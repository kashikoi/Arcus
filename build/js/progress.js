/* Arcus — measurement & progress engine.
   Pure functions over a db snapshot. Every screen gets progress from here; no UI does its own math. */
(function (A) {
  "use strict";
  const U = A.util;
  const M = A.model;

  const EPS = 0.005;

  // Core numeric calculation: progress = (current - start) / (target - start); works for increasing and decreasing goals.
  function numericCore(start, current, target) {
    if (start == null || target == null) {
      return { valid: false, issue: "Set both a starting and a target value to measure progress.", pct: null };
    }
    const cur = current == null ? start : current;
    const span = target - start;
    if (Math.abs(span) < 1e-9) {
      return { valid: false, issue: "Starting and target values are the same, so there is nothing to measure.", pct: null, start, current: cur, target };
    }
    const raw = (cur - start) / span;
    const direction = span < 0 ? "decrease" : "increase";
    const sign = span < 0 ? -1 : 1;
    return {
      valid: true,
      start, current: cur, target, direction,
      rawPct: raw,
      pct: U.clamp(raw, 0, 1),
      progressed: U.round2((cur - start) * sign),          // negative => moved backwards
      remaining: U.round2(Math.max(0, (target - cur) * sign)),
      total: U.round2(Math.abs(span)),
      overshoot: raw > 1 + 1e-9,
      regressed: raw < -1e-9,
      reached: raw >= 1 - 1e-9,
    };
  }

  function fmtOf(g) { return { measurementType: g.measurementType, currency: g.currency, unit: g.unit }; }
  function sameMeasure(a, b) {
    if (a.measurementType !== b.measurementType) return false;
    if (a.measurementType === "currency") return a.currency === b.currency;
    if (a.measurementType === "custom" || a.measurementType === "numeric") return (a.unit || "").trim().toLowerCase() === (b.unit || "").trim().toLowerCase();
    return true;
  }
  function isOpen(g) { return g && (g.status === "active" || g.status === "onHold"); }
  function isLive(g) { return g && g.status !== "archived"; }

  function createEngine(db) {
    const goalMap = new Map(db.goals.map((g) => [g.id, g]));
    const kids = new Map();
    db.goals.forEach((g) => {
      const k = g.parentId || "";
      if (!kids.has(k)) kids.set(k, []);
      kids.get(k).push(g);
    });
    kids.forEach((list) => list.sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt)));
    const byGoal = (list) => {
      const m = new Map();
      list.forEach((x) => { if (!m.has(x.goalId)) m.set(x.goalId, []); m.get(x.goalId).push(x); });
      return m;
    };
    const msMap = byGoal(db.milestones);
    msMap.forEach((l) => l.sort((a, b) => a.sortOrder - b.sortOrder));
    const actMap = byGoal(db.actions);
    actMap.forEach((l) => l.sort((a, b) => a.sortOrder - b.sortOrder));
    const entIndex = new Map(db.entries.map((e, i) => [e.id, i]));
    const entMap = byGoal(db.entries);
    // Newest first; insertion order breaks ties for entries recorded on the same date.
    entMap.forEach((l) => l.sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt) || entIndex.get(b.id) - entIndex.get(a.id)));
    const memo = new Map();

    function goal(id) { return goalMap.get(id) || null; }
    function children(id, opts) {
      const list = kids.get(id || "") || [];
      return opts && opts.includeArchived ? list.slice() : list.filter(isLive);
    }
    function descendants(id, opts) {
      const out = [];
      (function walk(pid) { children(pid, opts).forEach((c) => { out.push(c); walk(c.id); }); })(id);
      return out;
    }
    function path(id) {
      const out = [];
      let g = goal(id);
      const guard = new Set();
      while (g && !guard.has(g.id)) { guard.add(g.id); out.unshift(g); g = g.parentId ? goal(g.parentId) : null; }
      return out;
    }
    function depth(id) { return path(id).length - 1; }
    function milestonesOf(id) { return msMap.get(id) || []; }
    function actionsOf(id) { return actMap.get(id) || []; }
    function entriesOf(id) { return entMap.get(id) || []; }
    function dependenciesOf(id) {
      return db.dependencies.filter((d) => d.goalId === id).map((d) => ({ dep: d, goal: goal(d.dependsOnId) })).filter((x) => x.goal);
    }
    function dependentsOf(id) {
      return db.dependencies.filter((d) => d.dependsOnId === id).map((d) => ({ dep: d, goal: goal(d.goalId) })).filter((x) => x.goal);
    }
    function blockers(id) {
      return dependenciesOf(id).map((x) => x.goal).filter((g) => g.status !== "completed" && g.status !== "archived");
    }
    function subgoalCounts(id) {
      const list = children(id);
      return { done: list.filter((c) => c.status === "completed").length, total: list.length };
    }

    // Returns a full measurement result for a goal. Memoized per engine (engine is rebuilt after each mutation).
    function measure(id, stack) {
      if (memo.has(id)) return memo.get(id);
      const g = goal(id);
      if (!g) return { type: "none", valid: false, pct: null, issues: ["Missing goal"] };
      stack = stack || new Set();
      if (stack.has(id)) return { type: "none", valid: false, pct: null, issues: ["Cycle"] };
      stack.add(id);
      const result = compute(g, stack);
      result.fmt = fmtOf(g);
      result.subgoals = subgoalCounts(id);
      result.completed = g.status === "completed";
      memo.set(id, result);
      return result;
    }

    function compute(g, stack) {
      const issues = [];
      const def = M.MEASUREMENT_TYPES[g.measurementType];

      if (g.measurementType === "binary") {
        return { type: "binary", valid: true, pct: g.status === "completed" ? 1 : 0, issues };
      }

      if (g.measurementType === "milestones") {
        const ms = milestonesOf(g.id);
        if (ms.length) {
          const total = ms.reduce((a, m) => a + m.weight, 0);
          const done = ms.filter((m) => m.status === "completed").reduce((a, m) => a + m.weight, 0);
          const weighted = ms.some((m) => m.weight !== 1);
          return {
            type: "milestones", valid: true, pct: g.status === "completed" ? 1 : (total ? done / total : 0), issues,
            done: ms.filter((m) => m.status === "completed").length, total: ms.length, weighted,
          };
        }
        const sc = subgoalCounts(g.id);
        if (sc.total) {
          return { type: "subgoals", valid: true, pct: g.status === "completed" ? 1 : sc.done / sc.total, issues, done: sc.done, total: sc.total };
        }
        if (g.status === "completed") return { type: "milestones", valid: true, pct: 1, issues, done: 0, total: 0 };
        issues.push("Add milestones or subgoals to measure progress.");
        return { type: "milestones", valid: false, pct: null, issues, done: 0, total: 0 };
      }

      // Numeric family: currency / numeric / percentage / custom
      if (def && def.numeric && g.rollup) {
        const fmt = fmtOf(g);
        const ownDir = g.startValue != null && g.targetValue != null && g.startValue !== g.targetValue
          ? (g.targetValue < g.startValue ? "decrease" : "increase") : null;
        const included = [], excluded = [];
        children(g.id).forEach((c) => {
          const cm = measure(c.id, stack);
          const ok = cm.type === "numeric" && cm.valid && sameMeasure(fmtOf(c), fmt);
          if (ok && (!ownDir || cm.direction === ownDir) && (!included.length || included[0].m.direction === cm.direction)) included.push({ g: c, m: cm });
          else excluded.push({ g: c, reason: !ok ? (cm.type !== "numeric" ? "different measurement" : !cm.valid ? "not measurable yet" : "different unit/currency") : "opposite direction" });
        });
        if (included.length) {
          const childStart = included.reduce((a, x) => a + x.m.start, 0);
          const childTarget = included.reduce((a, x) => a + x.m.target, 0);
          const childCurrent = included.reduce((a, x) => a + x.m.current, 0);
          const start = g.startValue != null ? g.startValue : childStart;
          const target = g.targetValue != null ? g.targetValue : childTarget;
          // Apply the subgoals' net change to the parent's own baseline, so a parent baseline that differs
          // from the subgoal total never shows phantom progress.
          const current = U.round2(start + (childCurrent - childStart));
          const core = numericCore(start, current, target);
          if (!core.valid) issues.push(core.issue);
          if (g.startValue != null && Math.abs(childStart - g.startValue) > EPS) {
            issues.push(`Subgoals account for ${U.fmtValue(childStart, fmt)} of the ${U.fmtValue(g.startValue, fmt)} starting value; the rest isn't tracked by a subgoal.`);
          }
          if (excluded.length) issues.push(`${U.plural(excluded.length, "subgoal")} not included (${excluded.map((x) => x.reason).filter((v, i, a) => a.indexOf(v) === i).join(", ")}).`);
          return Object.assign({ type: "numeric", rollup: true, issues, aggregate: { included: included.map((x) => x.g.id), excluded: excluded.map((x) => x.g.id), childStart, childCurrent } }, core);
        }
        issues.push("No compatible subgoals to total yet — using this goal's own values.");
      }

      if (def && def.numeric) {
        const core = numericCore(g.startValue, g.currentValue, g.targetValue);
        if (!core.valid) issues.push(core.issue);
        if (core.valid && g.status === "completed" && !core.reached) issues.push("Marked complete before reaching the target value.");
        return Object.assign({ type: "numeric", rollup: false, issues }, core);
      }
      return { type: "none", valid: false, pct: null, issues: ["Unknown measurement type."] };
    }

    // Direction-aware progress amount (for milestone thresholds like "Pay down $1,500").
    function progressedAmount(id) {
      const m = measure(id);
      return m.type === "numeric" && m.valid ? m.progressed : null;
    }

    // Aggregates across top-level goals ONLY where mathematically valid: same measurement, unit/currency and direction.
    function portfolio(goalList) {
      const groups = new Map();
      const counts = { goals: 0, completed: 0, numeric: 0, other: 0 };
      goalList.forEach((g) => {
        counts.goals++;
        if (g.status === "completed") counts.completed++;
        const m = measure(g.id);
        if (m.type !== "numeric" || !m.valid) { counts.other++; return; }
        counts.numeric++;
        const key = [g.measurementType, g.currency, (g.unit || "").toLowerCase(), m.direction].join("|");
        if (!groups.has(key)) groups.set(key, { fmt: fmtOf(g), direction: m.direction, goals: [], progressed: 0, total: 0, remaining: 0 });
        const grp = groups.get(key);
        grp.goals.push(g);
        grp.progressed += Math.max(0, Math.min(m.progressed, m.total));
        grp.total += m.total;
        grp.remaining += m.remaining;
      });
      groups.forEach((grp) => { grp.pct = grp.total ? grp.progressed / grp.total : 0; });
      return { groups: Array.from(groups.values()), counts };
    }

    return {
      db, goal, children, descendants, path, depth, milestonesOf, actionsOf, entriesOf,
      dependenciesOf, dependentsOf, blockers, subgoalCounts, measure, progressedAmount, portfolio,
      isOpen, isLive, fmtOf,
    };
  }

  A.progress = { createEngine, numericCore, sameMeasure, isOpen, isLive, fmtOf };
})(typeof window !== "undefined" ? window.Arcus : globalThis.Arcus);
