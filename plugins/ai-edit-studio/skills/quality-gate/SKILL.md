---
name: quality-gate
description: The delivery checklist for AI Edit Studio — review the edit, render a preview, inspect the REAL render, measure it with studio_qc (loudness, true peak, black/frozen picture, silences, duration) and only then render finals and report. Use before saying any video is done, when a render "looks wrong", or when a client/creator needs a deliverable they can post as-is.
---

# Quality gate — nothing is "done" before it passes

A render is finished when the measured file passes, not when the job says `ready`.

## 1. Edit check (before rendering)

`studio_review {projectId}`. Required: **0 errors**. Apply sensible `fix.operations` via `studio_edit`
(`dryRun:true` first). Read the warnings aloud to yourself: jump cuts, flash shots (< 0.4 s), black frames, captions
faster than reading speed, off-beat cuts, missing finale fade.

## 2. Preview render and look at it

```text
studio_render {projectId, revision, preview:true, previewFormat:"vertical"|"landscape", queue:true}
studio_wait {projectId, until:"idle"}
studio_storyboard {projectId, exportId}         ← the real render, not the plan
studio_frame {projectId, exportId, time:0.3}    ← first frame people see
```

Look for: black or frozen frames, text cut off by the 9:16 crop or platform UI (keep text out of the bottom ~20 % and
right ~15 % on TikTok/Reels), captions covering faces, logo over captions, wrong subject in a reframed shot, a slow or
empty opening, an ending that fades into nothing.

## 3. Measure

`studio_qc {projectId, exportId}` → must have `passed:true`. Targets:

| Measure | Target | Fix |
| --- | --- | --- |
| Integrated loudness | −14 LUFS ±1 (podcast −16) | `set_options {loudnessTarget:-14}`, re-render |
| True peak | ≤ −1 dBTP | lower `musicGain`/clip `gain`, re-render |
| Black/frozen picture | none inside the edit | trim/delete the shot (`studio_timeline` gives ids) |
| Silences | none > 1 s unless intended | `studio_text_edit {removePauses:{min:0.8}}` |
| Duration | matches the edit | re-render from the current revision |

## 4. Finals

`studio_render {projectId, revision, formats:[…], queue:true}` → wait → `studio_qc` **per export** → storyboard one of
them. Optional: `studio_compare` for A/B variants side by side.

## 5. Report (keep it factual)

Files (absolute paths), format, length, LUFS/peak, review score, what you changed and why, what you could not fix,
and the open choices for the human (hook variant, music). Publish packs are drafts; nothing was posted.
