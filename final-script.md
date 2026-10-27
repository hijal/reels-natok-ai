# Final Script — Common Drama Script Standard

Use this file as the common reference for writing new stories, converting existing scripts,
and planning future episodes. It defines the character, scene, dialogue and timing
conventions for this project's MiniMax H3 workflow.

Default delivery: **English-language drama, MiniMax H3, 9:16, 1080×1920, 24 fps,
usually a 60- or 120-second episode**. Shorter episodes are also allowed.
All instructions, descriptions, dialogue, templates and examples in this standard are English.
The story can take place anywhere; do not assume a particular country, culture or accent
unless the source story specifies one.

This `.md` file is a format guide. Save each actual drama script as a separate UTF-8 `.txt`
file whose first line is `DRAMA SCRIPT`. Use the AI conversion prompt and template below.

## 1. Supported production profile

| Topic | Project convention |
| --- | --- |
| Structure | Header, characters, rules and scenes, in that order |
| Character continuity | Stable IDs, look and voice descriptions, references and intentional variants |
| Video | One continuous generated shot per scene; omit `CLIP` |
| Dialogue/audio | Native mixed video/audio; English dialogue, voice intent and SFX |
| Timing | **5–15s per render shot**, matching the Colab importer |
| Delivery | **9:16, 1080×1920, 24 fps** |
| On-screen text | Omit `TEXT`; overlays and captions are outside this profile |
| Music | Creative description, without a seamless recording guarantee |
| Transition | **cut**, matching current Colab assembly |
| Voice controls | `VOICE` and `ACCENT`, without a guaranteed identity/voice lock |

The current workflow uses model prompts for appearance, action, voices and audio.
Approved keyframes, separate voice/audio stems, overlays and audio mastering are
outside this production profile. The importer supports one-shot scenes; it rejects
multi-shot `SHOT` blocks.

## 2. Using the format with the current Colab notebook

The notebook detects a file whose first line is `DRAMA SCRIPT` and imports supported
one-shot scenes directly, even when `auto-story` is selected. It bypasses Qwen and keeps
supplied dialogue, per-scene durations, cast identities, appearance variants and beat cues.
The source title is retained. `SCENE_SECONDS` and `TARGET_SECONDS` do not overwrite a
structured script's own timing.

For the current workflow:

1. Keep a master script following this standard.
2. Upload the structured `.txt` directly for one-shot scenes. The importer validates scene
   numbering, runtime sums, IDs, speakers and beat bounds, then creates model prompts with
   resolved names, identity descriptions and applicable variants. Invalid scripts stop with
   an error instead of silently falling back to an LLM rewrite.
3. Supply shared character context and reference images separately. Match `<Picture 1>`,
   `<Picture 2>` and subsequent tags to the notebook's reference upload order.
4. For ordinary prompt paragraphs without the `DRAMA SCRIPT` marker, `scene-paragraphs`
   still uses the single `SCENE_SECONDS` setting. Ordinary stories in `auto-story` still
   use Qwen to create a plan.

This importer supports the one-shot profile described here.
Multi-shot `SHOT` blocks are rejected with a clear error. `REF` paths are not automatically
loaded; upload actual images separately and map their Picture tags manually. Production
`NOTE` lines are retained as metadata rather than sent to the model. Keyframes, voices,
music, lip sync and timing remain prompt guidance, not guaranteed frame-accurate execution
or separate post-production steps.

## 3. Format and file rules

- One `.txt` file per episode. For a series, use names such as `series-name-s01e01.txt`.
- The first line must be exactly `DRAMA SCRIPT`, with no title, Markdown heading or fence above it.
- Section order: header → `== CHARACTERS ==` → `== RULES ==` → `== SCENES ==`.
- Use UTF-8 without a BOM. LF and CRLF line endings are acceptable.
- Keys are UPPER CASE. A field appears once per block, except repeatable `REF`, `RULE`,
  `NOTE`, `VARIANT` and beat lines.
- Use spaces, not tabs: 2 spaces inside character/prop/location/scene blocks; 4 inside `SHOT`.
- Keep one value per line; avoid multiline continuation in this profile.
- Blank lines improve readability; they are not master-script scene delimiters.
- A complete comment line may start with `//`. Do not use inline comments.
- Dialogue uses straight double quotes: `"Mom, I'll come back."`. Escape inner quotes as `\"`
  and backslashes as `\\`.
