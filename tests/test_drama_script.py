"""Structured-script import and useful subprocess diagnostics without GPU dependencies."""
from contextlib import redirect_stdout
import io
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
from drama_script import is_drama_script, parse_drama_script
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
    def test_pasted_whitespace_keeps_structured_plan_in_both_input_paths(self):
        expected = parse_drama_script(SCRIPT)
        variants = [
            '\n' + SCRIPT,
            ' ' + SCRIPT,
            '\r\n \t\r\n  ' + SCRIPT.replace('\n', '\r\n'),
            '\ufeff' + SCRIPT,
            '\ufeff \n\n  ' + SCRIPT,
            '\n \ufeff  ' + SCRIPT.replace('DRAMA SCRIPT\n', 'DRAMA SCRIPT  \n', 1),
        ]
        with patch('colab_planner.subprocess.Popen') as proc:
            for text in variants:
                with self.subTest(prefix=repr(text[:35])):
                    self.assertTrue(is_drama_script(text))
                    self.assertEqual(parse_drama_script(text), expected)
                    self.assertEqual(plan_script(text, duration=15), expected)
                    self.assertEqual(plan_story(text, 'filename', '', 120, 15,
                                                '/missing-runtime', '/missing-drive'), expected)
        proc.assert_not_called()

    def test_padded_invalid_script_raises_with_original_line_number_without_fallback(self):
        text = '\n \n  ' + SCRIPT.replace('GENRE: Comedy', 'UNKNOWN: Comedy')
        number = next(i for i, line in enumerate(text.splitlines(), 1) if line.startswith('UNKNOWN:'))
        with patch('colab_planner.subprocess.Popen') as proc:
            for parse in (parse_drama_script, plan_script,
                          lambda value: plan_story(value, 'filename', '', 60, 5,
                                                   '/missing-runtime', '/missing-drive')):
                with self.subTest(parse=parse), self.assertRaisesRegex(ValueError, f'DRAMA SCRIPT line {number}:'):
                    parse(text)
        proc.assert_not_called()

    def test_marker_must_be_the_entire_first_nonempty_line(self):
        for text in (None, '', ' \n\ufeff\n', 'DRAMA SCRIPT extra\n',
                     'A story mentions DRAMA SCRIPT.', 'Intro\n\nDRAMA SCRIPT\n'):
            with self.subTest(text=text):
                self.assertFalse(is_drama_script(text))
        prose = '\n  A cat waits.\n\nA dog arrives.'
        self.assertEqual([scene['prompt'] for scene in plan_script(prose)['scenes']],
                         ['A cat waits.', 'A dog arrives.'])

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
