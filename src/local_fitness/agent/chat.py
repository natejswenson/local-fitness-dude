"""Interactive REPL with the fitness agent and one-shot ask command."""
from __future__ import annotations

import asyncio

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    ClaudeSDKClient,
    TextBlock,
    query,
)
from rich.console import Console
from rich.markdown import Markdown
from rich.prompt import Prompt

from . import prompts
from . import tools as agent_tools

console = Console()


def _options(model: str) -> ClaudeAgentOptions:
    server = agent_tools.make_server()
    return ClaudeAgentOptions(
        mcp_servers={agent_tools.SERVER_NAME: server},
        allowed_tools=agent_tools.allowed_tool_names(),
        system_prompt=prompts.SYSTEM_PROMPT,
        model=model,
        permission_mode="bypassPermissions",
        max_turns=50,
    )


async def _chat(model: str) -> None:
    options = _options(model)
    console.print(f"[bold cyan]fitness chat[/] · model: {model} · ctrl-d to exit\n")
    async with ClaudeSDKClient(options=options) as client:
        while True:
            try:
                user_input = Prompt.ask("[bold green]you[/]")
            except (EOFError, KeyboardInterrupt):
                console.print("\n[dim]bye[/]")
                return
            if not user_input.strip():
                continue
            await client.query(user_input)
            buffer: list[str] = []
            async for msg in client.receive_response():
                if isinstance(msg, AssistantMessage):
                    for block in msg.content:
                        if isinstance(block, TextBlock):
                            buffer.append(block.text)
            console.print()
            console.print(Markdown("\n".join(buffer)))
            console.print()


def run(model: str) -> None:
    asyncio.run(_chat(model))


async def _ask_once(question: str, model: str) -> str:
    options = _options(model)
    chunks: list[str] = []
    async for msg in query(prompt=question, options=options):
        if isinstance(msg, AssistantMessage):
            for block in msg.content:
                if isinstance(block, TextBlock):
                    chunks.append(block.text)
    return "\n".join(chunks).strip()


def ask(question: str, model: str) -> None:
    answer = asyncio.run(_ask_once(question, model))
    console.print(Markdown(answer))
