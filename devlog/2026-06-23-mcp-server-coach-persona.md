# 2026-06-23 — The coach voice follows you into Claude Code, not just the slash command

When I made the coach voice selectable, I wired it into the two fitness slash
commands and called it done. But there is a second way I actually talk to my
fitness data: through Claude Code, by asking a question and letting it call the
tools. That path had no voice at all. It answered in Claude Code's default tone,
because nothing told it I had a coach, let alone which one.

So the fitness MCP server now hands Claude Code the coach persona as its
server-level instructions. The persona rides along with the connection, and the
tool-driven answers pick up the profile I set. Set hardass, and asking "how are
my steps" through the tools gets the hardass read, not a neutral one.

## The bug the review caught before I shipped it

My first version set the persona when the server was built. That looked obviously
fine and was obviously wrong. The server is built at import time, and the database
schema isn't created until the app starts up a moment later. Reading my settings
during the build means reading a table that does not exist yet, which crashes on a
fresh clone before anything runs. That breaks the one rule this repo has: a
stranger who clones it has to be able to start it.

The fix turned out better than the original idea. Instead of resolving the persona
once at build, I resolve it at the moment a client connects. That defers the read
to after startup, so the fresh clone is safe, and it is fail-safe on top of that:
if the lookup ever fails, the connection just gets no persona instead of an error.
The unexpected bonus is that resolving on every connect makes it live. Change your
profile and the next connection picks it up, no restart, exactly like the slash
commands already behaved. The thing I was about to file as an accepted limitation
disappeared.

## Tested for the failure I almost shipped

There is now a test that builds the server against an uninitialized database and
asserts it does not crash, which is the exact regression the review surfaced.
Alongside it: the persona reflects the live profile, it changes when I change the
setting between two connects, and a lookup error degrades to no persona rather
than a broken handshake. One honest caveat remains in the notes: whether Claude
Code actually uses server instructions is the client's call, so the slash command
stays as the guaranteed path.
