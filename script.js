const MY_PASSWORD = "p";
const GIST_FILENAME = "chore-data.json";

let GITHUB_TOKEN = localStorage.getItem('githubToken') || "";
let GIST_ID = localStorage.getItem('gistId') || "";

const form = document.getElementById('form');
const formTitle = document.getElementById('form-title');
const textInput = document.getElementById('text');
const typeInput = document.getElementById('type');
const submitBtn = document.getElementById('submit-btn');

const listDaily = document.getElementById('list-daily');
const listErrands = document.getElementById('list-errands');
const listOneoff = document.getElementById('list-oneoff');

const sectionDaily = document.getElementById('section-daily');
const sectionErrands = document.getElementById('section-errands');
const sectionOneoff = document.getElementById('section-oneoff');

const progressFill = document.getElementById('month-progress');
const daysLeftText = document.getElementById('days-left');
const notesArea = document.getElementById('notes-area');

let chores = [];
let editState = { isEditing: false, id: null };

// Load Initial Data
try {
    const stored = localStorage.getItem('choreData');
    if (stored) chores = JSON.parse(stored);
} catch (e) { chores = []; }

const btnLogin = document.getElementById('login-btn');
const passInput = document.getElementById('password-input');

const checkPwd = () => {
    if (passInput.value === MY_PASSWORD) {
        document.getElementById('login-overlay').style.display = 'none';
        document.getElementById('app-container').style.display = 'grid';
        initApp();
    } else {
        document.getElementById('login-error').innerText = 'ACCESS_DENIED';
        passInput.value = '';
    }
};

btnLogin.addEventListener('click', checkPwd);
passInput.addEventListener('keydown', e => { if (e.key === 'Enter') checkPwd(); });

function updateDateAndProgress() {
    const now = new Date();
    document.getElementById('current-date').innerText = now.toLocaleDateString('en-US', { 
        weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit' 
    }).replace(/\//g, '.');

    const total = chores.length;
    const completed = chores.filter(c => c.completed).length;
    const percentage = total === 0 ? 0 : Math.round((completed / total) * 100);

    progressFill.style.width = `${percentage}%`;
    daysLeftText.innerText = `COMPLETION: ${percentage}%`;
}

form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!textInput.value.trim()) return;

    const newChore = {
        text: textInput.value,
        type: typeInput.value,
        completed: false
    };

    if (editState.isEditing) {
        chores = chores.map(c => c.id === editState.id ? { ...c, ...newChore } : c);
        editState = { isEditing: false, id: null };
        formTitle.innerText = 'NEW_CHORE_ENTRY';
        submitBtn.innerText = 'COMMIT_CHORE';
    } else {
        chores.push({ ...newChore, id: Date.now() });
    }

    textInput.value = '';
    updateLocalAndGist();
    renderUI();
});

window.toggleChore = (id) => {
    chores = chores.map(c => c.id === id ? { ...c, completed: !c.completed } : c);
    updateLocalAndGist();
    renderUI();
};

window.editChore = (id) => {
    const chore = chores.find(c => c.id === id);
    if (!chore) return;
    textInput.value = chore.text;
    typeInput.value = chore.type;
    editState = { isEditing: true, id };
    formTitle.innerText = 'EDIT_MODE';
    submitBtn.innerText = 'UPDATE_CHORE';
};

let confirmCallback = null;
function customConfirm(title, message, callback) {
    document.getElementById('confirm-title').innerText = title;
    document.getElementById('confirm-message').innerText = message;
    document.getElementById('confirm-modal').style.display = 'flex';
    confirmCallback = callback;
}

document.getElementById('confirm-yes-btn').addEventListener('click', () => {
    document.getElementById('confirm-modal').style.display = 'none';
    if (confirmCallback) confirmCallback();
});

document.getElementById('confirm-no-btn').addEventListener('click', () => {
    document.getElementById('confirm-modal').style.display = 'none';
});

window.deleteChore = (id) => {
    customConfirm('DELETE_TASK', 'Permanently remove chore from system?', () => {
        chores = chores.filter(c => c.id !== id);
        updateLocalAndGist();
        renderUI();
    });
};

window.resetMaintenance = () => {
    customConfirm('RESET_DAILY', 'Refresh all daily maintenance status?', () => {
        chores = chores.map(c => c.type === 'daily' ? { ...c, completed: false } : c);
        updateLocalAndGist();
        renderUI();
    });
};

function renderUI() {
    listDaily.innerHTML = '';
    listErrands.innerHTML = '';
    listOneoff.innerHTML = '';

    chores.forEach(c => {
        const li = document.createElement('li');
        li.className = `priority-${c.type} ${c.completed ? 'completed' : ''}`;

        li.innerHTML = `
            <label class="checkbox-container">
                <input type="checkbox" ${c.completed ? 'checked' : ''} onchange="toggleChore(${c.id})">
                <span class="custom-check"></span>
            </label>
            <div style="flex-grow: 1; font-family: var(--font-mono); font-size: 0.9rem;">
                ${c.text}
            </div>
            <div style="display: flex; gap: 10px;">
                <i class="fas fa-edit" style="cursor:pointer; color: var(--text-muted);" onclick="editChore(${c.id})"></i>
                <i class="fas fa-trash" style="cursor:pointer; color: var(--danger);" onclick="deleteChore(${c.id})"></i>
            </div>
        `;

        if (c.type === 'daily') listDaily.appendChild(li);
        else if (c.type === 'errands') listErrands.appendChild(li);
        else if (c.type === 'oneoff') listOneoff.appendChild(li);
    });

    updateDateAndProgress();
}

// Settings & Sync
window.openSettings = () => document.getElementById('settings-modal').style.display = 'flex';
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

window.manualSync = async () => {
    if (!GITHUB_TOKEN || !GIST_ID) return;
    const btn = document.getElementById('sync-btn');
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> SYNCING...';
    try {
        const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
            headers: { 'Authorization': `token ${GITHUB_TOKEN}` }, cache: 'no-store'
        });
        const json = await res.json();
        if (json.files && json.files[GIST_FILENAME]) {
            const data = JSON.parse(json.files[GIST_FILENAME].content);
            chores = data.chores || [];
            notesArea.value = data.notes || "";
            localStorage.setItem('choreData', JSON.stringify(chores));
            renderUI();
            btn.innerHTML = '<i class="fas fa-check"></i> SYNC_OK';
        }
    } catch(e) { btn.innerHTML = '<i class="fas fa-exclamation-triangle"></i> ERR'; }
    setTimeout(() => { btn.innerHTML = '<i class="fas fa-cloud"></i> CLOUD_SYNC'; }, 2000);
};

function updateLocalAndGist() {
    localStorage.setItem('choreData', JSON.stringify(chores));
    saveToGistThrottled();
}

let syncTimeout;
function saveToGistThrottled() {
    if (!GITHUB_TOKEN || !GIST_ID) return;
    clearTimeout(syncTimeout);
    syncTimeout = setTimeout(async () => {
        try {
            await fetch(`https://api.github.com/gists/${GIST_ID}`, {
                method: 'PATCH',
                headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ files: { [GIST_FILENAME]: { content: JSON.stringify({ chores, notes: notesArea.value }, null, 2) } } })
            });
        } catch(e) {}
    }, 2000);
}

notesArea.addEventListener('input', saveToGistThrottled);

function initApp() {
    const savedNotes = localStorage.getItem('choreNotes');
    if (savedNotes) notesArea.value = savedNotes;
    renderUI();
    window.manualSync();
}
