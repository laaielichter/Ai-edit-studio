# Changelog

## Unreleased — every output size, npm package, open source

- **All formats**: 720p (`hd`, no size cap), 1080p, 1440p, 4K and 21:9 ultrawide (`ultrawide`, 2560×1080, crops to
  fill the frame instead of black bars) as master; 9:16 at 720, 1080, 1440 and 4K; 1:1 and 4:5 at 720, 1080 and 1440.
  The editor has a *Social size* choice next to *Master*; agents pass the format ids to `studio_render`
  (up to 12 formats per render). Option `socialSize` (`720`, `1080`, `1440`, `4k`).
- **npm**: `npm install -g ai-edit-studio` gives the commands `ai-edit-studio`, `ai-edit-studio-mcp` and
  `ai-edit-studio-server`. An npm install keeps its data in `~/.ai-edit-studio` (macOS/Linux) or
  `Documents\AI Edit Studio` (Windows), so updates never touch your projects.
- **Open source** under the MIT license. The Windows default data folder is now `Documents\AI Edit Studio`.

## Unreleased — Claude Code + OpenAI Codex plugins, OpenAI API, installer and release zip, workflow skills

- **Installer for buyers**: `node cli.mjs install` (double-click `Install-AI-Edit-Studio.cmd`, or `./install.sh`)
  chooses the data folder once, checks FFmpeg (Windows/macOS: offers winget/Homebrew for Node and FFmpeg) and connects
  every agent app it finds: Claude Code (plugin), OpenAI Codex (MCP + skills), Claude Desktop and Cursor (MCP JSON,
  backups kept). Repeatable for upgrades; `node cli.mjs uninstall` removes the connections, never projects.
- **Settings file** (`%APPDATA%\AI Edit Studio\settings.json`, `~/.config/ai-edit-studio/settings.json`): the chosen
  data folder now applies to every door (editor, CLI, MCP, plugins) and counts as an explicit choice on Windows; the
  Codex plugin finds the engine through it.
- **Release zip**: `node tools/build-release.mjs` → `dist/AI-Edit-Studio-<version>.zip` + sha256, with `INSTALL.md`,
  installers, both plugins and the OpenAI examples; no tests, dev tools or internal plans; refuses files that look
  like keys. `start.sh` / `Start-AI-Edit-Studio.cmd` start the editor.
- **Fix — FFmpeg 9**: stems renders (and their sound-effect and programme mixes) used `-filter_complex_script`,
  which FFmpeg 9 removed ("Unrecognized option"), so `formats:["stems"]` failed with current Windows (Gyan) and
  Homebrew builds. All filter scripts now use the option the installed FFmpeg understands (`-/filter_complex` on 7+),
  checked once per binary. Found by the new Windows/macOS CI.
- **Fix — macOS FFmpeg**: Homebrew's plain `ffmpeg` cannot draw text or captions, so every render with a hook or
  captions failed for Mac users. The engine now also finds Homebrew's complete keg-only `ffmpeg-full`,
  `install.sh` offers to install it, the installer checks drawtext/libass/xfade instead of mere presence, and missing
  FFmpeg/text errors say how to fix it per OS.
- **Fix — symlinked paths**: `node <path>/cli.mjs …`, `server.mjs` and the MCP launcher did nothing (no output,
  exit 0) when the path went through a symlink, as `/var` and `/tmp` do on macOS. The "started directly?" check now
  compares real paths (`src/main-module.mjs`).
- **CI on Windows, macOS and Linux** (`.github/workflows/ci.yml`): unit tests plus `tools/e2e-release.mjs`, which
  unpacks the release zip in a throw-away home, runs the real installer (`install.ps1 -Unattended` on Windows),
  edits and renders through the MCP server as registered for Codex, requires render QC to pass, checks the Codex
  plugin bootstrap and the uninstall.

