const MY_PASSWORD = "p";
const GIST_FILENAME = "chore-data.json";

let GITHUB_TOKEN = localStorage.getItem('githubToken') || "";
let GIST_ID = localStorage.getItem('gistId') || "";

const form = document.getElementById('form');
const textInput = document.getElementById('text');
const typeInput = document.getElementById('type');
const notesArea = document.getElementById('notes-area');

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
        document.getElementById('login-error').innerText = 'ACCESS_DENIED';
    }
};

document.getElementById('login-btn').addEventListener('click', checkPwd);
document.getElementById('password-input').addEventListener('keydown', e => { if (e.key === 'Enter') checkPwd(); });

// MODAL CONTROLS
window.openSettings = () => {
    document.getElementById('github-token-input').value = GITHUB_TOKEN;
    document.getElementById('gist-id-input').value = GIST_ID;
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
        document.getElementById('confirm-title').innerText = 'DELETE_CHORE';
        document.getElementById('confirm-message').innerText =
            `Are you sure you want to delete "${choreName}"?`;
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
        countTag.innerText = '0 TASKS';
        return;
    }

    emptyMsg.style.display = 'none';
    countTag.innerText = `${dailyPlan.length} TASK${dailyPlan.length > 1 ? 'S' : ''}`;

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
            const checkIcon = c.completed ? '<i class="fas fa-check" style="font-size:0.6rem;"></i>' : '';

            li.innerHTML = `
                <div class="${checkClass}" onclick="toggleChore(${id})" title="Toggle complete">
                    ${checkIcon}
                </div>
                <span class="plan-num">${String(idx + 1).padStart(2, '0')}.</span>
                <div style="flex-grow: 1; font-family: var(--font-mono); font-size: 0.85rem;">${c.text}</div>
                <span onclick="openTimeBlockModal(${id})">${blockIcon}</span>
                <i class="fas fa-trash" style="color: var(--danger); font-size: 0.8rem;" onclick="deleteChore(${id})"></i>
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
        // Starred first, then incomplete, completed sink to bottom
        group.sort((a, b) => {
            if (a.completed !== b.completed) return a.completed ? 1 : -1;
            return (b.starred ? 1 : 0) - (a.starred ? 1 : 0);
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
                    ${isQueued ? '<i class="fas fa-check" style="font-size:0.6rem;"></i>' : ''}
                </div>
                <button class="chore-star-btn ${c.starred ? 'starred' : ''}" onclick="toggleStar(${c.id})" title="${c.starred ? 'Unstar' : 'Star'}">
                    <i class="fa${c.starred ? 's' : 'r'} fa-star"></i>
                </button>
                <div class="custom-check"></div>
                <div style="flex-grow: 1; font-family: var(--font-mono); font-size: 0.85rem;">
                    ${c.text}
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
    document.getElementById('current-date').innerText = now.toLocaleDateString('en-US', { weekday: 'short', month: '2-digit', day: '2-digit' }).replace(/\//g, '.');

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

    if (editState.isEditing) {
        chores = chores.map(c => c.id === editState.id ? { ...c, text: choreText, type: typeInput.value } : c);
        editState = { isEditing: false, id: null };
        document.getElementById('form-title').innerText = 'ADD_TASK';
        document.getElementById('submit-btn').innerText = 'COMMIT_CHORE';
    } else {
        chores.push({ text: choreText, type: typeInput.value, completed: false, starred: false, id: Date.now() });
    }

    textInput.value = '';
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
    editState = { isEditing: true, id };
    document.getElementById('form-title').innerText = 'EDIT_TASK';
    document.getElementById('submit-btn').innerText = 'UPDATE_CHORE';
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
                        content: JSON.stringify({ chores, notes: notesArea.innerText }, null, 2)
                    }
                }
            })
        });
    } catch(e) {}
}

window.manualSync = async () => {
    if (!GITHUB_TOKEN || !GIST_ID) return;
    const btn = document.getElementById('sync-btn');
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> SYNCING...';
    try {
        const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
            headers: { 'Authorization': `token ${GITHUB_TOKEN}` },
            cache: 'no-store'
        });
        const json = await res.json();
        const data = JSON.parse(json.files[GIST_FILENAME].content);
        chores = data.chores || [];
        notesArea.innerText = data.notes || "";
        updateUI();
        btn.innerHTML = '<i class="fas fa-check"></i> SYNC_OK';
    } catch(e) {
        btn.innerHTML = '<i class="fas fa-exclamation-triangle"></i> ERR';
    }
    setTimeout(() => { btn.innerHTML = '<i class="fas fa-cloud"></i> CLOUD_SYNC'; }, 2000);
};

notesArea.addEventListener('input', () => {
    localStorage.setItem('choreNotes', notesArea.innerText);
    saveToGist();
});

function initApp() {
    checkMidnightReset();
    const savedNotes = localStorage.getItem('choreNotes');
    if (savedNotes) notesArea.innerText = savedNotes;
    updateUI();
    window.manualSync();
}
