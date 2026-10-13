# AI Edit Studio — Director 0.10

A **local-first video editor** for creators, game developers and their agents. One engine with a
pro timeline for people and the same 57 tools for agents (MCP, HTTP/OpenAPI, CLI). Your footage never
leaves your machine; originals are only read.

*Formerly Game Trailer Studio. Existing projects, storage paths, `GAME_TRAILER_STUDIO_*` settings and the
`Start-Game-Trailer-Studio.*` scripts keep working. The Dutch history of this README lives in
[docs/README.nl.md](docs/README.nl.md).*

## What it does

**New in 0.10 — music engine**

- **Compose music for your edit** (Audio tab → *Compose music*, or `studio_music`): an original track in one of six
  styles (pop drop, trap, house, lo-fi, synthwave, cinematic trailer), made on this computer from synthesised
  instruments — no samples, no internet, free to use. It is exactly as long as your edit, its drops land exactly on
  your cuts (or markers named *drop*) and it ends with a final hit on the last frame. Same seed = same track, *New
  variation* = a new melody and groove. The beat grid is exact, so *Snap cuts to beat* uses the real beats. Optional
  stems (drums, bass, music, effects).
- **Your own music** stays one click away (*Choose…*), including tracks you made with Suno, Udio and the like.
- **Online generation (optional)** with your own ElevenLabs key: only the text prompt and the length are sent.
- Fixes: a sound-effects track that could fill the disk, filter scripts FFmpeg 4.x could not read, stretched history
  cards, clipped right-panel tabs, the start screen's tool count, a review tip that ignored timeline texts.

**New in 0.9 — polish**

- **Look** — LUTs (six built-in looks or your own .cube, with strength), automatic colour and camera matching per
  shot, and stabilisation of shaky shots (two-pass vid.stab, measured once).
- **Sound** — music cut on bar lines so it ends exactly with your edit, repair of hum, clicks, clipping and noise,
  shots made equally loud, locally made sound effects (whoosh, hit, pop, riser…), stems for mixing, and pauses that
  play faster instead of being cut.
- **Talking heads** — zooms on emphasis or slow push-ins, B-roll placed where its name is said, a progress bar and
  subscribe/link pop-ups.
- **Workflows** — one action over many projects, and two versions side by side as one video.

**New in 0.8 — long edits**

- **Segmented, cached renders** — long edits render as finished segments; after a fix only the changed part is
  rendered again, and a short last pass mixes the sound. Render just one part (I/O range) to check a fix.
- **Frame-exact cuts** — fixed a drift that let cuts (and with them captions, voice and music) slip later in edits with
  many shots, and an in-point bug from 0.5–0.7 that could start shots slightly early. Re-render older exports.
- **Outline** — chapters anchored to shots: move, delete or grade a whole section; they become YouTube chapters.
- **Search the footage** — find what was said (typo tolerant), labels, markers and strongest moments; insert in one click.
- **Fit to length** — 45 → 30 min or 3:12 → 2:59: pauses, filler words, weakest sentences and shots go first.
- **Script → rough cut**, **audio sync + multicam** (picture follows who talks), **review notes** pinned to shots,
  **proxies** for heavy footage, and **hand-off** to Premiere/Resolve/Avid (EDL), Final Cut/Resolve (FCPXML), OTIO,
  CSV shot lists and YouTube chapters. All in the new **Long** tab and as agent tools.

**New in 0.7**

- **Animated captions** — karaoke, pop, highlight marker or one word at a time, word-accurate from the transcript,
  rendered with libass in your brand colours and font; live preview in the editor.
- **Clip finder** — long video → the best self-contained clips (sentence-aligned), one ready project per clip, renders queued.
- **Layers** — B-roll cutaways and picture-in-picture above the edit; the main sound keeps playing.
- **Sound & motion** — J/L cuts per shot, punch-in zooms on the beat, stepped speed ramps, freeze frames.
- **Pro audio** — voice enhance (de-noise, presence, de-ess) and a master loudness target (−14 LUFS by default).
- **For agents** — render QC (LUFS, peak, black/frozen, silence), a render queue, long-poll `studio_wait`, live SSE events
  and recipes (multi-step workflows in one call).

