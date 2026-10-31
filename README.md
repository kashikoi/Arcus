# Arcus — Personal Goal Execution Platform

**Define an objective. Break it down. Prioritize what matters. Execute. Measure progress. Achieve the objective.**

Arcus turns ambitious, high-level goals into structured, measurable plans. It is domain-agnostic — paying off
debt, building an emergency fund, restoring a car, launching a product, or a fitness objective all run on the
same hierarchical goal engine.

- **Live:** https://kashikoi.github.io/Arcus/
- **Name:** after the arcus (shelf cloud) — the long, low cloud that rolls in ahead of a storm front.
- **Suite:** shares the sky/glass design language, settings and encrypted cloud sync of Cumulus, Nimbus, Cirrus, Stratus and Anvil.

## Using it

| View | What it answers |
|---|---|
| **Dashboard** | What am I trying to accomplish? How much progress? What's next? What's at risk? What did I accomplish recently? |
| **Focus** | What should I work on right now? Ranked recommendations with transparent reasons, overdue actions, upcoming milestones, blocked goals. Pin your own focus any time. |
| **Goals** | Explorer: tree (expand/collapse) or list, search, filter by status/priority, sort. Archived goals live here too. |
| **Goal detail** | The workspace for one objective: progress instrument, schedule & projections, debt payoff estimates, subordinate goals (priority order, drag to reorder), milestones, actions, progress history (with chart), dependencies. |

Keyboard: `N` new goal · `R` record progress (on a goal) · `/` search goals · `D` / `F` / `G` switch views · `Esc` close dialogs.

## Concepts

- **Goal** — the primary unit. Goals nest without a depth limit. Each has a **measurement type**:
  Currency, Number, Percentage, Custom unit (all numeric: start → target, increasing *or* decreasing),
  Milestones (completed milestones, optionally weighted; falls back to completed subgoals), or Done / not done.
- **Total from subgoals** — a numeric goal can roll up compatible subgoals (same measurement, unit/currency and
  direction). Incompatible subgoals are listed as *not in total* — values are never silently mixed. A parent
  baseline that differs from the subgoal total is applied as a baseline, not as phantom progress.
- **Milestones** — checkpoints. Give one a progress threshold (e.g. *Pay down $1,500*) and it completes
  automatically when progress crosses it.
- **Actions** — concrete activities that advance a goal, optionally tied to a milestone, with priority, due date and effort.
- **Progress entries** — an immutable history (previous → new, change, notes, type). Mistakes are fixed by adding a
  *correction* that reverses an entry; the original is kept.
- **Dependencies** — explicit prerequisites between separate goals (not parent/child). Blocked goals are surfaced, not ranked.
- **Priority vs. urgency** — priority (Critical/High/Medium/Low) is yours; urgency comes from dates (target date,
  promo expiry). Recommendations add up simple, visible rules (priority, deadline proximity, promo expiry,
  deferred interest, high APR, behind pace) — every point is shown.
- **Debt payoff (optional)** — for currency goals: APR, promo APR & expiry, statement day, "promo ends before
  statement", deferred interest, minimum payment. Arcus estimates the monthly payment needed before the promo ends,
  the payment to hit the target date, and the cost of paying only the minimum. All clearly labeled as estimates.

Color is used for meaning only: green = complete / positive progress, amber = approaching deadline / caution,
red = overdue / critical, neutral otherwise.

## Architecture

Plain vanilla HTML/CSS/JS — no framework, bundler or build step; works from `file://` or GitHub Pages.
Scripts share a single `window.Arcus` namespace and are loaded in dependency order:

| File | Layer | Responsibility |
|---|---|---|
| `js/util.js` | utilities | dates, number/currency formatting, escaping |
| `js/model.js` | domain model | entity shapes & enums, normalization/validation of stored data, v1 → v2 migration |
| `js/progress.js` | progress engine | the **only** place progress is calculated (numeric, roll-up, milestones, binary, portfolio) |
| `js/insights.js` | intelligence | urgency, transparent priority rules, recommendations, pace/projection, debt estimates, deadlines, risk, activity |
| `js/store.js` | application services + persistence | every mutation (validated), immutable history, completion cascade, localStorage |
| `js/sync.js` | backup | unified Kashikoi backup + zero-knowledge encrypted cloud sync |
| `js/demo.js` | sample data | Settings → Randomize data |
| `js/views.js` | UI | pure render functions (state in, HTML out) — no calculations |
| `js/app.js` | UI controller | routing, forms, dialogs, events, settings |

### Data (localStorage)
- `arcus_cloud_goals` — `{ schemaVersion: 2, goals[], milestones[], actions[], entries[], dependencies[], focusGoalId }`.
  Data from the first release (v1) is migrated automatically on load.
- `arcus_cloud_theme` — `day` (default) | `twilight` | `night` | `random`.
- `arcus_cloud_phrase` — opt-in remembered cloud recovery phrase.

## Tests
```
node --test tests/*.test.js
```
Covers the progress math (increasing/decreasing, zero, overshoot, invalid configs), roll-up compatibility,
milestone/binary measurement, validation & dependency rules, finance helpers, v1 migration, and the full
acceptance flow (debt-free goal → four cards → promo → milestones → actions → payments → parent progress →
history → focus → completion cascade).
