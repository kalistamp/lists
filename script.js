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

// COLLAPSIBLE ADD TASK FORM (Requirement 3)
window.toggleAddTaskForm = () => {
    const formEl = document.getElementById('form');
    const chevron = document.getElementById('add-task-chevron');
    const subtitle = document.getElementById('form-subtitle');
    if (!formEl) return;

    const isCollapsed = formEl.classList.contains('collapsed');
    if (isCollapsed) {
        expandAddTaskForm();
    } else {
        if (!editState.isEditing) {
            collapseAddTaskForm();
        }
    }
};

window.expandAddTaskForm = () => {
    const formEl = document.getElementById('form');
    const chevron = document.getElementById('add-task-chevron');
    const subtitle = document.getElementById('form-subtitle');
    if (!formEl) return;
    formEl.classList.remove('collapsed');
    if (chevron) chevron.style.transform = 'rotate(180deg)';
    if (subtitle) subtitle.innerText = 'Click to collapse';
};

window.collapseAddTaskForm = () => {
    const formEl = document.getElementById('form');
    const chevron = document.getElementById('add-task-chevron');
    const subtitle = document.getElementById('form-subtitle');
    if (!formEl) return;
    formEl.classList.add('collapsed');
    if (chevron) chevron.style.transform = 'rotate(0deg)';
    if (subtitle) subtitle.innerText = 'Click to expand';
};

window.cancelEdit = () => {
    editState = { isEditing: false, id: null };
    form.reset();
    document.getElementById('form-title').innerHTML = '<i class="fas fa-plus-circle"></i> Add task';
    document.getElementById('submit-btn').innerText = 'Add chore';
    document.getElementById('cancel-edit-btn').style.display = 'none';
    textInput.value = '';
    durationInput.value = '';
    urgencyInput.value = DEFAULT_URGENCY;
    dueDateInput.value = '';
    dueTimeInput.value = '';
    collapseAddTaskForm();
};

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

