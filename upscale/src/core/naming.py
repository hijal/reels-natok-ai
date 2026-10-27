from __future__ import annotations

from pathlib import Path


RENAME_MODES = ("Auto", "Copy", "Custom")
_INVALID_FILENAME_CHARACTERS = set('<>:"/\\|?*')
# (fix 716) Reserved Windows names (CON, PRN, AUX, NUL, COM1..9,
# LPT1..9) — with or without extension, a file cannot be created with such names.
_RESERVED_STEMS = {"con", "prn", "aux", "nul"} | {
    f"{prefix}{index}" for prefix in ("com", "lpt") for index in range(1, 10)
}
_MAX_FILENAME_LENGTH = 255


def validate_output_stem(stem: str) -> str:
    """(fix 716) Validate the FINAL filename stem.

    Previously validate_rename only checked the USER suffix, and
    the final stem (e.g. "CON" from source or "name " with a trailing space)
    was not checked at all — failing with FileExistsError/OSError only
    when written, with an unclear message.
    """
    if not stem:
        raise ValueError("Output name cannot be empty.")
    if any(character in _INVALID_FILENAME_CHARACTERS or ord(character) < 32 for character in stem):
        raise ValueError('Output name cannot contain < > : " / \\ | ? * or control characters.')
    if stem.endswith((" ", ".")):
        raise ValueError("Output name cannot end with a space or period.")
    if stem.split(".")[0].lower() in _RESERVED_STEMS:
        raise ValueError(f"'{stem}' is a reserved device name on Windows.")
    if len(stem) > _MAX_FILENAME_LENGTH:
        raise ValueError("Output name is too long for the file system.")
    return stem


def validate_rename(mode: str, custom_suffix: str) -> str:
    if mode not in RENAME_MODES:
        choices = ", ".join(RENAME_MODES)
        raise ValueError(f"Rename must be one of: {choices}.")
    suffix = str(custom_suffix or "")
    if mode != "Custom":
        return suffix
    if not suffix:
        raise ValueError("Enter a suffix when Rename is set to Custom.")
    if any(character in _INVALID_FILENAME_CHARACTERS or ord(character) < 32 for character in suffix):
        raise ValueError('Custom suffix cannot contain < > : " / \\ | ? * or control characters.')
    if suffix.endswith((" ", ".")):
        raise ValueError("Custom suffix cannot end with a space or period.")
    return suffix


def output_filename(
    source: Path,
    extension: str,
    mode: str,
    custom_suffix: str,
    auto_stem: str,
) -> str:
    suffix = validate_rename(mode, custom_suffix)
    if not extension.startswith("."):
        raise ValueError("Output extension must start with a period.")
    if mode == "Auto":
        stem = auto_stem
    else:
        stem = source.stem.strip().rstrip(".") or "output"
        if mode == "Custom":
            stem += suffix
    # (fix 716) Validate the final name completely (reserved Windows names,
    # trailing spaces/periods, length, invalid characters).
    validate_output_stem(stem)
    return f"{stem}{extension}"


def require_available_output(path: Path) -> None:
    if path.exists():
        raise FileExistsError(
            f"Output already exists: {path.name}. Rename or remove the existing file first."
        )
