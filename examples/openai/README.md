# AI Edit Studio with OpenAI

- `openai-agent.mjs` — Responses API loop, no dependencies: `OPENAI_API_KEY=… node examples/openai/openai-agent.mjs --skill viral-short "<what to make>"`
- `agents_sdk.py` — OpenAI Agents SDK over MCP stdio: `pip install openai-agents`, `python examples/openai/agents_sdk.py --skill long-to-shorts "<what to make>"`

Both use the `video-director` instructions plus the chosen skill and the `quality-gate` skill from this repo, so OpenAI
models follow the same workflow as Claude Code and Codex. Codex itself: see `docs/INTEGRATIONS.md` (`node cli.mjs codex-setup`).
Only prompts, tool results (JSON) and storyboard/frame JPEGs are sent to OpenAI; video files stay local.