- Extras use `| key: value`. Write a literal pipe in an unquoted description as `\|`.
- No empty values, unresolved `<placeholders>` or explanatory Markdown in a finished script.
- Write descriptions, direction, sound, rules, dialogue and display titles in **English**.
  Proper names can retain their original spelling. Translate non-English dialogue into
  natural English while preserving its meaning and intent.

## 4. Header

Keep this order. Omit the entire line when an optional field is unused.

| Key | Usage | Default / example |
| --- | --- | --- |
| `TITLE` | Required; episode title | `The First Paycheck — S01E01` |
| `LOGLINE` | Required; protagonist, conflict and a hint of the payoff | One English sentence |
| `GENRE` | Required | `Family drama` |
| `LANGUAGE` | Required; spoken dialogue | `English` |
| `ASPECT` | Required | `9:16` |
| `RESOLUTION` | Required; final export | `1080x1920` |
| `FPS` | Required | `24` |
| `RUNTIME` | Required; exact planned total | `60s`, `120s` or a shorter positive target |
| `STYLE` | Required | `natural cinematic realism` |
| `SETTING` | Required; shared place/time | `A rural family home at sunrise.` |
| `STYLE PROMPT` | Optional; consistent positive style direction | `natural skin texture, restrained acting` |
| `SPEECH RATE` | Optional; writing estimate only | `2.5` words per second |

`RESOLUTION` states delivery intent, not native generation resolution. The current notebook
generates at a lower resolution and exports 1080×1920; resizing does not restore lost detail.

Omit `ALT ASPECT`, `NEGATIVE PROMPT`, `HERO MAX`, `VOICE ID`, `CLIP` and `TEXT`. Where necessary,
express their story purpose through positive descriptions or dialogue. Do not lose important
story information simply by deleting an unsupported field.

## 5. Characters, props and locations

IDs match `@[a-z][a-z0-9_]*`, such as `@rafi`, `@mother`, `@bag`, `@home`. They share one
namespace: a character and a location cannot use the same ID. Define every ID before use.

### CHARACTER

```text
CHARACTER @rafi | Rafi | human
  ROLE: Young man leaving home for his first job
  AGE: 24
  GENDER: male
  FACE: oval face, narrow jaw, faint moustache
  SKIN: medium brown
  EYES: dark brown
  HAIR: short black hair, side part
  BUILD: slim, average height
  OUTFIT: faded blue cotton shirt and dark trousers
  ACCESSORIES: plain black wristwatch on the left wrist
  PERSONALITY: caring, reserved, quietly determined
  VOICE: young adult male, soft mid-low pitch, restrained emotion
  ACCENT: neutral American English
```

- Header: `CHARACTER @id | Display name | kind`. Allowed kinds: `human`, `animal`,
  `hologram`, `voice_only`, `other`.
- Give each human speaker `ROLE`, `AGE`, `GENDER`, `PERSONALITY`, `VOICE` and `ACCENT`.
  For non-human speakers, specify age impression or timbre in `VOICE` where relevant.
- Describe visible characters concretely using `FACE`, `SKIN`, `EYES`, `HAIR`, `BUILD`,
  `OUTFIT`, optional `ACCESSORIES`, or `LOOK` for non-humans. Omit irrelevant optional fields.
- A `voice_only` character has `VOICE` and `ACCENT`, with no visual look or image reference.
- Optional repeatable `REF: refs/rafi-front.png`. Only list existing/supplied files, relative
  to the script's folder. Do not invent reference paths.
- Optional `VARIANT wet | scenes 7-9 | Hair and shirt visibly wet.`. All unmentioned identity
  details stay the same. Two variants for one entity must not cover the same scene.
- Define identity once in the master. Expand relevant identity descriptions into every
  separately exported render prompt; an `@id` alone does not tell the model who someone is.
- Looks, voice descriptions and references guide consistency; they do not guarantee a lock.
- The example accent is illustrative. Choose one English accent appropriate to each
  character and keep it consistent; do not infer a speech language from a character's name.

### PROP and LOCATION

```text
PROP @bag | Travel bag
  LOOK: small brown canvas shoulder bag with one brass buckle
  RULE: The bag keeps the same colour, size and buckle.

LOCATION @home | Family home
  LOOK: modest rural room with a wooden bed and a small dining table
  LIGHT: soft warm sunrise through the east window
```

