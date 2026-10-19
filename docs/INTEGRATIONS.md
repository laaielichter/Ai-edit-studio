# Connect AI Edit Studio to your agent or tool

Claude Code · Claude Desktop · Cursor · OpenAI Codex · OpenAI API (Responses, Agents SDK) · HTTP/OpenAPI · CLI.

**Easiest:** `node cli.mjs install` (or `Install-AI-Edit-Studio.cmd` / `./install.sh`) sets up the data folder and
connects every app below that is on this computer — Claude Code (plugin), Codex (MCP + skills), Claude Desktop and
Cursor. Safe to run again; `node cli.mjs uninstall` removes the connections, never your projects. The sections below
are for doing it by hand.

One engine, the same 59 tools everywhere. Replace `C:\path\to\ai-edit-studio` with your folder.

## Claude Code — plugin (recommended: tools + workflow skills + video-director agent)

```text
/plugin marketplace add C:\path\to\ai-edit-studio        (or laaielichter/ai-edit-studio)
/plugin install ai-edit-studio@ai-edit-studio
```

You get the MCP server plus these skills (type `/` to see them):

| Skill | For |
| --- | --- |
| `/ai-edit-studio:viral-short` | raw clips → hook-first TikTok/Reels/Shorts with A/B hooks |
| `/ai-edit-studio:long-to-shorts` | podcast, stream or interview → a batch of ready clips |
| `/ai-edit-studio:talking-head` | edit by transcript, voice repair, captions, zooms, B-roll, chapters |
| `/ai-edit-studio:game-trailer` | gameplay captures → trailer + vertical + WhatsApp |
| `/ai-edit-studio:quality-gate` | the checklist before anything is called done |
| `/ai-edit-studio:troubleshoot` | error codes and symptoms → fixes |

And a `video-director` subagent that runs a whole job. Data folder: `~/.ai-edit-studio` on macOS/Linux and `Documents\AI Edit Studio` on Windows; set
`AI_EDIT_STUDIO_DATA_ROOT` (e.g. `D:\AI-Edit-Studio`) before starting Claude Code to use another folder.

Only the MCP server: `claude mcp add ai-edit-studio -- node C:\path\to\ai-edit-studio\mcp.mjs`.

## Claude Desktop, Cursor, Windsurf, Cline (MCP JSON)

`claude_desktop_config.json`, `.cursor/mcp.json`, … :

```json
{
  "mcpServers": {
    "ai-edit-studio": {
      "command": "node",
      "args": ["C:\\path\\to\\ai-edit-studio\\plugin\\mcp-launch.mjs"],
      "env": { "AI_EDIT_STUDIO_DATA_ROOT": "D:\\AI-Edit-Studio" }
    }
  }
}
```

## OpenAI Codex (app, CLI and IDE extension)

**Option A — one command (works with every Codex version that reads `config.toml`):**

```bash
node cli.mjs codex-setup                                  # macOS/Linux
node cli.mjs codex-setup --data-root D:\AI-Edit-Studio    # Windows: choose the data folder
```

It adds one marked `[mcp_servers.ai-edit-studio]` block to `~/.codex/config.toml` (backup next to it; tool timeout
300 s for `studio_wait`), installs the six skills as `~/.agents/skills/ai-edit-studio-*` and records the engine and data folder in the
settings file. `--dry-run` shows the plan, `--uninstall` removes the block and the skills. Run it again
after moving the engine folder or changing Node. Restart Codex; `/mcp` lists the server.

**Option B — Codex plugin** (plugin directory in the Codex app/CLI):

```bash
node cli.mjs codex-setup --plugin              # only tells the plugin where the engine is
codex plugin marketplace add C:\path\to\ai-edit-studio
```

Restart Codex and install **AI Edit Studio** from the plugin directory. The plugin (`plugins/ai-edit-studio/`, built by
`node tools/sync-codex-plugin.mjs`) brings the skills and the MCP server. Codex copies only the plugin folder into its
cache, so the plugin finds the engine through the settings file the installer / `--plugin` writes (or
`AI_EDIT_STUDIO_HOME`). Use A or B, not both
(`--plugin` removes A's block and skills).

Codex also reads this repo's `AGENTS.md` when you work inside the engine folder.

## OpenAI API — Responses API and Agents SDK

- **Node, no dependencies:** `OPENAI_API_KEY=… node examples/openai/openai-agent.mjs --skill viral-short "Make a TikTok
  from D:\clips\a.mp4 and b.mp4, promise: I built a game in 7 days"`. The model gets all 59 tools; calls run in the
  local engine; storyboards and frames go to the model as images so it can see the edit.
- **Agents SDK (Python):** `pip install openai-agents`, then `python examples/openai/agents_sdk.py --skill long-to-shorts
  "…"` — the same MCP server over stdio.
- **Your own code:** `GET /api/agent/tools?format=openai` returns ready Responses-API function tools
  (`?format=openai-chat` for Chat Completions); run each call with `POST /api/agent/tools/{name}`.

What goes to OpenAI: your prompt, the tool results (JSON) and storyboard/frame JPEGs. Video and audio files never leave
the computer. Model: `--model` or `OPENAI_MODEL` (default `gpt-5`).

## ChatGPT apps and GPT Actions — not supported, on purpose

ChatGPT apps (developer-mode connectors) and GPT Actions only call servers on a **public HTTPS URL**. AI Edit Studio
listens on 127.0.0.1 only and its tools read local file paths; putting it on the internet (tunnels) would expose your
computer. Use Codex, the API examples above or any local MCP client instead.

## HTTP — LangChain, n8n, Make, custom agents

Start the engine (`npm start`), then:

- Tool list with JSON schemas: `GET http://127.0.0.1:32146/api/agent/tools` (`?format=openai` / `openai-chat`)
- Call: `POST /api/agent/tools/{name}` with the arguments as JSON body, header `X-Studio-Client: <agent name>`
- OpenAPI 3.1 for OpenAPI loaders: `GET /api/openapi.json`
- Live progress: `GET /api/events?projectId=…` (SSE)

The server only listens on 127.0.0.1. n8n/Make on the same computer can reach it; cloud automations cannot (by design).

## Shell agents and scripts

```bash
node cli.mjs studio auto_edit --request job.json --wait
node cli.mjs studio qc --project <id>
```

## First prompt to try

> Use AI Edit Studio. Make a TikTok from `D:\clips\day1.mp4` and `D:\clips\day2.mp4`. Promise: "I built a game in 7 days".
> CTA "Follow for day 8". Give me the three hook variants, run the quality gate and make a publish pack.
