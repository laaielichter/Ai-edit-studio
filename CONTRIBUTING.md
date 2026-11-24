# Contributing to AI Edit Studio

Thanks for helping. Small fixes and big ideas are both welcome. Starring the repo is a simple way to keep it in your list and helps others find it, but it is never needed to get an issue, help or a review.

## Ways to help

- Pick an issue labeled `good first issue`. Done one already? Try one labeled `intermediate`.
- Report a bug or suggest a feature with the issue forms.
- Try AI Edit Studio with your agent (Claude Code, Codex, Cursor, an OpenAI or n8n flow, ...) and tell us what broke or what was missing.
- Improve the docs or add an example.

Before you start on an issue, leave a short comment such as "I'd like to work on this". Then nobody does the same work twice.

## Set up

You need Node 20 or newer and FFmpeg. There are no npm dependencies to install.

```bash
git clone https://github.com/laaielichter/ai-edit-studio.git
cd ai-edit-studio
node cli.mjs doctor   # checks Node, FFmpeg and the encoders
node --test           # the test suite
```

FFmpeg, as CI installs it: `choco install ffmpeg` on Windows, `brew install ffmpeg-full` on macOS,
`sudo apt-get install ffmpeg` on Linux. Part of the test suite renders real video, so install FFmpeg before you run
the tests.

To try the tools from an agent while you work: `claude mcp add ai-edit-studio -- node mcp.mjs`, or start the
editor with `npm start`.

## Rules of the codebase

- No runtime dependencies: Node's standard library and FFmpeg only.
- Footage stays on the user's computer. Nothing is uploaded unless the user picks a cloud provider themselves.
- Every tool is defined once in `src/agent-tools.mjs`; MCP, HTTP and the CLI all read that list. A new tool also
  needs its description, a test, and a line in `AGENTS.md`.
- Errors are `StudioError` with a stable code (for example `FILE_NOT_FOUND`). Agents match on the code, so keep
  codes stable and make the message say what to do.
- The Codex plugin carries a copy of the skills: run `node tools/sync-codex-plugin.mjs` after you change them
  (CI runs it with `--check`).
- CI runs on Windows, macOS and Linux. Mind paths, line endings and 8.3 short names on Windows.

## Pull requests

1. Keep each pull request to one change, and link the issue (`Fixes #12`).
2. Add or update tests, and the docs when behaviour changes.
3. Run `node --test` before you push.
4. Describe what changed and why, and how you tested it.
5. Do not edit `CHANGELOG.md` in your pull request; the maintainer adds the entry, with credit to you, when it is merged. This keeps pull requests from conflicting with each other.

First-time contributors: CI waits for a maintainer to approve the first run. That is normal and not something you
did wrong.

## Security

Please report a vulnerability privately through
[GitHub security advisories](https://github.com/laaielichter/ai-edit-studio/security/advisories/new), not in a
public issue.
