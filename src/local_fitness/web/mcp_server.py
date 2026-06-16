"""Expose the fitness tools as a standalone MCP server.

Lets interactive Claude sessions (Claude Code, Claude Desktop, other local
agents) query the fitness DB directly over the Model Context Protocol. The
SDK's in-process ``create_sdk_mcp_server`` (used by the brief/chat agent loop)
cannot be reached by an external client — but it returns a fully-wired
low-level ``mcp`` ``Server`` whose tool schemas and content handling are
already correct. We REUSE that exact server instance over a different
transport (streamable-HTTP for the deployed endpoint, stdio for local use),
so there is one source of truth for the tools and no schema/return-shape
reimplementation.

Design: ``docs/plans/2026-06-16-fitness-mcp-server-design.md``.
"""
from __future__ import annotations

import os

from mcp.server.lowlevel import Server
from mcp.server.streamable_http_manager import StreamableHTTPSessionManager
from mcp.server.transport_security import TransportSecuritySettings

from ..agent import tools as agent_tools

# Host allowlist for the streamable-HTTP transport's DNS-rebinding guard.
# Empty allowlist + protection-on (the SDK default) returns 421 for every
# request, so the served host MUST be present. Env-overridable for the
# container deployment; the default works for a fresh clone on loopback.
_DEFAULT_ALLOWED_HOSTS = "fitness.home.local,127.0.0.1,localhost"


def allowed_hosts() -> list[str]:
    raw = os.environ.get("LOCAL_FITNESS_MCP_ALLOWED_HOSTS", _DEFAULT_ALLOWED_HOSTS)
    return [h.strip() for h in raw.split(",") if h.strip()]


def build_server() -> Server:
    """The reused, fully-wired low-level MCP Server (one source of truth)."""
    return agent_tools.make_server()["instance"]


def build_session_manager(
    *,
    stateless_http: bool = True,
    json_response: bool = True,
    hosts: list[str] | None = None,
) -> tuple[Server, StreamableHTTPSessionManager]:
    """Build the reused Server + a streamable-HTTP session manager.

    ``json_response=True`` keeps POST tool-call replies as plain JSON (no
    long-lived SSE stream) so they pass cleanly through the existing
    ``BaseHTTPMiddleware`` auth/rate-limit stack. ``stateless_http=True`` drops
    per-session state (each tool call is self-contained). NOTE: the caller MUST
    run ``session_manager.run()`` in the host app's lifespan, or every request
    raises ``RuntimeError("Task group is not initialized")`` — mounting alone
    does not start it.
    """
    server = build_server()
    manager = StreamableHTTPSessionManager(
        app=server,
        stateless=stateless_http,
        json_response=json_response,
        security_settings=TransportSecuritySettings(
            allowed_hosts=hosts if hosts is not None else allowed_hosts(),
        ),
    )
    return server, manager


async def run_stdio() -> None:
    """Serve the same tools over stdio (local, auth-free). No HTTP, so the
    Host/Origin and trailing-slash gotchas of the HTTP path do not apply."""
    from mcp.server.stdio import stdio_server

    server = build_server()
    async with stdio_server() as (read, write):
        await server.run(read, write, server.create_initialization_options())