`PROP`: required `LOOK`; optional repeatable `REF`, `RULE`, `VARIANT`.
`LOCATION`: required `LOOK`; optional `LIGHT`, repeatable `REF`, `RULE`, `VARIANT`.
Define at least one location. Define important recurring/twist props; ordinary background
objects do not all need IDs.

## 6. Rules and continuity

The `== RULES ==` section contains repeatable `RULE:` and `NOTE:` lines.

- `RULE` states what stays consistent: outfits, time, object ownership or screen direction.
- `NOTE` is an editorial/production instruction, not speech or visible image content.
- Put events in `VISUAL` / `ACTION`, not in a continuity rule describing a future event.
- A prop cannot occupy two places at once. Show where it is placed or handed over.
- Reuse character IDs, appearances, voices and reference mappings across series episodes.
  State intentional changes in episode continuity and applicable scene variants.

## 7. Scenes and optional shots

Keep the default simple: **one SCENE = one render shot = one continuous camera setup**.

```text
SCENE 1 | 5s | Departure
  AT: @home, sunrise
  CAST: @rafi, @mother
  LIPSYNC: required
  MOOD: anxious, tender
  VISUAL: @rafi holds @bag beside the bed while @mother watches from the doorway.
  KEYFRAME: @rafi stands beside the bed holding the closed @bag; @mother stands at the doorway.
  CAMERA: Static medium two-shot.
  FRAME: @rafi left foreground; @mother right background; @bag in his right hand
  LIGHT: warm morning side light
  MUSIC: stop
  TRANSITION: cut
  @mother (softly): "Where are you going so early?" | at: 0.5s
```

Field order: `AT`, `CAST`, `LIPSYNC`, `MOOD`, `VISUAL`, `KEYFRAME`, `CAMERA`, `FRAME`,
`LIGHT`, `MUSIC`, `TRANSITION`, then beats.

- Required: `AT`, `CAST`, `LIPSYNC`, `VISUAL`, `CAMERA`, `FRAME`, `TRANSITION`.
- `KEYFRAME` is required when an action starts and ends in different poses/states. Describe
  one frozen initial instant. Otherwise it is optional. Writing it does not generate an image.
- `MOOD`, `LIGHT`, `MUSIC` are optional. `AT` names a location ID, optionally followed by a time note.
- Scene numbers are `1, 2, 3, …`. Planned scene lengths sum exactly to `RUNTIME`.
- Establish changes of place/time clearly. No hidden cuts or alternating angles within one
  shot. Use a static camera or one slow continuous move.
- Avoid crowding a shot with speech/actions. Usually one speaker, one short line, one action.

### CAST presence

```text
CAST: @rafi, @mother (glimpsed), @narrator (voice)
```

Allowed presence values: default visible, `(glimpsed)`, `(background)`, `(voice)`. Only
character IDs belong in `CAST`. A `voice_only` character requires `(voice)`. An empty
establishing shot uses `CAST: none`; it may show props/locations, but no character or speaker.

In `VISUAL`, `KEYFRAME`, `FRAME` and `ACTION`, a character `@id` means that person is visible
in the shot. Do not use a `(voice)` character's ID there; use a plain name for an off-camera
person. Speaker IDs follow the dialogue rules. IDs are also allowed in `AT`, `CAST`, `RULE`
and `NOTE`. Do not use `@ids` in `CAMERA`, `MOOD`, `LIGHT`, `LOOK`, `SFX`, `MUSIC` or headers.
An `@` inside dialogue/reference paths is literal text; elsewhere write a literal `@` as `\@`.

### Advanced: multiple SHOT blocks in one scene

Use optional `SHOT` blocks when camera angles change within the same place and continuous
time. Put `AT`, `CAST`, `MOOD`, `LIGHT`, `MUSIC`, `TRANSITION` at scene level, then the shots.
All beats belong inside a shot, never between scene fields and the first shot.

```text
SCENE 2 | 10s | The Question
  AT: @home
  CAST: @rafi, @mother
  MOOD: restrained sadness
  MUSIC: stop
  TRANSITION: cut
  SHOT 1 | 5s | close-up
    LIPSYNC: required
    VISUAL: @mother holds eye contact with someone off camera.
    CAMERA: Static close-up.
    FRAME: @mother centred; Rafi off camera left
    @mother: "When will you be back?" | at: 0.5s
  SHOT 2 | 5s | close-up
    LIPSYNC: required
    VISUAL: @rafi gives a small reassuring smile.
    CAMERA: Static close-up.
    FRAME: @rafi centred; Mother off camera right
    @rafi: "Soon, Mom." | at: 0.5s
```

