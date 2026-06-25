# 2026-06-25 — Black screen at fitness.home.local: react/react-dom version drift

## Symptom

The app at `https://fitness.home.local` loaded a black screen. Container was
up and healthy, `/health` returned `{"status":"ok"}`, the SPA shell and
`/assets/*.js|.css` all served 200. So: backend fine, shell fine, but React
mounted nothing — leaving the dark `bg-bg` body showing through an empty
`#root`.

## Diagnosis

`tsc -b` + `vite build` compile and bundle the SPA but never *execute* it, so
a runtime-only failure sails through CI green and ships. To see the actual
failure I drove headless Chrome over CDP (Node 25 has a built-in `WebSocket`),
trapped `window.onerror` via `Page.addScriptToEvaluateOnNewDocument`, and
navigated the live URL. Captured:

```
Minified React error #527; args[]=19.2.6 & args[]=19.2.5
```

React error #527 is the version-mismatch guard: `react` and `react-dom` must
be byte-identical in React 19. The lockfile confirmed `react@19.2.6` against
`react-dom@19.2.5`. Dependabot PR #15 ("Bump react and @types/react") had
bumped `react` and its types but not `react-dom`, and the later combined-bump
commit didn't realign them.

## Fix

Pinned both to `^19.2.7` (latest patch) so they resolve to the same version.
First attempt (`react-dom ^19.2.6`) floated react-dom up to 19.2.7 while react
stayed at 19.2.6 — same mismatch reversed, and pnpm flagged the unmet peer.
Matching both specifiers to `^19.2.7` resolves both to 19.2.7 cleanly.

Rebuilt the container (`docker compose up -d --build local-fitness` from the
traefik repo) and re-ran the CDP probe with cache disabled: `#root` now holds
rendered DOM and the only console line is the expected `401` on
`/api/auth/verify` (headless browser has no token → auth gate, working as
designed).

## Takeaway

CI's blind spot, restated from CLAUDE.md: there are no frontend unit tests, so
a green `validate` proves type-check + build, not that the app *runs*. A
react/react-dom drift is exactly the class of bug that passes build and dies
at mount. Worth a lightweight smoke check (mount the built bundle headless,
assert `#root` is non-empty) before trusting a frontend-dep bump. Dependabot
bumping `react` without `react-dom` in the same PR is the upstream trap to
watch for.
