const MY_PASSWORD = "p";
const GIST_FILENAME = "chore-data.json";

let GITHUB_TOKEN = localStorage.getItem('githubToken') || "";
let GIST_ID = localStorage.getItem('gistId') || "";

const form = document.getElementById('form');
const textInput = document.getElementById('text');
const typeInput = document.getElementById('type');
const urgencyInput = document.getElementById('urgency');
const dueDateInput = document.getElementById('due-date');
const dueTimeInput = document.getElementById('due-time');
const durationInput = document.getElementById('duration');
const notesArea = document.getElementById('notes-area');

// Fallback estimates (minutes) when a chore has no durationMin yet.
const DEFAULT_DURATION = { daily: 30, errands: 45, oneoff: 60 };

// Urgency ladder. Order matters: index doubles as the priority score.
const URGENCY_LEVELS = ['low', 'medium', 'high', 'urgent'];
const DEFAULT_URGENCY = 'medium';
const urgencyRank = (u) => {
    const i = URGENCY_LEVELS.indexOf(u);
    return i === -1 ? URGENCY_LEVELS.indexOf(DEFAULT_URGENCY) : i;
};

const lists = {
    daily: document.getElementById('list-daily'),
    errands: document.getElementById('list-errands'),
    oneoff: document.getElementById('list-oneoff')
};

let chores = [];
let dailyPlan = [];
let editState = { isEditing: false, id: null };

// timeBlocks: { [choreId]: { start: "13:00", end: "14:00" } }
let timeBlocks = {};

// INITIAL LOAD
try {
    const stored = localStorage.getItem('choreData');
    if (stored) chores = JSON.parse(stored);
} catch (e) { chores = []; }

try {
    const storedPlan = localStorage.getItem('dailyPlan');
    if (storedPlan) dailyPlan = JSON.parse(storedPlan);
} catch (e) { dailyPlan = []; }

try {
    const storedBlocks = localStorage.getItem('timeBlocks');
    if (storedBlocks) timeBlocks = JSON.parse(storedBlocks);
} catch (e) { timeBlocks = {}; }

// MIDNIGHT RESET
function checkMidnightReset() {
    const lastReset = localStorage.getItem('lastPlanReset');
    const today = new Date().toDateString();
    if (lastReset !== today) {
        dailyPlan = chores.filter(c => c.starred).map(c => c.id);
        timeBlocks = {};
        localStorage.setItem('dailyPlan', JSON.stringify(dailyPlan));
        localStorage.setItem('timeBlocks', JSON.stringify(timeBlocks));
        localStorage.setItem('lastPlanReset', today);
    }
}

// AUTHENTICATION
const checkPwd = () => {
    if (document.getElementById('password-input').value === MY_PASSWORD) {
        document.getElementById('login-overlay').style.display = 'none';
        document.getElementById('app-container').style.display = 'block';
        initApp();
    } else {
        document.getElementById('login-error').innerText = "That passkey didn't work.";
    }
};

document.getElementById('login-btn').addEventListener('click', checkPwd);
document.getElementById('password-input').addEventListener('keydown', e => { if (e.key === 'Enter') checkPwd(); });

// MODAL CONTROLS
window.openSettings = () => {
    document.getElementById('github-token-input').value = GITHUB_TOKEN;
    document.getElementById('gist-id-input').value = GIST_ID;
    document.getElementById('gemini-key-input').value = localStorage.getItem('geminiKey') || '';
    document.getElementById('gemini-model-input').value =
        localStorage.getItem('geminiModel') || (window.ChoreAgent ? window.ChoreAgent.defaultModel : '');
    document.getElementById('settings-modal').style.display = 'flex';
};

document.getElementById('close-settings-btn').addEventListener('click', () => {
    document.getElementById('settings-modal').style.display = 'none';
});

document.getElementById('save-settings-btn').addEventListener('click', () => {
    GITHUB_TOKEN = document.getElementById('github-token-input').value.trim();
    GIST_ID = document.getElementById('gist-id-input').value.trim();
    localStorage.setItem('githubToken', GITHUB_TOKEN);
    localStorage.setItem('gistId', GIST_ID);

    if (window.ChoreAgent) {
        window.ChoreAgent.setCredentials(
            document.getElementById('gemini-key-input').value.trim(),
            document.getElementById('gemini-model-input').value.trim()
        );
    }

    document.getElementById('settings-modal').style.display = 'none';
    if (GITHUB_TOKEN && GIST_ID) window.manualSync();
});

