/* Arcus — insights: urgency, transparent priority rules, financial estimates, projections, recommendations.
   Pure functions over a progress engine. */
(function (A) {
  "use strict";
  const U = A.util;
  const M = A.model;

  const URGENCY = {
    overdue: { label: "Overdue", tone: "bad" },
    urgent:  { label: "Due soon", tone: "warn" },
    soon:    { label: "Upcoming", tone: "warn" },
    normal:  { label: "On schedule", tone: "" },
    none:    { label: "No date", tone: "" },
  };
  const PACE_WINDOW_DAYS = 90;

  function urgencyFromDays(days) {
    if (days === null || days === undefined) return "none";
    if (days < 0) return "overdue";
    if (days <= 14) return "urgent";
    if (days <= 45) return "soon";
    return "normal";
  }

  function isDebt(g) { return g.category === "debt" && g.measurementType === "currency"; }

  // The date that matters most for a goal: its target date, or (for debt) an earlier promo expiration.
  function keyDate(g) {
    const out = [];
    if (g.targetDate) out.push({ date: g.targetDate, kind: "target", label: "Target date" });
    if (isDebt(g) && g.finance.promoEndDate && U.daysUntil(g.finance.promoEndDate) >= 0) {
      out.push({ date: g.finance.promoEndDate, kind: "promo", label: "Promo APR ends" });
    }
    if (!out.length) return null;
    // Earliest first; on a tie the promo expiry is the more specific (and more costly) deadline.
    out.sort((a, b) => a.date.localeCompare(b.date) || (a.kind === "promo" ? -1 : 1));
    const k = out[0];
    k.days = U.daysUntil(k.date);
    k.urgency = urgencyFromDays(k.days);
    return k;
  }

  function urgencyOf(g) {
    if (g.status === "completed" || g.status === "archived") return { level: "none", key: null };
    const k = keyDate(g);
    return { level: k ? k.urgency : "none", key: k };
  }

  // Recent pace in the goal's progress direction, from the immutable progress history.
  function pace(engine, id) {
    const g = engine.goal(id);
    const m = engine.measure(id);
    if (!g || m.type !== "numeric" || !m.valid) return null;
    const sources = m.rollup && m.aggregate ? m.aggregate.included : [id];
    const sign = m.direction === "decrease" ? -1 : 1;
    const cutoff = U.isoOffset(-PACE_WINDOW_DAYS);
    const recent = [];
    sources.forEach((sid) => engine.entriesOf(sid).forEach((e) => { if (e.date >= cutoff && e.changeAmount != null) recent.push(e); }));
    if (!recent.length) return { perDay: 0, perMonth: 0, entries: 0, windowDays: PACE_WINDOW_DAYS };
    recent.sort((a, b) => a.date.localeCompare(b.date));
    const oldestAge = -U.daysUntil(recent[0].date);
    if (recent.length < 2 && oldestAge < 7) return null; // not enough history to extrapolate
    const gained = recent.reduce((a, e) => a + sign * e.changeAmount, 0);
    const span = Math.max(30, oldestAge);
    const perDay = gained / span;
    return { perDay, perMonth: perDay * 30.44, entries: recent.length, windowDays: span };
  }

  // Schedule assessment: required pace vs. recent pace, projected completion.
  function assess(engine, id) {
    const g = engine.goal(id);
    const m = engine.measure(id);
    const res = { status: "noData", key: keyDate(g), pace: null, required: null, eta: null };
    if (!g || m.type !== "numeric" || !m.valid) { res.status = "notNumeric"; return res; }
    if (g.status === "completed" || m.reached) { res.status = "done"; return res; }
    const p = pace(engine, id);
    res.pace = p;
    const k = res.key;
    if (k && k.days !== null) {
      if (k.days < 0) res.status = "overdue";
      const months = Math.max(k.days, 1) / 30.44;
      res.required = { perMonth: m.remaining / months, perWeek: m.remaining / (Math.max(k.days, 1) / 7), by: k };
    }
    if (p && p.perDay > 0) {
      const days = Math.ceil(m.remaining / p.perDay);
      res.eta = { days, date: U.isoOffset(days) };
    }
    if (res.status === "overdue") return res;
    if (!k) { res.status = p ? "noDate" : "noData"; return res; }
    if (!p) { res.status = "noData"; return res; }
    if (p.perDay <= 0) { res.status = "stalled"; return res; }
    res.status = res.eta.days <= k.days ? "onTrack" : "behind";
    return res;
  }

  // ---------- Financial estimates (manual inputs; always labeled as estimates) ----------
  function statementDatesBetween(fromIso, toIso, day, inclusiveEnd) {
    const out = [];
    const from = U.parseDate(fromIso), to = U.parseDate(toIso);
    if (!from || !to || !day) return out;
    let y = from.getFullYear(), mo = from.getMonth();
    for (let i = 0; i < 600; i++) {
      const last = new Date(y, mo + 1, 0).getDate();
      const d = new Date(y, mo, Math.min(day, last));
      if (d > from && (inclusiveEnd ? d <= to : d < to)) out.push(U.localISO(d));
      if (d > to) break;
      mo++; if (mo > 11) { mo = 0; y++; }
    }
    return out;
  }
  function amortizedPayment(balance, aprPct, months) {
    if (months <= 0) return balance;
    const r = (aprPct || 0) / 100 / 12;
    if (r <= 0) return balance / months;
    return (r * balance) / (1 - Math.pow(1 + r, -months));
  }
  function payoffMonths(balance, aprPct, payment) {
    const r = (aprPct || 0) / 100 / 12;
    if (payment <= 0) return Infinity;
    if (r <= 0) return Math.ceil(balance / payment);
    if (payment <= r * balance) return Infinity;
    return Math.ceil(-Math.log(1 - (r * balance) / payment) / Math.log(1 + r));
  }

  function financePlan(engine, id) {
    const g = engine.goal(id);
    if (!g || !isDebt(g)) return null;
    const m = engine.measure(id);
    if (m.type !== "numeric" || !m.valid) return null;
    const f = g.finance;
    const fmt = engine.fmtOf(g);
    const balance = m.remaining;
    const items = [];
    const warnings = [];
    const today = U.todayISO();
    if (balance <= 0) return { items: [{ label: "Balance", value: "Paid off" }], warnings, estimate: false };

    if (f.promoEndDate) {
      const days = U.daysUntil(f.promoEndDate);
      if (days > 0) {
        let payments, basis;
        if (f.statementDay) {
          payments = statementDatesBetween(today, f.promoEndDate, f.statementDay, !f.promoEndsBeforeStatement).length;
          basis = `${U.plural(payments, "statement")} ${f.promoEndsBeforeStatement ? "close before" : "close by"} ${U.fmtDate(f.promoEndDate)}`;
        } else {
          payments = Math.floor(days / 30.44);
          basis = `${U.plural(payments, "full month")} until ${U.fmtDate(f.promoEndDate)}`;
        }
        if (payments < 1) {
          warnings.push({ tone: "bad", text: `No statement cycles remain before the promo rate ends — the full ${U.fmtValue(balance, fmt)} would need to be paid now to avoid promo-end interest.` });
        } else {
          items.push({ label: "Required to clear before promo ends", value: U.fmtMoney(Math.ceil(balance / payments * 100) / 100, g.currency, { cents: true }) + "/mo", note: basis, emphasis: true });
        }
        if (f.deferredInterest) {
          warnings.push({ tone: "bad", text: "Deferred interest applies: if any balance remains when the promo ends, interest accrued since the purchase date may be charged." });
        }
        if (f.apr != null) items.push({ label: "Rate after promo", value: f.apr + "% APR" });
      } else if (days <= 0) {
        warnings.push({ tone: "warn", text: `The promotional rate ended ${U.fmtDate(f.promoEndDate)}.` });
      }
    }

    // Payment to hit the goal's own target date. If the promo outlasts the target date the promo rate applies;
    // otherwise use the standard APR (a simplification — clearly labeled as an estimate).
    const promoItemShown = items.some((x) => x.emphasis);
    const sameAsPromo = promoItemShown && f.promoEndDate === g.targetDate;
    if (!sameAsPromo && g.targetDate && U.daysUntil(g.targetDate) > 0 && (f.apr != null || f.promoApr != null || f.promoEndDate)) {
      const promoCovers = f.promoEndDate && f.promoEndDate >= g.targetDate;
      const apr = promoCovers ? (f.promoApr || 0) : (f.apr != null ? f.apr : (f.promoApr || 0));
      const months = Math.max(1, Math.round(U.daysUntil(g.targetDate) / 30.44));
      const pmt = amortizedPayment(balance, apr, months);
      items.push({ label: `Payment to reach target by ${U.fmtShort(g.targetDate)}`, value: U.fmtMoney(Math.ceil(pmt * 100) / 100, g.currency, { cents: true }) + "/mo", note: `${U.plural(months, "payment")} at ${apr}% APR` });
    }
    if (f.minimumPayment && f.apr != null) {
      const n = payoffMonths(balance, f.apr, f.minimumPayment);
      if (n === Infinity) {
        warnings.push({ tone: "bad", text: `The minimum payment (${U.fmtMoney(f.minimumPayment, g.currency)}) doesn't cover monthly interest at ${f.apr}% APR — the balance would never be paid off.` });
      } else {
        const interest = f.minimumPayment * n - balance;
        items.push({ label: "Paying only the minimum", value: `${U.humanDays(n * 30.44)}`, note: `≈ ${U.fmtMoney(Math.max(0, interest), g.currency)} interest at ${f.apr}% APR` });
      }
    }
    return { items, warnings, estimate: true };
  }

  // ---------- Priority: transparent, additive rules ----------
  function priorityOf(engine, id) {
    const g = engine.goal(id);
    const reasons = [];
    const add = (points, text, tone) => reasons.push({ points, text, tone: tone || "" });
    const P = M.PRIORITIES[g.priority];
    add(P.weight, `${P.label} priority`, g.priority === "critical" ? "bad" : g.priority === "high" ? "warn" : "");
    const u = urgencyOf(g);
    if (u.key) {
      const d = u.key.days;
      const what = u.key.kind === "promo" ? "Promo APR ends" : "Target date";
      if (d < 0) add(30, `${what} passed ${U.humanDays(d)} ago`, "bad");
      else if (d <= 14) add(25, `${what} ${U.relDays(d)}`, "bad");
      else if (d <= 45) add(15, `${what} ${U.relDays(d)}`, "warn");
      else if (d <= 90) add(8, `${what} ${U.relDays(d)}`, "warn");
    }
    if (isDebt(g)) {
      const f = g.finance;
      if (f.promoEndDate && u.key && u.key.kind !== "promo") {
        const pd = U.daysUntil(f.promoEndDate);
        if (pd >= 0 && pd <= 90) add(10, `Promo APR ends ${U.relDays(pd)}`, "warn");
      }
      if (f.deferredInterest && f.promoEndDate && U.daysUntil(f.promoEndDate) >= 0) add(5, "Deferred interest at risk", "bad");
      if (f.apr != null && f.apr >= 20) add(5, `High APR (${f.apr}%)`, "warn");
    }
    const a = assess(engine, id);
    if (a.status === "behind") add(8, "Behind the pace needed", "warn");
    if (a.status === "stalled") add(6, "No recent progress", "warn");
    const blockers = engine.blockers(id);
    const score = reasons.reduce((s, r) => s + r.points, 0);
    return { score, reasons, blocked: blockers.length > 0, blockers, urgency: u, assessment: a };
  }

  // Actionable = active goal without active subgoals (the leaves of the active tree).
  function actionableGoals(engine) {
    return engine.db.goals.filter((g) => {
      if (g.status !== "active") return false;
      if (engine.path(g.id).some((p) => p.status !== "active")) return false;
      return !engine.children(g.id).some((c) => c.status === "active");
    });
  }

  function recommendations(engine) {
    const ranked = actionableGoals(engine).map((g) => ({ goal: g, p: priorityOf(engine, g.id) }));
    const orderKey = (g) => engine.path(g.id).map((x) => String(x.sortOrder).padStart(5, "0")).join(".");
    ranked.sort((a, b) =>
      (a.p.blocked - b.p.blocked) || (b.p.score - a.p.score) ||
      (M.PRIORITIES[a.goal.priority].rank - M.PRIORITIES[b.goal.priority].rank) || orderKey(a.goal).localeCompare(orderKey(b.goal)));
    return { ready: ranked.filter((x) => !x.p.blocked), blocked: ranked.filter((x) => x.p.blocked) };
  }

  function currentFocus(engine) {
    const db = engine.db;
    const pinned = db.focusGoalId ? engine.goal(db.focusGoalId) : null;
    if (pinned && engine.isOpen(pinned)) return { goal: pinned, pinned: true, p: priorityOf(engine, pinned.id) };
    const r = recommendations(engine).ready[0];
    return r ? { goal: r.goal, pinned: false, p: r.p } : null;
  }

  function actionSort(a, b) {
    const da = a.dueDate || "9999-12-31", dbb = b.dueDate || "9999-12-31";
    return da.localeCompare(dbb) || (M.PRIORITIES[a.priority].rank - M.PRIORITIES[b.priority].rank) || a.sortOrder - b.sortOrder;
  }
  function nextActions(engine, id, limit) {
    const ids = [id].concat(engine.descendants(id).filter((g) => engine.isOpen(g)).map((g) => g.id));
    const list = [];
    ids.forEach((gid) => engine.actionsOf(gid).forEach((a) => { if (a.status === "open") list.push(a); }));
    list.sort(actionSort);
    return limit ? list.slice(0, limit) : list;
  }

  function deadlines(engine, horizon) {
    horizon = horizon == null ? 45 : horizon;
    const out = [];
    const within = (d) => d !== null && d <= horizon;
    engine.db.goals.forEach((g) => {
      if (!engine.isOpen(g)) return;
      if (g.targetDate && within(U.daysUntil(g.targetDate))) out.push({ kind: "goal", date: g.targetDate, days: U.daysUntil(g.targetDate), goal: g, label: "Target date" });
      if (isDebt(g) && g.finance.promoEndDate) {
        const d = U.daysUntil(g.finance.promoEndDate);
        if (d >= 0 && within(d)) out.push({ kind: "promo", date: g.finance.promoEndDate, days: d, goal: g, label: "Promo APR ends" });
      }
    });
    engine.db.milestones.forEach((m) => {
      const g = engine.goal(m.goalId);
      if (m.status === "open" && m.dueDate && g && engine.isOpen(g) && within(U.daysUntil(m.dueDate))) out.push({ kind: "milestone", date: m.dueDate, days: U.daysUntil(m.dueDate), goal: g, item: m, label: m.name });
    });
    engine.db.actions.forEach((a) => {
      const g = engine.goal(a.goalId);
      if (a.status === "open" && a.dueDate && g && engine.isOpen(g) && within(U.daysUntil(a.dueDate))) out.push({ kind: "action", date: a.dueDate, days: U.daysUntil(a.dueDate), goal: g, item: a, label: a.name });
    });
    out.sort((a, b) => a.date.localeCompare(b.date));
    return out;
  }

  function atRisk(engine) {
    const out = [];
    engine.db.goals.forEach((g) => {
      if (g.status !== "active") return;
      const a = assess(engine, g.id);
      const u = urgencyOf(g);
      if (u.level === "overdue") out.push({ goal: g, tone: "bad", text: `${u.key.label} passed ${U.fmtDate(u.key.date)}` });
      else if (a.status === "behind") out.push({ goal: g, tone: "warn", text: `Projected ${U.fmtMonthYear(a.eta.date)} — after ${U.fmtDate(a.key.date)}` });
      else if (a.status === "stalled" && u.key && u.key.days <= 90) out.push({ goal: g, tone: "warn", text: `No progress in ${a.pace.windowDays} days; due ${U.relDays(u.key.days)}` });
      const blockers = engine.blockers(g.id);
      if (blockers.length && u.key && u.key.days <= 60) out.push({ goal: g, tone: "warn", text: `Blocked by ${blockers.map((b) => b.name).join(", ")}` });
      const plan = financePlan(engine, g.id);
      if (plan) plan.warnings.filter((w) => w.tone === "bad").forEach((w) => out.push({ goal: g, tone: "bad", text: w.text }));
    });
    return out;
  }

  function activity(engine, limit) {
    const out = [];
    engine.db.entries.forEach((e) => {
      const g = engine.goal(e.goalId);
      if (g) out.push({ kind: "entry", date: e.date, at: e.createdAt, goal: g, entry: e });
    });
    engine.db.goals.forEach((g) => { if (g.status === "completed" && g.completedDate) out.push({ kind: "goal", date: g.completedDate, at: g.updatedAt, goal: g }); });
    engine.db.milestones.forEach((m) => {
      const g = engine.goal(m.goalId);
      if (g && m.status === "completed" && m.completedDate) out.push({ kind: "milestone", date: m.completedDate, at: m.completedDate, goal: g, item: m });
    });
    engine.db.actions.forEach((a) => {
      const g = engine.goal(a.goalId);
      if (g && a.status === "done" && a.completedDate) out.push({ kind: "action", date: a.completedDate, at: a.completedDate, goal: g, item: a });
    });
    out.sort((a, b) => b.date.localeCompare(a.date) || String(b.at).localeCompare(String(a.at)));
    return limit ? out.slice(0, limit) : out;
  }

  A.insights = {
    URGENCY, urgencyFromDays, urgencyOf, keyDate, isDebt, pace, assess,
    statementDatesBetween, amortizedPayment, payoffMonths, financePlan,
    priorityOf, actionableGoals, recommendations, currentFocus, nextActions, actionSort, deadlines, atRisk, activity,
  };
})(typeof window !== "undefined" ? window.Arcus : globalThis.Arcus);