Restart shot numbering at 1 in each scene. Shot lengths sum to their scene's length. Each
shot lasts 5–15s; a multi-shot scene may exceed 15s. Do not count both scenes and their shots
when totaling runtime. Shot sizes: `establishing`, `wide`, `medium`, `two-shot`,
`over-the-shoulder`, `close-up`, `extreme close-up`, `insert`.

Shot fields: `LIPSYNC`, `VISUAL`, `KEYFRAME`, `CAMERA`, `FRAME`, `LIGHT`, then beats. Lighting
may inherit from the scene; give each shot its own `VISUAL`, `CAMERA`, `FRAME` and `LIPSYNC`.
The current structured importer rejects this advanced multi-shot structure. To use it now,
convert each shot to a separate SCENE, carry its location/cast into that scene, renumber
scenes and update affected variant ranges. No automatic flattening is implemented.

## 8. Dialogue, action and sound

| Syntax | Meaning | Extras |
| --- | --- | --- |
| `ACTION: …` | Visible action | `at:` |
| `@rafi: "…"` | A visible/off-screen speaker's line | `at:` |
| `@rafi (quietly): "…"` | Dialogue with delivery | `at:` |
| `@narrator [VO]: "…"` | Narration / inner voice | `at:` |
| `@rafi [VO] (quietly): "…"` | Voice-over with delivery | `at:` |
| `SFX: …` | Sound description | `at:`, `length:`, optional `sound:` |

- Every speaker must appear in the scene's `CAST`. `[VO]` precedes delivery parentheses.
- Use `LIPSYNC: required` for visible speech, `none` for VO/off-screen/silent shots. For H3
  this annotates intent; it is not a separate lip-sync process or switch.
- Give every spoken line and timed action an `at:`; every SFX an `at:` and `length:`.
- If SFX text is only a word such as "BOOM", explain the audible effect in `sound:`.
- Write the exact English words to be heard. IDs and production notes are not spoken.
- Avoid overlapping speakers in one short shot; use separate shots when needed.
- Put sound in `SFX` / `MUSIC`, rather than only describing it in `VISUAL`.
- 2.5 words/s is a rough writing estimate. Listen to the generated delivery. For a typical
  5s shot, use a short 5–8-word line and leave 1–2s for a reaction.

### Music

Default no score: `MUSIC: stop`. Optional example: `MUSIC: Sparse warm piano below the dialogue.`
A new description expresses a new cue. Omitting it in the following scene conventionally
carries forward the previous description; omission in the first scene means no score.

The same description does not ensure identical waveform, phase or seamless recorded music.
H3 may mix speech, effects and score together. Do not assume the current notebook implements
separate tracks, music fades or loudness mastering.

## 9. Timing and assembly

- Render shots last **5–15s**, usually 5–8s. Place shorter reactions inside a neighboring
  shot; do not repeat a beat just to extend runtime.
- Times use seconds: `5s`, `7.5s`, `0.5s`. Planned timing must be whole frames at 24 fps.
  Half-second steps are convenient. Do not use `at: 0.1s`.
- `at:` is measured from the start of its own shot. `at < shot length`;
  `at + SFX length <= shot length`.
- `RUNTIME` is the planned total. Measured generated duration differs: the current H3
  workflow snaps to `17n+5` frames, so a requested 5s becomes 124 frames, about 5.17s.
- A 12×5s script plans 60s, but current assembly can run about 62s. Exactly 60s requires
  per-clip trimming/retiming and audio handling, which are not implemented here.
- This profile uses only `TRANSITION: cut` and follows script/shot order. Do not promise
  crossfades or duration-preserving dissolves.
- Final export: 1080×1920 H.264/AAC MP4, 24 fps. Keep original generated scene files.
- GPU type, seed, model filenames, codec flags, output filenames and progress belong in
  runtime/production metadata, not the creative script.

## 10. Turning a story into an episode

