/* Arcus — shared utilities (no DOM, no state). */
(function (A) {
  "use strict";

  const DAY_MS = 86400000;

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  // Parses a number; returns null for blank/invalid input (so "unset" is distinguishable from 0).
  function numOrNull(v) {
    if (v === null || v === undefined || v === "") return null;
    const n = typeof v === "number" ? v : parseFloat(String(v).replace(/[,\s$€£¥]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  function round2(n) { return Math.round(n * 100) / 100; }
  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

  function localISO(d) {
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  }
  function todayISO() { return localISO(new Date()); }
  function isoOffset(days, fromIso) {
    const base = fromIso ? parseDate(fromIso) : startOfToday();
    return localISO(new Date(base.getTime() + days * DAY_MS + 3600000)); // +1h guards DST edges
  }
  function isISODate(s) { return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !!parseDate(s); }
  function parseDate(iso) {
    if (!iso) return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso));
    if (!m) return null;
    const d = new Date(+m[1], +m[2] - 1, +m[3]);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  function startOfToday() {
    const t = new Date();
    return new Date(t.getFullYear(), t.getMonth(), t.getDate());
  }
  function daysBetween(aIso, bIso) {
    const a = parseDate(aIso), b = parseDate(bIso);
    if (!a || !b) return null;
    return Math.round((b - a) / DAY_MS);
  }
  function daysUntil(iso) { return daysBetween(todayISO(), iso); }

  function fmtDate(iso, opts) {
    const d = parseDate(iso);
    return d ? d.toLocaleDateString(undefined, opts || { month: "short", day: "numeric", year: "numeric" }) : "";
  }
  function fmtShort(iso) {
    const d = parseDate(iso);
    if (!d) return "";
    const sameYear = d.getFullYear() === new Date().getFullYear();
    return d.toLocaleDateString(undefined, sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
  }
  function fmtMonthYear(iso) { return fmtDate(iso, { month: "short", year: "numeric" }); }

  function fmtNumber(n, maxFrac) {
    const abs = Math.abs(n);
    const frac = maxFrac != null ? maxFrac : (Number.isInteger(n) ? 0 : abs >= 1000 ? 0 : 2);
    return n.toLocaleString(undefined, { maximumFractionDigits: frac });
  }
  function fmtMoney(n, currency, opts) {
    const cents = (opts && opts.cents) || (!Number.isInteger(round2(n)) && Math.abs(n) < 10000);
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: currency || "USD",
        minimumFractionDigits: cents ? 2 : 0,
        maximumFractionDigits: cents ? 2 : 0,
      }).format(n);
    } catch (e) {
      return (currency || "") + " " + fmtNumber(n, 2);
    }
  }
  // Formats a value in a goal's measurement (currency/percentage/unit).
  function fmtValue(n, fmt, opts) {
    if (n === null || n === undefined || !Number.isFinite(n)) return "—";
    const sign = opts && opts.signed && n > 0 ? "+" : "";
    const t = fmt && fmt.measurementType;
    if (t === "currency") return sign + fmtMoney(n, fmt.currency, opts);
    if (t === "percentage") return sign + fmtNumber(n) + "%";
    const unit = fmt && fmt.unit ? " " + fmt.unit : "";
    return sign + fmtNumber(n) + unit;
  }
  function plural(n, word, pluralWord) {
    return fmtNumber(n) + " " + (n === 1 ? word : (pluralWord || word + "s"));
  }
  function humanDays(days) {
    const d = Math.abs(days);
    if (d === 0) return "today";
    if (d < 14) return plural(d, "day");
    if (d < 63) return plural(Math.round(d / 7), "week");
    if (d < 730) return plural(Math.round(d / 30.44), "month");
    return (d / 365.25).toFixed(1) + " years";
  }
  function relDays(days) {
    if (days === null || days === undefined) return "";
    if (days === 0) return "today";
    if (days === 1) return "tomorrow";
    if (days === -1) return "yesterday";
    return days > 0 ? "in " + humanDays(days) : humanDays(days) + " ago";
  }

  A.util = {
    DAY_MS, uid, escapeHtml, numOrNull, round2, clamp,
    todayISO, isoOffset, isISODate, parseDate, daysBetween, daysUntil, localISO,
    fmtDate, fmtShort, fmtMonthYear, fmtNumber, fmtMoney, fmtValue, plural, humanDays, relDays,
  };
})(typeof window !== "undefined" ? (window.Arcus = window.Arcus || {}) : (globalThis.Arcus = globalThis.Arcus || {}));
