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

  // Earliest start at or after `from` where the block, plus a cushion on either
  // side, clears everything already placed. Loops because stepping past one
  // block can land you inside the next.
  function firstFreeSlot(from, duration, occupied, cushion) {
    let start = from;
    for (let guard = 0; guard <= occupied.length; guard++) {
      const clash = occupied.find(b => start < b.end + cushion && b.start < start + duration + cushion);
      if (!clash) return start;
      start = clash.end + cushion;   // each pass clears at least one block
    }
    return start;
  }

  /**
   * Lay an ordered list of tasks onto the clock with cushions between them.
   *
   * List order is priority order and is also chronological order: an item
   * earlier in the list is never scheduled after a later one. Three optional
   * per-item constraints let a commitment be pinned or confined without the
   * caller doing any arithmetic itself:
   *
   *   startAt    "HH:MM" — pin to exactly this time
   *   notBefore  "HH:MM" — don't start before this
   *   notAfter   "HH:MM" — don't start after this
   *
   * Pinned items are laid down first and everything else flows around them, so
   * a fixed commitment ("helping family 17:00–18:00") holds its slot regardless
   * of what sits ahead of it in the list.
   *
   * @param {string} startTime      "HH:MM" wake-up / start of day
   * @param {string} [endTime]      "HH:MM" end of day (default: start + 13h)
   * @param {number} [cushionMin]   buffer inserted after each task (default 15)
   * @param {number} [maxLoadPercent] share of the waking window that may be
   *                                committed to tasks (default 65) — this is
   *                                what keeps the day from filling up
   * @param {Array}  items          [{ id, text, durationMin, startAt?,
   *                                notBefore?, notAfter? }] in priority order
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
    const occupied = [];      // every block laid down so far, as {start, end}

    let workMin = 0;

    const has = (v) => v !== undefined && v !== null && String(v).trim() !== '';
    const prepared = items.map(raw => {
      const it = raw || {};
      return {
        it,
        pinned: has(it.startAt),
        at: toMinutes(it.startAt),
        notBefore: toMinutes(it.notBefore),
        notAfter: toMinutes(it.notAfter),
        badWindow: (has(it.notBefore) && toMinutes(it.notBefore) === null) ||
                   (has(it.notAfter) && toMinutes(it.notAfter) === null)
      };
    });

    const skip = (it, reason, detail) =>
      skipped.push(detail
        ? { id: it && it.id, text: it && it.text, reason, detail }
        : { id: it && it.id, text: it && it.text, reason });

    // Duration and budget gates are identical for pinned and floating items.
    const durationOf = (it) => {
      const raw = numOr(it && it.durationMin, NaN);
      if (!Number.isFinite(raw) || raw <= 0) { skip(it, 'invalid-duration'); return null; }
      return clamp(Math.round(raw), MIN_TASK, MAX_TASK);
    };

    const fitsBudget = (it, duration) => {
      // A single task bigger than the whole budget can never fit
      if (duration > budgetMin) {
        skip(it, 'too-long-for-window', `${duration}m exceeds the ${budgetMin}m of task time available today`);
        return false;
      }
      // Load cap: protects slack beyond the between-task cushions
      if (workMin + duration > budgetMin) {
        skip(it, 'over-load-cap', `would push committed time past ${maxLoadPercent}% of the day`);
        return false;
      }
      return true;
    };

    const place = (it, duration, start, pinned) => {
      scheduled.push({
        id: it.id,
        text: it.text,
        start: toHHMM(start),
        end: toHHMM(start + duration),
        durationMin: duration,
        pinned: !!pinned
      });
      occupied.push({ start, end: start + duration });
      workMin += duration;
    };

    // ── Pass 1: pinned commitments claim their slots first ──────────
    for (const p of prepared) {
      if (!p.pinned) continue;
      if (p.at === null) { skip(p.it, 'bad-start-at', `could not read "${p.it.startAt}"; use 24-hour "HH:MM"`); continue; }
      const duration = durationOf(p.it);
      if (duration === null) continue;
      if (!fitsBudget(p.it, duration)) continue;

      if (p.at < startMin || p.at + duration > endMin) {
        skip(p.it, 'outside-day-window',
          `${toHHMM(p.at)}–${toHHMM(p.at + duration)} falls outside ${toHHMM(startMin)}–${toHHMM(endMin)}`);
        continue;
      }
      const clash = occupied.find(b => p.at < b.end && b.start < p.at + duration);
      if (clash) {
        skip(p.it, 'clashes-with-pinned-block',
          `${toHHMM(p.at)} overlaps the block at ${toHHMM(clash.start)}–${toHHMM(clash.end)}`);
        continue;
      }
      place(p.it, duration, p.at, true);
    }

    // ── Pass 2: everything else flows around the pins ───────────────
    // `cursor` only ever moves forward, which is what keeps list order and
    // clock order the same. A task pushed past a pin therefore drags the rest
    // of the list after it rather than back-filling the gap it left.
    let cursor = startMin;
    for (const p of prepared) {
      if (p.pinned) continue;
      if (p.badWindow) { skip(p.it, 'bad-time-constraint', 'notBefore/notAfter must be 24-hour "HH:MM"'); continue; }

      const duration = durationOf(p.it);
      if (duration === null) continue;
      if (!fitsBudget(p.it, duration)) continue;

      const earliest = Math.max(cursor, startMin, p.notBefore === null ? startMin : p.notBefore);
      const start = firstFreeSlot(earliest, duration, occupied, cushionMin);

      if (p.notAfter !== null && start > p.notAfter) {
        skip(p.it, 'no-slot-before-cutoff',
          `earliest free slot is ${toHHMM(start)}, past the ${toHHMM(p.notAfter)} cutoff`);
        continue;
      }
      // Hard wall at end of day
      if (start + duration > endMin) {
        skip(p.it, 'past-end-of-day', `would run past ${toHHMM(endMin)}`);
        continue;
      }

      place(p.it, duration, start, false);
      cursor = start + duration + cushionMin;
    }

    scheduled.sort((a, b) => toMinutes(a.start) - toMinutes(b.start));

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
