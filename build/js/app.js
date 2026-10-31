/* Arcus — application controller: routing, rendering, forms, dialogs, events, settings.
   Business rules live in store/progress/insights; this file only wires the UI to them. */
(function (A) {
  "use strict";
  const U = A.util;
  const M = A.model;
  const I = A.insights;
  const S = A.store;
  const V = A.views;
  const esc = U.escapeHtml;

  const APP_VERSION = "2026.10.31.2";
  const THEME_KEY = "arcus_cloud_theme";
  const ACTIVE_THEME_KEY = "arcus_cloud_active_theme";
  const REMEMBER_CLOUD_PHRASE_KEY = "arcus_cloud_phrase";
  const EXPLORER_KEY = "arcus_cloud_explorer";
  const THEMES = ["day", "twilight", "night"];
  const DEFAULT_THEME = "day";

  const el = {};
  const ui = {
    route: { name: "dashboard", id: null },
    explorer: { q: "", status: "open", priority: "all", sort: "manual", mode: "tree", collapsed: new Set() },
    showDoneActions: false,
  };

  // ---------- Helpers ----------
  function $(id) { return document.getElementById(id); }
  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { el.toast.hidden = true; }, 3200);
  }
  function engine() { return S.engine(); }
  // Runs a store mutation; validation errors are shown, never thrown into the UI.
  function attempt(fn, errEl) {
    try {
      if (errEl) errEl.hidden = true;
      return { ok: true, value: fn() };
    } catch (err) {
      const msg = err instanceof S.ValidationError ? err.message : "Something went wrong: " + (err && err.message);
      if (errEl) { errEl.textContent = msg; errEl.hidden = false; } else toast(msg);
      if (!(err instanceof S.ValidationError)) console.error(err);
      return { ok: false };
    }
  }
  function celebrate(result, fallback) {
    const parts = [];
    if (result && result.milestonesReached && result.milestonesReached.length) parts.push(`Milestone reached: ${result.milestonesReached.map((m) => m.name).join(", ")}`);
    if (result && result.completed && result.completed.length) parts.push(`Completed: ${result.completed.map((g) => g.name).join(", ")}`);
    if (result && result.reopened && result.reopened.length) parts.push(`Reopened: ${result.reopened.map((g) => g.name).join(", ")}`);
    if (result && result.completed && result.completed.length) {
      const f = I.currentFocus(engine());
      if (f) parts.push(`Next focus: ${f.goal.name}`);
    }
    toast(parts.length ? parts.join(" · ") : fallback);
  }

  // ---------- Theme ----------
  function getThemePref() {
    const pref = localStorage.getItem(THEME_KEY);
    return THEMES.includes(pref) || pref === "random" ? pref : DEFAULT_THEME;
  }
  function applyThemeClass(mode) {
    document.documentElement.classList.remove("day", "twilight");
    if (mode === "day" || mode === "twilight") document.documentElement.classList.add(mode);
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
    el.themePicker.querySelectorAll(".theme-chip").forEach((c) => c.classList.toggle("is-active", c.dataset.themeVal === getThemePref()));
  }

  // ---------- Routing ----------
  function parseRoute() {
    const h = location.hash.replace(/^#\/?/, "");
    const [name, id] = h.split("/");
    if (name === "goal" && id) return { name: "goal", id: decodeURIComponent(id) };
    if (name === "focus" || name === "goals") return { name, id: null };
    return { name: "dashboard", id: null };
  }
  function go(hash) {
    if (location.hash === hash) render();
    else location.hash = hash;
  }

  // ---------- Rendering ----------
  function render() {
    const e = engine();
    ui.route = parseRoute();
    if (ui.route.name === "goal" && !e.goal(ui.route.id)) ui.route = { name: "goals", id: null };
    renderRail(e);
    renderCrumb(e);
    const key = ui.route.name + (ui.route.id || "");
    const sameView = render._last === key;
    const scroll = el.canvas.scrollTop;
    let html;
    if (ui.route.name === "focus") html = V.focusView(e);
    else if (ui.route.name === "goals") html = V.explorer(e, ui.explorer);
    else if (ui.route.name === "goal") html = V.goalDetail(e, ui.route.id, ui);
    else html = V.dashboard(e);
    el.canvas.innerHTML = html;
    el.canvas.scrollTop = sameView ? scroll : 0;
    render._last = key;
    el.app.classList.toggle("is-detail", ui.route.name === "goal");
  }

  function renderRail(e) {
    el.nav.querySelectorAll(".nav__item").forEach((a) => {
      const r = a.dataset.route;
      const on = r === ui.route.name || (r === "goals" && ui.route.name === "goal");
      a.classList.toggle("is-active", on);
      if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
    const overdue = e.db.actions.filter((a) => a.status === "open" && a.dueDate && U.daysUntil(a.dueDate) < 0 && A.progress.isOpen(e.goal(a.goalId))).length
      + e.db.goals.filter((g) => g.status === "active" && I.urgencyOf(g).level === "overdue").length;
    el.focusBadge.hidden = !overdue;
    el.focusBadge.textContent = overdue;
    el.focusBadge.title = overdue + " overdue";
    const activeRoot = ui.route.name === "goal" ? (e.path(ui.route.id)[0] || null) : null;
    const roots = e.children(null).filter((g) => g.status !== "archived" && g.status !== "completed");
    el.railGoals.innerHTML = roots.length ? roots.map((g) => {
      const m = e.measure(g.id);
      return `<li><a class="rail-goal${activeRoot && activeRoot.id === g.id ? " is-active" : ""}" href="#/goal/${esc(g.id)}">
        <span class="rail-goal__name">${esc(g.name)}</span><span class="rail-goal__pct">${V.pctText(m)}</span>
        ${V.meter(m, { size: "xs" })}
      </a></li>`;
    }).join("") : `<li class="rail-goals__empty">No open goals</li>`;
  }

  function renderCrumb(e) {
    const parts = [`<a class="crumb__item crumb__home" href="#/dashboard">ARCUS</a>`];
    const sep = `<span class="crumb__sep" aria-hidden="true">/</span>`;
    if (ui.route.name === "goal") {
      parts.push(sep, `<a class="crumb__item" href="#/goals">Goals</a>`);
      const path = e.path(ui.route.id);
      path.forEach((g, i) => {
        parts.push(sep, i === path.length - 1
          ? `<span class="crumb__item is-current" aria-current="page" title="${esc(g.name)}">${esc(g.name)}</span>`
          : `<a class="crumb__item" href="#/goal/${esc(g.id)}" title="${esc(g.name)}">${esc(g.name)}</a>`);
      });
    } else {
      const label = { dashboard: "Dashboard", focus: "Focus", goals: "Goals" }[ui.route.name];
      parts.push(sep, `<span class="crumb__item is-current" aria-current="page">${label}</span>`);
    }
    el.crumb.innerHTML = parts.join("");
    const g = ui.route.name === "goal" ? e.goal(ui.route.id) : null;
    el.topProgressBtn.hidden = !(g && A.progress.isOpen(g) && V.canRecord(e, g));
  }

  // ---------- Modals ----------
  const modalStack = [];
  function openModal(node, focusSel) {
    node.hidden = false;
    modalStack.push({ node, returnTo: document.activeElement });
    // Later dialogs (e.g. a confirmation over Settings) must stack above earlier ones regardless of DOM order.
    node.style.zIndex = String(200 + modalStack.length);
    setTimeout(() => {
      const f = focusSel ? node.querySelector(focusSel) : node.querySelector("input, select, textarea, button:not(.modal__close)");
      if (f) f.focus();
    }, 30);
  }
  function closeModal(node) {
    node = node || (modalStack.length && modalStack[modalStack.length - 1].node);
    if (!node || node.hidden) return;
    node.hidden = true;
    const i = modalStack.findIndex((x) => x.node === node);
    if (i >= 0) {
      const entry = modalStack.splice(i, 1)[0];
      if (entry.returnTo && entry.returnTo.focus && document.contains(entry.returnTo)) entry.returnTo.focus();
    }
    if (node === el.choiceModal && choose._resolve) { const r = choose._resolve; choose._resolve = null; r(null); }
  }

  // Confirmation with explicit, labeled outcomes. Resolves to the chosen value, or null if dismissed.
  function choose(title, html, buttons) {
    el.choiceTitle.textContent = title;
    el.choiceText.innerHTML = html;
    el.choiceButtons.innerHTML = buttons.map((b, i) => `<button type="button" class="btn ${b.kind === "primary" ? "btn--primary" : b.kind === "danger" ? "btn--danger" : ""}" data-choice="${i}">${esc(b.label)}</button>`).join("")
      + `<button type="button" class="btn btn--quiet" data-choice="-1">Cancel</button>`;
    return new Promise((resolve) => {
      choose._resolve = resolve;
      el.choiceButtons.querySelectorAll("[data-choice]").forEach((btn) => btn.addEventListener("click", () => {
        const idx = +btn.dataset.choice;
        const r = choose._resolve;
        choose._resolve = null;
        closeModal(el.choiceModal);
        if (r) r(idx >= 0 ? buttons[idx].value : null);
      }));
      openModal(el.choiceModal, "[data-choice]");
    });
  }

  // ---------- Goal form ----------
  let goalFormId = null;
  function fillParentOptions(excludeId, selected) {
    const e = engine();
    const banned = new Set();
    if (excludeId) { banned.add(excludeId); e.descendants(excludeId, { includeArchived: true }).forEach((d) => banned.add(d.id)); }
    const opts = [`<option value="">— None (top-level goal) —</option>`];
    (function walk(pid, depth) {
      e.children(pid).forEach((g) => {
        if (banned.has(g.id)) return;
        opts.push(`<option value="${esc(g.id)}">${"\u2003".repeat(depth)}${esc(g.name)}</option>`);
        walk(g.id, depth + 1);
      });
    })(null, 0);
    el.goalForm.parentId.innerHTML = opts.join("");
    el.goalForm.parentId.value = selected || "";
  }
  function syncGoalForm() {
    const f = el.goalForm;
    const type = f.measurementType.value;
    const numeric = M.MEASUREMENT_TYPES[type].numeric;
    f.querySelectorAll("[data-show]").forEach((n) => { n.hidden = !n.dataset.show.split(" ").includes(type); });
    f.querySelectorAll("[data-hide-rollup]").forEach((n) => { n.hidden = !numeric || f.rollup.checked; });
    f.querySelector("[data-debt]").hidden = !(type === "currency" && f.isDebt.checked);
    $("measureHint").textContent = M.MEASUREMENT_TYPES[type].hint + (numeric && f.rollup.checked ? " Leave start/target blank to use the subgoals' totals." : "");
    const s = U.numOrNull(f.startValue.value), t = U.numOrNull(f.targetValue.value);
    $("directionHint").textContent = numeric && s != null && t != null && s !== t
      ? (t < s ? "↓ Decreasing objective — progress means the value goes down (e.g. paying off a balance)." : "↑ Increasing objective — progress means the value goes up.")
      : "";
  }
  function openGoalForm(id, parentId) {
    const e = engine();
    const g = id ? e.goal(id) : null;
    goalFormId = g ? g.id : null;
    const f = el.goalForm;
    f.reset();
    $("goalFormError").hidden = true;
    el.goalModalTitle.textContent = g ? "Edit goal" : parentId ? "New subordinate goal" : "New goal";
    const parent = g ? (g.parentId ? e.goal(g.parentId) : null) : (parentId ? e.goal(parentId) : null);
    fillParentOptions(goalFormId, parent ? parent.id : "");
    f.currency.innerHTML = M.CURRENCIES.map((c) => `<option>${c}</option>`).join("");
    const src = g || {
      measurementType: parent && M.MEASUREMENT_TYPES[parent.measurementType].numeric ? parent.measurementType : "currency",
      currency: parent ? parent.currency : "USD", unit: parent ? parent.unit : "", priority: "medium",
      category: parent ? parent.category : "general",
    };
    const inheritDebt = !g && parent && parent.measurementType === "currency" && parent.rollup && parent.targetValue === 0;
    f.name.value = g ? g.name : "";
    f.description.value = g ? g.description : "";
    f.priority.value = src.priority;
    f.measurementType.value = src.measurementType;
    f.currency.value = src.currency || "USD";
    f.unit.value = src.unit || "";
    f.rollup.checked = !!(g && g.rollup);
    f.startValue.value = g && g.startValue != null ? g.startValue : "";
    f.currentValue.value = g && g.currentValue != null && !g.rollup ? g.currentValue : "";
    f.targetValue.value = g && g.targetValue != null ? g.targetValue : (inheritDebt || src.category === "debt" ? 0 : "");
    f.startDate.value = g ? g.startDate : U.todayISO();
    f.targetDate.value = g ? g.targetDate : "";
    f.isDebt.checked = src.category === "debt" || !!inheritDebt;
    const fin = (g && g.finance) || {};
    ["apr", "promoApr", "statementDay", "minimumPayment"].forEach((k) => { f[k].value = fin[k] != null ? fin[k] : ""; });
    f.promoEndDate.value = fin.promoEndDate || "";
    f.promoEndsBeforeStatement.checked = !!fin.promoEndsBeforeStatement;
    f.deferredInterest.checked = !!fin.deferredInterest;
    syncGoalForm();
    openModal(el.goalModal, "[name=name]");
  }
  function submitGoalForm(ev) {
    ev.preventDefault();
    const f = el.goalForm;
    const data = {
      name: f.name.value, description: f.description.value, parentId: f.parentId.value || null, priority: f.priority.value,
      measurementType: f.measurementType.value, currency: f.currency.value, unit: f.unit.value, rollup: f.rollup.checked,
      startValue: f.startValue.value, currentValue: f.currentValue.value, targetValue: f.targetValue.value,
      startDate: f.startDate.value, targetDate: f.targetDate.value,
      category: f.isDebt.checked ? "debt" : "general",
      finance: {
        apr: f.apr.value, promoApr: f.promoApr.value, promoEndDate: f.promoEndDate.value, statementDay: f.statementDay.value,
        minimumPayment: f.minimumPayment.value, promoEndsBeforeStatement: f.promoEndsBeforeStatement.checked, deferredInterest: f.deferredInterest.checked,
      },
    };
    const editing = goalFormId;
    const r = attempt(() => (editing ? S.updateGoal(editing, data) : S.createGoal(data)), $("goalFormError"));
    if (!r.ok) return;
    closeModal(el.goalModal);
    if (editing) { render(); celebrate(r.value, "Goal saved."); }
    else { go("#/goal/" + r.value.id); toast("Goal created."); }
  }

  // ---------- Record progress ----------
  let progressMode = "change";
  function progressGoal() { return engine().goal(el.progressForm.goalId.value); }
  function openProgress(id) {
    const e = engine();
    const g = e.goal(id);
    if (!g) return;
    const targets = V.recordTargets(e, g);
    if (!targets.length) { toast("This goal isn't measured by a number — complete milestones or mark it done instead."); return; }
    const f = el.progressForm;
    f.reset();
    $("progressFormError").hidden = true;
    const focus = I.currentFocus(e);
    const pick = targets.find((t) => t.id === g.id) || (focus && targets.find((t) => t.id === focus.goal.id))
      || I.recommendations(e).ready.map((r) => r.goal).find((x) => targets.includes(x)) || targets[0];
    f.goalId.innerHTML = targets.map((t) => {
      const path = e.path(t.id).slice(e.path(g.id).length - 1).map((p) => p.name).join(" › ");
      return `<option value="${esc(t.id)}">${esc(path)} (${esc(U.fmtValue(t.currentValue, e.fmtOf(t)))})</option>`;
    }).join("");
    f.goalId.value = pick.id;
    $("progressGoalField").hidden = targets.length < 2;
    f.date.value = U.todayISO();
    f.date.max = U.todayISO();
    setProgressMode("change");
    openModal(el.progressModal, "[name=amount]");
  }
  function setProgressMode(mode) {
    progressMode = mode;
    el.progressMode.querySelectorAll(".seg__btn").forEach((b) => {
      const on = b.dataset.mode === mode;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-checked", String(on));
    });
    syncProgressForm();
  }
  function syncProgressForm() {
    const g = progressGoal();
    if (!g) return;
    const m = engine().measure(g.id);
    const debt = g.category === "debt";
    const dec = m.direction === "decrease";
    el.progressMode.querySelector('[data-mode="change"]').textContent = debt ? "Payment" : dec ? "Reduction" : "Progress";
    el.progressMode.querySelector('[data-mode="setback"]').textContent = debt ? "New charges" : "Setback";
    $("progressAmountLabel").textContent = progressMode === "set" ? (debt ? "New balance" : "New value")
      : progressMode === "setback" ? (debt ? "Amount added to balance" : "Amount lost") : (debt ? "Payment amount" : dec ? "Reduced by" : "Amount gained");
    const amt = U.numOrNull(el.progressForm.amount.value);
    const prev = g.currentValue;
    let next = null;
    if (amt != null) {
      if (progressMode === "set") next = amt;
      else if (amt > 0) { const sign = dec ? -1 : 1; next = prev + sign * amt * (progressMode === "setback" ? -1 : 1); }
    }
    const fmt = m.fmt;
    if (next == null) { $("progressPreview").innerHTML = `Currently <strong>${esc(U.fmtValue(prev, fmt))}</strong> · target ${esc(U.fmtValue(g.targetValue, fmt))}`; return; }
    const after = A.progress.numericCore(m.start, next, m.target);
    const ms = engine().milestonesOf(g.id).filter((x) => x.status === "open" && x.targetValue != null && after.valid && after.progressed >= x.targetValue);
    $("progressPreview").innerHTML = `${esc(U.fmtValue(prev, fmt))} → <strong>${esc(U.fmtValue(next, fmt))}</strong> · ${after.valid ? (after.reached ? "<span class=\"is-ok\">target reached — goal will be completed</span>" : esc(U.fmtValue(after.remaining, fmt)) + " to go (" + Math.floor(after.pct * 100) + "%)") : ""}`
      + (ms.length ? `<br><span class="is-ok">Milestone: ${ms.map((x) => esc(x.name)).join(", ")}</span>` : "");
  }
  function submitProgress(ev) {
    ev.preventDefault();
    const f = el.progressForm;
    const r = attempt(() => S.recordProgress(f.goalId.value, {
      mode: progressMode === "set" ? "set" : "change", setback: progressMode === "setback",
      amount: f.amount.value, date: f.date.value, notes: f.notes.value,
    }), $("progressFormError"));
    if (!r.ok) return;
    closeModal(el.progressModal);
    render();
    celebrate(r.value, "Progress recorded.");
  }

  // ---------- Milestone form ----------
  let milestoneCtx = null;
  function openMilestone(goalId, msId) {
    const e = engine();
    const g = e.goal(goalId);
    if (!g) return;
    const ms = msId ? e.milestonesOf(goalId).find((x) => x.id === msId) : null;
    milestoneCtx = { goalId, id: ms ? ms.id : null };
    const f = el.milestoneForm;
    f.reset();
    $("milestoneFormError").hidden = true;
    $("milestoneModalTitle").textContent = ms ? "Edit milestone" : "New milestone";
    const m = e.measure(goalId);
    const numeric = m.type === "numeric" && m.valid;
    $("milestoneThresholdField").hidden = !numeric;
    $("milestoneThresholdLabel").textContent = g.category === "debt" ? "Reached after paying down" : m.direction === "decrease" ? "Reached after reducing by" : "Reached after gaining";
    $("milestoneHint").textContent = numeric
      ? `Optional. Total change for this goal is ${U.fmtValue(m.total, m.fmt)}; ${U.fmtValue(Math.max(0, m.progressed), m.fmt)} so far. With a threshold the milestone completes automatically; without one, check it off yourself.`
      : "Check this milestone off when you reach it.";
    $("milestoneWeightField").hidden = g.measurementType !== "milestones";
    if (ms) {
      f.name.value = ms.name; f.description.value = ms.description;
      f.targetValue.value = ms.targetValue != null ? ms.targetValue : "";
      f.dueDate.value = ms.dueDate; f.weight.value = ms.weight !== 1 ? ms.weight : "";
    }
    openModal(el.milestoneModal, "[name=name]");
  }
  function submitMilestone(ev) {
    ev.preventDefault();
    const f = el.milestoneForm;
    const data = { name: f.name.value, description: f.description.value, targetValue: $("milestoneThresholdField").hidden ? null : f.targetValue.value, dueDate: f.dueDate.value, weight: f.weight.value };
    const r = attempt(() => (milestoneCtx.id ? S.updateMilestone(milestoneCtx.id, data) : S.addMilestone(milestoneCtx.goalId, data)), $("milestoneFormError"));
    if (!r.ok) return;
    closeModal(el.milestoneModal);
    render();
    celebrate(r.value, milestoneCtx.id ? "Milestone saved." : "Milestone added.");
  }

  // ---------- Action form ----------
  let actionCtx = null;
  function openAction(goalId, actionId, milestoneId) {
    const e = engine();
    const a = actionId ? e.actionsOf(goalId).find((x) => x.id === actionId) || e.db.actions.find((x) => x.id === actionId) : null;
    if (a) goalId = a.goalId;
    actionCtx = { goalId, id: a ? a.id : null };
    const f = el.actionForm;
    f.reset();
    $("actionFormError").hidden = true;
    $("actionModalTitle").textContent = a ? "Edit action" : "New action";
    const ms = e.milestonesOf(goalId);
    f.milestoneId.innerHTML = `<option value="">— Not tied to a milestone —</option>` + ms.map((m) => `<option value="${esc(m.id)}">${esc(m.name)}${m.status === "completed" ? " (done)" : ""}</option>`).join("");
    f.milestoneId.closest(".field").hidden = !ms.length;
    if (a) {
      f.name.value = a.name; f.description.value = a.description; f.milestoneId.value = a.milestoneId || "";
      f.priority.value = a.priority; f.dueDate.value = a.dueDate; f.effort.value = a.effort;
    } else {
      f.milestoneId.value = milestoneId || (ms.find((m) => m.status === "open") || {}).id || "";
      f.priority.value = "medium";
    }
    openModal(el.actionModal, "[name=name]");
  }
  function submitAction(ev) {
    ev.preventDefault();
    const f = el.actionForm;
    const data = { name: f.name.value, description: f.description.value, milestoneId: f.milestoneId.value || null, priority: f.priority.value, dueDate: f.dueDate.value, effort: f.effort.value };
    const r = attempt(() => (actionCtx.id ? S.updateAction(actionCtx.id, data) : S.addAction(actionCtx.goalId, data)), $("actionFormError"));
    if (!r.ok) return;
    closeModal(el.actionModal);
    render();
    toast(actionCtx.id ? "Action saved." : "Action added.");
  }

  // ---------- Goal commands ----------
  async function completeGoal(id) {
    const e = engine();
    const g = e.goal(id);
    const m = e.measure(id);
    const open = e.descendants(id).filter((d) => A.progress.isOpen(d));
    const openNote = open.length ? `<p class="choice__note">${U.plural(open.length, "subordinate goal")} ${open.length === 1 ? "is" : "are"} still open and will stay open.</p>` : "";
    let opts = {};
    if (m.type === "numeric" && m.valid && !m.reached && !(m.rollup && m.aggregate)) {
      const choice = await choose("Complete goal", `<p><strong>${esc(g.name)}</strong> is at ${esc(U.fmtValue(m.current, m.fmt))}; the target is ${esc(U.fmtValue(m.target, m.fmt))}.</p>${openNote}`, [
        { label: `Record final value ${U.fmtValue(m.target, m.fmt)} and complete`, value: "final", kind: "primary" },
        { label: "Complete without changing the value", value: "plain" },
      ]);
      if (!choice) return;
      opts.recordFinal = choice === "final";
    } else if (open.length || (m.rollup && m.aggregate && !m.reached)) {
      const choice = await choose("Complete goal", `<p>Mark <strong>${esc(g.name)}</strong> complete?</p>${openNote}${m.rollup && !m.reached ? `<p class="choice__note">Its subgoal total hasn't reached the target yet.</p>` : ""}`, [{ label: "Mark complete", value: "yes", kind: "primary" }]);
      if (!choice) return;
    }
    const r = attempt(() => S.completeGoal(id, opts));
    if (!r.ok) return;
    render();
    const result = r.value || {};
    result.completed = [g].concat((result.completed || []).filter((x) => x.id !== g.id));
    celebrate(result, "Goal completed.");
  }
  async function deleteGoal(id) {
    const e = engine();
    const g = e.goal(id);
    const desc = e.descendants(id, { includeArchived: true });
    const entries = [id].concat(desc.map((d) => d.id)).reduce((n, gid) => n + e.entriesOf(gid).length, 0);
    const choice = await choose("Delete goal permanently", `<p>Delete <strong>${esc(g.name)}</strong>${desc.length ? ` and its ${U.plural(desc.length, "subordinate goal")}` : ""}, including ${U.plural(entries, "progress entry", "progress entries")}, milestones and actions?</p><p class="choice__note">This can't be undone. Archive instead to keep the history.</p>`, [
      { label: "Archive instead", value: "archive" },
      { label: "Delete permanently", value: "delete", kind: "danger" },
    ]);
    if (choice === "archive") return archiveGoal(id, true);
    if (choice !== "delete") return;
    const r = attempt(() => S.deleteGoal(id));
    if (!r.ok) return;
    go(r.value ? "#/goal/" + r.value : "#/goals");
    toast("Goal deleted.");
  }
  async function archiveGoal(id, confirmed) {
    const e = engine();
    const desc = e.descendants(id).length;
    if (!confirmed && desc) {
      const choice = await choose("Archive goal", `<p>Archive <strong>${esc(e.goal(id).name)}</strong> and its ${U.plural(desc, "open subordinate goal")}? Archived goals are hidden but keep their history; restore them from Goals → Archived.</p>`, [{ label: "Archive", value: "yes", kind: "primary" }]);
      if (!choice) return;
    }
    if (attempt(() => S.setStatus(id, "archived")).ok) { render(); toast("Archived."); }
  }
  async function correctEntry(id) {
    const e = engine();
    const en = e.db.entries.find((x) => x.id === id);
    if (!en) return;
    const g = e.goal(en.goalId);
    const fmt = e.fmtOf(g);
    const choice = await choose("Reverse entry", `<p>Add a correction that reverses the ${esc(U.fmtDate(en.date))} entry (${esc(U.fmtValue(en.changeAmount, fmt, { signed: true }))}) on <strong>${esc(g.name)}</strong>?</p><p class="choice__note">The original stays in the history; the current value becomes ${esc(U.fmtValue(U.round2(g.currentValue - en.changeAmount), fmt))}.</p>`, [{ label: "Add correction", value: "yes", kind: "primary" }]);
    if (!choice) return;
    const r = attempt(() => S.correctEntry(id));
    if (r.ok) { render(); celebrate(r.value, "Correction recorded."); }
  }

  // ---------- Settings, backup, cloud ----------
  function openSettings() { updateThemePicker(); openModal(el.settingsModal); }
  function setCloudStatus(msg, kind) {
    el.cloudStatus.textContent = msg || "";
    el.cloudStatus.className = "cloud-data-status" + (kind ? " cloud-data-status--" + kind : "");
  }
  function cloudPhrase() { return el.cloudPhrase.value.trim().replace(/\s+/g, " "); }
  function saveRememberedPhrase() {
    if (el.rememberPhrase.checked && cloudPhrase()) localStorage.setItem(REMEMBER_CLOUD_PHRASE_KEY, cloudPhrase());
    else if (!el.rememberPhrase.checked) localStorage.removeItem(REMEMBER_CLOUD_PHRASE_KEY);
  }
  async function generatePhrase() {
    if (cloudPhrase()) {
      const ok = await choose("Create a new phrase", "<p>Replace the phrase in the box with a brand-new one?</p><p class=\"choice__note\">If you already use a phrase in your other cloud apps, use that instead so they share one backup.</p>", [{ label: "Create new phrase", value: "yes", kind: "primary" }]);
      if (!ok) return;
    }
    el.cloudPhrase.value = A.sync.createRecoveryPhrase();
    el.cloudPhrase.type = "text";
    el.togglePhraseBtn.textContent = "Hide";
    el.togglePhraseBtn.setAttribute("aria-pressed", "true");
    el.cloudPhraseOut.hidden = false;
    el.cloudPhraseOut.textContent = "Write these 16 words down. They are the ONLY key to your cloud backup — they can't be recovered.";
    saveRememberedPhrase();
    setCloudStatus("New recovery phrase created. Save to cloud to use it.", "info");
  }
  async function cloudSave() {
    const phrase = cloudPhrase();
    if (!phrase) { setCloudStatus("Enter or create a recovery phrase first.", "error"); return; }
    setCloudStatus("Encrypting and saving cloud backup…", "info");
    try {
      await A.sync.saveToCloud(phrase, S.getDb(), getThemePref());
      saveRememberedPhrase();
      setCloudStatus("Saved to cloud. Use the same phrase to restore on another device.", "success");
    } catch (err) {
      setCloudStatus(err && err.code === "decrypt-existing"
        ? "A different cloud backup exists for this phrase and couldn't be decrypted. Check the phrase."
        : "Could not save to cloud. Your local Arcus data is still safe here.", "error");
    }
  }
  async function cloudLoad() {
    const phrase = cloudPhrase();
    if (!phrase) { setCloudStatus("Enter your recovery phrase first.", "error"); return; }
    setCloudStatus("Loading encrypted cloud backup…", "info");
    let data;
    try {
      data = await A.sync.loadFromCloud(phrase);
      if (!data) { setCloudStatus("No cloud backup exists for this phrase yet. Save from your first device first.", "error"); return; }
    } catch (err) {
      setCloudStatus("Could not decrypt cloud backup. Check the phrase or try again later.", "error");
      return;
    }
    let restored;
    try { restored = A.sync.readBackup(data); }
    catch (err) { setCloudStatus("This cloud backup has no Arcus data yet. Save to cloud from Arcus first.", "error"); return; }
    saveRememberedPhrase();
    if (await applyRestore(restored, "encrypted cloud sync")) setCloudStatus("Restored from cloud.", "success");
    else setCloudStatus("Cloud restore cancelled.", "info");
  }
  async function applyRestore(restored, label) {
    const n = restored.db.goals.length;
    const ok = await choose("Restore data", `<p>Restore ${U.plural(n, "goal")} with ${U.plural(restored.db.entries.length, "progress entry", "progress entries")} from ${esc(label)}?</p><p class="choice__note">This replaces your current Arcus data on this device.</p>`, [{ label: "Restore", value: "yes", kind: "primary" }]);
    if (!ok) return false;
    S.replaceDb(restored.db);
    if (restored.theme && (THEMES.includes(restored.theme) || restored.theme === "random")) setTheme(restored.theme);
    go("#/dashboard");
    return true;
  }
  function exportJSON() {
    const blob = new Blob([JSON.stringify(A.sync.createBackupData(S.getDb(), getThemePref(), null), null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "arcus-backup-" + U.todayISO() + ".json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast("Backup exported.");
  }
  function importJSON(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const restored = A.sync.readBackup(JSON.parse(reader.result));
        if (await applyRestore(restored, "backup file")) { closeModal(el.settingsModal); toast("Backup imported."); }
      } catch (err) {
        toast("That file doesn't contain Arcus data.");
      }
      el.importFile.value = "";
    };
    reader.readAsText(file);
  }
  async function loadDemo() {
    if (S.getDb().goals.length) {
      const ok = await choose("Load example data", "<p>Replace everything with the example goals (debt payoff, emergency fund, car restoration, half marathon)?</p><p class=\"choice__note\">Export first if you want to keep your current data.</p>", [{ label: "Replace with example", value: "yes", kind: "danger" }]);
      if (!ok) return;
    }
    S.replaceDb(A.demo.build());
    closeModal(el.settingsModal);
    go("#/dashboard");
    toast("Example goals loaded.");
  }
  async function clearAll() {
    const ok = await choose("Clear all data", "<p>Delete ALL goals, milestones, actions and progress history on this device?</p><p class=\"choice__note\">This can't be undone. Your cloud backup (if any) is not affected.</p>", [{ label: "Delete everything", value: "yes", kind: "danger" }]);
    if (!ok) return;
    S.replaceDb(M.emptyDb());
    closeModal(el.settingsModal);
    go("#/dashboard");
    toast("All data cleared.");
  }

  // ---------- Events ----------
  const ACTIONS = {
    "new-goal": () => openGoalForm(null, null),
    "demo": () => loadDemo(),
    "edit-goal": (id) => openGoalForm(id),
    "add-subgoal": (id) => openGoalForm(null, id),
    "record": (id) => openProgress(id),
    "complete": (id) => completeGoal(id),
    "reopen": (id) => { if (attempt(() => S.setStatus(id, "active")).ok) { render(); toast("Goal reopened."); } },
    "hold": (id) => { if (attempt(() => S.setStatus(id, "onHold")).ok) { render(); toast("Goal put on hold."); } },
    "resume": (id) => { if (attempt(() => S.setStatus(id, "active")).ok) { render(); toast("Goal resumed."); } },
    "archive": (id) => archiveGoal(id),
    "restore": (id) => { if (attempt(() => S.restoreGoal(id)).ok) { render(); toast("Restored."); } },
    "delete-goal": (id) => deleteGoal(id),
    "pin": (id) => { if (attempt(() => S.setFocus(id)).ok) { render(); toast("Pinned as your current focus."); } },
    "unpin": () => { if (attempt(() => S.setFocus(null)).ok) { render(); toast("Focus unpinned — Arcus will recommend one."); } },
    "move-goal": (id, b) => { if (attempt(() => S.moveGoal(id, +b.dataset.dir)).ok) render(); },
    "add-milestone": (id) => openMilestone(id),
    "edit-milestone": (id) => { const m = S.getDb().milestones.find((x) => x.id === id); if (m) openMilestone(m.goalId, id); },
    "delete-milestone": async (id) => {
      const m = S.getDb().milestones.find((x) => x.id === id);
      if (!m) return;
      const ok = await choose("Delete milestone", `<p>Delete the milestone <strong>${esc(m.name)}</strong>? Linked actions are kept.</p>`, [{ label: "Delete", value: "yes", kind: "danger" }]);
      if (ok && attempt(() => S.deleteMilestone(id)).ok) { render(); toast("Milestone deleted."); }
    },
    "move-milestone": (id, b) => { if (attempt(() => S.moveMilestone(id, +b.dataset.dir)).ok) render(); },
    "add-action": (id) => openAction(id),
    "edit-action": (id) => openAction(null, id),
    "delete-action": async (id) => {
      const a = S.getDb().actions.find((x) => x.id === id);
      if (!a) return;
      const ok = await choose("Delete action", `<p>Delete <strong>${esc(a.name)}</strong>?</p>`, [{ label: "Delete", value: "yes", kind: "danger" }]);
      if (ok && attempt(() => S.deleteAction(id)).ok) { render(); toast("Action deleted."); }
    },
    "toggle-done-actions": () => { ui.showDoneActions = !ui.showDoneActions; render(); },
    "add-dependency": (id) => {
      const sel = $("depSelect");
      if (!sel || !sel.value) { toast("Choose a prerequisite goal first."); return; }
      if (attempt(() => S.addDependency(id, sel.value)).ok) { render(); toast("Dependency added."); }
    },
    "remove-dependency": (id) => { if (attempt(() => S.removeDependency(id)).ok) { render(); toast("Dependency removed."); } },
    "correct-entry": (id) => correctEntry(id),
    "toggle-node": (id) => { const c = ui.explorer.collapsed; c.has(id) ? c.delete(id) : c.add(id); saveExplorer(); render(); },
    "collapse-all": () => {
      const c = ui.explorer.collapsed;
      if (c.size) c.clear(); else engine().db.goals.forEach((g) => { if (engine().children(g.id).length) c.add(g.id); });
      saveExplorer(); render();
    },
    "explorer-mode": (id, b) => { ui.explorer.mode = b.dataset.mode; saveExplorer(); render(); },
  };
  function onClick(ev) {
    const t = ev.target;
    const btn = t.closest("[data-act]");
    if (btn && btn.tagName !== "INPUT") {
      const fn = ACTIONS[btn.dataset.act];
      if (fn) {
        ev.preventDefault();
        const menu = btn.closest("details.menu");
        if (menu) menu.open = false;
        fn(btn.dataset.id, btn);
      }
      return;
    }
    // Whole-row navigation for tables/trees (links and controls inside keep their own behavior).
    const row = t.closest("[data-href]");
    if (row && !t.closest("a, button, input, select, label")) go(row.dataset.href);
  }
  function onChange(ev) {
    const t = ev.target;
    if (t.matches("input[data-act=toggle-action]")) {
      if (attempt(() => S.toggleAction(t.dataset.id)).ok) { render(); toast(t.checked ? "Action done." : "Action reopened."); }
    } else if (t.matches("input[data-act=toggle-milestone]")) {
      const r = attempt(() => S.toggleMilestone(t.dataset.id));
      if (r.ok) { render(); toast(r.value.status === "completed" ? `Milestone reached: ${r.value.name}` : "Milestone reopened."); }
    } else if (t.id === "explorerStatus" || t.id === "explorerPriority" || t.id === "explorerSort") {
      ui.explorer[{ explorerStatus: "status", explorerPriority: "priority", explorerSort: "sort" }[t.id]] = t.value;
      saveExplorer(); render();
    }
  }
  function onInput(ev) {
    if (ev.target.id === "explorerSearch") {
      ui.explorer.q = ev.target.value;
      const pos = ev.target.selectionStart;
      render();
      const s = $("explorerSearch");
      if (s) { s.focus(); s.setSelectionRange(pos, pos); }
    }
  }
  function saveExplorer() {
    const x = ui.explorer;
    sessionStorage.setItem(EXPLORER_KEY, JSON.stringify({ status: x.status, priority: x.priority, sort: x.sort, mode: x.mode, collapsed: Array.from(x.collapsed) }));
  }
  function loadExplorer() {
    try {
      const s = JSON.parse(sessionStorage.getItem(EXPLORER_KEY) || "null");
      if (!s) return;
      const x = ui.explorer;
      if (V.STATUS_FILTERS[s.status]) x.status = s.status;
      if (s.priority === "all" || M.PRIORITIES[s.priority]) x.priority = s.priority;
      if (typeof s.sort === "string") x.sort = s.sort;
      if (s.mode === "list" || s.mode === "tree") x.mode = s.mode;
      if (Array.isArray(s.collapsed)) x.collapsed = new Set(s.collapsed);
    } catch (e) { /* ignore */ }
  }

  // Drag-to-reorder subordinate goals (same parent only).
  function wireDrag() {
    let dragId = null;
    el.canvas.addEventListener("dragstart", (e) => {
      const row = e.target.closest && e.target.closest(".sub-row");
      if (!row) return;
      dragId = row.dataset.id;
      row.classList.add("is-dragging");
      e.dataTransfer.effectAllowed = "move";
      try { e.dataTransfer.setData("text/plain", dragId); } catch (err) { /* old browsers */ }
    });
    el.canvas.addEventListener("dragend", () => {
      dragId = null;
      el.canvas.querySelectorAll(".is-dragging, .is-drop-target").forEach((n) => n.classList.remove("is-dragging", "is-drop-target"));
    });
    el.canvas.addEventListener("dragover", (e) => {
      const row = e.target.closest && e.target.closest(".sub-row");
      if (!row || !dragId || row.dataset.id === dragId) return;
      e.preventDefault();
      el.canvas.querySelectorAll(".is-drop-target").forEach((n) => n.classList.remove("is-drop-target"));
      row.classList.add("is-drop-target");
    });
    el.canvas.addEventListener("drop", (e) => {
      const row = e.target.closest && e.target.closest(".sub-row");
      if (!row || !dragId) return;
      e.preventDefault();
      const id = dragId;
      dragId = null;
      if (attempt(() => S.moveGoalBefore(id, row.dataset.id)).ok) render();
    });
  }

  function bind() {
    document.addEventListener("click", onClick);
    document.addEventListener("change", onChange);
    document.addEventListener("input", onInput);
    window.addEventListener("hashchange", render);
    document.querySelectorAll(".modal").forEach((mdl) => mdl.addEventListener("click", (ev) => {
      if (ev.target.closest("[data-close]")) closeModal(mdl);
    }));
    el.topNewBtn.addEventListener("click", () => openGoalForm(null, null));
    el.topProgressBtn.addEventListener("click", () => openProgress(ui.route.id));
    el.settingsBtn.addEventListener("click", openSettings);

    el.goalForm.addEventListener("submit", submitGoalForm);
    el.goalForm.addEventListener("change", syncGoalForm);
    el.goalForm.addEventListener("input", (ev) => { if (ev.target.name === "startValue" || ev.target.name === "targetValue") syncGoalForm(); });
    el.progressForm.addEventListener("submit", submitProgress);
    el.progressForm.addEventListener("input", syncProgressForm);
    el.progressForm.goalId.addEventListener("change", syncProgressForm);
    el.progressMode.addEventListener("click", (ev) => { const b = ev.target.closest(".seg__btn"); if (b) setProgressMode(b.dataset.mode); });
    el.milestoneForm.addEventListener("submit", submitMilestone);
    el.actionForm.addEventListener("submit", submitAction);

    el.themePicker.addEventListener("click", (ev) => { const c = ev.target.closest(".theme-chip"); if (c) setTheme(c.dataset.themeVal); });
    el.exportBtn.addEventListener("click", exportJSON);
    el.importBtn.addEventListener("click", () => el.importFile.click());
    el.importFile.addEventListener("change", () => importJSON(el.importFile.files[0]));
    el.randomizeBtn.addEventListener("click", loadDemo);
    el.clearBtn.addEventListener("click", clearAll);
    el.aboutBtn.addEventListener("click", () => { closeModal(el.settingsModal); openModal(el.aboutModal); });
    el.cloudPhraseForm.addEventListener("submit", (ev) => ev.preventDefault());
    el.generatePhraseBtn.addEventListener("click", generatePhrase);
    el.togglePhraseBtn.addEventListener("click", () => {
      const show = el.cloudPhrase.type === "password";
      el.cloudPhrase.type = show ? "text" : "password";
      el.togglePhraseBtn.textContent = show ? "Hide" : "Show";
      el.togglePhraseBtn.setAttribute("aria-pressed", String(show));
    });
    el.rememberPhrase.addEventListener("change", saveRememberedPhrase);
    el.cloudSaveBtn.addEventListener("click", cloudSave);
    el.cloudLoadBtn.addEventListener("click", cloudLoad);

    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") {
        const openMenu = document.querySelector("details.menu[open]");
        if (openMenu) { openMenu.open = false; return; }
        if (modalStack.length) { ev.preventDefault(); closeModal(); }
        return;
      }
      const tag = document.activeElement && document.activeElement.tagName;
      if (modalStack.length || /^(INPUT|TEXTAREA|SELECT)$/.test(tag) || ev.metaKey || ev.ctrlKey || ev.altKey) return;
      if (ev.key === "n") { ev.preventDefault(); openGoalForm(null, ui.route.name === "goal" ? ui.route.id : null); }
      else if (ev.key === "r" && ui.route.name === "goal") { ev.preventDefault(); openProgress(ui.route.id); }
      else if (ev.key === "/") { ev.preventDefault(); if (ui.route.name !== "goals") go("#/goals"); setTimeout(() => { const s = $("explorerSearch"); if (s) s.focus(); }, 0); }
      else if (ev.key === "g") { go("#/goals"); }
      else if (ev.key === "f") { go("#/focus"); }
      else if (ev.key === "d") { go("#/dashboard"); }
    });
    // Close "More" menus when clicking elsewhere.
    document.addEventListener("click", (ev) => {
      document.querySelectorAll("details.menu[open]").forEach((d) => { if (!d.contains(ev.target)) d.open = false; });
    });
    // Another tab changed the data.
    window.addEventListener("storage", (ev) => { if (ev.key === S.STORE_KEY) { S.load(); render(); } });
    wireDrag();
  }

  function cache() {
    ["app", "canvas", "crumb", "nav", "railGoals", "focusBadge", "appVersion", "toast", "topNewBtn", "topProgressBtn", "settingsBtn",
      "goalModal", "goalModalTitle", "goalForm", "progressModal", "progressForm", "progressMode", "milestoneModal", "milestoneForm",
      "actionModal", "actionForm", "choiceModal", "choiceTitle", "choiceText", "choiceButtons",
      "settingsModal", "aboutModal", "aboutVersion", "themePicker", "exportBtn", "importBtn", "importFile", "randomizeBtn", "clearBtn", "aboutBtn",
      "cloudPhraseForm", "cloudPhrase", "togglePhraseBtn", "cloudPhraseOut", "rememberPhrase", "generatePhraseBtn", "cloudSaveBtn", "cloudLoadBtn", "cloudStatus",
    ].forEach((id) => { el[id] = $(id); });
  }

  function init() {
    cache();
    S.init();
    loadExplorer();
    el.appVersion.textContent = "v" + APP_VERSION;
    el.aboutVersion.textContent = "Version " + APP_VERSION;
    const saved = localStorage.getItem(REMEMBER_CLOUD_PHRASE_KEY);
    if (saved) { el.cloudPhrase.value = saved; el.rememberPhrase.checked = true; }
    bind();
    render();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})(window.Arcus);
