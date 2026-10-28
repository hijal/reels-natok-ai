# Colab Episode Studio

This repository contains a Colab-hosted MiniMax H3 episode pipeline and an
authenticated browser dashboard. There is no local Next.js/Windows studio.

- Read `README.md` and `colab/README.md` for the supported workflow.
- Edit canonical Python helpers and browser assets in `tools/`. Regenerate both
  notebooks and the session repair script with
  `python3 scripts/build-colab-notebook.py`; do not edit embedded copies manually.
- Run `python3 -m unittest discover -s tests -v` after changes. Assembly tests
  require FFmpeg/ffprobe; dashboard HTTP tests require loopback socket access.
- Preserve recipe fingerprinting, scene checkpoints, cancellation ownership and
  export verification before Drive sync/runtime release.
- Keep credentials out of source, command arguments and logs. Use Colab Secrets.
- Do not delete generated videos, checkpoints, user data or model weights during
  source cleanup. Legacy ignored runtime folders may remain in existing checkouts.
- CPU tests do not validate actual GPU inference or live Cloudflare connectivity.