- **Claude Code plugin** (`.claude-plugin/plugin.json` + `marketplace.json`): installs the MCP server with
  `/plugin install`. `plugin/mcp-launch.mjs` keeps projects outside the plugin cache (`~/.ai-edit-studio` on
  macOS/Linux, `AI_EDIT_STUDIO_DATA_ROOT` to choose; Windows keeps the no-silent-C: rule).
- **Workflow skills** (`skills/`): `viral-short`, `long-to-shorts`, `talking-head`, `game-trailer`, `quality-gate`
  and `troubleshoot`, plus a `video-director` subagent (`agents/`). A test checks that every tool, recipe, template and
  platform they mention exists in the engine.
- **Docs**: `TROUBLESHOOTING.md` (error codes and symptoms → fixes), `docs/INTEGRATIONS.md` (Claude Code, Claude
  Desktop, Cursor, Codex, HTTP/OpenAPI, n8n). `AGENTS.md` now states the right tool count (57).
- **OpenAI Codex**: `node cli.mjs codex-setup` registers the MCP server in `~/.codex/config.toml` (one marked block,
  backup, 300 s tool timeout, `--dry-run`, `--uninstall`) and installs the skills in `~/.agents/skills`. Or the Codex
  plugin `plugins/ai-edit-studio` (marketplace `.agents/plugins/marketplace.json`), generated from the same skills by
  `tools/sync-codex-plugin.mjs`; it finds the engine through the per-user settings file.
- **OpenAI API**: `GET /api/agent/tools?format=openai|openai-chat` returns ready function tools;
  `examples/openai/openai-agent.mjs` (Responses API, no dependencies, frames/storyboards sent as images) and
  `examples/openai/agents_sdk.py` (Agents SDK over MCP). ChatGPT apps/GPT Actions are deliberately not supported:
  they need a public server.

## 0.10.0-beta.1 — music engine (6 October 2026)

- **Local music engine** (`src/music/`, Audio tab *Compose music*, agent tool `studio_music`, 57 tools). Pure
  JavaScript, no dependencies, no samples, no network: band-limited oscillators (PolyBLEP), zero-delay-feedback
  state-variable filters, RBJ EQ, an 8-line feedback-delay-network reverb, ping-pong delay, chorus, sidechain pump,
  compressor, look-ahead limiter, BS.1770 loudness and an FFT tonal-balance stage. Synthesised instruments: kick,
  snare, clap, hats, shaker, rim, cowbell, taiko, crash, 808 with glide, five synth basses, supersaw, pluck, pad,
  strings, brass, lead, FM electric piano, FM bell, felt piano, riser, reverse cymbal, impact, downlifter, sub drop,
  vinyl texture.
- **Composer**: six styles with their own drums, bass lines, instruments and mix recipe; mood progressions with
  voice-led 4-voice chords (sevenths for lo-fi, harmonic-minor V where wanted); a call-and-response hook written in
  scale steps (strong beats on chord tones, phrase ends resolved); sections (intro, build with snare roll, riser and a
  silent last eighth, drop, second drop with an octave layer, breaks in long pieces, final hit with ring-out);
  phrase crashes and fills.
- **Made for the edit**: a tempo map puts every drop and the final hit exactly on a bar line (tempo bends ≤ 6 % per
  section; anchors that cannot fit become accents); the track is exactly as long as the edit; the beat grid is stored
  as the project's music analysis, so beat sync and music-fit use the real beats. Each track is auto-balanced per
  instrument (measured loudness, not guesses), mastered to the style's loudness with a −1 dBFS ceiling and checked by
  tests for length, loudness, ceiling and tonal balance. Rendering runs in a worker thread (about 8 s for 25 s).
- **Other music sources**: your own file as before (also Suno/Udio downloads, which have no public API), and optional
  online generation with ElevenLabs Music using the user's own key (stored only in the local data folder, never
  returned; only the prompt and the length are sent).