// DELETE CONFIRMATION MODAL
function confirmDelete(choreName) {
    return new Promise((resolve) => {
        const modal = document.getElementById('confirm-modal');
        document.getElementById('confirm-title').innerText = 'Delete this chore?';
        document.getElementById('confirm-message').innerText =
            `"${choreName}" will be removed for good.`;
        modal.style.display = 'flex';

        const yesBtn = document.getElementById('confirm-yes-btn');
        const noBtn = document.getElementById('confirm-no-btn');

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

// TIME BLOCK MODAL
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
function dueTimestamp(chore) {
    if (!chore.dueDate) return null;
    const time = chore.dueTime || '23:59';
    const ts = new Date(`${chore.dueDate}T${time}`).getTime();
    return Number.isFinite(ts) ? ts : null;
}

// Short human due label + overdue flag for rendering
function dueMeta(chore) {
    const ts = dueTimestamp(chore);
    if (ts === null) return null;
    const d = new Date(ts);
    const dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const label = chore.dueTime ? `${dateStr}, ${formatTime(chore.dueTime)}` : dateStr;
    return { label, overdue: ts < Date.now() };
}

// Colour-coded urgency chip.
function urgencyTagHTML(chore) {
    const u = URGENCY_LEVELS.includes(chore.urgency) ? chore.urgency : DEFAULT_URGENCY;
    const label = u.charAt(0).toUpperCase() + u.slice(1);
    return `<span class="urgency-tag urgency-${u}">${label}</span>`;
}

// Due-date chip
function dueTagHTML(chore) {
    const meta = dueMeta(chore);
    if (!meta) return '';
    return `<span class="due-tag${meta.overdue ? ' overdue' : ''}"><i class="fas fa-flag"></i> ${meta.overdue ? 'Overdue' : 'Due'} ${meta.label}</span>`;
}

// DAILY PLAN RENDERING
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

    const total = dailyPlan.length;
    let currentLabel;
    let ul = null;

    dailyPlan.forEach((id, idx) => {
        const c = chores.find(ch => ch.id === id);
        if (!c) return;

        const block = timeBlocks[id];
        let label = null;
        if (block && (block.start || block.end)) {
            const s = block.start ? formatTime(block.start) : '?';
            const e = block.end ? formatTime(block.end) : '?';
            label = `${s} – ${e}`;
        }

        if (ul === null || label !== currentLabel) {
            if (label !== null) {
                const header = document.createElement('div');
                header.className = 'timeblock-header';
                header.innerHTML = `<i class="fas fa-clock"></i> ${label}`;
                planContainer.appendChild(header);
            }
            ul = document.createElement('ul');
            ul.className = 'chore-list plan-list';
            planContainer.appendChild(ul);
            currentLabel = label;
        }

        const li = document.createElement('li');
        li.className = `priority-${c.type} ${c.completed ? 'completed' : ''}`;
        li.dataset.id = id;

        attachPlanDrag(li, id);         // Touch long-press drag
        attachPlanDesktopDrag(li, id);  // Desktop HTML5 drag

        const blockIcon = timeBlocks[id]
            ? '<i class="fas fa-clock plan-clock-icon assigned" title="Edit time block"></i>'
            : '<i class="fas fa-clock plan-clock-icon" title="Assign time block"></i>';

        const checkClass = c.completed ? 'plan-complete-check done' : 'plan-complete-check';
        const checkIcon = c.completed ? '<i class="fas fa-check"></i>' : '';

        li.innerHTML = `
            <div class="${checkClass}" onclick="toggleChore(${id})" title="Toggle complete">
                ${checkIcon}
            </div>
            <span class="plan-num">${String(idx + 1).padStart(2, '0')}.</span>
            <div class="plan-text">${c.text} ${urgencyTagHTML(c)}${dueTagHTML(c)}</div>
            <div class="plan-actions">
                <span class="plan-reorder">
                    <button class="plan-arrow" onclick="movePlanItem(${id}, -1)" title="Move up" ${idx === 0 ? 'disabled' : ''}><i class="fas fa-chevron-up"></i></button>
                    <button class="plan-arrow" onclick="movePlanItem(${id}, 1)" title="Move down" ${idx === total - 1 ? 'disabled' : ''}><i class="fas fa-chevron-down"></i></button>
                </span>
                <span class="plan-clock-wrap" onclick="openTimeBlockModal(${id})">${blockIcon}</span>
                <button class="plan-icon-btn plan-edit" onclick="editChore(${id})" title="Edit"><i class="fas fa-pen"></i></button>
                <i class="fas fa-trash plan-trash" onclick="deleteChore(${id})" title="Delete"></i>
            </div>
        `;
        ul.appendChild(li);
    });
}

// Move a plan item up (-1) or down (+1) and persist immediately (Requirement 1).
window.movePlanItem = (id, dir) => {
    const i = dailyPlan.indexOf(id);
    if (i === -1) return;
    const j = i + dir;
    if (j < 0 || j >= dailyPlan.length) return;
    const tmp = dailyPlan[i];
    dailyPlan[i] = dailyPlan[j];
    dailyPlan[j] = tmp;
    persistPlanOrder();
};

function persistPlanOrder() {
    savePlan();
    saveToGist();
    updateDailyPlan();
}

// SWIPE LEFT TO REVEAL EDIT / DELETE (MOBILE)
let activeSwipeEl = null;

function attachSwipe(li, id) {
    let startX = 0;
    let startY = 0;
    let isDragging = false;
    const THRESHOLD = 60;

    li.addEventListener('touchstart', (e) => {
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
        isDragging = false;
    }, { passive: true });

    li.addEventListener('touchmove', (e) => {
        const dx = e.touches[0].clientX - startX;
        const dy = e.touches[0].clientY - startY;
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
        if (activeSwipeEl && activeSwipeEl !== li) {
            activeSwipeEl.style.transform = '';
            activeSwipeEl.classList.remove('swiped');
        }
        activeSwipeEl = swiped ? li : null;
    });
}

document.addEventListener('touchstart', (e) => {
    if (activeSwipeEl && !activeSwipeEl.contains(e.target)) {
        activeSwipeEl.style.transform = '';
        activeSwipeEl.classList.remove('swiped');
        activeSwipeEl = null;
    }
}, { passive: true });

// DESKTOP HTML5 DRAG-AND-DROP FOR TODAY'S PLAN (Requirement 1)
let dragSrcId = null;

function attachPlanDesktopDrag(li, id) {
    li.setAttribute('draggable', 'true');
    li.addEventListener('dragstart', (e) => {
        dragSrcId = id;
        li.classList.add('drag-source');
        if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', String(id));
        }
    });

    li.addEventListener('dragend', () => {
        li.classList.remove('drag-source');
        document.querySelectorAll('.plan-list li').forEach(el => el.classList.remove('drag-over'));
        dragSrcId = null;
    });

    li.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        li.classList.add('drag-over');
    });

    li.addEventListener('dragleave', () => {
        li.classList.remove('drag-over');
    });

    li.addEventListener('drop', (e) => {
        e.preventDefault();
        li.classList.remove('drag-over');
        if (dragSrcId !== null && dragSrcId !== id) {
            const fromIdx = dailyPlan.indexOf(dragSrcId);
            const toIdx = dailyPlan.indexOf(id);
            if (fromIdx !== -1 && toIdx !== -1) {
                dailyPlan.splice(fromIdx, 1);
                dailyPlan.splice(toIdx, 0, dragSrcId);
                persistPlanOrder();
            }
        }
    });
}

