### Format B (Ref2VA) — Prompt Structure

Six fields, strictly in this order:

1. `subject_definitions` — reference assets and tags
2. `summary` — brief overview of the task and relationships
3. `retention_analysis` — what is preserved / altered
4. `detailed_description` — shots in playback order
5. `overall_soundscape` — atmosphere and physical sounds
6. `non_diegetic_music` — background music (or "N/A")

All sections must be in English (except dialogues inside `<d>` and text visibly appearing in the frame).

### Tags and Their Roles

- `<Subject N>` — asset abstracted from references (character, object, location)
- `<Picture N>` — anchor image: framing, composition, style
- `<Video N>` — video: motion, camera path, pacing
- `<Audio N>` — audio: vocal timbre, sound effects, music style

Rule of "single role": each asset has one primary purpose.
`<Video N>` and `<Audio N>` are numbered **independently** from `<Picture N>`.
Define characters as `<Subject N> is ... in <Picture N> — ...`; a separate `<Picture N>` line is not needed.
Every attached reference must be referenced in the prompt by its respective tag.

### Link Markers

- Visual: `fully_preserved` | `weak_reference`
- Audio: `fully_copy` | `reference` | `weak_reference`

### Speaking Characters

- Global ID `(Sx)` on each vocal event; `<Audio N>` reuses the same `(Sx)`.
- `(Sx)` is not included in `retention_analysis`.

### Example (actual prompts are significantly more detailed)

```text
subject_definitions:
<Subject 1> is the coffee-shop interior in <Picture 1> — brick wall, orange sofa, neon sign.
<Subject 2> is the blonde woman in <Picture 2> — long blonde hair, pink shirt.
<Audio 1> is the voice-timbre reference for <Subject 2> (S1).

summary:
[reference generation] <Subject 2> eats a cookie in <Subject 1>, startled by a dog.

retention_analysis:
<Subject 1> ([Shot 1]): fully_preserved — brick wall, orange sofa, neon sign retained.
<Subject 2> ([Shot 1]): fully_preserved — blonde hair, pink shirt retained.
<Audio 1>: reference — vocal timbre guides <Subject 2>'s delivery.

detailed_description:
[Shot 1] Medium shot in <Subject 1>. <Subject 2> (S1) sits on the sofa holding a cookie. A Samoyed lunges at her hand. <Subject 2> (S1) says with light annoyance: <d>[English] Hey! Watch your dog!</d>

overall_soundscape:
Soft indoor coffee-shop room tone.

non_diegetic_music:
N/A
```
