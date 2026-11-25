"use strict";
// ===== SACET QUIZ — TYPESCRIPT STORAGE & DJANGO REAL-TIME SYNC ENGINE =====
class DjangoSyncSocket {
    constructor() {
        this.connected = true;
        this.listeners = {};
        this.lastTs = 0;
        this.polling = false;
        this.startPolling();
    }
    on(event, cb) {
        if (!this.listeners[event])
            this.listeners[event] = [];
        this.listeners[event].push(cb);
    }
    trigger(event, data) {
        const cbs = this.listeners[event] || [];
        cbs.forEach((cb) => {
            try {
                cb(data);
            }
            catch (e) {
                console.error('[SYNC] Listener error:', e);
            }
        });
    }
    emit(event, data) {
        const token = localStorage.getItem('sq_token') || '';
        const headers = { 'Content-Type': 'application/json' };
        if (token)
            headers['Authorization'] = `Bearer ${token}`;
        if (event === 'sync') {
            fetch('/api/sync/push', {
                method: 'POST',
                headers,
                body: JSON.stringify(data),
            }).catch((e) => console.warn('[SYNC] Push failed:', e));
        }
        else if (event === 'admin_cmd') {
            fetch('/api/sync/cmd', {
                method: 'POST',
                headers,
                body: JSON.stringify(data),
            }).catch((e) => console.warn('[SYNC] Cmd failed:', e));
        }
        else if (event === 'admin_audio') {
            fetch('/api/sync/audio', {
                method: 'POST',
                headers,
                body: JSON.stringify(data),
            }).catch((e) => console.warn('[SYNC] Audio failed:', e));
        }
    }
    async poll() {
        if (this.polling)
            return;
        this.polling = true;
        try {
            const token = localStorage.getItem('sq_token') || '';
            const headers = {};
            if (token)
                headers['Authorization'] = `Bearer ${token}`;
            const resp = await fetch(`/api/sync/state?since=${this.lastTs}`, { headers });
            if (!resp.ok)
                return;
            const res = await resp.json();
            if (!res || !res.success)
                return;
            this.connected = true;
            if (res.updates) {
                Object.keys(res.updates).forEach((key) => {
                    const item = res.updates[key];
                    const localTs = parseInt(localStorage.getItem(`_ts_${key}`) || '0', 10);
                    if (item._ts && item._ts < localTs)
                        return;
                    localStorage.setItem(key, item.val);
                    if (item._ts)
                        localStorage.setItem(`_ts_${key}`, String(item._ts));
                    this.trigger('sync', { key, val: item.val, _ts: item._ts });
                    window.dispatchEvent(new CustomEvent('storage_sync', { detail: { key } }));
                });
            }
            if (Array.isArray(res.events)) {
                res.events.forEach((evt) => {
                    this.trigger(evt.event, evt.payload);
                });
            }
            if (res.serverTs && res.serverTs > this.lastTs) {
                this.lastTs = res.serverTs;
            }
        }
        catch {
            this.connected = false;
        }
        finally {
            this.polling = false;
        }
    }
    startPolling() {
        this.poll();
        setInterval(() => this.poll(), 1200);
    }
}
const socket = new DjangoSyncSocket();
window.socket = socket;
window.__clientIp = localStorage.getItem('sq_client_ip') || '127.0.0.1';
fetch('/api/client-ip')
    .then((r) => r.json())
    .then((d) => {
    if (d && d.ip) {
        window.__clientIp = d.ip;
        localStorage.setItem('sq_client_ip', d.ip);
    }
})
    .catch(() => { });
