# Drama Script format: H3 engine

This is the script format for the dashboard's **H3** engine, the default for new videos. It is
the same DRAMA SCRIPT format as [script-format.md](script-format.md) (the **Classic** engine)
and is read by the same parser, but H3 makes each shot differently, so some features are not
available and some fields mean something else. A script that follows this file works with both
engines.

The script is plain text, easy to write by hand, and strict enough that `script-parse` reads it
with code instead of guessing with an LLM. Each detail you write here (looks, voices, light,
camera, sounds) is passed as-is to the keyframe images and to H3, so the more precise the
script, the better and more consistent the output.

The script states **creative intent and target timing**. Measured speech length, model
settings, generated files and render decisions belong to the later modules, not here.

When you ask an AI to write or convert a script, give it this whole file and start your
request with the prompt in **Instructions for AI writers**. The blank template and the
complete example there are what the AI should copy.

## How H3 makes a video

1. A keyframe image is made for every shot from `KEYFRAME` (or `VISUAL`), `FRAME`, the looks
   and the `REF` images, and checked; with review on, you approve the keyframes first.
2. **Every shot** becomes one H3 clip of exactly the shot's length. H3 makes the **picture,
   the voices, the sound effects and the music together**, starting from the approved keyframe
   and using the references of up to eight characters and props in view.
3. The clips are joined with the scene transitions and mastered to −14 LUFS.

What this means for the script:

| H3 rule | Why |
| --- | --- |
| every shot (or one-shot scene) is **4–15 s** long | H3 makes one clip per shot; the dashboard rejects other lengths |
| `FPS: 24` and `ASPECT` 9:16 or 16:9 | H3 works at 24 fps in these two shapes |
| **no `TEXT` lines** | there is no text overlay step |
| **no `ALT ASPECT`** | there is no second export |
| `CLIP` does not matter | every shot is a moving clip; `still` and `hero` are made the same way |
| `LIPSYNC` does not matter | H3 makes the speaking mouth with the voice; set it anyway so the check shows no warning |
| `NEGATIVE PROMPT`, `VOICE ID`, `HERO MAX` are not used | H3 has no negative prompt or voice list |
| dialogue, `SFX` and `MUSIC` are **descriptions H3 hears** | each clip makes its own sound; see **Beats** and **Music** |
| no captions yet | the finished video has no burned-in subtitles |
| one continuous camera move per shot | H3 is told "one continuous shot, no cuts" |
| at most 8 characters and props in view per shot | H3 takes the keyframe plus up to eight references |

Each shot takes about 5 minutes of L4 time, so use fewer, longer shots (5–8 s) where nothing
new needs a new angle.

## Shape

```text
DRAMA SCRIPT                       ← first line, always

TITLE: …                           ← story header (key: value)
…

== CHARACTERS ==                   ← character, prop and location blocks
CHARACTER @aira | Aira Rahman | human
  AGE: 26
  …

== RULES ==                        ← continuity rules and production notes
RULE: …

== SCENES ==                       ← scenes, in order
SCENE 1 | 8s | The Perfect City
  AT: @skyline
  …
  @aira (quietly): "Then why does it feel so empty?"
```

- `DRAMA SCRIPT` is exactly the first line: no spaces before it, no title or code fence above it.
- The header comes next, then the sections in this order: `== CHARACTERS ==`, `== RULES ==`
  (may be left out), `== SCENES ==`.
- `== CHARACTERS ==` must define at least one `LOCATION`, because every scene needs `AT`.

## General rules

**File**

- UTF-8 without a BOM. LF or CRLF line endings.
- Empty lines are allowed anywhere and never change meaning.

**Lines and keys**

- One item per line, `KEY: value`. Keys are UPPER CASE, written exactly as in this file.
- Each key appears at most once per block, unless this file says it may repeat.
- Indent with spaces only (tabs are an error). Lines inside a block (character, prop,
  location, scene) are indented exactly 2 spaces. Lines inside a `SHOT` are indented exactly
  4 spaces from the left edge.
- Any line the parser does not recognise is an **error with its line number**; nothing is
  guessed or skipped silently.

**Continuation lines**

- A long value may continue on the next lines. A continuation line is any non-empty line
  indented **deeper** than the key or beat line it continues. It is joined with one space and
  is always read as text, even if it looks like a key.
- A block header (`CHARACTER`, `PROP`, `LOCATION`, `SCENE`, `SHOT`) cannot be continued.

**Comments**

- A line whose first non-space characters are `//` is a comment and is ignored.
- `//` inside a value is kept as text (so URLs work).

**Ids**

- Ids match `@[a-z][a-z0-9_]*`: `@aira`, `@wild_boar`, `@umbrella`, `@greenhouse`.
- One shared namespace: a character, prop and location can never have the same id.
- Every id is defined once, in `== CHARACTERS ==`, and only then used.
- Ids are read in `AT`, `CAST`, `VISUAL`, `KEYFRAME`, `ACTION`, `FRAME`, `RULE` and `NOTE`.
- Every other field names things in plain words, never with `@`: `CAMERA`, `MOOD`, `LIGHT`,
  `LOOK`, `SFX` and `MUSIC` descriptions, `TRANSITION` notes and every header field.
  Write `CAMERA: Slow push toward Ben.`, not `CAMERA: Slow push toward @ben.`;
  an id in `CAMERA`, `MOOD` or `LIGHT` is an error.
- Inside dialogue, `@` is ordinary text: `"Email @support"` is said exactly like that.
- Inside `REF`, `@` is ordinary text.
- In descriptive fields, write `\@` for a literal `@`.

**Quotes**

- Dialogue and on-screen text are always in straight double quotes `"…"`.
- Inside them, write `\"` for a double quote and `\\` for a backslash. Single quotes and
  apostrophes need no escaping: `"It's fine."`

**Extras**

- Some lines take extras after the main content: `| key: value`, separated by `|`.
  Each line type lists the extras it accepts. Unknown or repeated extras are errors.
- In an unquoted value, write `\|` for a literal `|`.

**Times**

- Lengths and times are seconds with an `s`: `8s`, `6.5s`, `0.5s`. Ranges use `-`: `24-30s`.
- Every length and time must be a **whole number of frames** at the script's `FPS`
  (default 24). At 24 fps, `0.125s` is 3 frames; `0.1s` is not allowed. Steps of `0.5s` work
  at 16, 24 and 30 fps. The parser never rounds a time for you.
- Time spans include their start and exclude their end: a 4 s shot runs from `0s` up to, but
  not including, `4s`. `at:` can be `0s` but must be less than the length of its shot or scene.

**Writing language**

- Everything descriptive (looks, `VISUAL`, `CAMERA`, `FRAME`, `LIGHT`, `SFX` and `MUSIC`
  descriptions, rules) is written in **English**, because image, video and sound models
  follow English prompts best.