- `tools/verify-director10-ui.mjs` (compose, new variation, ElevenLabs block, Dutch) and `test/music.test.mjs`.

## 0.9.0-beta.2 — fixes found while making the 25 s promo with the engine (6 October 2026)

- **Sound effects could fill the disk.** When one effect was used more than once (for example several pops), the
  pre-mixed effects track never ended: `apad,atrim=duration` did not stop on the mixed stream's timestamps and wrote
  silence until the disk was full (28 GB in about a minute on the promo). The track is now padded and cut by sample
  count on rebuilt timestamps, and the output is capped with `-t`. Regression test with real FFmpeg
  (`test/sfx-track.test.mjs`, skipped when FFmpeg is missing).
- **Older FFmpeg (4.x) could not read the render scripts**: every filter script ended with a ";", which FFmpeg 5+
  ignores but 4.x rejects ("No such filter: ''"). Scripts are now written without it (render, segments, effects,
  stems). Found because the effects-track test failed on an FFmpeg 4.4 machine.
- **History cards stretched to hundreds of pixels** for edits made in the editor: the “who” label used the class
  `editor`, which also matched the editor layout grid (`height:100%`). The label now resets those properties.
- **Right-panel tabs no longer clip** at narrower windows (they wrap to a second row instead of scrolling out of view).
- **Start screen said “23 tools”**; it now says 56 (English and Dutch).
- **Review tip “No opening or end text”** now also counts timeline texts: a hook text in the first 3 seconds or a
  call to action in the last 3 seconds is enough.

## 0.9.0-beta.1 — look, sound and talking-head polish; batch and A/B (6 October 2026)

### Look
- **LUTs** (`studio_lut`, Style tab): six built-in looks generated locally as 33³ .cube files (teal & orange, warm
  film, cool night, bleach bypass, mono contrast, vivid pop), import your own .cube (validated, copied into the
  library), strength 0–1 (blend with the graded picture), before/after preview image for agents. Applied under all text.
- **Colour match** (`studio_color_match`, Style tab): measures every shot (signalstats: exposure, contrast range,
  saturation, colour cast) and sets the shot colour controls — `auto` (exposure, contrast, white balance) or `match`
  to a reference shot so cameras and days look alike. Dry run shows the numbers.
- **Stabilise** (`studio_stabilize`, Shot tab slider): two-pass vid.stab per shot range, measured in the background
  and reused by renders; slight auto-zoom hides moving edges; `deshake` fallback without vid.stab.
- Shot **temperature** now renders as a white-balance shift (`colortemperature`, lightness kept). The old colour
  balance barely moved mid-greys, so renders were much weaker than the live preview. Projects that use temperature
  will render visibly warmer/cooler than before (as the preview showed). Older FFmpeg builds keep the old filter.

### Sound
- **Music to length** (`studio_music_fit`, Audio tab): whole bars removed from the middle (or a phrase repeated) on the
  detected beat grid, start on a beat, short crossfades — the track ends with its real ending exactly at the end of
  the edit. Writes a new WAV; re-fits from the original after edits.
- **Audio repair** (`studio_audio_repair`, Audio tab): analysis of mains hum (50/60 Hz narrow bands), clipping and
  noise floor per recording; repair chain (de-clip, de-click, hum notches at 4 harmonics, FFT noise reduction) on the
  programme sound; “even out shot levels” sets per-shot gain from measured loudness. Measured: hum 42 dB under the
  voice after repair (was 22 dB).
- **Sound effects** (`studio_sfx`, Audio tab): whoosh, hit, pop, riser, click and drop synthesised locally with
  FFmpeg (no samples downloaded); auto placement on transitions, texts, punch-ins and the finale; pre-mixed into one
  track and mixed under the master loudness.
- **Stems** (`formats:["stems"]`, Export tab checkbox): dialogue, voice-over, music, effects and the final mix as
  48 kHz/24-bit WAV; picture is not decoded for the programme sound.