1. Establish character, situation and a hook in the opening shot's first few seconds.
2. Show what the protagonist wants and what prevents it.
3. Each following beat introduces an attempt, consequence or emotional change.
4. Plant a reveal/twist through an earlier visible detail or line, rather than unrelated new information.
5. End with a visible payoff and reaction time. A series may resolve a small emotional beat
   while leaving a question for the next episode; avoid the same cliffhanger every time.

Simple plans: 60s → 12×5s or 10×6s; 120s → 24×5s or 20×6s. Choose scene count to fit the
story. Multi-shot scenes have a separate render-shot count. Keep one main conflict per
episode. Use a narrator only when needed; do not explain visible information again in long dialogue.

## 11. AI prompt for converting all uploaded scripts

Provide this prompt, the entire guide and the source story/script together.

~~~text
Convert the supplied story or script into the Common Drama Script Standard in final-script.md.
Use the specification as the authority when the source format conflicts with it.

Preserve the supplied plot, character identities, relationships, intent and supplied English dialogue wherever possible. Translate any non-English
dialogue into natural English while preserving its meaning. Do not silently change a supplied ending or invent reference
files. If only an idea is supplied, develop it into a coherent short drama with a visible
hook, problem, escalation, earned reveal and payoff. Keep serial continuity when a previous
episode is supplied. Add only necessary connective action and consistent missing look details.

Defaults: English dialogue and English visual/production descriptions; MiniMax H3;
9:16; final export 1080x1920; 24 fps; one episode per file; planned runtime 60s unless
the request specifies 120s or another shorter runtime. Every render shot must be 5–15s.
Use one scene per continuous shot unless a location/time-continuous scene needs multiple
explicit SHOT blocks. The sum of shot lengths must equal their scene length; the sum of
scene lengths must equal the planned RUNTIME. Use half-second timing increments.

Define characters, important props and locations once with unique @ids. Keep human ages,
faces, skin, eyes, hair, outfits, voices and accents consistent. Define deliberate visual
changes through scene-specific VARIANT entries. Do not claim perfect face or voice locking.

Use only the fields in this standard. No CLIP, TEXT, ALT ASPECT, NEGATIVE PROMPT, VOICE ID
or HERO MAX. Use TRANSITION: cut. Keep dialogue concise and leave reaction time. Mark visible
speech LIPSYNC: required, and VO/off-screen/silence none. Give each spoken line and action
an at: time; each SFX an at: time and length:. Avoid simultaneous speaking in a short shot.

Separate the initial frozen pose in KEYFRAME from movement in VISUAL/ACTION. One camera setup
and one continuous movement per shot. Resolve which character/prop is visible and where each
object is; never place an object in two locations at once. Use plain names for off-camera
people in visual fields. Use @ids only in the fields that allow them.

Treat RESOLUTION and RUNTIME as delivery/planning intent. Do not claim exact generated
durations, native 1080p detail, generated keyframes, subtitles, separate audio stems, continuous
music, mastering or transitions that the current notebook does not implement.

Check timing, IDs, speakers, locations, indentation, required fields, continuity and plot
before answering. Do not include your planning notes. Output only one complete script in
a single text code block, with DRAMA SCRIPT as its first content line. When saving a .txt
file, omit the code fences. For a series, provide a separate complete script/file per episode.

Source story/script: <paste here>
Target planned runtime: <60s / 120s / shorter>
Episode: <title or S01E01>
Existing character/reference continuity: <paste details or state none>
~~~

## 12. Reusable blank template

This is a scaffold. Fill every placeholder and add enough scenes to match RUNTIME. Omit
unused optional blocks. The two sample scenes alone are not a complete 60-second script.

