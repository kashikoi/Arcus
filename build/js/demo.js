/* Arcus — demo data set (Settings → Randomize data). Built directly in the v2 model. */
(function (A) {
  "use strict";
  const U = A.util;

  function build() {
    const d = (n) => U.isoOffset(n);
    const db = A.model.emptyDb();
    let seq = 0;
    const id = (p) => p + "-" + (++seq).toString(36) + Math.random().toString(36).slice(2, 6);
    const goal = (o) => { const g = Object.assign({ id: id("g"), sortOrder: db.goals.filter((x) => x.parentId === (o.parentId || null)).length }, o); db.goals.push(g); return g; };
    const ms = (goalId, list) => list.forEach((m, i) => db.milestones.push(Object.assign({ id: id("m"), goalId, sortOrder: i }, m)));
    const act = (goalId, list) => list.forEach((a, i) => db.actions.push(Object.assign({ id: id("a"), goalId, sortOrder: i }, a)));
    // Payment history: list of [daysAgo, newValue, notes]
    const history = (g, rows, type) => {
      let prev = g.startValue;
      rows.forEach(([ago, next, notes]) => {
        db.entries.push({ id: id("e"), goalId: g.id, date: d(-ago), previousValue: prev, newValue: next, changeAmount: U.round2(next - prev), notes, entryType: type || "progress", createdAt: new Date(Date.now() - ago * 86400000).toISOString() });
        prev = next;
      });
      g.currentValue = prev;
    };

    // ---- Financial: Become Debt-Free ----
    const debt = goal({
      name: "Become debt-free", measurementType: "currency", currency: "USD", startValue: 65000, targetValue: 0, rollup: true,
      priority: "critical", startDate: d(-75), targetDate: d(900),
      description: "Clear all four credit cards. Attack the 0% promo card before the promotion ends, then highest APR first while paying minimums on the rest.",
    });
    const cardA = goal({
      parentId: debt.id, name: "Eliminate Credit Card A", measurementType: "currency", startValue: 7500, targetValue: 0, priority: "critical", category: "debt",
      startDate: d(-75), targetDate: d(62), description: "0% promotional APR ends soon; deferred interest applies.",
      finance: { apr: 26.99, promoApr: 0, promoEndDate: d(62), deferredInterest: true, promoEndsBeforeStatement: true, statementDay: 15, minimumPayment: 150 },
    });
    history(cardA, [[58, 6700, "Payment"], [28, 5950, "Payment"], [3, 5200, "Payment + side-gig cash"]], "payment");
    const cardB = goal({ parentId: debt.id, name: "Eliminate Credit Card B", measurementType: "currency", startValue: 18000, targetValue: 0, priority: "high", category: "debt",
      description: "Highest standard APR — next after Card A.", finance: { apr: 24.9, minimumPayment: 540 } });
    history(cardB, [[40, 17725, "Minimum payment"], [10, 17450, "Minimum payment"]], "payment");
    const cardC = goal({ parentId: debt.id, name: "Eliminate Credit Card C", measurementType: "currency", startValue: 24500, targetValue: 0, priority: "medium", category: "debt",
      finance: { apr: 21.2, minimumPayment: 610 } });
    history(cardC, [[20, 24200, "Minimum payment"]], "payment");
    const cardD = goal({ parentId: debt.id, name: "Eliminate Credit Card D", measurementType: "currency", startValue: 15000, targetValue: 0, priority: "low", category: "debt",
      finance: { apr: 0, promoApr: 0, promoEndDate: d(420), minimumPayment: 150 }, description: "Long 0% promotion — lowest priority for now." });
    history(cardD, [[15, 14850, "Minimum payment"]], "payment");

    ms(cardA.id, [
      { name: "Pay down $1,500", targetValue: 1500, status: "completed", auto: true, completedDate: d(-28) },
      { name: "Pay down $3,000", targetValue: 3000, dueDate: d(14), status: "open" },
      { name: "Pay down $5,000", targetValue: 5000, dueDate: d(40), status: "open" },
      { name: "Eliminate the remaining balance", targetValue: 7500, dueDate: d(60), status: "open" },
    ]);
    const msA = db.milestones.filter((m) => m.goalId === cardA.id);
    act(cardA.id, [
      { name: "Make an additional $750 payment", milestoneId: msA[1].id, priority: "high", dueDate: d(6), effort: "xs", status: "open" },
      { name: "Transfer available savings above the $1k buffer", milestoneId: msA[2].id, priority: "high", dueDate: d(21), effort: "xs", status: "open" },
      { name: "Confirm the exact promo end date with the card issuer", priority: "critical", dueDate: d(2), effort: "s", status: "open" },
      { name: "Review monthly expenses for cuts", priority: "medium", effort: "s", status: "done", completedDate: d(-30) },
    ]);
    act(debt.id, [
      { name: "Set up autopay for every minimum payment", priority: "high", effort: "s", status: "done", completedDate: d(-70) },
      { name: "Freeze cards — no new charges", priority: "high", effort: "xs", status: "open" },
    ]);

    // ---- Financial (increasing): Emergency fund ----
    const ef = goal({ name: "Build a $10,000 emergency fund", measurementType: "currency", startValue: 0, targetValue: 10000, priority: "high",
      startDate: d(-90), targetDate: d(400), description: "High-yield savings. Small but steady while the debt gets paid." });
    history(ef, [[75, 800, "Opened HYSA"], [45, 1600, "Auto-transfer"], [15, 2400, "Auto-transfer"]]);
    ms(ef.id, [
      { name: "One month of expenses", targetValue: 2500, status: "open" },
      { name: "Three months of expenses", targetValue: 7500, status: "open" },
    ]);

    // ---- Non-financial: car restoration (milestones) with a dependency ----
    const car = goal({ name: "Restore the '72 Chevelle", measurementType: "milestones", priority: "medium", targetDate: d(540),
      description: "Frame-off restoration, done in stages as cash allows." });
    ms(car.id, [
      { name: "Teardown & inventory", weight: 1, status: "completed", completedDate: d(-120) },
      { name: "Engine rebuild", weight: 3, status: "open", dueDate: d(200) },
      { name: "Body & paint", weight: 3, status: "open" },
      { name: "Interior", weight: 2, status: "open" },
    ]);
    act(car.id, [
      { name: "Get three quotes for machine-shop work", priority: "medium", effort: "m", status: "open", milestoneId: null },
      { name: "Photograph and bag all trim", priority: "low", effort: "m", status: "done", completedDate: d(-118) },
    ]);
    db.dependencies.push({ id: id("d"), goalId: car.id, dependsOnId: ef.id });

    // ---- Non-financial: fitness (custom unit + binary subgoals) ----
    const run = goal({ name: "Run a half marathon", measurementType: "milestones", priority: "medium", targetDate: d(150),
      description: "Spring race. Build base mileage first, then a long-run block." });
    const miles = goal({ parentId: run.id, name: "Weekly mileage to 25 mi", measurementType: "custom", unit: "mi", startValue: 8, targetValue: 25, priority: "medium" });
    history(miles, [[30, 11, "Week 4"], [9, 14, "Week 7"]]);
    goal({ parentId: run.id, name: "Long run of 10 miles", measurementType: "custom", unit: "mi", startValue: 3, targetValue: 10, currentValue: 3, priority: "medium" });
    goal({ parentId: run.id, name: "Register for the race", measurementType: "binary", priority: "low", status: "completed", completedDate: d(-12) });

    db.goals.forEach((g) => { if (g.currentValue == null && g.startValue != null) g.currentValue = g.startValue; });
    return db;
  }

  A.demo = { build };
})(typeof window !== "undefined" ? window.Arcus : globalThis.Arcus);