function io(_opts) {
    return socket;
}
window.io = io;
const KEYS = {
    QUIZ: 'sq_quiz',
    TEAMS: 'sq_teams',
    QUESTIONS: 'sq_questions',
    SESSION: 'sq_session',
    ACTIVITY: 'sq_activity',
    SETTINGS: 'sq_settings',
    ROUNDS: 'sq_rounds',
    USERS: 'sq_users',
    PARTICIPANTS: 'sq_participants',
    LOGIN_STATUS: 'sq_login_status',
    CAM_PREFIX: 'sq_cam_',
    CAM_STATUS: 'sq_cam_status',
    ALERTS: 'sq_alerts',
    FEEDBACK: 'sq_feedback',
    LOGIN_HISTORY: 'sq_login_history',
    QUIZ_REQUESTS: 'sq_quiz_requests',
    MANAGED_QUIZZES: 'sq_managed_quizzes',
};
const DEFAULT_SETTINGS = {
    adminUsername: 'srinivas',
    adminPassword: 'sri@1119',
    captchaCode: 'QUIZ2026',
    defaultTimePerQuestion: 60,
    participantTimeLimit: 30,
    overallTimeLimit: 0,
    globalInstructions: '',
    prizes: ['🏆 Gold Medal + ₹5000', '🥈 Silver Medal + ₹3000', '🥉 Bronze Medal + ₹1000'],
};
const DEFAULT_QUIZ = {
    status: 'idle',
    currentRoundIdx: 0,
    currentQInRound: 0,
    globalQIdx: 0,
    questionStartTeamIdx: 0,
    currentTeamIdx: 0,
    passChain: [],
    participantTurn: false,
    participantTimerStart: null,
    participantTimeLimit: 30,
    timerStart: null,
    timerLimit: 60,
    roundTimerStart: null,
    roundTimeLimit: 0,
    competitionStart: null,
    overallTimeLimit: 0,
    _timerEndHandled: false,
    _roundTimerEnded: false,
    _participantTimerHandled: false,
};
function load(key, def = null) {
    try {
        const v = localStorage.getItem(key);
        return v ? JSON.parse(v) : def;
    }
    catch {
        return def;
    }
}
function save(key, val) {
    const str = JSON.stringify(val);
    localStorage.setItem(key, str);
    if (socket && key !== KEYS.SESSION && !key.startsWith(KEYS.CAM_PREFIX)) {
        const token = localStorage.getItem('sq_token');
        const timestamp = Date.now();
        localStorage.setItem(`_ts_${key}`, String(timestamp));
        socket.emit('sync', { key, val: str, token, _ts: timestamp });
    }
}
function getPKey(key) {
    const s = Store.getSession();
    if ([
        KEYS.SESSION,
        KEYS.USERS,
        KEYS.LOGIN_HISTORY,
        KEYS.QUIZ_REQUESTS,
        KEYS.MANAGED_QUIZZES,
        KEYS.SETTINGS,
    ].includes(key)) {
        return key;
    }
    if (!s || !s.quizId) {
        return key;
    }
    return `${key}_${s.quizId}`;
}
const Store = {
    getSettings() {
        return { ...DEFAULT_SETTINGS, ...(load(KEYS.SETTINGS) || {}) };
    },
    saveSettings(s) {
        save(KEYS.SETTINGS, s);
    },
    getQuiz() {
        return { ...DEFAULT_QUIZ, ...(load(getPKey(KEYS.QUIZ)) || {}) };
    },
    saveQuiz(q) {
        save(getPKey(KEYS.QUIZ), q);
    },
    getUsers() {
        return load(KEYS.USERS, []);
    },
    saveUsers(u) {
        save(KEYS.USERS, u);
    },
    getUserById(id) {
        return Store.getUsers().find((u) => u.id === id) || null;
    },
    getUserByLogin(username, password) {
        return Store.getUsers().find((u) => u.username === username && u.password === password) || null;
    },
    updateUser(id, patch) {
        const list = Store.getUsers();
        const idx = list.findIndex((u) => u.id === id);
        if (idx >= 0) {
            list[idx] = { ...list[idx], ...patch };
            Store.saveUsers(list);
        }
    },
    deleteUser(id) {
        const list = Store.getUsers().filter((u) => u.id !== id);
        Store.saveUsers(list);
        try {
            const token = localStorage.getItem('sq_token');
            fetch('/api/users/delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ id, token }),
            }).catch((e) => console.warn('[DELETE] Backend API notify failed:', e));
        }
        catch { }
    },
    addUser(u) {
        const list = Store.getUsers();
        list.push(u);
        Store.saveUsers(list);
    },
    getTeams(quizId) {
        const pk = quizId ? `${KEYS.TEAMS}_${quizId}` : getPKey(KEYS.TEAMS);
        return load(pk, []).sort((a, b) => (a.teamNumber || 0) - (b.teamNumber || 0));
    },
    saveTeams(t) {
        save(getPKey(KEYS.TEAMS), t);
    },
    getActiveTeams() {
        return Store.getTeams().filter((t) => t.status === 'active');
    },
    getTeamById(id) {
        return Store.getTeams().find((t) => t.id === id) || null;
    },
    getTeamByLogin(u, p, quizId) {
        return Store.getTeams(quizId).find((t) => t.username === u && t.password === p && t.status === 'active') || null;
    },
    updateTeam(id, patch) {
        const list = load(getPKey(KEYS.TEAMS), []);
        const idx = list.findIndex((t) => t.id === id);
        if (idx >= 0) {
            list[idx] = { ...list[idx], ...patch };
            save(getPKey(KEYS.TEAMS), list);
        }
    },
    deleteTeam(id) {
        save(getPKey(KEYS.TEAMS), load(getPKey(KEYS.TEAMS), []).filter((t) => t.id !== id));
    },
    getQuestions(quizId) {
        const pk = quizId ? `${KEYS.QUESTIONS}_${quizId}` : getPKey(KEYS.QUESTIONS);
        return load(pk, []);
    },
    saveQuestions(q) {
        save(getPKey(KEYS.QUESTIONS), q);
    },
    getRounds(quizId) {
        const pk = quizId ? `${KEYS.ROUNDS}_${quizId}` : getPKey(KEYS.ROUNDS);
        return load(pk, []);
    },
    saveRounds(r) {
        save(getPKey(KEYS.ROUNDS), r);
    },
    getParticipants(quizId) {
        const pk = quizId ? `${KEYS.PARTICIPANTS}_${quizId}` : getPKey(KEYS.PARTICIPANTS);
        return load(pk, []);
    },
    saveParticipants(p) {
        save(getPKey(KEYS.PARTICIPANTS), p);
    },
    getParticipantById(id) {
        return Store.getParticipants().find((p) => p.id === id) || null;
    },
    upsertParticipant(id, name, patch) {
        const list = Store.getParticipants();
        const idx = list.findIndex((p) => p.id === id);
        if (idx >= 0) {
            list[idx] = { ...list[idx], ...patch };
        }
        else {
            list.push({ id, name, score: 0, correctCount: 0, answers: {}, ...patch });
        }
        Store.saveParticipants(list);
    },
    getLoginStatus() {
        return load(getPKey(KEYS.LOGIN_STATUS), {});
    },
    setTeamLogin(teamId, teamName, loggedIn) {
        const s = Store.getLoginStatus();
        s[teamId] = { loggedIn, teamName, loginTime: loggedIn ? Date.now() : s[teamId]?.loginTime || null };
        save(getPKey(KEYS.LOGIN_STATUS), s);
        if (loggedIn) {
            const teams = Store.getTeams();
            const idx = teams.findIndex((t) => t.id === teamId);
            if (idx >= 0 && teams[idx].status !== 'active') {
                teams[idx].status = 'active';
                Store.saveTeams(teams);
            }
        }
    },
    clearLoginStatus() {
        save(getPKey(KEYS.LOGIN_STATUS), {});
    },
    getLoginHistory() {
        return load(KEYS.LOGIN_HISTORY, []);
    },
    addLoginRecord(name, role) {
        const list = Store.getLoginHistory();
        list.unshift({ id: genId(), name, role, loginTime: Date.now(), logoutTime: null });
        if (list.length > 500)
            list.pop();
        save(KEYS.LOGIN_HISTORY, list);
        return list[0].id;
    },
    updateLogout(id) {
        const list = Store.getLoginHistory();
        const r = list.find((x) => x.id === id);
        if (r) {
            r.logoutTime = Date.now();
            save(KEYS.LOGIN_HISTORY, list);
        }
    },
    saveCamFrame(teamId, base64) {
        const key = KEYS.CAM_PREFIX + teamId;
        localStorage.setItem(key, base64);
        if (socket)
            socket.emit('sync', { key, val: base64 });
    },
    getCamFrame(teamId) {
        return localStorage.getItem(KEYS.CAM_PREFIX + teamId) || null;
    },
    clearCamFrame(teamId) {
        localStorage.removeItem(KEYS.CAM_PREFIX + teamId);
    },
    getCamStatus() {
        return load(getPKey(KEYS.CAM_STATUS), {});
    },
    updateCamStatus(teamId, patch) {
        const s = Store.getCamStatus();
        s[teamId] = { ...(s[teamId] || {}), ...patch };
        save(getPKey(KEYS.CAM_STATUS), s);
    },
    getAlerts() {
        return load(getPKey(KEYS.ALERTS), []);
    },
    addAlert(alert) {
        const list = Store.getAlerts();
        list.unshift(alert);
        if (list.length > 100)
            list.pop();
        save(getPKey(KEYS.ALERTS), list);
    },
    dismissAlert(id) {
        const list = Store.getAlerts();
        const idx = list.findIndex((a) => a.id === id);
        if (idx >= 0) {
            list[idx].dismissed = true;
            save(getPKey(KEYS.ALERTS), list);
        }
    },
    clearAlerts() {
        save(getPKey(KEYS.ALERTS), []);
    },
    addActivity(text, type = 'info', isSuper = false) {
        const sess = this.getSession();
        const quizId = isSuper ? null : sess?.quizId;
        const key = getPKey(KEYS.ACTIVITY);
        const now = new Date();
        const activity = {
            id: genId(),
            text,
            type,
            status: type.toUpperCase(),
            ip: window.__clientIp || localStorage.getItem('sq_client_ip') || '127.0.0.1',
            date: now.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }),
            time: now.toLocaleTimeString('en-IN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }),
            isSuper,
            quizId,
            timestamp: now.getTime(),
        };
        const list = load(key, []);
        list.unshift(activity);
        if (list.length > 300)
            list.pop();
        save(key, list);
        if (quizId) {
            const globalList = load(KEYS.ACTIVITY, []);
            globalList.unshift(activity);
            if (globalList.length > 1000)
                globalList.pop();
            save(KEYS.ACTIVITY, globalList);
        }
    },
    getActivity(forcedQuizId) {
        const sess = this.getSession();
        if (sess?.isSuper && forcedQuizId === undefined) {
            return load(KEYS.ACTIVITY, []);
        }
        const key = forcedQuizId !== undefined ? `${KEYS.ACTIVITY}_${forcedQuizId}` : getPKey(KEYS.ACTIVITY);
        return load(key, []);
    },
    clearActivity() {
        const sess = this.getSession();
        save(getPKey(KEYS.ACTIVITY), []);
        if (sess?.isSuper)
            save(KEYS.ACTIVITY, []);
    },
    getSession() {
        return load(KEYS.SESSION, null);
    },
    setSession(s) {
        save(KEYS.SESSION, s);
    },
    clearSession() {
        localStorage.removeItem(KEYS.SESSION);
        localStorage.removeItem('sq_token');
    },
    setToken(t) {
        localStorage.setItem('sq_token', t);
    },
    getToken() {
        return localStorage.getItem('sq_token');
    },
    getFeedback() {
        return load(getPKey(KEYS.FEEDBACK), []);
    },
    addFeedback(name, text) {
        const list = Store.getFeedback();
        list.push({ name, text, time: new Date().toLocaleString('en-IN') });
        save(getPKey(KEYS.FEEDBACK), list);
    },
    getQuizRequests() {
        return load(KEYS.QUIZ_REQUESTS, []);
    },
    saveQuizRequests(r) {
        save(KEYS.QUIZ_REQUESTS, r);
    },
    addQuizRequest(r) {
        const list = Store.getQuizRequests();
        list.push({ ...r, id: genId(), time: Date.now(), status: 'pending' });
        Store.saveQuizRequests(list);
    },
    deleteQuizRequest(id) {
        const list = Store.getQuizRequests().filter((r) => r.id !== id);
        Store.saveQuizRequests(list);
    },
    getManagedQuizzes() {
        return load(KEYS.MANAGED_QUIZZES, []);
    },
    saveManagedQuizzes(q) {
        save(KEYS.MANAGED_QUIZZES, q);
    },
    addManagedQuiz(q) {
        const list = Store.getManagedQuizzes();
        list.push(q);
        Store.saveManagedQuizzes(list);
    },
    generateQuizId() {
        return Math.random().toString(36).substr(2, 6).toUpperCase();
    },
    pushToBackend() {
        const token = localStorage.getItem('sq_token');
        Object.values(KEYS).forEach((key) => {
            if (key === KEYS.SESSION || key === KEYS.LOGIN_STATUS || key.startsWith('sq_cam_'))
                return;
            const val = localStorage.getItem(key);
            if (val)
                socket.emit('sync', { key, val, token });
        });
    },
    getQuizSummary(quizId) {
        const qObj = load(`${KEYS.QUIZ}_${quizId}`, DEFAULT_QUIZ);
        const teams = load(`${KEYS.TEAMS}_${quizId}`, []);
        const acts = load(`${KEYS.ACTIVITY}_${quizId}`, []);
        return {
            status: qObj.status,
            round: qObj.currentRoundIdx + 1,
            teamCount: teams.length,
            activities: acts.slice(0, 5),
            lastSeen: acts[0]?.time || '—',
        };
    },
    isQuizPaid(quizId) {
        return Boolean(load(`sq_payment_status_${quizId}`, false) === true);
    },
    setQuizPaid(quizId, isPaid) {
        save(`sq_payment_status_${quizId}`, isPaid);
    },
    getMonitoredUsers() {
        const sess = this.getSession();
        const teams = this.getActiveTeams();
        const users = this.getUsers().filter((u) => u.role === 'participant');
        let myTeams = teams;
        let myParts = users;
        if (sess && !sess.isSuper && sess.quizId) {
            myTeams = teams.filter((t) => t.quizId === sess.quizId);
            myParts = users.filter((p) => !p.currentQuizId || p.currentQuizId === sess.quizId);
        }
        return [
            ...myTeams.map((t) => ({ ...t, monitorType: 'TEAM', ident: `T${t.teamNumber}` })),
            ...myParts.map((p) => ({ ...p, monitorType: 'PART', ident: 'P' })),
        ];
    },
};
function getRoundQRange(rounds, idx) {
    let start = 0;
    for (let i = 0; i < idx; i++)
        start += rounds[i]?.questionCount || 0;
    const count = rounds[idx]?.questionCount || 0;
    return { start, end: start + count - 1, count };
}
function getTotalConfiguredQs(rounds) {
    return rounds.reduce((s, r) => s + (r.questionCount || 0), 0);
}
function advanceToNextQuestion(fromGlobalIdx, overrideCycleHalt = false) {
    const quiz = Store.getQuiz();
    const now = Date.now();
    if (fromGlobalIdx !== undefined && quiz.globalQIdx !== fromGlobalIdx)
        return;
    if (quiz._advancing) {
        if (quiz._advancingTime && now - quiz._advancingTime > 10000) {
            console.warn('[QUIZ] Advancement was stuck, forcing reset.');
        }
        else {
            return;
        }
    }
    if (quiz._advancing && now - (quiz._advancingTime || 0) < 1500)
        return;
    try {
        quiz._advancing = true;
        quiz._advancingTime = now;
        Store.saveQuiz(quiz);
        const rounds = Store.getRounds();
        const questions = Store.getQuestions();
        const teams = Store.getActiveTeams();
        const range = getRoundQRange(rounds, quiz.currentRoundIdx);
        if (!teams.length) {
            quiz._advancing = false;
            Store.saveQuiz(quiz);
            return;
        }
        const nextQInRound = quiz.currentQInRound + 1;
        const nextGlobal = quiz.globalQIdx + 1;
        const teamsCount = teams.length;
        if (!overrideCycleHalt && nextQInRound % teamsCount === 0) {
            const questionsRemaining = range.count - nextQInRound;
            if (questionsRemaining > 0 && questionsRemaining < teamsCount) {
                window.dispatchEvent(new CustomEvent('quiz_cycle_warning', { detail: { remaining: questionsRemaining, teamsCount, fromGlobalIdx } }));
            }
        }
        const nextStartTeam = (quiz.questionStartTeamIdx + 1) % teamsCount;
        const r = rounds[quiz.currentRoundIdx];
        if (nextQInRound >= range.count || nextGlobal >= questions.length) {
            Store.saveQuiz({
                ...quiz,
                status: 'round_end',
                _advancing: false,
                _advancingTime: null,
                passChain: [],
                participantTurn: false,
                participantTimerStart: null,
            });
            Store.addActivity(`🏁 Round ${quiz.currentRoundIdx + 1} ended`, 'success');
            return;
        }
        const newQ = {
            ...quiz,
            status: 'running',
            currentQInRound: nextQInRound,
            globalQIdx: nextGlobal,
            questionStartTeamIdx: nextStartTeam,
            currentTeamIdx: nextStartTeam,
            passChain: [],
            participantTurn: false,
            participantTimerStart: null,
            timerStart: Date.now(),
            timerLimit: r?.timePerQuestion || 60,
            _timerEndHandled: false,
            _participantTimerHandled: false,
            _advancing: false,
            _advancingTime: null,
        };
        Store.saveQuiz(newQ);
        Store.addActivity(`➡ Q${nextQInRound + 1} → <strong>${teams[nextStartTeam]?.name || '?'}</strong>`, 'info');
    }
    catch (e) {
        console.error('[QUIZ] Error in advanceToNextQuestion:', e);
        const qErr = Store.getQuiz();
        qErr._advancing = false;
        qErr._advancingTime = null;
        Store.saveQuiz(qErr);
    }
}
function $id(id) {
    return document.getElementById(id);
}
function $qs(sel) {
    return document.querySelector(sel);
}
function $qsa(sel) {
    return Array.from(document.querySelectorAll(sel));
}
// Global Button Ripple Effect
document.addEventListener('click', (e) => {
    const target = e.target?.closest('button, .btn-main, .btn-sm, .dash-quick-btn, .pay-tab-btn, .nav-item');
    if (!target)
        return;
    const rect = target.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height);
    const wave = document.createElement('span');
    wave.className = 'btn-ripple-wave';
    wave.style.width = `${size}px`;
    wave.style.height = `${size}px`;
    wave.style.left = `${e.clientX - rect.left - size / 2}px`;
    wave.style.top = `${e.clientY - rect.top - size / 2}px`;
    target.appendChild(wave);
    setTimeout(() => wave.remove(), 600);
});
function genId() {
    return '_' + Math.random().toString(36).substr(2, 9);
}
function requireRole(role) {
    const s = Store.getSession();
    if (!s) {
        const token = Store.getToken();
        if (token)
            return { role, userId: 'reconnecting' };
        window.location.href = '/';
        return null;
    }
    if (s.role !== role && s.userId !== 'reconnecting') {
        window.location.href = '/';
        return null;
    }
    return s;
}
function requireAnyAuth() {
    const s = Store.getSession();
    if (!s) {
        window.location.href = '/';
        return null;
    }
    return s;
}
function toast(msg, type = 'info', dur = 3200) {
    let c = document.getElementById('toast-container');
    if (!c) {
        c = document.createElement('div');
        c.id = 'toast-container';
        document.body.appendChild(c);
    }
    const icons = { success: '✓', error: '✕', info: 'ℹ', warning: '⚠' };
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.innerHTML = `<span class="toast-icon">${icons[type] || 'ℹ'}</span><span>${msg}</span>`;
    c.appendChild(el);
    setTimeout(() => {
        el.style.opacity = '0';
        el.style.transform = 'translateX(110%)';
        setTimeout(() => el.remove(), 300);
    }, dur);
}
function formatTime(sec) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0)
        return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
