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
let editState = { isEditing: false, id: null };

try {
    const stored = localStorage.getItem('choreData');
    if (stored) chores = JSON.parse(stored);
} catch (e) { chores = []; }

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

function updateUI() {
    Object.values(lists).forEach(l => l.innerHTML = '');
    
    chores.forEach(c => {
        const li = document.createElement('li');
        li.className = `priority-${c.type} ${c.completed ? 'completed' : ''}`;
        
        // CLICKABLE BAR LOGIC
        li.onclick = (e) => {
            // Prevent toggle if clicking edit/delete icons specifically
            if (e.target.tagName !== 'I') toggleChore(c.id);
        };

        li.innerHTML = `
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

    const total = chores.length;
    const completed = chores.filter(c => c.completed).length;
    const pct = total === 0 ? 0 : Math.round((completed / total) * 100);
    document.getElementById('month-progress').style.width = `${pct}%`;
    document.getElementById('days-left').innerText = `COMPLETION: ${pct}%`;
    
    const now = new Date();
    document.getElementById('current-date').innerText = now.toLocaleDateString('en-US', { weekday: 'short', month: '2-digit', day: '2-digit' }).replace(/\//g, '.');
}

form.addEventListener('submit', (e) => {
    e.preventDefault();
    const choreText = textInput.value.trim();
    if (!choreText) return;

    if (editState.isEditing) {
        chores = chores.map(c => c.id === editState.id ? { ...c, text: choreText, type: typeInput.value } : c);
        editState = { isEditing: false, id: null };
    } else {
        chores.push({ text: choreText, type: typeInput.value, completed: false, id: Date.now() });
    }

    textInput.value = '';
    saveAndSync();
});

window.toggleChore = (id) => {
    chores = chores.map(c => c.id === id ? { ...c, completed: !c.completed } : c);
    saveAndSync();
};

window.resetMaintenance = () => {
    const dailyCount = chores.filter(c => c.type === 'daily').length;
    if (dailyCount === 0) return;
    
    // Only resets daily tasks, leaves others alone
    chores = chores.map(c => c.type === 'daily' ? { ...c, completed: false } : c);
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
    saveAndSync();
};

function saveAndSync() {
    localStorage.setItem('choreData', JSON.stringify(chores));
    updateUI();
    saveToGist();
}

// Gist logic remains identical to previous functional version
async function saveToGist() {
    if (!GITHUB_TOKEN || !GIST_ID) return;
    try {
        await fetch(`https://api.github.com/gists/${GIST_ID}`, {
            method: 'PATCH',
            headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ files: { [GIST_FILENAME]: { content: JSON.stringify({ chores, notes: notesArea.value }) } } })
        });
    } catch(e) {}
}

window.manualSync = async () => {
    if (!GITHUB_TOKEN || !GIST_ID) return;
    try {
        const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, { headers: { 'Authorization': `token ${GITHUB_TOKEN}` } });
        const json = await res.json();
        const data = JSON.parse(json.files[GIST_FILENAME].content);
        chores = data.chores || [];
        notesArea.value = data.notes || "";
        updateUI();
    } catch(e) {}
};

window.openSettings = () => document.getElementById('settings-modal').style.display = 'flex';
initApp();
function initApp() { updateUI(); window.manualSync(); }
