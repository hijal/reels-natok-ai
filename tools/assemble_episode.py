#!/usr/bin/env python3
"""Assemble ordered scene clips into a portrait MP4; no GPU or pip packages needed."""
import argparse
import errno
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


def run(args):
    result = subprocess.run([str(a) for a in args], capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(result.stderr[-4000:] or f"Command failed: {args[0]}")
    return result.stdout


def probe(file):
    return json.loads(run([
        "ffprobe", "-v", "error", "-show_streams", "-show_format",
        "-of", "json", file,
    ]))


def video_info(file):
    data = probe(file)
    video = next((s for s in data["streams"] if s["codec_type"] == "video"
                  and not s.get("disposition", {}).get("attached_pic")), None)
    if video is None:
        raise ValueError(f"No video stream: {file}")
    duration = float(video.get("duration") or data["format"].get("duration") or 0)
    if not math.isfinite(duration) or duration <= 0:
        raise ValueError(f"Cannot determine video duration: {file}")
    return data, video, duration


def assemble(clips, output, *, fit="pad", overwrite=False):
    """Normalize one clip at a time, then concatenate in exactly the supplied order.

    Missing audio becomes silence. Existing audio is preserved, resampled to stereo
    48 kHz and padded/trimmed to its video. Final output is H.264/AAC, 24 fps,
    1080x1920, yuv420p, with faststart for web playback. Cuts are hard cuts.
    """
    if fit not in ("pad", "crop"):
        raise ValueError("fit must be pad or crop")
    for binary in ("ffmpeg", "ffprobe"):
        if not shutil.which(binary):
            raise RuntimeError(f"{binary} is required. Install ffmpeg first.")
    sources = [Path(p).expanduser().resolve(strict=True) for p in clips]
    if not sources:
        raise ValueError("Provide at least one scene clip")
    output = Path(output).expanduser().resolve()
    if output.suffix.lower() != ".mp4":
        raise ValueError("Output must have an .mp4 extension")
    if output in sources:
        raise ValueError("Output must not replace a source clip")
    if output.exists() and not overwrite:
        raise FileExistsError(f"Output already exists: {output}")
    infos = [video_info(p) for p in sources]
    output.parent.mkdir(parents=True, exist_ok=True)
    scale = (
        "scale=1080:1920:force_original_aspect_ratio=decrease:force_divisible_by=2,"
        "pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black"
        if fit == "pad" else
        "scale=1080:1920:force_original_aspect_ratio=increase:force_divisible_by=2,"
        "crop=1080:1920"
    )
    # Work beside the destination so the final rename is atomic on the same disk.
    with tempfile.TemporaryDirectory(prefix=".assemble-", dir=output.parent) as work:
        work = Path(work)
        for i, (source, (data, video, duration)) in enumerate(zip(sources, infos)):
            print(f"Scene {i + 1}/{len(sources)}: {source.name}", flush=True)
            # Normalize non-square pixels before resizing to preserve display aspect.
            vf = "scale=trunc(iw*sar/2)*2:ih,setsar=1," + scale
            vf += ",fps=24,setpts=PTS-STARTPTS,format=yuv420p"
            cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
                   "-i", source]
            audio = next((s for s in data["streams"] if s["codec_type"] == "audio"), None)
            if audio:
                audio_map = f"0:{audio['index']}"
            else:
                cmd += ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"]
                audio_map = "1:a:0"
            cmd += ["-map", f"0:{video['index']}", "-map", audio_map,
                    "-vf", vf, "-af", "asetpts=PTS-STARTPTS,aresample=48000,apad",
                    "-t", str(duration), "-c:v", "libx264", "-preset", "fast",
                    "-crf", "18", "-threads", "2", "-c:a", "aac", "-b:a", "192k",
                    "-ar", "48000", "-ac", "2", "-video_track_timescale", "12288",
                    work / f"scene-{i:05d}.mp4"]
            run(cmd)
        listing = work / "concat.txt"
        listing.write_text("".join(f"file 'scene-{i:05d}.mp4'\n"
                                   for i in range(len(sources))), encoding="utf-8")
        result = work / "result.mp4"
        run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
             "-f", "concat", "-safe", "1", "-i", listing, "-c", "copy",
             "-movflags", "+faststart", result])
        data, video, duration = video_info(result)
        if (video["width"], video["height"]) != (1080, 1920):
            raise RuntimeError("Final output dimensions are incorrect")
        expected = sum(info[2] for info in infos)
        if abs(duration - expected) > max(0.5, len(sources) / 24 + 0.1):
            raise RuntimeError(f"Duration mismatch: expected {expected:.2f}s, got {duration:.2f}s")
        if not any(s["codec_type"] == "audio" for s in data["streams"]):
            raise RuntimeError("Final output has no audio stream")
        if overwrite:
            os.replace(result, output)
        else:
            # Publish without overwriting a file created by another job meanwhile.
            try:
                os.link(result, output)
            except OSError as exc:
                # Mounted Google Drive does not support hard links. Exclusive
                # creation still protects an existing user file there.
                if exc.errno not in (errno.EPERM, errno.EXDEV, errno.ENOTSUP, errno.EOPNOTSUPP):
                    raise
                with output.open("xb") as destination:
                    try:
                        with result.open("rb") as source:
                            shutil.copyfileobj(source, destination)
                    except BaseException:
                        destination.close()
                        output.unlink(missing_ok=True)
                        raise
    print(f"Saved: {output} ({duration:.2f}s, 1080x1920)", flush=True)
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("clips", nargs="*", help="Scene clips in story order")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--manifest", type=Path, help="JSON episodes manifest; paths relative to its folder")
    parser.add_argument("--fit", choices=["pad", "crop"], default="pad")
    parser.add_argument("--overwrite", action="store_true")
    args = parser.parse_args()
    if args.manifest:
        if args.clips or args.output:
            parser.error("Use --manifest OR clips with --output")
        manifest = args.manifest.resolve()
        jobs = json.loads(manifest.read_text(encoding="utf-8"))
        if not isinstance(jobs, dict) or not isinstance(jobs.get("episodes"), list) or not jobs["episodes"]:
            parser.error('Manifest needs a nonempty "episodes" array')
        for job in jobs["episodes"]:
            if not isinstance(job, dict) or not isinstance(job.get("clips"), list) or not job["clips"]:
                parser.error("Each episode needs a nonempty clips array")
            if not isinstance(job.get("output"), str) or not all(isinstance(p, str) for p in job["clips"]):
                parser.error("Episode output and clip paths must be strings")
            assemble([manifest.parent / p for p in job["clips"]], manifest.parent / job["output"],
                     fit=job.get("fit", args.fit), overwrite=args.overwrite)
    elif args.clips and args.output:
        assemble(args.clips, args.output, fit=args.fit, overwrite=args.overwrite)
    else:
        parser.error("Provide scene clips and --output, or --manifest")


if __name__ == "__main__":
    main()