```text
DRAMA SCRIPT

TITLE: <episode title>
LOGLINE: <one English sentence>
GENRE: <genre>
LANGUAGE: English
ASPECT: 9:16
RESOLUTION: 1080x1920
FPS: 24
RUNTIME: <planned total>s
STYLE: <shared visual style>
SETTING: <shared place and time>

== CHARACTERS ==

CHARACTER @lead | <display name> | human
  ROLE: <role and motivation>
  AGE: <whole years>
  GENDER: <gender>
  FACE: <concrete face details>
  SKIN: <skin tone>
  EYES: <eye details>
  HAIR: <hair details>
  BUILD: <build>
  OUTFIT: <fixed outfit>
  PERSONALITY: <consistent personality>
  VOICE: <pitch, timbre, pace>
  ACCENT: neutral American English

LOCATION @place | <display name>
  LOOK: <consistent spatial description>
  LIGHT: <base lighting>

== RULES ==

RULE: <a visual continuity rule>
NOTE: <an editorial instruction; omit if not needed>

== SCENES ==

SCENE 1 | 5s | <hook>
  AT: @place
  CAST: @lead
  LIPSYNC: required
  MOOD: <emotion>
  VISUAL: <one visible action involving @lead>
  KEYFRAME: <single initial pose involving @lead>
  CAMERA: Static medium shot.
  FRAME: @lead centred, eyes in the upper third
  MUSIC: stop
  TRANSITION: cut
  @lead (<delivery>): "<short English line>" | at: 0.5s

SCENE 2 | 5s | <consequence>
  AT: @place
  CAST: @lead
  LIPSYNC: none
  VISUAL: <the visible consequence and reaction>
  KEYFRAME: <single initial pose>
  CAMERA: Static close-up.
  FRAME: @lead centred
  TRANSITION: cut
  ACTION: <one action involving @lead> | at: 1s
```

## 13. Complete 60-second example

12 scenes × 5s = **60s planned**. No reference files are assumed, so there are no invented
REF paths. The current H3 frame grid can make the measured rendered duration longer.

