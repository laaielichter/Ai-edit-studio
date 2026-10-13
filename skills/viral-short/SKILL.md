---
name: viral-short
description: Turn raw footage into a finished, hook-first short (TikTok, Reels, YouTube Shorts) with AI Edit Studio — strongest opening, captions, vertical reframe, music that drops on the cuts, A/B hook variants, render QC and a publish pack. Use when someone wants a short, a reel, a TikTok, "make this go viral", or a social cut from their clips.
---

# Viral short from raw footage

Goal: a 9:16 video that earns the first 2 seconds, never lets attention drop, reads without sound and ends on a
reason to follow. The engine measures (motion, loudness, scene cuts, beats, words); it does not judge taste — you do,
by looking at frames and the storyboard before anything is called finished. Never promise views or "guaranteed viral".

## 0. Ask only what you cannot see

- Footage: absolute local paths (up to 24). Music: their own track, or compose one (step 4).
- The one-line promise of the video ("3 mistakes that ruin your sourdough"). This becomes `hookText`/`title`.
- Platform: `tiktok` (default), `reels` or `shorts`. Call to action, e.g. "Follow for part 2".
- Brand kit name if they have one (`studio_brand {action:"list"}`).

## 1. Create and auto-edit (Director mode)

```text
studio_create {name, inputs:[...], options:{label:"", endTitle:""}}         → projectId
studio_auto_edit {projectId, platform:"tiktok", pace:"punchy", keep:"highlights",
                  hookText:"<promise in ≤ 6 words, CAPS ok>", cta:"<cta>", variants:true,
                  brand?:"<kit>", preview:true, queue:true}
studio_wait {projectId, until:"idle"}   (repeat while timedOut)
studio_get {projectId}                  → project.autoEdit = report (hook score, review score, shots)
```

- Talking to camera? Run `studio_transcribe {projectId, language:"auto"}` first so captions are word-accurate,
  then auto-edit. No speech engine → import their SRT/VTT (`studio_transcript {action:"import", file}`). Never invent speech.
- `variants:true` makes A/B projects with the other two hooks. Offer all three; the creator posts the strongest or tests them.

## 2. Look before you judge

`studio_storyboard {projectId}` and `studio_frame {projectId, time:0.5}`. Check by eye:

| Check | Fix |
| --- | --- |
| Frame 1 is motion, a face or the payoff — not a logo, black or a slow pan | `studio_edit` `move` the strongest clip to 0 (`studio_highlights` ranks them) |
| Hook text readable, ≤ 6 words, inside the safe area | `update_text` or `captionPosition:"middle"` |
| No shot longer than ~3 s without change (talking head: zoom) | `studio_auto_zoom {style:"punch"}`, `split`, `punch_in` |
| Captions on, animated, big | `set_options {captionAnimation:"pop"\|"karaoke", captionCase:"upper"}` |
| Last 2 s: payoff or CTA, no fade into nothing | `add_text` CTA, `studio_music {ending:"hit"}` |
| Total length fits the promise (often 15–35 s) | `studio_fit_duration {target}` |

## 3. Review loop

`studio_review {projectId}` → apply `fix.operations` you agree with via `studio_edit` (use `dryRun:true` first),
re-review until there are no errors and the hook is the highest-scoring part. Every change is a revision; undo with `studio_restore`.

## 4. Sound (half of retention)

- No music yet: `studio_music {projectId, revision, style:"pop"|"trap"|"house", mood:"uplifting"|"epic", drops:"auto", ending:"hit"}`,
  then `studio_edit {operations:[{op:"beat_sync", every:2}]}`. Put a marker named `drop` where the payoff lands first.
- `studio_sfx {action:"auto"}` for whooshes on transitions and pops on texts. Voice: `set_options {voiceEnhance:"light"}`.
- Leave `loudnessTarget` at −14 LUFS.

## 5. Render, check, deliver

Run the **quality-gate** skill: preview render → storyboard of the real export → `studio_qc` → final
`studio_render {formats:["vertical"]}` (+ `"landscape"` / `"square"` if asked) → QC again → `studio_publish_pack
{projectId, title, platforms:["tiktok","reels","shorts"]}`. Report file paths, length, LUFS, the hook you chose and why,
and the A/B variants. Publish-pack texts are drafts; nothing is uploaded or posted.