- **Speed up pauses** (`studio_text_edit {speedPauses}`, Words tab): pauses play at up to 2× (pitch kept) instead of
  being cut — or, without a transcript, the quiet stretches; new edit op `speed_ranges`.

### Talking heads & social
- **Emphasis zooms** (`studio_auto_zoom`, Shot tab): punch-in changes at sentence starts, `!`/`?` and loud peaks
  (`punch_in` now takes explicit `times` and a focus), or slow push-ins/pull-outs per shot.
- **Automatic B-roll** (`studio_auto_broll`, Shot tab): cutaways from sources not in the edit where their file name is
  said (“rocket” → rocket launch.mp4), else over the calmest stretches; each uses the strongest unused part.
- **Progress bar** (`options.progressBar`, Text tab) and **callout** text style (subscribe/link pop-ups); both previewed live.

### Workflows
- **Batch** (`studio_batch`): one tool over many projects (all, name match or list), current revision filled in,
  renders queued. **Compare** (`studio_compare`, Export tab): two renders side by side or stacked, labelled, in sync,
  as a new export.

### Agents (56 tools)
- New: `studio_lut`, `studio_color_match`, `studio_stabilize`, `studio_music_fit`, `studio_audio_repair`, `studio_sfx`,
  `studio_auto_zoom`, `studio_auto_broll`, `studio_batch`, `studio_compare`; edit op `speed_ranges`; options `lut`,
  `lutStrength`, `progressBar`, `sfx`, `audioRepair`; clip `stabilize`; text style `callout`; render format `stems`.

## 0.8.0-beta.1 — long edits: segmented renders, frame-exact timing, sections, search, multicam, NLE hand-off (6 October 2026)

### Fixed (important)
- **Footage in-points (0.5–0.7)**: inputs used `-itsoffset` together with `-ss`. FFmpeg then seeks in the offset
  timeline and the accurate-seek trim no longer drops the frames between the keyframe and the in-point, so shots could
  show footage from slightly before the chosen in-point. Removed for shots, sound and layers; memory stays bounded
  (separate per-shot inputs). Renders made with 0.5–0.7 may start some shots a little early — re-render to fix.
- **Cut drift in edits with many shots**: every shot got a whole number of frames and picture and sound were padded to
  each other per shot, so cuts drifted later over the edit (about 16 ms per shot in the worst case, >1 s after 80
  shots) and captions, voice-over and music slowly fell out of step with the picture. Shots are now placed on the
  frames between their rounded cut points (no accumulation), picture and sound are joined separately, and transitions
  start on a frame. Measured: 79 cuts over 97 s land within ±17 ms of the plan (was up to +1.27 s).
- `studio_timeline` reported open comments from the wrong field; queued range renders run as their own job kind.

### Long edits (podcasts, vlogs, courses, docs, multicam)
- **Segmented, cached renders**: long edits (≥ 3 min or ≥ 60 shots, or `segmentedRender:"on"`) render as fully
  finished picture segments (grade, captions, texts, layers, logo, title/fades included) cut only at hard cuts outside
  any caption/text/layer, cached by exactly what FFmpeg is asked to do. A short final pass copies the picture and mixes
  the programme sound (loudness, voice, music, layer sound) once. A fix re-renders only its segment; ripple edits
  elsewhere keep the cache (segment boundaries follow shot ids). Brand intro/outro become cached segments too.
  Measured: 250 s edit, 7 segments; re-render after a colour fix reused 6 of 7.
- **Range renders** (`studio_render_range`, Long tab): render only a part (I/O range) as preview or final quality.
- **Fit to length** (`studio_fit_duration`): pauses and filler words → weakest sentences → weakest shots → trims toward
  each shot's strongest part → (if needed) inner trims of the opening/closing shots. One revision, dry-run preview.