// TOUCH DRAG-AND-DROP FOR TODAY'S PLAN
function attachPlanDrag(li, id) {
    let longPressTimer = null;
    let dragActive = false;
    let startX = 0;
    let startY = 0;
    let currentDropTarget = null;
    const MOVE_CANCEL_THRESHOLD = 8;

    li.addEventListener('touchstart', (e) => {
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
        longPressTimer = setTimeout(() => {
            dragActive = true;
            dragSrcId = id;
            li.classList.add('drag-source');
        }, 500);
    }, { passive: false });

    li.addEventListener('touchmove', (e) => {
        const dx = Math.abs(e.touches[0].clientX - startX);
        const dy = Math.abs(e.touches[0].clientY - startY);

        if (!dragActive && (dx > MOVE_CANCEL_THRESHOLD || dy > MOVE_CANCEL_THRESHOLD)) {
            clearTimeout(longPressTimer);
            return;
        }

        if (!dragActive) return;
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
            const targetId = parseInt(currentDropTarget.dataset.id, 10);
            if (targetId && dragSrcId !== targetId) {
                const fromIdx = dailyPlan.indexOf(dragSrcId);
                const toIdx = dailyPlan.indexOf(targetId);
                if (fromIdx !== -1 && toIdx !== -1) {
                    dailyPlan.splice(fromIdx, 1);
                    dailyPlan.splice(toIdx, 0, dragSrcId);
                    persistPlanOrder();
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

// UI RENDERING FOR CATEGORY LISTS (Requirement 2)
function updateUI() {
    Object.values(lists).forEach(l => { if (l) l.innerHTML = ''; });

    ['daily', 'errands', 'oneoff'].forEach(type => {
        const group = chores.filter(c => c.type === type);
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
            const li = document.createElement('li');
            li.className = `priority-${c.type} ${c.completed ? 'completed' : ''}`;
            li.dataset.id = c.id;

            // Swipe-left on touch/mobile
            attachSwipe(li, c.id);

            li.onclick = (e) => {
                if (
                    e.target.tagName === 'I' ||
                    e.target.tagName === 'BUTTON' ||
                    e.target.closest('.chore-star-btn') ||
                    e.target.closest('.swipe-actions') ||
                    e.target.closest('.chore-actions')
                ) return;
                toggleChore(c.id);
            };

            // The star is the single control for "is this in Today's plan".
            // (A separate queue checkbox used to exist here; it wrote dailyPlan
            // without writing `starred`, so the two could disagree and a
            // checkbox-only item silently vanished at the midnight reset.)
            li.innerHTML = `
                <button class="chore-star-btn ${c.starred ? 'starred' : ''}" onclick="toggleStar(${c.id})" title="${c.starred ? "Remove from Today's plan" : "Add to Today's plan"}">
                    <i class="fa${c.starred ? 's' : 'r'} fa-star"></i>
                </button>
                <div class="custom-check"></div>
                <div class="chore-text">
                    ${c.text}
                    ${urgencyTagHTML(c)}
                    ${c.durationMin ? `<span class="dur-tag">${formatDuration(c.durationMin)}</span>` : ''}
                    ${dueTagHTML(c)}
                </div>
                <!-- DESKTOP / ALWAYS VISIBLE ACTION BUTTONS (Requirement 2) -->
                <div class="chore-actions">
                    <button class="chore-action-btn chore-edit-btn" onclick="editChore(${c.id})" title="Edit task"><i class="fas fa-pen"></i></button>
                    <button class="chore-action-btn chore-delete-btn" onclick="deleteChore(${c.id})" title="Delete task"><i class="fas fa-trash"></i></button>
                </div>
                <!-- MOBILE SWIPE ACTIONS -->
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

// STAR TOGGLE — the only way a chore enters or leaves Today's plan by hand.
// Keeping `starred` and `dailyPlan` written together is what stops the two
// from drifting apart (the midnight reset rebuilds the plan from `starred`).
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

// CORE FORM ACTION: CREATE / UPDATE
form.addEventListener('submit', (e) => {
    e.preventDefault();
    const choreText = textInput.value.trim();
    if (!choreText) return;

    const rawDuration = parseInt(durationInput.value, 10);
    const durationMin = Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : undefined;

    const urgency = URGENCY_LEVELS.includes(urgencyInput.value) ? urgencyInput.value : DEFAULT_URGENCY;
    const dueDate = dueDateInput.value || undefined;
    const dueTime = dueTimeInput.value || undefined;
    const category = typeInput.value;

    if (editState.isEditing) {
        // Requirement 2: Edit updates EVERY creation field
        chores = chores.map(c => c.id === editState.id ? {
            ...c,
            text: choreText,
            type: category,
            urgency,
            dueDate,
            dueTime,
            durationMin
        } : c);

        editState = { isEditing: false, id: null };
        document.getElementById('form-title').innerHTML = '<i class="fas fa-plus-circle"></i> Add task';
        document.getElementById('submit-btn').innerText = 'Add chore';
        document.getElementById('cancel-edit-btn').style.display = 'none';
        collapseAddTaskForm();
    } else {
        chores.push({
            text: choreText,
            type: category,
            urgency,
            dueDate,
            dueTime,
            completed: false,
            starred: false,
            durationMin,
            id: Date.now()
        });
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

// EDIT CHORE (Requirement 2)
window.editChore = (id) => {
    const c = chores.find(chore => chore.id === id);
    if (!c) return;

    // Populate all fields
    textInput.value = c.text || '';
    typeInput.value = c.type || 'oneoff';
    urgencyInput.value = c.urgency || DEFAULT_URGENCY;
    dueDateInput.value = c.dueDate || '';
    dueTimeInput.value = c.dueTime || '';
    durationInput.value = c.durationMin || '';

    editState = { isEditing: true, id };
    document.getElementById('form-title').innerHTML = '<i class="fas fa-edit"></i> Edit task';
    document.getElementById('submit-btn').innerText = 'Update chore';
    document.getElementById('cancel-edit-btn').style.display = 'inline-block';

    // Expand the form and scroll into view
    expandAddTaskForm();
    document.getElementById('add-task-module').scrollIntoView({ behavior: 'smooth', block: 'start' });
    textInput.focus();
};

// DELETE CHORE (Requirement 2)
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

// APP BRIDGE
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

    commit() {
        saveAndSync();
    },

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