// ─────────────────────────────────────────────
// FEATURE 1: DELETE CONFIRMATION via existing modal
// Returns a Promise that resolves true (confirmed) or false (cancelled)
// ─────────────────────────────────────────────
function confirmDelete(choreName) {
    return new Promise((resolve) => {
        const modal = document.getElementById('confirm-modal');
        document.getElementById('confirm-title').innerText = 'Delete this chore?';
        document.getElementById('confirm-message').innerText =
            `"${choreName}" will be removed for good.`;
        modal.style.display = 'flex';

        const yesBtn = document.getElementById('confirm-yes-btn');
        const noBtn = document.getElementById('confirm-no-btn');

        // Clone nodes to remove any stale listeners from previous calls
        const freshYes = yesBtn.cloneNode(true);
        const freshNo = noBtn.cloneNode(true);
        yesBtn.parentNode.replaceChild(freshYes, yesBtn);
        noBtn.parentNode.replaceChild(freshNo, noBtn);

        freshYes.addEventListener('click', () => {
            modal.style.display = 'none';
            resolve(true);
        }, { once: true });

        freshNo.addEventListener('click', () => {
            modal.style.display = 'none';
            resolve(false);
        }, { once: true });
    });
}

// ─────────────────────────────────────────────
// FEATURE 3: TIME BLOCK MODAL
// ─────────────────────────────────────────────
let timeBlockTargetId = null;

window.openTimeBlockModal = (choreId) => {
    timeBlockTargetId = choreId;
    const c = chores.find(ch => ch.id === choreId);
    document.getElementById('timeblock-chore-label').innerText = c ? c.text : '';

    const existing = timeBlocks[choreId];
    document.getElementById('timeblock-start').value = existing ? existing.start : '';
    document.getElementById('timeblock-end').value = existing ? existing.end : '';

    document.getElementById('timeblock-modal').style.display = 'flex';
};

document.getElementById('timeblock-save-btn').addEventListener('click', () => {
    const start = document.getElementById('timeblock-start').value;
    const end = document.getElementById('timeblock-end').value;
    if (timeBlockTargetId !== null) {
        if (start || end) {
            timeBlocks[timeBlockTargetId] = { start, end };
        } else {
            delete timeBlocks[timeBlockTargetId];
        }
        saveTimeBlocks();
        updateDailyPlan();
    }
    document.getElementById('timeblock-modal').style.display = 'none';
});

document.getElementById('timeblock-clear-btn').addEventListener('click', () => {
    if (timeBlockTargetId !== null) {
        delete timeBlocks[timeBlockTargetId];
        saveTimeBlocks();
        updateDailyPlan();
    }
    document.getElementById('timeblock-modal').style.display = 'none';
});

document.getElementById('timeblock-cancel-btn').addEventListener('click', () => {
    document.getElementById('timeblock-modal').style.display = 'none';
});

// Format "13:00" → "1:00 PM"
function formatTime(t) {
    if (!t) return '';
    const [hStr, mStr] = t.split(':');
    let h = parseInt(hStr, 10);
    const m = mStr;
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return `${h}:${m} ${ampm}`;
}

// 90 → "1h 30m", 45 → "45m"
function formatDuration(mins) {
    if (!mins) return '';
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    if (h && m) return `${h}h ${m}m`;
    if (h) return `${h}h`;
    return `${m}m`;
}

// Effective duration for scheduling: explicit value, else category default
function effectiveDuration(chore) {
    return chore.durationMin || DEFAULT_DURATION[chore.type] || 30;
}

// A chore's due moment as an epoch ms, or null if it has no due date.
// A date with no time is treated as end-of-day so it isn't "overdue" all day.
function dueTimestamp(chore) {
    if (!chore.dueDate) return null;
    const time = chore.dueTime || '23:59';
    const ts = new Date(`${chore.dueDate}T${time}`).getTime();
    return Number.isFinite(ts) ? ts : null;
}

