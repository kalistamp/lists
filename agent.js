/* ============================================================
   CHORE AGENT — provider-agnostic function-calling loop
   The model is given tools that map onto real app operations and
   runs a read → act → observe loop until it has an answer. All
   clock arithmetic is delegated to scheduler.js; the model's job
   is judgement (what to do, in what order), not maths.

   Gemini, OpenAI and Anthropic are all supported. Everything above
   the PROVIDERS section — tools, prompt, scheduling, transcript —
   is shared; each adapter only knows its vendor's wire format.
   ============================================================ */

(function () {
  'use strict';

  const MAX_STEPS = 8;
  // How far down the discovered list Auto will walk before giving up on it and
  // falling back to the built-in chain. Without a cap, a provider-wide outage
  // would try every model the key can see, one request each.
  const AUTO_TRY_LIMIT = 5;
  const CATEGORIES = ['daily', 'errands', 'oneoff'];
  const URGENCIES = ['low', 'medium', 'high', 'urgent'];

  const PROVIDER_IDS = ['gemini', 'openai', 'anthropic'];
  const DEFAULT_PROVIDER = 'gemini';

  // Credentials are kept per provider so switching back and forth never makes
  // you re-paste a key. Gemini keeps its original storage names so installs
  // that predate multi-provider support carry over untouched.
  const STORAGE = {
    provider: 'aiProvider',
    migrated: 'modelPinMigrated',
    gemini: { key: 'geminiKey', model: 'geminiModel' },
    openai: { key: 'openaiKey', model: 'openaiModel' },
    anthropic: { key: 'anthropicKey', model: 'anthropicModel' }
  };

  let activeProvider = DEFAULT_PROVIDER;
  const creds = {};          // provider id → { key, model }
  const resolvedModel = {};  // provider id → the model id that last answered
  let running = false;

  // Display-only record of the model that actually produced the last draft.
  // Deliberately separate from `resolvedModel`, which drives request routing:
  // that one stays session-only so a model that was merely busy last time is
  // still retried first on the next load. This one persists, so the label keeps
  // describing the plan sitting in the list after a page reload.
  let lastDraftModel = localStorage.getItem('lastPlannerModel') || '';

  // ─────────────────────────────────────────────
  // TOOL DECLARATIONS
  // ─────────────────────────────────────────────
  const functionDeclarations = [
    {
      name: 'list_chores',
      description: 'Re-read the current chore list with ids, categories, durations, starred flags, completion state and any assigned time block. Note: "daily" chores are filtered out as they are excluded from AI day planning.',
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
      name: 'set_inferred_priority',
      description: "Record your own read of how pressing chores are, judged from what the tasks actually involve. This is advisory: it never overwrites the user's own urgency setting, it is shown alongside it in the list, and it only affects ordering where they left the default in place. Assess everything worth assessing in ONE batched call rather than calling this repeatedly.",
      parameters: {
        type: 'OBJECT',
        properties: {
          assessments: {
            type: 'ARRAY',
            description: 'One entry per chore you have formed a view on.',
            items: {
              type: 'OBJECT',
              properties: {
                chore_id: { type: 'NUMBER' },
                level: { type: 'STRING', enum: URGENCIES, description: 'How pressing this genuinely is, on the same ladder as the urgency field.' },
                reason: { type: 'STRING', description: 'One short clause naming the consequence of leaving it — not a restatement of the task. e.g. "late fee after the 8th", "water damage if it keeps dripping".' }
              },
              required: ['chore_id', 'level', 'reason']
            }
          }
        },
        required: ['assessments']
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
      description: 'Star or unstar a chore. Starred non-daily chores are treated as priorities and are auto-added to the daily plan.',
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
      description: "Replace Today's plan with a time-blocked schedule. You supply non-daily chores in the order they should happen and how long each takes; this tool does all the clock arithmetic, inserts cushions between tasks, stops at the end of the day and enforces a load cap. Any omitted setting falls back to the day window shown in your instructions, so pass one only when the user asked for something different. Note: any 'daily' chores are automatically filtered out.",
      parameters: {
        type: 'OBJECT',
        properties: {
          start_time: { type: 'STRING', description: 'Wake-up / start of day, 24-hour "HH:MM". Defaults to the start of the day window.' },
          end_time: { type: 'STRING', description: 'Wind-down time, 24-hour "HH:MM". Defaults to the end of the day window.' },
          cushion_min: { type: 'NUMBER', description: 'Buffer in minutes after each task. Defaults to the day window cushion. Use 20–30 for a deliberately relaxed day.' },
          max_load_percent: { type: 'NUMBER', description: 'Share of waking hours that may be committed to tasks. Defaults to the day window fullness cap. Lower means a lighter day.' },
          items: {
            type: 'ARRAY',
            description: 'Chores in priority order, which is also the order they will run in.',
            items: {
              type: 'OBJECT',
              properties: {
                chore_id: { type: 'NUMBER' },
                duration_min: { type: 'NUMBER', description: 'Estimate in minutes. Required — infer a realistic value if the chore has none.' },
                start_at: { type: 'STRING', description: 'Pin to exactly this 24-hour "HH:MM". Use only for a real fixed commitment the user gave a time for ("the call is at 2"). Pinned items claim their slot first and everything else is laid around them.' },
                not_before: { type: 'STRING', description: 'Earliest it may start, 24-hour "HH:MM". This is how you honour "later on", "after lunch", "towards the end of the day" — give the boundary, not a computed slot.' },
                not_after: { type: 'STRING', description: 'Latest it may start, 24-hour "HH:MM". Use for "before the shops shut", "first thing".' }
              },
              required: ['chore_id', 'duration_min']
            }
          }
        },
        required: ['items']
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
  // ─────────────────────────────────────────────
  const App = () => window.ChoresApp;
  const Sched = () => window.ChoreScheduler;

  // The planner's start / wind-down / cushion / fullness controls describe the
  // day itself, not just the arguments of the "Plan my day" button. A freeform
  // ask like "shift everything an hour later" is unanswerable without them, so
  // they are read fresh on every run and fed to BOTH entry points — as context
  // in the system prompt and as the defaults build_day_schedule falls back to.
  function readDayControls() {
    const val = (id) => {
      if (typeof document === 'undefined') return '';
      const el = document.getElementById(id);
      return el ? String(el.value || '').trim() : '';
    };
    const num = (id, fallback) => {
      const n = Number(val(id));
      return Number.isFinite(n) && n > 0 ? n : fallback;
    };

    const start = val('agent-wake-time') || currentTimeHHMM();
    const endRaw = val('agent-end-time');
    const end = endRaw || Sched().defaultEndTime(start);
    return { start, end, endExplicit: !!endRaw, cushion: num('agent-cushion', 15), load: num('agent-load', 65) };
  }

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
    // Chore ids are creation timestamps (Date.now()), so age costs nothing to
    // derive — and it is the most useful tiebreak left when every task carries
    // the same default urgency.
    const age = choreAgeDays(c);
    if (age !== null) out.age_days = age;
    // A previous run's judgement, so it isn't re-derived from scratch each time.
    if (URGENCIES.includes(c.inferredUrgency)) {
      out.inferred_urgency = c.inferredUrgency;
      if (c.inferredReason) out.inferred_reason = c.inferredReason;
    }
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

  // Ids are Date.now() at creation. Anything outside a plausible range isn't a
  // timestamp (hand-edited data, an imported gist), so report no age at all
  // rather than a made-up one.
  const ID_EPOCH_FLOOR = Date.UTC(2020, 0, 1);
  function choreAgeDays(c) {
    const id = Number(c && c.id);
    if (!Number.isFinite(id) || id < ID_EPOCH_FLOOR || id > Date.now()) return null;
    return Math.floor((Date.now() - id) / 86400000);
  }

  const tools = {
    list_chores(args) {
      const plan = App().getPlan();
      const blocks = App().getTimeBlocks();
      const includeDone = !!(args && args.include_completed);

      // REQUIREMENT 4: Filter out any task whose category is "daily"
      const chores = App().getChores()
        .filter(c => (includeDone || !c.completed) && c.type !== 'daily')
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
      if (chore.starred && chore.type !== 'daily') {
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
        if (typeof args.due_date === 'string') { u.dueDate = args.due_date.trim() || undefined; changed.due_date = u.dueDate || null; }
        if (typeof args.due_time === 'string') { u.dueTime = args.due_time.trim() || undefined; changed.due_time = u.dueTime || null; }
        if (Number(args.duration_min) > 0) { u.durationMin = Math.round(Number(args.duration_min)); changed.duration_min = u.durationMin; }
        return u;
      });
      App().setChores(next);
      return Object.keys(changed).length ? { updated: id, changed } : { updated: id, changed: null, note: 'nothing to change' };
    },

    set_inferred_priority(args) {
      const list = Array.isArray(args.assessments) ? args.assessments : [];
      if (!list.length) return { error: 'assessments is required and must not be empty' };

      const chores = App().getChores();
      const applied = [];
      const next = chores.map(c => {
        const a = list.find(x => Number(x && x.chore_id) === c.id);
        if (!a || !URGENCIES.includes(a.level)) return c;
        applied.push({ chore_id: c.id, text: c.text, level: a.level });
        return {
          ...c,
          // Deliberately a separate field. Writing to `urgency` would destroy
          // the user's own answer with a guess, and there would be no way to
          // tell afterwards which of the two you were looking at.
          inferredUrgency: a.level,
          inferredReason: String(a.reason || '').trim().slice(0, 160),
          inferredAt: Date.now()
        };
      });

      const unknown = list
        .map(a => Number(a && a.chore_id))
        .filter(id => !chores.some(c => c.id === id));

      App().setChores(next);
      return {
        assessed: applied,
        unknown_chore_ids: unknown.length ? unknown : undefined,
        note: "Advisory only — the user's own urgency values are unchanged."
      };
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
      if (starred && c.type !== 'daily' && !plan.includes(id)) plan = [...plan, id];
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
      if (c.type === 'daily') return { error: `Chores in the 'daily' category cannot be added to Today's plan.` };

      let plan = App().getPlan();
      const want = !!args.in_plan;
      if (want && !plan.includes(id)) plan = [...plan, id];
      if (!want && plan.includes(id)) plan = plan.filter(p => p !== id);
      App().setPlan(plan);
      return { chore_id: id, text: c.text, in_plan: want };
    },

    build_day_schedule(args) {
      const chores = App().getChores();
      const rawItems = Array.isArray(args.items) ? args.items : [];

      // REQUIREMENT 4: Filter out any chore whose category is 'daily'
      const items = rawItems.map(it => {
        const id = Number(it && it.chore_id);
        const c = chores.find(x => x.id === id);
        const isDaily = c && c.type === 'daily';
        return {
          id,
          text: c ? c.text : `(unknown chore ${id})`,
          durationMin: Number(it && it.duration_min) > 0
            ? Number(it.duration_min)
            : (c ? App().effectiveDuration(c) : NaN),
          startAt: it && it.start_at,
          notBefore: it && it.not_before,
          notAfter: it && it.not_after,
          missing: !c || isDaily,
          isDaily
        };
      });

      const unknown = items.filter(i => i.missing && !i.isDaily).map(i => i.id);
      const dailySkipped = items.filter(i => i.isDaily).map(i => i.text);
      const known = items.filter(i => !i.missing);

      // Anything the model left out comes from the planner controls, so a bare
      // "shift everything an hour later" still lands inside the user's day.
      const day = readDayControls();
      const result = Sched().planBlocks({
        startTime: args.start_time || day.start,
        endTime: args.end_time || day.end,
        cushionMin: args.cushion_min != null ? args.cushion_min : day.cushion,
        maxLoadPercent: args.max_load_percent != null ? args.max_load_percent : day.load,
        items: known
      });

      if (!result.ok) return { error: result.error };

      const blocks = {};
      result.scheduled.forEach(b => { blocks[b.id] = { start: b.start, end: b.end }; });
      App().setTimeBlocks(blocks);
      App().setPlan(result.scheduled.map(b => b.id));

      return {
        scheduled: result.scheduled.map(b => ({
          chore_id: b.id, text: b.text, start: b.start, end: b.end, duration_min: b.durationMin,
          pinned: b.pinned || undefined
        })),
        not_scheduled: result.skipped.map(s => ({
          chore_id: s.id, text: s.text, reason: s.reason, detail: s.detail || null
        })),
        daily_chores_excluded: dailySkipped.length ? dailySkipped : undefined,
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
      if (c.type === 'daily') return { error: `Cannot set time block on daily category chore.` };

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

    // REQUIREMENT 4: Filter out any chore in the "daily" category from openChores sent to the AI planner
    const openChores = chores
      .filter(c => !c.completed && c.type !== 'daily')
      .map(c => compactChore(c, plan, blocks));
    const doneCount = chores.filter(c => c.type !== 'daily' && c.completed).length;
    const notes = (app.getNotes() || '').trim();

    const day = readDayControls();
    const windowMin = Sched().toMinutes(day.end) - Sched().toMinutes(day.start);
    const windowLabel = windowMin > 0
      ? `${Math.floor(windowMin / 60)}h${windowMin % 60 ? ` ${windowMin % 60}m` : ''}`
      : 'not a valid window — say so rather than guessing';

    return [
      "You are the planning assistant built into a personal chores app. You act on the user's real data through the tools provided — you are not a chat bot describing what could be done, you make the changes.",
      '',
      `Today is ${now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}. The current time is ${now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}.`,
      '',
      'THE DAY WINDOW',
      'These are the planner controls as the user has them set right now. They describe the whole day and apply to EVERY request, not only "plan my day":',
      `  • Start of day: ${day.start}`,
      `  • Wind down by: ${day.end}${day.endExplicit ? '' : ' (derived — the user left this blank)'}`,
      `  • Cushion between tasks: ${day.cushion} minutes`,
      `  • Day fullness cap: ${day.load}% of the waking window`,
      `That is a waking window of ${windowLabel}. Never place a block before ${day.start} or ending after ${day.end}, and answer questions about "today", "this morning", "later" or "the rest of the day" against this window rather than inventing one. If the user's message names different times, those win for that request.`,
      'build_day_schedule uses all four of these automatically when you omit the matching argument, so pass one only to override it deliberately.',
      '',
      'CRITICAL CATEGORY RULE:',
      'Tasks belonging to the "daily" category MUST NEVER be scheduled or included in Today\'s plan by the LLM planner. Daily tasks are habits handled separately by the user and are completely excluded from AI day planning.',
      '',
      'URGENCY & PRIORITY SCORING',
      'Every non-daily chore carries an urgency level. Treat it as a strict priority ladder and score each chore before ordering the day:',
      '  • urgent (score 4): must happen today. Give it the earliest suitable slot and never leave it out.',
      '  • high   (score 3): important today. Schedule ahead of medium and low; only drop it if the day is genuinely full.',
      '  • medium (score 2): normal. Fill the middle of the day with these.',
      '  • low    (score 1): nice-to-have. Schedule late, and these are the first to drop when trimming to fit.',
      'Due dates override the stored level upward, never downward. Using today’s date and time given above: a chore due today or already past due counts as at least high; a chore due within the next hour, or already overdue, counts as urgent. A chore is never demoted below its stored urgency because of its due date.',
      'Break ties in this order: higher urgency score first, then nearer due date/time, then starred, then time-sensitive errands, then one-offs.',
      'When the load cap forces you to leave chores out, drop strictly from the bottom of the ladder up. Never leave an urgent or overdue task unscheduled while a lower-scored one is placed.',
      '',
      'WHEN URGENCY IS UNINFORMATIVE',
      '"medium" is what the form starts on, so a list where nearly everything sits at medium usually means the field was never touched — not that every task is genuinely equal. Check for this: if roughly three quarters or more of the incomplete chores share a single level, treat urgency as unset for ordering and rank on the signals that were NOT defaulted:',
      '  1. your own judgement of how pressing the task is — see below; this is the strongest signal you have;',
      '  2. an explicit due date — soonest first;',
      '  3. starred, because that was a real choice;',
      '  4. age_days — something added weeks ago and still open is either quietly overdue or wants deleting, and either way it is worth surfacing;',
      '  5. a short duration that clears a nagging item quickly;',
      '  6. errands that group into one outing.',
      '',
      'JUDGING PRIORITY YOURSELF',
      'You know what these tasks actually involve. The urgency field frequently records only that the user did not stop to think about it, so where it is uninformative, form your own view and act on it rather than treating the list as flat. Judge each chore on what it IS:',
      '  • what actually happens if it slips another week — a fine, a lapsed policy, a missed appointment, a health or safety consequence, or genuinely nothing;',
      '  • whether waiting makes it worse or more expensive: leaks, warning lights, damp, anything perishable, anything with a queue that grows;',
      '  • whether another person is blocked or waiting on it, or it holds up a second task;',
      '  • whether it carries a deadline the user never wrote down — renewals, registrations, prescriptions, returns windows, tickets, tax and seasonal cut-offs;',
      '  • whether it is simply optional and would just be pleasant to have done.',
      'Do not read urgency off the wording. A task written in a panic is not urgent because of its phrasing, and a flatly-worded "renew passport" may be the most pressing thing on the list.',
      'Record your conclusions with set_inferred_priority — one batched call — so they persist, appear next to the task in the list, and do not have to be re-derived next time. Chores that already carry inferred_urgency have been assessed; leave them alone unless the text changed or you now disagree, and if you disagree, say so briefly.',
      'This is advisory. It never overwrites what the user set, and it decides ordering only where they left the default in place. When you have leant on it, say in one short line that you judged the ordering yourself and that setting urgency or a due date on the two or three that matter most would override you. Say it once, plainly, without lecturing, and drop it from later answers unless asked.',
      '',
      'HOW TO BUILD A DAY',
      'When asked to plan the day, you will be told a wake-up or start time. Then:',
      '1. Score every incomplete non-daily chore with the urgency ladder above, adjusting for due dates. Sort by that score, breaking ties as described. Urgent and overdue tasks go into the earliest slots.',
      '2. Choose a BALANCED SUBSET that fits comfortably in the waking hours — not everything on the list. A day that feels achievable beats a day that is technically full.',
      '3. Order them sensibly within the priority scoring: place higher-urgency and time-critical work in the earlier, protected slots; group errands into one outing so travel is shared; keep quiet or low-effort, low-urgency tasks for later in the day.',
      '4. Estimate a realistic duration for anything without one, and round to something human (15, 30, 45, 60 minutes). Err generous.',
      '5. Call build_day_schedule with the ordered list. It does the clock maths, inserts the cushions and enforces the limits. Never compute times yourself.',
      '6. Read what it returns. Report the schedule chronologically with exact start and end times, then say plainly what you left out and why — naming the urgency of anything you dropped.',
      '',
      'COMMITMENTS MENTIONED IN PASSING',
      'The user will often name something that is not on the list at all — "I have to spend an hour helping family", "the plumber is coming at 11", "I promised to call my sister tonight". Treat that as a task to be created, not merely as context for ordering the existing ones:',
      '1. add_chore it first, with a realistic duration and the category it belongs in. Star it only if they signalled it matters more than the rest.',
      '2. Take the id from the result and include it in the SAME build_day_schedule call as everything else, so the day is laid out once, as a whole.',
      '3. Translate where they want it into a constraint instead of a slot you worked out yourself:',
      '     "at 11", "the 2pm call"          → start_at',
      '     "later", "towards the end", "this evening", "after lunch"  → not_before',
      '     "first thing", "before the shops shut", "this morning"     → not_after',
      '   Pick the boundary the words imply against the day window above and let the tool find the actual time. Do not compute a slot and pass it as start_at — reserve start_at for a clock time they actually named.',
      'If the tool reports a pinned item as clashes-with-pinned-block or outside-day-window, say so and offer the nearest workable time. Do not quietly move a commitment the user gave a fixed time for.',
      '',
      'The default cushion is 15 minutes and the default load cap is 65% of waking hours. If the user asks for a gentle, slow or recovery day, raise the cushion to 20–30 and drop the load cap to 40–50. If they ask for a productive push, you may go to 75–80, but never remove cushions entirely.',
      '',
      'STYLE',
      "Be brief and concrete. Lead with the schedule itself. Don't pad with encouragement or restate the user's request back to them. If a tool returns an error or a refusal, say so honestly rather than pretending it worked.",
      '',
      'CURRENT STATE',
      `Incomplete non-daily chores (${openChores.length}${doneCount ? `, plus ${doneCount} already done` : ''}):`,
      openChores.length ? JSON.stringify(openChores, null, 1) : '(none)',
      '',
      `Chores currently in Today's plan, in order: ${plan.length ? JSON.stringify(plan) : '(empty)'}`,
      notes ? `\nUser's notes:\n${notes}` : '',
      '',
      'Durations shown as duration_assumed are category fallbacks, not the user\'s own estimates — replace them with better judgement and consider saving the improvement via update_chore.'
    ].join('\n');
  }

  // ─────────────────────────────────────────────
  // PROVIDER PLUMBING
  // ─────────────────────────────────────────────

  // Gemini spells its schema types with the proto's uppercase enum names;
  // OpenAI and Anthropic want ordinary JSON Schema. One recursive lowercase
  // pass means the tool set above stays written once.
  function toJsonSchema(node) {
    if (Array.isArray(node)) return node.map(toJsonSchema);
    if (!node || typeof node !== 'object') return node;
    const out = {};
    Object.keys(node).forEach(k => {
      const v = node[k];
      out[k] = (k === 'type' && typeof v === 'string') ? v.toLowerCase() : toJsonSchema(v);
    });
    return out;
  }

  const EMPTY_SCHEMA = { type: 'object', properties: {} };
  const openAiTools = () => functionDeclarations.map(f => ({
    type: 'function',
    function: { name: f.name, description: f.description, parameters: toJsonSchema(f.parameters) || EMPTY_SCHEMA }
  }));
  const anthropicTools = () => functionDeclarations.map(f => ({
    name: f.name,
    description: f.description,
    input_schema: toJsonSchema(f.parameters) || EMPTY_SCHEMA
  }));

  // /v1/responses declares tools flat rather than nested under `function`, and
  // strict is opt-out: leaving it on would require every property to be listed
  // in `required`, which these schemas deliberately don't do — most arguments
  // are optional.
  const responsesTools = () => functionDeclarations.map(f => ({
    type: 'function',
    name: f.name,
    description: f.description,
    parameters: toJsonSchema(f.parameters) || EMPTY_SCHEMA,
    strict: false
  }));

  const textOfContent = (content) => {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.map(c => (c && (c.text || c.output_text)) || '').join('');
  };

  // The two OpenAI endpoints disagree on how a transcript is shaped, and which
  // one a model needs isn't known until it refuses — so a conversation has to
  // be convertible after it has already started.
  function chatToResponsesItems(items) {
    const out = [];
    (items || []).forEach(m => {
      if (!m) return;
      if (m.role === 'tool') {
        out.push({ type: 'function_call_output', call_id: m.tool_call_id, output: m.content });
        return;
      }
      if (m.role === 'assistant') {
        if (m.content) out.push({ role: 'assistant', content: textOfContent(m.content) });
        (m.tool_calls || []).forEach(tc => out.push({
          type: 'function_call',
          call_id: tc.id,
          name: tc.function && tc.function.name,
          arguments: (tc.function && tc.function.arguments) || '{}'
        }));
        return;
      }
      out.push({ role: m.role, content: textOfContent(m.content) });
    });
    return out;
  }

  function responsesToChatItems(items) {
    const out = [];
    (items || []).forEach(it => {
      if (!it) return;
      if (it.type === 'function_call') {
        out.push({
          role: 'assistant',
          content: null,
          tool_calls: [{ id: it.call_id, type: 'function', function: { name: it.name, arguments: it.arguments || '{}' } }]
        });
        return;
      }
      if (it.type === 'function_call_output') {
        out.push({ role: 'tool', tool_call_id: it.call_id, content: it.output });
        return;
      }
      if (it.role) out.push({ role: it.role, content: textOfContent(it.content) });
    });
    return out;
  }

  const ENDPOINT_MODE_KEY = 'openaiEndpointModes';
  function loadEndpointModes() {
    try {
      const raw = JSON.parse(localStorage.getItem(ENDPOINT_MODE_KEY) || '{}');
      return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    } catch (e) { return {}; }
  }
  function saveEndpointModes(modes) {
    try { localStorage.setItem(ENDPOINT_MODE_KEY, JSON.stringify(modes)); } catch (e) {}
  }

  async function readErrorDetail(res) {
    try {
      const err = await res.json();
      return (err && err.error && err.error.message) || '';
    } catch (e) { return ''; }
  }

  // Two recoverable outcomes. Both let the chain move on to the next model, but
  // they mean opposite things to the user: "unavailable" is a configuration
  // problem worth fixing in Settings, while "overloaded" is the provider being
  // busy and says nothing about whether the model is usable. Anything else
  // aborts the run.
  const SKIP = (kind, status, detail) => ({ skip: kind, status, detail: detail || '' });

  // 503 ("the model is overloaded") is by far the common transient failure. It
  // must not abort the run: falling through to a generic throw killed the whole
  // chain before a single fallback model got a turn, which is exactly what left
  // the planner stuck on a busy provider.
  function isOverloaded(status, detail) {
    if (status === 503 || status === 500) return true;
    return /overloaded|try again later|temporarily unavailable/i.test(detail || '');
  }

  function classifyHttpError(label, status, detail) {
    const d = detail || '';
    if (status === 429) throw new Error(`${label} rate limit hit. Wait a moment and try again.${d ? ` (${d})` : ''}`);
    if (status === 401) throw new Error(`${label} rejected the API key. Check it in Settings.`);
    if ((status === 400 || status === 403) && /api[ _-]?key|unauthorized|authentication/i.test(d)) {
      throw new Error(`${label} rejected the API key. Check it in Settings.`);
    }
    if (status === 404 || ((status === 400 || status === 403) &&
        /model/i.test(d) && /not found|not supported|does not exist|no access|permission|invalid|unsupported|deprecat/i.test(d))) {
      return SKIP('unavailable', status, d);
    }
    if (isOverloaded(status, d)) return SKIP('overloaded', status, d);
    if (status >= 500) throw new Error(`${label} is having trouble (HTTP ${status}). Try again shortly.`);
    throw new Error(`${label} error ${status}${d ? `: ${d}` : ''}`);
  }

  // Sort discovered models by a per-provider tuple of tie-breakers; every entry
  // is "lower is better" so one comparator serves all three. Entries carry the
  // provider's own metadata ({ id, created }) rather than just a name, because
  // the release date is the only trustworthy signal for "newest" — an id like
  // "sol" has no version number to parse, and guessing from the string is what
  // made the picker rank brand-new models below old ones.
  function rankBy(entries, keyFn) {
    return entries
      .map((e, idx) => {
        const o = typeof e === 'string' ? { id: e, created: 0 } : e;
        return { o, idx, k: keyFn(o) };
      })
      .sort((a, b) => {
        for (let i = 0; i < a.k.length; i++) { if (a.k[i] !== b.k[i]) return a.k[i] - b.k[i]; }
        return a.idx - b.idx;
      })
      .map(x => x.o.id);
  }

  function parseToolArgs(raw) {
    if (raw && typeof raw === 'object') return raw;
    if (!raw) return {};
    try { return JSON.parse(raw); } catch (e) { return {}; }
  }

  // ─────────────────────────────────────────────
  // PROVIDERS
  // Each adapter owns one vendor's wire format and nothing else. send()
  // normalises to { raw, text, calls } (or an UNAVAILABLE marker); the push*
  // helpers append to that provider's own message array.
  // ─────────────────────────────────────────────
  const PROVIDERS = {
    gemini: {
      id: 'gemini',
      label: 'Gemini',
      base: 'https://generativelanguage.googleapis.com/v1beta/models',
      defaultModel: 'gemini-flash-latest',
      fallbacks: ['gemini-flash-latest', 'gemini-pro-latest', 'gemini-flash-lite-latest'],
      keyUrl: 'aistudio.google.com/apikey',

      newConvo: () => [],
      pushUser(convo, text) { convo.push({ role: 'user', parts: [{ text }] }); },
      pushAssistant(convo, raw) { convo.push(raw); },
      pushToolResults(convo, results) {
        convo.push({
          role: 'user',
          parts: results.map(r => ({ functionResponse: { name: r.name, response: r.result } }))
        });
      },

      buildBody(model, convo, systemPrompt) {
        return {
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: convo,
          tools: [{ functionDeclarations }],
          toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
          generationConfig: { temperature: 0.4, maxOutputTokens: 2048 }
        };
      },

      parse(json) {
        const candidate = json.candidates && json.candidates[0];
        if (!candidate) {
          const blocked = json.promptFeedback && json.promptFeedback.blockReason;
          throw new Error(blocked ? `Gemini blocked the request (${blocked}).` : 'Gemini returned no candidates.');
        }
        const parts = (candidate.content && candidate.content.parts) || [];
        return {
          raw: candidate.content,
          text: parts.filter(p => p.text).map(p => p.text).join('').trim(),
          // Gemini has no call ids; the index keeps them distinct for the log.
          calls: parts.filter(p => p.functionCall).map((p, i) => ({
            id: `${p.functionCall.name}#${i}`,
            name: p.functionCall.name,
            args: p.functionCall.args || {}
          }))
        };
      },

      async send(model, convo, systemPrompt, key) {
        const url = `${this.base}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(this.buildBody(model, convo, systemPrompt))
        });
        if (!res.ok) return classifyHttpError(this.label, res.status, await readErrorDetail(res));
        return this.parse(await res.json());
      },

      async discover(key) {
        const res = await fetch(`${this.base}?key=${encodeURIComponent(key)}&pageSize=1000`);
        if (!res.ok) return { ok: false, status: res.status, detail: await readErrorDetail(res) };
        const json = await res.json();
        const entries = (json.models || [])
          .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
          .map(m => ({ id: String(m.name).replace(/^models\//, ''), created: 0 }));
        return { ok: true, models: rankBy(entries, this.rankKey) };
      },

      // Gemini's ListModels carries no release date, so this stays name-based —
      // but its "-latest" aliases already track the newest of each family.
      rankKey(m) {
        const n = m.id;
        const v = n.match(/gemini-(\d+(?:\.\d+)?)/);
        return [
          /-latest$/.test(n) ? 0 : 1,
          /lite/.test(n) ? 1 : 0,
          /flash/.test(n) ? 0 : 1,
          /preview|exp|thinking|tts|image|robotics|computer-use|customtools|embedding|aqa/.test(n) ? 1 : 0,
          -(v ? parseFloat(v[1]) : 0)
        ];
      }
    },

    openai: {
      id: 'openai',
      label: 'OpenAI',
      base: 'https://api.openai.com/v1',
      defaultModel: 'gpt-5.1',
      fallbacks: ['gpt-5.1', 'gpt-5', 'gpt-4.1', 'gpt-4o'],
      keyUrl: 'platform.openai.com/api-keys',

      // The conversation carries its own wire format, because which endpoint a
      // model needs is not known until it refuses. `items` is either
      // chat/completions messages or Responses input items; `mode` says which.
      newConvo: () => ({ mode: 'chat', items: [] }),

      // A bare {role, content} is valid in both formats, so the opening turn
      // never needs converting.
      pushUser(convo, text) { convo.items.push({ role: 'user', content: text }); },

      // Responses returns a list of output items; chat returns one message.
      pushAssistant(convo, raw) {
        if (Array.isArray(raw)) convo.items.push(...raw);
        else convo.items.push(raw);
      },

      pushToolResults(convo, results) {
        results.forEach(r => convo.items.push(convo.mode === 'responses'
          ? { type: 'function_call_output', call_id: r.id, output: JSON.stringify(r.result) }
          // chat: one message per call, each tagged with the id it answers
          : { role: 'tool', tool_call_id: r.id, content: JSON.stringify(r.result) }));
      },

      // ---- /v1/chat/completions ----
      buildBody(model, convo, systemPrompt, reasoning) {
        // No temperature and no token cap on purpose: the GPT-5 family rejects
        // a non-default temperature on this endpoint and renamed max_tokens to
        // max_completion_tokens, so sending either breaks the newest models.
        const body = {
          model,
          messages: [{ role: 'system', content: systemPrompt }, ...convo.items],
          tools: openAiTools(),
          tool_choice: 'auto'
        };
        if (reasoning === 'none') body.reasoning_effort = 'none';
        return body;
      },

      parse(json) {
        const msg = json.choices && json.choices[0] && json.choices[0].message;
        if (!msg) throw new Error('OpenAI returned no message.');
        return {
          raw: msg,
          text: (msg.content || '').trim(),
          calls: (msg.tool_calls || [])
            .filter(tc => tc.function && tc.function.name)
            .map(tc => ({ id: tc.id, name: tc.function.name, args: parseToolArgs(tc.function.arguments) }))
        };
      },

      // ---- /v1/responses ----
      buildResponsesBody(model, convo, systemPrompt) {
        return {
          model,
          instructions: systemPrompt,
          input: convo.items,
          tools: responsesTools(),
          tool_choice: 'auto',
          // Stateless: the full conversation is re-sent every turn, so nothing
          // needs retaining server-side — and this keeps the chore list off
          // OpenAI's storage. The trade is that reasoning items cannot be
          // replayed by id, so they are dropped in parseResponses and each turn
          // reasons fresh. Reasoning within a turn, which is the point, is
          // unaffected. `reasoning` itself is left unset so the model applies
          // its own default effort.
          store: false
        };
      },

      parseResponses(json) {
        const out = Array.isArray(json.output) ? json.output : [];
        const text = out
          .filter(o => o.type === 'message')
          .map(o => (o.content || []).filter(c => c.type === 'output_text').map(c => c.text).join(''))
          .join('')
          .trim();
        return {
          // Only what can be replayed without server-side state.
          raw: out.filter(o => o.type === 'message' || o.type === 'function_call'),
          text,
          calls: out
            .filter(o => o.type === 'function_call' && o.name)
            // function_call_output references call_id, not the item id.
            .map(o => ({ id: o.call_id || o.id, name: o.name, args: parseToolArgs(o.arguments) }))
        };
      },

      // ---- endpoint negotiation ----
      // Which endpoint each model needs, learned from its refusals:
      //   chat            /v1/chat/completions — fine for everything that isn't
      //                   a reasoning model refusing tools
      //   responses       /v1/responses — the only way to have function tools
      //                   AND reasoning on the newest models (gpt-5.6-sol)
      //   chat-no-reason  last resort: tools on chat with reasoning switched
      //                   off, for a key that cannot reach /v1/responses
      // Cached across reloads so the wasted probe happens once, not per visit.
      endpointMode: loadEndpointModes(),

      nextMode(mode, status, detail) {
        const d = detail || '';
        // "To use function tools, use /v1/responses or set reasoning_effort to 'none'."
        if (mode === 'chat' && status === 400 && /reasoning[_ ]?effort/i.test(d)) return 'responses';
        if (mode === 'responses' &&
            (status === 404 || /not supported|unsupported|unknown|unavailable|does not exist|must be verified/i.test(d))) {
          return 'chat-no-reason';
        }
        return null;
      },

      // Rewrite the running conversation into whichever format the next attempt
      // needs. On the first turn this is a no-op — there is only a user message,
      // which both formats accept.
      applyMode(convo, mode) {
        const want = mode === 'responses' ? 'responses' : 'chat';
        if (convo.mode === want) return;
        convo.items = want === 'responses'
          ? chatToResponsesItems(convo.items)
          : responsesToChatItems(convo.items);
        convo.mode = want;
      },

      request(model, convo, systemPrompt, key, mode) {
        const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` };
        return mode === 'responses'
          ? fetch(`${this.base}/responses`, {
              method: 'POST', headers,
              body: JSON.stringify(this.buildResponsesBody(model, convo, systemPrompt))
            })
          : fetch(`${this.base}/chat/completions`, {
              method: 'POST', headers,
              body: JSON.stringify(this.buildBody(model, convo, systemPrompt, mode === 'chat-no-reason' ? 'none' : 'omit'))
            });
      },

      async send(model, convo, systemPrompt, key) {
        let mode = this.endpointMode[model] || 'chat';

        for (let attempt = 0; attempt < 3; attempt++) {
          this.applyMode(convo, mode);
          const res = await this.request(model, convo, systemPrompt, key, mode);

          if (res.ok) {
            if (this.endpointMode[model] !== mode) {
              this.endpointMode[model] = mode;
              saveEndpointModes(this.endpointMode);
            }
            const json = await res.json();
            return mode === 'responses' ? this.parseResponses(json) : this.parse(json);
          }

          const detail = await readErrorDetail(res);
          const next = this.nextMode(mode, res.status, detail);
          if (!next) return classifyHttpError(this.label, res.status, detail);

          logNote(next === 'responses'
            ? `“${model}” needs the Responses API to use tools while reasoning — switching to it.`
            : `“${model}” could not use the Responses API — falling back with reasoning off.`);
          mode = next;
        }
        return classifyHttpError(this.label, 400, 'no usable OpenAI endpoint for this model');
      },

      async discover(key) {
        const res = await fetch(`${this.base}/models`, { headers: { 'Authorization': `Bearer ${key}` } });
        if (!res.ok) return { ok: false, status: res.status, detail: await readErrorDetail(res) };
        const json = await res.json();
        // Deny-list only. An allow-list of known families (/^gpt-|^o\d/) silently
        // hid every model whose name didn't follow the old convention, so a new
        // family would never appear in the picker no matter what the key could
        // reach. Anything not obviously a non-chat endpoint is offered.
        // Bare substrings were dangerous: "ada" and "edit" match inside plenty
        // of plausible new names, and hiding a model that exists is the failure
        // that started this. Legacy and modality tokens are matched as whole
        // dash-separated segments instead.
        const skip = /embedding|whisper|dall-e|moderation|transcribe|realtime|(^|-)(tts|audio|image|video|speech|search|instruct|edit|ada|curie|babbage|davinci|similarity)(-|$)/i;
        const entries = (json.data || [])
          .filter(m => !skip.test(String(m.id)))
          .map(m => ({ id: String(m.id), created: Number(m.created) || 0 }));
        return { ok: true, models: rankBy(entries, this.rankKey) };
      },

      // Ordered by the API's own `created` stamp, not by digits in the name.
      // There is deliberately no preference for the gpt- prefix: ranking known
      // families first is exactly what would bury a newer model released under
      // a different name.
      rankKey(m) {
        const n = m.id;
        return [
          /mini|nano/.test(n) ? 1 : 0,                    // full-size before cut-down
          /preview|\d{4}-\d{2}-\d{2}/.test(n) ? 1 : 0,    // rolling alias before a dated snapshot
          -(m.created || 0)                               // newest first
        ];
      }
    },

    anthropic: {
      id: 'anthropic',
      label: 'Anthropic',
      base: 'https://api.anthropic.com/v1',
      defaultModel: 'claude-sonnet-5',
      fallbacks: ['claude-sonnet-5', 'claude-opus-5', 'claude-haiku-4-5-20251001'],
      keyUrl: 'console.anthropic.com/settings/keys',

      // anthropic-dangerous-direct-browser-access opts this page into
      // Anthropic's CORS allowance; without it the browser blocks the call
      // before it ever leaves the tab.
      headers(key) {
        return {
          'Content-Type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true'
        };
      },

      newConvo: () => [],
      pushUser(convo, text) { convo.push({ role: 'user', content: text }); },
      pushAssistant(convo, raw) { convo.push(raw); },
      pushToolResults(convo, results) {
        // All results ride in one user turn, each block naming its tool_use id.
        convo.push({
          role: 'user',
          content: results.map(r => ({
            type: 'tool_result',
            tool_use_id: r.id,
            content: JSON.stringify(r.result)
          }))
        });
      },

      buildBody(model, convo, systemPrompt) {
        return {
          model,
          max_tokens: 2048,
          temperature: 0.4,
          system: systemPrompt,
          messages: convo,
          tools: anthropicTools()
        };
      },

      parse(json) {
        const blocks = Array.isArray(json.content) ? json.content : [];
        return {
          raw: { role: 'assistant', content: blocks },
          text: blocks.filter(b => b.type === 'text').map(b => b.text).join('').trim(),
          calls: blocks.filter(b => b.type === 'tool_use')
            .map(b => ({ id: b.id, name: b.name, args: b.input || {} }))
        };
      },

      async send(model, convo, systemPrompt, key) {
        const res = await fetch(`${this.base}/messages`, {
          method: 'POST',
          headers: this.headers(key),
          body: JSON.stringify(this.buildBody(model, convo, systemPrompt))
        });
        if (!res.ok) return classifyHttpError(this.label, res.status, await readErrorDetail(res));
        return this.parse(await res.json());
      },

      async discover(key) {
        const res = await fetch(`${this.base}/models?limit=100`, { headers: this.headers(key) });
        if (!res.ok) return { ok: false, status: res.status, detail: await readErrorDetail(res) };
        const json = await res.json();
        // No name filter: this endpoint only lists models the key can actually
        // call, so filtering on /^claude-/ could only ever hide a new family.
        const entries = (json.data || []).map(m => ({
          id: String(m.id),
          created: Date.parse(m.created_at || '') || 0
        }));
        return { ok: true, models: rankBy(entries, this.rankKey) };
      },

      // By release date, same as OpenAI. No family preference: ranking sonnet
      // above opus above haiku encodes a guess about which is best, and it
      // would pin the order to families that exist today.
      rankKey(m) {
        return [
          /\d{8}$/.test(m.id) ? 1 : 0,   // stable alias before a dated snapshot
          -(m.created || 0)              // newest first
        ];
      }
    }
  };

  // ─────────────────────────────────────────────
  // MODEL CALL — configured model, then fallbacks, then whatever the key has
  // ─────────────────────────────────────────────
  async function callModel(convo, systemPrompt) {
    const p = PROVIDERS[activeProvider];
    const { key, model } = creds[activeProvider];
    const tried = [];
    const failures = [];

    // Every model answered, but only to say it was busy. That is a transient
    // outage, not a misconfiguration — the message must not send the user off
    // to "fix" a Settings value that was never wrong.
    const allBusy = () => failures.length > 0 && failures.every(f => f.skip === 'overloaded');
    const busyError = () => new Error(
      `Every ${p.label} model tried is overloaded right now (${failures.map(f => f.model).join(', ')}). ` +
      'That is temporary and nothing is wrong with your key or settings — wait a moment and ' +
      'try again. Your chores and today\'s plan were left untouched.'
    );

    const runChain = async (models) => {
      for (const m of models) {
        if (!m || tried.includes(m)) continue;
        tried.push(m);
        const turn = await p.send(m, convo, systemPrompt, key);
        if (!turn.skip) {
          if (resolvedModel[p.id] !== m) {
            if (tried.length > 1) logNote(`Using ${p.label} model “${m}”.`);
            resolvedModel[p.id] = m;
          }
          noteDraftModel(m);
          return turn;
        }
        failures.push({ model: m, skip: turn.skip, status: turn.status });
        // Say so out loud: a silent fallback is what made a 503 confusing.
        if (turn.skip === 'overloaded') {
          logNote(`“${m}” is overloaded (HTTP ${turn.status}) — trying the next model.`);
        }
      }
      return null;
    };

    if (resolvedModel[p.id]) {
      const t = await runChain([resolvedModel[p.id]]);
      if (t) return t;
      resolvedModel[p.id] = null;
    }

    let turn;

    // Auto (no pinned model): ask what the key can reach and take the best
    // ranked. This has to happen BEFORE the built-in chain, or the constants
    // would win and Auto would never see anything released after this file.
    if (!model) {
      const listed = await listModels(p.id, key);
      if (listed.ok && listed.models.length) {
        turn = await runChain(listed.models.slice(0, AUTO_TRY_LIMIT));
        if (turn) return turn;
        if (allBusy()) throw busyError();
      }
    }

    const configured = [model, ...p.fallbacks].filter((m, i, a) => m && a.indexOf(m) === i);
    turn = await runChain(configured);
    if (turn) return turn;

    // Skip the model-list sweep when everything was merely busy: the models it
    // returns would be just as overloaded, so it is a wasted round trip.
    if (allBusy()) throw busyError();

    // Cached from the Auto branch above when that ran, so this is usually free.
    const disc = await listModels(p.id, key);
    if (!disc.ok) {
      if (/rejected/i.test(disc.error || '')) {
        throw new Error(`${p.label} rejected the API key. Check it in Settings.`);
      }
      throw new Error(`No configured ${p.label} model worked, and the available-model list couldn't be read (${disc.error}).`);
    }
    if (disc.models.length) logNote(`Configured models unavailable — checking ${disc.models.length} model(s) your key supports.`);
    turn = await runChain(disc.models);
    if (turn) return turn;

    if (allBusy()) throw busyError();

    throw new Error(
      `No available ${p.label} model. Tried ${tried.join(', ') || '(none)'}. ` +
      (disc.models.length
        ? `Your key can use: ${disc.models.slice(0, 12).join(', ')}. Set one of these in Settings.`
        : 'The provider listed no usable models — the key may be invalid or have no model access.')
    );
  }

  // ─────────────────────────────────────────────
  // AGENT LOOP
  // ─────────────────────────────────────────────
  async function runAgent(userMessage) {
    if (running) return;
    const p = PROVIDERS[activeProvider];
    if (!creds[activeProvider].key) {
      logError(`No ${p.label} API key yet — add one in Settings (${p.keyUrl}).`);
      return;
    }

    running = true;
    setBusy(true);
    logUser(userMessage);

    const systemPrompt = buildSystemPrompt();
    const convo = p.newConvo();
    p.pushUser(convo, userMessage);
    let mutated = false;

    try {
      for (let step = 0; step < MAX_STEPS; step++) {
        const turn = await callModel(convo, systemPrompt);

        if (!turn.calls.length) {
          if (turn.text) logAnswer(turn.text);
          else logError(`${p.label} finished without saying anything. Try rephrasing.`);
          return;
        }

        p.pushAssistant(convo, turn.raw);

        const results = [];
        for (const call of turn.calls) {
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
          results.push({ id: call.id, name: call.name, result });
        }

        p.pushToolResults(convo, results);
      }

      logError(`Stopped after ${MAX_STEPS} tool rounds without a final answer. Any changes already made have been kept.`);
    } catch (e) {
      logError(e.message || String(e));
    } finally {
      if (mutated) App().commit();
      running = false;
      setBusy(false);
    }
  }

  // ─────────────────────────────────────────────
  // TRANSCRIPT
  // Entries are held as data and persisted, not just drawn into the DOM. The
  // log used to be rebuilt empty on every load, so coming back hours later left
  // no record of what was asked or which model produced the plan sitting in the
  // list — exactly when that record matters most.
  // ─────────────────────────────────────────────
  const TRANSCRIPT_KEY = 'plannerTranscript';
  const TRANSCRIPT_MAX = 40;
  const TRANSCRIPT_TEXT_MAX = 4000;

  // Loaded eagerly rather than in restoreTranscript(), so the history exists
  // even before anything is rendered.
  let transcript = loadTranscript();

  function loadTranscript() {
    try {
      const raw = JSON.parse(localStorage.getItem(TRANSCRIPT_KEY) || '[]');
      return Array.isArray(raw) ? raw.filter(e => e && typeof e.text === 'string') : [];
    } catch (e) { return []; }
  }

  function saveTranscript() {
    try { localStorage.setItem(TRANSCRIPT_KEY, JSON.stringify(transcript)); } catch (e) {}
  }

  function logEl() { return document.getElementById('agent-log'); }

  function pushEntry(entry) {
    const e = Object.assign({ at: Date.now() }, entry);
    e.text = String(e.text || '').slice(0, TRANSCRIPT_TEXT_MAX);
    transcript.push(e);
    if (transcript.length > TRANSCRIPT_MAX) transcript = transcript.slice(-TRANSCRIPT_MAX);
    saveTranscript();
    renderEntry(e);
  }

  // "2:15 PM" today, "Aug 5, 2:15 PM" once it isn't today any more.
  function stamp(at) {
    if (!at) return '';
    const d = new Date(at);
    const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    return new Date().toDateString() === d.toDateString()
      ? time
      : `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${time}`;
  }

  function buildRow(row, e) {
    if (e.kind === 'user' || e.kind === 'answer') {
      const head = document.createElement('div');
      head.className = 'agent-entry-head';
      const label = document.createElement('span');
      label.className = 'agent-entry-label';
      label.textContent = e.kind === 'user' ? 'You' : 'Planner';
      const meta = document.createElement('span');
      meta.className = 'agent-entry-meta';
      // Naming the model on the answer is what makes an old plan explainable.
      meta.textContent = [stamp(e.at), e.model ? `via ${e.model}` : ''].filter(Boolean).join(' · ');
      head.append(label, meta);

      const body = document.createElement('div');
      if (e.kind === 'answer') body.className = 'agent-answer-body';
      body.textContent = e.text;
      row.append(head, body);
      return;
    }

    if (e.kind === 'error') {
      const icon = document.createElement('i');
      icon.className = 'fas fa-triangle-exclamation';
      const body = document.createElement('span');
      body.textContent = ` ${e.text}`;
      row.append(icon, body);
      return;
    }

    // tool / note
    const icon = document.createElement('i');
    icon.className = e.kind === 'tool' ? 'fas fa-gear' : 'fas fa-circle-info';
    row.appendChild(icon);
    if (e.name) {
      const label = document.createElement('span');
      label.className = 'agent-tool-name';
      label.textContent = ` ${e.name}`;
      row.appendChild(label);
    }
    const summary = document.createElement('span');
    summary.className = 'agent-tool-summary';
    summary.textContent = ` ${e.text}`;
    row.appendChild(summary);
  }

  function renderEntry(e) {
    const box = logEl();
    if (!box) return;
    const row = document.createElement('div');
    row.className = `agent-entry agent-${e.kind === 'note' ? 'tool' : e.kind}`;
    buildRow(row, e);
    box.appendChild(row);
    while (box.children.length > TRANSCRIPT_MAX) box.removeChild(box.firstChild);
    box.scrollTop = box.scrollHeight;
  }

  function restoreTranscript() {
    const box = logEl();
    if (!box) return;
    box.innerHTML = '';
    transcript.forEach(renderEntry);
  }

  function clearTranscript() {
    transcript = [];
    saveTranscript();
    const box = logEl();
    if (box) box.innerHTML = '';
  }

  function logUser(text) { pushEntry({ kind: 'user', text }); }
  function logError(text) { pushEntry({ kind: 'error', text }); }
  function logNote(text) { pushEntry({ kind: 'note', text }); }
  function logTool(name, args, result) {
    pushEntry({ kind: 'tool', name, text: summarizeToolResult(name, args, result) });
  }

  // lastDraftModel is set by noteDraftModel the moment a model answers, so by
  // the time we log the reply it names the model that actually wrote it.
  function logAnswer(text) {
    pushEntry({ kind: 'answer', text, model: lastDraftModel || '' });
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
      case 'set_inferred_priority': {
        const n = result.assessed.length;
        const levels = result.assessed.filter(a => a.level === 'urgent' || a.level === 'high');
        return `→ judged ${n} task${n === 1 ? '' : 's'}${levels.length ? `, ${levels.length} above medium` : ''}`;
      }
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

  // Record which model actually produced a draft, and surface it. Without this
  // the only trace was a logNote that fired solely on a fallback and vanished
  // with "Clear log" — so on a normal run you could never tell what drafted it.
  function noteDraftModel(model) {
    lastDraftModel = model;
    localStorage.setItem('lastPlannerModel', model);
    renderStatus();
  }

  // #agent-status shows "Thinking…" mid-run and otherwise holds the model label.
  function renderStatus() {
    const el = document.getElementById('agent-status');
    if (!el) return;
    if (running) {
      el.textContent = 'Thinking…';
      el.classList.remove('model-tag');
      el.removeAttribute('title');
      return;
    }
    if (lastDraftModel) {
      el.textContent = `via ${lastDraftModel}`;
      el.classList.add('model-tag');
      el.title = `Last draft was generated by the ${PROVIDERS[activeProvider].label} model “${lastDraftModel}”.`;
    } else {
      el.textContent = '';
      el.classList.remove('model-tag');
      el.removeAttribute('title');
    }
  }

  function setBusy(busy) {
    const planBtn = document.getElementById('agent-plan-btn');
    const askBtn = document.getElementById('agent-ask-btn');
    renderStatus();   // reads `running`, which runAgent updates before calling
    [planBtn, askBtn].forEach(b => { if (b) b.disabled = busy; });
    if (planBtn) {
      planBtn.innerHTML = busy
        ? '<i class="fas fa-spinner fa-spin"></i> Planning…'
        : '<i class="fas fa-wand-magic-sparkles"></i> Plan my day';
    }
  }

  function currentTimeHHMM() {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  function planMyDay() {
    // The window itself already reaches the model through the system prompt;
    // restating it here is purely so the transcript reads as a real request.
    const day = readDayControls();
    runAgent(
      `Plan my day — I'm starting at ${day.start} and winding down by ${day.end}. ` +
      'Pick a balanced subset of my incomplete non-daily chores, build the schedule with build_day_schedule, ' +
      'then show me the chronological result and tell me what you left for another day.'
    );
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

    renderStatus();        // restore the model label after a reload
    restoreTranscript();   // and the conversation that produced the current plan

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
      clearBtn.addEventListener('click', clearTranscript);
    }
  }

  // ─────────────────────────────────────────────
  // CREDENTIALS
  // ─────────────────────────────────────────────
  // An earlier version substituted the built-in default whenever the model
  // field was left blank, so simply pressing Save burned that constant into
  // storage — recording "I made no choice" as "pin this forever", which then
  // outranked discovery and froze the planner on whatever was current the day
  // it was written. Clear those once so they become Auto again. A value that
  // differs from the default was typed deliberately and is left alone.
  function migrateLegacyModelPins() {
    if (localStorage.getItem(STORAGE.migrated)) return;
    PROVIDER_IDS.forEach(id => {
      const stored = (localStorage.getItem(STORAGE[id].model) || '').trim();
      if (stored && stored === PROVIDERS[id].defaultModel) localStorage.removeItem(STORAGE[id].model);
    });
    localStorage.setItem(STORAGE.migrated, '1');
  }

  function loadCredentials() {
    migrateLegacyModelPins();
    const stored = localStorage.getItem(STORAGE.provider);
    activeProvider = PROVIDER_IDS.includes(stored) ? stored : DEFAULT_PROVIDER;
    PROVIDER_IDS.forEach(id => {
      creds[id] = {
        key: localStorage.getItem(STORAGE[id].key) || '',
        // "" is Auto: resolved against the live model list at request time.
        model: (localStorage.getItem(STORAGE[id].model) || '').trim()
      };
      resolvedModel[id] = null;
    });
  }

  /**
   * Persist the settings modal's state.
   * @param {{provider?: string, gemini?: {key,model}, openai?: {…}, anthropic?: {…}}} config
   */
  function setCredentials(config) {
    const c = config || {};
    if (PROVIDER_IDS.includes(c.provider) && c.provider !== activeProvider) {
      activeProvider = c.provider;
      localStorage.setItem(STORAGE.provider, activeProvider);
      // The label describes a draft from the provider we just left, so it would
      // otherwise read "via gemini-flash-latest" with OpenAI selected.
      lastDraftModel = '';
      localStorage.removeItem('lastPlannerModel');
      renderStatus();
    }
    PROVIDER_IDS.forEach(id => {
      if (!c[id]) return;
      const key = (c[id].key || '').trim();
      // Blank stays blank — that is Auto. Substituting the default here is what
      // pinned every install to a constant the first time Save was pressed.
      const model = (c[id].model || '').trim();
      // A changed model invalidates whichever id last answered for this provider.
      if (creds[id].model !== model || creds[id].key !== key) resolvedModel[id] = null;
      creds[id] = { key, model };
      localStorage.setItem(STORAGE[id].key, key);
      localStorage.setItem(STORAGE[id].model, model);
    });
  }

  // Snapshot for the settings modal to render from.
  function getConfig() {
    const out = { provider: activeProvider, providers: {} };
    PROVIDER_IDS.forEach(id => {
      out.providers[id] = {
        label: PROVIDERS[id].label,
        key: creds[id].key,
        model: creds[id].model,
        defaultModel: PROVIDERS[id].defaultModel,
        fallbacks: PROVIDERS[id].fallbacks.slice(),
        keyUrl: PROVIDERS[id].keyUrl
      };
    });
    return out;
  }

  // Model lists change under us — new families ship, keys gain and lose access —
  // so the picker asks the provider rather than trusting a hardcoded list.
  // Cached per key so reopening Settings doesn't re-hit the network.
  const modelListCache = {};   // provider id → { key, models }

  /**
   * List the models a key can reach. Always resolves with a usable `models`
   * array: on any failure it falls back to the built-in chain, so the picker
   * is never empty and the user can still pick something.
   */
  async function listModels(providerId, key, opts) {
    const p = PROVIDERS[providerId];
    if (!p) return { ok: false, error: `unknown provider "${providerId}"`, models: [] };

    const fallbacks = p.fallbacks.slice();
    const trimmed = (key || '').trim();
    if (!trimmed) return { ok: false, error: 'no API key', models: fallbacks, needsKey: true };

    const cached = modelListCache[providerId];
    if (cached && cached.key === trimmed && !(opts && opts.force)) {
      return { ok: true, models: cached.models.slice(), cached: true };
    }

    try {
      const disc = await p.discover(trimmed);
      if (!disc.ok) {
        const why = disc.status === 401 ? 'the key was rejected' : `HTTP ${disc.status}`;
        return { ok: false, error: disc.detail ? `${why}: ${disc.detail}` : why, models: fallbacks };
      }
      modelListCache[providerId] = { key: trimmed, models: disc.models };
      return { ok: true, models: disc.models.slice() };
    } catch (e) {
      return { ok: false, error: e.message || String(e), models: fallbacks };
    }
  }

  loadCredentials();

  window.ChoreAgent = {
    init,
    setCredentials,
    getConfig,
    listModels,
    run: runAgent,
    providerIds: PROVIDER_IDS,
    getProvider: () => activeProvider,
    getModel: () => creds[activeProvider].model,        // what is configured
    getDraftModel: () => lastDraftModel,                // what produced the last draft
    getKey: () => creds[activeProvider].key,
    // Test seam: exposes the pure pieces without needing a network or a DOM.
    _internals: {
      PROVIDERS, toJsonSchema, classifyHttpError, rankBy, parseToolArgs,
      functionDeclarations, buildSystemPrompt, readDayControls,
      getTranscript: () => transcript.slice(), pushEntry, choreAgeDays,
      chatToResponsesItems, responsesToChatItems
    }
  };
})();
