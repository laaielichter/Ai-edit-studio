# Install AI Edit Studio

A local video editor for you **and** your AI agents (Claude Code, OpenAI Codex, Claude Desktop, Cursor, your own
OpenAI agents). Your footage never leaves your computer.

## Windows

1. Unzip `AI-Edit-Studio-<version>.zip` to a permanent place, e.g. `D:\Apps\AI-Edit-Studio` (not Downloads).
2. Double-click **`Install-AI-Edit-Studio.cmd`**. It offers to install Node.js and FFmpeg (via winget) when they are
   missing, asks where projects and renders go, and connects every agent app it finds.
3. Start the editor with **`Start-AI-Edit-Studio.cmd`**, or restart your agent app and ask it to use AI Edit Studio.

## macOS / Linux

```bash
unzip AI-Edit-Studio-<version>.zip -d ~/Apps && cd ~/Apps/AI-Edit-Studio-<version>
./install.sh                 # optional: --data-root /Volumes/Video/AI-Edit-Studio
./start.sh                   # opens the editor in your browser
```

Needs Node.js 20+ and a complete FFmpeg. On macOS: `brew install node ffmpeg-full` (`install.sh` offers it). The
plain `ffmpeg` formula cannot draw text or captions.

## What the installer connects

| App | What you get |
| --- | --- |
| Claude Code | plugin: 57 tools, 6 workflow skills (`/ai-edit-studio:viral-short` …), `video-director` agent |
| OpenAI Codex (app, CLI, IDE) | the 57 tools (MCP) and the same 6 skills |
| Claude Desktop, Cursor | the 57 tools (MCP) |
| OpenAI API / Agents SDK | nothing to install — `examples/openai/` with your own `OPENAI_API_KEY` |

Apps installed later? Run the installer again — it is safe to repeat, also for upgrades (unzip the new version, run its
installer; your projects stay where they are). Options: `--no-claude`, `--no-codex`, `--no-desktop`, `--no-cursor`,
`--dry-run`. Remove the connections with `node cli.mjs uninstall` (projects and renders are kept).

## First thing to try

> Use AI Edit Studio. Make a TikTok from `D:\clips\day1.mp4` and `D:\clips\day2.mp4`. Promise: "I built a game in 7
> days". CTA "Follow for day 8". Give me three hook variants, run the quality gate and make a publish pack.

Problems: [TROUBLESHOOTING.md](TROUBLESHOOTING.md) · privacy: [PRIVACY.md](PRIVACY.md) · all agent options:
[docs/INTEGRATIONS.md](docs/INTEGRATIONS.md).

---

**Nederlands, kort:** pak de zip uit op een vaste plek, dubbelklik `Install-AI-Edit-Studio.cmd`, kies je datamap en
start daarna `Start-AI-Edit-Studio.cmd`. De installer koppelt Claude Code, OpenAI Codex, Claude Desktop en Cursor als
die op je pc staan. Opnieuw uitvoeren is veilig (ook bij een update).
