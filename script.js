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

// INITIAL LOAD
try {
    const stored = localStorage.getItem('choreData');
    if (stored) chores = JSON.parse(stored);
} catch (e) { chores = []; }

try {
    const storedPlan = localStorage.getItem('dailyPlan');
    if (storedPlan) dailyPlan = JSON.parse(storedPlan);
} catch (e) { dailyPlan = []; }

// MIDNIGHT RESET
function checkMidnightReset() {
    const lastReset = localStorage.getItem('lastPlanReset');
    const today = new Date().toDateString();
    if (lastReset !== today) {
        // Automatically populate daily plan with starred chores
        dailyPlan = chores.filter(c => c.starred).map(c => c.id);
        localStorage.setItem('dailyPlan', JSON.stringify(dailyPlan));
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

// DAILY PLAN RENDERING
function updateDailyPlan() {
    const planList = document.getElementById('list-daily-plan');
    const emptyMsg = document.getElementById('plan-empty');
    const countTag = document.getElementById('plan-count');

    dailyPlan = dailyPlan.filter(id => chores.find(c => c.id === id));
    planList.innerHTML = '';

    if (dailyPlan.length === 0) {
        emptyMsg.style.display = 'block';
        countTag.innerText = '0 TASKS';
        return;
    }

    emptyMsg.style.display = 'none';
    countTag.innerText = `${dailyPlan.length} TASK${dailyPlan.length > 1 ? 'S' : ''}`;

    dailyPlan.forEach((id, idx) => {
        const c = chores.find(ch => ch.id === id);
        if (!c) return;

        const li = document.createElement('li');
        li.className = `priority-${c.type}`;

        const upDisabled = idx === 0 ? 'disabled' : '';
        const downDisabled = idx === dailyPlan.length - 1 ? 'disabled' : '';

        li.innerHTML = `
            <span class="plan-num">${String(idx + 1).padStart(2, '0')}.</span>
            <div style="flex-grow: 1; font-family: var(--font-mono); font-size: 0.85rem;">${c.text}</div>
            <div class="plan-reorder">
                <button onclick="movePlanItem(${id}, -1)" ${upDisabled} title="Move up">▲</button>
                <button onclick="movePlanItem(${id}, 1)" ${downDisabled} title="Move down">▼</button>
            </div>
            <i class="fas fa-trash" style="color: var(--danger); font-size: 0.8rem;" onclick="deleteChore(${id})"></i>
        `;
        planList.appendChild(li);
    });
}

// UI RENDERING
function updateUI() {
    Object.values(lists).forEach(l => l.innerHTML = '');

    const sorted = [...chores].sort((a, b) => {
        if (a.type !== b.type) return 0; 
        return (b.starred ? 1 : 0) - (a.starred ? 1 : 0);
    });

    ['daily', 'errands', 'oneoff'].forEach(type => {
        const group = sorted.filter(c => c.type === type);
        group.sort((a, b) => (b.starred ? 1 : 0) - (a.starred ? 1 : 0));
        group.forEach(c => {
            const isQueued = dailyPlan.includes(c.id);
            const li = document.createElement('li');
            li.className = `priority-${c.type} ${c.completed ? 'completed' : ''}`;

            li.onclick = (e) => {
                if (e.target.tagName === 'I' || e.target.closest('.chore-queue-check') || e.target.closest('.chore-star-btn')) return;
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
                <div style="display: flex; gap: 15px;">
                    <i class="fas fa-edit" style="color: var(--text-muted);" onclick="editChore(${c.id})"></i>
                    <i class="fas fa-trash" style="color: var(--danger);" onclick="deleteChore(${c.id})"></i>
                </div>
            `;
            if (lists[c.type]) lists[c.type].appendChild(li);
        });
    });

    const total = chores.length;
    const completed = chores.filter(c => c.completed).length;
    const pct = total === 0 ? 0 : Math.round((completed / total) * 100);
    document.getElementById('month-progress').style.width = `${pct}%`;
    document.getElementById('days-left').innerText = `COMPLETION: ${pct}%`;

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

window.movePlanItem = (id, dir) => {
    const idx = dailyPlan.indexOf(id);
    const newIdx = idx + dir;
    if (newIdx < 0 || newIdx >= dailyPlan.length) return;
    dailyPlan.splice(idx, 1);
    dailyPlan.splice(newIdx, 0, id);
    savePlan();
    updateDailyPlan();
};

// STAR TOGGLE (CORRELATED WITH DAILY PLAN)
window.toggleStar = (id) => {
    chores = chores.map(c => {
        if (c.id === id) {
            const newStarred = !c.starred;
            // Automatically add to or remove from today's plan
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
    // Refresh the daily plan with starred items upon reset
    dailyPlan = chores.filter(c => c.starred).map(c => c.id);
    savePlan();
    saveAndSync();
};

window.editChore = (id) => {
    const c = chores.find(chore => chore.id === id);
    textInput.value = c.text;
    typeInput.value = c.type;
    editState = { isEditing: true, id };
};

window.deleteChore = (id) => {
    chores = chores.filter(c => c.id !== id);
    dailyPlan = dailyPlan.filter(pid => pid !== id);
    savePlan();
    saveAndSync();
};

// PERSISTENCE
function savePlan() {
    localStorage.setItem('dailyPlan', JSON.stringify(dailyPlan));
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
                        content: JSON.stringify({ chores, notes: notesArea.value }, null, 2)
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
        notesArea.value = data.notes || "";
        updateUI();
        btn.innerHTML = '<i class="fas fa-check"></i> SYNC_OK';
    } catch(e) {
        btn.innerHTML = '<i class="fas fa-exclamation-triangle"></i> ERR';
    }
    setTimeout(() => { btn.innerHTML = '<i class="fas fa-cloud"></i> CLOUD_SYNC'; }, 2000);
};

notesArea.addEventListener('input', () => {
    localStorage.setItem('choreNotes', notesArea.value);
    saveToGist();
});

function initApp() {
    checkMidnightReset();
    const savedNotes = localStorage.getItem('choreNotes');
    if (savedNotes) notesArea.value = savedNotes;
    updateUI();
    window.manualSync();
}
