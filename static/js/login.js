"use strict";
// ===== LOGIN PAGE (TypeScript) =====
function showLoginTab(tab) {
    document.querySelectorAll('.ltab').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.lpanel').forEach((p) => p.classList.remove('active'));
    document.getElementById('ltab-' + tab)?.classList.add('active');
    document.getElementById('panel-' + tab)?.classList.add('active');
}
let pendingTeam = null;
let pollIv = null;
function validateQuizId() {
    const input = document.getElementById('l-quizid');
    const info = document.getElementById('l-quiz-info');
    if (!input || !info)
        return;
    const qid = input.value.trim().toUpperCase();
    if (!qid) {
        info.style.display = 'none';
        return;
    }
    const managed = Store.getManagedQuizzes();
    const q = managed.find((x) => x.quizId === qid);
    if (q) {
        info.style.display = 'block';
        info.className = 'text-xs mt-1 text-success fw-bold';
        info.textContent = `✓ Found: ${q.collegeName} (${q.status})`;
    }
    else {
        info.style.display = 'block';
        info.className = 'text-xs mt-1 text-danger fw-bold';
        info.textContent = '✗ Invalid Quiz ID';
    }
}
async function doLogin() {
    const username = document.getElementById('l-username')?.value.trim() || '';
    const password = document.getElementById('l-password')?.value.trim() || '';
    const quizId = document.getElementById('l-quizid')?.value.trim().toUpperCase() || '';
    const err = document.getElementById('l-error');
    if (err)
        err.textContent = '';
    if (!username || !password) {
        if (err)
            err.textContent = 'Please enter username and password.';
        return;
    }
    try {
        const resp = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password, quizId }),
        });
        const result = await resp.json();
        if (!result.success) {
            if (err)
                err.textContent = result.message || 'Invalid username or password.';
            return;
        }
        Store.setToken(result.token);
        Store.setSession(result.session);
        const role = result.session.role;
        if (result.session.isSuper) {
            Store.addActivity('Super Admin logged in', 'info', true);
            window.location.href = '/superadmin';
        }
        else if (role === 'admin') {
            Store.addActivity(`Admin logged in (Quiz: ${result.session.quizId})`, 'info');
            window.location.href = '/admin';
        }
        else if (role === 'user') {
            alert('Access Pending: Your account has "User" rights. Please ask the Superadmin to promote you to "Admin" to access the dashboard.');
            Store.addActivity(`User logged in: ${result.session.name}`, 'info');
            window.location.href = '/participant';
        }
        else if (role === 'participant' || role === 'team') {
            pendingTeam = {
                ...result.session,
                name: result.session.name || result.session.teamName,
                id: result.session.userId || result.session.teamId,
                isParticipant: role === 'participant',
            };
            completeLoginWithoutCamera();
        }
        else {
            Store.addActivity('Viewer logged in', 'info');
            window.location.href = '/participant';
        }
    }
    catch (e) {
        console.error(e);
        if (err)
            err.textContent = 'Server connection error. Please try again later.';
    }
}
function completeLoginWithoutCamera() {
    if (!pendingTeam)
        return;
    const qid = pendingTeam.quizId;
    const name = pendingTeam.name;
    const id = pendingTeam.id;
    if (pendingTeam.isParticipant) {
        const rid = Store.addLoginRecord(name, 'participant');
        if (qid)
            Store.updateUser(id, { currentQuizId: qid });
        Store.setSession({ role: 'participant', userId: id, name, eligible: true, cameraStatus: 'active', rid, quizId: qid });
        Store.addActivity(`Participant <strong>${name}</strong> logged in`, 'info');
        window.location.href = '/participant';
    }
    else {
        const rid = Store.addLoginRecord(name, 'team');
        Store.setSession({ role: 'team', teamId: id, teamName: name, eligible: true, cameraStatus: 'active', rid, quizId: qid });
        Store.setTeamLogin(id, name, true);
        Store.addActivity(`Team <strong>${name}</strong> logged in (Quiz: ${qid})`, 'info');
        window.location.href = `/team/${encodeURIComponent(name)}`;
    }
}
async function requestCamPermission() {
    completeLoginWithoutCamera();
}
function closeModal(id) {
    document.getElementById(id)?.classList.remove('open');
    if (id === 'modal-camera') {
        if (pollIv) {
            clearInterval(pollIv);
            pollIv = null;
        }
        pendingTeam = null;
    }
}
function doRegister() {
    const name = document.getElementById('r-name')?.value.trim() || '';
    const roll = document.getElementById('r-roll')?.value.trim() || '';
    const username = document.getElementById('r-user')?.value.trim() || '';
    const quizId = document.getElementById('r-quizid')?.value.trim().toUpperCase() || '';
    const college = document.getElementById('r-college')?.value.trim() || '';
    const dept = document.getElementById('r-dept')?.value.trim() || '';
    const year = document.getElementById('r-year')?.value || '1';
    const password = document.getElementById('r-pass')?.value.trim() || '';
    const confirm = document.getElementById('r-confirm')?.value.trim() || '';
    const err = document.getElementById('r-error');
    const suc = document.getElementById('r-success');
    if (err)
        err.textContent = '';
    suc?.classList.add('hidden');
    if (!name || !roll || !username || !password || !college || !dept) {
        if (err)
            err.textContent = 'All fields are required.';
        return;
    }
    if (username.length < 3) {
        if (err)
            err.textContent = 'Username must be at least 3 characters.';
        return;
    }
    if (password.length < 4) {
        if (err)
            err.textContent = 'Password must be at least 4 characters.';
        return;
    }
    if (password !== confirm) {
        if (err)
            err.textContent = 'Passwords do not match.';
        return;
    }
    const newUser = {
        id: genId(),
        name,
        roll,
        username,
        password,
        college,
        dept,
        year,
        role: 'user',
        currentQuizId: quizId,
        registeredAt: Date.now(),
    };
    fetch('/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newUser),
    })
        .then((r) => r.json())
        .then((res) => {
        if (res.success) {
            Store.addUser(newUser);
            Store.addActivity(`New registration: <strong>${name}</strong>`, 'info');
            ['r-name', 'r-roll', 'r-user', 'r-quizid', 'r-pass', 'r-confirm'].forEach((id) => {
                const el = document.getElementById(id);
                if (el)
                    el.value = '';
            });
            if (suc) {
                suc.textContent = '✓ Account created! Admin will approve your role. You may then login.';
                suc.classList.remove('hidden');
            }
        }
        else {
            if (err)
                err.textContent = res.message || 'Registration failed.';
        }
    })
        .catch((e) => {
        console.error(e);
        if (err)
            err.textContent = 'Server connection error.';
    });
}
document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter')
        return;
    const active = document.querySelector('.lpanel.active')?.id;
    if (active === 'panel-login')
        doLogin();
    else if (active === 'panel-register')
        doRegister();
});
