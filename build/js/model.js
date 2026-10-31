/* Arcus — domain model: entity shapes, enums, normalization, and v1 -> v2 migration. */
(function (A) {
  "use strict";
  const U = A.util;

  const SCHEMA_VERSION = 2;

  const MEASUREMENT_TYPES = {
    currency:   { label: "Currency",          numeric: true,  hint: "Money from a starting balance to a target — e.g. $7,500 → $0, or $0 → $10,000 saved." },
    numeric:    { label: "Number",            numeric: true,  hint: "Any count or quantity — miles, pounds, users, pages." },
    percentage: { label: "Percentage",        numeric: true,  hint: "A value measured in percent — e.g. body fat 24% → 18%, or 0% → 100% complete." },
    custom:     { label: "Custom unit",       numeric: true,  hint: "A number with your own unit — e.g. 0 → 12 \"chapters\"." },
    milestones: { label: "Milestones",        numeric: false, hint: "Progress = completed milestones (optionally weighted). Falls back to completed subgoals." },
    binary:     { label: "Done / not done",   numeric: false, hint: "Either complete or not — e.g. \"Get the title transferred\"." },
  };
  const NUMERIC_TYPES = Object.keys(MEASUREMENT_TYPES).filter((k) => MEASUREMENT_TYPES[k].numeric);

  const PRIORITIES = {
    critical: { label: "Critical", rank: 0, weight: 40 },
    high:     { label: "High",     rank: 1, weight: 30 },
    medium:   { label: "Medium",   rank: 2, weight: 20 },
    low:      { label: "Low",      rank: 3, weight: 10 },
  };
  const GOAL_STATUSES = {
    active:    { label: "Active" },
    onHold:    { label: "On hold" },
    completed: { label: "Completed" },
    archived:  { label: "Archived" },
  };
  const EFFORTS = {
    xs: { label: "< 15 min" },
    s:  { label: "< 1 hour" },
    m:  { label: "Half day" },
    l:  { label: "1–2 days" },
    xl: { label: "Multi-day" },
  };
  const ENTRY_TYPES = {
    progress:   { label: "Progress" },
    payment:    { label: "Payment" },
    adjustment: { label: "Adjustment" },
    correction: { label: "Correction" },
    completion: { label: "Completion" },
  };
  const CATEGORIES = { general: { label: "General" }, debt: { label: "Debt payoff" } };
  const CURRENCIES = ["USD", "CAD", "EUR", "GBP", "AUD", "JPY", "CHF", "MXN"];

  function pick(v, table, fallback) { return Object.prototype.hasOwnProperty.call(table, v) ? v : fallback; }
  function str(v, max) { return String(v == null ? "" : v).slice(0, max || 500); }
  function dateOrEmpty(v) { return U.isISODate(v) ? v : (typeof v === "string" && U.isISODate(v.slice(0, 10)) ? v.slice(0, 10) : ""); }
  function idOr(v) { return typeof v === "string" && v ? v : U.uid(); }
  function stamp(v) { return typeof v === "string" && v ? v : new Date().toISOString(); }

  function emptyDb() {
    return { schemaVersion: SCHEMA_VERSION, goals: [], milestones: [], actions: [], entries: [], dependencies: [], focusGoalId: null };
  }

  function normalizeFinance(f) {
    const o = f && typeof f === "object" ? f : {};
    return {
      apr: U.numOrNull(o.apr),
      promoApr: U.numOrNull(o.promoApr),
      promoEndDate: dateOrEmpty(o.promoEndDate),
      deferredInterest: !!o.deferredInterest,
      promoEndsBeforeStatement: !!o.promoEndsBeforeStatement,
      statementDay: (function () { const n = U.numOrNull(o.statementDay); return n && n >= 1 && n <= 31 ? Math.round(n) : null; })(),
      minimumPayment: U.numOrNull(o.minimumPayment),
    };
  }

  function normalizeGoal(g, i) {
    const o = g && typeof g === "object" ? g : {};
    const type = pick(o.measurementType, MEASUREMENT_TYPES, "currency");
    const numeric = MEASUREMENT_TYPES[type].numeric;
    const start = numeric ? U.numOrNull(o.startValue) : null;
    return {
      id: idOr(o.id),
      parentId: typeof o.parentId === "string" && o.parentId ? o.parentId : null,
      name: str(o.name || "Untitled goal", 200),
      description: str(o.description, 4000),
      measurementType: type,
      currency: CURRENCIES.includes(o.currency) ? o.currency : "USD",
      unit: str(o.unit, 24),
      startValue: start,
      targetValue: numeric ? U.numOrNull(o.targetValue) : null,
      currentValue: numeric ? (U.numOrNull(o.currentValue) != null ? U.numOrNull(o.currentValue) : start) : null,
      rollup: numeric && !!o.rollup,
      priority: pick(o.priority, PRIORITIES, "medium"),
      status: pick(o.status, GOAL_STATUSES, "active"),
      category: pick(o.category, CATEGORIES, "general"),
      finance: normalizeFinance(o.finance),
      startDate: dateOrEmpty(o.startDate),
      targetDate: dateOrEmpty(o.targetDate),
      completedDate: dateOrEmpty(o.completedDate),
      completedAutomatically: o.status === "completed" && !!o.completedAutomatically,
      createdAt: stamp(o.createdAt),
      updatedAt: stamp(o.updatedAt),
      sortOrder: Number.isFinite(o.sortOrder) ? o.sortOrder : (i || 0),
    };
  }

  function normalizeMilestone(m, i) {
    const o = m && typeof m === "object" ? m : {};
    return {
      id: idOr(o.id),
      goalId: String(o.goalId || ""),
      name: str(o.name || "Milestone", 200),
      description: str(o.description, 2000),
      targetValue: U.numOrNull(o.targetValue), // progress amount from the goal's start (direction-aware)
      weight: (function () { const w = U.numOrNull(o.weight); return w && w > 0 ? w : 1; })(),
      dueDate: dateOrEmpty(o.dueDate),
      status: o.status === "completed" ? "completed" : "open",
      auto: o.status === "completed" && !!o.auto, // completed automatically by crossing targetValue
      completedDate: dateOrEmpty(o.completedDate),
      sortOrder: Number.isFinite(o.sortOrder) ? o.sortOrder : (i || 0),
    };
  }

  function normalizeAction(a, i) {
    const o = a && typeof a === "object" ? a : {};
    return {
      id: idOr(o.id),
      goalId: String(o.goalId || ""),
      milestoneId: typeof o.milestoneId === "string" && o.milestoneId ? o.milestoneId : null,
      name: str(o.name || "Action", 300),
      description: str(o.description, 2000),
      priority: pick(o.priority, PRIORITIES, "medium"),
      dueDate: dateOrEmpty(o.dueDate),
      status: o.status === "done" ? "done" : "open",
      effort: o.effort && EFFORTS[o.effort] ? o.effort : "",
      completedDate: dateOrEmpty(o.completedDate),
      createdAt: stamp(o.createdAt),
      sortOrder: Number.isFinite(o.sortOrder) ? o.sortOrder : (i || 0),
    };
  }

  function normalizeEntry(e) {
    const o = e && typeof e === "object" ? e : {};
    const prev = U.numOrNull(o.previousValue);
    const next = U.numOrNull(o.newValue);
    const change = U.numOrNull(o.changeAmount);
    return {
      id: idOr(o.id),
      goalId: String(o.goalId || ""),
      date: dateOrEmpty(o.date) || U.todayISO(),
      previousValue: prev,
      newValue: next,
      changeAmount: change != null ? change : (prev != null && next != null ? U.round2(next - prev) : null),
      notes: str(o.notes, 1000),
      entryType: pick(o.entryType, ENTRY_TYPES, "progress"),
      correctsId: typeof o.correctsId === "string" ? o.correctsId : null,
      createdAt: stamp(o.createdAt),
    };
  }

  function normalizeDependency(d) {
    const o = d && typeof d === "object" ? d : {};
    return { id: idOr(o.id), goalId: String(o.goalId || ""), dependsOnId: String(o.dependsOnId || "") };
  }

  // Validates referential integrity and breaks parent cycles. Never throws.
  function normalizeDb(raw) {
    if (raw && typeof raw === "object" && !raw.schemaVersion && Array.isArray(raw.goals) && raw.goals.some((g) => g && "kind" in g)) {
      raw = migrateV1(raw);
    }
    const src = raw && typeof raw === "object" ? raw : {};
    const goals = (Array.isArray(src.goals) ? src.goals : []).map(normalizeGoal);
    const seen = new Set();
    const uniqueGoals = goals.filter((g) => (seen.has(g.id) ? false : (seen.add(g.id), true)));
    const ids = new Set(uniqueGoals.map((g) => g.id));
    const byId = new Map(uniqueGoals.map((g) => [g.id, g]));
    uniqueGoals.forEach((g) => { if (g.parentId && (!ids.has(g.parentId) || g.parentId === g.id)) g.parentId = null; });
    uniqueGoals.forEach((g) => {
      const chain = new Set([g.id]);
      let p = g.parentId;
      while (p) {
        if (chain.has(p)) { g.parentId = null; break; }
        chain.add(p);
        p = byId.get(p) ? byId.get(p).parentId : null;
      }
    });
    const milestones = (Array.isArray(src.milestones) ? src.milestones : []).map(normalizeMilestone).filter((m) => ids.has(m.goalId));
    const msIds = new Set(milestones.map((m) => m.id));
    const actions = (Array.isArray(src.actions) ? src.actions : []).map(normalizeAction).filter((a) => ids.has(a.goalId));
    actions.forEach((a) => { if (a.milestoneId && !msIds.has(a.milestoneId)) a.milestoneId = null; });
    const entries = (Array.isArray(src.entries) ? src.entries : []).map(normalizeEntry).filter((e) => ids.has(e.goalId));
    const depKeys = new Set();
    const dependencies = (Array.isArray(src.dependencies) ? src.dependencies : []).map(normalizeDependency).filter((d) => {
      const key = d.goalId + ">" + d.dependsOnId;
      if (!ids.has(d.goalId) || !ids.has(d.dependsOnId) || d.goalId === d.dependsOnId || depKeys.has(key)) return false;
      depKeys.add(key);
      return true;
    });
    return {
      schemaVersion: SCHEMA_VERSION,
      goals: uniqueGoals,
      milestones,
      actions,
      entries,
      dependencies,
      focusGoalId: typeof src.focusGoalId === "string" && ids.has(src.focusGoalId) ? src.focusGoalId : null,
    };
  }

  // v1 (2026.10.31.1): { goals: [{ kind, unit, start, current, target, steps[], entries[], ... }] }
  function migrateV1(raw) {
    const out = emptyDb();
    raw.goals.forEach((g, i) => {
      if (!g || typeof g !== "object") return;
      const unit = typeof g.unit === "string" ? g.unit : "$";
      let type = "milestones";
      if (g.kind === "amount" || g.kind === "rollup") type = unit === "$" ? "currency" : unit === "%" ? "percentage" : unit ? "custom" : "numeric";
      const statusMap = { done: "completed", paused: "onHold", active: "active" };
      out.goals.push({
        id: g.id, parentId: g.parentId || null, name: g.title, description: g.notes,
        measurementType: type, currency: "USD", unit: type === "custom" ? unit : "",
        startValue: g.kind === "amount" ? g.start : null,
        targetValue: g.kind === "amount" ? g.target : null,
        currentValue: g.kind === "amount" ? g.current : null,
        rollup: g.kind === "rollup",
        priority: "medium", status: statusMap[g.status] || "active",
        targetDate: g.dueDate, completedDate: g.completedAt ? String(g.completedAt).slice(0, 10) : "",
        createdAt: g.createdAt, updatedAt: g.updatedAt, sortOrder: Number.isFinite(g.order) ? g.order : i,
      });
      (Array.isArray(g.steps) ? g.steps : []).forEach((s, j) => {
        out.actions.push({ id: s.id, goalId: g.id, name: s.text, status: s.done ? "done" : "open", sortOrder: j });
      });
      (Array.isArray(g.entries) ? g.entries : []).forEach((e) => {
        const next = U.numOrNull(e.value), delta = U.numOrNull(e.delta);
        out.entries.push({
          id: e.id, goalId: g.id, date: e.date, newValue: next,
          previousValue: next != null && delta != null ? U.round2(next - delta) : null,
          changeAmount: delta, notes: e.note, entryType: "progress",
        });
      });
    });
    return out;
  }

  A.model = {
    SCHEMA_VERSION, MEASUREMENT_TYPES, NUMERIC_TYPES, PRIORITIES, GOAL_STATUSES, EFFORTS, ENTRY_TYPES, CATEGORIES, CURRENCIES,
    emptyDb, normalizeDb, normalizeGoal, normalizeMilestone, normalizeAction, normalizeEntry, normalizeDependency, normalizeFinance, migrateV1,
  };
})(typeof window !== "undefined" ? window.Arcus : globalThis.Arcus);
