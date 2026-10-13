# Troubleshooting

Run `node cli.mjs doctor` first (agents: `studio_doctor`). It checks Node, FFmpeg/ffprobe, the encoder, the data
folder and the optional speech engine.

## Install and start

| Problem | Fix |
| --- | --- |
| `node` not found / old version | Install Node 20 or newer, open a new terminal. |
| `CAPTIONS_UNAVAILABLE` / "does not support on-screen text (drawtext)" | Your FFmpeg has no text rendering. macOS: `brew install ffmpeg-full` (found automatically, even though it is not on PATH). Windows: `winget install Gyan.FFmpeg`. Run the installer again to check. |
| `ffmpeg was not found` | Windows: `winget install Gyan.FFmpeg`; macOS: `brew install ffmpeg-full`; Linux: your package manager. Or put it in `tools/ffmpeg/bin` under the data folder, or set `FFMPEG_PATH` and `FFPROBE_PATH`. It needs libx264, drawtext and libass. |
| `DATA_ROOT_UNAVAILABLE` | The data folder cannot be created. Pick another one: `./Start-Game-Trailer-Studio.ps1 -DataRoot 'D:\AI-Edit-Studio'`, or set `GAME_TRAILER_STUDIO_DATA_ROOT`. For the plugin/MCP: `AI_EDIT_STUDIO_DATA_ROOT`. |
| `INSUFFICIENT_FREE_SPACE` | Free disk space on the data drive; remove proxies (`studio_proxies {action:"remove"}`) and old exports. |
| Browser does not open / `SERVER_START_FAILED` | Port 32146 in use → set `GAME_TRAILER_STUDIO_PORT`. Logs: `<data folder>/logs`. Start `node server.mjs` in a terminal to see the error. |
| MCP tools missing in Claude/Cursor | Absolute path to `mcp.mjs` / `plugin/mcp-launch.mjs`; Node on PATH for that app; restart the client. In Claude Code `/mcp` shows the status. |

## Speech and captions

| Problem | Fix |
| --- | --- |
| `ASR_UNAVAILABLE` | `node cli.mjs speech-setup --model base` (Windows downloads whisper.cpp + model, ~200 MB). macOS: `brew install whisper-cpp`, then speech-setup for the model. Or import your own SRT/VTT/JSON. |
| Wrong language | `language:"nl"` (or `en`, …) instead of `auto`. Larger model: `--model small`. |
| Captions late/early by a fixed amount | Caption offset (editor: Text tab; agents: `set_options {captionOffset}`). |
| Captions drift in long edits | Exports from before 0.8 had a drift bug — re-render. |
| Captions too fast to read | `studio_review` flags it; shorten lines or slow the cut. |

## Render and quality

| Problem | Fix |
| --- | --- |
| `ENGINE_BUSY` | One analysis/render at a time. Use `queue:true` or wait. |
| `RENDER_FAILED` | `doctor`; render the failing part only (`studio_render_range`) to find the shot; check the source plays. |
| Too quiet/loud after upload | Check `studio_qc`: −14 LUFS and true peak ≤ −1 dBTP. Set `loudnessTarget`, re-render. |
| Vertical crop loses the subject | Reframe follows motion, not faces: set the focus point per shot, or use fit (blurred background). |
| Preview differs from export | The FFmpeg render is leading. Judge the export. |
| HEVC/MKV does not play in the editor | Editing still works; make proxies for playback. |
| Lost an edit | History → restore. Nothing is ever deleted. |

Still stuck? Note the error `code`, the `doctor` output and the last lines of `<data folder>/logs`, and file an issue.
Do not attach footage or keys.
