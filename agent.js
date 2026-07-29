/* ============================================================
   CHORE AGENT — Gemini function-calling loop
   The model is given tools that map onto real app operations and
   runs a read → act → observe loop until it has an answer. All
   clock arithmetic is delegated to scheduler.js; the model's job
   is judgement (what to do, in what order), not maths.
   ============================================================ */

(function () {
  'use strict';

  const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
  // Default to the Google-maintained "-latest" alias: it always resolves to a
  // current model, so it can't rot. Concrete dated ids (gemini-2.5-flash,
  // gemini-2.0-flash, the old 1.5 / 1.0 ids) get retired for new keys and 404
  // with "no longer available to new users", so we don't lead with them.
  const DEFAULT_MODEL = 'gemini-flash-latest';
  // Tried after the user's configured model — all maintained aliases so they
  // can't rot. gemini-flash-latest is repeated here on purpose: it guarantees a
  // live model is in the chain even when a stale concrete id is saved in
  // Settings. If every alias still misses, callGemini falls back to live
  // ListModels discovery (see discoverModels) so the chain can't dead-end.
  const FALLBACK_MODELS = ['gemini-flash-latest', 'gemini-pro-latest', 'gemini-flash-lite-latest'];
  const MAX_STEPS = 8;             // free tier is rate-limited; cap the loop
  const CATEGORIES = ['daily', 'errands', 'oneoff'];
  const URGENCIES = ['low', 'medium', 'high', 'urgent'];

  let GEMINI_KEY = localStorage.getItem('geminiKey') || '';
  let GEMINI_MODEL = localStorage.getItem('geminiModel') || DEFAULT_MODEL;

  // Once a model answers this session we pin it, so the loop doesn't re-probe a
  // dead model on every step. Reset whenever the key or configured model changes.
  let resolvedModel = null;

  let running = false;

  // ─────────────────────────────────────────────
  // TOOL DECLARATIONS
  // ─────────────────────────────────────────────
  const functionDeclarations = [
    {
      name: 'list_chores',
      description: 'Re-read the current chore list with ids, categories, durations, starred flags, completion state and any assigned time block. Call this after making changes if you need to confirm the new state.',
      parameters: {
        type: 'OBJECT',
        properties: {
          include_completed: { type: 'BOOLEAN', description: 'Include chores already marked done. Defaults to false.' }
        }
      }
    },
    {
      name: 'add_chore',
      description: 'Create a new chore.',
      parameters: {
        type: 'OBJECT',
        properties: {
          text: { type: 'STRING', description: 'What needs doing, phrased as a short task.' },
          category: { type: 'STRING', enum: CATEGORIES, description: 'daily = recurring habit, errands = shopping/out-of-house, oneoff = single task.' },
          urgency: { type: 'STRING', enum: URGENCIES, description: 'How pressing the task is. Defaults to medium. Use high/urgent for things that must happen today or have a near deadline.' },
          due_date: { type: 'STRING', description: 'Optional deadline date as "YYYY-MM-DD".' },
          due_time: { type: 'STRING', description: 'Optional deadline time as 24-hour "HH:MM". Only meaningful with due_date.' },
          duration_min: { type: 'NUMBER', description: 'Realistic estimate in minutes.' },
          starred: { type: 'BOOLEAN', description: 'Star it as a priority for today.' }
        },
        required: ['text', 'category']
      }
    },
    {
      name: 'update_chore',
      description: 'Change the text, category, urgency, due date or estimated duration of an existing chore. Use this to fill in duration estimates for chores that have none, or to raise urgency on a task the user flags as pressing.',
      parameters: {
        type: 'OBJECT',
        properties: {
          chore_id: { type: 'NUMBER' },
          text: { type: 'STRING' },
          category: { type: 'STRING', enum: CATEGORIES },
          urgency: { type: 'STRING', enum: URGENCIES },
          due_date: { type: 'STRING', description: 'Deadline date "YYYY-MM-DD". Pass an empty string to clear it.' },
          due_time: { type: 'STRING', description: 'Deadline time "HH:MM". Pass an empty string to clear it.' },
          duration_min: { type: 'NUMBER' }
        },
        required: ['chore_id']
      }
    },
    {
      name: 'set_chore_completed',
      description: 'Mark a chore done or not done.',
      parameters: {
        type: 'OBJECT',
        properties: {
          chore_id: { type: 'NUMBER' },
          completed: { type: 'BOOLEAN' }
        },
        required: ['chore_id', 'completed']
      }
    },
    {
      name: 'set_chore_starred',
      description: 'Star or unstar a chore. Starred chores are treated as priorities and are auto-added to the daily plan at midnight reset.',
      parameters: {
        type: 'OBJECT',
        properties: {
          chore_id: { type: 'NUMBER' },
          starred: { type: 'BOOLEAN' }
        },
        required: ['chore_id', 'starred']
      }
    },
    {
      name: 'delete_chore',
      description: 'Permanently delete a chore. The user must confirm in a dialog, so this can be declined — check the result.',
      parameters: {
        type: 'OBJECT',
        properties: { chore_id: { type: 'NUMBER' } },
        required: ['chore_id']
      }
    },
    {
      name: 'set_plan_membership',
      description: "Add a chore to, or remove it from, Today's plan without assigning a time.",
      parameters: {
        type: 'OBJECT',
        properties: {
          chore_id: { type: 'NUMBER' },
          in_plan: { type: 'BOOLEAN' }
        },
        required: ['chore_id', 'in_plan']
      }
    },
    {
      name: 'build_day_schedule',
      description: "Replace Today's plan with a time-blocked schedule. You supply the chores in the order they should happen and how long each takes; this tool does all the clock arithmetic, inserts cushions between tasks, stops at the end of the day and enforces a load cap so the day is never over-filled. It returns exactly what fit and what did not — read the result and tell the user, do not assume everything was scheduled.",
      parameters: {
        type: 'OBJECT',
        properties: {
          start_time: { type: 'STRING', description: 'Wake-up / start of day, 24-hour "HH:MM".' },
          end_time: { type: 'STRING', description: 'Wind-down time, 24-hour "HH:MM". Defaults to 13 hours after start.' },
          cushion_min: { type: 'NUMBER', description: 'Buffer in minutes after each task. Default 15. Use 20–30 for a deliberately relaxed day.' },
          max_load_percent: { type: 'NUMBER', description: 'Share of waking hours that may be committed to tasks. Default 65. Lower means a lighter day.' },
          items: {
            type: 'ARRAY',
            description: 'Chores in chronological order.',
            items: {
              type: 'OBJECT',
              properties: {
                chore_id: { type: 'NUMBER' },
                duration_min: { type: 'NUMBER', description: 'Estimate in minutes. Required — infer a realistic value if the chore has none.' }
              },
              required: ['chore_id', 'duration_min']
            }
          }
        },
        required: ['start_time', 'items']
      }
    },
    {
      name: 'set_time_block',
      description: 'Assign or clear the time block on a single chore, leaving the rest of the schedule alone. Pass no start/end to clear it.',
      parameters: {
        type: 'OBJECT',
        properties: {
          chore_id: { type: 'NUMBER' },
          start: { type: 'STRING', description: '24-hour "HH:MM".' },
          end: { type: 'STRING', description: '24-hour "HH:MM".' }
        },
        required: ['chore_id']
      }
    },
    {
      name: 'clear_day_schedule',
      description: "Remove all time blocks. Optionally also empty Today's plan.",
      parameters: {
        type: 'OBJECT',
        properties: {
          also_clear_plan: { type: 'BOOLEAN', description: "Also remove every chore from Today's plan. Defaults to false." }
        }
      }
    },
    {
      name: 'append_note',
      description: "Append a line to the user's notes area.",
      parameters: {
        type: 'OBJECT',
        properties: { text: { type: 'STRING' } },
        required: ['text']
      }
    }
  ];

  // ─────────────────────────────────────────────
  // TOOL IMPLEMENTATIONS
  // Each returns a plain object handed straight back to the model.
  // ─────────────────────────────────────────────
  const App = () => window.ChoresApp;
  const Sched = () => window.ChoreScheduler;

  function compactChore(c, plan, blocks) {
    const out = {
      id: c.id,
      text: c.text,
      category: c.type,
      urgency: URGENCIES.includes(c.urgency) ? c.urgency : 'medium',
      completed: !!c.completed,
      starred: !!c.starred,
      in_plan: plan.includes(c.id),
      duration_min: c.durationMin || null
    };
    if (!c.durationMin) out.duration_assumed = App().effectiveDuration(c);
    if (c.dueDate) {
      out.due_date = c.dueDate;
      if (c.dueTime) out.due_time = c.dueTime;
    }
    const b = blocks[c.id];
    if (b) out.time_block = `${b.start || '?'}–${b.end || '?'}`;
    return out;
  }

  function findChore(id) {
    return App().getChores().find(c => c.id === Number(id));
  }

  const tools = {
    list_chores(args) {
      const plan = App().getPlan();
      const blocks = App().getTimeBlocks();
      const includeDone = !!(args && args.include_completed);
      const chores = App().getChores()
        .filter(c => includeDone || !c.completed)
        .map(c => compactChore(c, plan, blocks));
      return { chores, count: chores.length };
    },

    add_chore(args) {
      const text = String(args.text || '').trim();
      if (!text) return { error: 'text is required' };
      const category = CATEGORIES.includes(args.category) ? args.category : 'oneoff';
      const urgency = URGENCIES.includes(args.urgency) ? args.urgency : 'medium';
      const id = Date.now() + Math.floor(Math.random() * 1000);
      const chore = {
        id,
        text,
        type: category,
        urgency,
        dueDate: args.due_date ? String(args.due_date).trim() : undefined,
        dueTime: args.due_time ? String(args.due_time).trim() : undefined,
        completed: false,
        starred: !!args.starred,
        durationMin: Number(args.duration_min) > 0 ? Math.round(Number(args.duration_min)) : undefined
      };
      App().setChores([...App().getChores(), chore]);
      if (chore.starred) {
        const plan = App().getPlan();
        if (!plan.includes(id)) App().setPlan([...plan, id]);
      }
      return { added: { id, text, category, urgency, due_date: chore.dueDate || null, duration_min: chore.durationMin || null, starred: chore.starred } };
    },

    update_chore(args) {
      const id = Number(args.chore_id);
      if (!findChore(id)) return { error: `no chore with id ${id}` };
      const changed = {};
      const next = App().getChores().map(c => {
        if (c.id !== id) return c;
        const u = { ...c };
        if (typeof args.text === 'string' && args.text.trim()) { u.text = args.text.trim(); changed.text = u.text; }
        if (CATEGORIES.includes(args.category)) { u.type = args.category; changed.category = u.type; }
        if (URGENCIES.includes(args.urgency)) { u.urgency = args.urgency; changed.urgency = u.urgency; }
        // An explicit empty string clears the field; a non-empty string sets it.
        if (typeof args.due_date === 'string') { u.dueDate = args.due_date.trim() || undefined; changed.due_date = u.dueDate || null; }
        if (typeof args.due_time === 'string') { u.dueTime = args.due_time.trim() || undefined; changed.due_time = u.dueTime || null; }
        if (Number(args.duration_min) > 0) { u.durationMin = Math.round(Number(args.duration_min)); changed.duration_min = u.durationMin; }
        return u;
      });
      App().setChores(next);
      return Object.keys(changed).length ? { updated: id, changed } : { updated: id, changed: null, note: 'nothing to change' };
    },

    set_chore_completed(args) {
      const id = Number(args.chore_id);
      const c = findChore(id);
      if (!c) return { error: `no chore with id ${id}` };
      App().setChores(App().getChores().map(x => x.id === id ? { ...x, completed: !!args.completed } : x));
      return { chore_id: id, text: c.text, completed: !!args.completed };
    },

    set_chore_starred(args) {
      const id = Number(args.chore_id);
      const c = findChore(id);
      if (!c) return { error: `no chore with id ${id}` };
      const starred = !!args.starred;
      App().setChores(App().getChores().map(x => x.id === id ? { ...x, starred } : x));
      let plan = App().getPlan();
      if (starred && !plan.includes(id)) plan = [...plan, id];
      if (!starred && plan.includes(id)) plan = plan.filter(p => p !== id);
      App().setPlan(plan);
      return { chore_id: id, text: c.text, starred };
    },

    async delete_chore(args) {
      const id = Number(args.chore_id);
      const c = findChore(id);
      if (!c) return { error: `no chore with id ${id}` };
      const confirmed = await App().confirmDelete(c.text);
      if (!confirmed) return { deleted: false, reason: 'user declined the confirmation dialog' };
      App().setChores(App().getChores().filter(x => x.id !== id));
      App().setPlan(App().getPlan().filter(p => p !== id));
      const blocks = App().getTimeBlocks();
      delete blocks[id];
      App().setTimeBlocks(blocks);
      return { deleted: true, chore_id: id, text: c.text };
    },

    set_plan_membership(args) {
      const id = Number(args.chore_id);
      const c = findChore(id);
      if (!c) return { error: `no chore with id ${id}` };
      let plan = App().getPlan();
      const want = !!args.in_plan;
      if (want && !plan.includes(id)) plan = [...plan, id];
      if (!want && plan.includes(id)) plan = plan.filter(p => p !== id);
      App().setPlan(plan);
      return { chore_id: id, text: c.text, in_plan: want };
    },

    build_day_schedule(args) {
      const chores = App().getChores();
      const items = (Array.isArray(args.items) ? args.items : []).map(it => {
        const id = Number(it && it.chore_id);
        const c = chores.find(x => x.id === id);
        return {
          id,
          text: c ? c.text : `(unknown chore ${id})`,
          durationMin: Number(it && it.duration_min) > 0
            ? Number(it.duration_min)
            : (c ? App().effectiveDuration(c) : NaN),
          missing: !c
        };
      });

      const unknown = items.filter(i => i.missing).map(i => i.id);
      const known = items.filter(i => !i.missing);

      const result = Sched().planBlocks({
        startTime: args.start_time,
        endTime: args.end_time,
        cushionMin: args.cushion_min,
        maxLoadPercent: args.max_load_percent,
        items: known
      });

      if (!result.ok) return { error: result.error };

      // Commit the layout: plan order follows the schedule, blocks come from it
      const blocks = {};
      result.scheduled.forEach(b => { blocks[b.id] = { start: b.start, end: b.end }; });
      App().setTimeBlocks(blocks);
      App().setPlan(result.scheduled.map(b => b.id));

      return {
        scheduled: result.scheduled.map(b => ({
          chore_id: b.id, text: b.text, start: b.start, end: b.end, duration_min: b.durationMin
        })),
        not_scheduled: result.skipped.map(s => ({
          chore_id: s.id, text: s.text, reason: s.reason, detail: s.detail || null
        })),
        day: {
          start: result.startTime,
          end: result.endTime,
          waking_minutes: result.windowMin,
          task_minutes: result.workMin,
          task_budget_minutes: result.budgetMin,
          cushion_between_tasks_min: result.cushionMin,
          unstructured_minutes: result.freeMin,
          load_percent: result.loadPercent
        },
        unknown_chore_ids: unknown.length ? unknown : undefined
      };
    },

    set_time_block(args) {
      const id = Number(args.chore_id);
      const c = findChore(id);
      if (!c) return { error: `no chore with id ${id}` };
      const blocks = App().getTimeBlocks();

      if (!args.start && !args.end) {
        delete blocks[id];
        App().setTimeBlocks(blocks);
        return { chore_id: id, text: c.text, time_block: null };
      }
      const s = Sched().toMinutes(args.start);
      const e = Sched().toMinutes(args.end);
      if (args.start && s === null) return { error: `bad start "${args.start}"; use "HH:MM"` };
      if (args.end && e === null) return { error: `bad end "${args.end}"; use "HH:MM"` };
      if (s !== null && e !== null && e <= s) return { error: 'end must be after start' };

      blocks[id] = { start: args.start || '', end: args.end || '' };
      App().setTimeBlocks(blocks);

      const plan = App().getPlan();
      if (!plan.includes(id)) App().setPlan([...plan, id]);

      return { chore_id: id, text: c.text, time_block: `${args.start || '?'}–${args.end || '?'}` };
    },

    clear_day_schedule(args) {
      App().setTimeBlocks({});
      if (args && args.also_clear_plan) App().setPlan([]);
      return { cleared: true, plan_emptied: !!(args && args.also_clear_plan) };
    },

    append_note(args) {
      const text = String(args.text || '').trim();
      if (!text) return { error: 'text is required' };
      App().appendNote(text);
      return { appended: text };
    }
  };

  // ─────────────────────────────────────────────
  // SYSTEM PROMPT
  // ─────────────────────────────────────────────
  function buildSystemPrompt() {
    const app = App();
    const plan = app.getPlan();
    const blocks = app.getTimeBlocks();
    const chores = app.getChores();
    const now = new Date();

    const openChores = chores.filter(c => !c.completed).map(c => compactChore(c, plan, blocks));
    const doneCount = chores.length - openChores.length;
    const notes = (app.getNotes() || '').trim();

    return [
      "You are the planning assistant built into a personal chores app. You act on the user's real data through the tools provided — you are not a chat bot describing what could be done, you make the changes.",
      '',
      `Today is ${now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}. The current time is ${now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}.`,
      '',
      'URGENCY & PRIORITY SCORING',
      'Every chore carries an urgency level. Treat it as a strict priority ladder and score each chore before ordering the day:',
      '  • urgent (score 4): must happen today. Give it the earliest suitable slot and never leave it out.',
      '  • high   (score 3): important today. Schedule ahead of medium and low; only drop it if the day is genuinely full.',
      '  • medium (score 2): normal. Fill the middle of the day with these.',
      '  • low    (score 1): nice-to-have. Schedule late, and these are the first to drop when trimming to fit.',
      'Due dates override the stored level upward, never downward. Using today’s date and time given above: a chore due today or already past due counts as at least high; a chore due within the next hour, or already overdue, counts as urgent. A chore is never demoted below its stored urgency because of its due date.',
      'Break ties in this order: higher urgency score first, then nearer due date/time, then starred, then daily habits, then time-sensitive errands, then one-offs.',
      'When the load cap forces you to leave chores out, drop strictly from the bottom of the ladder up. Never leave an urgent or overdue task unscheduled while a lower-scored one is placed.',
      '',
      'HOW TO BUILD A DAY',
      'When asked to plan the day, you will be told a wake-up or start time. Then:',
      '1. Score every incomplete chore with the urgency ladder above, adjusting for due dates. Sort by that score, breaking ties as described. Urgent and overdue tasks go into the earliest slots.',
      '2. Choose a BALANCED SUBSET that fits comfortably in the waking hours — not everything on the list. A day that feels achievable beats a day that is technically full. Leaving low-urgency chores for tomorrow is the correct behaviour, not a failure — but an urgent or overdue task is not something you may defer.',
      '3. Order them sensibly within the priority scoring: place higher-urgency and time-critical work in the earlier, protected slots; group errands into one outing so travel is shared; keep quiet or low-effort, low-urgency tasks for later in the day.',
      '4. Estimate a realistic duration for anything without one, and round to something human (15, 30, 45, 60 minutes). Err generous.',
      '5. Call build_day_schedule with the ordered list. It does the clock maths, inserts the cushions and enforces the limits. Never compute times yourself.',
      '6. Read what it returns. Report the schedule chronologically with exact start and end times, then say plainly what you left out and why — naming the urgency of anything you dropped.',
      '',
      'The default cushion is 15 minutes and the default load cap is 65% of waking hours. If the user asks for a gentle, slow or recovery day, raise the cushion to 20–30 and drop the load cap to 40–50. If they ask for a productive push, you may go to 75–80, but never remove cushions entirely.',
      '',
      'STYLE',
      "Be brief and concrete. Lead with the schedule itself. Don't pad with encouragement or restate the user's request back to them. If a tool returns an error or a refusal, say so honestly rather than pretending it worked.",
      '',
      'CURRENT STATE',
      `Incomplete chores (${openChores.length}${doneCount ? `, plus ${doneCount} already done` : ''}):`,
      openChores.length ? JSON.stringify(openChores, null, 1) : '(none)',
      '',
      `Chores currently in Today's plan, in order: ${plan.length ? JSON.stringify(plan) : '(empty)'}`,
      notes ? `\nUser's notes:\n${notes}` : '',
      '',
      'Durations shown as duration_assumed are category fallbacks, not the user\'s own estimates — replace them with better judgement and consider saving the improvement via update_chore.'
    ].join('\n');
  }

  // ─────────────────────────────────────────────
  // GEMINI CALL
  // Model resolution is three-tiered: (1) the configured model, then the static
  // FALLBACK_MODELS chain; (2) if all of those hit availability errors, live
  // ListModels discovery picks a model this key actually supports; (3) the first
  // model that answers is pinned for the session. Rate-limit and bad-key errors
  // are NOT retried on other models — they'd fail identically — so they surface
  // straight away.
  // ─────────────────────────────────────────────

  // Configured model first, then the fallbacks, de-duplicated.
  function modelCandidates() {
    const ordered = [GEMINI_MODEL, ...FALLBACK_MODELS];
    return ordered.filter((m, i) => m && ordered.indexOf(m) === i);
  }

  // True when the failure is specific to this model id, so another model is
  // worth trying: 404 (model not found for this key/API version), or a 400/403
  // whose message points at the model rather than the key or quota.
  function isModelAvailabilityError(status, detail) {
    if (status === 404) return true;
    const d = (detail || '').toLowerCase();
    if ((status === 400 || status === 403) && /API key/i.test(detail) === false) {
      return /model|not found|not supported|does not exist|no access|permission/.test(d);
    }
    return false;
  }

  async function requestModel(model, contents, systemPrompt) {
    const url = `${API_BASE}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(GEMINI_KEY)}`;
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents,
        tools: [{ functionDeclarations }],
        toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
        generationConfig: { temperature: 0.4, maxOutputTokens: 2048 }
      })
    });
  }

  async function readErrorDetail(res) {
    try {
      const err = await res.json();
      return (err && err.error && err.error.message) || '';
    } catch (e) { return ''; /* body wasn't json */ }
  }

  function candidateFromJson(json) {
    const candidate = json.candidates && json.candidates[0];
    if (!candidate) {
      const blocked = json.promptFeedback && json.promptFeedback.blockReason;
      throw new Error(blocked ? `Request blocked by Gemini (${blocked}).` : 'Gemini returned no candidates.');
    }
    return candidate;
  }

  // One generateContent attempt. Returns { candidate } on success or
  // { unavailable, detail } for a model-specific miss. Errors that every model
  // would share (rate limit, bad key) and genuine errors are thrown.
  async function attemptModel(model, contents, systemPrompt) {
    const res = await requestModel(model, contents, systemPrompt);
    if (res.ok) return { candidate: candidateFromJson(await res.json()) };

    const detail = await readErrorDetail(res);
    if (res.status === 429) {
      throw new Error(`Gemini free-tier rate limit hit. Wait a minute and try again.${detail ? ` (${detail})` : ''}`);
    }
    if (res.status === 400 && /API key/i.test(detail)) {
      throw new Error('Gemini rejected the API key. Check it in Settings.');
    }
    if (isModelAvailabilityError(res.status, detail)) return { unavailable: true, detail };
    throw new Error(`Gemini error ${res.status}${detail ? `: ${detail}` : ''}`);
  }

  // Rank whatever ListModels returned so discovery tries the most sensible first:
  // maintained "-latest" aliases, then full (non-lite) over lite, flash over pro
  // (fast/cheap for a simple scheduling task), stable over preview/specialised,
  // then newest version. The self-healing loop still skips any that 404 on use
  // (some ids are listed but retired), so this only needs to be a good ordering.
  function rankModels(names) {
    const version = (n) => { const m = n.match(/gemini-(\d+(?:\.\d+)?)/); return m ? parseFloat(m[1]) : 0; };
    const key = (n) => [
      /-latest$/.test(n) ? 0 : 1,
      /lite/.test(n) ? 1 : 0,
      /flash/.test(n) ? 0 : 1,
      /preview|exp|thinking|tts|image|robotics|computer-use|customtools|embedding|aqa/.test(n) ? 1 : 0,
      -version(n)
    ];
    return names
      .map((n, idx) => ({ n, idx, k: key(n) }))
      .sort((a, b) => { for (let i = 0; i < a.k.length; i++) { if (a.k[i] !== b.k[i]) return a.k[i] - b.k[i]; } return a.idx - b.idx; })
      .map(x => x.n);
  }

  // Ask the API which models THIS key can use for generateContent. This is the
  // self-healing backstop: even if every hardcoded id is retired, we still find
  // a live model instead of dead-ending on a stale list.
  async function discoverModels() {
    const res = await fetch(`${API_BASE}?key=${encodeURIComponent(GEMINI_KEY)}&pageSize=1000`);
    if (!res.ok) return { ok: false, status: res.status, detail: await readErrorDetail(res) };
    const json = await res.json();
    const names = (json.models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => String(m.name).replace(/^models\//, ''));
    return { ok: true, models: rankModels(names) };
  }

  async function callGemini(contents, systemPrompt) {
    const tried = [];

    // Walk a list of model ids, skipping any already tried, and return the first
    // candidate. Pins the winner and notes it once when it isn't the primary.
    const runChain = async (models) => {
      for (const model of models) {
        if (tried.includes(model)) continue;
        tried.push(model);
        const r = await attemptModel(model, contents, systemPrompt);
        if (r.candidate) {
          if (resolvedModel !== model) {
            if (tried.length > 1) logNote(`Using Gemini model “${model}”.`);
            resolvedModel = model;
          }
          return r.candidate;
        }
      }
      return null;
    };

    // 1) A model already proven this session — reuse it, but if it has since
    //    stopped working, clear the pin and fall through to a fresh search.
    if (resolvedModel) {
      const c = await runChain([resolvedModel]);
      if (c) return c;
      resolvedModel = null;
    }

    // 2) Configured model, then the static fast-path chain.
    let c = await runChain(modelCandidates());
    if (c) return c;

    // 3) Self-healing: discover what this key actually supports.
    const disc = await discoverModels();
    if (!disc.ok) {
      if (disc.status === 400 && /API key/i.test(disc.detail)) {
        throw new Error('Gemini rejected the API key. Check it in Settings.');
      }
      throw new Error(`No configured Gemini model worked, and the available-model list couldn't be read (HTTP ${disc.status}${disc.detail ? `: ${disc.detail}` : ''}).`);
    }
    if (disc.models.length) logNote(`Configured models unavailable — checking ${disc.models.length} model(s) your key supports.`);
    c = await runChain(disc.models);
    if (c) return c;

    throw new Error(
      `No available Gemini model. Tried ${tried.join(', ') || '(none)'}. ` +
      (disc.models.length
        ? `Your key's generateContent models are: ${disc.models.join(', ')}. Set one of these in Settings.`
        : 'ListModels returned no generateContent models — the key may be invalid or the Generative Language API not enabled for it.')
    );
  }

  // ─────────────────────────────────────────────
  // AGENT LOOP
  // ─────────────────────────────────────────────
  async function runAgent(userMessage) {
    if (running) return;
    if (!GEMINI_KEY) {
      logError('No Gemini API key yet — add one in Settings. A free key comes from aistudio.google.com/apikey.');
      return;
    }

    running = true;
    setBusy(true);
    logUser(userMessage);

    const systemPrompt = buildSystemPrompt();
    const contents = [{ role: 'user', parts: [{ text: userMessage }] }];
    let mutated = false;

    try {
      for (let step = 0; step < MAX_STEPS; step++) {
        const candidate = await callGemini(contents, systemPrompt);
        const parts = (candidate.content && candidate.content.parts) || [];
        const calls = parts.filter(p => p.functionCall).map(p => p.functionCall);
        const text = parts.filter(p => p.text).map(p => p.text).join('').trim();

        // Model is done acting and has an answer
        if (!calls.length) {
          if (text) logAnswer(text);
          else logError('Gemini finished without saying anything. Try rephrasing.');
          return;
        }

        contents.push(candidate.content);

        // Gemini may return several calls in one turn — run them all,
        // then hand every result back in a single follow-up message.
        const responseParts = [];
        for (const call of calls) {
          const impl = tools[call.name];
          let result;
          if (!impl) {
            result = { error: `unknown tool "${call.name}"` };
          } else {
            try {
              result = await impl(call.args || {});
            } catch (e) {
              result = { error: `tool threw: ${e.message}` };
            }
          }
          if (impl && call.name !== 'list_chores') mutated = true;
          logTool(call.name, call.args || {}, result);
          responseParts.push({ functionResponse: { name: call.name, response: result } });
        }

        contents.push({ role: 'user', parts: responseParts });
      }

      logError(`Stopped after ${MAX_STEPS} tool rounds without a final answer. Any changes already made have been kept.`);
    } catch (e) {
      logError(e.message || String(e));
    } finally {
      // Re-render and sync once, whatever happened — mutations already wrote
      // to localStorage, so nothing is lost if the loop errored mid-way.
      if (mutated) App().commit();
      running = false;
      setBusy(false);
    }
  }

  // ─────────────────────────────────────────────
  // TRANSCRIPT UI
  // Built with textContent throughout — model output is never
  // interpolated into innerHTML.
  // ─────────────────────────────────────────────
  function logEl() { return document.getElementById('agent-log'); }

  function appendEntry(className, build) {
    const box = logEl();
    if (!box) return;
    const row = document.createElement('div');
    row.className = `agent-entry ${className}`;
    build(row);
    box.appendChild(row);
    box.scrollTop = box.scrollHeight;
  }

  function logUser(text) {
    appendEntry('agent-user', row => {
      const label = document.createElement('span');
      label.className = 'agent-entry-label';
      label.textContent = 'You';
      const body = document.createElement('div');
      body.textContent = text;
      row.append(label, body);
    });
  }

  function logAnswer(text) {
    appendEntry('agent-answer', row => {
      const label = document.createElement('span');
      label.className = 'agent-entry-label';
      label.textContent = 'Planner';
      const body = document.createElement('div');
      body.className = 'agent-answer-body';
      body.textContent = text;
      row.append(label, body);
    });
  }

  function logError(text) {
    appendEntry('agent-error', row => {
      const icon = document.createElement('i');
      icon.className = 'fas fa-triangle-exclamation';
      const body = document.createElement('span');
      body.textContent = ` ${text}`;
      row.append(icon, body);
    });
  }

  // Muted informational line — reuses the small tool-receipt styling.
  function logNote(text) {
    appendEntry('agent-tool', row => {
      const icon = document.createElement('i');
      icon.className = 'fas fa-circle-info';
      const body = document.createElement('span');
      body.className = 'agent-tool-summary';
      body.textContent = ` ${text}`;
      row.append(icon, body);
    });
  }

  // One line per tool call, with a short human summary of the outcome
  function logTool(name, args, result) {
    appendEntry('agent-tool', row => {
      const icon = document.createElement('i');
      icon.className = 'fas fa-gear';
      const label = document.createElement('span');
      label.className = 'agent-tool-name';
      label.textContent = ` ${name}`;
      const summary = document.createElement('span');
      summary.className = 'agent-tool-summary';
      summary.textContent = ` ${summarizeToolResult(name, args, result)}`;
      row.append(icon, label, summary);
    });
  }

  function summarizeToolResult(name, args, result) {
    if (result && result.error) return `→ ${result.error}`;
    switch (name) {
      case 'list_chores':
        return `→ read ${result.count} chore${result.count === 1 ? '' : 's'}`;
      case 'add_chore':
        return `→ added “${result.added.text}”`;
      case 'update_chore':
        return result.changed ? `→ updated ${Object.keys(result.changed).join(', ')} on “${shortText(args.chore_id)}”` : '→ no change';
      case 'set_chore_completed':
        return `→ “${result.text}” ${result.completed ? 'done' : 'reopened'}`;
      case 'set_chore_starred':
        return `→ “${result.text}” ${result.starred ? 'starred' : 'unstarred'}`;
      case 'delete_chore':
        return result.deleted ? `→ deleted “${result.text}”` : '→ you declined the deletion';
      case 'set_plan_membership':
        return `→ “${result.text}” ${result.in_plan ? 'added to today' : 'removed from today'}`;
      case 'set_time_block':
        return result.time_block ? `→ “${result.text}” at ${result.time_block}` : `→ cleared block on “${result.text}”`;
      case 'clear_day_schedule':
        return '→ schedule cleared';
      case 'append_note':
        return '→ note added';
      case 'build_day_schedule': {
        const n = result.scheduled.length;
        const left = result.not_scheduled.length;
        return `→ ${n} block${n === 1 ? '' : 's'} ${result.day.start}–${result.day.end}, ${result.day.load_percent}% load${left ? `, ${left} left out` : ''}`;
      }
      default:
        return '→ done';
    }
  }

  function shortText(choreId) {
    const c = findChore(choreId);
    return c ? c.text : `#${choreId}`;
  }

  function setBusy(busy) {
    const status = document.getElementById('agent-status');
    const planBtn = document.getElementById('agent-plan-btn');
    const askBtn = document.getElementById('agent-ask-btn');
    if (status) status.textContent = busy ? 'Thinking…' : '';
    [planBtn, askBtn].forEach(b => { if (b) b.disabled = busy; });
    if (planBtn) {
      planBtn.innerHTML = busy
        ? '<i class="fas fa-spinner fa-spin"></i> Planning…'
        : '<i class="fas fa-wand-magic-sparkles"></i> Plan my day';
    }
  }

  // ─────────────────────────────────────────────
  // WIRING
  // ─────────────────────────────────────────────
  function currentTimeHHMM() {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  function planMyDay() {
    const wake = document.getElementById('agent-wake-time').value || currentTimeHHMM();
    const end = document.getElementById('agent-end-time').value;
    const cushion = document.getElementById('agent-cushion').value;
    const load = document.getElementById('agent-load').value;

    const parts = [`Plan my day. I'm starting at ${wake}.`];
    if (end) parts.push(`I want to be winding down by ${end}.`);
    parts.push(`Use a cushion of about ${cushion} minutes between tasks and a load cap of ${load}%.`);
    parts.push('Pick a balanced subset of my incomplete chores, build the schedule with build_day_schedule, then show me the chronological result and tell me what you left for another day.');

    runAgent(parts.join(' '));
  }

  function askFreeform() {
    const input = document.getElementById('agent-prompt');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    runAgent(text);
  }

  function init() {
    const wake = document.getElementById('agent-wake-time');
    if (wake && !wake.value) wake.value = currentTimeHHMM();

    const planBtn = document.getElementById('agent-plan-btn');
    const askBtn = document.getElementById('agent-ask-btn');
    const prompt = document.getElementById('agent-prompt');
    const clearBtn = document.getElementById('agent-clear-log-btn');

    if (planBtn && !planBtn.dataset.wired) {
      planBtn.dataset.wired = '1';
      planBtn.addEventListener('click', planMyDay);
    }
    if (askBtn && !askBtn.dataset.wired) {
      askBtn.dataset.wired = '1';
      askBtn.addEventListener('click', askFreeform);
    }
    if (prompt && !prompt.dataset.wired) {
      prompt.dataset.wired = '1';
      prompt.addEventListener('keydown', e => { if (e.key === 'Enter') askFreeform(); });
    }
    if (clearBtn && !clearBtn.dataset.wired) {
      clearBtn.dataset.wired = '1';
      clearBtn.addEventListener('click', () => { const b = logEl(); if (b) b.innerHTML = ''; });
    }
  }

  // Settings modal calls this after saving
  function setCredentials(key, model) {
    GEMINI_KEY = key || '';
    GEMINI_MODEL = model || DEFAULT_MODEL;
    resolvedModel = null; // re-probe the chain with the new key/model
    localStorage.setItem('geminiKey', GEMINI_KEY);
    localStorage.setItem('geminiModel', GEMINI_MODEL);
  }

  window.ChoreAgent = {
    init,
    setCredentials,
    run: runAgent,
    getModel: () => GEMINI_MODEL,
    getKey: () => GEMINI_KEY,
    defaultModel: DEFAULT_MODEL
  };
})();
