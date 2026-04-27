"""Daily morning briefing generator.

Runs the agent in one-shot briefing mode and writes the result to
~/localrepo/local-fitness/briefings/YYYY-MM-DD.md.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import date
from pathlib import Path

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    TextBlock,
    query,
)

from .. import db
from . import prompts
from . import tools as agent_tools

LOG = logging.getLogger(__name__)

DEFAULT_BRIEFINGS_DIR = Path.home() / "localrepo" / "local-fitness" / "briefings"
DEFAULT_MODEL = "claude-sonnet-4-6"


async def _generate(model: str = DEFAULT_MODEL) -> str:
    user_name = db.get_setting("user_name", prompts.DEFAULT_USER_NAME)
    server = agent_tools.make_server()
    options = ClaudeAgentOptions(
        mcp_servers={agent_tools.SERVER_NAME: server},
        allowed_tools=agent_tools.allowed_tool_names(),
        system_prompt=prompts.system_prompt(user_name),
        model=model,
        permission_mode="bypassPermissions",
        max_turns=20,
    )
    chunks: list[str] = []
    async for message in query(prompt=prompts.briefing_prompt(user_name), options=options):
        if isinstance(message, AssistantMessage):
            for block in message.content:
                if isinstance(block, TextBlock):
                    chunks.append(block.text)
    return "\n".join(chunks).strip()


def generate_and_save(out_dir: Path | None = None, model: str = DEFAULT_MODEL) -> Path:
    out_dir = out_dir or DEFAULT_BRIEFINGS_DIR
    out_dir.mkdir(parents=True, exist_ok=True)
    text = asyncio.run(_generate(model=model))
    path = out_dir / f"{date.today().isoformat()}.md"
    path.write_text(text + "\n", encoding="utf-8")
    LOG.info("Wrote briefing to %s", path)
    return path