```text
DRAMA SCRIPT

TITLE: The First Paycheck — S01E01
LOGLINE: A son leaving for his first city job notices his mother has saved their only meal for him and chooses to share it before saying goodbye.
GENRE: Family drama
LANGUAGE: English
ASPECT: 9:16
RESOLUTION: 1080x1920
FPS: 24
RUNTIME: 60s
STYLE: natural cinematic realism, restrained performances, warm morning light
SETTING: A modest rural family home at sunrise on the son's departure day.
STYLE PROMPT: realistic skin texture, gentle contrast, natural gestures, intimate vertical composition
SPEECH RATE: 2.5

== CHARACTERS ==

CHARACTER @rafi | Rafi | human
  ROLE: Son leaving home for his first job in the city
  AGE: 24
  GENDER: male
  FACE: oval face, narrow jaw, faint moustache
  SKIN: medium brown
  EYES: dark brown
  HAIR: short black hair, side part
  BUILD: slim, average height
  OUTFIT: faded blue cotton shirt and dark trousers
  ACCESSORIES: plain black wristwatch on the left wrist
  PERSONALITY: caring, reserved, quietly determined
  VOICE: young adult male, soft mid-low pitch, slow restrained delivery
  ACCENT: neutral American English

CHARACTER @mother | Mother | human
  ROLE: Mother hiding her sadness and hunger to support her son
  AGE: 52
  GENDER: female
  FACE: round face, fine smile lines, slightly tired eyes
  SKIN: warm medium brown
  EYES: dark brown
  HAIR: black hair with a few grey strands, tied in a low bun
  BUILD: slight build, short height
  OUTFIT: plain white cotton sari with a narrow red border
  PERSONALITY: practical, affectionate, quietly self-sacrificing
  VOICE: mature female, warm mid pitch, soft unhurried delivery
  ACCENT: neutral American English

PROP @bag | Travel bag
  LOOK: small brown canvas shoulder bag with one brass buckle
  RULE: The bag keeps its colour, dimensions and single brass buckle.

PROP @photo | Family photograph
  LOOK: one small worn family photograph with a plain cream border and no printed words

PROP @meal | Shared meal
  LOOK: one shallow round tin plate with rice, one boiled egg and two plain metal spoons
  RULE: There is one plate; the food decreases only through eating.

LOCATION @room | Family room
  LOOK: modest rural room, wooden bed on the left, small dining table in the centre, doorway on the right
  LIGHT: warm sunrise through an east-facing window

LOCATION @doorway | Front doorway
  LOOK: wooden front door of the same house opening onto a narrow village path
  LIGHT: warm morning daylight

== RULES ==

RULE: The story takes place during the same morning; character appearance and clothing stay consistent.
RULE: The resting position of @bag is the left bed; its owner is Rafi.
RULE: There is one @photo; it remains inside @bag whenever it is not visible.
RULE: At the dining table, Rafi sits on the left and Mother sits on the right.
NOTE: Performance and speech should feel intimate; leave a short reaction after every line.

== SCENES ==

SCENE 1 | 5s | The Early Departure
  AT: @room, sunrise
  CAST: @rafi, @mother
  LIPSYNC: required
  MOOD: anxious, tender
  VISUAL: @rafi pauses beside the bed holding @bag as @mother watches him from the doorway.
  KEYFRAME: @rafi stands beside the bed with the closed @bag in his right hand; @mother faces him from the doorway.
  CAMERA: Static medium two-shot.
  FRAME: @rafi left foreground; @mother right background; @bag at his right side
  MUSIC: stop
  TRANSITION: cut
  @mother (softly): "Where are you going so early?" | at: 0.5s
  SFX: Morning birds chirp outside. | at: 0s | length: 4s

SCENE 2 | 5s | The New Job
  AT: @room
  CAST: @rafi, @mother (voice)
  LIPSYNC: required
  MOOD: hopeful but hesitant
  VISUAL: @rafi answers someone off camera without fully lifting his eyes.
  KEYFRAME: @rafi faces slightly right with his gaze lowered and lips relaxed.
  CAMERA: Static close-up.
  FRAME: @rafi centred; Mother off camera right
  TRANSITION: cut
  @rafi (quietly): "The city, Mom. I found a job." | at: 0.5s

SCENE 3 | 5s | An Unspoken Goodbye
  AT: @room
  CAST: @mother, @rafi (voice)
  LIPSYNC: required
  MOOD: hurt beneath affection
  VISUAL: @mother holds eye contact with someone off camera, fighting a tremble in her expression.
  KEYFRAME: @mother looks toward the left with a composed face and slightly moist eyes.
  CAMERA: Static close-up.
  FRAME: @mother centred; Rafi off camera left
  TRANSITION: cut
  @mother (gently): "Were you leaving without saying goodbye?" | at: 0.5s

SCENE 4 | 5s | The Photograph
  AT: @room
  CAST: @rafi
  LIPSYNC: none
  MOOD: vulnerable
  VISUAL: @rafi's hands slide @photo into the open @bag on the bed.
  KEYFRAME: @rafi's right hand holds @photo just above the open @bag on the bed; his left hand steadies the bag.
  CAMERA: Static insert on hands and objects.
  FRAME: @rafi's hands, @photo and @bag fill the centre; his face stays outside the frame
  TRANSITION: cut
  @rafi [VO] (softly): "I couldn't bring myself to say goodbye." | at: 0.5s
  SFX: Canvas fabric rustles softly. | at: 1s | length: 1s

SCENE 5 | 5s | Stay for Breakfast
  AT: @room
  CAST: @mother, @rafi
  LIPSYNC: required
  MOOD: practical tenderness
  VISUAL: @mother settles the closed @bag on the bed and gently gestures toward the dining table as @rafi watches.
  KEYFRAME: @mother rests one hand on the closed @bag at the bed edge; @rafi stands nearby with empty hands.
  CAMERA: Static medium two-shot.
  FRAME: @mother right; @rafi left; @bag on the bed between them
  TRANSITION: cut
  @mother (warmly): "Have something to eat first." | at: 0.5s

SCENE 6 | 5s | One Plate
  AT: @room, at the dining table
  CAST: @mother
  LIPSYNC: none
  MOOD: quiet care
  VISUAL: @mother's hands place @meal on the dining table.
  KEYFRAME: @mother's hands hold @meal just above the table; both spoons lie inside the plate.
  CAMERA: Static insert.
  FRAME: @meal and @mother's hands centred; her face stays outside the frame
  TRANSITION: cut
  ACTION: @mother's hands release @meal onto the table. | at: 1s
  SFX: A tin plate touches the wooden table. | at: 1s | length: 0.5s

SCENE 7 | 5s | The Missing Meal
  AT: @room, at the dining table
  CAST: @rafi, @mother (voice)
  LIPSYNC: required
  MOOD: concern
  VISUAL: @rafi looks from @meal toward someone off camera on his right.
  KEYFRAME: @rafi sits at the left side of the table, looking down at @meal; both spoons remain in the plate.
  CAMERA: Static medium close-up.
  FRAME: @rafi centred; @meal lower foreground; Mother off camera right
  TRANSITION: cut
  @rafi (concerned): "Aren't you eating?" | at: 0.5s

SCENE 8 | 5s | The Small Lie
  AT: @room, at the dining table
  CAST: @mother, @rafi (voice)
  LIPSYNC: required
  MOOD: concealed sacrifice
  VISUAL: @mother offers a brief reassuring smile toward someone off camera.
  KEYFRAME: @mother sits on the right side of the table, facing left, with a restrained smile.
  CAMERA: Static close-up.
  FRAME: @mother centred; Rafi off camera left
  TRANSITION: cut
  @mother (lightly): "I'm not hungry." | at: 0.5s

SCENE 9 | 5s | What She Hides
  AT: @room, at the dining table
  CAST: @mother
  LIPSYNC: none
  MOOD: vulnerable
  VISUAL: @mother's free hand presses lightly against her stomach below the table edge.
  KEYFRAME: @mother's hand rests on her lap just below the table edge, fingers slightly curled.
  CAMERA: Static insert below the table edge.
  FRAME: @mother's hand and lap centred; her face stays outside the frame
  TRANSITION: cut
  ACTION: @mother's hand shifts from her lap to her stomach. | at: 1s

SCENE 10 | 5s | Sharing
  AT: @room, at the dining table
  CAST: @rafi, @mother (glimpsed)
  LIPSYNC: required
  MOOD: understanding
  VISUAL: @rafi slides @meal to the space between himself and @mother.
  KEYFRAME: @rafi's fingers rest on the edge of @meal in front of him; @mother's shoulder is visible at the right edge.
  CAMERA: Static medium shot.
  FRAME: @rafi left; @mother's shoulder right edge; @meal near the centre
  TRANSITION: cut
  @rafi (gently): "Today, we eat together." | at: 0.5s
  ACTION: @rafi slides @meal toward the centre of the table. | at: 1s

SCENE 11 | 5s | Together
  AT: @room, at the dining table
  CAST: @rafi, @mother
  LIPSYNC: none
  MOOD: relief, affection
  VISUAL: @rafi and @mother quietly share @meal, each using one spoon.
  KEYFRAME: @rafi sits left and @mother sits right, one spoon in each person's hand, with @meal between them.
  CAMERA: Static medium two-shot.
  FRAME: @rafi left; @mother right; @meal at the centre of the table
  TRANSITION: cut
  SFX: Soft spoons touch the tin plate. | at: 0.5s | length: 3s

SCENE 12 | 5s | The Promise
  AT: @doorway, moments later
  CAST: @rafi, @mother
  LIPSYNC: required
  MOOD: hopeful farewell
  VISUAL: @rafi holds @bag on his shoulder and gives @mother a small reassuring smile.
  KEYFRAME: @rafi stands left with @bag on his right shoulder; @mother faces him from the doorway on the right.
  CAMERA: Static medium two-shot.
  FRAME: @rafi left; @mother right; @bag visible at his shoulder; village path behind him
  TRANSITION: cut
  @rafi (warmly): "My first paycheck is for you." | at: 0.5s
```

