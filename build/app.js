/* ============================================================
   ARCUS — Goal planner & progress tracker
   Goal -> prioritized subgoals (any depth) -> logged progress
   Zero backend. All state in localStorage.
   ============================================================ */
(function () {
  "use strict";

  const STORE_KEY = "arcus_cloud_goals";
  const THEME_KEY = "arcus_cloud_theme";
  const ACTIVE_THEME_KEY = "arcus_cloud_active_theme"; // sessionStorage, resolved random pick
  const FILTER_KEY = "arcus_cloud_filter";
  const REMEMBER_CLOUD_PHRASE_KEY = "arcus_cloud_phrase"; // localStorage, opt-in remembered phrase

  const APP_VERSION = "2026.10.31.1";
  const THEMES = ["day", "twilight", "night"];
  const DEFAULT_THEME = "day";
  const KINDS = ["amount", "rollup", "milestone"];
  const STATUSES = ["active", "paused", "done"];
  const DAY_MS = 86400000;

  // ---------- Cloud sync / unified backup (shared Kashikoi suite worker) ----------
  const CLOUD_SYNC_ENDPOINT = "https://nimbus-sync.nimbus-sync.workers.dev";
  const CLOUD_SYNC_FORMAT = "kashikoi-encrypted-backup-v1";
  const LEGACY_CLOUD_SYNC_FORMAT = "nimbus-encrypted-backup-v1";
  const UNIFIED_BACKUP_SCHEMA = "kashikoi-app-backup-v1";
  // The shared sync Worker only accepts envelopes tagged "Nimbus"/"Cumulus"; since every app
  // reads/writes the same blob, Arcus tags it "Nimbus" so the PUT validates and the other apps
  // can still decrypt it. The honest author is recorded separately in `writtenBy`.
  const CLOUD_ENVELOPE_APP = "Nimbus";
  const ACCEPTED_ENVELOPE_APPS = new Set(["Nimbus", "Cumulus", "Cirrus", "Stratus", "Anvil", "Arcus"]);
  const RECOVERY_PHRASE_WORD_COUNT = 16;
  const CLOUD_KDF_ITERATIONS = 600000;
  const RECOVERY_WORDS = [
    "anchor", "apricot", "arbor", "aurora", "basalt", "beacon", "birch", "bison",
    "blossom", "boulder", "breeze", "canyon", "cedar", "cinder", "cirrus", "clay",
    "clover", "cobalt", "comet", "coral", "cove", "crater", "crystal", "cumulus",
    "current", "dawn", "delta", "dune", "ember", "evergreen", "fathom", "fern",
    "fjord", "flint", "forge", "fossil", "galaxy", "garnet", "geyser", "glacier",
    "granite", "grove", "harbor", "hazel", "heather", "horizon", "ivory", "jade",
    "juniper", "kelp", "lagoon", "lantern", "lichen", "lilac", "lumen", "magma",
    "maple", "marble", "meadow", "meridian", "mesa", "mica", "mist", "monsoon",
    "moss", "nebula", "nectar", "oasis", "obsidian", "ocean", "onyx", "opal",
    "orchard", "pebble", "petal", "pine", "pollen", "prairie", "quartz", "quill",
    "rapids", "ravine", "reef", "ridge", "ripple", "river", "sable", "saffron",
    "sage", "sandbar", "sapphire", "savanna", "sequoia", "shale", "shore", "sierra",
    "slate", "solstice", "spruce", "storm", "summit", "tempest", "thicket", "thunder",
    "tide", "timber", "topaz", "trellis", "tundra", "valley", "vapor", "verdant",
    "vertex", "vista", "willow", "wisp", "zenith", "zephyr",
  ];

  // ---------- In-memory state ----------
  let db = { goals: [] };
  let selectedId = null;      // null => dashboard
  let railFilter = "active";  // active | done | all
  let editingId = null;       // goal being edited (null => new)
  let editorKind = "amount";
  let logMode = "change";
  let dragId = null;
  const el = {};

  // ---------- Utilities ----------
  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function num(v, fallback) {
    const n = typeof v === "number" ? v : parseFloat(v);
    return Number.isFinite(n) ? n : (fallback === undefined ? 0 : fallback);
  }
  function clamp01(n) { return Math.max(0, Math.min(1, n)); }
  function todayISO() {
    const d = new Date();
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  }
  function isoOffset(days) {
    const d = new Date(Date.now() + days * DAY_MS);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  }
  function parseDate(iso) {
    if (!iso) return null;
    const [y, m, d] = String(iso).slice(0, 10).split("-").map(Number);
    if (!y || !m || !d) return null;
    return new Date(y, m - 1, d);
  }
  function daysUntil(iso) {
    const d = parseDate(iso);
    if (!d) return null;
    const t = new Date();
    const today = new Date(t.getFullYear(), t.getMonth(), t.getDate());
    return Math.round((d - today) / DAY_MS);
  }
  function fmtDate(iso, opts) {
    const d = parseDate(iso);
    if (!d) return "";
    return d.toLocaleDateString(undefined, opts || { month: "short", day: "numeric", year: "numeric" });
  }
  function fmtShortDate(iso) {
    return fmtDate(iso, { month: "short", day: "numeric" });
  }
  function fmtValue(v, unit, opts) {
    const n = num(v);
    const abs = Math.abs(n);
    const decimals = Number.isInteger(n) ? 0 : (abs >= 100 ? 0 : 2);
    const body = abs.toLocaleString(undefined, { minimumFractionDigits: unit === "$" ? decimals : 0, maximumFractionDigits: decimals });
    const sign = n < 0 ? "-" : (opts && opts.signed && n > 0 ? "+" : "");
    if (unit === "$") return sign + "$" + body;
    if (unit === "%") return sign + body + "%";
    return sign + body + (unit ? " " + unit : "");
  }
  function plural(n, word) { return n + " " + word + (n === 1 ? "" : "s"); }
  function humanDays(days) {
    if (days <= 0) return "today";
    if (days < 14) return plural(days, "day");
    if (days < 70) return plural(Math.round(days / 7), "week");
    if (days < 730) return plural(Math.round(days / 30.44), "month");
    return (days / 365.25).toFixed(1) + " years";
  }
  function toast(msg) {
    if (!el.toast) return;
    el.toast.textContent = msg;
    el.toast.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { el.toast.hidden = true; }, 2600);
  }

  // ---------- Persistence ----------
  function normalizeGoal(g, i) {
    const o = g && typeof g === "object" ? g : {};
    const kind = KINDS.includes(o.kind) ? o.kind : "amount";
    const now = new Date().toISOString();
    return {
      id: typeof o.id === "string" && o.id ? o.id : uid(),
      parentId: typeof o.parentId === "string" && o.parentId ? o.parentId : null,
      title: String(o.title || "Untitled goal").slice(0, 200),
      icon: String(o.icon || "🎯").slice(0, 8),
      kind,
      unit: typeof o.unit === "string" ? o.unit.slice(0, 12) : "$",
      start: num(o.start),
      current: num(o.current, num(o.start)),
      target: num(o.target),
      dueDate: typeof o.dueDate === "string" ? o.dueDate.slice(0, 10) : "",
      notes: String(o.notes || ""),
      status: STATUSES.includes(o.status) ? o.status : "active",
      order: num(o.order, i || 0),
      steps: Array.isArray(o.steps)
        ? o.steps.filter((s) => s && typeof s.text === "string").map((s) => ({ id: s.id || uid(), text: s.text, done: !!s.done }))
        : [],
      entries: Array.isArray(o.entries)
        ? o.entries.filter((e) => e && typeof e === "object").map((e) => ({
            id: e.id || uid(),
            date: typeof e.date === "string" ? e.date.slice(0, 10) : todayISO(),
            delta: num(e.delta),
            value: num(e.value),
            note: String(e.note || ""),
          }))
        : [],
      createdAt: o.createdAt || now,
      updatedAt: o.updatedAt || now,
      completedAt: o.completedAt || null,
    };
  }

  function sanitizeGoals(list) {
    const goals = (Array.isArray(list) ? list : []).map(normalizeGoal);
    const ids = new Set(goals.map((g) => g.id));
    goals.forEach((g) => {
      if (g.parentId && (!ids.has(g.parentId) || g.parentId === g.id)) g.parentId = null;
    });
    // Break any accidental parent cycles.
    goals.forEach((g) => {
      const seen = new Set([g.id]);
      let p = g.parentId;
      while (p) {
        if (seen.has(p)) { g.parentId = null; break; }
        seen.add(p);
        const parent = goals.find((x) => x.id === p);
        p = parent ? parent.parentId : null;
      }
    });
    return goals;
  }

  function load() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
      db = { goals: sanitizeGoals(raw && raw.goals) };
    } catch (e) {
      db = { goals: [] };
    }
    const f = localStorage.getItem(FILTER_KEY);
    if (f === "active" || f === "done" || f === "all") railFilter = f;
  }
  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(db));
    } catch (e) {
      toast("Couldn't save — browser storage may be full.");
    }
  }

  // ---------- Goal tree helpers ----------
  function goalById(id) { return db.goals.find((g) => g.id === id) || null; }
  function childrenOf(id) {
    return db.goals.filter((g) => g.parentId === id).sort((a, b) => a.order - b.order);
  }
  function descendantsOf(id) {
    const out = [];
    (function walk(pid) {
      childrenOf(pid).forEach((c) => { out.push(c); walk(c.id); });
    })(id);
    return out;
  }
  function pathTo(id) {
    const out = [];
    let g = goalById(id);
    while (g) { out.unshift(g); g = g.parentId ? goalById(g.parentId) : null; }
    return out;
  }
  function rootOf(id) { const p = pathTo(id); return p[0] || null; }
  function isOpen(g) { return g.status !== "done"; }
  function nextOrder(parentId) {
    const sibs = childrenOf(parentId);
    return sibs.length ? Math.max.apply(null, sibs.map((s) => s.order)) + 1 : 0;
  }
  function renumber(parentId) {
    childrenOf(parentId).forEach((g, i) => { g.order = i; });
  }
  function touch(g) { g.updatedAt = new Date().toISOString(); }

  // Highest-priority open child (active first, then paused) — "what to work on now".
  function focusChild(g) {
    const kids = childrenOf(g.id);
    return kids.find((k) => k.status === "active") || null;
  }
  // Follow the focus chain to the deepest actionable goal.
  function focusLeaf(g) {
    let cur = g;
    let next = focusChild(cur);
    while (next) { cur = next; next = focusChild(cur); }
    return cur === g ? null : cur;
  }

  // ---------- Progress math ----------
  // Returns { numeric, start, current, target, unit, pct, remaining, decreasing }
  function metrics(g, seen) {
    seen = seen || new Set();
    if (seen.has(g.id)) return { numeric: false, pct: 0 };
    seen.add(g.id);

    if (g.kind === "amount") {
      return numericMetrics(g.start, g.current, g.target, g.unit, g.status);
    }
    const kids = childrenOf(g.id);
    if (g.kind === "rollup") {
      const nums = kids.map((k) => ({ k, m: metrics(k, seen) })).filter((x) => x.m.numeric);
      if (nums.length) {
        const unit = nums[0].m.unit;
        const same = nums.filter((x) => x.m.unit === unit);
        const s = same.reduce((a, x) => a + x.m.start, 0);
        const c = same.reduce((a, x) => a + x.m.current, 0);
        const t = same.reduce((a, x) => a + x.m.target, 0);
        const m = numericMetrics(s, c, t, unit, g.status);
        m.rollupCount = same.length;
        return m;
      }
    }
    // milestone (or rollup without numeric children)
    let pct;
    if (g.status === "done") pct = 1;
    else if (kids.length) {
      const parts = kids.map((k) => metrics(k, seen).pct);
      const stepPart = g.steps.length ? [g.steps.filter((s) => s.done).length / g.steps.length] : [];
      const all = parts.concat(stepPart);
      pct = all.reduce((a, b) => a + b, 0) / all.length;
    } else if (g.steps.length) pct = g.steps.filter((s) => s.done).length / g.steps.length;
    else pct = 0;
    return { numeric: false, pct: clamp01(pct), doneKids: kids.filter((k) => k.status === "done").length, totalKids: kids.length };
  }

  function numericMetrics(start, current, target, unit, status) {
    const span = target - start;
    let pct;
    if (span === 0) pct = (status === "done" || current === target) ? 1 : 0;
    else pct = clamp01((current - start) / span);
    const decreasing = target < start;
    const remaining = Math.max(0, decreasing ? current - target : target - current);
    return { numeric: true, start, current, target, unit, pct, remaining, decreasing, progressed: Math.abs(current - start) };
  }

  function reached(g) {
    if (g.kind !== "amount") return false;
    return g.target < g.start ? g.current <= g.target : g.current >= g.target;
  }

  // Every logged entry for a goal and its descendants (newest first).
  function entriesFor(g) {
    const goals = [g].concat(descendantsOf(g.id));
    const out = [];
    goals.forEach((x) => x.entries.forEach((e) => out.push({ goal: x, entry: e })));
    out.sort((a, b) => (b.entry.date.localeCompare(a.entry.date)) || 0);
    return out;
  }

  // Progress per day in the "good" direction, based on the last 90 days of entries.
  function paceFor(g) {
    const m = metrics(g);
    if (!m.numeric) return null;
    const cutoff = isoOffset(-90);
    const recent = entriesFor(g).filter((x) => x.entry.date >= cutoff && x.goal.unit === m.unit);
    if (recent.length < 2 && !(recent.length === 1 && recent[0].entry.date < isoOffset(-6))) return null;
    const sign = m.decreasing ? -1 : 1;
    const gained = recent.reduce((a, x) => a + sign * x.entry.delta, 0);
    const oldest = recent[recent.length - 1].entry.date;
    const spanDays = Math.max(30, -daysUntil(oldest));
    const perDay = gained / spanDays;
    return perDay > 0 ? { perDay, perMonth: perDay * 30.44 } : { perDay: 0, perMonth: 0 };
  }

  // ---------- Demo data ----------
  function demoData() {
    const d = (n) => isoOffset(n);
    const goals = [];
    const add = (o) => { const g = normalizeGoal(o, goals.length); goals.push(g); return g; };

    const debt = add({ title: "Pay off all credit card debt", icon: "💳", kind: "rollup", unit: "$", dueDate: d(900),
      notes: "Avalanche-ish: clear the 0% card before the promo ends, then highest APR first. Minimums on everything else.",
      steps: [
        { text: "List every card with balance, APR and promo end date", done: true },
        { text: "Set up autopay for all minimums", done: true },
        { text: "Freeze cards in a drawer — no new charges", done: false },
        { text: "Redirect every raise / bonus to the focus card", done: false },
      ] });
    const card = (title, start, current, due, notes, entries, order) => add({ parentId: debt.id, title, icon: "💳", kind: "amount", unit: "$",
      start, current, target: 0, dueDate: due, notes, entries, order });
    card("Chase Freedom — 0% promo ends soon", 7500, 5200, d(62),
      "0% APR ends in ~2 months, then 26.99%. Must be $0 before the promo ends.",
      [
        { date: d(-58), delta: -800, value: 6700, note: "Payment" },
        { date: d(-28), delta: -750, value: 5950, note: "Payment" },
        { date: d(-3), delta: -750, value: 5200, note: "Payment + side gig cash" },
      ], 0);
    card("Capital One Quicksilver (24.9%)", 18200, 17650, "", "Highest APR after the promo card — next in line.",
      [{ date: d(-40), delta: -275, value: 17925, note: "Minimum" }, { date: d(-10), delta: -275, value: 17650, note: "Minimum" }], 1);
    card("Amex Blue Cash (21.2%)", 12300, 12010, "", "Minimums only for now.",
      [{ date: d(-20), delta: -290, value: 12010, note: "Minimum" }], 2);
    card("Discover It (18.4%)", 27000, 26600, "", "Lowest APR — last to attack.",
      [{ date: d(-15), delta: -400, value: 26600, note: "Minimum" }], 3);

    const ef = add({ title: "Build a $10k emergency fund", icon: "🛟", kind: "amount", unit: "$", start: 0, current: 2400, target: 10000,
      dueDate: d(400), notes: "High-yield savings. Small but steady while the debt gets paid.",
      entries: [
        { date: d(-75), delta: 800, value: 800, note: "Opened HYSA" },
        { date: d(-45), delta: 800, value: 1600, note: "Auto-transfer" },
        { date: d(-15), delta: 800, value: 2400, note: "Auto-transfer" },
      ] });

    const half = add({ title: "Run a half marathon", icon: "🏃", kind: "milestone", dueDate: d(150),
      notes: "Spring race. Build base mileage first, then the long-run block.",
      steps: [
        { text: "Pick a race and register", done: true },
        { text: "Buy proper running shoes", done: true },
        { text: "Follow a 12-week plan", done: false },
      ] });
    add({ parentId: half.id, title: "Weekly mileage up to 25 mi", icon: "📈", kind: "amount", unit: "mi", start: 8, current: 14, target: 25, order: 0,
      entries: [{ date: d(-30), delta: 3, value: 11, note: "" }, { date: d(-9), delta: 3, value: 14, note: "" }] });
    add({ parentId: half.id, title: "Long run of 10 miles", icon: "🏁", kind: "amount", unit: "mi", start: 3, current: 6, target: 10, order: 1 });
    add({ parentId: half.id, title: "Sign up for a 10K tune-up race", icon: "🎟️", kind: "milestone", status: "done", order: 2, completedAt: d(-12) });

    return { goals: sanitizeGoals(goals), focusId: debt.id, efId: ef.id };
  }

  // ---------- Rendering helpers ----------
  function barHtml(pct, size, g) {
    const cls = ["bar"];
    if (size) cls.push("bar--" + size);
    if (g && g.status === "done") cls.push("is-done");
    if (g && g.status === "paused") cls.push("is-paused");
    return `<div class="${cls.join(" ")}" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(pct * 100)}"><div class="bar__fill" style="width:${(pct * 100).toFixed(1)}%"></div></div>`;
  }
  function pctText(pct) { return Math.floor(pct * 100) + "%"; }
  function statusPill(g) {
    if (g.status === "done") return `<span class="pill pill--done">✓ Done</span>`;
    if (g.status === "paused") return `<span class="pill pill--paused">⏸ Paused</span>`;
    return `<span class="pill pill--active">● Active</span>`;
  }
  function duePill(g) {
    if (!g.dueDate || g.status === "done") return "";
    const n = daysUntil(g.dueDate);
    if (n === null) return "";
    if (n < 0) return `<span class="pill pill--overdue">⚠ ${plural(-n, "day")} past target date</span>`;
    const cls = n <= 30 ? "pill--overdue" : n <= 90 ? "pill--warn" : "";
    return `<span class="pill ${cls}">📅 ${fmtShortDate(g.dueDate)} · ${n === 0 ? "today" : humanDays(n) + " left"}</span>`;
  }
  function shortMeta(g, m) {
    if (g.status === "done") return "Completed" + (g.completedAt ? " " + fmtShortDate(g.completedAt) : "");
    if (m.numeric) return fmtValue(m.remaining, m.unit) + " to go";
    if (m.totalKids) return `${m.doneKids}/${m.totalKids} subgoals done`;
    if (g.steps.length) return `${g.steps.filter((s) => s.done).length}/${g.steps.length} steps done`;
    return "Milestone";
  }

  function renderAll() {
    renderRail();
    renderCrumb();
    renderCanvas();
  }

  // ---------- Rail ----------
  function renderRail() {
    const roots = childrenOf(null);
    const active = roots.filter((g) => g.status !== "done");
    const done = db.goals.filter((g) => g.status === "done").length;
    const overall = active.length ? active.reduce((a, g) => a + metrics(g).pct, 0) / active.length : 0;
    el.railSummary.innerHTML = `
      <div class="stat-mini"><span class="stat-mini__val">${active.length}</span><span class="stat-mini__lbl">Active goals</span></div>
      <div class="stat-mini"><span class="stat-mini__val">${pctText(overall)}</span><span class="stat-mini__lbl">Avg progress</span></div>
      <div class="stat-mini"><span class="stat-mini__val">${done}</span><span class="stat-mini__lbl">Completed</span></div>`;

    el.railFilter.querySelectorAll(".seg__btn").forEach((b) => b.classList.toggle("is-active", b.dataset.filter === railFilter));

    const list = roots.filter((g) => railFilter === "all" || (railFilter === "done" ? g.status === "done" : g.status !== "done"));
    const activeRoot = selectedId ? rootOf(selectedId) : null;
    if (!list.length) {
      el.goalList.innerHTML = `<li class="goal-list__empty">${roots.length ? "Nothing here." : "No goals yet. Start with something big."}</li>`;
      return;
    }
    el.goalList.innerHTML = list.map((g) => {
      const m = metrics(g);
      return `<li class="goal-card${activeRoot && activeRoot.id === g.id ? " is-active" : ""}" data-id="${g.id}" draggable="true" tabindex="0">
        <div class="goal-card__head">
          <span class="goal-card__icon">${escapeHtml(g.icon)}</span>
          <span class="goal-card__title">${escapeHtml(g.title)}</span>
          <span class="goal-card__pct">${pctText(m.pct)}</span>
        </div>
        ${barHtml(m.pct, "sm", g)}
        <div class="goal-card__meta"><span>${escapeHtml(shortMeta(g, m))}</span><span>${g.status === "paused" ? "Paused" : ""}</span></div>
      </li>`;
    }).join("");
  }

  // ---------- Breadcrumb ----------
  function renderCrumb() {
    const parts = [`<button type="button" class="crumb__item crumb__home${selectedId ? "" : " is-current"}" data-crumb="">ARCUS</button>`];
    if (selectedId) {
      const path = pathTo(selectedId);
      path.forEach((g, i) => {
        parts.push(`<span class="crumb__sep" aria-hidden="true">/</span>`);
        parts.push(`<button type="button" class="crumb__item${i === path.length - 1 ? " is-current" : ""}" data-crumb="${g.id}" title="${escapeHtml(g.title)}">${escapeHtml(g.icon)} ${escapeHtml(g.title)}</button>`);
      });
    } else {
      parts.push(`<span class="crumb__sep" aria-hidden="true">/</span><span class="crumb__item is-current">Overview</span>`);
    }
    el.crumb.innerHTML = parts.join("");
    const g = selectedId ? goalById(selectedId) : null;
    el.topLogBtn.hidden = !(g && loggableGoals(g).length);
    el.app.classList.toggle("is-viewing", !!selectedId);
  }

  // ---------- Canvas ----------
  function renderCanvas() {
    const g = selectedId ? goalById(selectedId) : null;
    if (!g) {
      selectedId = null;
      el.canvas.innerHTML = db.goals.length ? dashboardHtml() : emptyHtml();
    } else {
      el.canvas.innerHTML = goalHtml(g);
    }
  }

  function emptyHtml() {
    return `<div class="empty">
      <div class="empty__icon">🌩️</div>
      <h2 class="empty__title">What are you working toward?</h2>
      <p class="empty__text">Set a big goal &mdash; like <em>“Pay off all credit card debt”</em> &mdash; then break it into prioritized subgoals.
      Arcus always shows what to focus on next, and tracks every step of progress until it’s done.</p>
      <div class="empty__actions">
        <button type="button" class="btn btn--beacon" data-action="new-goal">+ Create your first goal</button>
        <button type="button" class="btn btn--ghost" data-action="demo">Explore a demo</button>
      </div>
    </div>`;
  }

  function dashboardHtml() {
    const roots = childrenOf(null).filter((g) => g.status !== "done");
    const focusItems = roots.map((r) => ({ root: r, leaf: focusLeaf(r) || (r.kind === "amount" ? r : null) })).filter((x) => x.leaf);
    const focusHtml = focusItems.length ? `<section>
        <h3 class="section-title">Focus right now</h3>
        <ul class="focus-list">${focusItems.map(({ root, leaf }) => {
          const m = metrics(leaf);
          const path = pathTo(leaf.id).slice(0, -1).map((p) => p.title).join(" › ");
          return `<li class="focus-list__item">
            <span class="sub__icon">${escapeHtml(leaf.icon)}</span>
            <div class="focus-list__body" data-open="${leaf.id}">
              <div class="focus-list__title">${escapeHtml(leaf.title)}</div>
              <div class="focus-list__path">${escapeHtml(path || root.title)} · ${escapeHtml(shortMeta(leaf, m))}</div>
            </div>
            ${duePill(leaf)}
            ${loggableGoals(leaf).length ? `<button type="button" class="btn btn--beacon btn--tiny" data-log="${leaf.id}">+ Log</button>` : ""}
          </li>`;
        }).join("")}</ul>
      </section>` : "";

    const cards = childrenOf(null).filter((g) => railFilter === "all" || (railFilter === "done" ? g.status === "done" : g.status !== "done"));
    return `<div class="canvas__inner">
      <div>
        <h2 class="goal-head__title">Overview</h2>
        <p class="goal-head__sub" style="color:var(--ink-faint);font-size:0.88rem">${new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</p>
      </div>
      ${focusHtml}
      <section>
        <h3 class="section-title">${railFilter === "done" ? "Completed goals" : railFilter === "all" ? "All goals" : "Active goals"}
          <button type="button" class="btn btn--ghost btn--tiny" data-action="new-goal">+ New goal</button></h3>
        ${cards.length ? `<div class="dash-grid">${cards.map((g) => {
          const m = metrics(g);
          const f = focusChild(g);
          return `<div class="dash-card" data-open="${g.id}" tabindex="0">
            <div class="dash-card__head"><span class="goal-head__icon" style="width:40px;height:40px;font-size:1.3rem">${escapeHtml(g.icon)}</span>
              <span class="dash-card__title">${escapeHtml(g.title)}</span>${statusPill(g)}</div>
            ${barHtml(m.pct, null, g)}
            <div class="dash-card__nums"><span>${pctText(m.pct)} complete</span><span>${escapeHtml(shortMeta(g, m))}</span></div>
            ${f ? `<div class="dash-card__focus">Next up: <strong>${escapeHtml(f.title)}</strong></div>` : ""}
            ${g.dueDate && g.status !== "done" ? `<div>${duePill(g)}</div>` : ""}
          </div>`;
        }).join("")}</div>` : `<p class="history__empty">No goals in this view.</p>`}
      </section>
    </div>`;
  }

  function loggableGoals(g) {
    const list = [g].concat(descendantsOf(g.id)).filter((x) => x.kind === "amount");
    return list.filter(isOpen).concat(list.filter((x) => !isOpen(x)));
  }

  function insightsHtml(g, m) {
    if (!m.numeric || g.status === "done") return "";
    const out = [];
    const unit = m.unit;
    const verb = m.decreasing ? "paid down" : "gained";
    if (m.progressed > 0) {
      out.push({ cls: "good", icon: "📉", html: m.decreasing
        ? `You’ve ${verb} <strong>${fmtValue(m.progressed, unit)}</strong> of ${fmtValue(m.start - m.target, unit)} so far.`
        : `You’ve ${verb} <strong>${fmtValue(m.progressed, unit)}</strong> of ${fmtValue(m.target - m.start, unit)} so far.` });
      if (!m.decreasing) out[0].icon = "📈";
    }
    const n = g.dueDate ? daysUntil(g.dueDate) : null;
    let needPerMonth = null;
    if (n !== null && m.remaining > 0) {
      if (n > 0) {
        needPerMonth = m.remaining / Math.max(n / 30.44, 1 / 30.44);
        const perWeek = m.remaining / Math.max(n / 7, 1 / 7);
        out.push({ cls: n <= 90 ? "warn" : "", icon: "🎯", html: `To hit the target by <strong>${fmtDate(g.dueDate)}</strong> you need about <strong>${fmtValue(Math.ceil(needPerMonth), unit)}/month</strong> (≈${fmtValue(Math.ceil(perWeek), unit)}/week).` });
      } else {
        out.push({ cls: "bad", icon: "⚠️", html: `The target date (${fmtDate(g.dueDate)}) has passed with <strong>${fmtValue(m.remaining, unit)}</strong> still to go. Pick a new date or push harder.` });
      }
    }
    const pace = paceFor(g);
    if (pace && m.remaining > 0) {
      if (pace.perDay > 0) {
        const eta = Math.ceil(m.remaining / pace.perDay);
        const etaIso = isoOffset(eta);
        let cls = "";
        let extra = "";
        if (n !== null && n > 0) {
          if (eta <= n) { cls = "good"; extra = " — <strong>on track</strong> for your target date."; }
          else { cls = "warn"; extra = ` — that’s <strong>${humanDays(eta - n)} late</strong>. Add ~${fmtValue(Math.ceil(needPerMonth - pace.perMonth), unit)}/month to catch up.`; }
        }
        out.push({ cls, icon: "⏱️", html: `At your recent pace (~${fmtValue(Math.round(pace.perMonth), unit)}/month) you’ll get there around <strong>${fmtDate(etaIso, { month: "short", year: "numeric" })}</strong> (${humanDays(eta)})${extra}` });
      } else {
        out.push({ cls: "warn", icon: "⏸️", html: `No net progress logged in the last 90 days.` });
      }
    }
    if (!out.length) return "";
    return `<div class="insights">${out.map((x) => `<div class="insight${x.cls ? " insight--" + x.cls : ""}"><span>${x.icon}</span><span>${x.html}</span></div>`).join("")}</div>`;
  }

  // Value-over-time series for numeric goals (rollups replay every descendant entry).
  function seriesFor(g, m) {
    if (!m.numeric) return [];
    let pairs;
    if (g.kind === "amount") {
      pairs = g.entries.map((e) => ({ date: e.date, delta: e.delta }));
    } else {
      pairs = entriesFor(g).filter((x) => x.goal.kind === "amount" && x.goal.unit === m.unit).map((x) => ({ date: x.entry.date, delta: x.entry.delta }));
    }
    if (!pairs.length) return [];
    pairs.sort((a, b) => a.date.localeCompare(b.date));
    const totalDelta = pairs.reduce((a, p) => a + p.delta, 0);
    let v = m.current - totalDelta;
    const first = parseDate(pairs[0].date);
    const startDate = new Date(first.getTime() - 7 * DAY_MS);
    const pts = [{ t: startDate.getTime(), v }];
    pairs.forEach((p) => { v += p.delta; pts.push({ t: parseDate(p.date).getTime(), v }); });
    return pts;
  }

  function chartHtml(g, m) {
    const pts = seriesFor(g, m);
    if (pts.length < 2) return "";
    const W = 600, H = 120, P = 8;
    const t0 = pts[0].t, t1 = Math.max(pts[pts.length - 1].t, t0 + DAY_MS);
    const vals = pts.map((p) => p.v).concat([m.target]);
    const lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    const span = hi - lo || 1;
    const x = (t) => P + ((t - t0) / (t1 - t0)) * (W - 2 * P);
    const y = (v) => P + (1 - (v - lo) / span) * (H - 2 * P);
    const line = pts.map((p, i) => (i ? "L" : "M") + x(p.t).toFixed(1) + " " + y(p.v).toFixed(1)).join(" ");
    const area = line + ` L ${x(pts[pts.length - 1].t).toFixed(1)} ${H} L ${x(t0).toFixed(1)} ${H} Z`;
    const iso = (t) => new Date(t).toISOString().slice(0, 10);
    return `<section>
      <h3 class="section-title">Trend <span style="text-transform:none;letter-spacing:0;font-weight:500">target ${fmtValue(m.target, m.unit)} (dashed)</span></h3>
      <svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
        <path class="spark__area" d="${area}" />
        <line class="spark__target" x1="0" x2="${W}" y1="${y(m.target).toFixed(1)}" y2="${y(m.target).toFixed(1)}" vector-effect="non-scaling-stroke" />
        <path class="spark__line" d="${line}" vector-effect="non-scaling-stroke" />
      </svg>
      <div class="goal-card__meta"><span>${fmtShortDate(iso(t0))} · ${fmtValue(pts[0].v, m.unit)}</span><span>${fmtShortDate(iso(pts[pts.length - 1].t))} · ${fmtValue(pts[pts.length - 1].v, m.unit)}</span></div>
    </section>`;
  }

  function subRowHtml(k, idx, total, focusId) {
    const m = metrics(k);
    const canLog = loggableGoals(k).some(isOpen);
    const kidCount = childrenOf(k.id).length;
    return `<li class="sub${k.status === "done" ? " is-done" : ""}${k.id === focusId ? " is-focus" : ""}" data-id="${k.id}" draggable="true">
      <span class="sub__rank" title="Priority ${idx + 1} — drag to reorder">${idx + 1}</span>
      <span class="sub__icon">${escapeHtml(k.icon)}</span>
      <div class="sub__body" data-open="${k.id}">
        <span class="sub__title">${escapeHtml(k.title)}</span>
        ${barHtml(m.pct, "sm", k)}
        <span class="sub__meta"><span>${pctText(m.pct)}</span><span>${escapeHtml(shortMeta(k, m))}</span>${kidCount ? `<span>${plural(kidCount, "subgoal")}</span>` : ""}${k.status === "paused" ? "<span>Paused</span>" : ""}${duePill(k)}</span>
      </div>
      <div class="sub__actions">
        <button type="button" class="mini-btn" data-move="${k.id}" data-dir="-1" title="Higher priority" ${idx === 0 ? "disabled" : ""}>▲</button>
        <button type="button" class="mini-btn" data-move="${k.id}" data-dir="1" title="Lower priority" ${idx === total - 1 ? "disabled" : ""}>▼</button>
        ${canLog ? `<button type="button" class="mini-btn mini-btn--go" data-log="${k.id}" title="Log progress">+</button>` : ""}
        <button type="button" class="mini-btn" data-toggle-done="${k.id}" title="${k.status === "done" ? "Reopen" : "Mark done"}">${k.status === "done" ? "↺" : "✓"}</button>
      </div>
    </li>`;
  }

  function goalHtml(g) {
    const m = metrics(g);
    const kids = childrenOf(g.id);
    const focus = focusChild(g);
    const entries = entriesFor(g);
    const showGoalName = g.kind !== "amount";

    let heroBig;
    if (m.numeric) {
      heroBig = `${fmtValue(m.current, m.unit)}<small>${m.decreasing ? "left of" : "of"} ${fmtValue(m.decreasing ? m.start : m.target, m.unit)}${m.decreasing && m.target ? " → " + fmtValue(m.target, m.unit) : ""}</small>`;
    } else if (m.totalKids) {
      heroBig = `${m.doneKids}<small>of ${plural(m.totalKids, "subgoal")} done</small>`;
    } else if (g.steps.length) {
      heroBig = `${g.steps.filter((s) => s.done).length}<small>of ${plural(g.steps.length, "step")} done</small>`;
    } else {
      heroBig = g.status === "done" ? "Done<small>🎉</small>" : "Milestone<small>mark it done when it’s done</small>";
    }

    const stats = m.numeric ? `<div class="stats">
        <div class="stat"><span class="stat__lbl">Start</span><span class="stat__val">${fmtValue(m.start, m.unit)}</span></div>
        <div class="stat"><span class="stat__lbl">Current</span><span class="stat__val">${fmtValue(m.current, m.unit)}</span></div>
        <div class="stat"><span class="stat__lbl">Target</span><span class="stat__val">${fmtValue(m.target, m.unit)}</span></div>
        <div class="stat"><span class="stat__lbl">Remaining</span><span class="stat__val">${fmtValue(m.remaining, m.unit)}</span></div>
      </div>` : "";

    const focusHtml = focus ? (() => {
      const fm = metrics(focus);
      return `<div class="focus">
        <div class="focus__body">
          <span class="focus__label">⚡ Focus now · priority #1 of ${kids.filter((k) => k.status === "active").length} open</span>
          <span class="focus__title" data-open="${focus.id}">${escapeHtml(focus.icon)} ${escapeHtml(focus.title)}</span>
          ${barHtml(fm.pct, "sm", focus)}
          <span class="focus__meta">${pctText(fm.pct)} · ${escapeHtml(shortMeta(focus, fm))} ${duePill(focus)}</span>
        </div>
        ${loggableGoals(focus).some(isOpen) ? `<button type="button" class="btn btn--beacon" data-log="${focus.id}">+ Log progress</button>` : ""}
      </div>`;
    })() : "";

    const subsHtml = `<section>
      <h3 class="section-title">Subgoals · in priority order
        <button type="button" class="btn btn--ghost btn--tiny" data-action="add-sub">+ Add subgoal</button></h3>
      ${kids.length ? `<ul class="sub-list" id="subList">${kids.map((k, i) => subRowHtml(k, i, kids.length, focus && focus.id)).join("")}</ul>`
        : `<p class="history__empty">Break this goal into smaller pieces. The top active subgoal becomes your focus.</p>`}
    </section>`;

    const stepsHtml = `<section>
      <h3 class="section-title">Action plan</h3>
      ${g.steps.length ? `<ul class="steps">${g.steps.map((s) => `<li class="step${s.done ? " is-done" : ""}">
          <input type="checkbox" data-step="${s.id}" ${s.done ? "checked" : ""} aria-label="Done" />
          <span class="step__text">${escapeHtml(s.text)}</span>
          <button type="button" class="mini-btn" data-del-step="${s.id}" title="Remove step">×</button>
        </li>`).join("")}</ul>` : ""}
      <form class="step-add" id="stepAddForm" autocomplete="off">
        <input class="field__input" id="stepAddInput" placeholder="Add a step — how will you get there?" maxlength="300" />
        <button type="submit" class="btn btn--ghost">Add</button>
      </form>
    </section>`;

    const notesHtml = g.notes ? `<section><h3 class="section-title">Why / how</h3><p class="notes">${escapeHtml(g.notes)}</p></section>` : "";

    const histHtml = `<section>
      <h3 class="section-title">History</h3>
      ${entries.length ? `<ul class="history">${entries.slice(0, 60).map(({ goal, entry }) => {
        const good = goal.target < goal.start ? entry.delta <= 0 : entry.delta >= 0;
        return `<li class="history__item">
          <span class="history__date">${fmtDate(entry.date)}</span>
          <span class="history__text">${showGoalName || goal.id !== g.id ? `<strong>${escapeHtml(goal.title)}</strong> · ` : ""}${escapeHtml(entry.note || "Progress")} <span style="color:var(--ink-faint)">→ ${fmtValue(entry.value, goal.unit)}</span></span>
          <span class="history__delta${good ? "" : " is-back"}">${fmtValue(entry.delta, goal.unit, { signed: true })}</span>
          <button type="button" class="mini-btn" data-del-entry="${entry.id}" data-goal="${goal.id}" title="Delete entry (reverts it)">×</button>
        </li>`;
      }).join("")}</ul>` : `<p class="history__empty">${loggableGoals(g).length ? "Nothing logged yet." : "Progress here comes from steps and subgoals."}</p>`}
    </section>`;

    return `<div class="canvas__inner">
      <div class="goal-head">
        <div class="goal-head__icon">${escapeHtml(g.icon)}</div>
        <div class="goal-head__body">
          <h2 class="goal-head__title">${escapeHtml(g.title)}</h2>
          <div class="goal-head__sub">${statusPill(g)}${duePill(g)}${g.kind === "rollup" ? `<span class="pill">Σ sum of subgoals</span>` : ""}</div>
        </div>
        <div class="goal-head__actions">
          ${loggableGoals(g).some(isOpen) ? `<button type="button" class="btn btn--beacon" data-log="${g.id}">+ Log progress</button>` : ""}
          <button type="button" class="btn btn--ghost" data-action="edit">Edit</button>
          <button type="button" class="btn btn--ghost" data-toggle-done="${g.id}">${g.status === "done" ? "Reopen" : "Mark done"}</button>
          <button type="button" class="btn btn--danger" data-action="delete">Delete</button>
        </div>
      </div>
      <div class="hero">
        <div class="hero__top"><span class="hero__big">${heroBig}</span><span class="hero__pct">${pctText(m.pct)}</span></div>
        ${barHtml(m.pct, "lg", g)}
        ${stats}
        ${insightsHtml(g, m)}
      </div>
      ${focusHtml}
      ${subsHtml}
      ${chartHtml(g, m)}
      ${stepsHtml}
      ${notesHtml}
      ${histHtml}
    </div>`;
  }

  // ---------- Navigation ----------
  function select(id) {
    selectedId = id && goalById(id) ? id : null;
    renderAll();
    el.canvas.scrollTop = 0;
  }

  // ---------- Goal editor ----------
  const KIND_HINTS = {
    amount: "Track a number from a starting value to a target — e.g. a $7,500 balance down to $0, or savings up to $10,000.",
    rollup: "Adds up the numbers of its subgoals — perfect for “all credit cards” made of one subgoal per card.",
    milestone: "Done/not done. Progress comes from checking off action-plan steps and finishing subgoals.",
  };
  const PRESET_UNITS = ["$", "%", "", "lb", "mi", "hrs"];

  function parentOptions(excludeId) {
    const banned = new Set();
    if (excludeId) { banned.add(excludeId); descendantsOf(excludeId).forEach((d) => banned.add(d.id)); }
    const out = [`<option value="">— Nothing (top-level goal) —</option>`];
    (function walk(pid, depth) {
      childrenOf(pid).forEach((g) => {
        if (banned.has(g.id)) return;
        out.push(`<option value="${g.id}">${"\u00a0\u00a0".repeat(depth * 2)}${escapeHtml(g.icon)} ${escapeHtml(g.title)}</option>`);
        walk(g.id, depth + 1);
      });
    })(null, 0);
    return out.join("");
  }

  function setEditorKind(kind) {
    editorKind = kind;
    el.fKind.querySelectorAll(".seg__btn").forEach((b) => b.classList.toggle("is-active", b.dataset.kind === kind));
    el.fKindHint.textContent = KIND_HINTS[kind];
    el.fUnitRow.hidden = kind !== "amount";
    el.fNumbersRow.hidden = kind !== "amount";
    updateDirectionHint();
  }
  function updateUnitCustom() {
    el.fUnitCustomWrap.hidden = el.fUnit.value !== "__custom";
  }
  function editorUnit() {
    return el.fUnit.value === "__custom" ? el.fUnitCustom.value.trim().slice(0, 12) : el.fUnit.value;
  }
  function updateDirectionHint() {
    if (editorKind !== "amount") { el.fDirection.textContent = ""; return; }
    const s = parseFloat(el.fStart.value), t = parseFloat(el.fTarget.value);
    if (!Number.isFinite(s) || !Number.isFinite(t) || s === t) { el.fDirection.textContent = ""; return; }
    el.fDirection.textContent = t < s ? "↓ Counting down (e.g. paying off a balance)" : "↑ Counting up (e.g. saving toward a target)";
  }

  function openEditor(id, parentId) {
    const g = id ? goalById(id) : null;
    editingId = g ? g.id : null;
    const parent = g ? (g.parentId ? goalById(g.parentId) : null) : (parentId ? goalById(parentId) : null);
    el.editorTitle.textContent = g ? "Edit goal" : parent ? "New subgoal" : "New goal";
    el.fParent.innerHTML = parentOptions(editingId);
    el.fParent.value = parent ? parent.id : "";
    el.fTitle.value = g ? g.title : "";
    el.fIcon.value = g ? g.icon : (parent ? parent.icon : "🎯");
    el.fStatus.value = g ? g.status : "active";
    const unit = g ? g.unit : (parent ? (metrics(parent).unit || parent.unit || "$") : "$");
    if (PRESET_UNITS.includes(unit)) { el.fUnit.value = unit; el.fUnitCustom.value = ""; }
    else { el.fUnit.value = "__custom"; el.fUnitCustom.value = unit; }
    updateUnitCustom();
    el.fStart.value = g && g.kind === "amount" ? g.start : "";
    el.fCurrent.value = g && g.kind === "amount" ? g.current : "";
    el.fTarget.value = g && g.kind === "amount" ? g.target : "";
    el.fDue.value = g ? g.dueDate : "";
    el.fNotes.value = g ? g.notes : "";
    setEditorKind(g ? g.kind : "amount");
    el.editorModal.hidden = false;
    setTimeout(() => el.fTitle.focus(), 30);
  }
  function closeEditor() { el.editorModal.hidden = true; }

  function saveEditor(ev) {
    if (ev) ev.preventDefault();
    const title = el.fTitle.value.trim();
    if (!title) { el.fTitle.focus(); toast("Give the goal a name."); return; }
    let g = editingId ? goalById(editingId) : null;
    const isNew = !g;
    const newParent = el.fParent.value || null;
    if (isNew) {
      g = normalizeGoal({ parentId: newParent, order: nextOrder(newParent) });
      db.goals.push(g);
    } else if (g.parentId !== newParent) {
      const oldParent = g.parentId;
      g.parentId = newParent;
      g.order = nextOrder(newParent) + 1;
      renumber(oldParent);
      renumber(newParent);
    }
    g.title = title.slice(0, 200);
    g.icon = (el.fIcon.value.trim() || "🎯").slice(0, 8);
    g.kind = editorKind;
    g.dueDate = el.fDue.value || "";
    g.notes = el.fNotes.value.trim();
    if (editorKind === "amount") {
      g.unit = editorUnit();
      const start = num(el.fStart.value, 0);
      const target = num(el.fTarget.value, 0);
      g.start = start;
      g.target = target;
      g.current = el.fCurrent.value === "" ? start : num(el.fCurrent.value, start);
    }
    const prevStatus = g.status;
    g.status = el.fStatus.value;
    if (g.status === "done" && prevStatus !== "done") g.completedAt = todayISO();
    if (g.status !== "done") g.completedAt = null;
    touch(g);
    save();
    closeEditor();
    select(g.id);
    toast(isNew ? "Goal created." : "Goal saved.");
  }

  // ---------- Log progress ----------
  function logTarget() { return goalById(el.lGoal.value); }

  function openLog(id) {
    const g = goalById(id);
    if (!g) return;
    const options = loggableGoals(g).filter(isOpen);
    if (!options.length) { toast("Nothing numeric to log here — check off steps or subgoals instead."); return; }
    const leaf = focusLeaf(g);
    const def = g.kind === "amount" && isOpen(g) ? g : (leaf && leaf.kind === "amount" ? leaf : options[0]);
    el.lGoal.innerHTML = options.map((o) => `<option value="${o.id}">${escapeHtml(o.icon)} ${escapeHtml(o.title)} (${escapeHtml(fmtValue(o.current, o.unit))})</option>`).join("");
    el.lGoal.value = def.id;
    el.lGoal.closest(".field").hidden = options.length < 2;
    el.lAmount.value = "";
    el.lDate.value = todayISO();
    el.lNote.value = "";
    setLogMode("change");
    el.logModal.hidden = false;
    setTimeout(() => el.lAmount.focus(), 30);
  }
  function closeLog() { el.logModal.hidden = true; }

  function setLogMode(mode) {
    logMode = mode;
    el.lMode.querySelectorAll(".seg__btn").forEach((b) => b.classList.toggle("is-active", b.dataset.mode === mode));
    updateLogLabels();
  }
  function updateLogLabels() {
    const g = logTarget();
    if (!g) return;
    const dec = g.target < g.start;
    const isMoney = g.unit === "$";
    el.lModeChange.textContent = dec ? (isMoney ? "Paid down" : "Reduced by") : "Added";
    if (logMode === "change") el.lAmountLabel.textContent = dec ? (isMoney ? "Amount paid" : "Reduced by") : "Amount added";
    else el.lAmountLabel.textContent = dec && isMoney ? "New balance" : "New value";
    updateLogPreview();
  }
  function computeLog(g) {
    const v = parseFloat(el.lAmount.value);
    if (!Number.isFinite(v)) return null;
    const dec = g.target < g.start;
    const next = logMode === "set" ? v : g.current + (dec ? -v : v);
    return { next, delta: next - g.current };
  }
  function updateLogPreview() {
    const g = logTarget();
    const r = g && computeLog(g);
    if (!g || !r) { el.lPreview.textContent = g ? `Currently ${fmtValue(g.current, g.unit)} · target ${fmtValue(g.target, g.unit)}` : ""; return; }
    const after = numericMetrics(g.start, r.next, g.target, g.unit, g.status);
    el.lPreview.textContent = `${fmtValue(g.current, g.unit)} → ${fmtValue(r.next, g.unit)} · ${after.remaining > 0 ? fmtValue(after.remaining, g.unit) + " to go" : "🎉 target reached!"} (${pctText(after.pct)})`;
  }

  function submitLog(ev) {
    ev.preventDefault();
    const g = logTarget();
    if (!g) return;
    const r = computeLog(g);
    if (!r) { el.lAmount.focus(); return; }
    if (r.delta === 0) { toast("No change to log."); return; }
    g.entries.push({ id: uid(), date: el.lDate.value || todayISO(), delta: r.delta, value: r.next, note: el.lNote.value.trim() });
    g.current = r.next;
    touch(g);
    const celebrations = [];
    if (reached(g) && g.status !== "done") {
      g.status = "done";
      g.completedAt = todayISO();
      celebrations.push(g.title);
      // Cascade: a rollup whose numbers now hit its target is done too.
      pathTo(g.id).slice(0, -1).reverse().forEach((a) => {
        if (a.status !== "done" && a.kind === "rollup" && metrics(a).numeric && metrics(a).pct >= 1) {
          a.status = "done";
          a.completedAt = todayISO();
          celebrations.push(a.title);
        }
      });
    }
    save();
    closeLog();
    renderAll();
    if (celebrations.length) {
      const next = g.parentId ? focusChild(goalById(g.parentId)) : null;
      toast(`🎉 “${celebrations[celebrations.length - 1]}” complete!` + (next ? ` Next focus: ${next.title}` : ""));
    } else {
      toast("Progress logged.");
    }
  }

  function deleteEntry(goalId, entryId) {
    const g = goalById(goalId);
    if (!g) return;
    const e = g.entries.find((x) => x.id === entryId);
    if (!e) return;
    if (!confirm(`Delete this entry (${fmtValue(e.delta, g.unit, { signed: true })} on ${fmtDate(e.date)})? The goal’s current value will be adjusted back.`)) return;
    g.entries = g.entries.filter((x) => x.id !== entryId);
    g.current -= e.delta;
    if (g.status === "done" && g.kind === "amount" && !reached(g)) { g.status = "active"; g.completedAt = null; }
    touch(g);
    save();
    renderAll();
    toast("Entry deleted.");
  }

  // ---------- Status / ordering / delete ----------
  function toggleDone(id) {
    const g = goalById(id);
    if (!g) return;
    if (g.status === "done") {
      g.status = "active";
      g.completedAt = null;
      toast("Reopened.");
    } else {
      const openKids = descendantsOf(g.id).filter(isOpen).length;
      if (openKids && !confirm(`This goal still has ${plural(openKids, "open subgoal")}. Mark it done anyway?`)) return;
      g.status = "done";
      g.completedAt = todayISO();
      const next = g.parentId ? focusChild(goalById(g.parentId)) : null;
      toast(`🎉 Done!` + (next ? ` Next focus: ${next.title}` : ""));
    }
    touch(g);
    save();
    renderAll();
  }

  function moveGoal(id, dir) {
    const g = goalById(id);
    if (!g) return;
    const sibs = childrenOf(g.parentId);
    const i = sibs.indexOf(g);
    const j = i + dir;
    if (j < 0 || j >= sibs.length) return;
    sibs.splice(i, 1);
    sibs.splice(j, 0, g);
    sibs.forEach((s, k) => { s.order = k; });
    save();
    renderAll();
  }

  function dropBefore(dragged, target) {
    const a = goalById(dragged), b = goalById(target);
    if (!a || !b || a === b || a.parentId !== b.parentId) return;
    const sibs = childrenOf(a.parentId).filter((s) => s !== a);
    const bi = sibs.indexOf(b);
    const fromBelow = a.order > b.order;
    sibs.splice(fromBelow ? bi : bi + 1, 0, a);
    sibs.forEach((s, k) => { s.order = k; });
    save();
    renderAll();
  }

  function deleteGoal(id) {
    const g = goalById(id);
    if (!g) return;
    const desc = descendantsOf(g.id);
    const msg = desc.length
      ? `Delete “${g.title}” and its ${plural(desc.length, "subgoal")}? This cannot be undone.`
      : `Delete “${g.title}”? This cannot be undone.`;
    if (!confirm(msg)) return;
    const gone = new Set([g.id].concat(desc.map((d) => d.id)));
    db.goals = db.goals.filter((x) => !gone.has(x.id));
    renumber(g.parentId);
    save();
    select(g.parentId);
    toast("Goal deleted.");
  }

  // ---------- Action plan steps ----------
  function addStep(text) {
    const g = goalById(selectedId);
    if (!g || !text.trim()) return;
    g.steps.push({ id: uid(), text: text.trim().slice(0, 300), done: false });
    touch(g);
    save();
    renderAll();
    const input = document.getElementById("stepAddInput");
    if (input) input.focus();
  }
  function toggleStep(stepId, done) {
    const g = goalById(selectedId);
    const s = g && g.steps.find((x) => x.id === stepId);
    if (!s) return;
    s.done = done;
    touch(g);
    save();
    renderAll();
  }
  function deleteStep(stepId) {
    const g = goalById(selectedId);
    if (!g) return;
    g.steps = g.steps.filter((x) => x.id !== stepId);
    touch(g);
    save();
    renderAll();
  }

  // ---------- Theme / atmosphere ----------
  function getThemePref() {
    const pref = localStorage.getItem(THEME_KEY);
    return pref === "day" || pref === "twilight" || pref === "night" || pref === "random" ? pref : DEFAULT_THEME;
  }
  function applyThemeClass(mode) {
    const root = document.documentElement;
    root.classList.remove("day", "twilight");
    if (mode === "day") root.classList.add("day");
    else if (mode === "twilight") root.classList.add("twilight");
  }
  function setTheme(pref) {
    localStorage.setItem(THEME_KEY, pref);
    if (pref === "random") {
      const active = THEMES[Math.floor(Math.random() * THEMES.length)];
      sessionStorage.setItem(ACTIVE_THEME_KEY, active);
      applyThemeClass(active);
    } else {
      sessionStorage.removeItem(ACTIVE_THEME_KEY);
      applyThemeClass(pref);
    }
    updateThemePicker();
  }
  function updateThemePicker() {
    const pref = getThemePref();
    el.themePicker.querySelectorAll(".theme-chip").forEach((chip) => {
      chip.classList.toggle("is-active", chip.dataset.themeVal === pref);
    });
  }

  // ---------- Settings / About ----------
  function openSettings() { updateThemePicker(); el.settingsModal.hidden = false; }
  function closeSettings() { el.settingsModal.hidden = true; }
  function openAbout() { closeSettings(); el.aboutModal.hidden = false; }
  function closeAbout() { el.aboutModal.hidden = true; }
  function initVersion() {
    el.appVersion.textContent = "v" + APP_VERSION;
    el.aboutVersion.textContent = "Version " + APP_VERSION;
  }

  // ---------- Unified backup (Kashikoi suite schema) ----------
  function createArcusBackupData() {
    return {
      version: 1,
      appName: "Arcus",
      exportedAt: new Date().toISOString(),
      theme: getThemePref(),
      goals: db.goals,
    };
  }

  // Preserves every other app's slice so saving from Arcus never clobbers the sister apps.
  function getExistingBackupApps(existingBackup) {
    if (!existingBackup || typeof existingBackup !== "object") return {};
    if (existingBackup.schema === UNIFIED_BACKUP_SCHEMA && existingBackup.apps && typeof existingBackup.apps === "object") {
      return Object.assign({}, existingBackup.apps);
    }
    if (existingBackup.appName === "Nimbus" || Array.isArray(existingBackup.tabs)) return { nimbus: existingBackup };
    if (existingBackup.appName === "Cumulus" || Array.isArray(existingBackup.accounts)) return { cumulus: existingBackup };
    if (existingBackup.appName === "Cirrus" || Array.isArray(existingBackup.movies)) return { cirrus: existingBackup };
    if (existingBackup.appName === "Stratus" || Array.isArray(existingBackup.stamps)) return { stratus: existingBackup };
    if (existingBackup.appName === "Anvil" || Array.isArray(existingBackup.runbooks)) return { anvil: existingBackup };
    if (existingBackup.appName === "Arcus" || Array.isArray(existingBackup.goals)) return { arcus: existingBackup };
    return {};
  }

  function createBackupData(existingBackup) {
    const apps = getExistingBackupApps(existingBackup);
    apps.arcus = createArcusBackupData();
    return {
      schema: UNIFIED_BACKUP_SCHEMA,
      version: 1,
      appName: "Kashikoi Apps",
      exportedAt: new Date().toISOString(),
      apps,
    };
  }

  function normalizeBackupData(data) {
    if (!data || typeof data !== "object") throw new Error("Invalid format");
    const arcus = data.schema === UNIFIED_BACKUP_SCHEMA && data.apps ? data.apps.arcus : data;
    if (!arcus || typeof arcus !== "object" || !Array.isArray(arcus.goals)) throw new Error("No Arcus data");
    return {
      goals: sanitizeGoals(arcus.goals),
      theme: typeof arcus.theme === "string" ? arcus.theme : null,
    };
  }

  function applyRestoredData(imported, sourceLabel) {
    const roots = imported.goals.filter((g) => !g.parentId).length;
    const summary = `${plural(roots, "goal")} (${imported.goals.length} including subgoals)`;
    if (!confirm(`Restore ${summary} from ${sourceLabel}? This replaces your current Arcus data.`)) return false;
    db = { goals: imported.goals };
    if (imported.theme && ["day", "twilight", "night", "random"].includes(imported.theme)) setTheme(imported.theme);
    save();
    select(null);
    return true;
  }

  function downloadBackup(obj, filename) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportJSON() {
    downloadBackup(createBackupData(), "arcus-backup-" + todayISO() + ".json");
    toast("Backup exported.");
  }
  function importJSON(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function () {
      try {
        const imported = normalizeBackupData(JSON.parse(reader.result));
        if (applyRestoredData(imported, "backup file")) { closeSettings(); toast("Backup imported."); }
      } catch (e) {
        toast("That file doesn't contain Arcus data.");
      }
      el.importFile.value = "";
    };
    reader.readAsText(file);
  }

  function randomizeData() {
    if (db.goals.length && !confirm("Replace everything with a demo set of goals? Export first if you want to keep your current data.")) return;
    const demo = demoData();
    db = { goals: demo.goals };
    save();
    closeSettings();
    select(demo.focusId);
    toast("Demo goals loaded.");
  }
  function clearAll() {
    if (!confirm("Delete ALL goals, subgoals and history? This cannot be undone.")) return;
    db = { goals: [] };
    save();
    closeSettings();
    select(null);
    toast("All data cleared.");
  }

  // ---------- Encrypted cloud sync (zero-knowledge, shared worker) ----------
  function getCloudPhrase() {
    return el.cloudPhrase.value.trim().replace(/\s+/g, " ");
  }
  function setCloudStatus(msg, kind) {
    el.cloudStatus.textContent = msg || "";
    el.cloudStatus.className = "cloud-data-status" + (kind ? " cloud-data-status--" + kind : "");
  }
  function createRecoveryPhrase() {
    const idx = new Uint32Array(RECOVERY_PHRASE_WORD_COUNT);
    crypto.getRandomValues(idx);
    return [...idx].map((n) => RECOVERY_WORDS[n % RECOVERY_WORDS.length]).join(" ");
  }
  function generateCloudPhrase() {
    if (getCloudPhrase() && !confirm("Replace the phrase in the box with a brand-new one? If you already use a phrase in your other cloud apps, use that instead so they share one backup.")) return;
    el.cloudPhrase.value = createRecoveryPhrase();
    el.cloudPhrase.type = "text";
    el.togglePhraseBtn.textContent = "Hide";
    el.togglePhraseBtn.setAttribute("aria-pressed", "true");
    el.cloudPhraseOut.hidden = false;
    el.cloudPhraseOut.textContent = "Write these 16 words down. They are the ONLY key to your cloud backup — they can't be recovered.";
    saveRememberedPhrase();
    setCloudStatus("New recovery phrase created. Save to cloud to use it.", "info");
  }
  function togglePhraseVisibility() {
    const show = el.cloudPhrase.type === "password";
    el.cloudPhrase.type = show ? "text" : "password";
    el.togglePhraseBtn.textContent = show ? "Hide" : "Show";
    el.togglePhraseBtn.setAttribute("aria-pressed", String(show));
  }
  function saveRememberedPhrase() {
    if (el.rememberPhrase.checked && getCloudPhrase()) localStorage.setItem(REMEMBER_CLOUD_PHRASE_KEY, getCloudPhrase());
    else if (!el.rememberPhrase.checked) localStorage.removeItem(REMEMBER_CLOUD_PHRASE_KEY);
  }
  function loadRememberedPhrase() {
    const saved = localStorage.getItem(REMEMBER_CLOUD_PHRASE_KEY) || "";
    if (!saved) return;
    el.cloudPhrase.value = saved;
    el.rememberPhrase.checked = true;
  }

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function base64ToArrayBuffer(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }
  async function sha256Hex(value) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  function getCloudSyncKey(phrase) {
    return sha256Hex("kashikoi-cloud-sync-v1:" + phrase);
  }
  async function deriveCloudKey(phrase, salt) {
    const phraseKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(phrase), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", hash: "SHA-256", salt, iterations: CLOUD_KDF_ITERATIONS },
      phraseKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  }
  async function encryptCloudBackup(phrase, backupData) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveCloudKey(phrase, salt);
    const plaintext = new TextEncoder().encode(JSON.stringify(backupData));
    const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
    return {
      app: CLOUD_ENVELOPE_APP,
      writtenBy: "Arcus",
      format: CLOUD_SYNC_FORMAT,
      updatedAt: new Date().toISOString(),
      kdf: { name: "PBKDF2", hash: "SHA-256", iterations: CLOUD_KDF_ITERATIONS, salt: arrayBufferToBase64(salt) },
      cipher: { name: "AES-GCM", iv: arrayBufferToBase64(iv) },
      payload: arrayBufferToBase64(encrypted),
    };
  }
  async function decryptCloudBackup(phrase, envelope) {
    if (!envelope || typeof envelope !== "object" || !ACCEPTED_ENVELOPE_APPS.has(envelope.app) ||
        (envelope.format !== CLOUD_SYNC_FORMAT && envelope.format !== LEGACY_CLOUD_SYNC_FORMAT) ||
        !envelope.kdf || !envelope.cipher || typeof envelope.payload !== "string") {
      throw new Error("Invalid envelope");
    }
    const salt = new Uint8Array(base64ToArrayBuffer(envelope.kdf.salt));
    const iv = new Uint8Array(base64ToArrayBuffer(envelope.cipher.iv));
    const key = await deriveCloudKey(phrase, salt);
    const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, base64ToArrayBuffer(envelope.payload));
    return JSON.parse(new TextDecoder().decode(decrypted));
  }
  async function fetchEncryptedBackupAtKey(syncKey) {
    const bust = Date.now() + "-" + Math.random().toString(36).slice(2);
    const response = await fetch(`${CLOUD_SYNC_ENDPOINT}/sync/${syncKey}?t=${bust}`, { cache: "no-store" });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error("HTTP " + response.status);
    return response.json();
  }
  async function createMergedCloudBackup(phrase) {
    const syncKey = await getCloudSyncKey(phrase);
    let existingBackup = null;
    const envelope = await fetchEncryptedBackupAtKey(syncKey);
    if (envelope) {
      try {
        existingBackup = await decryptCloudBackup(phrase, envelope);
      } catch (e) {
        throw new Error("decrypt-existing");
      }
    }
    return { syncKey, backup: createBackupData(existingBackup) };
  }

  async function saveCloudData() {
    const phrase = getCloudPhrase();
    if (!phrase) { setCloudStatus("Enter or create a recovery phrase first.", "error"); return; }
    setCloudStatus("Encrypting and saving cloud backup…", "info");
    try {
      const merged = await createMergedCloudBackup(phrase);
      const envelope = await encryptCloudBackup(phrase, merged.backup);
      const response = await fetch(`${CLOUD_SYNC_ENDPOINT}/sync/${merged.syncKey}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(envelope),
      });
      if (!response.ok) throw new Error("HTTP " + response.status);
      saveRememberedPhrase();
      setCloudStatus("Saved to cloud. Use the same phrase to restore on another device.", "success");
    } catch (error) {
      if (error && error.message === "decrypt-existing") {
        setCloudStatus("A different cloud backup exists for this phrase and couldn't be decrypted. Check the phrase.", "error");
      } else {
        setCloudStatus("Could not save to cloud. Your local Arcus data is still safe here.", "error");
      }
    }
  }

  async function loadCloudData() {
    const phrase = getCloudPhrase();
    if (!phrase) { setCloudStatus("Enter your recovery phrase first.", "error"); return; }
    setCloudStatus("Loading encrypted cloud backup…", "info");
    let data;
    try {
      const syncKey = await getCloudSyncKey(phrase);
      const envelope = await fetchEncryptedBackupAtKey(syncKey);
      if (!envelope) { setCloudStatus("No cloud backup exists for this phrase yet. Save from your first device first.", "error"); return; }
      data = await decryptCloudBackup(phrase, envelope);
    } catch (error) {
      setCloudStatus("Could not decrypt cloud backup. Check the phrase or try again later.", "error");
      return;
    }
    let imported;
    try {
      imported = normalizeBackupData(data);
    } catch (e) {
      setCloudStatus("This cloud backup has no Arcus data yet. Save to cloud from Arcus first.", "error");
      return;
    }
    saveRememberedPhrase();
    if (applyRestoredData(imported, "encrypted cloud sync")) setCloudStatus("Restored from cloud.", "success");
    else setCloudStatus("Cloud restore cancelled.", "info");
  }

  // ---------- Events ----------
  function wireDrag(container, itemSelector) {
    container.addEventListener("dragstart", (e) => {
      const item = e.target.closest(itemSelector);
      if (!item) return;
      dragId = item.dataset.id;
      item.classList.add("is-dragging");
      e.dataTransfer.effectAllowed = "move";
      try { e.dataTransfer.setData("text/plain", dragId); } catch (err) {}
    });
    container.addEventListener("dragend", () => {
      dragId = null;
      container.querySelectorAll(".is-dragging, .is-drop-target").forEach((n) => n.classList.remove("is-dragging", "is-drop-target"));
    });
    container.addEventListener("dragover", (e) => {
      const item = e.target.closest(itemSelector);
      if (!item || !dragId || item.dataset.id === dragId) return;
      const a = goalById(dragId), b = goalById(item.dataset.id);
      if (!a || !b || a.parentId !== b.parentId) return;
      e.preventDefault();
      container.querySelectorAll(".is-drop-target").forEach((n) => n.classList.remove("is-drop-target"));
      item.classList.add("is-drop-target");
    });
    container.addEventListener("drop", (e) => {
      const item = e.target.closest(itemSelector);
      if (!item || !dragId) return;
      e.preventDefault();
      dropBefore(dragId, item.dataset.id);
    });
  }

  function onCanvasClick(e) {
    const t = e.target;
    const btn = t.closest("button, [data-open]");
    if (!btn) return;
    const d = btn.dataset;
    if (d.log) return openLog(d.log);
    if (d.move) return moveGoal(d.move, Number(d.dir));
    if (d.toggleDone) return toggleDone(d.toggleDone);
    if (d.delStep) return deleteStep(d.delStep);
    if (d.delEntry) return deleteEntry(d.goal, d.delEntry);
    if (d.open) return select(d.open);
    switch (d.action) {
      case "new-goal": return openEditor(null, null);
      case "demo": return randomizeData();
      case "edit": return openEditor(selectedId);
      case "delete": return deleteGoal(selectedId);
      case "add-sub": return openEditor(null, selectedId);
    }
  }

  function bindEvents() {
    el.canvas.addEventListener("click", onCanvasClick);
    el.canvas.addEventListener("change", (e) => {
      if (e.target.matches("input[data-step]")) toggleStep(e.target.dataset.step, e.target.checked);
    });
    el.canvas.addEventListener("submit", (e) => {
      if (e.target.id === "stepAddForm") {
        e.preventDefault();
        addStep(document.getElementById("stepAddInput").value);
      }
    });
    el.canvas.addEventListener("keydown", (e) => {
      if ((e.key === "Enter" || e.key === " ") && e.target.matches(".dash-card[data-open]")) {
        e.preventDefault();
        select(e.target.dataset.open);
      }
    });
    wireDrag(el.canvas, ".sub");

    el.goalList.addEventListener("click", (e) => {
      const card = e.target.closest(".goal-card");
      if (card) select(card.dataset.id);
    });
    el.goalList.addEventListener("keydown", (e) => {
      const card = e.target.closest(".goal-card");
      if (card && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); select(card.dataset.id); }
    });
    wireDrag(el.goalList, ".goal-card");

    el.railFilter.addEventListener("click", (e) => {
      const b = e.target.closest(".seg__btn");
      if (!b) return;
      railFilter = b.dataset.filter;
      localStorage.setItem(FILTER_KEY, railFilter);
      renderAll();
    });
    el.crumb.addEventListener("click", (e) => {
      const b = e.target.closest("[data-crumb]");
      if (b && !b.classList.contains("is-current")) select(b.dataset.crumb || null);
    });
    el.newGoalBtn.addEventListener("click", () => openEditor(null, null));
    el.topLogBtn.addEventListener("click", () => openLog(selectedId));

    // Editor
    el.editorForm.addEventListener("submit", saveEditor);
    el.fKind.addEventListener("click", (e) => {
      const b = e.target.closest(".seg__btn");
      if (b) setEditorKind(b.dataset.kind);
    });
    el.fUnit.addEventListener("change", updateUnitCustom);
    el.fStart.addEventListener("input", updateDirectionHint);
    el.fTarget.addEventListener("input", updateDirectionHint);
    document.querySelectorAll("[data-close-editor]").forEach((n) => n.addEventListener("click", closeEditor));

    // Log
    el.logForm.addEventListener("submit", submitLog);
    el.lMode.addEventListener("click", (e) => {
      const b = e.target.closest(".seg__btn");
      if (b) setLogMode(b.dataset.mode);
    });
    el.lGoal.addEventListener("change", updateLogLabels);
    el.lAmount.addEventListener("input", updateLogPreview);
    document.querySelectorAll("[data-close-log]").forEach((n) => n.addEventListener("click", closeLog));

    // Settings / About
    el.settingsBtn.addEventListener("click", openSettings);
    document.querySelectorAll("[data-close-settings]").forEach((n) => n.addEventListener("click", closeSettings));
    document.querySelectorAll("[data-close-about]").forEach((n) => n.addEventListener("click", closeAbout));
    el.aboutBtn.addEventListener("click", openAbout);
    el.themePicker.addEventListener("click", (e) => {
      const chip = e.target.closest(".theme-chip");
      if (chip) setTheme(chip.dataset.themeVal);
    });
    el.exportBtn.addEventListener("click", exportJSON);
    el.importBtn.addEventListener("click", () => el.importFile.click());
    el.importFile.addEventListener("change", () => importJSON(el.importFile.files[0]));
    el.randomizeBtn.addEventListener("click", randomizeData);
    el.clearBtn.addEventListener("click", clearAll);

    // Cloud sync
    el.cloudPhraseForm.addEventListener("submit", (e) => e.preventDefault());
    el.generatePhraseBtn.addEventListener("click", generateCloudPhrase);
    el.togglePhraseBtn.addEventListener("click", togglePhraseVisibility);
    el.rememberPhrase.addEventListener("change", saveRememberedPhrase);
    el.cloudSaveBtn.addEventListener("click", saveCloudData);
    el.cloudLoadBtn.addEventListener("click", loadCloudData);

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        if (!el.logModal.hidden) return closeLog();
        if (!el.editorModal.hidden) return closeEditor();
        if (!el.aboutModal.hidden) return closeAbout();
        if (!el.settingsModal.hidden) return closeSettings();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s" && !el.editorModal.hidden) {
        e.preventDefault();
        saveEditor();
        return;
      }
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement && document.activeElement.tagName);
      const modalOpen = !el.editorModal.hidden || !el.logModal.hidden || !el.settingsModal.hidden || !el.aboutModal.hidden;
      if (typing || modalOpen || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "n") { e.preventDefault(); openEditor(null, null); }
      else if (e.key === "l" && selectedId) { e.preventDefault(); openLog(selectedId); }
    });

    // Stay in sync if another tab edits data.
    window.addEventListener("storage", (e) => {
      if (e.key === STORE_KEY) { load(); renderAll(); }
    });
  }

  function cacheEls() {
    [
      "app", "canvas", "crumb", "goalList", "railSummary", "railFilter", "newGoalBtn", "topLogBtn", "appVersion", "toast",
      "editorModal", "editorTitle", "editorForm", "fIcon", "fTitle", "fParent", "fStatus", "fKind", "fKindHint",
      "fUnitRow", "fUnit", "fUnitCustomWrap", "fUnitCustom", "fNumbersRow", "fStart", "fCurrent", "fTarget", "fDue", "fDirection", "fNotes",
      "logModal", "logForm", "lGoal", "lMode", "lModeChange", "lAmountLabel", "lAmount", "lDate", "lPreview", "lNote",
      "settingsBtn", "settingsModal", "themePicker", "exportBtn", "importBtn", "importFile", "randomizeBtn", "clearBtn", "aboutBtn",
      "aboutModal", "aboutVersion",
      "cloudPhraseForm", "cloudPhrase", "togglePhraseBtn", "cloudPhraseOut", "rememberPhrase", "generatePhraseBtn",
      "cloudSaveBtn", "cloudLoadBtn", "cloudStatus",
    ].forEach((id) => { el[id] = document.getElementById(id); });
  }

  function init() {
    cacheEls();
    load();
    initVersion();
    loadRememberedPhrase();
    bindEvents();
    renderAll();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
