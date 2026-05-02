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

if (localStorage.getItem('darkMode') === 'enabled') {
    document.body.classList.add('dark-mode');
}

try {
    const stored = localStorage.getItem('choreData');
    if (stored) chores = JSON.parse(stored);
} catch (e) {
    chores = [];
}

const btnLogin = document.getElementById('login-btn');
const passInput = document.getElementById('password-input');
const appContainer = document.getElementById('app-container');

const checkPwd = () => {
    if (passInput.value === MY_PASSWORD) {
        document.getElementById('login-overlay').style.display = 'none';
        appContainer.style.display = window.innerWidth >= 768 ? 'grid' : 'flex';
        initApp();
    } else {
        document.getElementById('login-error').innerText = 'Incorrect Password';
        passInput.value = '';
    }
};

btnLogin.addEventListener('click', checkPwd);
passInput.addEventListener('keydown', e => { if (e.key === 'Enter') checkPwd(); });

function updateDateAndProgress() {
    const now = new Date();
    document.getElementById('current-date').innerText = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

    const total = chores.length;
    const completed = chores.filter(c => c.completed).length;
    const percentage = total === 0 ? 0 : (completed / total) * 100;

    progressFill.style.width = `${percentage}%`;
    daysLeftText.innerText = `${completed} out of ${total} tasks complete`;
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
        chores = chores.map(c => c.id === editState.id ? { ...c, ...newChore, completed: c.completed } : c);
        editState = { isEditing: false, id: null };
        formTitle.innerText = 'Add New Chore';
        submitBtn.innerText = 'Add Chore';
        submitBtn.style.backgroundColor = 'var(--primary-color)';
    } else {
        chores.push({ ...newChore, id: Math.floor(Math.random() * 10000000) });
    }

    textInput.value = '';
    typeInput.value = 'daily';
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
    formTitle.innerText = 'Edit Chore';
    submitBtn.innerText = 'Update Chore';
    submitBtn.style.backgroundColor = '#f59e0b';
    document.querySelector('.add-transaction').scrollIntoView({ behavior: 'smooth' });
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
    confirmCallback = null;
});

document.getElementById('confirm-no-btn').addEventListener('click', () => {
    document.getElementById('confirm-modal').style.display = 'none';
    confirmCallback = null;
});

window.deleteChore = (id) => {
    customConfirm('Delete Task', 'Are you sure you want to delete this task?', () => {
        chores = chores.filter(c => c.id !== id);
        updateLocalAndGist();
        renderUI();
    });
};

window.resetMaintenance = () => {
    customConfirm('Reset Maintenance', 'Reset completion status for all Daily Maintenance chores?', () => {
        chores = chores.map(c => c.type === 'daily' ? { ...c, completed: false } : c);
        updateLocalAndGist();
        renderUI();
    });
};

window.openSettings = () => {
    document.getElementById('github-token-input').value = GITHUB_TOKEN;
    document.getElementById('gist-id-input').value = GIST_ID;
    document.getElementById('settings-modal').style.display = 'flex';
};

window.manualSync = async () => {
    const btn = document.getElementById('sync-btn');
    if (!GITHUB_TOKEN || !GIST_ID) {
        if (btn) btn.innerHTML = '<i class="fas fa-exclamation-triangle"></i> Setup Req';
        setTimeout(() => { if (btn) btn.innerHTML = '<i class="fas fa-cloud"></i> Cloud Sync'; }, 2000);
        return;
    }
    if (btn) btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Loading...';
    try {
        const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
            headers: { 'Authorization': `token ${GITHUB_TOKEN}` }, cache: 'no-store'
        });
        if (!res.ok) throw new Error();
        const json = await res.json();
        if (json.files && json.files[GIST_FILENAME]) {
            const data = JSON.parse(json.files[GIST_FILENAME].content);
            if (data.chores) chores = data.chores;
            if (data.notes !== undefined) notesArea.value = data.notes;
            localStorage.setItem('choreData', JSON.stringify(chores));
            localStorage.setItem('choreNotes', notesArea.value);
            renderUI();
            lastSyncedTime = new Date();
            updateSyncTimestamp();
            if (btn) btn.innerHTML = '<i class="fas fa-cloud-download-alt"></i> Loaded';
        } else {
            saveToGistThrottled();
        }
    } catch(e) {
        if (btn) btn.innerHTML = '<i class="fas fa-exclamation-triangle"></i> Error';
    }
    setTimeout(() => { if (btn) btn.innerHTML = '<i class="fas fa-cloud"></i> Cloud Sync'; }, 2000);
};