// Short human due label + overdue flag for rendering, e.g. { label: "Due Aug 3", overdue: true }
function dueMeta(chore) {
    const ts = dueTimestamp(chore);
    if (ts === null) return null;
    const d = new Date(ts);
    const dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const label = chore.dueTime ? `${dateStr}, ${formatTime(chore.dueTime)}` : dateStr;
    return { label, overdue: ts < Date.now() };
}

// Colour-coded urgency chip. Rendered on every chore so the priority is explicit.
function urgencyTagHTML(chore) {
    const u = URGENCY_LEVELS.includes(chore.urgency) ? chore.urgency : DEFAULT_URGENCY;
    const label = u.charAt(0).toUpperCase() + u.slice(1);
    return `<span class="urgency-tag urgency-${u}">${label}</span>`;
}

// Due-date chip, styled red once the deadline has passed.
function dueTagHTML(chore) {
    const meta = dueMeta(chore);
    if (!meta) return '';
    return `<span class="due-tag${meta.overdue ? ' overdue' : ''}"><i class="fas fa-flag"></i> ${meta.overdue ? 'Overdue' : 'Due'} ${meta.label}</span>`;
}

// ─────────────────────────────────────────────
// DAILY PLAN RENDERING — includes Feature 2 (inline completion) & Feature 3 (time blocks)
// ─────────────────────────────────────────────
function updateDailyPlan() {
    const planContainer = document.getElementById('list-daily-plan');
    const emptyMsg = document.getElementById('plan-empty');
    const countTag = document.getElementById('plan-count');

    dailyPlan = dailyPlan.filter(id => chores.find(c => c.id === id));
    planContainer.innerHTML = '';

    if (dailyPlan.length === 0) {
        emptyMsg.style.display = 'block';
        countTag.innerText = 'No tasks';
        return;
    }

    emptyMsg.style.display = 'none';
    countTag.innerText = `${dailyPlan.length} task${dailyPlan.length > 1 ? 's' : ''}`;

    // Group chores by time block label for rendering.
    // Chores with no time block go into a null group (always rendered last).
    // Groups with a start time are sorted chronologically.
    const groups = []; // [{ label: string|null, startMinutes: number|null, items: [{ id, idx }] }]
    const labelMap = {}; // key → group index

    // "HH:MM" → total minutes from midnight for sorting (null if missing)
    function toMinutes(timeStr) {
        if (!timeStr) return null;
        const [h, m] = timeStr.split(':').map(Number);
        return h * 60 + m;
    }

    dailyPlan.forEach((id, idx) => {
        const block = timeBlocks[id];
        let label = null;
        let startMinutes = null;
        if (block && (block.start || block.end)) {
            const s = block.start ? formatTime(block.start) : '?';
            const e = block.end ? formatTime(block.end) : '?';
            label = `${s} – ${e}`;
            startMinutes = toMinutes(block.start);
        }
        const key = label === null ? '__unblocked__' : label;
        if (labelMap[key] === undefined) {
            labelMap[key] = groups.length;
            groups.push({ label, startMinutes, items: [] });
        }
        groups[labelMap[key]].items.push({ id, idx });
    });

    // Sort: timed groups ascending by start time, unblocked group always last
    groups.sort((a, b) => {
        if (a.label === null) return 1;
        if (b.label === null) return -1;
        const aMin = a.startMinutes ?? Infinity;
        const bMin = b.startMinutes ?? Infinity;
        return aMin - bMin;
    });

    groups.forEach(group => {
        // If the group has a time block label, render a header
        if (group.label !== null) {
            const header = document.createElement('div');
            header.className = 'timeblock-header';
            header.innerHTML = `<i class="fas fa-clock"></i> ${group.label}`;
            planContainer.appendChild(header);
        }

        const ul = document.createElement('ul');
        ul.className = 'chore-list plan-list';

        group.items.forEach(({ id, idx }) => {
            const c = chores.find(ch => ch.id === id);
            if (!c) return;

            const li = document.createElement('li');
            li.className = `priority-${c.type} ${c.completed ? 'completed' : ''}`;
            li.dataset.id = id;

            // Long-press drag-and-drop reorder
            attachPlanDrag(li, id);

            const blockIcon = timeBlocks[id]
                ? '<i class="fas fa-clock plan-clock-icon assigned" title="Edit time block"></i>'
                : '<i class="fas fa-clock plan-clock-icon" title="Assign time block"></i>';

            // Inline completion checkbox
            const checkClass = c.completed ? 'plan-complete-check done' : 'plan-complete-check';
            const checkIcon = c.completed ? '<i class="fas fa-check"></i>' : '';

            li.innerHTML = `
                <div class="${checkClass}" onclick="toggleChore(${id})" title="Toggle complete">
                    ${checkIcon}
                </div>
                <span class="plan-num">${String(idx + 1).padStart(2, '0')}.</span>
                <div class="plan-text">${c.text} ${urgencyTagHTML(c)}${dueTagHTML(c)}</div>
                <span onclick="openTimeBlockModal(${id})">${blockIcon}</span>
                <i class="fas fa-trash plan-trash" onclick="deleteChore(${id})"></i>
            `;
            ul.appendChild(li);
        });

        planContainer.appendChild(ul);
    });
}