## 14. Final check before saving any script

- [ ] DRAMA SCRIPT is the first line; sections are ordered; one episode per file.
- [ ] English dialogue, descriptions, titles and instructions; 9:16, 1080x1920, 24 fps.
- [ ] Required header fields filled; no placeholders, fake reference paths or unknown keys.
- [ ] IDs unique and defined; AT is a location; every speaker belongs to CAST.
- [ ] Visible IDs match cast/presence; off-screen/VO characters are not accidentally drawn.
- [ ] Character appearance/voice, screen direction and prop ownership remain coherent.
- [ ] Every render shot is 5–15s; scene/shot numbers are sequential; durations sum correctly.
- [ ] Planned times are whole frames; beats fit; dialogue leaves reaction time without overlap.
- [ ] Action/keyframe separate movement from initial pose; one camera setup per shot.
- [ ] Required scene/shot fields present; sound uses sound fields; dialogue quotes are escaped.
- [ ] No TEXT, CLIP, ALT ASPECT, NEGATIVE PROMPT, HERO MAX, VOICE ID; transitions are cuts.
- [ ] The hook, conflict and payoff are visible; series episodes preserve continuity.
- [ ] No false promises of exact render duration, native Full HD, voice locking or unsupported features.

Original reference documents are preserved. Use this file as the common writing/conversion
standard. The Colab importer supports one-shot scripts; multi-shot import and automatic
reference-path resolution remain outside its supported subset.
