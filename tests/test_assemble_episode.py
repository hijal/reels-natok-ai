"""CPU integration checks: python3 -m unittest discover -s tests -v."""
import importlib.util
import errno
import array
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "assemble_episode", Path(__file__).resolve().parents[1] / "tools/assemble_episode.py")
assembly = importlib.util.module_from_spec(spec)
spec.loader.exec_module(assembly)


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "ffmpeg required")
class AssemblyTest(unittest.TestCase):
    def test_mixed_scenes_keep_order_audio_and_portrait_export(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            first, second = root / "scene one.mp4", root / "scene two.mp4"
            assembly.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i",
                          "color=c=red:s=160x90:r=12:d=0.5", "-f", "lavfi", "-i",
                          "sine=frequency=440:duration=0.5", "-c:v", "libx264",
                          "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", first])
            assembly.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i",
                          "color=c=blue:s=90x160:r=30:d=0.5", "-c:v", "libx264",
                          "-pix_fmt", "yuv420p", second])
            with patch.object(assembly.os, "link", side_effect=OSError(errno.ENOTSUP, "Drive FUSE")):
                output = assembly.assemble([first, second], root / "episode.mp4")
            data, video, duration = assembly.video_info(output)
            self.assertEqual((video["width"], video["height"]), (1080, 1920))
            self.assertEqual(video["r_frame_rate"], "24/1")
            self.assertEqual(video["codec_name"], "h264")
            self.assertEqual(video["pix_fmt"], "yuv420p")
            self.assertAlmostEqual(duration, 1, delta=0.1)
            audio = next(s for s in data["streams"] if s["codec_type"] == "audio")
            self.assertEqual(audio["codec_name"], "aac")
            self.assertEqual(audio["channels"], 2)
            amplitudes = []
            for timestamp in ("0.2", "0.8"):
                samples = subprocess.run([
                    "ffmpeg", "-v", "error", "-ss", timestamp, "-i", str(output),
                    "-t", "0.1", "-vn", "-ac", "1", "-f", "f32le", "pipe:1"],
                    capture_output=True, check=True).stdout
                values = array.array('f')
                values.frombytes(samples)
                amplitudes.append(max(abs(v) for v in values))
            self.assertGreater(amplitudes[0], 0.01)  # Original dialogue/tone retained.
            self.assertLess(amplitudes[1], 0.001)  # Silent scene remains silent.
            # Check actual decoded scene order rather than just concat metadata.
            for timestamp, dominant_channel in (("0.25", 0), ("0.75", 2)):
                rgb = subprocess.run([
                    "ffmpeg", "-v", "error", "-ss", timestamp, "-i", str(output),
                    "-frames:v", "1", "-vf", "crop=2:2:540:960", "-pix_fmt", "rgb24",
                    "-f", "rawvideo", "pipe:1"], capture_output=True, check=True).stdout[:3]
                self.assertGreater(rgb[dominant_channel], 200)
                self.assertLess(rgb[1], 40)
            original = output.read_bytes()
            with self.assertRaises(FileExistsError):
                assembly.assemble([first], output)
            self.assertEqual(output.read_bytes(), original)
            self.assertTrue(first.exists() and second.exists())
            self.assertFalse(list(root.glob(".assemble-*")))

    def test_rejects_empty_episode(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(ValueError):
                assembly.assemble([], Path(tmp) / "episode.mp4")


if __name__ == "__main__":
    unittest.main()
