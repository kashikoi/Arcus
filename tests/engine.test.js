// Run: node --test tests/
// Engine + service tests for Arcus (no browser, no dependencies).
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const root = path.join(__dirname, "..", "js");
["util", "model", "progress", "insights", "store", "demo"].forEach((f) => require(path.join(root, f + ".js")));
const { util: U, progress: P, insights: I, store: S, model: M } = globalThis.Arcus;

function memStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}
function fresh() { S.init({ storage: memStorage() }); }
const card = (name, start, extra) => Object.assign({ name, measurementType: "currency", currency: "USD", startValue: start, targetValue: 0, priority: "medium" }, extra || {});

test("numericCore handles increasing, decreasing, zero, overshoot, regression and invalid configs", () => {
  const dec = P.numericCore(65000, 45000, 0);
  assert.equal(dec.direction, "decrease");
  assert.ok(Math.abs(dec.pct - 20000 / 65000) < 1e-9);
  assert.equal(dec.remaining, 45000);
  const inc = P.numericCore(0, 2500, 10000);
  assert.equal(inc.pct, 0.25);
  assert.equal(P.numericCore(0, 12000, 10000).overshoot, true);
  assert.equal(P.numericCore(0, 12000, 10000).pct, 1);
  const back = P.numericCore(100, 110, 50);
  assert.equal(back.regressed, true);
  assert.equal(back.pct, 0);
  assert.equal(P.numericCore(5, 5, 5).valid, false);
  assert.equal(P.numericCore(null, 1, 5).valid, false);
  assert.equal(P.numericCore(-10, 0, 10).pct, 0.5);
});

test("spec example: $65,000 -> $0 at $45,000 current", () => {
  const r = P.numericCore(65000, 45000, 0);
  assert.equal(Math.round(r.pct * 100), 31); // (45000-65000)/(0-65000) = 30.77%
});

test("acceptance flow: debt-free hierarchy, priorities, promo, milestones, actions, payments, completion", () => {
  fresh();
  // 1-2
  const parent = S.createGoal({ name: "Become Debt-Free", measurementType: "currency", currency: "USD", startValue: 65000, targetValue: 0, rollup: true, priority: "critical" });
  // 3-5
  const a = S.createGoal(card("Eliminate Credit Card A", 7500, { parentId: parent.id, priority: "critical", category: "debt", finance: { apr: 26.99, promoApr: 0, promoEndDate: U.isoOffset(60), deferredInterest: true, statementDay: 15, promoEndsBeforeStatement: true } }));
  const b = S.createGoal(card("Eliminate Credit Card B", 18000, { parentId: parent.id, priority: "high", category: "debt", finance: { apr: 24.9 } }));
  const c = S.createGoal(card("Eliminate Credit Card C", 24500, { parentId: parent.id, priority: "medium" }));
  const d = S.createGoal(card("Eliminate Credit Card D", 15000, { parentId: parent.id, priority: "low" }));
  let e = S.engine();
  assert.equal(e.children(parent.id).length, 4);
  assert.equal(e.measure(parent.id).pct, 0);
  assert.equal(e.measure(parent.id).aggregate.included.length, 4);

  // 6-7 milestones + actions linked to milestones
  const m1 = S.addMilestone(a.id, { name: "Pay down $1,500", targetValue: 1500 }).milestone;
  const m2 = S.addMilestone(a.id, { name: "Pay down $3,000", targetValue: 3000 }).milestone;
  S.addMilestone(a.id, { name: "Pay down $5,000", targetValue: 5000 });
  S.addMilestone(a.id, { name: "Eliminate the remaining balance", targetValue: 7500 });
  const act = S.addAction(a.id, { name: "Make an additional $750 payment", milestoneId: m1.id, priority: "high", dueDate: U.isoOffset(5) });
  assert.equal(S.engine().actionsOf(a.id)[0].milestoneId, m1.id);

  // 8-9 record payments, subordinate goal progress
  const r1 = S.recordProgress(a.id, { mode: "change", amount: 750, date: U.isoOffset(-20) });
  assert.equal(r1.entry.previousValue, 7500);
  assert.equal(r1.entry.newValue, 6750);
  assert.equal(r1.entry.entryType, "payment");
  const r2 = S.recordProgress(a.id, { mode: "set", amount: 5500, date: U.isoOffset(-5), notes: "Statement balance" });
  assert.equal(r2.milestonesReached.map((m) => m.id).join(), m1.id);
  e = S.engine();
  assert.equal(e.measure(a.id).current, 5500);
  assert.ok(Math.abs(e.measure(a.id).pct - 2000 / 7500) < 1e-9);
  // 10 parent reflects it
  assert.equal(e.measure(parent.id).current, 63000);
  assert.ok(Math.abs(e.measure(parent.id).pct - 2000 / 65000) < 1e-9);
  // 11 history preserved
  assert.deepEqual(e.entriesOf(a.id).map((x) => x.newValue), [5500, 6750]);

  // 12 focus recommendation: card A (critical + promo + deferred interest) wins
  const rec = I.recommendations(e);
  assert.equal(rec.ready[0].goal.id, a.id);
  assert.ok(rec.ready[0].p.reasons.some((x) => /Promo APR/.test(x.text)));
  assert.equal(I.currentFocus(e).goal.id, a.id);
  const plan = I.financePlan(e, a.id);
  assert.ok(plan.items[0].label.includes("promo"));
  assert.ok(plan.warnings.some((w) => /Deferred interest/.test(w.text)));

  // Paying off A completes it, milestones auto-complete, focus moves on
  const r3 = S.recordProgress(a.id, { mode: "change", amount: 5500, date: U.todayISO() });
  assert.deepEqual(r3.completed.map((g) => g.id), [a.id]);
  e = S.engine();
  assert.equal(e.milestonesOf(a.id).filter((m) => m.status === "completed").length, 4);
  assert.equal(e.measure(parent.id).current, 57500);
  assert.notEqual(I.currentFocus(e).goal.id, a.id);
  assert.equal(e.actionsOf(a.id)[0].id, act.id);

  // Correction appends, never overwrites; reopens auto-completed goal
  const lastEntry = e.entriesOf(a.id)[0];
  const corr = S.correctEntry(lastEntry.id);
  e = S.engine();
  assert.equal(e.entriesOf(a.id).length, 4);
  assert.equal(e.entriesOf(a.id)[0].entryType, "correction");
  assert.equal(e.goal(a.id).currentValue, 5500);
  assert.deepEqual(corr.reopened.map((g) => g.id), [a.id]);
  assert.equal(e.milestonesOf(a.id).find((m) => m.id === m2.id).status, "open");
  assert.throws(() => S.correctEntry(lastEntry.id), /already been corrected/);

  // 13 mark complete manually with final value; parent updates; remaining cards -> parent completes by cascade
  S.completeGoal(a.id, { recordFinal: true });
  [b, c, d].forEach((g) => S.completeGoal(g.id, { recordFinal: true }));
  e = S.engine();
  assert.equal(e.goal(parent.id).status, "completed");
  assert.equal(e.measure(parent.id).pct, 1);
});