function renderUI() {
    listDaily.innerHTML = '';
    listErrands.innerHTML = '';
    listOneoff.innerHTML = '';

    let hasDaily = false;
    let hasErrands = false;
    let hasOneoff = false;

    chores.forEach(c => {
        const li = document.createElement('li');
        let cssClass = 'priority-' + c.type;
        if (c.completed) cssClass = 'completed';
        li.className = cssClass;

        li.innerHTML = `
            <div class="checkbox-container">
                <input type="checkbox" ${c.completed ? 'checked' : ''} onchange="toggleChore(${c.id})">
            </div>
            <div class="list-info">
                <span>${c.text}</span>
            </div>
            <div class="list-actions">
                <button class="action-btn edit-btn" onclick="editChore(${c.id})"><i class="fas fa-edit"></i></button>
                <button class="action-btn delete-btn" onclick="deleteChore(${c.id})"><i class="fas fa-times"></i></button>
            </div>
        `;

        if (c.type === 'daily') { listDaily.appendChild(li); hasDaily = true; }
        else if (c.type === 'errands') { listErrands.appendChild(li); hasErrands = true; }
        else if (c.type === 'oneoff') { listOneoff.appendChild(li); hasOneoff = true; }
    });

    sectionDaily.style.display = hasDaily ? 'block' : 'none';
    sectionErrands.style.display = hasErrands ? 'block' : 'none';
    sectionOneoff.style.display = hasOneoff ? 'block' : 'none';

    updateDateAndProgress();
}

notesArea.addEventListener('input', () => {
    localStorage.setItem('choreNotes', notesArea.value);
    saveToGistThrottled();
});

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

document.getElementById('dark-mode-btn').addEventListener('click', () => {
    document.body.classList.toggle('dark-mode');
    const icon = document.querySelector('#dark-mode-btn i');
    if (document.body.classList.contains('dark-mode')) {
        localStorage.setItem('darkMode', 'enabled');
        icon.classList.replace('fa-moon', 'fa-sun');
    } else {
        localStorage.setItem('darkMode', 'disabled');
        icon.classList.replace('fa-sun', 'fa-moon');
    }
});

if (document.body.classList.contains('dark-mode')) {
    document.querySelector('#dark-mode-btn i').classList.replace('fa-moon', 'fa-sun');
}

let syncTimeout;
let lastSyncedTime = null;

function updateSyncTimestamp() {
    const timestampEl = document.getElementById('sync-timestamp');
    if (!timestampEl || !lastSyncedTime) return;
    const diffSec = Math.floor((new Date() - lastSyncedTime) / 1000);
    if (diffSec < 60) timestampEl.innerText = `Last synced: ${diffSec}s ago`;
    else timestampEl.innerText = `Last synced: ${Math.floor(diffSec / 60)}m ago`;
}
setInterval(updateSyncTimestamp, 60000);

function updateLocalAndGist() {
    localStorage.setItem('choreData', JSON.stringify(chores));
    saveToGistThrottled();
}

function saveToGistThrottled() {
    if (!GITHUB_TOKEN || !GIST_ID) return;
    clearTimeout(syncTimeout);
    syncTimeout = setTimeout(async () => {
        const btn = document.getElementById('sync-btn');
        if (btn) btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';
        try {
            const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
                method: 'PATCH',
                headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ files: { [GIST_FILENAME]: { content: JSON.stringify({ chores, notes: notesArea.value }, null, 2) } } })
            });
            if (res.ok) {
                lastSyncedTime = new Date();
                updateSyncTimestamp();
                if (btn) btn.innerHTML = '<i class="fas fa-check-circle"></i> Saved';
            } else throw new Error();
        } catch(e) {
            if (btn) btn.innerHTML = '<i class="fas fa-exclamation-triangle"></i> Error';
        }
        setTimeout(() => { if (btn) btn.innerHTML = '<i class="fas fa-cloud"></i> Cloud Sync'; }, 2000);
    }, 1500);
}

function initApp() {
    const savedNotes = localStorage.getItem('choreNotes');
    if (savedNotes) notesArea.value = savedNotes;

    if (chores.length === 0) {
        chores = [
            { id: 101, text: 'Clean kitchen counters', type: 'daily', completed: false },
            { id: 102, text: 'Sweep floors', type: 'daily', completed: false },
            { id: 105, text: 'Buy groceries', type: 'errands', completed: false }
        ];
        localStorage.setItem('choreData', JSON.stringify(chores));
    }

    renderUI();
    window.manualSync();
}

// FUTURE IDEAS
// 1. Recurring Auto-Reset: Automatically uncheck "Daily Maintenance" chores at midnight local time.
// 2. Gamification & Points: Assign point values to chore types and maintain a weekly score.
// 3. User Accounts: Support family members assigning tasks to specific people.
// 4. Sub-tasks: Allow a small checklist inside a larger task.
// 5. Activity Log: Keep a rolling 7-day history array in the Gist showing when chores were completed.
// 6. Push Notifications: Remind the user to reset maintenance chores each morning via browser notifications.