- **Sections** (`studio_sections`, `options.sections`, Long tab outline): chapters anchored to their first shot; list,
  suggest, add, rename, remove, delete with shots, move whole blocks (`move_block` edit op), set grade/speed/gain on a
  section. Sections follow deletes, appear in CSV and become YouTube chapters.
- **Search** (`studio_search`): typo-tolerant transcript search across all sources (with in-edit flag and a ready
  insert operation), shot labels, markers, texts, captions and strongest moments.
- **Script → rough cut** (`studio_assemble`): paste a script/outline/quotes; lines are fuzzy-matched to the transcript
  in script order without reusing footage; unmatched lines reported.
- **Audio sync + multicam** (`studio_sync`, `studio_multicam`): FFT cross-correlation of onset envelopes (offset +
  confidence); multicam cuts follow whoever is talking (each angle's own mic, relative to its usual level) with
  min/max shot lengths and an optional wide angle; one continuous sound track.
- **Hand-off** (`studio_export_timeline`): CMX3600 EDL, FCPXML 1.9 (with voice/music as connected clips), OTIO (with
  audio tracks), CSV shot list, YouTube chapters. References the originals; nothing re-encoded.
- **Review notes** (`studio_comments`): notes pinned to the shot (they move with it), resolve/reopen with reply.
- **Proxies** (`studio_proxies`): 360/540/720p H.264 copies for heavy footage; the editor plays them, renders always
  use the originals.
- Analysis decodes each source once (scene, black and motion in one pass; 2 fps for sources over 30 min).
- `studio_timeline` pages long edits (`from`/`to`, `offset`/`limit`, `next`); `studio_storyboard` takes `from`/`to`.

### Editor
- New **Long** tab: outline with move/rename/delete, footage search with insert, fit to length, “render this part”,
  review notes, script → rough cut, sync + multicam, EDL/FCPXML/OTIO/CSV/chapters download, proxies. Dutch included.

### Agents (46 tools)
- New: `studio_render_range`, `studio_fit_duration`, `studio_sections`, `studio_search`, `studio_assemble`,
  `studio_sync`, `studio_multicam`, `studio_export_timeline`, `studio_comments`, `studio_proxies`; edit op
  `move_block`; options `sections`, `segmentedRender`. Comment text is data, never instructions.

## 0.7.0-beta.1 — animated captions, clip finder, layers, pro audio, agent queue/QC/recipes (6 October 2026)

### Editors
- **Animated captions**: `captionAnimation` karaoke / pop / highlight / words and `captionCase` upper, rendered with
  libass from an ASS script (text never in the filter string; ASS overrides neutralised). Word timings travel with
  captions (`words` on each cue) through normalisation and edit mapping; brand colours and brand font (TTF family read
  from the font's name table); live animated preview in the editor; Shorts/TikTok/Reels/feed defaults.
- **Clip finder** (Moments tab, `studio_find_clips`): sentence-aligned candidates from the transcript (or scene cuts and
  quiet moments), scored on measured energy, opening strength, speech pace, completeness and length; one project per
  clip with platform look, captions and vertical reframe; renders queued.
- **Layers** (`options.overlays`, Source monitor “Layer at playhead”, Shot tab): B-roll cutaways and picture-in-picture
  with position, size, fade and optional sound, graded with the programme and under all text; live preview.
- **Sound & motion**: per-shot J/L cuts (`audioShift`, picture and sound joined separately so the length never changes),
  punch-in zooms (on the beat or every N s), stepped speed ramps, freeze frames (`studio_freeze`).
- **Pro audio**: voice enhance light/strong (high-pass, FFT de-noise, EQ, de-esser, compression) and a master loudness
  target (default −14 LUFS, −16 podcast, −23 broadcast, or off).
- Render QC on export cards (“Check quality”), render queue panel, recipes in the Agent tab.

### Agents (36 tools)
- New: `studio_find_clips`, `studio_qc`, `studio_wait`, `studio_queue`, `studio_recipe`, `studio_freeze`.
  `queue:true` on render and auto-edit. `GET /api/events` server-sent events. Built-in recipes `shorts-from-long`,
  `podcast-clean`, `social-pack`, `game-trailer`, plus saved custom recipes.
- Transcripts are copied with duplicated projects.


## 0.6.0-beta.1 — Director mode, edit by text, smart reframe, publish pack, brand kits (6 October 2026)

### Director mode (`studio_auto_edit`, ✦ Auto-edit button, "finish it for…" in New project)
- One call from footage to a finished edit per platform (`shorts`, `tiktok`, `reels`, `feed`, `youtube`, `trailer`, `vlog`, `film`).
- Removes black frames and dead air (frozen picture AND near-silence, absolute levels), tiles footage into windows that
  snap to scene cuts, and selects with `keep`: `highlights` (energy build-up, strongest first), `story` (recorded order)
  or `most` (nearly all footage, few cuts).
- Tries three opening hooks plus the selection and keeps the highest hook score; optional A/B projects (`variants:true`).
- Transitions by pace, dip to black into a trailer finale, beat sync, captions from transcripts, up to three safe
  review fixes, smart reframe for vertical/feed, then optional preview or platform renders. Every step is a revision.

### Edit by text (`studio_transcribe`, `studio_transcript`, `studio_text_edit`, Words tab)
- Local speech recognition with whisper.cpp (`whisper-cli`, token timestamps) or FFmpeg's whisper filter; one-time
  install with `node cli.mjs speech-setup` or the button in the Words tab. Audio never leaves the computer.
- Import transcripts from SRT/VTT, whisper.cpp JSON or a words array from any ASR.
- Remove words, phrases, filler words (language-aware, conservative) and long pauses; paper edit (`assemble`) builds
  the timeline from word ranges in any order; `smooth` adds 0.12 s dissolves. New edit operation `remove_ranges`.
- `autoCaptions`: captions are rebuilt from the words still in the edit after every change. `allowJumpCuts` keeps the
  review quiet about intentional jump cuts.

### Smart reframe (`studio_reframe`, Follow the action)
- Per-shot motion centroid (frame differences above the frame median, centre prior, median smoothing) → static focus or
  an eased pan (`focusXEnd`/`focusYEnd`, smoothstep in the render and the live preview). Cached per shot.

### Publish pack (`studio_publish_pack`)
- Thumbnails (1280×720) and covers (1080×1920) from the sharpest, best-exposed high-energy frames with your title and a
  brand accent bar; clean 1080p stills; timeline SRT/VTT; YouTube chapters; per-platform title/description/hashtag
  drafts from your own title, brief and CTA; `publish.md` + `publish.json`. Nothing is uploaded.

### Brand kits (`studio_brand`, Style tab)
- Logo with position/size/opacity, primary/accent/text colours (numeric in every filter), font file, intro/outro clips
  (≤ 30 s, wrapped in an extra pass; SRT shifted), caption/look defaults, CTA, label, hashtags.

### Fixes
- **Render crash fixed**: a shot that runs into the end of its recording made FFmpeg fail with "Invalid data found when
  processing input" (padded audio frames without timestamps). Audio timestamps are now rebuilt after padding. This also
  affected 0.5.
- Previews can be vertical/square/portrait (`previewFormat`); storyboards of vertical exports use portrait tiles.
- Agent door, CLI and MCP accept requests up to 12 MiB (long transcripts).

### Agents (30 tools)
- New: `studio_auto_edit`, `studio_transcribe`, `studio_transcript`, `studio_text_edit`, `studio_reframe`,
  `studio_publish_pack`, `studio_brand`. `studio_doctor` reports the speech engine. MCP instructions describe the fast path.

## 0.5.0-beta.1 — English engine, Ken Burns, styles, memory-safe renders (5 October 2026)

### Editor
- Interface in **English by default** with a full **Dutch** translation (`public/i18n.js`, switch top right; remembered per browser).
- **Ken Burns**: per-shot `zoomEnd` animates the zoom over the shot (zoompan in the render, CSS in the live preview).
- **Named styles** stored by the engine (look, brand, mix, captions, export choices) — shared between editor and agents.
- Render progress shows an ETA. Opening a project link while the app is open now switches projects (hashchange).

### Engine
- **All engine, review and validation messages are English** (error codes unchanged).
- **Memory-safe renders with transitions**: each clip's audio gets its own demuxer and every input is placed on the
  timeline with `-itsoffset`. A 35 s 1440p60 edit with crossfades dropped from >6 GB peak (killed by the OOM killer)
  to ~1.5 GB.
- `studio_frame` accepts `size:"large"` (1920 px, higher quality).

### Agents (23 tools)
- New: `studio_style` (list/save/apply), `studio_captions_import` (local SRT → source-timed captions), `studio_doctor`.
- AGENTS.md updated; the copied agent brief is English.

## 0.4.1-beta.1 — socials, vlogs en korte films (4 oktober 2026)

### Montage
- Limieten: 20 minuten, 200 shots, 24 bronnen, bronnen tot 2 uur (`LIMITS` in `public/edit-ops.js`, overal hergebruikt).
- Overgangen per shot (`transition`, `transitionSeconds`): `fade`, `fadeblack`, `fadewhite`, `wipeleft`, `wiperight`,
  `slideleft`, `slideright`, `circleopen`, `smoothleft`, `pixelize`, `radial`. Overlappende tijdlijnlayout
  (`overlapOf`, `layout` met `visibleStart/visibleEnd`), render via gegroepeerde concat + xfade/acrossfade,
  ondertitelmapping en per-shotvolume volgen de overlap. Het tweede deel van een knip begint altijd met een harde knip.
- Kleur per shot: `brightness`, `contrast`, `saturation`, `temperature`, `sharpen`, `denoise` (eq/colorbalance/unsharp/hqdn3d).
- Tekst op de tijdlijn: `options.texts` met stijlen `title`, `lower`, `big`, `note` en vijf posities; drawtext met fade;
  operaties `add_text`, `update_text`, `remove_text`; Tekst-tab met lijst en "tekst bij afspeelkop"; T-spoor; live overlay.
- Stilstaande beelden (PNG/JPG/WebP) als bron: virtuele duur 60 s, render met `-loop`, filmstrip/frames/storyboard
  zonder seek, speler met klok in plaats van video-tijd; voorstellen slaan stills over; projecten met alleen stills krijgen geen voorstel.
- Shot-inspector: overgang (type + duur), kleurregelaars met live voorbeeld, "Herstel kleur", "Kopieer naar alle shots".
- Tijdlijn tekent overlappende shots tot de zichtbare knip en zet een overgangsmarker op de overlap.

### Agents
- HTTP-ingang: `GET /api/agent/tools`, `POST /api/agent/call {name, arguments}`, `POST /api/agent/tools/{name}`,
  `GET /api/openapi.json`. Auteur uit `X-Studio-Client` (max. 40 tekens) op elke revisie.
- `studio_duplicate`: kopie zonder exports (sjabloon voor A/B of verticale cut).
- Beats worden nu voor de hele montage berekend (voorheen tot 2 minuten).
- `AGENTS.md`: Engelse quickstart voor alle agentframeworks.

### Fixes
- Afspelen stopte niet meer op een stilstaand beeld met geluid van het vorige shot; eerste-shot-overgang wordt genegeerd.
- Importeren van `.webp` via de browser; eindbericht na analyse bleef "Filmstrip x/x".

## 0.4.0-beta.1 — Director 0.4 (4 oktober 2026)

### Editor
- Nieuwe editor-layout (bronnen · monitor · inspector · tijdlijn) op volledige schermbreedte.
- Tijdlijn met sporen: markers, V1 met filmstrip-thumbnails en energiebalk, A1-waveform (gemeten loudness),
  muziek met beatgrid, ondertitels. Zoom (Ctrl+scroll, +/−, passend), snappen, I/O-bereik.
- Gebaren: slepen = verplaatsen, rand slepen = ripple-trim met live bronframe, Alt+slepen = slip, mes-gereedschap.
- Sneltoetsen: Spatie, J/K/L, ←/→ (frame), Shift+←/→ (seconde), ↑/↓ (knippen), I/O/X, S, Q/W, Delete,
  Alt+←/→, M, N, V/B, Ctrl+Z/Shift+Z/Y, Ctrl+S, Ctrl+Enter, Ctrl+A, `?`.
- Bronmonitor met in/uit, gearceerde gebruikte stukken en invoegen bij kop/achteraan.
- Afspeler met twee video-elementen (voorladen volgende shot), meespelende muziek/voice-over,
  CSS-benadering van look, fades, titel, eindtekst en ondertitels; 9:16/1:1/4:5-voorbeeld met vervaagde achtergrond.
- Shot-inspector: label, bron wisselen naar ongebruikt stuk, in/uit met nudge, snelheid, volume,
  kader, zoom, focuspunt-kiezer met uitsnede per formaat, spiegelen; meervoudige selectie.
- Live kwaliteitscheck met score, hookmeter, issues, "ga naar" en één-klik-fixes.
- Momenten-paneel met sterkste ongebruikte stukken; invoegen bij de kop.
- Look-kaarten met live voorbeeld, ondertitelstijlen (box/bold/minimal) en posities, bewerkbare ondertitelregels.
- Beatdetectie, "snap knippen op beat", muziek-startpunt.
- Historie: auteur per revisie, diff-weergave, terugzetten. Live meekijken met agentwijzigingen;
  conflictkeuze bij niet-opgeslagen werk.
- Welkomstscherm met sjablonen en recente projecten; nieuw-projectdialoog met sjabloonkeuze en automatisch analyseren.
- Agent-tabblad met opdracht, configuratie (Claude Code, MCP-json, terminal) en activiteitenfeed.
- Responsieve layout zonder horizontale overloop op 390 px.

### Engine en agents
- `public/edit-ops.js`: gedeelde, pure edit-operaties (UI én engine) met stabiele clip-ids en atomische batches.
- Nieuwe API-routes en tools: `edit`, `timeline`, `storyboard`, `review`, `highlights`, `beats`,
  `history`, `diff`, `restore`, `revision` (19 MCP-tools totaal).
- Revisiegeschiedenis op schijf (`history/rev-NNNNNN.json`) met auteur en samenvatting.
- `public/insights.js`: energiecurves, highlights, hookscore, review met machine-toepasbare fixes.
- `src/beats.mjs`: lokale beatdetectie (spectral flux, autocorrelatie, dynamic programming).
- `src/templates.mjs`: zes sjablonen; `template` bij aanmaken.
- Nieuwe opties: `captionStyle`, `captionPosition`, `musicTrimStart`, `markers`, `template`; clipveld `label`.
- Filmstrips per bron (lazy, gecachet, na analyse vooraf gemaakt); muziek/voice-over via de lokale mediaroute.
- FFmpeg < 7: automatisch `-filter_complex_script` in plaats van `-/filter_complex`.
- HTTP 409 voor revisieconflicten en bezette engine; request-limiet 256 KiB (gelijk aan de CLI).
- CLI: `--from`, `--to`, `--to-revision`, `--dry-run`.

### Compatibiliteit
- Bestaande projecten, opslagpaden, poort, `GAME_TRAILER_STUDIO_*`-variabelen en startscripts blijven werken.
- Oudere 0.3-server: nieuwe tools geven `RESTART_REQUIRED`; oude tools blijven werken.
