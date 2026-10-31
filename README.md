# Arcus — Goal Planner & Progress Tracker

## Overview
- **Name:** Arcus (after the arcus / shelf cloud — the long, low, wedge-shaped cloud that rolls in ahead of a storm front).
- **Purpose:** A local-first, zero-backend planner for big goals. Set a high-level goal (e.g. *Pay off all credit card debt*), break it into **prioritized subgoals** (e.g. *the $7,500 card whose 0% promo ends in 2 months*), log progress, and always know what to focus on next.
- **Sister apps:** Shares the sky/cloud design language, settings, and encrypted cloud sync of Cumulus, Nimbus, Cirrus, Stratus, and Anvil (frosted glass, multi-atmosphere theme, no-build vanilla HTML/CSS/JS).

## Technology & Design Philosophy
- **Stack:** Plain vanilla HTML5, CSS3, ES2015+ JavaScript. No framework, no bundler, no build step.
- **Local-first:** All data persists in `localStorage`; 100% private to the browser. JSON export/import plus optional zero-knowledge encrypted cloud sync.
- **Deploy:** Static site — open `index.html` directly (`file://`) or via GitHub Pages: https://kashikoi.github.io/Arcus/

## Concepts
- **Goal → subgoals (any depth).** Subgoals are ordered by priority (drag the number badge or use ▲▼). The top *active* subgoal is the **Focus now** item; finishing it promotes the next one.
- **Progress types**
  - **A number** — start → target (counts up *or* down). e.g. card balance $7,500 → $0, savings $0 → $10,000.
  - **Sum of subgoals** — rolls up the numbers of its children (e.g. total debt across all cards).
  - **Steps / subgoals done** — milestone progress from the action-plan checklist and finished subgoals.
- **Log progress** — "Paid down / Added" an amount, or "Set new value". Reaching the target auto-completes the goal (and a roll-up parent when its total hits target).
- **Insights** — required pace to hit the target date (per month / week), projected finish date from your last 90 days of entries, and whether you're on track.
- **Action plan** — per-goal checklist of how you'll get there. **Why / how** notes for context.
- **Overview** — "Focus right now" list (the deepest focus item of every active goal) plus goal cards.

## Data Model (localStorage)
- `arcus_cloud_goals` — `{ goals: [...] }`
  - **goal:** `{ id, parentId|null, title, icon, kind: "amount"|"rollup"|"milestone", unit, start, current, target, dueDate, notes, status: "active"|"paused"|"done", order, steps[{id,text,done}], entries[{id,date,delta,value,note}], createdAt, updatedAt, completedAt }`
- `arcus_cloud_theme` — `"day"` (default) | `"twilight"` | `"night"` | `"random"`.
- `arcus_cloud_filter` — rail filter (`active` | `done` | `all`).
- `arcus_cloud_phrase` — opt-in remembered cloud recovery phrase.

## Settings
Atmosphere (Day / Twilight / Night / Random), Export / Import JSON, Encrypted Cloud Sync (same recovery phrase and shared backup as the other cloud apps), Randomize data (demo), Clear all data, About.

## Keyboard
`N` new goal · `L` log progress on the open goal · `⌘/Ctrl+S` save in the editor · `Esc` close dialogs.

## Files
`index.html`, `styles.css`, `app.js`, `icon.svg`, `manifest.webmanifest`, `build/` (release mirror).
