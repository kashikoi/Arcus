# Arcus — agent context / project memory

Checked-in snapshot of working context for the Arcus app. If you're an agent picking
this up in a new session, read this first.

## What this is
- A personal, local-first **goal planner / progress tracker**, part of the kashikoi
  cloud-themed app suite (Cumulus, Nimbus, Cirrus, Stratus, Anvil). Repo:
  github.com/kashikoi/Arcus. Pages: https://kashikoi.github.io/Arcus/ (served from `main` /).
- Named after the arcus (shelf cloud). Scenic background is an inline SVG of a shelf cloud
  over a suburban neighborhood (based on a user photo); Day is the default atmosphere.
- Plain vanilla HTML/CSS/JS, no build step, no backend.

## Architecture & conventions
- `app.js` is one IIFE; element refs cached in `el` via `cacheEls()`. Rendering is
  string-template `innerHTML` with `escapeHtml()` on every user string; clicks are handled by
  delegation on `#canvas` / `#goalList` via `data-*` attributes (`data-open`, `data-log`,
  `data-move`, `data-toggle-done`, `data-action`, ...).
- Goals are a flat array with `parentId`; siblings sorted by `order` (priority). `renumber()`
  after reparent/delete. `sanitizeGoals()` drops dangling parents and breaks cycles.
- `metrics(g)` is the single source of progress math: `amount` uses start/current/target
  (direction inferred: target < start => counting down); `rollup` sums numeric children of the
  first child's unit; `milestone` averages child pct + step completion.
- `focusChild()` = first child with `status === "active"`; `focusLeaf()` follows that chain.
- Logging pushes `{date, delta, value, note}` to the goal's `entries` and updates `current`.
  Deleting an entry subtracts its delta (undo). Reaching target auto-marks done and cascades
  to roll-up ancestors whose totals hit target.
- `paceFor()` uses the last 90 days of entries (min 30-day window) for projections.
- `[hidden] { display:none !important }` is required (modals use `display:flex`).
- The "beacon" CSS token name is kept for suite parity but is emerald/green in Arcus.

## Cloud sync (shared with the suite)
- Same worker (`nimbus-sync.nimbus-sync.workers.dev`), same PBKDF2(600k)/AES-GCM envelope,
  same `kashikoi-cloud-sync-v1:` key derivation and 16-word phrase as Anvil/Cirrus/etc.
- The worker only accepts `app: "Nimbus" | "Cumulus"`, so the envelope is tagged `Nimbus`
  with `writtenBy: "Arcus"`. Data lives at `apps.arcus` inside the unified
  `kashikoi-app-backup-v1` blob; saving always merges and preserves other apps' slices.

## Release flow
Same as the other cloud apps: work on `develop` → bump `APP_VERSION` in app.js and every
`?v=` string + About version in index.html → `cp app.js index.html styles.css icon.svg
manifest.webmanifest build/` → commit "Release Arcus <version>" → push `develop` →
`git checkout main && git merge develop -m "Merge develop for Arcus <version>"` → push
`main` → switch back to `develop`.