- Dialogue is written in the story's `LANGUAGE` (English by default). Names and
  proper nouns keep their own spelling.

## Header

Each key at most once, in this order:

| Key               | Required | Example / meaning                                                         |
| ----------------- | -------- | ------------------------------------------------------------------------- |
| `TITLE`           | yes      | `The Rain We Never Had`                                                   |
| `LOGLINE`         | no       | one sentence: what the story is about                                     |
| `GENRE`           | no       | `Romance, Science fiction`                                                |
| `LANGUAGE`        | yes      | language of dialogue: `English`                                           |
| `ASPECT`          | yes      | `16:9` or `9:16`                                                          |
| `RESOLUTION`      | no       | export size `WIDTHxHEIGHT`, matching `ASPECT` exactly: `1280x720`; even sizes, 16 to 4096 px |
| `FPS`             | no       | `24` (the default); H3 accepts no other value                             |
| `RUNTIME`         | yes      | exact `26s`, or a range `24-30s` (both ends included)                     |
| `STYLE`           | yes      | the visual style in a few words                                           |
| `SETTING`         | no       | the world in one or two sentences                                         |
| `STYLE PROMPT`    | no       | a full image/video style prompt used for every shot                       |
| `SPEECH RATE`     | no       | positive words per second for rough timing checks; default `2.5` (natural English) |

- `SPEECH RATE` is only an estimate for checking the script. Real speech length is measured
  after the voices are made.
- Leave out `ALT ASPECT` (an error with H3), `NEGATIVE PROMPT` and `HERO MAX` (not used).
  Say what you want in `STYLE PROMPT` instead of what you do not want.

## Characters, props and locations (`== CHARACTERS ==`)

### CHARACTER

```text
CHARACTER @aira | Aira Rahman | human
  ROLE: Female lead, sky designer
  AGE: 26
  GENDER: female
  FACE: oval face, soft jawline, small beauty mark under the left eye
  SKIN: warm light-brown
  EYES: dark brown, almond-shaped
  HAIR: shoulder-length wavy black hair, side part on the right
  BUILD: slim, average height
  OUTFIT: long charcoal-grey wool coat over a white turtleneck, black trousers
  ACCESSORIES: thin silver bracelet on the right wrist
  PERSONALITY: quiet, curious, lonely beneath her calm
  VOICE: soft, clear, thoughtful; warmer around Noah
  ACCENT: neutral American
  REF: refs/aira_front.png
  REF: refs/aira_profile.png
  VARIANT wet | scenes 22-25 | Hair and coat visibly wet.
```

- Header line: `CHARACTER @id | Display name | kind`, kind = `human`, `animal`, `hologram`,
  `voice_only` or `other`. A narrator is `CHARACTER @narrator | Narrator | voice_only`.
- Look keys (all optional, one line each): `FACE`, `SKIN`, `EYES`, `HAIR`, `BUILD`, `OUTFIT`,
  `ACCESSORIES`, `LOOK` (free description for non-humans). Write what must stay **identical in
  every scene**; these lines become the character's locked identity.
- A `voice_only` character has no look keys and no `REF`.
- `ROLE`, `AGE` (whole number), `GENDER`, `PERSONALITY`, `VOICE`, `ACCENT` are optional but
  help voice casting.
- `VOICE` is what H3 hears for every line of the character, so describe the voice concretely
  (`high, slow, sleepy`; `low, warm, unhurried`). `VOICE ID` is not used by H3: keep the `VOICE`
  words the same and the voice stays close between shots, but not identical.
- `REF` (optional, may repeat): a reference image path, relative to the folder of the script
  file. Front view first, then other angles. A reference helps the face stay the same; it
  does not guarantee it.
- `VARIANT name | scenes <list> | description` (may repeat) records a deliberate look change
  (wet, costume, injury). The list is numbers and ranges: `22-25`, `13`, `13, 17-19`. Only
  what the description changes is different; everything else stays locked. Two variants of
  the same character may not cover the same scene.

### PROP and LOCATION

```text
PROP @umbrella | Yellow umbrella
  LOOK: vintage golden-yellow umbrella with small hand-painted silver stars on the underside
  REF: refs/umbrella.png
  RULE: same size, shape, colour and pattern every time

LOCATION @shop | Umbrella shop
  LOOK: tiny vintage repair shop among cold futuristic stores, lanterns, umbrellas on hooks
  LIGHT: warm golden lantern light
  REF: refs/shop_interior.png
```

- `PROP` keys: `LOOK` (required), `REF`, `RULE`, `VARIANT` (the last three may repeat).
- `LOCATION` keys: `LOOK` (required), `LIGHT`, `REF`, `RULE`, `VARIANT` (`REF`, `RULE` and
  `VARIANT` may repeat).

## Rules and notes (`== RULES ==`)

```text
RULE: No real water anywhere before scene 21; scenes 18-19 are holographic rain only.
NOTE: Keep dialogue, narration, music and effects on separate audio tracks.
```

Only `RULE:` and `NOTE:` lines, each may repeat. `RULE` = a continuity rule. Every rule here, and
the `RULE` lines of each character, prop and location in a shot, is added to that shot's keyframe
prompt, without the parts that tell an event: a clause such as "Max lands on a soft cushion" or
"its cap pops open in the last shot" and an "until …" ending are left out, because an image model
draws every moment it is told about, in every shot. Write a `RULE` as how things look and stay
(`@doortrap stays on the right`); put what happens in `VISUAL` and `ACTION`. The H3 clip only gets
the rule clauses about who and what is in view, and never a clause about cuts or other shots. Nothing checks the generated output automatically: look at the
keyframes and redo a shot that breaks a rule. The parser checks the ids in a rule. `NOTE` = any
other production instruction (not sent to models).

## Scenes (`== SCENES ==`)

Scene header: `SCENE <number> | <length> | <title>`. Numbers start at 1 and go up by 1.
Scene start and end times follow from the order. The film's length is exactly the sum of
the scene lengths.

### A scene that is one shot

```text
SCENE 1 | 8s | The Perfect City
  AT: @skyline, late afternoon
  CAST: @aira, @narrator (voice)
  LIPSYNC: none
  MOOD: lonely, calm
  VISUAL: @aira stands alone on a glass rooftop, back to camera, looking out over the towers.
  CAMERA: Wide shot, slow push-in.
  FRAME: @aira in the centre; skyline on both sides
  LIGHT: flat, even artificial daylight
  MUSIC: Sparse cold piano. | fade_in: 0.5s
  TRANSITION: cut

  @narrator [VO]: "It hasn't rained here in fifty years." | at: 1s
  @aira [VO] (quietly): "Then why does it feel so empty?" | at: 4s
```

### A scene split into shots

