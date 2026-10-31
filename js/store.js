/* Arcus — application services & persistence.
   All mutations go through here: they validate, keep the progress history immutable, cascade completion,
   then persist and rebuild the engine. UI code never edits the db directly. */
(function (A) {
  "use strict";
  const U = A.util;
  const M = A.model;

  const STORE_KEY = "arcus_cloud_goals";
  let db = M.emptyDb();
  let engine = A.progress.createEngine(db);
  let storage = null;
  const listeners = [];

  class ValidationError extends Error {}
  function fail(msg) { throw new ValidationError(msg); }

  function init(opts) {
    storage = (opts && opts.storage) || (typeof localStorage !== "undefined" ? localStorage : null);
    load();
  }
  function load() {
    let raw = null;
    try { raw = storage ? JSON.parse(storage.getItem(STORE_KEY) || "null") : null; } catch (e) { raw = null; }
    db = M.normalizeDb(raw);
    engine = A.progress.createEngine(db);
  }
  function persist() {
    if (!storage) return;
    try { storage.setItem(STORE_KEY, JSON.stringify(db)); }
    catch (e) { throw new ValidationError("Couldn't save — browser storage may be full."); }
  }
  function commit() {
    engine = A.progress.createEngine(db);
    persist();
    listeners.forEach((fn) => { try { fn(); } catch (e) { /* listener errors must not break saves */ } });
  }
  function onChange(fn) { listeners.push(fn); }
  function replaceDb(next) {
    db = M.normalizeDb(next);
    commit();
  }
  function getDb() { return db; }
  function eng() { return engine; }
  function now() { return new Date().toISOString(); }
  function touch(g) { g.updatedAt = now(); }
  function goalOrFail(id) { const g = db.goals.find((x) => x.id === id); if (!g) fail("That goal no longer exists."); return g; }
  function nextSort(list) { return list.length ? Math.max.apply(null, list.map((x) => x.sortOrder)) + 1 : 0; }

  // ---------- Goals ----------
  function validateGoalFields(f, existingId) {
    const name = String(f.name || "").trim();
    if (!name) fail("Give the goal a name.");
    const type = f.measurementType;
    if (!M.MEASUREMENT_TYPES[type]) fail("Choose how progress is measured.");
    if (f.parentId) {
      if (!db.goals.some((g) => g.id === f.parentId)) fail("The parent goal no longer exists.");
      if (existingId && (f.parentId === existingId || engine.descendants(existingId, { includeArchived: true }).some((d) => d.id === f.parentId))) {
        fail("A goal can't be placed under itself or one of its own subgoals.");
      }
    }
    if (M.MEASUREMENT_TYPES[type].numeric) {
      const s = U.numOrNull(f.startValue), t = U.numOrNull(f.targetValue);
      if (!f.rollup && (s == null || t == null)) fail("Enter a starting value and a target value.");
      if (s != null && t != null && s === t) fail("The starting and target values must be different.");
      if (type === "custom" && !String(f.unit || "").trim()) fail("Enter the custom unit (e.g. \"chapters\").");
    }
    if (f.startDate && f.targetDate && f.targetDate < f.startDate) fail("The target date can't be before the start date.");
    const fin = f.finance || {};
    ["apr", "promoApr"].forEach((k) => {
      const v = U.numOrNull(fin[k]);
      if (v != null && (v < 0 || v > 100)) fail("APR must be between 0 and 100%.");
    });
    if (U.numOrNull(fin.minimumPayment) != null && U.numOrNull(fin.minimumPayment) < 0) fail("Minimum payment can't be negative.");
    return name;
  }

  function applyGoalFields(g, f) {
    g.name = String(f.name).trim().slice(0, 200);
    g.description = String(f.description || "").trim().slice(0, 4000);
    g.measurementType = f.measurementType;
    const numeric = M.MEASUREMENT_TYPES[g.measurementType].numeric;
    g.currency = M.CURRENCIES.includes(f.currency) ? f.currency : "USD";
    g.unit = g.measurementType === "custom" || g.measurementType === "numeric" ? String(f.unit || "").trim().slice(0, 24) : "";
    g.rollup = numeric && !!f.rollup;
    g.startValue = numeric ? U.numOrNull(f.startValue) : null;
    g.targetValue = numeric ? U.numOrNull(f.targetValue) : null;
    g.priority = M.PRIORITIES[f.priority] ? f.priority : "medium";
    g.category = g.measurementType === "currency" && f.category === "debt" ? "debt" : "general";
    g.finance = M.normalizeFinance(g.category === "debt" ? f.finance : {});
    g.startDate = U.isISODate(f.startDate) ? f.startDate : "";
    g.targetDate = U.isISODate(f.targetDate) ? f.targetDate : "";
  }

  function createGoal(f) {
    validateGoalFields(f, null);
    const parentId = f.parentId || null;
    const g = M.normalizeGoal({ parentId, sortOrder: nextSort(engine.children(parentId, { includeArchived: true })) });
    applyGoalFields(g, f);
    g.parentId = parentId;
    g.status = f.status && M.GOAL_STATUSES[f.status] && f.status !== "completed" ? f.status : "active";
    const numeric = M.MEASUREMENT_TYPES[g.measurementType].numeric;
    const cur = numeric ? U.numOrNull(f.currentValue) : null;
    g.currentValue = numeric ? (cur != null ? cur : g.startValue) : null;
    db.goals.push(g);
    if (numeric && !g.rollup && cur != null && g.startValue != null && cur !== g.startValue) {
      db.entries.push(M.normalizeEntry({
        goalId: g.id, date: U.todayISO(), previousValue: g.startValue, newValue: cur,
        entryType: "adjustment", notes: "Current value when the goal was created",
      }));
    }
    commit();
    return g;
  }

  function updateGoal(id, f) {
    const g = goalOrFail(id);
    validateGoalFields(f, id);
    const prevParent = g.parentId;
    const prevCurrent = g.currentValue;
    applyGoalFields(g, f);
    const newParent = f.parentId || null;
    if (newParent !== prevParent) {
      g.parentId = newParent;
      g.sortOrder = nextSort(engine.children(newParent, { includeArchived: true }));
    }
    const numeric = M.MEASUREMENT_TYPES[g.measurementType].numeric;
    if (!numeric) g.currentValue = null;
    else if (!g.rollup) {
      const cur = U.numOrNull(f.currentValue);
      const next = cur != null ? cur : (prevCurrent != null ? prevCurrent : g.startValue);
      // Manual edits to the current value are recorded, never silent.
      if (prevCurrent != null && next !== prevCurrent) {
        db.entries.push(M.normalizeEntry({ goalId: g.id, date: U.todayISO(), previousValue: prevCurrent, newValue: next, entryType: "adjustment", notes: "Edited in goal settings" }));
      }
      g.currentValue = next;
    }
    touch(g);
    renumber(prevParent);
    renumber(newParent);
    const result = afterValueChange(g.id, U.todayISO());
    commit();
    return Object.assign({ goal: g }, result);
  }

  function renumber(parentId) {
    engine = A.progress.createEngine(db);
    engine.children(parentId, { includeArchived: true }).forEach((c, i) => { c.sortOrder = i; });
  }

  // Re-evaluates milestones and completion after a goal's value changes; cascades to roll-up ancestors.
  function afterValueChange(goalId, date) {
    engine = A.progress.createEngine(db);
    const completed = [], reopened = [], milestonesReached = [], milestonesReopened = [];
    const chain = engine.path(goalId).reverse(); // self first, then ancestors
    chain.forEach((g) => {
      engine = A.progress.createEngine(db);
      const progressed = engine.progressedAmount(g.id);
      if (progressed != null) {
        db.milestones.filter((m) => m.goalId === g.id && m.targetValue != null).forEach((m) => {
          const hit = progressed >= m.targetValue - 1e-9;
          if (hit && m.status === "open") { m.status = "completed"; m.auto = true; m.completedDate = date; milestonesReached.push(m); }
          else if (!hit && m.status === "completed" && m.auto) { m.status = "open"; m.auto = false; m.completedDate = ""; milestonesReopened.push(m); }
        });
      }
      engine = A.progress.createEngine(db);
      const meas = engine.measure(g.id);
      const isNumeric = meas.type === "numeric" && meas.valid;
      if (isNumeric && meas.reached && (g.status === "active" || g.status === "onHold") && (g.id === goalId || g.rollup)) {
        g.status = "completed"; g.completedDate = date; touch(g); completed.push(g);
      } else if (isNumeric && !meas.reached && g.status === "completed" && g.id === goalId && g.completedAutomatically) {
        g.status = "active"; g.completedDate = ""; touch(g); reopened.push(g);
      }
    });
    completed.forEach((g) => { g.completedAutomatically = true; });
    return { completed, reopened, milestonesReached, milestonesReopened };
  }

  // ---------- Progress entries (immutable history) ----------
  function recordProgress(goalId, opts) {
    const g = goalOrFail(goalId);
    const meas = engine.measure(goalId);
    if (!M.MEASUREMENT_TYPES[g.measurementType].numeric) fail("This goal isn't measured by a number — complete milestones or mark it done instead.");
    if (g.rollup && meas.aggregate) fail("This goal totals its subgoals — record progress on a subgoal.");
    if (meas.type !== "numeric" || !meas.valid) fail(meas.issues[0] || "Set starting and target values first.");
    if (g.status === "archived") fail("Restore this goal before recording progress.");
    const amount = U.numOrNull(opts.amount);
    if (amount == null) fail("Enter an amount.");
    const date = U.isISODate(opts.date) ? opts.date : U.todayISO();
    if (date > U.isoOffset(1)) fail("Progress can't be recorded in the future.");
    const prev = g.currentValue != null ? g.currentValue : g.startValue;
    let next;
    if (opts.mode === "set") next = amount;
    else {
      if (amount <= 0) fail("Enter a positive amount (use \"Setback\" for changes that move away from the target).");
      const sign = meas.direction === "decrease" ? -1 : 1;
      next = prev + sign * amount * (opts.setback ? -1 : 1);
    }
    next = U.round2(next);
    if (next === prev) fail("That doesn't change the current value.");
    const entry = M.normalizeEntry({
      goalId, date, previousValue: prev, newValue: next, entryType: M.ENTRY_TYPES[opts.entryType] ? opts.entryType : (g.category === "debt" && !opts.setback && opts.mode !== "set" ? "payment" : "progress"),
      notes: String(opts.notes || "").trim(),
    });
    db.entries.push(entry);
    g.currentValue = next;
    touch(g);
    const result = afterValueChange(goalId, date);
    commit();
    return Object.assign({ entry }, result);
  }

  // Reverses an entry by appending a correction (history stays intact).
  function correctEntry(entryId, notes) {
    const e = db.entries.find((x) => x.id === entryId);
    if (!e) fail("Entry not found.");
    if (e.entryType === "correction") fail("Corrections can't be corrected — record a new entry instead.");
    if (db.entries.some((x) => x.correctsId === entryId)) fail("This entry has already been corrected.");
    const g = goalOrFail(e.goalId);
    if (e.changeAmount == null) fail("This entry has no value change to reverse.");
    const prev = g.currentValue;
    const next = U.round2(prev - e.changeAmount);
    db.entries.push(M.normalizeEntry({
      goalId: g.id, date: U.todayISO(), previousValue: prev, newValue: next, entryType: "correction", correctsId: e.id,
      notes: String(notes || "").trim() || `Reverses ${U.fmtDate(e.date)} entry`,
    }));
    g.currentValue = next;
    touch(g);
    const result = afterValueChange(g.id, U.todayISO());
    commit();
    return result;
  }

  // ---------- Status ----------
  function completeGoal(id, opts) {
    const g = goalOrFail(id);
    const date = (opts && U.isISODate(opts.date)) ? opts.date : U.todayISO();
    const meas = engine.measure(id);
    if (opts && opts.recordFinal && meas.type === "numeric" && meas.valid && !meas.rollup && !meas.reached) {
      db.entries.push(M.normalizeEntry({ goalId: id, date, previousValue: g.currentValue, newValue: g.targetValue, entryType: "completion", notes: "Final value recorded when marked complete" }));
      g.currentValue = g.targetValue;
    }
    g.status = "completed";
    g.completedDate = date;
    g.completedAutomatically = false;
    touch(g);
    const result = afterValueChange(id, date);
    commit();
    return result;
  }
  function setStatus(id, status) {
    const g = goalOrFail(id);
    if (!M.GOAL_STATUSES[status]) fail("Unknown status.");
    if (status === "completed") return completeGoal(id);
    g.status = status;
    if (status !== "completed") { g.completedDate = ""; g.completedAutomatically = false; }
    if (status === "archived") {
      engine.descendants(id, { includeArchived: true }).forEach((d) => { if (d.status !== "completed") d.status = "archived"; touch(d); });
      if (db.focusGoalId && (db.focusGoalId === id || engine.descendants(id).some((d) => d.id === db.focusGoalId))) db.focusGoalId = null;
    }
    touch(g);
    commit();
    return {};
  }
  function restoreGoal(id) {
    const g = goalOrFail(id);
    g.status = "active";
    engine.descendants(id, { includeArchived: true }).forEach((d) => { if (d.status === "archived") { d.status = "active"; touch(d); } });
    touch(g);
    commit();
  }

  function deleteGoal(id) {
    goalOrFail(id);
    const gone = new Set([id].concat(engine.descendants(id, { includeArchived: true }).map((d) => d.id)));
    const parentId = db.goals.find((g) => g.id === id).parentId;
    db.goals = db.goals.filter((g) => !gone.has(g.id));
    db.milestones = db.milestones.filter((m) => !gone.has(m.goalId));
    db.actions = db.actions.filter((a) => !gone.has(a.goalId));
    db.entries = db.entries.filter((e) => !gone.has(e.goalId));
    db.dependencies = db.dependencies.filter((d) => !gone.has(d.goalId) && !gone.has(d.dependsOnId));
    if (gone.has(db.focusGoalId)) db.focusGoalId = null;
    renumber(parentId);
    commit();
    return parentId;
  }

  // ---------- Ordering ----------
  function reorder(list, id, toIndex) {
    const item = list.find((x) => x.id === id);
    const rest = list.filter((x) => x.id !== id);
    rest.splice(U.clamp(toIndex, 0, rest.length), 0, item);
    rest.forEach((x, i) => { x.sortOrder = i; });
  }
  function moveGoal(id, delta) {
    const g = goalOrFail(id);
    const sibs = engine.children(g.parentId, { includeArchived: true });
    reorder(sibs, id, sibs.indexOf(g) + delta);
    commit();
  }
  function moveGoalBefore(id, targetId) {
    const g = goalOrFail(id), t = goalOrFail(targetId);
    if (g.parentId !== t.parentId || id === targetId) return;
    const sibs = engine.children(g.parentId, { includeArchived: true });
    // Dropping onto a sibling takes its slot (items below shift down, items above shift up).
    reorder(sibs, id, sibs.indexOf(t));
    commit();
  }
  function setFocus(id) {
    if (id) { const g = goalOrFail(id); if (!engine.isOpen(g)) fail("Only open goals can be the current focus."); }
    db.focusGoalId = id || null;
    commit();
  }

  // ---------- Milestones ----------
  function validateMilestone(f, goalId) {
    if (!String(f.name || "").trim()) fail("Give the milestone a name.");
    const tv = U.numOrNull(f.targetValue);
    if (tv != null) {
      const meas = engine.measure(goalId);
      if (meas.type !== "numeric" || !meas.valid) fail("Automatic milestones need a goal measured by a number.");
      if (tv <= 0) fail("The progress threshold must be greater than zero.");
      if (tv > meas.total + 1e-9) fail(`The threshold can't exceed the goal's total change (${U.fmtValue(meas.total, meas.fmt)}).`);
    }
    const w = U.numOrNull(f.weight);
    if (w != null && w <= 0) fail("Weight must be greater than zero.");
  }
  function addMilestone(goalId, f) {
    goalOrFail(goalId);
    validateMilestone(f, goalId);
    const m = M.normalizeMilestone(Object.assign({}, f, { goalId, status: "open", sortOrder: nextSort(engine.milestonesOf(goalId)) }));
    db.milestones.push(m);
    const result = afterValueChange(goalId, U.todayISO());
    commit();
    return Object.assign({ milestone: m }, result);
  }
  function updateMilestone(id, f) {
    const m = db.milestones.find((x) => x.id === id);
    if (!m) fail("Milestone not found.");
    validateMilestone(f, m.goalId);
    m.name = String(f.name).trim().slice(0, 200);
    m.description = String(f.description || "").trim().slice(0, 2000);
    m.targetValue = U.numOrNull(f.targetValue);
    m.weight = U.numOrNull(f.weight) || 1;
    m.dueDate = U.isISODate(f.dueDate) ? f.dueDate : "";
    if (m.targetValue == null) m.auto = false;
    const result = afterValueChange(m.goalId, U.todayISO());
    commit();
    return result;
  }
  function toggleMilestone(id) {
    const m = db.milestones.find((x) => x.id === id);
    if (!m) fail("Milestone not found.");
    if (m.status === "completed") { m.status = "open"; m.completedDate = ""; m.auto = false; }
    else { m.status = "completed"; m.completedDate = U.todayISO(); m.auto = false; }
    commit();
    return m;
  }
  function deleteMilestone(id) {
    db.milestones = db.milestones.filter((m) => m.id !== id);
    db.actions.forEach((a) => { if (a.milestoneId === id) a.milestoneId = null; });
    commit();
  }
  function moveMilestone(id, delta) {
    const m = db.milestones.find((x) => x.id === id);
    if (!m) return;
    const list = engine.milestonesOf(m.goalId);
    reorder(list, id, list.indexOf(m) + delta);
    commit();
  }

  // ---------- Actions ----------
  function validateAction(f, goalId) {
    if (!String(f.name || "").trim()) fail("Describe the action.");
    if (f.milestoneId && !db.milestones.some((m) => m.id === f.milestoneId && m.goalId === goalId)) fail("That milestone belongs to a different goal.");
  }
  function addAction(goalId, f) {
    goalOrFail(goalId);
    validateAction(f, goalId);
    const a = M.normalizeAction(Object.assign({}, f, { goalId, status: "open", sortOrder: nextSort(engine.actionsOf(goalId)) }));
    db.actions.push(a);
    commit();
    return a;
  }
  function updateAction(id, f) {
    const a = db.actions.find((x) => x.id === id);
    if (!a) fail("Action not found.");
    validateAction(f, a.goalId);
    a.name = String(f.name).trim().slice(0, 300);
    a.description = String(f.description || "").trim().slice(0, 2000);
    a.milestoneId = f.milestoneId || null;
    a.priority = M.PRIORITIES[f.priority] ? f.priority : "medium";
    a.dueDate = U.isISODate(f.dueDate) ? f.dueDate : "";
    a.effort = M.EFFORTS[f.effort] ? f.effort : "";
    commit();
    return a;
  }
  function toggleAction(id) {
    const a = db.actions.find((x) => x.id === id);
    if (!a) fail("Action not found.");
    if (a.status === "done") { a.status = "open"; a.completedDate = ""; }
    else { a.status = "done"; a.completedDate = U.todayISO(); }
    commit();
    return a;
  }
  function deleteAction(id) {
    db.actions = db.actions.filter((a) => a.id !== id);
    commit();
  }

  // ---------- Dependencies (explicit prerequisites — not parent/child) ----------
  function addDependency(goalId, dependsOnId) {
    goalOrFail(goalId); goalOrFail(dependsOnId);
    if (goalId === dependsOnId) fail("A goal can't depend on itself.");
    const anc = engine.path(goalId).map((g) => g.id);
    const desc = engine.descendants(goalId, { includeArchived: true }).map((g) => g.id);
    if (anc.includes(dependsOnId) || desc.includes(dependsOnId)) fail("Parent and subgoal relationships already link these goals — dependencies are for separate goals.");
    if (db.dependencies.some((d) => d.goalId === goalId && d.dependsOnId === dependsOnId)) fail("That dependency already exists.");
    // Reject cycles: walking prerequisites from dependsOnId must not reach goalId.
    const seen = new Set();
    const stack = [dependsOnId];
    while (stack.length) {
      const cur = stack.pop();
      if (cur === goalId) fail("That would create a circular dependency.");
      if (seen.has(cur)) continue;
      seen.add(cur);
      db.dependencies.filter((d) => d.goalId === cur).forEach((d) => stack.push(d.dependsOnId));
    }
    const d = M.normalizeDependency({ goalId, dependsOnId });
    db.dependencies.push(d);
    commit();
    return d;
  }
  function removeDependency(id) {
    db.dependencies = db.dependencies.filter((d) => d.id !== id);
    commit();
  }

  A.store = {
    STORE_KEY, ValidationError, init, load, onChange, replaceDb, getDb, engine: eng,
    createGoal, updateGoal, recordProgress, correctEntry, completeGoal, setStatus, restoreGoal, deleteGoal,
    moveGoal, moveGoalBefore, setFocus,
    addMilestone, updateMilestone, toggleMilestone, deleteMilestone, moveMilestone,
    addAction, updateAction, toggleAction, deleteAction,
    addDependency, removeDependency,
  };
})(typeof window !== "undefined" ? window.Arcus : globalThis.Arcus);