**New in 0.6**

- **✦ Director mode** — pick a platform (TikTok, Reels, Shorts, feed, YouTube, trailer, vlog, film) and get a finished
  edit: dead air and black removed, strongest hook chosen out of three, transitions, beat sync, captions from speech,
  automatic review fixes, vertical reframe and the platform renders. Optional A/B projects with the other hooks.
- **Edit by text** — local speech recognition (whisper.cpp, optional one-time install), then delete words, filler words
  and long pauses in the transcript, search phrases, or build a paper edit from selected passages. Captions follow.
- **Smart reframe** — for 9:16, 1:1 and 4:5 the crop follows the measured motion per shot and pans when it moves.
- **Publish pack** — thumbnails and covers from the sharpest high-energy frames with your title, clean stills,
  SRT/VTT, YouTube chapters and per-platform title/description/hashtag drafts. Never posts anything.
- **Brand kits** — logo (position/size/opacity), colours, font, intro and outro, CTA and hashtags; one click or one call.

**For editors** (open `http://127.0.0.1:32146/`; interface in English or Dutch, switch top right)

- **Timeline** with markers, V1 (filmstrip thumbnails + energy bar), A1 (measured waveform), music (beat grid)
  and text tracks. Drag to reorder, drag edges to ripple-trim, Alt+drag to slip, blade tool, snapping.
- **NLE shortcuts**: Space, J/K/L, I/O, S (cut), Q/W (trim to playhead), Delete (ripple), Alt+←/→, M, N, V/B, Ctrl+Z/S, Ctrl+Enter, `?`.
- **Per shot**: speed, gain, crop/zoom/focus point, **Ken Burns** (zoom → zoom at end), mirror,
  **transitions** (dissolve, dip to black/white, wipes, slides, circle, pixelize, radial), **colour**
  (brightness, contrast, saturation, temperature, sharpen, denoise).
- **On-screen text**: title cards, lower thirds, big social text and notes with fades. Source-timed
  **captions** from your SRT that follow every cut. Three caption styles.
- **Music**: beat detection, snap cuts to the beat, music start offset, ducking under speech.
- **Live quality check**: score, hook strength, jump cuts, flash shots, black frames, caption speed, off-beat cuts — with one-click fixes.
- **Templates** (Shorts hook, game trailer, YouTube teaser, devlog, cinematic, feed post) and **named styles** shared with your agent.
- **History** with author per revision, "what changed?" and non-destructive restore. Agent edits appear live.
- **Exports**: 1080p/1440p/4K, 9:16, 1:1, 4:5 (full frame on a blurred background or your crop) and a WhatsApp version ≤ 16 MiB.
- Long-form: up to **20 minutes**, 200 shots, 24 sources (2 h each). Still images (PNG/JPG/WebP) work as sources.

**For agents** — see **[AGENTS.md](AGENTS.md)**, setup for Claude, Cursor, OpenAI Codex, the OpenAI API, n8n and others in
**[docs/INTEGRATIONS.md](docs/INTEGRATIONS.md)**, and fixes in **[TROUBLESHOOTING.md](TROUBLESHOOTING.md)**.

| Door | Entry |
| --- | --- |
| Claude Code plugin | `/plugin marketplace add <this folder>` → `/plugin install ai-edit-studio@ai-edit-studio` (tools + workflow skills + `video-director` agent) |
| OpenAI Codex | `node cli.mjs codex-setup` (or the Codex plugin in `plugins/ai-edit-studio`) — tools + the same skills |
| OpenAI API | `examples/openai/` (Responses API, Agents SDK); `GET /api/agent/tools?format=openai` |
| MCP (stdio) | `claude mcp add ai-edit-studio -- node mcp.mjs` |
| HTTP | `GET /api/agent/tools`, `POST /api/agent/call`, `POST /api/agent/tools/{name}` |
| OpenAPI 3.1 | `GET /api/openapi.json` |
| CLI | `node cli.mjs studio <tool> --request file.json [--wait]` |