```text
SCENE 2 | 12s | First Meeting
  AT: @shop
  CAST: @aira, @noah
  MOOD: curious, warm
  LIGHT: warm lanterns, cold blue neon spill through the door
  MUSIC: Cozy acoustic guitar.

  SHOT 1 | 4s | wide
    LIPSYNC: none
    VISUAL: @noah repairs @umbrella at his workbench as @aira steps through the door.
    FRAME: @noah right foreground; @aira in the doorway, centre background
    SFX: A small brass bell rings above the door. | at: 0.5s | length: 1s

  SHOT 2 | 4s | close-up
    LIPSYNC: required
    VISUAL: @aira runs a finger along a rib of @umbrella, intrigued.
    @aira: "Why repair umbrellas? Nobody needs them anymore." | at: 0s

  SHOT 3 | 4s | close-up
    LIPSYNC: required
    VISUAL: @noah looks up from the workbench, smiling.
    @noah (smiling): "Maybe someone will someday." | at: 1s
```

### Scene fields

Each at most once per scene, before the first beat or shot, written in this order (leave out
the ones you do not use):

| Key          | Required | Meaning                                                                               |
| ------------ | -------- | ------------------------------------------------------------------------------------- |
| `AT`         | yes      | one **location** id, optionally with a note: `@shop, next morning`                    |
| `CAST`       | yes      | who is in the scene with their presence (see below), or `none`                        |
| `CLIP`       | no       | `still` or `hero`; not used by H3 (every shot is a moving clip), so leave it out      |
| `LIPSYNC`    | no       | `required` or `none` (see **Lip sync**)                                               |
| `MOOD`       | no       | the emotion of the scene                                                              |
| `VISUAL`     | yes\*    | what the frame shows; the main image prompt                                           |
| `KEYFRAME`   | no       | one visible starting pose/state; overrides VISUAL for the still image only             |
| `CAMERA`     | no       | one shot size and movement; recognized sizes also control keyframe framing unless the SHOT header gives a size |
| `FRAME`      | no       | blocking: where each character and prop is in the frame                               |
| `LIGHT`      | no       | lighting for this scene (adds to the location's `LIGHT`)                              |
| `MUSIC`      | no       | the background score H3 makes for this scene's clips (see **Music**)                  |
| `TRANSITION` | no       | how this scene hands over to the next one (see **Transitions**); default `cut`        |

\* `VISUAL` is required in a scene without shots. In a scene with shots, every shot needs
its own `VISUAL`, and the scene `VISUAL` is optional (a general description shared by all
its shots).

`SFX` is a beat, never a scene field. `TEXT` is not available with H3.

### Cast presence

`CAST` lists ids separated by commas, each optionally followed by a presence in brackets:

```text
CAST: @aira, @noah (glimpsed), @narrator (voice)
```

| Presence       | Meaning                                                      |
| -------------- | ------------------------------------------------------------ |
| *(none)*       | visible: on screen, drawn with full locked look (default)    |
| `(glimpsed)`   | partly seen: from behind, in a mirror, at the edge of frame  |
| `(background)` | small or out of focus in the background                      |
| `(voice)`      | heard only, never drawn; speaks off screen                   |

- Only character ids go in `CAST`. Any other presence word is an error.
- A `voice_only` character must have `(voice)` presence.
- `CAST: none` means no dialogue and no character ids anywhere in the scene.

### Shots

- Shot header: `SHOT <number> | <length> | <size>`. The size is optional and is one of:
  `establishing`, `wide`, `medium`, `two-shot`, `over-the-shoulder`, `close-up`,
  `extreme close-up`, `insert`. Any other word is an error; put details in `CAMERA`.
- Shot numbers start at 1 in each scene. A shot is referred to as `scene.shot`, e.g. `2.3`.
- Shot lengths must add up exactly to the scene length.
- **Every shot is 4–15 s** (H3). A scene without shots is one shot, so it is 4–15 s too. A quick
  reaction that would be 2–3 s belongs at the end of the shot before it, or gets 4 s.
- Shot fields: `CLIP`, `LIPSYNC`, `VISUAL` (required), `KEYFRAME`, `CAMERA`, `FRAME`, `LIGHT`, in this
  order, before the shot's beats. A field not set in the shot is taken from the scene.
  `AT`, `CAST`, `MOOD` and `MUSIC` belong to the scene only.
- In a scene with shots, every beat belongs to a shot: beats are written inside `SHOT` blocks,
  never between the scene fields and the first shot.
- Shots inside a scene are always joined by hard cuts.
- One shot = one camera setup. If a moment needs two camera angles, it needs two shots.
- H3 makes each shot as one continuous take that starts on the keyframe's framing. `CAMERA`
  is one slow, continuous move (or static); never ask for a cut, a zoom to another shot size
  or "alternating" angles inside a shot.

### Beats

Beats are written in the order they happen, after the scene fields (or inside a shot).

| Line                         | Meaning                                                              | Extras                                  |
| ---------------------------- | -------------------------------------------------------------------- | --------------------------------------- |
| `ACTION: …`                  | something a character does, or a camera beat                         | `at:`                                   |
| `@id: "…"`                   | a spoken line                                                        | `at:`                                   |
| `@id (delivery): "…"`        | a spoken line with delivery: `(quietly)`, `(smiling through tears)`  | `at:`                                   |
| `@id [VO]: "…"`              | voice-over: heard, not spoken on screen (narration, inner voice)     | `at:`                                   |
| `@id [VO] (delivery): "…"`   | voice-over with delivery; `[VO]` always comes before `(delivery)`    | `at:`                                   |
| `SFX: …`                     | a sound effect                                                       | `sound:`, `length:`, `at:`              |

- **Speakers:** a speaker must be a character in the scene's `CAST`. A speaker with `(voice)`
  presence is heard off screen. `[VO]` marks narration and inner voice; it never needs lip sync.
- **`at:`** is measured from the start of the beat's shot (or scene, if it has no shots).
  An `ACTION` with `at:` reaches H3 as "At 2.0s: …", in time order, and a spoken line's
  `at:` is its time in the shot; H3 treats both as a guide, not an exact cue.
  A beat without `at:` is not placed at `0s` or spaced evenly: its time is left for the timing
  step to decide. Give `at:` to every spoken line and `SFX` whenever you can.
- **Dialogue:** H3 is told who says the exact words, with the `(delivery)` and the
  character's `VOICE`, and "off screen" for a `(voice)` or `[VO]` speaker. Keep the words
  exactly as they should be heard.
- **`SFX`:** describe the sound in words; the shot's `SFX` descriptions are added to H3's
  soundscape for that clip, together with natural ambience. `sound:` gives a fuller
  description and is required when the SFX text is only a word: `SFX: "BOING!" | sound:
  cartoon spring boing | length: 1s`. Give `length:` and `at:` so the script reads clearly;
  H3 places the sound itself. A sound effect never carries over into the next shot.
- **No `TEXT`:** H3 has no text overlay, and the dashboard rejects a `TEXT` line. Titles,
  labels and signs are left out, or shown as an object without readable words.
- H3 videos have no captions yet.

### Ids inside text

In `VISUAL`, `KEYFRAME`, `ACTION` and `FRAME`, an `@id` means **"this one is in the frame"**:

```text
VISUAL: @noah opens @umbrella above @aira; she looks up at the painted stars.
```

For a shot spanning several moments, give the initial image its own concrete pose:

```text
    VISUAL: @noah opens @umbrella, revealing its painted stars.
    KEYFRAME: @noah holds the closed @umbrella upright, one hand on its opening mechanism.
    CAMERA: Static medium shot.
    ACTION: @noah opens @umbrella. | at: 0.5s
```

`KEYFRAME` is optional, placed after `VISUAL` and before `CAMERA`, and can be inherited
from a scene. With it, initial reference selection, image generation and still-image checks
use `KEYFRAME` plus `FRAME`; the H3 clip starts on that keyframe and follows `VISUAL` and timed
`ACTION`. List
characters/props that must already be visible in `KEYFRAME`. An action-only later arrival
does not become an extra initial-frame character. `VISUAL` remains required. Escaped `\@`
stays literal. Without `KEYFRAME`, existing scripts keep their VISUAL-based image prompts.
Clearly sequential descriptions are flagged for a frame decision rather than endlessly
retried. This warning is conservative and English-based; explicitly write `KEYFRAME` for
ambiguous descriptions in any language.

See [shot repair behavior and settings](SHOT_REPAIR.md).

- The parser attaches the locked look (and `REF` images) of every id it finds, so the image
  model gets the full description every time. Never repeat look details in the scene.
- At most eight characters and props with an `@id` in one shot: H3 takes one reference
  image for each, plus the keyframe.
- Use an `@id` only for characters and props that are visible in that shot. Refer to someone
  off screen in plain words, without `@`: `FRAME: @noah centred; Aira off camera to the left`.
- A character id used here must be in the scene's `CAST`, and not with `(voice)` presence.
- A look change in a scene must come from a `VARIANT`, never from words in `VISUAL`.

### Lip sync

`LIPSYNC: required` or `LIPSYNC: none`, in a scene or a shot (a shot's value overrides the
scene's).

H3 makes the speaking mouth together with the voice, so there is no separate lip-sync step
and the value does not change the clip. Still write it, because the parser warns when it is
missing:

- `required`: a visible character speaks (not `[VO]`) in this shot.
- `none`: narration, inner voice, speakers off screen, or a shot where no one visible speaks.
- With the dashboard's **Spoken dialogue** switch off, the clips have no dialogue.

### Music

`MUSIC` is a scene field. The music track works like this:

```text
MUSIC: Slow sparse piano. | sound: high-register felt piano | fade_in: 0.5s | fade_out: 1s
MUSIC: stop
```

- `MUSIC: <description>` starts a new piece at the start of the scene, replacing any music
  that was playing.
- **No `MUSIC` line:** the music from the previous scene keeps playing without restarting.
  In the first scene, no `MUSIC` line means no music.
- `MUSIC: stop` ends the music at the start of the scene. `stop` takes no extras.
- Extras on a description: `sound:` (a fuller description for the music model),
  `fade_in:` (over the first part of this scene) and `fade_out:` (over the last part of the
  last scene this piece plays in). A fade must fit inside its scene.
- H3 makes the music inside each clip from the description of the piece playing during that
  shot (`No background score.` when none is), so a piece restarts slightly at every cut. To
  keep one piece going, leave `MUSIC` out of the next scenes: the same description is used.
- Dialogue, effects and music come out of H3 already mixed in each clip.

### Transitions

`TRANSITION: <type> [length] | note: …`

| Type       | Meaning                                              | Example                            |
| ---------- | ---------------------------------------------------- | ---------------------------------- |
| `cut`      | hard cut to the next scene (default)                 | `TRANSITION: cut`                  |
| `dissolve` | this scene blends into the next one                  | `TRANSITION: dissolve 1s`          |
| `fade`     | fade to black, then the next scene fades in          | `TRANSITION: fade 1s`              |

- `dissolve` and `fade` need a length; `cut` has none.
- `note:` describes the creative idea (`note: match cut on the umbrella`); it never changes
  the type.
- A transition **never changes the film's length**; it happens inside the scene lengths:
  - `dissolve L`: centred on the boundary, half of `L` at the end of this scene and half at
    the start of the next (with an odd number of frames, the extra frame is in this scene).
  - `fade L`: this scene fades to black in the first half of `L`, ending at the boundary;
    the next scene fades in from black in the second half.
- The last scene may use `cut` or `fade` (a fade to black over its last `L`), not `dissolve`.
- A transition must fit in the scenes it touches, and two transitions may not overlap in
  the same scene.

## Checks the parser makes

Errors (the script is not accepted until fixed):

- first line is not exactly `DRAMA SCRIPT`; a BOM; sections missing or out of order
- a required key is missing or empty; an unknown key, extra or line; a key repeated in a block
- tabs, or a line at the wrong indent; an unclosed or unescaped quote
- an `@id` that is malformed, undefined, defined twice, or of the wrong kind (e.g. `AT` with a prop)
- a speaker not in the scene's `CAST`
- a character id in `VISUAL`, `ACTION` or `FRAME` that is not in `CAST`, or has `(voice)`
- a `voice_only` character without `(voice)`, or with look keys or `REF`
- a `PROP` or `LOCATION` without `LOOK`; a scene or shot without the `VISUAL` it needs
- scene numbers not 1, 2, 3, …; shot numbers not 1, 2, 3, … within a scene
- a length or time that is not a positive whole number of frames (`at:` may be `0s`)
- shot lengths that do not add up to their scene length
- scene lengths that add up to something outside `RUNTIME`
- `RESOLUTION` not in `WIDTHxHEIGHT` form or not matching `ASPECT`; `FPS` not a whole number
- a beat between the scene fields and the first shot in a scene that has shots
- an `at:` time, or `at:` + `length:`, past the end of its shot or scene
- an unknown presence word, shot size, `CLIP`, `LIPSYNC`, `TEXT mode` or `TRANSITION` type
- a `dissolve`/`fade` without a length, or a `dissolve` on the last scene
- a fade or transition that does not fit its scene, or two transitions overlapping in one scene
- `MUSIC: stop` with extras
- two `VARIANT`s of one character, prop or location covering the same scene, or a `VARIANT`
  pointing at a scene that does not exist
- an `SFX` that is only a quoted word without `sound:`

Warnings (shown for review):

- a character in `CAST` who never appears (no id in any `VISUAL`, `ACTION` or `FRAME`, and
  never speaks)
- a visible character in `CAST` whose id is not in any `VISUAL` of the scene
- a visible speaker (not `[VO]`) in a shot with no `LIPSYNC` set
- a spoken line, `SFX` or `TEXT` without `at:`; a `TEXT` without `length:` or `where:`
- a spoken line whose estimated length (words ÷ `SPEECH RATE`) runs past the end of its
  shot or scene, or leaves less than 1 s after the last line
- two spoken lines that overlap in time (from `at:` and estimated length)
- a `REF` file that cannot be found
- dialogue or `TEXT` that does not seem to be in `LANGUAGE`

The speech checks use an estimate.

H3 errors (shown by the dashboard's check when the H3 engine is chosen, and by the runner
before anything is installed):

- `FPS` other than 24, or an `ALT ASPECT`
- a shot, or a scene without shots, shorter than 4 s or longer than 15 s
- a `TEXT` line

## Writing tips for good output

- **Looks:** concrete and visual (`shoulder-length wavy black hair`), not judgements
  (`beautiful`). Same words every time something reappears.
- **VISUAL:** describe one frame or one simple movement: who is where, doing what, with
  which props and light. Use `@ids` for what is visible; describe everything else by what it
  looks like.
- **One camera per shot:** if `CAMERA` would need "alternating", "cut to" or "reverse angle",
  split the scene into shots instead.
- **Movement:** every shot moves. Give each shot one clear movement (a turn, a step, an
  umbrella opening), and a quiet shot a small one (breathing, steam, a slow look up).
- **No readable text:** never ask for words in `VISUAL` (a sign that reads …); image and video
  models draw garbled letters, and H3 has no `TEXT` overlay.
- **Sounds:** every sound goes in `SFX:` or `MUSIC:`, never only inside `VISUAL`.
- **Timing:** keep spoken lines short enough to fit the shot with room for a reaction.
  At 2.5 words/s, a 4 s shot holds about 7 words comfortably.
- **Consistency:** once a face looks right, add its `REF` so every later run reuses it.
- **Voices:** give every speaking character `GENDER`, and `AGE` for people. Add a `VOICE` line
  for anyone who should not sound like an ordinary adult (`raspy, slow, a little deaf`;
  `squeaky and fast`; `slightly robotic`). For animals `AGE` does not change the voice; say it
  in `VOICE`.
- **Say what is there, not what is not:** `VISUAL: a plush toy fish` works; `not a real fish`
  or `no people` often makes the image or video model draw exactly that. Use a `RULE` only for
  what the reader must know, and phrase it positively where you can.
- **Talking shots:** give a shot where someone speaks on screen a `static` or `gentle`
  camera, one speaker in close-up, and 1–2 s after the line for the reaction. Show the hands in `VISUAL` if the line needs a gesture: what the keyframe hides,
  the video model invents.
- **Inserts:** for a hands-only, paws-only or object shot, write it as one (`close-up of @sam's hands`,
  `close-up of @finn's front paws`) and keep the faces out of `VISUAL` and `FRAME`.
- **Single-moment keyframes (`KEYFRAME`):** an image model draws one frozen instant. Never rely on
  a sequence (`then`, `begins shaking`), a before-to-after expression transition (`guilty expression
  melts into gratitude`), or an invisible micro-motion (`nose twitches`) as the still-frame prompt.
  Whenever `VISUAL` has movement or a transition over time, add an explicit `KEYFRAME:` line with
  the exact single pose and expression for frame 0, and put the movement in `VISUAL` and `ACTION:`.
- **Keyframe before the big moment:** for a hit, fall, flight or crash, the `KEYFRAME` is the
  instant just before it (the glove bursting out of the hatch while the visitor still faces the
  door), not the person in mid-air. The image model draws a still pose well and a flying body
  poorly; the clip makes the movement.
- **One copy of everything:** an object held in a hand is not also on the table. Name where each
  prop is, once.
- **Walls and rooms that break:** a wall, floor or doorway is part of the `LOCATION`, or a prop
  whose `LOOK` says `solid flat wall, no opening, no doorway`. A prop's reference image is drawn
  alone on a plain background, so an unclear wall turns into an arch.

## Instructions for AI writers

This section is for any AI that writes or converts a script. Paste the prompt below at the
start of the request, followed by this whole file and the story or idea.

### Prompt to paste

~~~text
You are writing a drama script in DRAMA SCRIPT format for the H3 engine. The full format
specification follows this message. Follow it exactly; a code parser will reject anything else.

Planning workflow (complete these 4 steps in your reasoning before writing the script, or
show steps 1–3 first if the user asks to review the outline before the full script):
1. LOGLINE: Write one sentence that states the protagonist, the core conflict/problem, and
   the spirit of the twist.
2. SYNOPSIS & VARIANTS: Map the 5-part story shape (Hook 10–15%, Problem 20–25%,
   Escalation 30–40%, Twist 70–85%, Ending 10–15%) and list every CHARACTER, PROP and
   LOCATION @id, including any state changes that need a VARIANT (e.g. whole vs. broken,
   clean vs. messy) with their exact scene numbers.
3. SCENE & SHOT BEATS: Break the story into numbered scenes and shots whose lengths add up
   exactly to each scene length and total RUNTIME. For every shot, decide:
   - Shot size (wide, medium, two-shot, close-up, insert) and who is visible in FRAME
   - The single frozen instant for the still image (KEYFRAME) vs. the movement over time
     (VISUAL / ACTION), ensuring no sequence ("then", "begins to") or before-to-after emotion
     transition is left without an explicit KEYFRAME line
   - Spoken lines (at 2.5 words/s, leaving >= 1s buffer in the shot) and SFX timings
   - A length of 4–15 s (5–8 s is best); merge any shorter moment into a neighbouring shot
4. FULL SCRIPT: Emit the complete, parser-valid DRAMA SCRIPT from the beat sheet.

Output rules:
- Unless the user explicitly asks to review the outline first, output only the final script
  inside one ```text code block. No explanation before or after.
- The first line inside the block is exactly: DRAMA SCRIPT
- Use only the keys, line types, extras, presence words, shot sizes, LIPSYNC values
  and transition types defined in the specification. Never invent new keys.
- H3 limits: every shot (and every scene without shots) is 4–15 s; FPS: 24; ASPECT 9:16 or
  16:9; no TEXT lines, no ALT ASPECT, no NEGATIVE PROMPT, no HERO MAX, no CLIP lines.
- Copy the structure of the blank template and the complete example.
- Indent with spaces only: 2 inside blocks, 4 inside SHOT blocks.
- Use straight double quotes "…" for dialogue. Never curly quotes.
- Write every description in English. Write dialogue in the script's LANGUAGE.
- Use @ids in VISUAL, KEYFRAME, ACTION and FRAME only for what is visible in that shot.
- Never write @ids in CAMERA, MOOD, LIGHT, LOOK, SFX, MUSIC or TRANSITION; name people
  and things there in plain words ("push toward Ben", "holding Ben and the remote").
- Write each RULE as how something looks or stays, never as an event ("lands on a cushion",
  "bounces through the wall", "until the finale"): events go in VISUAL and ACTION.
- For a hit, fall, flight or crash, the KEYFRAME is the instant just before it, not mid-air.
  For hands-only or paws-only insert shots, write `@id's hands` or `@id's paws` in every mention.
- Write each character's look only in their CHARACTER block, never in scenes.
- When a shot's VISUAL describes a sequence of actions or an expression transition, add a
  KEYFRAME line describing one frozen visible pose and expression for the still image.
- Give at: to every spoken line and SFX; give length: to every SFX.
- Use times that are whole frames at the FPS: steps of 0.5s are always safe.
- Set LIPSYNC on every scene or shot where a visible character speaks.
- Tell a complete story in the story shape of the specification: a movie-style beginning, a
  clear problem, a twist (funny in a comedy), and a satisfying ending. If the idea is thin,
  add what is missing; never end on the problem. Any RUNTIME works, but a viewer must
  understand what happened from the pictures, like a movie (see "Clear like a movie").
- Before answering, run the self-check in the specification and fix every problem.

Story or idea:
<paste the story, outline or idea here>

Target: <runtime, e.g. 60s> · <aspect, e.g. 9:16> · <style, e.g. soft cinematic realism>
~~~

### Story shape

Every script tells one complete story, the way a film does, at any `RUNTIME`: 15 seconds or
several minutes. The parts keep their share of the runtime; a longer film gets more scenes in
each part, not a slower start:

| Part | Share of `RUNTIME` | What happens |
| ---- | ------------------ | ------------ |
| 1. Movie-style beginning (hook) | first 10–15 % | An image that grabs attention and shows who and where at once: a striking establishing shot, a close-up of the key prop, or the first line already mid-action. No slow intro, no title card first. |
| 2. Clear problem | next 20–25 % | What the main character wants and what stands in the way, in one beat the viewer understands without explanation: the last slice, a missing toy, an alarm that will not stop. |
| 3. Escalation | middle 30–40 % | Each attempt makes it worse or the stakes higher. Each shot adds something new; never repeat a beat. |
| 4. Twist | about 70–85 % in | The thing the viewer did not expect, which changes how the problem looks. In a comedy it is funny (the culprit was the narrator, the cat was the CEO all along); in other genres it is a turning point or reveal. It must follow from something shown earlier (a prop, a line, a look), so it feels earned. |
| 5. Satisfying ending | last 10–15 % | The problem resolves, or turns around, and lands on a button: a final line, a reaction, or a callback to the beginning. Leave 1–2 s after the last line for the reaction and the music to finish. |

- A 12–20 s story can merge 2 and 3, and 4 and 5, but still needs hook, problem, twist and ending.
- A story of several minutes keeps one main problem and adds attempts, setbacks and a
  low point before the twist, rather than a second unrelated story.
- Write `LOGLINE` as the whole story in one sentence, twist included in spirit
  (`A cat CEO fires everyone for napping, then falls asleep in his own meeting.`).
- Plant the twist: the prop, line or detail it depends on is visible or heard before it.
- Every scene changes something: a new problem, a new attempt, a reveal or the payoff.
- Give the main character a clear want and a recognisable personality (`PERSONALITY`), so
  their reactions are funny or moving instead of generic.
- Dialogue is short and in character; the best line is usually the last one. No line explains
  what the picture already shows.
- Use sound for comedy timing: a beat of silence, an `SFX` sting or a music stop right before
  the punchline.

### Clear like a movie

A viewer who watches once, with the sound off or on, must be able to say what happened. Show
it on screen; dialogue only adds to it.

- **Where and who first:** every new place starts with a wide or establishing shot (`AT` the
  location, the characters in it) before the close-ups.
- **Cause, then effect, then reaction:** show what happens (the cat pushes the cup), its
  result (the cup falls, `SFX` crash) and someone's reaction, each in its own shot when it
  matters.
- **One idea per shot:** each shot answers one question (what does she see, what does he do,
  how does she feel). If the `VISUAL` needs "and then", it is two shots.
- **Key information in the picture:** the prop the twist depends on is seen clearly, close
  enough to read, at least once before the twist.
- **Faces tell the feeling:** give important lines and the twist a close-up reaction shot.
- **Time and place changes are marked:** a new scene with an establishing shot, a `fade` or
  `dissolve`, or a narrator line (`Next morning…`).
- **Same direction:** keep who is on the left and who is on the right the same within a scene,
  so the viewer never loses track.
- **The ending shows the result:** the last scene makes the outcome visible (the empty plate,
  the sleeping CEO), not only said.

### How to turn a story into scenes

- Pick the number of scenes from `RUNTIME`: most scenes are 5–12 s, made of one to three
  shots of 4–8 s. A 60 s story is usually 6–9 scenes and 8–12 shots.
- One scene = one place and one continuous moment. A new place or a time jump is a new scene.
- Split a scene into shots whenever the camera angle changes. In a dialogue exchange, give
  each spoken line its own close-up shot with `LIPSYNC: required`.
- Keep each spoken line short: at 2.5 words/s, about 7 words per 4 s shot.
- Define every character, prop and location before the scenes, with full looks, even if the
  story does not describe them: invent concrete details and then keep them.
- Every sound in the story becomes an `SFX` or `MUSIC` line. Readable words (titles, signs)
  are left out: tell that part with a picture, a line of dialogue or the narrator.
- Music keeps playing into the next scene unless that scene starts new music or says
  `MUSIC: stop`.

### Blank template

```text
DRAMA SCRIPT

TITLE:
LOGLINE:
GENRE:
LANGUAGE: English
ASPECT: 9:16
RESOLUTION: 1080x1920
FPS: 24
RUNTIME:
STYLE:
SETTING:
STYLE PROMPT:

== CHARACTERS ==

CHARACTER @id | Display name | human
  ROLE:
  AGE:
  GENDER:
  FACE:
  SKIN:
  EYES:
  HAIR:
  BUILD:
  OUTFIT:
  ACCESSORIES:
  PERSONALITY:
  VOICE:
  ACCENT:

CHARACTER @narrator | Narrator | voice_only
  VOICE:
  ACCENT:

PROP @id | Display name
  LOOK:

LOCATION @id | Display name
  LOOK:
  LIGHT:

== RULES ==

RULE:
NOTE:

== SCENES ==

SCENE 1 | 8s | Title
  AT: @location
  CAST: @id, @narrator (voice)
  LIPSYNC: none
  MOOD:
  VISUAL:
  KEYFRAME:
  CAMERA:
  FRAME:
  LIGHT:
  MUSIC: | fade_in: 0.5s
  TRANSITION: cut

  ACTION: | at: 1s
  @narrator [VO]: "" | at: 0.5s
  SFX: | length: 1s | at: 2s

SCENE 2 | 12s | Title
  AT: @location
  CAST: @id, @id
  MOOD:
  MUSIC:
  TRANSITION: fade 1s

  SHOT 1 | 6s | wide
    LIPSYNC: none
    VISUAL:
    CAMERA:
    FRAME:

  SHOT 2 | 6s | close-up
    LIPSYNC: required
    VISUAL:
    CAMERA:
    @id: "" | at: 0.5s
```

Fill every value. Delete every line you do not use. Never leave an empty value in the
final script.

### Common mistakes

| Mistake                                                        | Correct                                                      |
| -------------------------------------------------------------- | ------------------------------------------------------------ |
| `**SCENE 1**`, `# Characters`, other markdown                  | plain lines exactly as in the template                       |
| curly quotes `“Hello”`                                         | straight quotes `"Hello"`                                    |
| `VISUAL: Aira smiles at Noah.`                                 | `VISUAL: @aira smiles at @noah.`                             |
| `VISUAL: @noah answers @aira.` while Aira is off screen        | `VISUAL: @noah answers someone off camera.`                  |
| look details in `VISUAL` (`@aira, in her grey coat…`)          | only the `@id`; the look comes from her block                |
| `VISUAL: … a sign reads "OPEN" …` or any `TEXT:` line          | leave the words out: `a small wooden sign on the door`       |
| `VISUAL: … thunder rumbles …`                                  | `SFX: Distant thunder rumbles. \| length: 2s \| at: 1s`      |
| `CAMERA: alternating close-ups`                                | one `SHOT` per angle                                         |
| `TRANSITION: Smooth fade into the night.`                      | `TRANSITION: fade 1s \| note: into the night`                |
| `SHOT 1 \| 4s \| tight close shot`                             | `SHOT 1 \| 4s \| close-up`, details in `CAMERA`              |
| `CAST: @aira (offscreen)`                                      | `CAST: @aira (voice)`                                        |
| `NARRATOR: "…"`                                                | `@narrator [VO]: "…"` with `@narrator (voice)` in `CAST`     |
| a speaker missing from `CAST`                                  | add them to `CAST`                                           |
| visible speaker without `LIPSYNC`                              | `LIPSYNC: required` on that shot                             |
| `MUSIC: same as before`                                        | leave `MUSIC` out; the music keeps playing                   |
| `SFX: bell \| 2s`                                              | `SFX: A bell rings. \| length: 2s \| at: 0.5s`               |
| `at: 0.1s` at 24 fps                                           | `at: 0s` or `at: 0.5s`                                       |
| a beat written before `SHOT 1`                                 | move it inside a shot                                        |
| shots `4s + 4s + 3s` in a `12s` scene                          | shot lengths add up exactly to the scene length              |
| a new key such as `EMOTION:` or `PROPS:`                       | only keys from this specification                            |
| `SHOT 2 \| 3s \| close-up` or a 3 s one-shot scene              | 4–15 s: merge the moment into the shot before, or make it 4 s |
| `ALT ASPECT: 9:16`, `NEGATIVE PROMPT:`, `CLIP: hero`            | leave them out; H3 does not use them                         |
| `CAMERA: close-up, then cut to a wide shot`                    | one continuous move per shot; a new angle is a new `SHOT`     |
| `CAMERA: Slow push toward @ben.`                               | `CAMERA: Slow push toward Ben.`: no `@id` outside id fields   |
| `RULE: @max bounces through @wall_panel and lands on a cushion.` | the event in that shot's `VISUAL`; a `RULE` says how things stay |
| `KEYFRAME: @max flies horizontally across the corridor`          | the instant before: `@max mid-knock as @glove bursts from the hatch` |
| `@tacos` for a prop defined as `@taco`                         | the exact id: `two @taco plates`, never a plural id          |

### Self-check before output

1. The first line is `DRAMA SCRIPT`, and the sections are in order.
2. Every `@id` used anywhere is defined exactly once, and `AT` uses a location id.
3. Every speaker and every character id in `VISUAL`, `ACTION` and `FRAME` is in that
   scene's `CAST`; no `(voice)` character is described as visible.
4. Ids in `VISUAL`, `ACTION` and `FRAME` are only for what is visible in that shot, and
   `CAMERA`, `MOOD`, `LIGHT`, `LOOK`, `SFX`, `MUSIC` and `TRANSITION` contain no `@id`.
5. Every `RULE` describes how things look or stay, never an event; every `KEYFRAME` of a
   hit, fall or flight is the instant before it; no prop is in two places in one frame.
6. Scene numbers are 1, 2, 3, …; shot numbers restart at 1 in each scene.
7. Shot lengths add up exactly to their scene length; scene lengths add up to a number
   inside `RUNTIME`.
8. Every time and length is a whole number of frames at the `FPS`.
9. Every spoken line and `SFX` has `at:`; every `SFX` has `length:`. All of them end
   inside their shot or scene.
10. Every spoken line fits its shot or scene with at least 1 s spare (words ÷ 2.5), and no
   two lines overlap.
11. Every shot where a visible character speaks has `LIPSYNC: required`.
12. Music changes are deliberate: new music, `MUSIC: stop`, or no line to keep it playing.
13. No sound appears only inside `VISUAL`, and nothing asks for readable words.
14. Every `LIPSYNC`, `TRANSITION`, shot size and presence word is from the fixed lists, and
    the last scene does not `dissolve`.
15. No empty values, no markdown, no curly quotes, no tabs.
16. The story has a hook in the first seconds, a clear problem, a twist that was set up
    earlier, and an ending with a button and 1–2 s to breathe.
17. Watching the pictures alone, a viewer can tell where it happens, who wants what, what
    went wrong, the twist and how it ended.
18. Every speaking character has `GENDER` (and `AGE` for people) and a concrete `VOICE`;
    talking shots have a calm camera.
19. Every shot whose `VISUAL` contains a sequence of actions or a before-to-after emotion
    change has a `KEYFRAME` line describing a single static pose and expression.
20. H3: every shot (and every scene without shots) is 4–15 s; `FPS: 24`; no `TEXT`,
    `ALT ASPECT`, `NEGATIVE PROMPT`, `HERO MAX` or `CLIP` lines; at most eight `@id`s in
    view per shot.

## Complete example

```text
DRAMA SCRIPT

TITLE: The Rain We Never Had
LOGLINE: In a city where it never rains, a sky designer meets the man who still repairs umbrellas.
GENRE: Romance, Science fiction
LANGUAGE: English
ASPECT: 16:9
RESOLUTION: 1280x720
FPS: 24
RUNTIME: 24-30s
STYLE: soft cinematic realism, cold city against warm shop
SETTING: A spotless future city under a perfect artificial sky. It has not rained in fifty years.
STYLE PROMPT: cinematic film still, 35mm lens, shallow depth of field, soft film grain,
    teal-and-amber colour grade, realistic skin texture, natural hands

== CHARACTERS ==

CHARACTER @aira | Aira Rahman | human
  ROLE: Female lead, sky designer
  AGE: 26
  GENDER: female
  FACE: oval face, soft jawline, small beauty mark under the left eye
  SKIN: warm light-brown
  EYES: dark brown, almond-shaped
  HAIR: shoulder-length wavy black hair, side part on the right
  BUILD: slim, average height
  OUTFIT: long charcoal-grey wool coat over a white turtleneck, black trousers
  ACCESSORIES: thin silver bracelet on the right wrist
  PERSONALITY: quiet, curious, lonely beneath her calm
  VOICE: soft, clear, thoughtful; warmer around Noah
  ACCENT: neutral American

CHARACTER @noah | Noah Park | human
  ROLE: Male lead, umbrella repairer
  AGE: 29
  GENDER: male
  FACE: square face, light stubble, laugh lines at the eyes
  SKIN: light olive
  EYES: dark brown
  HAIR: short messy black hair
  BUILD: tall, lean
  OUTFIT: rolled-up sleeves on a faded blue work shirt, brown canvas apron
  ACCESSORIES: small brass screwdriver tucked behind the right ear
  PERSONALITY: gentle, patient, quietly hopeful
  VOICE: low, warm, unhurried
  ACCENT: neutral American

CHARACTER @narrator | Narrator | voice_only
  VOICE: calm, mature, a little wistful
  ACCENT: neutral British

PROP @umbrella | Yellow umbrella
  LOOK: vintage golden-yellow umbrella with a curved wooden handle and small hand-painted
      silver stars on the underside
  RULE: same size, shape, colour and pattern every time

LOCATION @skyline | City rooftop
  LOOK: glass rooftop terrace above white and silver towers, a flawless cloudless blue sky
      with a faint artificial grid shimmer
  LIGHT: flat, even, shadowless daylight

LOCATION @shop | Umbrella shop
  LOOK: tiny vintage repair shop between cold futuristic stores, paper lanterns, dozens of
      umbrellas hanging on wall hooks, a cluttered wooden workbench
  LIGHT: warm golden lantern light

== RULES ==

RULE: No real water anywhere in this story.
RULE: @umbrella is closed in scenes 1 and 2 and opens only in scene 3.
NOTE: Keep dialogue, narration, music and effects on separate audio tracks.

== SCENES ==

SCENE 1 | 8s | The Perfect City
  AT: @skyline, late afternoon
  CAST: @aira, @narrator (voice)
  LIPSYNC: none
  MOOD: lonely, calm
  VISUAL: @aira stands alone at the glass railing of the rooftop, back to camera, looking
      out over the towers under the perfect sky.
  CAMERA: Wide shot, slow push-in toward her.
  FRAME: @aira in the centre; towers on both sides
  MUSIC: Sparse cold piano. | sound: slow solo piano, high register, lots of space between notes | fade_in: 0.5s | fade_out: 1s
  TRANSITION: cut | note: on a gust of wind

  @narrator [VO]: "It hasn't rained here in fifty years." | at: 1s
  @aira [VO] (quietly): "Then why does it feel so empty?" | at: 4s

SCENE 2 | 12s | First Meeting
  AT: @shop, a few minutes later
  CAST: @aira, @noah
  MOOD: curious, warm
  LIGHT: cold blue neon spill through the open door
  MUSIC: Cozy acoustic guitar. | sound: soft fingerpicked acoustic guitar, warm, slow | fade_in: 0.5s | fade_out: 1s

  SHOT 1 | 4s | wide
    LIPSYNC: none
    VISUAL: @noah sits at the workbench repairing the closed @umbrella as @aira steps
        through the doorway.
    CAMERA: Static wide shot from behind the workbench.
    FRAME: @noah right foreground; @aira in the doorway, centre background
    SFX: A small brass bell rings above the door. | sound: bright, delicate shop bell | length: 1s | at: 0.5s

  SHOT 2 | 4s | close-up
    LIPSYNC: required
    VISUAL: @aira runs a finger slowly along a rib of the closed @umbrella on the workbench.
    CAMERA: Close-up on her hand and face, slight drift right.
    FRAME: @aira centred; @umbrella in the near foreground
    @aira: "Why repair umbrellas? Nobody needs them anymore." | at: 0s

  SHOT 3 | 4s | close-up
    LIPSYNC: required
    VISUAL: @noah looks up from the workbench, smiling at someone off camera.
    CAMERA: Close-up, static, hold on eye contact.
    FRAME: @noah centred; Aira off camera to the left
    @noah (smiling): "Maybe someone will someday." | at: 1s

SCENE 3 | 6s | Stars Underneath
  AT: @shop
  CAST: @aira, @noah (glimpsed)
  LIPSYNC: none
  MOOD: wonder
  VISUAL: @noah, seen only from the shoulder, opens @umbrella above @aira; she looks up at
      the silver stars painted on its underside, lantern light on her face.
  CAMERA: Low-angle close-up, slow tilt up to the underside of the umbrella.
  FRAME: @aira centre; @umbrella fills the top of the frame; @noah at the right edge
  TRANSITION: fade 1s

  SFX: An umbrella snaps open. | sound: fabric umbrella opening indoors, soft whump | length: 1s | at: 0.5s
  ACTION: @aira's eyes widen and a small smile appears. | at: 2s
```

**Timing check of the example**

- Story shape: the hook is the lone figure above a perfect, rainless city; the problem is her
  emptiness ("Then why does it feel so empty?"); the twist, set up by the closed umbrella on
  the workbench in scene 2, is the umbrella opening to show stars underneath; the ending is her looking
  up at them. In a comedy the twist would be the joke.
- Scenes: 8 + 12 + 6 = 26 s (624 frames at 24 fps), inside `RUNTIME` 24–30 s. Scene 2 shots:
  4 + 4 + 4 = 12 s. Every shot is 4–15 s: five H3 clips of 8, 4, 4, 4 and 6 s.
- Scene 1: the narrator's 7 words take about 2.8 s (1 s → 3.8 s); Aira's 7 words take about
  2.8 s (4 s → 6.8 s), leaving 1.2 s.
- Shot 2.2: 7 words, 0 s → 2.8 s, leaving 1.2 s. Shot 2.3: 4 words, 1 s → 2.6 s, leaving 1.4 s.
- Music: H3 makes the piano in the scene 1 clip and the guitar in every clip of scenes 2
  and 3 (no `MUSIC` line in scene 3, so the guitar description continues). The film ends
  with the `fade 1s` to black.
- In shot 2.3, Aira is off camera, so she is written without `@` and is not drawn.