// ─────────────────────────────────────────────
// SWIPE LEFT TO REVEAL EDIT / DELETE
// ─────────────────────────────────────────────
let activeSwipeEl = null;

function attachSwipe(li, id) {
    let startX = 0;
    let startY = 0;
    let isDragging = false;
    const THRESHOLD = 60; // px needed to fully reveal actions

    li.addEventListener('touchstart', (e) => {
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
        isDragging = false;
    }, { passive: true });

    li.addEventListener('touchmove', (e) => {
        const dx = e.touches[0].clientX - startX;
        const dy = e.touches[0].clientY - startY;
        // Only handle horizontal swipes
        if (!isDragging && Math.abs(dy) > Math.abs(dx)) return;
        isDragging = true;
        if (dx < 0) {
            const shift = Math.min(Math.abs(dx), THRESHOLD);
            li.style.transform = `translateX(-${shift}px)`;
            if (shift >= THRESHOLD) li.classList.add('swiped');
        } else if (dx > 0 && li.classList.contains('swiped')) {
            li.style.transform = `translateX(0)`;
            li.classList.remove('swiped');
        }
    }, { passive: true });

    li.addEventListener('touchend', () => {
        if (!isDragging) return;
        const swiped = li.classList.contains('swiped');
        if (!swiped) {
            li.style.transform = '';
        }
        // Close any previously opened swipe that isn't this one
        if (activeSwipeEl && activeSwipeEl !== li) {
            activeSwipeEl.style.transform = '';
            activeSwipeEl.classList.remove('swiped');
        }
        activeSwipeEl = swiped ? li : null;
    });
}

// Close open swipe if user taps elsewhere
document.addEventListener('touchstart', (e) => {
    if (activeSwipeEl && !activeSwipeEl.contains(e.target)) {
        activeSwipeEl.style.transform = '';
        activeSwipeEl.classList.remove('swiped');
        activeSwipeEl = null;
    }
}, { passive: true });

// ─────────────────────────────────────────────
// DRAG-AND-DROP REORDER FOR TODAY'S PLAN
// ─────────────────────────────────────────────
let dragSrcId = null;

