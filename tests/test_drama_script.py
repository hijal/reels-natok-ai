"""Structured-script import and useful subprocess diagnostics without GPU dependencies."""
from contextlib import redirect_stdout
import io
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
from drama_script import parse_drama_script
from colab_drama import plan_script
from colab_planner import plan_story, run_planner

SCRIPT = '''DRAMA SCRIPT

TITLE: Test Episode
LOGLINE: One character notices a changed prop.
GENRE: Comedy
LANGUAGE: English
ASPECT: 9:16
RESOLUTION: 1080x1920
FPS: 24
RUNTIME: 10s
STYLE: expressive 3D animation
SETTING: A picnic table at noon.

== CHARACTERS ==
CHARACTER @cat | Cleo | animal
  LOOK: orange tabby cat with green eyes
  VOICE: crisp adult female voice
  ACCENT: neutral British English
PROP @pizza | Pizza
  LOOK: triangular bread with melted cheese
  VARIANT bare | scenes 2 | The same bread and crust, completely bare.
LOCATION @table | Picnic table
  LOOK: one wooden picnic table

== RULES ==
RULE: @cat keeps the same appearance.
NOTE: Do not read this production instruction aloud.

== SCENES ==
SCENE 1 | 5s | First
  AT: @table
  CAST: @cat
  LIPSYNC: required
  VISUAL: @cat looks at @pizza.
  KEYFRAME: @cat holds @pizza at table height.
  CAMERA: Static close-up.
  FRAME: @cat and @pizza centred
  MUSIC: stop
  TRANSITION: cut
  @cat (softly): "One slice. It's mine." | at: 0.5s
SCENE 2 | 5s | Changed
  AT: @table
  CAST: @cat
  LIPSYNC: required
  VISUAL: @cat inspects the bare @pizza.
  CAMERA: Static close-up.
  FRAME: @cat and @pizza centred
  TRANSITION: cut
  @cat: "Where is the cheese?" | at: 0.5s
'''


class StructuredImportTest(unittest.TestCase):
    def test_both_input_paths_bypass_qwen_and_preserve_timing_dialogue_and_variants(self):
        with patch('colab_planner.subprocess.Popen') as proc:
            plan = plan_story(SCRIPT, 'filename', '', 120, 15, '/missing-runtime', '/missing-drive')
        proc.assert_not_called()
        self.assertEqual(plan, plan_script(SCRIPT, duration=15))
        self.assertEqual(plan['title'], 'Test Episode')
        self.assertEqual([s['duration'] for s in plan['scenes']], [5, 5])
        self.assertIn('"One slice. It\'s mine."', plan['scenes'][0]['prompt'])
        self.assertIn('VOICE: crisp adult female voice', plan['scenes'][0]['prompt'])
        self.assertNotIn('Current-state override for Pizza', plan['scenes'][0]['prompt'])
        self.assertIn('Current-state override for Pizza', plan['scenes'][1]['prompt'])
        self.assertNotIn('Do not read this production instruction', plan['scenes'][0]['prompt'])
        self.assertNotIn('@cat', plan['scenes'][0]['prompt'])

    def test_bad_input_stops_with_actionable_error_instead_of_prose_fallback(self):
        cases = [
            (SCRIPT.replace('SCENE 2 | 5s', 'SCENE 3 | 5s'), 'Scene numbers'),
            (SCRIPT.replace('RUNTIME: 10s', 'RUNTIME: 12s'), 'RUNTIME'),
            (SCRIPT.replace('VISUAL: @cat looks', 'VISUAL: @missing looks'), 'Undefined IDs'),
            (SCRIPT.replace('TRANSITION: cut', 'TRANSITION: fade 1s'), 'Only cut'),
            (SCRIPT.replace('SCENE 2 | 5s | Changed', '  SHOT 1 | 5s | close-up'), 'Multi-shot'),
            (SCRIPT.replace('  @cat (softly)', '  @missing (softly)'), 'Speaker'),
            (SCRIPT.replace('at: 0.5s', 'at: 5s'), 'past the scene'),
            (SCRIPT.replace('scenes 2 |', 'scenes 9 |'), 'nonexistent scene'),
            (SCRIPT.replace('  TRANSITION: cut', '  TEXT: "unsupported"'), 'Unsupported scene line'),
        ]
        for text, message in cases:
            with self.subTest(message=message), self.assertRaisesRegex(ValueError, message):
                parse_drama_script(text)

    def test_quoted_pipe_is_preserved_and_off_screen_cast_not_drawn(self):
        text = SCRIPT.replace('  CAST: @cat\n', '  CAST: @cat (voice)\n')
        text = text.replace('  LIPSYNC: required', '  LIPSYNC: none')
        text = text.replace('VISUAL: @cat looks at @pizza.', 'VISUAL: @pizza rests on the table.')
        text = text.replace('KEYFRAME: @cat holds @pizza at table height.', 'KEYFRAME: @pizza rests on the table.')
        text = text.replace('FRAME: @cat and @pizza centred', 'FRAME: @pizza centred')
        text = text.replace('VISUAL: @cat inspects the bare @pizza.', 'VISUAL: The bare @pizza rests on the table.')
        text = text.replace('One slice. It\'s mine.', 'One slice | one owner.')
        plan = parse_drama_script(text)
        self.assertIn('"One slice | one owner."', plan['scenes'][0]['prompt'])
        self.assertIn('Visible cast: none.', plan['scenes'][0]['prompt'])
        self.assertIn('OFF-SCREEN VOICE Cleo', plan['scenes'][0]['prompt'])

    def test_subprocess_error_includes_real_traceback_and_persistent_log(self):
        with tempfile.TemporaryDirectory() as tmp:
            log = Path(tmp) / 'planner.log'
            with redirect_stdout(io.StringIO()), self.assertRaisesRegex(RuntimeError, 'fixture_dependency') as error:
                run_planner([sys.executable, '-u', '-c', "print('Starting fixture'); raise ModuleNotFoundError('fixture_dependency')"], log)
            self.assertIn(str(log), str(error.exception))
            self.assertIn('Traceback', log.read_text())
            self.assertIn('Starting fixture', log.read_text())


if __name__ == '__main__':
    unittest.main()
