"""Import the one-shot DRAMA SCRIPT profile without an LLM rewrite."""
from decimal import Decimal, InvalidOperation
import json
import re

ID = r"@[a-z][a-z0-9_]*"
HEADER_FIELDS = set("TITLE LOGLINE GENRE LANGUAGE ASPECT RESOLUTION FPS RUNTIME STYLE SETTING".split()) | {"STYLE PROMPT", "SPEECH RATE"}
SCENE_FIELDS = set("AT CAST LIPSYNC MOOD VISUAL KEYFRAME CAMERA FRAME LIGHT MUSIC TRANSITION".split())
ENTITY_FIELDS = set("ROLE AGE GENDER FACE SKIN EYES HAIR BUILD OUTFIT ACCESSORIES PERSONALITY VOICE ACCENT LOOK LIGHT REF RULE".split())


def _drama_script_header(text):
    """Find the first nonempty line, allowing pasted whitespace and a UTF-8 BOM."""
    if not isinstance(text, str):
        return None
    for index, line in enumerate(text.splitlines()):
        content = line.strip().lstrip("\ufeff").strip()
        if content:
            return index if content == "DRAMA SCRIPT" else None
    return None


def is_drama_script(text):
    return _drama_script_header(text) is not None


def parse_drama_script(text, context=""):
    """Preserve one-shot scene durations, identities, variants, dialogue and beat cues.

    This intentionally rejects multi-shot scenes and unsupported production fields
    rather than silently treating them as prose. Timing remains model guidance.
    REF paths are reported for manual upload, not resolved from untrusted text.
    """
    header = _drama_script_header(text)
    if header is None:
        raise ValueError("Structured script must begin with DRAMA SCRIPT")
    if len(text.encode()) > 2 * 1024 * 1024:
        raise ValueError("Script exceeds 2 MiB")
    headers, entities, scenes, rules, notes = {}, {}, [], [], []
    section, current = None, None
    seen_sections = []

    def fail(number, message):
        raise ValueError(f"DRAMA SCRIPT line {number}: {message}")

    def seconds(value, number, allow_zero=False):
        if not re.fullmatch(r"\d+(?:\.\d+)?s", value):
            fail(number, f"Expected seconds such as 5s, got {value!r}")
        try:
            result = Decimal(value[:-1])
        except InvalidOperation:
            fail(number, "Invalid time")
        if result < 0 or (not allow_zero and result == 0) or result * 24 != (result * 24).to_integral_value():
            fail(number, "Time must be a positive whole number of frames at 24 fps (at may be zero)")
        return result

    def extras(parts, allowed, number):
        result = {}
        for part in parts:
            key, sep, value = part.strip().partition(":")
            if not sep or key not in allowed or key in result or not value.strip():
                fail(number, f"Invalid or duplicate beat extra: {part!r}")
            result[key] = value.strip()
        return result

    # Keep source line numbers intact; normalize only the marker, not field indentation.
    for number, raw in enumerate(text.splitlines()[header + 1:], header + 2):
        line = raw.strip()
        if not line or line.startswith("//"):
            continue
        if "\t" in raw:
            fail(number, "Use spaces, not tabs")
        if line.startswith("=="):
            allowed = ["== CHARACTERS ==", "== RULES ==", "== SCENES =="]
            if line not in allowed or len(seen_sections) >= 3 or line != allowed[len(seen_sections)]:
                fail(number, "Expected sections CHARACTERS, RULES, SCENES in that order")
            seen_sections.append(line)
            section, current = line, None
            continue
        if section is None:
            key, sep, value = line.partition(":")
            if raw != line or not sep or key not in HEADER_FIELDS or key in headers or not value.strip():
                fail(number, "Unknown, empty, duplicated or indented header field")
            headers[key] = value.strip()
            continue
        if section == "== CHARACTERS ==":
            match = re.fullmatch(rf"(CHARACTER|PROP|LOCATION) ({ID}) \| ([^|]+?)(?: \| ([^|]+))?", line)
            if raw == line and match:
                kind, id_, name, type_ = match.groups()
                if id_ in entities:
                    fail(number, f"Duplicate ID {id_}")
                if kind == "CHARACTER" and type_ not in ("human", "animal", "hologram", "voice_only", "other"):
                    fail(number, "Invalid character kind")
                if kind != "CHARACTER" and type_:
                    fail(number, "Only characters have a kind suffix")
                current = {"kind": kind, "name": name.strip(), "type": type_, "fields": {},
                           "rules": [], "refs": [], "variants": [], "line": number}
                entities[id_] = current
                continue
            if current is None or not raw.startswith("  ") or raw.startswith("   "):
                fail(number, "Expected an entity header or a field indented by two spaces")
            variant = re.fullmatch(r"VARIANT (\w+) \| scenes ([\d, -]+) \| (.+)", line)
            if variant:
                name, ranges, description = variant.groups()
                numbers = set()
                for token in ranges.replace(" ", "").split(","):
                    if not re.fullmatch(r"\d+(?:-\d+)?", token):
                        fail(number, "Invalid variant scene range")
                    start, _, end = token.partition("-")
                    a, b = int(start), int(end or start)
                    if not 1 <= a <= b <= 120:
                        fail(number, "Variant scene range must be within 1–120")
                    numbers.update(range(a, b + 1))
                if any(numbers & v["scenes"] for v in current["variants"]):
                    fail(number, "Overlapping entity variants")
                current["variants"].append({"name": name, "scenes": numbers, "description": description})
                continue
            key, sep, value = line.partition(":")
            if not sep or key not in ENTITY_FIELDS or not value.strip():
                fail(number, "Unknown or empty entity field")
            value = value.strip()
            if key in ("RULE", "REF"):
                current["rules" if key == "RULE" else "refs"].append(value)
            elif key in current["fields"]:
                fail(number, f"Duplicate entity field {key}")
            else:
                current["fields"][key] = value
            continue
        if section == "== RULES ==":
            key, sep, value = line.partition(":")
            if raw != line or not sep or key not in ("RULE", "NOTE") or not value.strip():
                fail(number, "Expected RULE or NOTE")
            (rules if key == "RULE" else notes).append(value.strip())
            continue
        match = re.fullmatch(r"SCENE (\d+) \| ([\d.]+s) \| (.+)", line)
        if raw == line and match:
            index, duration, title = match.groups()
            if int(index) != len(scenes) + 1:
                fail(number, "Scene numbers must start at 1 and increase by one")
            duration = seconds(duration, number)
            if not 5 <= duration <= 15:
                fail(number, "One-shot scenes must last 5–15s")
            current = {"number": int(index), "duration": duration, "title": title,
                       "fields": {}, "beats": [], "line": number}
            scenes.append(current)
            continue
        if line.startswith("SHOT "):
            fail(number, "Multi-shot scene import is not supported yet; use one SCENE per shot")
        if current is None or not raw.startswith("  ") or raw.startswith("   "):
            fail(number, "Expected SCENE or a scene line indented by two spaces")
        spoken = re.match(rf"^({ID})(?: (\[VO\]))?(?: \(([^)]+)\))?:\s*", line)
        if spoken:
            payload = line[spoken.end():]
            try:
                dialogue, end = json.JSONDecoder().raw_decode(payload)
            except json.JSONDecodeError:
                fail(number, "Dialogue requires a correctly escaped double-quoted string")
            if not isinstance(dialogue, str) or not dialogue.strip():
                fail(number, "Dialogue cannot be empty")
            suffix = payload[end:].strip()
            if not suffix.startswith("|"):
                fail(number, "Dialogue requires | at: <time>")
            meta = extras(suffix[1:].split("|"), {"at"}, number)
            beat = {"type": "dialogue", "speaker": spoken[1], "vo": bool(spoken[2]),
                    "delivery": spoken[3], "text": dialogue, "meta": meta, "line": number}
        else:
            key, sep, value = line.partition(":")
            if not sep or not value.strip():
                fail(number, "Expected a nonempty scene field or beat")
            if key in SCENE_FIELDS:
                if current["beats"] or key in current["fields"]:
                    fail(number, "Scene fields must be unique and precede beats")
                current["fields"][key] = value.strip()
                continue
            if key not in ("ACTION", "SFX"):
                fail(number, f"Unsupported scene line {key!r}")
            parts = re.split(r"(?<!\\)\|", value)
            meta = extras(parts[1:], {"at"} if key == "ACTION" else {"at", "length", "sound"}, number)
            beat = {"type": key, "text": parts[0].strip().replace(r"\|", "|"), "meta": meta, "line": number}
        if "at" not in beat["meta"] or (beat["type"] == "SFX" and "length" not in beat["meta"]):
            fail(number, "Every beat needs at; SFX also needs length")
        at = seconds(beat["meta"]["at"], number, allow_zero=True)
        length = seconds(beat["meta"]["length"], number) if "length" in beat["meta"] else Decimal(0)
        if at >= current["duration"] or at + length > current["duration"]:
            fail(number, "Beat extends past the scene")
        current["beats"].append(beat)

    if len(seen_sections) != 3 or not scenes:
        raise ValueError("DRAMA SCRIPT requires CHARACTERS, RULES and nonempty SCENES sections")
    for field in ("TITLE", "LOGLINE", "GENRE", "LANGUAGE", "ASPECT", "RESOLUTION", "FPS", "RUNTIME", "STYLE", "SETTING"):
        if field not in headers:
            raise ValueError(f"Missing required header {field}")
    if (headers["LANGUAGE"].lower(), headers["ASPECT"], headers["RESOLUTION"], headers["FPS"]) != ("english", "9:16", "1080x1920", "24"):
        raise ValueError("This importer supports English, 9:16, 1080x1920 export and 24 fps")
    total = sum(s["duration"] for s in scenes)
    if seconds(headers["RUNTIME"], 1) != total:
        raise ValueError(f"RUNTIME does not match the scene sum ({total}s)")
    if not any(e["kind"] == "LOCATION" for e in entities.values()):
        raise ValueError("Define at least one LOCATION")
    for entity in entities.values():
        if entity["kind"] != "CHARACTER" and "LOOK" not in entity["fields"]:
            fail(entity["line"], "Props and locations require LOOK")
        for variant in entity["variants"]:
            if not variant["scenes"] <= set(range(1, len(scenes) + 1)):
                fail(entity["line"], "Variant refers to a nonexistent scene")

    def ids(value, number):
        found = set(re.findall(rf"(?<!\\){ID}", value))
        if not found <= entities.keys():
            fail(number, "Undefined IDs: " + ", ".join(sorted(found - entities.keys())))
        return found

    def names(value):
        return re.sub(rf"(?<!\\){ID}", lambda m: entities[m[0]]["name"], value).replace(r"\@", "@")

    for value in rules + notes:
        ids(value, 1)
    for entity in entities.values():
        for value in entity["rules"]:
            ids(value, entity["line"])

    result = []
    music = "stop"
    for scene in scenes:
        f, number = scene["fields"], scene["line"]
        missing = {"AT", "CAST", "LIPSYNC", "VISUAL", "CAMERA", "FRAME", "TRANSITION"} - f.keys()
        if missing:
            fail(number, "Missing scene fields: " + ", ".join(sorted(missing)))
        location_id = f["AT"].split(",", 1)[0].strip()
        if location_id not in entities or entities[location_id]["kind"] != "LOCATION":
            fail(number, "AT must name a defined location")
        if f["TRANSITION"] != "cut" or f["LIPSYNC"] not in ("required", "none"):
            fail(number, "Only cut transitions and required/none LIPSYNC are supported")
        cast = {}
        if f["CAST"] != "none":
            for value in f["CAST"].split(","):
                match = re.fullmatch(rf"({ID})(?: \((glimpsed|background|voice)\))?", value.strip())
                if not match or match[1] not in entities or entities[match[1]]["kind"] != "CHARACTER":
                    fail(number, "Invalid CAST entry")
                if match[1] in cast:
                    fail(number, "Duplicate CAST entry")
                cast[match[1]] = match[2] or "visible"
                if entities[match[1]]["type"] == "voice_only" and cast[match[1]] != "voice":
                    fail(number, "A voice_only character must have (voice) presence")
        visible = set()
        for key in ("VISUAL", "KEYFRAME", "FRAME"):
            visible.update(ids(f.get(key, ""), number))
        for beat in scene["beats"]:
            if beat["type"] == "ACTION":
                visible.update(ids(beat["text"], beat["line"]))
            if beat["type"] == "dialogue":
                if beat["speaker"] not in cast:
                    fail(beat["line"], "Speaker is not in CAST")
                if cast[beat["speaker"]] != "voice" and not beat["vo"] and f["LIPSYNC"] != "required":
                    fail(beat["line"], "Visible speech requires LIPSYNC: required")
        for id_ in visible:
            if entities[id_]["kind"] == "CHARACTER" and (id_ not in cast or cast[id_] == "voice"):
                fail(number, f"Visible character {id_} is absent from CAST or marked voice-only")
        if len({id_ for id_ in visible if entities[id_]["kind"] != "LOCATION"}) > 8:
            fail(number, "More than eight character/prop identities are visible")
        active = visible | set(cast) | {location_id}
        lines = [f"Scene {scene['number']}: {scene['title']}. One continuous shot; no internal cuts.",
                 "Visible cast: " + (", ".join(entities[x]["name"] + f" ({p})" for x, p in cast.items() if p != "voice") or "none") + ". Keep all other characters outside the crop."]
        for id_, entity in entities.items():
            if id_ not in active:
                continue
            label = "OFF-SCREEN VOICE" if cast.get(id_) == "voice" else entity["kind"]
            details = "; ".join(f"{k}: {v}" for k, v in entity["fields"].items())
            lines.append(f"{label} {entity['name']}: {details}")
            for variant in entity["variants"]:
                if scene["number"] in variant["scenes"]:
                    lines.append(f"Current-state override for {entity['name']}: {variant['description']}. This overrides conflicting base appearance.")
            lines.extend("Continuity: " + names(r) for r in entity["rules"])
        lines.extend(f"{key}: {names(f[key])}" for key in ("AT", "MOOD", "VISUAL", "KEYFRAME", "CAMERA", "FRAME", "LIGHT") if key in f)
        lines.append("KEYFRAME text describes the initial pose only; it is not a supplied keyframe image.")
        music = f.get("MUSIC", music)
        lines.append("Music: " + ("No background score." if music == "stop" else music))
        for rule in rules:
            mentioned = ids(rule, number)
            if not mentioned or mentioned & active:
                lines.append("Continuity constraint, not an instruction to add off-screen subjects: " + names(rule))
        for beat in scene["beats"]:
            at = beat["meta"]["at"]
            if beat["type"] == "dialogue":
                speaker = entities[beat["speaker"]]["name"]
                voice = "voice-over" if beat["vo"] else cast[beat["speaker"]]
                lines.append(f"At {at}, {speaker} ({voice}; {beat['delivery'] or 'natural delivery'}) says exactly in English: " + json.dumps(beat["text"], ensure_ascii=False))
            else:
                description = names(beat["text"]) if beat["type"] == "ACTION" else beat["text"]
                lines.append(f"At {at}, {beat['type']}: {description}" + (f" Duration: {beat['meta']['length']}." if "length" in beat["meta"] else ""))
                if "sound" in beat["meta"]:
                    lines.append("Sound detail: " + beat["meta"]["sound"])
        result.append({"prompt": "\n".join(lines), "duration": float(scene["duration"]), "script_scene": scene["number"]})
    shared = "\n".join(f"{k}: {v}" for k, v in headers.items() if k in ("LOGLINE", "GENRE", "STYLE", "SETTING", "STYLE PROMPT"))
    warnings = []
    if any(e["refs"] for e in entities.values()):
        warnings.append("REF paths are metadata only: upload the actual images separately and match their Picture tags manually.")
    return {"title": headers["TITLE"], "context": context + "\nScript style and setting take precedence over generic defaults.\n" + shared,
            "scenes": result, "source_format": "drama-script", "warnings": warnings,
            "production_notes": notes, "planned_seconds": float(total)}