function attachPlanDrag(li, id) {
    let longPressTimer = null;
    let dragActive = false;
    let startX = 0;
    let startY = 0;
    let currentDropTarget = null;
    const MOVE_CANCEL_THRESHOLD = 8; // px of movement that cancels the long-press

    li.addEventListener('touchstart', (e) => {
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
        longPressTimer = setTimeout(() => {
            dragActive = true;
            dragSrcId = id;
            li.classList.add('drag-source');
        }, 500);
    }, { passive: false }); // must be false so touchmove can call preventDefault

    li.addEventListener('touchmove', (e) => {
        const dx = Math.abs(e.touches[0].clientX - startX);
        const dy = Math.abs(e.touches[0].clientY - startY);

        // Cancel the timer only if the finger has actually moved (not a micro-jitter)
        if (!dragActive && (dx > MOVE_CANCEL_THRESHOLD || dy > MOVE_CANCEL_THRESHOLD)) {
            clearTimeout(longPressTimer);
            return;
        }

        if (!dragActive) return;

        // Prevent page scroll while dragging
        e.preventDefault();

        const touch = e.touches[0];
        const el = document.elementFromPoint(touch.clientX, touch.clientY);
        const targetLi = el ? el.closest('.plan-list li') : null;
        if (currentDropTarget && currentDropTarget !== targetLi) {
            currentDropTarget.classList.remove('drag-over');
        }
        if (targetLi && targetLi !== li) {
            targetLi.classList.add('drag-over');
            currentDropTarget = targetLi;
        } else {
            currentDropTarget = null;
        }
    }, { passive: false });

    li.addEventListener('touchend', () => {
        clearTimeout(longPressTimer);
        if (!dragActive) return;
        dragActive = false;
        li.classList.remove('drag-source');
        if (currentDropTarget) {
            currentDropTarget.classList.remove('drag-over');
            const targetId = parseInt(currentDropTarget.dataset.id);
            if (targetId && dragSrcId !== targetId) {
                const fromIdx = dailyPlan.indexOf(dragSrcId);
                const toIdx = dailyPlan.indexOf(targetId);
                if (fromIdx !== -1 && toIdx !== -1) {
                    dailyPlan.splice(fromIdx, 1);
                    dailyPlan.splice(toIdx, 0, dragSrcId);
                    savePlan();
                    updateDailyPlan();
                }
            }
            currentDropTarget = null;
        }
        dragSrcId = null;
    });

    li.addEventListener('touchcancel', () => {
        clearTimeout(longPressTimer);
        dragActive = false;
        dragSrcId = null;
        li.classList.remove('drag-source');
        if (currentDropTarget) {
            currentDropTarget.classList.remove('drag-over');
            currentDropTarget = null;
        }
    });
}

// UI RENDERING
function updateUI() {
    Object.values(lists).forEach(l => l.innerHTML = '');

    ['daily', 'errands', 'oneoff'].forEach(type => {
        const group = chores.filter(c => c.type === type);
        // Completed sink to bottom, then starred, then by urgency, then soonest due
        group.sort((a, b) => {
            if (a.completed !== b.completed) return a.completed ? 1 : -1;
            if (!!a.starred !== !!b.starred) return a.starred ? -1 : 1;
            const byUrgency = urgencyRank(b.urgency) - urgencyRank(a.urgency);
            if (byUrgency !== 0) return byUrgency;
            const ad = dueTimestamp(a);
            const bd = dueTimestamp(b);
            if (ad !== bd) {
                if (ad === null) return 1;
                if (bd === null) return -1;
                return ad - bd;
            }
            return 0;
        });
        group.forEach(c => {
            const isQueued = dailyPlan.includes(c.id);
            const li = document.createElement('li');
            li.className = `priority-${c.type} ${c.completed ? 'completed' : ''}`;
            li.dataset.id = c.id;

            // Swipe-left to reveal edit/delete
            attachSwipe(li, c.id);

            li.onclick = (e) => {
                if (
                    e.target.tagName === 'I' ||
                    e.target.closest('.chore-queue-check') ||
                    e.target.closest('.chore-star-btn') ||
                    e.target.closest('.swipe-actions')
                ) return;
                toggleChore(c.id);
            };

            li.innerHTML = `
                <div class="chore-queue-check ${isQueued ? 'queued' : ''}" onclick="togglePlanQueue(${c.id})" title="${isQueued ? 'Remove from today' : 'Add to today'}">
                    ${isQueued ? '<i class="fas fa-check"></i>' : ''}
                </div>
                <button class="chore-star-btn ${c.starred ? 'starred' : ''}" onclick="toggleStar(${c.id})" title="${c.starred ? 'Unstar' : 'Star'}">
                    <i class="fa${c.starred ? 's' : 'r'} fa-star"></i>
                </button>
                <div class="custom-check"></div>
                <div class="chore-text">
                    ${c.text}
                    ${urgencyTagHTML(c)}
                    ${c.durationMin ? `<span class="dur-tag">${formatDuration(c.durationMin)}</span>` : ''}
                    ${dueTagHTML(c)}
                </div>
                <div class="swipe-actions" id="swipe-actions-${c.id}">
                    <button class="swipe-btn swipe-edit" onclick="editChore(${c.id})"><i class="fas fa-edit"></i></button>
                    <button class="swipe-btn swipe-delete" onclick="deleteChore(${c.id})"><i class="fas fa-trash"></i></button>
                </div>
            `;
            if (lists[c.type]) lists[c.type].appendChild(li);
        });
    });

    const now = new Date();
    document.getElementById('current-date').innerText = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

    updateDailyPlan();
}