test("roll-up never aggregates incompatible measurements", () => {
  fresh();
  const p = S.createGoal({ name: "Mixed", measurementType: "currency", currency: "USD", rollup: true });
  S.createGoal(card("USD card", 1000, { parentId: p.id }));
  S.createGoal(card("EUR card", 1000, { parentId: p.id, currency: "EUR" }));
  S.createGoal({ name: "Miles", parentId: p.id, measurementType: "custom", unit: "mi", startValue: 0, targetValue: 10 });
  S.createGoal({ name: "Savings", parentId: p.id, measurementType: "currency", startValue: 0, targetValue: 500 });
  const m = S.engine().measure(p.id);
  assert.equal(m.aggregate.included.length, 1);
  assert.equal(m.aggregate.excluded.length, 3);
  assert.ok(m.issues.some((x) => /not included/.test(x)));
  assert.equal(m.total, 1000);
});

test("parent baseline larger than subgoal total does not show phantom progress", () => {
  fresh();
  const p = S.createGoal({ name: "Debt", measurementType: "currency", startValue: 65000, targetValue: 0, rollup: true });
  S.createGoal(card("Only card", 7500, { parentId: p.id }));
  const m = S.engine().measure(p.id);
  assert.equal(m.current, 65000);
  assert.equal(m.pct, 0);
  assert.ok(m.issues.some((x) => /account for/.test(x)));
});

test("milestone (weighted), subgoal-count and binary measurement", () => {
  fresh();
  const g = S.createGoal({ name: "Restore the car", measurementType: "milestones" });
  const m1 = S.addMilestone(g.id, { name: "Engine", weight: 3 }).milestone;
  S.addMilestone(g.id, { name: "Paint", weight: 1 });
  S.toggleMilestone(m1.id);
  assert.equal(S.engine().measure(g.id).pct, 0.75);
  const h = S.createGoal({ name: "Launch", measurementType: "milestones" });
  const k1 = S.createGoal({ name: "Build", parentId: h.id, measurementType: "binary" });
  S.createGoal({ name: "Ship", parentId: h.id, measurementType: "binary" });
  assert.equal(S.engine().measure(h.id).type, "subgoals");
  S.completeGoal(k1.id);
  assert.equal(S.engine().measure(h.id).pct, 0.5);
  assert.equal(S.engine().measure(k1.id).pct, 1);
});

