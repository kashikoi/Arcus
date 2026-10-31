# Arcus — agent context / project memory

Checked-in snapshot of working context for Arcus. If you're an agent picking this up, read this first.

## What this is
- A personal **goal execution platform** (not a task manager), part of the kashikoi cloud-themed suite
  (Cumulus, Nimbus, Cirrus, Stratus, Anvil). Repo: github.com/kashikoi/Arcus. Pages: https://kashikoi.github.io/Arcus/
  (served from `main` /). Product direction: objectives over tasks, hierarchical decomposition, measurable
  progress, transparent prioritization, continuous feedback.
- Background is an inline SVG of an arcus (shelf cloud) over a suburban neighborhood; Day is the default theme.
- Vanilla HTML/CSS/JS, no build step, no backend, no external JS dependencies.

## Architecture rules (keep these)
- Layered scripts on `window.Arcus` (see README table): util → model → progress → insights → store → sync → demo → views → app.
  Load order in index.html matters. No ES modules (they don't load from `file://`).
- **All progress math lives in `js/progress.js`** (`createEngine(db).measure(id)`); insights in `js/insights.js`.
  Views must not calculate — they format engine output.
- **All mutations go through `js/store.js`**, which validates (throws `ValidationError` with a user-facing message),
  commits (persist + rebuild engine) and returns cascade results `{completed, reopened, milestonesReached, milestonesReopened}`.
- Progress history is immutable: never edit/delete entries; `correctEntry` appends a reversing `correction`.
  Manual edits of `currentValue` in the goal form are recorded as `adjustment` entries.
- Roll-ups (`goal.rollup`) only include children with the same measurement type, unit/currency and direction;
  parent current = parent start + Σ(child current − child start). Never average unrelated measures
  (`engine.portfolio` groups by measure+unit+direction).
- Milestones with `targetValue` (progress amount from start) auto-complete/auto-reopen (`auto` flag); manual ones don't.
- Goals reaching their numeric target auto-complete (`completedAutomatically`), cascade to roll-up ancestors, and
  auto-reopen if a correction drops them below target.
- Priority score = additive rules in `insights.priorityOf` with visible reasons; recommendations rank *actionable*
  goals (active, all ancestors active, no active children), blocked ones listed separately. `db.focusGoalId` = pinned focus.
- Color semantics: `--ok` green (complete/positive), `--warn` amber, `--bad` red, neutral otherwise. `--accent` is
  for interaction/focus only. Keep the restrained look (hairlines over cards, no gamification).
- `[hidden] { display:none !important }` is required. Dialogs stack via z-index set in `openModal`.

## Data
- localStorage `arcus_cloud_goals`: schema v2 `{ schemaVersion, goals, milestones, actions, entries, dependencies, focusGoalId }`.
  `model.normalizeDb` sanitizes everything (dangling refs, cycles, duplicates) and migrates v1 (`goals[].kind/steps/entries`).
- Cloud sync: shared worker `nimbus-sync.nimbus-sync.workers.dev`, PBKDF2(600k)/AES-GCM, envelope tagged
  `app: "Nimbus"` (worker allow-list) with `writtenBy: "Arcus"`; data at `apps.arcus` in the unified
  `kashikoi-app-backup-v1` blob; saves merge and preserve sibling apps' slices.

## Testing
- `node --test tests/*.test.js` (engine/service tests incl. the 13-step acceptance flow). Run before every release.
- UI verified with headless Chrome + playwright-core (not checked in).

## Release flow
Work on `develop` → bump `APP_VERSION` in `js/app.js` and every `?v=` in index.html → run tests →
`rm -rf build && mkdir build && cp -R index.html styles.css icon.svg manifest.webmanifest js build/` →
commit "Release Arcus <version>: <summary>" → push `develop` → `git checkout main && git merge develop -m "Merge develop for Arcus <version>"`
→ push `main` → back to `develop`.