function onUpdate(cb) {
    window.addEventListener('storage', (e) => {
        if (!e.key)
            return;
        cb({ key: e.key });
    });
    window.addEventListener('storage_sync', (e) => {
        cb({ key: e.detail.key });
    });
}
const RenderEngine = {
    quizMap(containerId) {
        const q = Store.getQuiz();
        const rounds = Store.getRounds();
        const questions = Store.getQuestions();
        const container = document.getElementById(containerId);
        if (!container)
            return;
        if (q.status === 'idle' || q.status === 'finished') {
            container.innerHTML = '';
            delete container.dataset.state;
            return;
        }
        const curRound = rounds.find((r) => r.num == q.currentRoundIdx + 1) || rounds[0];
        if (!curRound)
            return;
        const roundQs = questions.filter((qs) => qs.roundId == curRound.id).sort((a, b) => a.id - b.id);
        const totalInRound = roundQs.length || curRound.questionCount || 0;
        const newState = `${q.status}|${q.currentRoundIdx}|${q.currentQInRound}|${q.participantTurn}|${totalInRound}`;
        if (container.dataset.state === newState)
            return;
        container.dataset.state = newState;
        let html = `
      <div class="quiz-map-wrap">
        <div class="qm-top">
          <div class="qm-stage-info">
            <span class="badge bg-primary">${(curRound.stage || 'ROUND').toUpperCase()} STAGE</span>
            <span class="text-xs font-title text-muted ms-2">ROUND ${curRound.num}: ${(curRound.name || '').toUpperCase()}</span>
          </div>
          <div class="text-xs text-muted font-title">QUESTION <strong>${q.currentQInRound + 1}</strong> / ${totalInRound}</div>
        </div>
        <div class="qm-track">
    `;
        for (let i = 0; i < totalInRound; i++) {
            let state = 'todo';
            if (i < q.currentQInRound)
                state = 'done';
            else if (i === q.currentQInRound)
                state = q.participantTurn ? 'participant' : 'current';
            html += `<div class="qm-bulb-wrap">
        <div class="qm-bulb ${state}">${i + 1}</div>
        ${i < totalInRound - 1 ? `<div class="qm-line ${i < q.currentQInRound ? 'done' : ''}"></div>` : ''}
      </div>`;
        }
        html += `
        </div>
        <div class="qm-legend">
          <div class="ql-item"><span class="ql-dot" style="background:var(--success)"></span> DONE</div>
          <div class="ql-item"><span class="ql-dot" style="background:var(--warning);box-shadow:0 0 5px var(--warning)"></span> ACTIVE</div>
          <div class="ql-item"><span class="ql-dot" style="background:var(--primary-gradient);box-shadow:0 0 5px var(--primary)"></span> PARTICIPANT TURN</div>
          <div class="ql-item"><span class="ql-dot" style="background:#f1f3f5"></span> UPCOMING</div>
        </div>
      </div>
    `;
        container.innerHTML = html;
    },
};