// PLAN QUEUE TOGGLE
window.togglePlanQueue = (id) => {
    if (dailyPlan.includes(id)) {
        dailyPlan = dailyPlan.filter(pid => pid !== id);
    } else {
        dailyPlan.push(id);
    }
    savePlan();
    updateUI();
};

// STAR TOGGLE
window.toggleStar = (id) => {
    chores = chores.map(c => {
        if (c.id === id) {
            const newStarred = !c.starred;
            if (newStarred && !dailyPlan.includes(id)) {
                dailyPlan.push(id);
            } else if (!newStarred && dailyPlan.includes(id)) {
                dailyPlan = dailyPlan.filter(pid => pid !== id);
            }
            return { ...c, starred: newStarred };
        }
        return c;
    });
    savePlan();
    saveAndSync();
};

// CORE ACTIONS
form.addEventListener('submit', (e) => {
    e.preventDefault();
    const choreText = textInput.value.trim();
    if (!choreText) return;

    // Blank duration stays undefined so the agent can estimate it later
    const rawDuration = parseInt(durationInput.value, 10);
    const durationMin = Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : undefined;

    const urgency = URGENCY_LEVELS.includes(urgencyInput.value) ? urgencyInput.value : DEFAULT_URGENCY;
    const dueDate = dueDateInput.value || undefined;
    const dueTime = dueTimeInput.value || undefined;

    if (editState.isEditing) {
        chores = chores.map(c => c.id === editState.id ? { ...c, text: choreText, type: typeInput.value, urgency, dueDate, dueTime, durationMin } : c);
        editState = { isEditing: false, id: null };
        document.getElementById('form-title').innerText = 'Add task';
        document.getElementById('submit-btn').innerText = 'Add chore';
    } else {
        chores.push({ text: choreText, type: typeInput.value, urgency, dueDate, dueTime, completed: false, starred: false, durationMin, id: Date.now() });
    }

    textInput.value = '';
    durationInput.value = '';
    urgencyInput.value = DEFAULT_URGENCY;
    dueDateInput.value = '';
    dueTimeInput.value = '';
    saveAndSync();
});

window.toggleChore = (id) => {
    chores = chores.map(c => c.id === id ? { ...c, completed: !c.completed } : c);
    saveAndSync();
};

window.resetMaintenance = () => {
    chores = chores.map(c => c.type === 'daily' ? { ...c, completed: false } : c);
    dailyPlan = chores.filter(c => c.starred).map(c => c.id);
    savePlan();
    saveAndSync();
};

// FEATURE 4: Auto-scroll to top on edit
window.editChore = (id) => {
    const c = chores.find(chore => chore.id === id);
    textInput.value = c.text;
    typeInput.value = c.type;
    urgencyInput.value = c.urgency || DEFAULT_URGENCY;
    dueDateInput.value = c.dueDate || '';
    dueTimeInput.value = c.dueTime || '';
    durationInput.value = c.durationMin || '';
    editState = { isEditing: true, id };
    document.getElementById('form-title').innerText = 'Edit task';
    document.getElementById('submit-btn').innerText = 'Update chore';
    window.scrollTo({ top: 0, behavior: 'smooth' });
};

// FEATURE 1: Delete with confirmation modal
window.deleteChore = async (id) => {
    const chore = chores.find(c => c.id === id);
    const name = chore ? chore.text : 'this chore';
    const confirmed = await confirmDelete(name);
    if (!confirmed) return;
    chores = chores.filter(c => c.id !== id);
    dailyPlan = dailyPlan.filter(pid => pid !== id);
    delete timeBlocks[id];
    saveTimeBlocks();
    savePlan();
    saveAndSync();
};

