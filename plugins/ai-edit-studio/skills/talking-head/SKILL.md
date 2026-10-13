---
name: talking-head
description: Polish talking-head, podcast, tutorial or interview footage with AI Edit Studio — edit by transcript (fillers, pauses, retakes), voice repair, word-accurate animated captions, punch-in zooms, B-roll on keywords, chapters. Use for vlogs, YouTube videos, courses, interviews and podcasts.
---

# Talking head that people finish

1. `studio_create {name, inputs:["<talking head>", "<b-roll>…"]}` → `studio_transcribe {projectId, language:"auto"}` → `studio_wait`. (No engine: tell the user about
   `node cli.mjs speech-setup --model base` once, or import a transcript.)
2. Read it: `studio_transcript {projectId, sourceIndex:0}` (`[mm:ss #wordIndex]` stamps). Find retakes — the same
   sentence said twice; keep the last clean one.
3. One revision for the content cut (dry-run first, show the diff):
   ```json
   {"projectId":"…","revision":N,"removeFillers":true,"removePauses":{"min":0.7,"keep":0.15},
    "removeWords":[{"from":120,"to":131}],"smooth":true,"dryRun":true}
   ```
   Or a paper edit with `assemble:[{from,to,label}]` to reorder: strongest claim first.
   Pauses that carry meaning: `speedPauses:{min:0.8, speed:2}` instead of cutting.
4. Sound: `studio_audio_repair {action:"analyze"}` → `{action:"apply", auto:true, levelShots:true}`;
   `set_options {voiceEnhance:"light"}` (`"strong"` only for noisy rooms). Podcasts: `loudnessTarget:-16`.
5. Keep eyes busy: `studio_auto_zoom {style:"punch", amount:1.12, focusY:0.4}`;
   `studio_auto_broll {pool:[1,2,3], maxPerMinute:4}` (pool = source indices: add the B-roll files as sources in
   `studio_create`, named after what they show) puts cutaways where their names are said;
   `set_options {progressBar:"bottom"}` for long videos.
6. Captions: `captionAnimation:"highlight"` (YouTube) or `"karaoke"` (vertical). Check reading speed in `studio_review`.
7. Long video: `studio_sections {action:"suggest"}` → chapters; `studio_export_timeline {format:"chapters"}`.
8. Quality gate, then render `landscape` (+ `vertical` cut via `studio_duplicate` + `studio_reframe {aspect:"9:16"}`).
   Built-in shortcut: `studio_recipe {action:"run", name:"podcast-clean", projectId}`.
