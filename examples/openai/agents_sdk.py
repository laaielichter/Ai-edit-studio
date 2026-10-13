"""AI Edit Studio with the OpenAI Agents SDK (pip install openai-agents), over MCP stdio.

    OPENAI_API_KEY=... python examples/openai/agents_sdk.py --skill viral-short "Make a TikTok from D:/clips/a.mp4 ..."

The SDK starts the same MCP server Claude Code and Codex use. Video files stay on this computer.
"""
import argparse
import asyncio
import os
import re
from pathlib import Path

from agents import Agent, Runner
from agents.mcp import MCPServerStdio

ROOT = Path(__file__).resolve().parents[2]


def body(path: Path) -> str:
    return re.sub(r"\A---\n.*?\n---\n", "", path.read_text(encoding="utf-8"), flags=re.S).strip()


def instructions(skill: str | None) -> str:
    parts = [body(ROOT / "agents" / "video-director.md")]
    for name in [skill, "quality-gate"]:
        if name:
            parts.append(body(ROOT / "skills" / name / "SKILL.md"))
    return "\n\n---\n\n".join(parts)


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("prompt")
    parser.add_argument("--skill", choices=["viral-short", "long-to-shorts", "talking-head", "game-trailer"])
    parser.add_argument("--model", default=os.environ.get("OPENAI_MODEL", "gpt-5"))
    args = parser.parse_args()

    async with MCPServerStdio(
        name="ai-edit-studio",
        params={"command": "node", "args": [str(ROOT / "plugin" / "mcp-launch.mjs")]},
        client_session_timeout_seconds=300,  # studio_wait long-polls up to 280 s
        cache_tools_list=True,
    ) as studio:
        agent = Agent(name="Video director", instructions=instructions(args.skill), model=args.model, mcp_servers=[studio])
        result = await Runner.run(agent, args.prompt, max_turns=80)
        print(result.final_output)


if __name__ == "__main__":
    asyncio.run(main())
