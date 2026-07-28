/* ============================================================
   SCHEDULER — deterministic day layout
   No DOM, no network, no model. Every minute of clock arithmetic
   for the AI planner happens in here, so the language model never
   has to add up times (it is bad at that). The model decides WHAT
   to schedule and in WHICH ORDER; this file decides WHEN, and is
   the thing that structurally guarantees the day is never
   over-scheduled.
   ============================================================ */

(function (root) {
  'use strict';

  const MIN_TASK = 5;      // shortest block we'll honour
  const MAX_TASK = 300;    // 5h — anything longer is a data-entry mistake
  const MAX_CUSHION = 90;

  // "8:30" | "08:30" → 510
  function toMinutes(timeStr) {
    if (typeof timeStr !== 'string') return null;
    const m = timeStr.trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h > 23 || min > 59) return null;
    return h * 60 + min;
  }

  // 510 → "08:30"
  function toHHMM(mins) {
    const clamped = Math.max(0, Math.min(23 * 60 + 59, Math.round(mins)));
    const h = Math.floor(clamped / 60);
    const m = clamped % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  // 510 → "8:30 AM"  (display only)
  function formatClock(mins) {
    const clamped = Math.max(0, Math.min(23 * 60 + 59, Math.round(mins)));
    let h = Math.floor(clamped / 60);
    const m = clamped % 60;
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return `${h}:${String(m).padStart(2, '0')} ${ampm}`;
  }

  // A sane end-of-day when the user only tells us when they woke up.
  // 13 waking hours from the start, never past 23:00.
  function defaultEndTime(startTime) {
    const start = toMinutes(startTime);
    if (start === null) return '22:00';
    return toHHMM(Math.min(start + 13 * 60, 23 * 60));
  }

  /**
   * Lay an ordered list of tasks onto the clock with cushions between them.
   *
   * @param {string} startTime      "HH:MM" wake-up / start of day
   * @param {string} [endTime]      "HH:MM" end of day (default: start + 13h)
   * @param {number} [cushionMin]   buffer inserted after each task (default 15)
   * @param {number} [maxLoadPercent] share of the waking window that may be
   *                                committed to tasks (default 65) — this is
   *                                what keeps the day from filling up
   * @param {Array}  items          [{ id, text, durationMin }] in priority order
   */
  function planBlocks(opts) {
    const o = opts || {};
    const startMin = toMinutes(o.startTime);
    if (startMin === null) {
      return { ok: false, error: `Could not read start time "${o.startTime}". Use 24-hour "HH:MM", e.g. "08:00".` };
    }

    const endMin = toMinutes(o.endTime || defaultEndTime(o.startTime));
    if (endMin === null) {
      return { ok: false, error: `Could not read end time "${o.endTime}". Use 24-hour "HH:MM", e.g. "22:00".` };
    }
    if (endMin <= startMin) {
      return { ok: false, error: `End of day (${o.endTime}) must be after the start (${o.startTime}). Overnight schedules aren't supported.` };
    }

    const cushionMin = clamp(numOr(o.cushionMin, 15), 0, MAX_CUSHION);
    const maxLoadPercent = clamp(numOr(o.maxLoadPercent, 65), 20, 100);

    const windowMin = endMin - startMin;
    const budgetMin = Math.floor((windowMin * maxLoadPercent) / 100);

    const items = Array.isArray(o.items) ? o.items : [];
    const scheduled = [];
    const skipped = [];

    let cursor = startMin;
    let workMin = 0;

    for (const item of items) {
      const raw = numOr(item && item.durationMin, NaN);
      if (!Number.isFinite(raw) || raw <= 0) {
        skipped.push({ id: item && item.id, text: item && item.text, reason: 'invalid-duration' });
        continue;
      }
      const duration = clamp(Math.round(raw), MIN_TASK, MAX_TASK);

      // A single task bigger than the whole budget can never fit
      if (duration > budgetMin) {
        skipped.push({
          id: item.id,
          text: item.text,
          reason: 'too-long-for-window',
          detail: `${duration}m exceeds the ${budgetMin}m of task time available today`
        });
        continue;
      }
      // Load cap: protects slack beyond the between-task cushions
      if (workMin + duration > budgetMin) {
        skipped.push({
          id: item.id,
          text: item.text,
          reason: 'over-load-cap',
          detail: `would push committed time past ${maxLoadPercent}% of the day`
        });
        continue;
      }
      // Hard wall at end of day
      if (cursor + duration > endMin) {
        skipped.push({
          id: item.id,
          text: item.text,
          reason: 'past-end-of-day',
          detail: `would run past ${toHHMM(endMin)}`
        });
        continue;
      }

      scheduled.push({
        id: item.id,
        text: item.text,
        start: toHHMM(cursor),
        end: toHHMM(cursor + duration),
        durationMin: duration
      });

      workMin += duration;
      cursor += duration + cushionMin;
    }

    // Cushions only count between tasks, not after the last one
    const cushionTotalMin = scheduled.length > 1 ? (scheduled.length - 1) * cushionMin : 0;

    return {
      ok: true,
      scheduled,
      skipped,
      startTime: toHHMM(startMin),
      endTime: toHHMM(endMin),
      windowMin,
      budgetMin,
      workMin,
      cushionMin,
      cushionTotalMin,
      freeMin: windowMin - workMin - cushionTotalMin,
      loadPercent: windowMin ? Math.round((workMin / windowMin) * 100) : 0
    };
  }

  // Human-readable chronological summary, e.g. "8:00–11:00 gym"
  function summarize(result) {
    if (!result || !result.ok) return '';
    return result.scheduled
      .map(b => `${formatClock(toMinutes(b.start))} – ${formatClock(toMinutes(b.end))}  ${b.text}`)
      .join('\n');
  }

  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
  function numOr(v, fallback) {
    const n = typeof v === 'string' ? parseFloat(v) : v;
    return Number.isFinite(n) ? n : fallback;
  }

  const api = { toMinutes, toHHMM, formatClock, defaultEndTime, planBlocks, summarize };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChoreScheduler = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