test("validation and dependency rules", () => {
  fresh();
  assert.throws(() => S.createGoal({ name: "", measurementType: "binary" }), /name/);
  assert.throws(() => S.createGoal({ name: "x", measurementType: "currency", startValue: 5, targetValue: 5 }), /different/);
  assert.throws(() => S.createGoal({ name: "x", measurementType: "currency", startValue: 5 }), /starting value and a target/);
  const a = S.createGoal({ name: "A", measurementType: "binary" });
  const b = S.createGoal({ name: "B", measurementType: "binary" });
  const child = S.createGoal({ name: "A1", parentId: a.id, measurementType: "binary" });
  assert.throws(() => S.updateGoal(a.id, Object.assign({}, a, { parentId: child.id })), /under itself/);
  S.addDependency(b.id, a.id);
  assert.throws(() => S.addDependency(a.id, b.id), /circular/);
  assert.throws(() => S.addDependency(child.id, a.id), /Parent and subgoal/);
  const e = S.engine();
  assert.equal(e.blockers(b.id)[0].id, a.id);
  const rec = I.recommendations(e);
  assert.ok(rec.blocked.some((x) => x.goal.id === b.id));
  assert.throws(() => S.recordProgress(a.id, { amount: 1 }), /isn't measured by a number/);
});

test("finance helpers", () => {
  assert.ok(Math.abs(I.amortizedPayment(10000, 0, 10) - 1000) < 1e-9);
  assert.ok(Math.abs(I.amortizedPayment(10000, 12, 12) - 888.49) < 0.01);
  assert.equal(I.payoffMonths(1000, 24, 10), Infinity);
  assert.equal(I.payoffMonths(1200, 0, 100), 12);
  // Promo ends ON a statement date: inclusive counts it, exclusive ("ends before statement") does not.
  assert.deepEqual(I.statementDatesBetween("2026-10-31", "2027-01-15", 15, true), ["2026-11-15", "2026-12-15", "2027-01-15"]);
  assert.deepEqual(I.statementDatesBetween("2026-10-31", "2027-01-15", 15, false), ["2026-11-15", "2026-12-15"]);
  assert.equal(I.statementDatesBetween("2026-10-31", "2027-01-15", 31, true)[0], "2026-11-30");
});

test("v1 data migrates to the v2 model", () => {
  const v1 = { goals: [
    { id: "p", parentId: null, title: "Debt", kind: "rollup", unit: "$", status: "active", order: 0, steps: [{ id: "s", text: "List cards", done: true }], entries: [] },
    { id: "c", parentId: "p", title: "Card", kind: "amount", unit: "$", start: 7500, current: 5200, target: 0, status: "done", dueDate: "2027-01-01", order: 0,
      entries: [{ id: "e1", date: "2026-10-01", delta: -2300, value: 5200, note: "pay" }] },
  ] };
  const db = M.normalizeDb(v1);
  assert.equal(db.schemaVersion, 2);
  assert.equal(db.goals[0].rollup, true);
  assert.equal(db.goals[1].measurementType, "currency");
  assert.equal(db.goals[1].status, "completed");
  assert.equal(db.goals[1].targetDate, "2027-01-01");
  assert.equal(db.actions[0].status, "done");
  assert.equal(db.entries[0].previousValue, 7500);
});

test("portfolio aggregates only compatible top-level goals", () => {
  fresh();
  S.createGoal(card("Debt", 10000));
  S.createGoal({ name: "Save", measurementType: "currency", startValue: 0, targetValue: 5000 });
  S.createGoal({ name: "Run", measurementType: "custom", unit: "mi", startValue: 0, targetValue: 100 });
  const pf = S.engine().portfolio(S.engine().children(null));
  assert.equal(pf.groups.length, 3);
});

test("demo data loads and is internally consistent", () => {
  fresh();
  S.replaceDb(globalThis.Arcus.demo.build());
  const e = S.engine();
  assert.ok(e.db.goals.length >= 8);
  e.db.goals.forEach((g) => { const m = e.measure(g.id); assert.ok(m.type); });
  assert.ok(I.currentFocus(e));
});
