# ops/ — scheduled brief job (macOS launchd)

The daily brief is composed by a **separate, scheduled process** — not the
web server. In the agent-first architecture the web server holds no Claude
inference; the brief is written out-of-band by `fitness brief`, which runs
the Claude-bound headless agent (in-process MCP via `make_server()`) and
persists the result through `briefs.save_brief()`.

On macOS, `launchd` runs that job daily.

## Install

```bash
./ops/install-launchd.sh
```

This resolves your `uv` binary and this repo's path, fills them into
`com.localfitness.brief.plist.template`, writes the rendered plist to
`~/Library/LaunchAgents/com.localfitness.brief.plist`, and loads it. It
runs `fitness brief` daily at **06:30**. If the Mac is asleep at 06:30,
launchd runs the missed job once at the next wake.

## Credentials

The job needs `CLAUDE_CODE_OAUTH_TOKEN` (your Claude Max subscription — no
per-token API billing). The CLI auto-loads `.env` from the repo root via
`load_dotenv()`, so put the token in `<repo>/.env` (gitignored). It is
**not** stored in the plist. The scheduled run talks to the MCP in-process,
so it needs neither `LOCAL_FITNESS_API_TOKEN` nor an allowed-host entry.

## Verify / manage

```bash
launchctl start com.localfitness.brief   # run once now
tail -f logs/brief.launchd.err.log       # watch output
./ops/uninstall-launchd.sh               # remove the job
```

Success looks like a fresh `briefings/<today>.json` and a non-error exit in
the logs.

## Linux

No launchd. Schedule `uv run fitness brief` with cron or a systemd timer,
ensuring `CLAUDE_CODE_OAUTH_TOKEN` is in `<repo>/.env`.
