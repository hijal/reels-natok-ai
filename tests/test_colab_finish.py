"""Check shutdown ordering and failure behavior without contacting Colab."""
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
from colab_drama import atomic_json, digest
from colab_finish import finish_run


class FinishTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.drive = Path(self.temp.name)
        self.workspace = self.drive / 'MyDrive/reels-natok-ai'
        folder = self.workspace / 'episodes/example'
        folder.mkdir(parents=True)
        recipe = {'plan': {'scenes': [{'prompt': 'Example', 'duration': 5}]}}
        recipe_hash = digest(recipe)
        atomic_json(folder / 'recipe.json', recipe)
        self.output = folder / 'episode-1080x1920.mp4'
        self.output.write_bytes(b'final video fixture')
        (folder / 'scene-001.mp4').write_bytes(b'scene fixture')
        atomic_json(folder / 'scene-001.json', {
            'status': 'done', 'fingerprint': digest({'recipe': recipe_hash, 'scene': 0})})
        atomic_json(folder / 'completed.json', {
            'recipe': recipe_hash, 'output': self.output.name, 'scene_count': 1})
        self.events = []
        self.flush = Mock(side_effect=lambda: self.events.append('flush'))
        self.unassign = Mock(side_effect=lambda: self.events.append('unassign'))
        self.probe = patch('colab_finish.video_info', return_value=(
            {'streams': [{'codec_type': 'audio'}]}, {'width': 1080, 'height': 1920}, 5.17))
        self.probe.start()
        self.addCleanup(self.probe.stop)

    def finish(self, **kwargs):
        options = dict(expected_episodes=1, drive_root=self.drive,
                       mounted_fn=lambda root: True, flush_fn=self.flush,
                       unassign_fn=self.unassign)
        options.update(kwargs)
        return finish_run([self.output], self.workspace, **options)

    def test_manifest_saved_before_flush_then_runtime_release(self):
        def flush():
            manifest = json.loads((self.workspace / 'last-results.json').read_text())
            self.assertTrue(manifest['complete'])
            self.assertEqual(manifest['outputs'][0]['path'], 'episodes/example/episode-1080x1920.mp4')
            self.events.append('flush')
        self.flush.side_effect = flush
        self.finish()
        self.assertEqual(self.events, ['flush', 'unassign'])

    def test_incomplete_batch_or_scene_never_releases_runtime(self):
        with self.assertRaisesRegex(RuntimeError, 'Not all requested'):
            self.finish(expected_episodes=2)
        (self.output.parent / 'scene-001.mp4').unlink()
        with self.assertRaisesRegex(RuntimeError, 'verification failed'):
            self.finish()
        self.flush.assert_not_called()
        self.unassign.assert_not_called()

    def test_invalid_export_or_unmounted_drive_never_releases_runtime(self):
        with patch('colab_finish.video_info', return_value=(
                {'streams': []}, {'width': 576, 'height': 1024}, 5)):
            with self.assertRaisesRegex(RuntimeError, 'verification failed'):
                self.finish()
        with self.assertRaisesRegex(RuntimeError, 'mounted Google Drive'):
            self.finish(mounted_fn=lambda root: False)
        self.flush.assert_not_called()
        self.unassign.assert_not_called()

    def test_sync_failure_keeps_runtime_assigned(self):
        self.flush.side_effect = OSError('Drive unavailable')
        with self.assertRaisesRegex(RuntimeError, 'Drive sync failed'):
            self.finish()
        self.unassign.assert_not_called()

    def test_release_failure_reports_manual_fallback(self):
        self.unassign.side_effect = OSError('Colab unavailable')
        with self.assertRaisesRegex(RuntimeError, 'Disconnect and delete runtime'):
            self.finish()
        self.flush.assert_called_once()

    def test_disabled_leaves_runtime_and_drive_connected(self):
        self.finish(auto_disconnect=False)
        self.flush.assert_not_called()
        self.unassign.assert_not_called()

    def test_notebook_failure_in_second_episode_skips_finish(self):
        notebook = json.loads((Path(__file__).resolve().parents[1] /
                              'colab/Reels_Natok_MiniMax_H3.ipynb').read_text())
        source = next(''.join(c['source']) for c in notebook['cells']
                      if c['cell_type'] == 'code' and '9. Generate' in ''.join(c['source']))
        env = dict(scripts=[{}, {}], WORKSPACE=self.workspace, RUNTIME='runtime',
                   URL='url', REFERENCES=[], SEED=42, PRESET='preset', FIT='pad',
                   run_episode=Mock(side_effect=[self.output, RuntimeError('generation failed')]))
        with patch('colab_finish.finish_run') as finish:
            with self.assertRaisesRegex(RuntimeError, 'generation failed'):
                exec(compile(source, '<generation-cell>', 'exec'), env)
            finish.assert_not_called()
        env['run_episode'] = Mock(return_value=self.output)
        with patch('colab_finish.finish_run') as finish:
            exec(compile(source, '<generation-cell>', 'exec'), env)
            finish.assert_called_once_with([self.output, self.output], self.workspace,
                                           expected_episodes=2, auto_disconnect=True)


if __name__ == '__main__':
    unittest.main()
