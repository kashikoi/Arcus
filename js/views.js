/* Arcus — views: pure render functions (state in, HTML string out). No calculations live here —
   all numbers come from Arcus.progress / Arcus.insights. */
(function (A) {
  "use strict";
  const U = A.util;
  const M = A.model;
  const I = A.insights;
  const esc = U.escapeHtml;

  // ---------- Small building blocks ----------
  function pctText(m) { return m.pct == null ? "—" : Math.floor(m.pct * 100 + 1e-9) + "%"; }
  function meter(m, opts) {
    const pct = m.pct == null ? 0 : m.pct;
    const cls = ["meter"];
    if (opts && opts.size) cls.push("meter--" + opts.size);
    if (m.completed || pct >= 1) cls.push("is-complete");
    if (m.pct == null) cls.push("is-unknown");
    return `<div class="${cls.join(" ")}" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(pct * 100)}"><span style="width:${(pct * 100).toFixed(1)}%"></span></div>`;
  }
  function chip(text, tone, title) {
    return `<span class="chip${tone ? " chip--" + tone : ""}"${title ? ` title="${esc(title)}"` : ""}>${esc(text)}</span>`;
  }
  function priorityChip(p) {
    const tone = p === "critical" ? "bad" : p === "high" ? "warn" : "";
    return `<span class="prio prio--${p}${tone ? " prio--" + tone : ""}"><i></i>${esc(M.PRIORITIES[p].label)}</span>`;
  }
  function statusChip(g) {
    if (g.status === "completed") return chip("Completed", "ok");
    if (g.status === "onHold") return chip("On hold", "");
    if (g.status === "archived") return chip("Archived", "muted");
    return "";
  }
  function urgencyChip(g) {
    const u = I.urgencyOf(g);
    if (!u.key) return "";
    const k = u.key;
    const tone = u.level === "overdue" ? "bad" : (u.level === "urgent" || u.level === "soon") ? "warn" : "";
    const what = k.kind === "promo" ? "Promo ends" : "Due";
    const text = k.days < 0 ? `${what === "Due" ? "Overdue" : "Promo ended"} · ${U.humanDays(k.days)}` : `${what} ${U.fmtShort(k.date)} · ${k.days === 0 ? "today" : U.humanDays(k.days)}`;
    return chip(text, tone, `${k.label}: ${U.fmtDate(k.date)}`);
  }
  function blockedChip(e, g) {
    const b = e.blockers(g.id);
    return b.length && A.progress.isOpen(g) ? chip("Blocked", "warn", "Waiting on: " + b.map((x) => x.name).join(", ")) : "";
  }
  function goalLink(g, cls) { return `<a class="${cls || "link"}" href="#/goal/${esc(g.id)}">${esc(g.name)}</a>`; }
  function dueText(iso) {
    if (!iso) return "";
    const d = U.daysUntil(iso);
    const tone = d < 0 ? "bad" : d <= 14 ? "warn" : "";
    return `<span class="due${tone ? " due--" + tone : ""}" title="${esc(U.fmtDate(iso))}">${d < 0 ? "Overdue " + U.humanDays(d) : d === 0 ? "Due today" : U.fmtShort(iso)}</span>`;
  }

  // One-line, measurement-aware summary of where a goal stands.
  function summary(m) {
    if (m.type === "numeric") {
      if (!m.valid) return "Not measurable yet";
      if (m.direction === "decrease") {
        const verb = m.fmt.measurementType === "currency" ? "paid down" : "reduced";
        return `${U.fmtValue(m.current, m.fmt)} left · ${U.fmtValue(Math.max(0, m.progressed), m.fmt)} ${verb}`;
      }
      return `${U.fmtValue(m.current, m.fmt)} of ${U.fmtValue(m.target, m.fmt)}`;
    }
    if (m.type === "milestones") return m.total ? `${m.done} of ${U.plural(m.total, "milestone")}` : "No milestones yet";
    if (m.type === "subgoals") return `${m.done} of ${U.plural(m.total, "subgoal")} complete`;
    if (m.type === "binary") return m.pct >= 1 ? "Complete" : "Not complete";
    return "";
  }
  function emptyNote(text) { return `<p class="empty-note">${text}</p>`; }

  function sectionHead(title, extra) {
    return `<header class="section__head"><h3 class="section__title">${title}</h3>${extra || ""}</header>`;
  }

  // Progress series for the history chart (rollups replay included subgoals' entries).
  function seriesFor(e, g, m) {
    if (m.type !== "numeric" || !m.valid) return [];
    const ids = m.rollup && m.aggregate ? m.aggregate.included : [g.id];
    const entries = [];
    ids.forEach((id) => e.entriesOf(id).forEach((x) => { if (x.changeAmount != null) entries.push(x); }));
    if (!entries.length) return [];
    entries.sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt));
    const total = entries.reduce((s, x) => s + x.changeAmount, 0);
    let v = m.current - total;
    const firstDate = g.startDate && g.startDate < entries[0].date ? g.startDate : U.isoOffset(-7, entries[0].date);
    const pts = [{ date: firstDate, v }];
    entries.forEach((x) => { v += x.changeAmount; pts.push({ date: x.date, v: U.round2(v) }); });
    return pts;
  }
  function chart(e, g, m) {
    const pts = seriesFor(e, g, m);
    if (pts.length < 2) return "";
    const W = 640, H = 140, PX = 4, PY = 10;
    const t = (iso) => U.parseDate(iso).getTime();
    const t0 = t(pts[0].date), t1 = Math.max(t(pts[pts.length - 1].date), t0 + U.DAY_MS);
    const vals = pts.map((p) => p.v).concat([m.target, m.start]);
    const lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals), span = hi - lo || 1;
    const x = (iso) => PX + ((t(iso) - t0) / (t1 - t0)) * (W - 2 * PX);
    const y = (v) => PY + (1 - (v - lo) / span) * (H - 2 * PY);
    // Step line: values hold until the next recorded entry.
    let d = `M${x(pts[0].date).toFixed(1)} ${y(pts[0].v).toFixed(1)}`;
    for (let i = 1; i < pts.length; i++) d += ` H${x(pts[i].date).toFixed(1)} V${y(pts[i].v).toFixed(1)}`;
    return `<figure class="chart">
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Value over time">
        <line class="chart__target" x1="0" x2="${W}" y1="${y(m.target).toFixed(1)}" y2="${y(m.target).toFixed(1)}" vector-effect="non-scaling-stroke" />
        <path class="chart__line" d="${d}" vector-effect="non-scaling-stroke" />
      </svg>
      <figcaption><span>${esc(U.fmtShort(pts[0].date))} · ${esc(U.fmtValue(pts[0].v, m.fmt))}</span><span class="chart__legend">— — target ${esc(U.fmtValue(m.target, m.fmt))}</span><span>${esc(U.fmtShort(pts[pts.length - 1].date))} · ${esc(U.fmtValue(pts[pts.length - 1].v, m.fmt))}</span></figcaption>
    </figure>`;
  }

  function assessmentText(a, m) {
    const map = {
      onTrack: ["On track", "ok"], behind: ["Behind pace", "warn"], overdue: ["Overdue", "bad"], stalled: ["Stalled", "warn"],
      noData: ["Not enough history", ""], noDate: ["No target date", ""], done: ["Complete", "ok"], notNumeric: ["", ""],
    };
    const [label, tone] = map[a.status] || ["", ""];
    return label ? chip(label, tone) : "";
  }

  // ---------- Focus panel (shared by Dashboard + Focus) ----------
  function nextMilestone(e, g) {
    const m = e.milestonesOf(g.id).find((x) => x.status === "open");
    if (!m) return null;
    const progressed = e.progressedAmount(g.id);
    const left = m.targetValue != null && progressed != null ? Math.max(0, m.targetValue - progressed) : null;
    return { m, left };
  }
  function figureFor(m) {
    if (m.type === "numeric" && m.valid) {
      if (m.reached) return { value: "Target reached", label: "" };
      return { value: U.fmtValue(m.remaining, m.fmt), label: m.direction === "decrease" ? (m.fmt.measurementType === "currency" ? "remaining" : "to reduce") : "to go" };
    }
    return { value: pctText(m), label: summary(m).toLowerCase() };
  }

  function focusPanel(e, focus, opts) {
    if (!focus) {
      return `<section class="panel focus-panel focus-panel--empty">
        <div class="eyebrow">Current focus</div>
        <p>No active goals need attention. Create a goal or reopen one to get a recommendation.</p>
      </section>`;
    }
    const g = focus.goal;
    const m = e.measure(g.id);
    const fig = figureFor(m);
    const path = e.path(g.id).slice(0, -1);
    const u = focus.p.urgency;
    const plan = I.financePlan(e, g.id);
    const nm = nextMilestone(e, g);
    const acts = I.nextActions(e, g.id, 3);
    const lines = [];
    if (u.key && u.key.kind === "promo") lines.push(`Promotional APR expires ${u.key.days > 60 ? "in approximately " + U.humanDays(u.key.days) : U.relDays(u.key.days)} (${U.fmtDate(u.key.date)}).`);
    else if (u.key) lines.push(`${u.key.days < 0 ? "Target date passed" : "Target date"} ${U.fmtDate(u.key.date)} — ${U.relDays(u.key.days)}.`);
    if (plan && plan.items[0]) lines.push(`<strong>${esc(plan.items[0].value)}</strong> ${esc(plan.items[0].label.toLowerCase())} <span class="est">estimate</span>`);
    const a = focus.p.assessment;
    if (a && a.required && !(plan && plan.items[0]) && a.status !== "overdue") lines.push(`Needs about <strong>${esc(U.fmtValue(Math.ceil(a.required.perMonth), m.fmt))}/month</strong> to finish on time <span class="est">estimate</span>`);
    return `<section class="panel focus-panel">
      <div class="focus-panel__top">
        <div class="eyebrow">${focus.pinned ? "Current focus · pinned" : "Current focus · recommended"}</div>
        <div class="focus-panel__tools">
          ${focus.pinned ? `<button type="button" class="btn btn--sm btn--quiet" data-act="unpin">Unpin</button>` : `<button type="button" class="btn btn--sm btn--quiet" data-act="pin" data-id="${esc(g.id)}" title="Keep this as your focus until you change it">Pin</button>`}
          ${opts && opts.compact ? `<a class="btn btn--sm btn--quiet" href="#/focus">All priorities</a>` : ""}
        </div>
      </div>
      <h2 class="focus-panel__title">${goalLink(g, "focus-panel__link")}</h2>
      ${path.length ? `<div class="focus-panel__path">${path.map((p) => goalLink(p, "link link--muted")).join(" › ")}</div>` : ""}
      <div class="focus-panel__figure"><span class="figure">${esc(fig.value)}</span> <span class="figure__label">${esc(fig.label)}</span><span class="figure__pct">${pctText(m)}</span></div>
      ${meter(m, { size: "lg" })}
      ${lines.length ? `<ul class="focus-panel__lines">${lines.map((l) => `<li>${l}</li>`).join("")}</ul>` : ""}
      <div class="why" aria-label="Why this is the focus">${focus.p.reasons.map((r) => chip(r.text, r.tone)).join("")}${focus.p.blocked ? chip("Blocked by " + focus.p.blockers.map((b) => b.name).join(", "), "warn") : ""}</div>
      ${nm ? `<div class="focus-panel__milestone"><span class="eyebrow">Next milestone</span> ${esc(nm.m.name)}${nm.left != null ? ` — <strong>${esc(U.fmtValue(nm.left, m.fmt))}</strong> to go` : ""}${nm.m.dueDate ? " · " + dueText(nm.m.dueDate) : ""}</div>` : ""}
      ${acts.length ? `<div class="focus-panel__actions"><span class="eyebrow">Recommended next actions</span>
        <ul class="checklist">${acts.map((x) => actionRow(e, x, { compact: true, showGoal: x.goalId !== g.id })).join("")}</ul></div>` : ""}
      <div class="focus-panel__buttons">
        ${canRecord(e, g) ? `<button type="button" class="btn btn--primary" data-act="record" data-id="${esc(g.id)}">Record progress</button>` : ""}
        ${!canRecord(e, g) && g.measurementType === "binary" ? `<button type="button" class="btn btn--primary" data-act="complete" data-id="${esc(g.id)}">Mark complete</button>` : ""}
        <a class="btn" href="#/goal/${esc(g.id)}">Open goal</a>
      </div>
    </section>`;
  }

  // Goals that accept a progress entry: numeric, measurable, not a roll-up (or a roll-up with numeric subgoals to pick from).
  function recordTargets(e, g) {
    const list = [g].concat(e.descendants(g.id)).filter((x) => {
      if (!A.progress.isOpen(x) || !M.MEASUREMENT_TYPES[x.measurementType].numeric) return false;
      const m = e.measure(x.id);
      return m.type === "numeric" && m.valid && !(m.rollup && m.aggregate);
    });
    return list;
  }
  function canRecord(e, g) { return recordTargets(e, g).length > 0; }

  function actionRow(e, a, opts) {
    const g = e.goal(a.goalId);
    const ms = a.milestoneId ? e.milestonesOf(a.goalId).find((m) => m.id === a.milestoneId) : null;
    const meta = [];
    if (opts && opts.showGoal && g) meta.push(goalLink(g, "link link--muted"));
    if (!(opts && opts.compact) && ms) meta.push(`<span class="muted">↳ ${esc(ms.name)}</span>`);
    if (a.priority === "critical" || a.priority === "high") meta.push(priorityChip(a.priority));
    if (a.dueDate && a.status === "open") meta.push(dueText(a.dueDate));
    if (a.effort) meta.push(`<span class="muted">${esc(M.EFFORTS[a.effort].label)}</span>`);
    if (a.status === "done" && a.completedDate) meta.push(`<span class="muted">Done ${esc(U.fmtShort(a.completedDate))}</span>`);
    return `<li class="check-row${a.status === "done" ? " is-done" : ""}">
      <label class="check-row__box"><input type="checkbox" data-act="toggle-action" data-id="${esc(a.id)}" ${a.status === "done" ? "checked" : ""} aria-label="Mark action done" /></label>
      <div class="check-row__body">
        <span class="check-row__title">${esc(a.name)}</span>
        ${a.description && !(opts && opts.compact) ? `<span class="check-row__desc">${esc(a.description)}</span>` : ""}
        ${meta.length ? `<span class="check-row__meta">${meta.join("")}</span>` : ""}
      </div>
      ${opts && opts.editable ? `<div class="row-tools">
        <button type="button" class="tool" data-act="edit-action" data-id="${esc(a.id)}" title="Edit action" aria-label="Edit action">✎</button>
        <button type="button" class="tool" data-act="delete-action" data-id="${esc(a.id)}" title="Delete action" aria-label="Delete action">×</button>
      </div>` : ""}
    </li>`;
  }

  // ---------- Dashboard ----------
  function goalRow(e, g, opts) {
    const m = e.measure(g.id);
    const a = I.assess(e, g.id);
    return `<tr data-href="#/goal/${esc(g.id)}">
      <td class="cell-goal">${goalLink(g)}<span class="cell-sub">${esc(summary(m))}</span>${opts && opts.path ? `<span class="cell-sub">${esc(e.path(g.id).slice(0, -1).map((p) => p.name).join(" › "))}</span>` : ""}</td>
      <td class="cell-progress">${meter(m)}<span class="cell-pct">${pctText(m)}</span></td>
      <td>${priorityChip(g.priority)}</td>
      <td>${urgencyChip(g) || `<span class="muted">${g.targetDate ? esc(U.fmtShort(g.targetDate)) : "—"}</span>`}</td>
      <td>${statusChip(g) || blockedChip(e, g) || assessmentText(a, m) || ""}</td>
    </tr>`;
  }
  function goalTable(e, goals, opts) {
    return `<div class="table-wrap"><table class="table">
      <thead><tr><th>Goal</th><th>Progress</th><th>Priority</th><th>Key date</th><th>Status</th></tr></thead>
      <tbody>${goals.map((g) => goalRow(e, g, opts)).join("")}</tbody>
    </table></div>`;
  }

  function deadlineList(items) {
    if (!items.length) return emptyNote("Nothing due in the next 45 days.");
    const kindLabel = { goal: "Goal", promo: "Promo APR", milestone: "Milestone", action: "Action" };
    return `<ul class="list">${items.map((d) => `<li class="list__item">
      <span class="list__date ${d.days < 0 ? "is-bad" : d.days <= 14 ? "is-warn" : ""}">${esc(U.fmtShort(d.date))}<small>${esc(d.days < 0 ? U.humanDays(d.days) + " late" : U.relDays(d.days))}</small></span>
      <span class="list__body"><span class="list__kind">${kindLabel[d.kind]}</span> ${d.kind === "goal" || d.kind === "promo" ? goalLink(d.goal) : esc(d.label)}
        ${d.kind === "milestone" || d.kind === "action" ? `<span class="cell-sub">${goalLink(d.goal, "link link--muted")}</span>` : ""}</span>
    </li>`).join("")}</ul>`;
  }

  function riskList(items) {
    if (!items.length) return emptyNote("Nothing flagged. Goals with dates are on pace or have no history yet.");
    return `<ul class="list">${items.map((r) => `<li class="list__item">
      <span class="dot dot--${r.tone}"></span>
      <span class="list__body">${goalLink(r.goal)}<span class="cell-sub">${esc(r.text)}</span></span>
    </li>`).join("")}</ul>`;
  }

  function activityList(e, items) {
    if (!items.length) return emptyNote("Recorded progress, completed milestones and finished actions show up here.");
    return `<ul class="list">${items.map((x) => {
      let text, tone = "";
      if (x.kind === "entry") {
        const en = x.entry;
        const m = e.measure(x.goal.id);
        const good = en.changeAmount != null && m.type === "numeric" && m.valid ? (m.direction === "decrease" ? en.changeAmount < 0 : en.changeAmount > 0) : true;
        tone = en.entryType === "correction" ? "" : good ? "ok" : "bad";
        text = `${esc(M.ENTRY_TYPES[en.entryType].label)} on ${goalLink(x.goal)}: ${esc(U.fmtValue(en.previousValue, e.fmtOf(x.goal)))} → ${esc(U.fmtValue(en.newValue, e.fmtOf(x.goal)))}`;
      } else if (x.kind === "goal") { tone = "ok"; text = `Completed goal ${goalLink(x.goal)}`; }
      else if (x.kind === "milestone") { tone = "ok"; text = `Milestone reached: ${esc(x.item.name)} <span class="muted">· ${goalLink(x.goal, "link link--muted")}</span>`; }
      else { text = `Action done: ${esc(x.item.name)} <span class="muted">· ${goalLink(x.goal, "link link--muted")}</span>`; }
      return `<li class="list__item"><span class="list__date">${esc(U.fmtShort(x.date))}</span><span class="dot dot--${tone}"></span><span class="list__body">${text}</span></li>`;
    }).join("")}</ul>`;
  }

  function portfolioPanel(e, roots) {
    const pf = e.portfolio(roots);
    const msDone = e.db.milestones.filter((m) => m.status === "completed").length;
    const actDone30 = e.db.actions.filter((a) => a.status === "done" && a.completedDate && U.daysUntil(a.completedDate) >= -30).length;
    const allOpen = e.db.goals.filter((g) => g.status !== "archived");
    const groups = pf.groups.map((grp) => {
      const verb = grp.direction === "decrease" ? (grp.fmt.measurementType === "currency" ? "paid down" : "reduced") : "gained";
      const unitLabel = grp.fmt.measurementType === "currency" ? grp.fmt.currency : grp.fmt.measurementType === "percentage" ? "percentage points" : (grp.fmt.unit || "units");
      return `<div class="pf">
        <div class="pf__head"><span class="pf__label">${esc(unitLabel)} · ${grp.direction === "decrease" ? "reducing" : "building"}</span><span class="pf__pct">${Math.floor(grp.pct * 100)}%</span></div>
        ${meter({ pct: grp.pct })}
        <div class="pf__nums"><strong>${esc(U.fmtValue(grp.progressed, grp.fmt))}</strong> ${verb} of ${esc(U.fmtValue(grp.total, grp.fmt))} · ${esc(U.fmtValue(grp.remaining, grp.fmt))} to go</div>
        <div class="pf__goals">${grp.goals.map((g) => goalLink(g, "link link--muted")).join(", ")}</div>
      </div>`;
    }).join("");
    return `<section class="panel">
      ${sectionHead("Overall progress")}
      ${groups || emptyNote("Numeric totals appear when top-level goals share a measurement.")}
      <dl class="stats">
        <div><dt>Goals complete</dt><dd>${allOpen.filter((g) => g.status === "completed").length} <small>of ${allOpen.length}</small></dd></div>
        <div><dt>Milestones reached</dt><dd>${msDone} <small>of ${e.db.milestones.length}</small></dd></div>
        <div><dt>Actions done (30 days)</dt><dd>${actDone30}</dd></div>
      </dl>
      <p class="footnote">Totals only combine goals with the same measurement, unit and direction — unrelated goals are never averaged together.</p>
    </section>`;
  }

  function emptyState() {
    return `<div class="view view--empty">
      <div class="empty">
        <h1 class="empty__title">Define an objective.</h1>
        <p class="empty__text">Start with something ambitious — <em>“Become debt-free”</em>, <em>“Launch a product”</em>, <em>“Restore the car”</em>.
        Break it into subordinate goals, add milestones and actions, prioritize what matters, then record progress until it’s achieved.</p>
        <div class="empty__actions">
          <button type="button" class="btn btn--primary" data-act="new-goal">Create your first goal</button>
          <button type="button" class="btn" data-act="demo">Load an example</button>
        </div>
      </div>
    </div>`;
  }

  function dashboard(e) {
    if (!e.db.goals.length) return emptyState();
    const roots = e.children(null).filter((g) => g.status !== "archived");
    const primary = roots.filter((g) => g.status !== "completed").sort((a, b) => M.PRIORITIES[a.priority].rank - M.PRIORITIES[b.priority].rank || a.sortOrder - b.sortOrder);
    const completedRoots = roots.filter((g) => g.status === "completed");
    return `<div class="view">
      <header class="view__head">
        <div><h1 class="view__title">Dashboard</h1><p class="view__sub">${esc(new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" }))}</p></div>
      </header>
      <div class="grid grid--focus">
        ${focusPanel(e, I.currentFocus(e), { compact: true })}
        ${portfolioPanel(e, roots)}
      </div>
      <section class="panel">
        ${sectionHead("Primary goals", `<a class="btn btn--sm btn--quiet" href="#/goals">Explore all</a>`)}
        ${primary.length ? goalTable(e, primary) : emptyNote("All top-level goals are complete.")}
        ${completedRoots.length ? `<p class="footnote">${U.plural(completedRoots.length, "completed goal")} hidden — see <a class="link" href="#/goals">Goals</a>.</p>` : ""}
      </section>
      <div class="grid grid--2">
        <section class="panel">${sectionHead("Upcoming deadlines")}${deadlineList(I.deadlines(e, 45))}</section>
        <section class="panel">${sectionHead("At risk")}${riskList(I.atRisk(e))}</section>
      </div>
      <section class="panel">${sectionHead("Recent activity")}${activityList(e, I.activity(e, 10))}</section>
    </div>`;
  }

  // ---------- Focus view ----------
  function focusView(e) {
    if (!e.db.goals.length) return emptyState();
    const rec = I.recommendations(e);
    const focus = I.currentFocus(e);
    const overdue = e.db.actions.filter((a) => a.status === "open" && a.dueDate && U.daysUntil(a.dueDate) < 0 && A.progress.isOpen(e.goal(a.goalId))).sort(I.actionSort);
    const upcomingMs = e.db.milestones.filter((m) => m.status === "open" && m.dueDate && U.daysUntil(m.dueDate) <= 45 && A.progress.isOpen(e.goal(m.goalId))).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
    const ranked = rec.ready.map((x, i) => {
      const m = e.measure(x.goal.id);
      const isFocus = focus && focus.goal.id === x.goal.id;
      return `<li class="rank-row${isFocus ? " is-focus" : ""}">
        <span class="rank-row__n">${i + 1}</span>
        <div class="rank-row__body">
          <div class="rank-row__title">${goalLink(x.goal)} ${priorityChip(x.goal.priority)} ${urgencyChip(x.goal)}</div>
          <div class="cell-sub">${esc(e.path(x.goal.id).slice(0, -1).map((p) => p.name).join(" › "))}${e.path(x.goal.id).length > 1 ? " · " : ""}${esc(summary(m))}</div>
          <div class="why why--small">${x.p.reasons.map((r) => chip(`${r.text} +${r.points}`, r.tone)).join("")}</div>
        </div>
        <div class="rank-row__side">
          <span class="score" title="Sum of the rules on the left">${x.p.score}</span>
          ${isFocus && focus.pinned ? `<button type="button" class="btn btn--sm btn--quiet" data-act="unpin">Unpin</button>` : `<button type="button" class="btn btn--sm btn--quiet" data-act="pin" data-id="${esc(x.goal.id)}" title="Make this your pinned focus">${isFocus ? "Pin" : "Focus"}</button>`}
        </div>
      </li>`;
    }).join("");
    return `<div class="view">
      <header class="view__head">
        <div><h1 class="view__title">Focus</h1><p class="view__sub">What should I work on right now?</p></div>
      </header>
      ${focusPanel(e, focus)}
      <section class="panel">
        ${sectionHead("Recommended order", `<span class="muted small">Score = sum of transparent rules. You can always pin your own focus.</span>`)}
        ${ranked ? `<ol class="rank-list">${ranked}</ol>` : emptyNote("No actionable goals. Goals on hold, completed, or with active subgoals are not ranked — their subgoals are.")}
      </section>
      <div class="grid grid--2">
        <section class="panel">${sectionHead("Overdue actions")}${overdue.length ? `<ul class="checklist">${overdue.map((a) => actionRow(e, a, { showGoal: true })).join("")}</ul>` : emptyNote("No overdue actions.")}</section>
        <section class="panel">${sectionHead("Upcoming milestones")}${upcomingMs.length ? `<ul class="list">${upcomingMs.map((m) => `<li class="list__item"><span class="list__date ${U.daysUntil(m.dueDate) < 0 ? "is-bad" : U.daysUntil(m.dueDate) <= 14 ? "is-warn" : ""}">${esc(U.fmtShort(m.dueDate))}<small>${esc(U.relDays(U.daysUntil(m.dueDate)))}</small></span><span class="list__body">${esc(m.name)}<span class="cell-sub">${goalLink(e.goal(m.goalId), "link link--muted")}</span></span></li>`).join("")}</ul>` : emptyNote("No milestones due in the next 45 days.")}</section>
      </div>
      <section class="panel">${sectionHead("Blocked by dependencies")}${rec.blocked.length ? `<ul class="list">${rec.blocked.map((x) => `<li class="list__item"><span class="dot dot--warn"></span><span class="list__body">${goalLink(x.goal)}<span class="cell-sub">Waiting on ${x.p.blockers.map((b) => goalLink(b, "link link--muted")).join(", ")}</span></span></li>`).join("")}</ul>` : emptyNote("Nothing is blocked.")}</section>
    </div>`;
  }

  // ---------- Goal explorer ----------
  const STATUS_FILTERS = {
    open: { label: "Open", test: (g) => g.status === "active" || g.status === "onHold" },
    active: { label: "Active", test: (g) => g.status === "active" },
    onHold: { label: "On hold", test: (g) => g.status === "onHold" },
    completed: { label: "Completed", test: (g) => g.status === "completed" },
    archived: { label: "Archived", test: (g) => g.status === "archived" },
    all: { label: "All", test: () => true },
  };
  const SORTS = {
    manual: "Priority order (manual)",
    priority: "Priority level",
    date: "Key date",
    progress: "Progress",
    name: "Name",
  };
  function sortGoals(e, list, sort) {
    const keyDate = (g) => { const k = I.keyDate(g); return k ? k.date : "9999-12-31"; };
    const cmp = {
      manual: (a, b) => a.sortOrder - b.sortOrder,
      priority: (a, b) => M.PRIORITIES[a.priority].rank - M.PRIORITIES[b.priority].rank || a.sortOrder - b.sortOrder,
      date: (a, b) => keyDate(a).localeCompare(keyDate(b)),
      progress: (a, b) => (e.measure(b.id).pct || 0) - (e.measure(a.id).pct || 0),
      name: (a, b) => a.name.localeCompare(b.name),
    }[sort] || ((a, b) => a.sortOrder - b.sortOrder);
    return list.slice().sort(cmp);
  }

  function explorer(e, st) {
    if (!e.db.goals.length) return emptyState();
    const q = (st.q || "").trim().toLowerCase();
    const sf = STATUS_FILTERS[st.status] || STATUS_FILTERS.open;
    const includeArchived = st.status === "archived" || st.status === "all";
    const matches = (g) => sf.test(g) && (st.priority === "all" || g.priority === st.priority) &&
      (!q || g.name.toLowerCase().includes(q) || g.description.toLowerCase().includes(q));
    const filtering = q || st.priority !== "all" || st.status !== "open";
    const kids = (id) => sortGoals(e, e.children(id, { includeArchived }), st.sort);
    const memo = new Map();
    const visible = (g) => {
      if (memo.has(g.id)) return memo.get(g.id);
      const v = matches(g) || kids(g.id).some(visible);
      memo.set(g.id, v);
      return v;
    };
    let count = 0;
    let body;
    if (st.mode === "list") {
      const all = sortGoals(e, e.db.goals.filter((g) => matches(g) && (includeArchived || g.status !== "archived")), st.sort === "manual" ? "priority" : st.sort);
      count = all.length;
      body = all.length ? goalTable(e, all, { path: true }) : "";
    } else {
      const rows = [];
      (function walk(pid, depth) {
        kids(pid).forEach((g) => {
          if (!visible(g)) return;
          const hit = matches(g);
          if (hit) count++;
          const childList = kids(g.id).filter(visible);
          const open = !st.collapsed.has(g.id) || (filtering && childList.some(matches));
          const m = e.measure(g.id);
          rows.push(`<div class="tree-row${hit ? "" : " is-context"}${g.status === "completed" ? " is-complete" : ""}" role="row" style="--depth:${depth}" data-href="#/goal/${esc(g.id)}">
            <div class="tree-row__name" role="gridcell">
              ${childList.length ? `<button type="button" class="caret${open ? " is-open" : ""}" data-act="toggle-node" data-id="${esc(g.id)}" aria-expanded="${open}" aria-label="${open ? "Collapse" : "Expand"} ${esc(g.name)}"></button>` : `<span class="caret caret--leaf"></span>`}
              <div class="tree-row__text">${goalLink(g)}<span class="cell-sub">${esc(summary(m))}${childList.length ? " · " + U.plural(childList.length, "subgoal") : ""}</span></div>
            </div>
            <div class="cell-progress" role="gridcell">${meter(m)}<span class="cell-pct">${pctText(m)}</span></div>
            <div role="gridcell">${priorityChip(g.priority)}</div>
            <div role="gridcell">${urgencyChip(g) || `<span class="muted">—</span>`}</div>
            <div role="gridcell">${statusChip(g) || blockedChip(e, g)}</div>
          </div>`);
          if (open) walk(g.id, depth + 1);
        });
      })(null, 0);
      body = rows.length ? `<div class="tree" role="treegrid"><div class="tree-head" role="row"><div>Goal</div><div>Progress</div><div>Priority</div><div>Key date</div><div>Status</div></div>${rows.join("")}</div>` : "";
    }
    const opt = (obj, cur) => Object.keys(obj).map((k) => `<option value="${k}"${k === cur ? " selected" : ""}>${esc(typeof obj[k] === "string" ? obj[k] : obj[k].label)}</option>`).join("");
    return `<div class="view">
      <header class="view__head">
        <div><h1 class="view__title">Goals</h1><p class="view__sub">${U.plural(count, "goal")} ${filtering ? "match" + (count === 1 ? "es" : "") : "shown"}</p></div>
        <button type="button" class="btn btn--primary" data-act="new-goal">New goal</button>
      </header>
      <section class="panel">
        <div class="toolbar" role="search">
          <input class="field__input toolbar__search" type="search" id="explorerSearch" placeholder="Search goals" value="${esc(st.q || "")}" aria-label="Search goals" />
          <select class="field__input" id="explorerStatus" aria-label="Filter by status">${opt(STATUS_FILTERS, st.status)}</select>
          <select class="field__input" id="explorerPriority" aria-label="Filter by priority"><option value="all">Any priority</option>${opt(M.PRIORITIES, st.priority)}</select>
          <select class="field__input" id="explorerSort" aria-label="Sort">${opt(SORTS, st.sort)}</select>
          <div class="seg seg--inline" role="radiogroup" aria-label="View">
            <button type="button" class="seg__btn${st.mode !== "list" ? " is-active" : ""}" data-act="explorer-mode" data-mode="tree">Tree</button>
            <button type="button" class="seg__btn${st.mode === "list" ? " is-active" : ""}" data-act="explorer-mode" data-mode="list">List</button>
          </div>
          ${st.mode !== "list" ? `<button type="button" class="btn btn--sm btn--quiet" data-act="collapse-all">${st.collapsed.size ? "Expand all" : "Collapse all"}</button>` : ""}
        </div>
        ${body || emptyNote("No goals match these filters.")}
      </section>
    </div>`;
  }

  // ---------- Goal detail ----------
  function instrument(e, g, m) {
    const fmt = m.fmt;
    let main, facts = [];
    if (m.type === "numeric" && m.valid) {
      const curLabel = g.category === "debt" ? "Current balance" : m.rollup ? "Current (from subgoals)" : "Current";
      main = `<div class="readout"><span class="readout__value">${esc(U.fmtValue(m.current, fmt))}</span><span class="readout__label">${curLabel}</span></div>
              <div class="readout readout--right"><span class="readout__value">${pctText(m)}</span><span class="readout__label">${m.reached ? "Target reached" : "of the way"}</span></div>`;
      const verb = m.direction === "decrease" ? (fmt.measurementType === "currency" ? "Paid down" : "Reduced") : "Gained";
      facts = [["Start", U.fmtValue(m.start, fmt)], ["Target", U.fmtValue(m.target, fmt)], [verb, U.fmtValue(m.progressed, fmt)], ["Remaining", U.fmtValue(m.remaining, fmt)]];
    } else if (m.type === "numeric") {
      main = `<div class="readout"><span class="readout__value">—</span><span class="readout__label">Not measurable yet</span></div>`;
    } else {
      main = `<div class="readout"><span class="readout__value">${esc(summary(m))}</span><span class="readout__label">${m.type === "milestones" && m.weighted ? "weighted by milestone" : M.MEASUREMENT_TYPES[g.measurementType].label}</span></div>
              <div class="readout readout--right"><span class="readout__value">${pctText(m)}</span><span class="readout__label">complete</span></div>`;
    }
    if (g.startDate) facts.push(["Started", U.fmtDate(g.startDate)]);
    if (g.targetDate) facts.push(["Target date", U.fmtDate(g.targetDate)]);
    if (g.completedDate && g.status === "completed") facts.push(["Completed", U.fmtDate(g.completedDate)]);
    const issues = m.issues.length ? `<ul class="notes">${m.issues.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : "";
    return `<section class="panel instrument">
      <div class="instrument__main">${main}</div>
      ${meter(m, { size: "lg" })}
      ${facts.length ? `<dl class="facts">${facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>` : ""}
      ${issues}
    </section>`;
  }

  function schedulePanel(e, g, m) {
    if (m.type !== "numeric" || !m.valid || g.status === "completed") return "";
    const a = I.assess(e, g.id);
    const rows = [];
    if (a.required) rows.push([`Required pace to hit ${a.required.by.kind === "promo" ? "the promo deadline" : "the target date"}`, `${U.fmtValue(Math.ceil(a.required.perMonth), m.fmt)}/month`, `≈ ${U.fmtValue(Math.ceil(a.required.perWeek), m.fmt)}/week until ${U.fmtDate(a.required.by.date)}`]);
    if (a.pace) rows.push(["Recent pace", a.pace.perDay > 0 ? `${U.fmtValue(Math.round(a.pace.perMonth), m.fmt)}/month` : "No net progress", `last ${a.pace.windowDays} days · ${U.plural(a.pace.entries, "entry", "entries")}`]);
    if (a.eta) rows.push(["Projected completion", U.fmtMonthYear(a.eta.date), `${U.relDays(a.eta.days)} at recent pace`]);
    if (!rows.length) return "";
    return `<section class="panel">
      ${sectionHead("Schedule", `${assessmentText(a, m)} <span class="est">estimates</span>`)}
      <dl class="kv">${rows.map(([k, v, n]) => `<div><dt>${esc(k)}</dt><dd><strong>${esc(v)}</strong><small>${esc(n)}</small></dd></div>`).join("")}</dl>
    </section>`;
  }

  function financePanel(e, g) {
    if (!I.isDebt(g)) return "";
    const f = g.finance;
    const plan = I.financePlan(e, g.id);
    const terms = [];
    if (f.apr != null) terms.push(["Standard APR", f.apr + "%"]);
    if (f.promoEndDate) terms.push(["Promo APR", (f.promoApr != null ? f.promoApr : 0) + "% until " + U.fmtDate(f.promoEndDate)]);
    if (f.statementDay) terms.push(["Statement closes", "Day " + f.statementDay + (f.promoEndsBeforeStatement ? " · promo ends before that cycle closes" : "")]);
    if (f.deferredInterest) terms.push(["Deferred interest", "Yes"]);
    if (f.minimumPayment != null) terms.push(["Minimum payment", U.fmtMoney(f.minimumPayment, g.currency)]);
    return `<section class="panel">
      ${sectionHead("Debt payoff", plan && plan.estimate ? `<span class="est">estimates — not financial advice</span>` : "")}
      ${terms.length ? `<dl class="facts facts--terms">${terms.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>` : emptyNote("Add APR and promo details in Edit to get payoff estimates.")}
      ${plan && plan.items.length ? `<dl class="kv">${plan.items.map((x) => `<div${x.emphasis ? ' class="is-emphasis"' : ""}><dt>${esc(x.label)}</dt><dd><strong>${esc(x.value)}</strong>${x.note ? `<small>${esc(x.note)}</small>` : ""}</dd></div>`).join("")}</dl>` : ""}
      ${plan && plan.warnings.length ? `<ul class="notes">${plan.warnings.map((w) => `<li class="notes__${w.tone}">${esc(w.text)}</li>`).join("")}</ul>` : ""}
      <p class="footnote">Calculated from the details you entered. Actual interest and payoff depend on your issuer’s terms, statement timing and new charges.</p>
    </section>`;
  }

  function subgoalsPanel(e, g, m) {
    const kids = e.children(g.id);
    const focus = I.currentFocus(e);
    const included = m.aggregate ? new Set(m.aggregate.included) : null;
    const rows = kids.map((k, i) => {
      const km = e.measure(k.id);
      return `<li class="sub-row${k.status === "completed" ? " is-complete" : ""}${focus && focus.goal.id === k.id ? " is-focus" : ""}" data-id="${esc(k.id)}" draggable="true">
        <span class="sub-row__rank" title="Drag to reorder">${i + 1}</span>
        <div class="sub-row__body">
          <div class="sub-row__title">${goalLink(k)} ${priorityChip(k.priority)} ${urgencyChip(k)} ${statusChip(k)} ${blockedChip(e, k)}${included && !included.has(k.id) && k.status !== "archived" ? chip("Not in total", "muted", "Different measurement, unit or direction") : ""}</div>
          <div class="sub-row__meter">${meter(km)}<span class="cell-pct">${pctText(km)}</span><span class="cell-sub">${esc(summary(km))}</span></div>
        </div>
        <div class="row-tools">
          <button type="button" class="tool" data-act="move-goal" data-id="${esc(k.id)}" data-dir="-1" ${i === 0 ? "disabled" : ""} title="Move up" aria-label="Move up">▲</button>
          <button type="button" class="tool" data-act="move-goal" data-id="${esc(k.id)}" data-dir="1" ${i === kids.length - 1 ? "disabled" : ""} title="Move down" aria-label="Move down">▼</button>
          ${canRecord(e, k) && !e.children(k.id).length ? `<button type="button" class="tool tool--go" data-act="record" data-id="${esc(k.id)}" title="Record progress" aria-label="Record progress">+</button>` : ""}
        </div>
      </li>`;
    }).join("");
    return `<section class="panel">
      ${sectionHead(`Subordinate goals${kids.length ? ` <span class="count">${m.subgoals.done}/${m.subgoals.total}</span>` : ""}`, `<button type="button" class="btn btn--sm" data-act="add-subgoal" data-id="${esc(g.id)}">Add subgoal</button>`)}
      ${kids.length ? `<ol class="sub-list" id="subList">${rows}</ol>` : emptyNote("Break this objective into smaller goals. Order them by priority — drag or use the arrows.")}
    </section>`;
  }

  function milestonesPanel(e, g, m) {
    const list = e.milestonesOf(g.id);
    const numeric = m.type === "numeric" && m.valid;
    const progressed = numeric ? m.progressed : null;
    const verb = !numeric ? "" : m.direction === "decrease" ? (g.measurementType === "currency" ? "paid down" : "reduced") : "gained";
    const rows = list.map((x, i) => {
      const auto = x.targetValue != null && numeric;
      const left = auto ? Math.max(0, x.targetValue - progressed) : null;
      const linked = e.actionsOf(g.id).filter((a) => a.milestoneId === x.id);
      const openLinked = linked.filter((a) => a.status === "open").length;
      return `<li class="check-row${x.status === "completed" ? " is-done" : ""}">
        <label class="check-row__box"><input type="checkbox" data-act="toggle-milestone" data-id="${esc(x.id)}" ${x.status === "completed" ? "checked" : ""} aria-label="Milestone complete" /></label>
        <div class="check-row__body">
          <span class="check-row__title">${esc(x.name)}</span>
          ${x.description ? `<span class="check-row__desc">${esc(x.description)}</span>` : ""}
          <span class="check-row__meta">
            ${auto ? `<span class="muted">${x.status === "completed" ? (x.auto ? "Reached automatically" : "Completed") : `At ${esc(U.fmtValue(x.targetValue, m.fmt))} ${verb} · ${esc(U.fmtValue(left, m.fmt))} to go`}</span>` : ""}
            ${x.status === "completed" && x.completedDate ? `<span class="muted">${esc(U.fmtShort(x.completedDate))}</span>` : x.dueDate ? dueText(x.dueDate) : ""}
            ${g.measurementType === "milestones" && x.weight !== 1 ? `<span class="muted">Weight ${esc(String(x.weight))}</span>` : ""}
            ${linked.length ? `<span class="muted">${openLinked ? U.plural(openLinked, "open action") : "Actions done"}</span>` : ""}
          </span>
        </div>
        <div class="row-tools">
          <button type="button" class="tool" data-act="move-milestone" data-id="${esc(x.id)}" data-dir="-1" ${i === 0 ? "disabled" : ""} aria-label="Move up">▲</button>
          <button type="button" class="tool" data-act="move-milestone" data-id="${esc(x.id)}" data-dir="1" ${i === list.length - 1 ? "disabled" : ""} aria-label="Move down">▼</button>
          <button type="button" class="tool" data-act="edit-milestone" data-id="${esc(x.id)}" aria-label="Edit milestone">✎</button>
          <button type="button" class="tool" data-act="delete-milestone" data-id="${esc(x.id)}" aria-label="Delete milestone">×</button>
        </div>
      </li>`;
    }).join("");
    const done = list.filter((x) => x.status === "completed").length;
    return `<section class="panel">
      ${sectionHead(`Milestones${list.length ? ` <span class="count">${done}/${list.length}</span>` : ""}`, `<button type="button" class="btn btn--sm" data-act="add-milestone" data-id="${esc(g.id)}">Add milestone</button>`)}
      ${list.length ? `<ul class="checklist">${rows}</ul>` : emptyNote(numeric ? "Checkpoints like “Pay down $1,500”. Give one a progress threshold and it completes automatically." : "Significant checkpoints toward this goal.")}
    </section>`;
  }

  function actionsPanel(e, g, showDone) {
    const list = e.actionsOf(g.id);
    const open = list.filter((a) => a.status === "open").sort(I.actionSort);
    const done = list.filter((a) => a.status === "done");
    const ms = e.milestonesOf(g.id);
    const groups = [];
    ms.forEach((m) => { const items = open.filter((a) => a.milestoneId === m.id); if (items.length) groups.push({ title: m.name, items }); });
    const loose = open.filter((a) => !a.milestoneId || !ms.some((m) => m.id === a.milestoneId));
    if (loose.length) groups.push({ title: groups.length ? "Other actions" : "", items: loose });
    return `<section class="panel">
      ${sectionHead(`Actions${list.length ? ` <span class="count">${done.length}/${list.length}</span>` : ""}`, `<button type="button" class="btn btn--sm" data-act="add-action" data-id="${esc(g.id)}">Add action</button>`)}
      ${groups.map((grp) => `${grp.title ? `<div class="group-label">↳ ${esc(grp.title)}</div>` : ""}<ul class="checklist">${grp.items.map((a) => actionRow(e, a, { editable: true, compact: true })).join("")}</ul>`).join("")}
      ${!open.length ? emptyNote(list.length ? "All actions done." : "Concrete things to do that move this goal forward — “Make an additional $750 payment”.") : ""}
      ${done.length ? `<button type="button" class="btn btn--sm btn--quiet" data-act="toggle-done-actions">${showDone ? "Hide" : "Show"} ${U.plural(done.length, "completed action")}</button>
        ${showDone ? `<ul class="checklist">${done.map((a) => actionRow(e, a, { editable: true })).join("")}</ul>` : ""}` : ""}
    </section>`;
  }

  function dependenciesPanel(e, g) {
    const deps = e.dependenciesOf(g.id);
    const dependents = e.dependentsOf(g.id);
    const banned = new Set([g.id].concat(e.path(g.id).map((x) => x.id), e.descendants(g.id, { includeArchived: true }).map((x) => x.id), deps.map((d) => d.goal.id)));
    const options = e.db.goals.filter((x) => !banned.has(x.id) && x.status !== "archived");
    return `<section class="panel">
      ${sectionHead("Dependencies")}
      <div class="grid grid--2 grid--tight">
        <div>
          <div class="group-label">Depends on</div>
          ${deps.length ? `<ul class="list">${deps.map((d) => `<li class="list__item"><span class="dot dot--${d.goal.status === "completed" ? "ok" : "warn"}"></span><span class="list__body">${goalLink(d.goal)}<span class="cell-sub">${d.goal.status === "completed" ? "Complete" : "Not complete — blocks this goal"}</span></span><button type="button" class="tool" data-act="remove-dependency" data-id="${esc(d.dep.id)}" aria-label="Remove dependency">×</button></li>`).join("")}</ul>` : emptyNote("No prerequisites.")}
          ${options.length ? `<div class="inline-form"><select class="field__input" id="depSelect" aria-label="Add prerequisite"><option value="">Add a prerequisite…</option>${options.map((x) => `<option value="${esc(x.id)}">${esc(e.path(x.id).map((p) => p.name).join(" › "))}</option>`).join("")}</select><button type="button" class="btn btn--sm" data-act="add-dependency" data-id="${esc(g.id)}">Add</button></div>` : ""}
        </div>
        <div>
          <div class="group-label">Required by</div>
          ${dependents.length ? `<ul class="list">${dependents.map((d) => `<li class="list__item"><span class="dot"></span><span class="list__body">${goalLink(d.goal)}</span></li>`).join("")}</ul>` : emptyNote("Nothing waits on this goal.")}
        </div>
      </div>
    </section>`;
  }

  function historyPanel(e, g, m) {
    const ids = m.rollup && m.aggregate ? [g.id].concat(m.aggregate.included) : [g.id];
    const entries = [];
    ids.forEach((id) => e.entriesOf(id).forEach((x) => entries.push(x)));
    entries.sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
    const corrected = new Set(e.db.entries.filter((x) => x.correctsId).map((x) => x.correctsId));
    const showGoal = ids.length > 1;
    if (!entries.length && !(m.type === "numeric")) return "";
    return `<section class="panel">
      ${sectionHead("Progress history", `<span class="muted small">Entries are never edited — corrections are added as new entries.</span>`)}
      ${chart(e, g, m)}
      ${entries.length ? `<div class="table-wrap"><table class="table table--history">
        <thead><tr><th>Date</th>${showGoal ? "<th>Goal</th>" : ""}<th>Type</th><th class="num">Previous</th><th class="num">New</th><th class="num">Change</th><th>Notes</th><th></th></tr></thead>
        <tbody>${entries.slice(0, 200).map((x) => {
          const xg = e.goal(x.goalId);
          const xm = e.measure(x.goalId);
          const fmt = e.fmtOf(xg);
          const good = x.changeAmount != null && xm.valid ? (xm.direction === "decrease" ? x.changeAmount < 0 : x.changeAmount > 0) : null;
          const isCorrected = corrected.has(x.id);
          return `<tr class="${isCorrected ? "is-corrected" : ""}">
            <td class="nowrap">${esc(U.fmtDate(x.date))}</td>
            ${showGoal ? `<td>${goalLink(xg, "link link--muted")}</td>` : ""}
            <td>${esc(M.ENTRY_TYPES[x.entryType].label)}${isCorrected ? ` <span class="muted">(reversed)</span>` : ""}</td>
            <td class="num">${esc(U.fmtValue(x.previousValue, fmt))}</td>
            <td class="num">${esc(U.fmtValue(x.newValue, fmt))}</td>
            <td class="num ${good === true ? "is-ok" : good === false ? "is-bad" : ""}">${esc(U.fmtValue(x.changeAmount, fmt, { signed: true }))}</td>
            <td class="cell-notes">${esc(x.notes)}</td>
            <td class="nowrap">${x.entryType !== "correction" && !isCorrected && x.changeAmount != null ? `<button type="button" class="btn btn--sm btn--quiet" data-act="correct-entry" data-id="${esc(x.id)}">Reverse</button>` : ""}</td>
          </tr>`;
        }).join("")}</tbody>
      </table></div>` : emptyNote("No progress recorded yet.")}
    </section>`;
  }

  function goalDetail(e, id, ui) {
    const g = e.goal(id);
    if (!g) return `<div class="view">${emptyNote("This goal doesn’t exist anymore. <a class=\"link\" href=\"#/goals\">Back to goals</a>")}</div>`;
    const m = e.measure(id);
    const parent = g.parentId ? e.goal(g.parentId) : null;
    const focus = I.currentFocus(e);
    const isPinned = e.db.focusGoalId === g.id;
    const open = A.progress.isOpen(g);
    return `<div class="view">
      <header class="view__head view__head--goal">
        <div class="goal-head">
          ${parent ? `<div class="goal-head__parent">Part of ${goalLink(parent, "link link--muted")}</div>` : ""}
          <h1 class="view__title">${esc(g.name)}</h1>
          <div class="goal-head__chips">${priorityChip(g.priority)} ${statusChip(g)} ${urgencyChip(g)} ${blockedChip(e, g)} ${focus && focus.goal.id === g.id ? chip(isPinned ? "Current focus (pinned)" : "Current focus", "accent") : ""} ${g.category === "debt" ? chip("Debt payoff", "") : ""}</div>
        </div>
        <div class="goal-head__actions">
          ${open && canRecord(e, g) ? `<button type="button" class="btn btn--primary" data-act="record" data-id="${esc(g.id)}">Record progress</button>` : ""}
          <button type="button" class="btn" data-act="edit-goal" data-id="${esc(g.id)}">Edit</button>
          ${g.status === "completed" ? `<button type="button" class="btn" data-act="reopen" data-id="${esc(g.id)}">Reopen</button>` : g.status !== "archived" ? `<button type="button" class="btn" data-act="complete" data-id="${esc(g.id)}">Mark complete</button>` : ""}
          <details class="menu">
            <summary class="btn" aria-label="More actions">More</summary>
            <div class="menu__list">
              ${open ? (isPinned ? `<button type="button" data-act="unpin">Unpin focus</button>` : `<button type="button" data-act="pin" data-id="${esc(g.id)}">Set as current focus</button>`) : ""}
              ${g.status === "active" ? `<button type="button" data-act="hold" data-id="${esc(g.id)}">Put on hold</button>` : g.status === "onHold" ? `<button type="button" data-act="resume" data-id="${esc(g.id)}">Resume</button>` : ""}
              <button type="button" data-act="add-subgoal" data-id="${esc(g.id)}">Add subgoal</button>
              ${g.status === "archived" ? `<button type="button" data-act="restore" data-id="${esc(g.id)}">Restore from archive</button>` : `<button type="button" data-act="archive" data-id="${esc(g.id)}">Archive</button>`}
              <button type="button" class="is-danger" data-act="delete-goal" data-id="${esc(g.id)}">Delete permanently…</button>
            </div>
          </details>
        </div>
      </header>
      ${g.description ? `<p class="description">${esc(g.description)}</p>` : ""}
      ${instrument(e, g, m)}
      <div class="grid grid--2 grid--auto">
        ${schedulePanel(e, g, m)}
        ${financePanel(e, g)}
      </div>
      ${subgoalsPanel(e, g, m)}
      <div class="grid grid--2">
        ${milestonesPanel(e, g, m)}
        ${actionsPanel(e, g, ui.showDoneActions)}
      </div>
      ${historyPanel(e, g, m)}
      ${dependenciesPanel(e, g)}
    </div>`;
  }

  A.views = { dashboard, focusView, explorer, goalDetail, recordTargets, canRecord, summary, pctText, meter, STATUS_FILTERS };
})(typeof window !== "undefined" ? window.Arcus : globalThis.Arcus);