// PERSISTENCE
function savePlan() {
    localStorage.setItem('dailyPlan', JSON.stringify(dailyPlan));
}

function saveTimeBlocks() {
    localStorage.setItem('timeBlocks', JSON.stringify(timeBlocks));
}

function saveAndSync() {
    localStorage.setItem('choreData', JSON.stringify(chores));
    updateUI();
    saveToGist();
}

async function saveToGist() {
    if (!GITHUB_TOKEN || !GIST_ID) return;
    try {
        await fetch(`https://api.github.com/gists/${GIST_ID}`, {
            method: 'PATCH',
            headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                files: {
                    [GIST_FILENAME]: {
                        content: JSON.stringify({
                            chores,
                            notes: notesArea.innerText,
                            dailyPlan,
                            timeBlocks
                        }, null, 2)
                    }
                }
            })
        });
    } catch(e) {}
}

window.manualSync = async () => {
    if (!GITHUB_TOKEN || !GIST_ID) return;
    const btn = document.getElementById('sync-btn');
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Syncing…';
    try {
        const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
            headers: { 'Authorization': `token ${GITHUB_TOKEN}` },
            cache: 'no-store'
        });
        const json = await res.json();
        const data = JSON.parse(json.files[GIST_FILENAME].content);
        chores = data.chores || [];
        notesArea.innerText = data.notes || "";
        // Only adopt plan/blocks when the gist actually carries them, so older
        // gists written before this feature don't wipe a schedule built locally.
        if (Array.isArray(data.dailyPlan)) {
            dailyPlan = data.dailyPlan;
            savePlan();
        }
        if (data.timeBlocks && typeof data.timeBlocks === 'object') {
            timeBlocks = data.timeBlocks;
            saveTimeBlocks();
        }
        localStorage.setItem('choreData', JSON.stringify(chores));
        updateUI();
        btn.innerHTML = '<i class="fas fa-check"></i> Synced';
    } catch(e) {
        btn.innerHTML = '<i class="fas fa-exclamation-triangle"></i> Sync failed';
    }
    setTimeout(() => { btn.innerHTML = '<i class="fas fa-cloud"></i> Sync'; }, 2000);
};

notesArea.addEventListener('input', () => {
    localStorage.setItem('choreNotes', notesArea.innerText);
    saveToGist();
});

// ─────────────────────────────────────────────
// APP BRIDGE
// The one seam agent.js is allowed to touch. Keeping this explicit means the
// agent never reaches into module internals, and every mutation it makes goes
// through the same persistence path as a human click.
// ─────────────────────────────────────────────
window.ChoresApp = {
    getChores: () => chores.map(c => ({ ...c })),
    getPlan: () => [...dailyPlan],
    getTimeBlocks: () => JSON.parse(JSON.stringify(timeBlocks)),
    getNotes: () => notesArea.innerText,

    setChores(next) {
        chores = next;
        localStorage.setItem('choreData', JSON.stringify(chores));
    },
    setPlan(next) {
        dailyPlan = next;
        savePlan();
    },
    setTimeBlocks(next) {
        timeBlocks = next;
        saveTimeBlocks();
    },
    appendNote(text) {
        const existing = notesArea.innerText.trimEnd();
        notesArea.innerText = existing ? `${existing}\n${text}` : text;
        localStorage.setItem('choreNotes', notesArea.innerText);
    },

    // Re-render and push everything to the gist in one call
    commit() {
        saveAndSync();
    },

    // Reuse the human-facing confirmation modal for destructive agent actions
    confirmDelete,
    effectiveDuration,
    formatTime,
    formatDuration,
    defaultDurations: DEFAULT_DURATION
};

function initApp() {
    checkMidnightReset();
    const savedNotes = localStorage.getItem('choreNotes');
    if (savedNotes) notesArea.innerText = savedNotes;
    updateUI();
    window.manualSync();
    if (window.ChoreAgent) window.ChoreAgent.init();
}