One call from footage to renders: `studio_auto_edit`. Text-based editing: `studio_transcribe`, `studio_transcript`,
`studio_text_edit`. Plus `studio_reframe`, `studio_publish_pack`, `studio_brand`. Atomic `studio_edit` batches on stable clip ids (with `dryRun`), `studio_timeline` + `studio_storyboard`
to see the edit, `studio_review` with machine-applicable fixes, beats, highlights, styles, caption
import, history/diff/restore, duplicate and render. Every agent change is a revision with the agent's name.

## Install and start (Windows beta)

**With npm** (Node 20+ and FFmpeg needed):

```bash
npm install -g ai-edit-studio
ai-edit-studio install      # data folder + connects Claude Code, Codex, Claude Desktop and Cursor
ai-edit-studio serve        # starts the editor on http://127.0.0.1:32146
```

**From the download zip:** unzip, double-click `Install-AI-Edit-Studio.cmd` (macOS/Linux: `./install.sh`)
and follow [INSTALL.md](INSTALL.md). It sets up the data folder and connects Claude Code, OpenAI Codex, Claude Desktop
and Cursor in one go.

**From source:**

Requirements: **Node 20+** and an **FFmpeg** build with libx264 (tested with FFmpeg 9.0.1 on Windows and 6.1 on Linux; NVENC used when available).

```powershell
# double-click Start-Game-Trailer-Studio.vbs  (hidden server, opens the browser)
# or:
npm start
node cli.mjs doctor      # checks FFmpeg, encoder, storage and the (optional) speech engine
node cli.mjs speech-setup --model base   # optional: local speech recognition (whisper.cpp + model, ~200 MB)
```

FFmpeg/ffprobe are found on `PATH`, in `tools/ffmpeg/bin` under the app or data folder, or via `FFMPEG_PATH` / `FFPROBE_PATH`.

**Storage.** Projects and renders go to the data folder: the one you chose in the installer, otherwise
`Documents\AI Edit Studio` on Windows and `.studio-data` next to the app on macOS/Linux. To pick another folder:

```powershell
./Start-Game-Trailer-Studio.ps1 -DataRoot 'D:\AI-Edit-Studio'
# or set GAME_TRAILER_STUDIO_DATA_ROOT=<absolute folder>
```

The server binds to `127.0.0.1:32146` only (`GAME_TRAILER_STUDIO_PORT` to change). The old capture console is at `/legacy.html`.

## Honest limits

- Speech recognition only runs locally and needs the optional whisper.cpp install (or bring a transcript). No face
  tracking (reframe follows measured motion), no generative video, no uploading or publishing.
- Energy, hook, highlights and Director mode use motion, loudness, scene changes, beats and words — not story or taste.
  Post texts in the publish pack are drafts built only from your own title, brief and call to action.
- The browser preview approximates look, colour, text and transitions; the FFmpeg render is leading.
  Formats the browser cannot play (e.g. some MKV/HEVC) still edit fine; watch the rendered preview.
- SDR / H.264 output; 4K is Lanczos upscaling, not AI detail.
- Beta: not yet verified by many outside users. Bug reports are welcome as GitHub issues.

## Development

```bash
node --test                                   # unit tests
node tools/verify-beta.mjs <new-dir-under-data-root>
node tools/verify-director.mjs <new-dir-under-data-root>
node tools/verify-director-ui.mjs <playwright/index.mjs> <chrome> <new-dir> <analysed-project-id>
node tools/verify-director06.mjs <new-dir-under-data-root> [port]
node tools/verify-director06-ui.mjs <playwright/index.mjs> <chrome> <new-dir> <analysed-project-id>
node tools/verify-director07.mjs <new-dir-under-data-root> [port]
node tools/verify-director07-ui.mjs <playwright/index.mjs> <chrome> <new-dir> <analysed-project-id>
```

## License

MIT — see [LICENSE](LICENSE). Issues and pull requests are welcome; run `node --test` before sending one.

[Changelog](CHANGELOG.md) · [Privacy](PRIVACY.md) · [Third-party notices](THIRD-PARTY-NOTICES.md) · [Agent guide (NL)](AGENT-GUIDE.md)
