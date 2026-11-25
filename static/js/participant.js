"use strict";
// ===== PARTICIPANT / VIEWER PAGE =====
const session = requireAnyAuth();
const isParticipant = session.role === 'participant';
const userId = session.userId;
let pSel = [], pAnswered = false, lastGQ = -1, timerIv = null;
let camStream = null, camCapIv = null;
function init() {
    $id('ph-name').textContent = session.name || 'Viewer';
    $id('ph-role-badge').innerHTML = isParticipant
        ? '<span class="badge badge-green">PARTICIPANT</span>'
        : '<span class="badge badge-gray">VIEWER</span>';
    // Support Enter key in Join Modal
    const joinInput = $id('jm-quizid');
    if (joinInput) {
        joinInput.addEventListener('keyup', (e) => {
            if (e.key === 'Enter')
                joinAsContestantFromModal();
        });
    }
    const managed = Store.getManagedQuizzes();
    const quizInfo = managed.find(x => x.quizId === session.quizId);
    const btnConduct = $id('btn-header-conduct');
    const btnJoin = $id('btn-header-join');
    const adminContext = $id('ph-admin-context');
    if (quizInfo) {
        if (adminContext)
            adminContext.style.display = 'block';
        if ($id('ph-college-name'))
            $id('ph-college-name').textContent = quizInfo.collegeName;
        if ($id('ph-college-code'))
            $id('ph-college-code').textContent = quizInfo.collegeCode;
        // Find admin name
        const admins = Store.getUsers().filter(u => u.role === 'admin');
        const adminUser = admins.find(a => a.id === quizInfo.adminId);
        if ($id('ph-admin-name'))
            $id('ph-admin-name').textContent = adminUser ? adminUser.name : 'Admin';
        // Hide buttons once joined with ID
        if (btnConduct)
            btnConduct.style.display = 'none';
        if (btnJoin)
            btnJoin.style.display = 'none';
    }
    if (isParticipant) {
        $id('ph-score-chip').style.display = 'flex';
        if ($id('ph-join-card'))
            $id('ph-join-card').style.display = 'none';
        if ($id('ph-join-cta'))
            $id('ph-join-cta').style.display = 'none';
        if (btnJoin)
            btnJoin.style.display = 'none';
        if (btnConduct)
            btnConduct.style.display = 'none';
        initCam(); // Start proctoring if possible, but don't block
        showMain();
        render();
    }
    else {
        const sess = Store.getSession();
        if (sess?.captchaVerified) {
            showMain();
            render();
            if (quizInfo) {
                // If already joined with a quiz ID, don't show the join CTA
                if ($id('ph-join-cta'))
                    $id('ph-join-cta').style.display = 'none';
            }
            else {
                if ($id('ph-join-cta'))
                    $id('ph-join-cta').classList.remove('hidden');
            }
        }
        else
            $id('ph-captcha-gate').classList.remove('hidden');
    }
    setInterval(() => {
        const q = Store.getQuiz();
        const el = $id('ph-comp-clock');
        if (el && q.competitionStart)
            el.textContent = formatTime(Math.floor((Date.now() - q.competitionStart) / 1000));
    }, 1000);
    onUpdate(render);
    setInterval(render, 1000);
}
function verifyCaptcha() {
    const input = $id('ph-captcha-input').value.trim().toUpperCase();
    const err = $id('ph-captcha-err');
    const settings = Store.getSettings();
    if (!input) {
        err.textContent = 'Enter the code.';
        return;
    }
    if (input !== settings.captchaCode.toUpperCase()) {
        err.textContent = 'Invalid captcha. Ask admin.';
        return;
    }
    const updatedSession = { ...Store.getSession(), captchaVerified: true };
    Store.setSession(updatedSession);
    Store.addActivity(`Viewer <strong>${session.name}</strong> joined`, 'info');
    $id('ph-captcha-gate').classList.add('hidden');
    showMain();
    render();
}
async function initCam() {
    if (!isParticipant)
        return;
    try {
        const camStreamObj = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240, facingMode: 'user' } });
        camStream = camStreamObj;
        const vid = $id('ph-cam-video');
        if (vid) {
            vid.srcObject = camStream;
            vid.play();
        }
        camCapIv = setInterval(captureFrame, 10000); // Snapshot every 10s
        Store.addActivity(`Camera (Proctoring) started for <strong>${session.name}</strong>`, `success`);
    }
    catch (e) {
        console.error('Cam init fail:', e);
        toast('CAMERA DISCONNECTED / PERMISSION LOST', 'error', 10000);
        const ind = $id('ph-cam-indicator');
        if (ind) {
            ind.textContent = 'OFFLINE';
            ind.style.background = 'var(--red)';
        }
    }
}
function captureFrame() {
    if (!camStream)
        return;
    const vid = $id('ph-cam-video');
    const canvas = $id('ph-cam-canvas');
    if (!vid || !canvas)
        return;
    canvas.width = 160;
    canvas.height = 120;
    canvas.getContext('2d').drawImage(vid, 0, 0, 160, 120);
    const data = canvas.toDataURL('image/jpeg', 0.5);
    Store.saveCamFrame(userId, data);
    Store.updateCamStatus(userId, { tabHidden: document.hidden, lastSeen: Date.now(), suspicious: document.hidden });
}
function showMain() {
    const m = $id('ph-main');
    if (m) {
        m.classList.remove('hidden');
        m.style.display = 'flex';
    }
}
function render() {
    const quiz = Store.getQuiz(), questions = Store.getQuestions(), rounds = Store.getRounds();
    const canAnswer = isParticipant;
    if (isParticipant) {
        const p = Store.getParticipantById(userId);
        $id('ph-score').textContent = p?.correctCount || 0;
        checkTeamAllocation();
    }
    const ri = $id('ph-round-info');
    if (ri && quiz.status !== 'idle' && rounds[quiz.currentRoundIdx]) {
        const stg = rounds[quiz.currentRoundIdx].stage || 'Preliminary';
        ri.innerHTML = `<span style="opacity:0.6;font-size:9px">${stg.toUpperCase()}</span> ${rounds[quiz.currentRoundIdx].name}`;
    }
    else if (ri)
        ri.textContent = '';
    // Always render scoreboard
    renderScoreboard();
    RenderEngine.quizMap('quiz-map-container');
    if (quiz.status === 'idle') {
        showPState('waiting');
        const settings = Store.getSettings();
        const welcomeEl = $id('ph-welcome-msg');
        const prizesEl = $id('ph-prizes-box');
        // Dynamic Welcome Message
        if (welcomeEl)
            welcomeEl.innerHTML = `WELCOME, <strong>${(session.name || 'VIEWER').toUpperCase()}</strong>! 👋`;
        // Prizes
        if (prizesEl && settings.prizes && settings.prizes.length > 0) {
            prizesEl.innerHTML = `<div class="prize-title">🎁 COMPETITION PRIZES</div>` +
                settings.prizes.map((p, i) => `<div class="prize-item">${p}</div>`).join('');
            prizesEl.classList.remove('hidden');
        }
        if (settings.globalInstructions) {
            const instrEl = $id('ph-general-instr');
            if (instrEl) {
                instrEl.textContent = settings.globalInstructions;
                instrEl.classList.remove('hidden');
            }
        }
        return;
    }
    if (quiz.status === 'round_intro') {
        showPState('round-intro');
        renderRoundIntro(quiz, rounds);
        return;
    }
    if (quiz.status === 'round_end') {
        showPState('round-end');
        renderRoundEnd(quiz, rounds);
        return;
    }
    if (quiz.status === 'finished') {
        showPState('finished');
        renderFinal();
        return;
    }
    const q = questions[quiz.globalQIdx];
    if (!q) {
        showPState('watch');
        return;
    }
    if (quiz.globalQIdx !== lastGQ) {
        lastGQ = quiz.globalQIdx;
        pSel = [];
        pAnswered = false;
        const rev = $id('ph-ans-reveal');
        if (rev)
            rev.className = 'answer-reveal';
        const sub = $id('ph-btn-submit');
        if (sub) {
            sub.style.display = 'inline-flex';
            sub.disabled = true;
        }
    }
    // PARTICIPANT TURN — show answer section with live timer
    if (quiz.status === 'participant_turn') {
        if (canAnswer) {
            showPState('answer');
            renderAnswerPhase(quiz, q, rounds);
        }
        else {
            showPState('watch');
            renderWatchPhase(quiz, q, rounds, '📢 PARTICIPANT TURN');
        }
        tickParticipantTimer(quiz);
        return;
    }
    // Regular team turn — watch
    showPState('watch');
    renderWatchPhase(quiz, q, rounds, null);
    tickTeamTimer(quiz);
}
function showPState(name) {
    ['waiting', 'round-intro', 'watch', 'answer', 'round-end', 'finished'].forEach(s => {
        const el = $id('ps-' + s);
        if (el)
            el.classList.add('hidden');
    });
    const el = $id('ps-' + name);
    if (el)
        el.classList.remove('hidden');
}
function renderRoundIntro(quiz, rounds) {
    const r = rounds[quiz.currentRoundIdx];
    const stage = r?.stage || 'Preliminary';
    const el1 = $id('ph-ri-name'), el2 = $id('ph-ri-instr');
    if (el1)
        el1.innerHTML = `<span style="font-size:11px;background:rgba(255,215,0,0.2);color:var(--gold);padding:3px 10px;border-radius:4px;margin-bottom:8px;display:inline-block">${stage.toUpperCase()} STAGE</span><br>${(r?.name || `ROUND ${quiz.currentRoundIdx + 1}`).toUpperCase()}`;
    if (el2)
        el2.textContent = r?.instructions || 'No instructions.';
}
function renderWatchPhase(quiz, q, rounds, overrideLabel) {
    const teams = Store.getActiveTeams(), range = getRoundQRange(rounds, quiz.currentRoundIdx);
    const el1 = $id('ph-q-label'), el2 = $id('ph-q-text'), el3 = $id('ph-q-type');
    if (el1)
        el1.textContent = `Q${quiz.currentQInRound + 1} OF ${range.count}`;
    if (el2)
        el2.textContent = q.text;
    if (el3)
        el3.textContent = q.type === 'multiple' ? 'MULTI-ANSWER' : 'SINGLE ANSWER';
    const tb = $id('ph-team-badge');
    if (tb) {
        if (overrideLabel || quiz.currentTeamIdx === -1 || quiz.status === 'participant_turn') {
            tb.textContent = overrideLabel || '📢 PARTICIPANT TURN';
            tb.className = 'badge badge-purple';
        }
        else {
            const cur = teams[quiz.currentTeamIdx];
            tb.textContent = `${cur?.name || 'Team'}'s Turn`;
            tb.className = 'badge badge-gold';
        }
    }
    const passEl = $id('ph-pass-chain');
    if (passEl && quiz.passChain?.length) {
        passEl.innerHTML = `<div class="pass-chain">${teams.map((t, i) => `<span class="pchip ${quiz.passChain.includes(t.id) ? 'pchip-passed' : teams[quiz.currentTeamIdx]?.id === t.id ? 'pchip-cur' : ''}">${t.name}</span>${i < teams.length - 1 ? '<span class="parr">→</span>' : ''}`).join('')}</div>`;
    }
    else if (passEl)
        passEl.innerHTML = '';
    // Participant timer visible in watch mode during participant turn
    const ptPanel = $id('ph-pt-panel');
    if (ptPanel) {
        if (quiz.status === 'participant_turn' && quiz.participantTimerStart) {
            ptPanel.style.display = 'block';
            const rem = Math.max(0, quiz.participantTimeLimit - Math.floor((Date.now() - quiz.participantTimerStart) / 1000));
            const pct = (rem / quiz.participantTimeLimit) * 100;
            const te = $id('ph-pt-timer'), be = $id('ph-pt-bar');
            if (te) {
                te.textContent = rem;
                te.className = 'timer-num' + (rem <= 5 ? ' danger' : rem <= 10 ? ' warn' : '');
            }
            if (be) {
                be.style.width = pct + '%';
                be.className = 'tbar' + (rem <= 5 ? ' tbar-danger' : rem <= 10 ? ' tbar-warn' : '');
            }
        }
        else {
            ptPanel.style.display = 'none';
        }
    }
}
function renderAnswerPhase(quiz, q, rounds) {
    const range = getRoundQRange(rounds, quiz.currentRoundIdx);
    const el1 = $id('ph-ans-qlabel'), el2 = $id('ph-ans-text'), el3 = $id('ph-ans-multi');
    if (el1)
        el1.textContent = `Q${quiz.currentQInRound + 1} OF ${range.count}`;
    if (el2)
        el2.textContent = q.text;
    if (el3)
        el3.classList.toggle('hidden', q.type !== 'multiple');
    // Participant timer
    if (quiz.participantTimerStart) {
        const rem = Math.max(0, quiz.participantTimeLimit - Math.floor((Date.now() - quiz.participantTimerStart) / 1000));
        const pct = (rem / quiz.participantTimeLimit) * 100;
        const te = $id('ph-ans-timer'), be = $id('ph-ans-tbar');
        if (te) {
            te.textContent = rem;
            te.className = 'timer-num' + (rem <= 5 ? ' danger' : rem <= 10 ? ' warn' : '');
        }
        if (be) {
            be.style.width = pct + '%';
            be.className = 'tbar' + (rem <= 5 ? ' tbar-danger' : rem <= 10 ? ' tbar-warn' : '');
        }
    }
    if (!pAnswered) {
        const optsEl = $id('ph-ans-opts');
        if (optsEl)
            optsEl.innerHTML = q.options.map((o, i) => `
      <button class="opt-btn ${pSel.includes(i) ? 'opt-sel' : ''}" onclick="selectPOpt(${i})">
        <span class="opt-lbl">${String.fromCharCode(65 + i)}</span>${o}
      </button>`).join('');
    }
    const sub = $id('ph-btn-submit');
    if (sub)
        sub.disabled = !pSel.length || pAnswered;
}
function tickParticipantTimer(quiz) {
    clearInterval(timerIv);
    timerIv = setInterval(() => {
        const q2 = Store.getQuiz();
        if (q2.status !== 'participant_turn') {
            clearInterval(timerIv);
            render();
            return;
        }
        renderAnswerPhase(q2, Store.getQuestions()[q2.globalQIdx] || { options: [], correct: [] }, Store.getRounds());
        const rem = q2.participantTimerStart ? Math.max(0, q2.participantTimeLimit - Math.floor((Date.now() - q2.participantTimerStart) / 1000)) : 0;
        if (rem <= 0 && !q2._participantTimerHandled) {
            Store.addActivity('⏰ Participant time up → next question', 'warning');
            advanceToNextQuestion(q2.globalQIdx);
        }
    }, 500);
}
function tickTeamTimer(quiz) {
    clearInterval(timerIv);
    function tick() {
        const q2 = Store.getQuiz();
        const el = $id('ph-timer'), bar = $id('ph-tbar');
        if (!el || !bar)
            return;
        if (q2.status !== 'running') {
            el.textContent = q2.timerLimit || '—';
            el.className = 'timer-num';
            bar.style.width = '100%';
            bar.className = 'tbar';
            return;
        }
        const elapsed = q2.timerStart ? Math.floor((Date.now() - q2.timerStart) / 1000) : 0;
        const limit = q2.timerLimit || 60, rem = Math.max(0, limit - elapsed), pct = (rem / limit) * 100;
        el.textContent = rem;
        const c = rem <= 10 ? 'danger' : rem <= 20 ? 'warn' : '';
        el.className = 'timer-num' + (c ? ' ' + c : '');
        bar.style.width = pct + '%';
        bar.className = 'tbar' + (c ? ' tbar-' + c : '');
    }
    tick();
    timerIv = setInterval(tick, 500);
}
function selectPOpt(i) {
    if (pAnswered)
        return;
    const quiz = Store.getQuiz(), q = Store.getQuestions()[quiz.globalQIdx];
    if (!q || quiz.status !== 'participant_turn')
        return;
    pSel = q.type === 'single' ? [i] : pSel.includes(i) ? pSel.filter(x => x !== i) : [...pSel, i];
    $qsa('#ph-ans-opts .opt-btn').forEach((b, idx) => b.classList.toggle('opt-sel', pSel.includes(idx)));
    const sub = $id('ph-btn-submit');
    if (sub)
        sub.disabled = !pSel.length;
}
function submitParticipant() {
    const quiz = Store.getQuiz(), q = Store.getQuestions()[quiz.globalQIdx];
    if (!q || pAnswered || !pSel.length || quiz.status !== 'participant_turn')
        return;
    pAnswered = true;
    const ok = JSON.stringify([...pSel].sort()) === JSON.stringify([...q.correct].sort());
    // Save answer
    const p = Store.getParticipantById(userId) || { score: 0, correctCount: 0, answers: {} };
    const answers = { ...(p.answers || {}) };
    answers[quiz.globalQIdx] = pSel;
    Store.upsertParticipant(userId, session.name, { answers, score: (p.score || 0) + (ok ? 5 : 0), correctCount: (p.correctCount || 0) + (ok ? 1 : 0), roll: session.roll });
    Store.addActivity(`[P] <strong>${session.name}</strong> Q${quiz.currentQInRound + 1}: ${ok ? '✓ CORRECT' : '✗ WRONG'}`, ok ? 'success' : 'error');
    const rev = $id('ph-ans-reveal');
    if (rev) {
        rev.className = 'answer-reveal show';
        rev.innerHTML = `<div style="color:${ok ? 'var(--green)' : 'var(--red)'}">${ok ? '✓ Correct! Well done!' : '✗ Wrong Answer'}</div><div class="text-sm text-muted mt-1">Correct: ${q.correct.map(c => String.fromCharCode(65 + c) + '. ' + q.options[c]).join(', ')}</div>${q.explanation ? `<div class="text-sm text-muted mt-1">${q.explanation}</div>` : ''}`;
    }
    $qsa('#ph-ans-opts .opt-btn').forEach((b, idx) => { b.disabled = true; if (q.correct.includes(idx))
        b.classList.add('opt-ok');
    else if (pSel.includes(idx))
        b.classList.add('opt-bad'); });
    const sub = $id('ph-btn-submit');
    if (sub)
        sub.style.display = 'none';
    toast(ok ? '✓ Correct!' : '✗ Wrong', ok ? 'success' : 'error');
    // If correct → advance quiz immediately from participant side
    if (ok) {
        const qid = quiz.globalQIdx;
        setTimeout(() => advanceToNextQuestion(qid), 1800);
    }
}
function renderRoundEnd(quiz, rounds) {
    const r = rounds[quiz.currentRoundIdx];
    const el1 = $id('ph-re-name');
    if (el1)
        el1.textContent = `${r?.name || `ROUND ${quiz.currentRoundIdx + 1}`} COMPLETE!`;
    const teams = Store.getActiveTeams().sort((a, b) => (b.score || 0) - (a.score || 0));
    const el2 = $id('ph-re-scores');
    if (el2)
        el2.innerHTML = teams.map((t, i) => `<div class="sb-row"><span class="sb-rank r${i + 1}">${i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `#${i + 1}`}</span><span class="sb-name">T${t.teamNumber}: ${t.name}<small class="text-muted"> ${t.correctCount || 0}✓</small></span><span class="sb-pts">${t.score || 0}</span></div>`).join('');
}
function renderFinal() {
    const teams = Store.getActiveTeams().sort((a, b) => (b.score || 0) - (a.score || 0));
    const el = $id('ph-final-scores');
    if (el)
        el.innerHTML = teams.map((t, i) => `<div class="sb-row"><span class="sb-rank r${i + 1}">${i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `#${i + 1}`}</span><span class="sb-name">T${t.teamNumber}: ${t.name}<small class="text-muted"> ${t.correctCount || 0}✓</small></span><span class="sb-pts">${t.score || 0}</span></div>`).join('');
}
function renderScoreboard() {
    const teams = Store.getActiveTeams().sort((a, b) => (b.score || 0) - (a.score || 0));
    const el = $id('ph-scoreboard');
    if (!el)
        return;
    el.innerHTML = `<div class="sb-list">${teams.map((t, i) => `<div class="sb-row"><span class="sb-rank r${i + 1}">${i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `#${i + 1}`}</span><span class="sb-name">T${t.teamNumber}: ${t.name}</span><span class="sb-pts">${t.score || 0}</span></div>`).join('')}</div>`;
}
function doLogout() {
    if (session.rid)
        Store.updateLogout(session.rid);
    if (camCapIv)
        clearInterval(camCapIv);
    if (camStream)
        camStream.getTracks().forEach(t => t.stop());
    Store.clearSession();
    window.location.href = '../index.html';
}
function submitFeedback() {
    const text = $id('ph-f-text')?.value.trim();
    if (!text)
        return;
    Store.addFeedback(session.name, text);
    $id('ph-f-text').value = '';
    $id('ph-f-msg').classList.remove('hidden');
    setTimeout(() => $id('ph-f-msg').classList.add('hidden'), 5000);
}
function checkTeamAllocation() {
    const teams = Store.getTeams();
    const myTeam = teams.find(t => t.memberIds.includes(userId));
    const el = $id('ph-team-info');
    const msg = $id('ph-team-msg');
    const ldr = $id('ph-team-leader-msg');
    if (myTeam) {
        if (el && msg) {
            el.classList.remove('hidden');
            el.style.border = '2px solid var(--gold)';
            el.style.background = 'rgba(255,215,0,0.05)';
            msg.innerHTML = `<div class="font-title text-gold" style="font-size:16px;margin-bottom:5px">📢 YOU ARE IN A TEAM!</div>You have been allotted to <strong>${myTeam.name}</strong> (Team No: ${myTeam.teamNumber})`;
            if (ldr) {
                const leader = Store.getUsers().find(u => u.id === myTeam.leaderId);
                ldr.innerHTML = `<div class="mt-2 pt-2 border-t" style="border-color:rgba(255,215,0,0.2)">
          <span class="badge badge-gold" style="font-size:10px">${myTeam.leaderId === userId ? '⭐ YOU ARE THE LEADER' : `Leader: ${leader ? leader.name : 'System Assigned'}`}</span>
          <button class="btn-sm btn-gold ml-2" onclick="window.location.href='/team/${encodeURIComponent(myTeam.name)}'" style="font-size:9px;padding:3px 10px">GO TO TEAM PAGE</button>
        </div>`;
            }
        }
    }
    else if (el) {
        el.classList.add('hidden');
    }
}
// CONDUCT QUIZ & ALIGN
function openModal(id) { $id(id).classList.add('open'); }
function closeModal(id) { $id(id).classList.remove('open'); }
function joinAsContestantFromModal() {
    const input = $id('jm-quizid');
    const quizId = input.value.trim().toUpperCase();
    const err = $id('jm-err');
    if (err)
        err.textContent = '';
    if (!quizId) {
        toast('Enter a Quiz ID', 'warning');
        return;
    }
    const managed = Store.getManagedQuizzes();
    console.log('[JOIN] Checking Quiz ID:', quizId, 'Available:', managed.length);
    const q = managed.find(x => x.quizId === quizId);
    if (!q) {
        const msg = 'Invalid Quiz ID. Please double-check with your admin.';
        if (err)
            err.textContent = msg;
        toast(msg, 'error');
        return;
    }
    if (q.status !== 'active') {
        const msg = 'This quiz session is currently inactive.';
        if (err)
            err.textContent = msg;
        toast(msg, 'warning');
        return;
    }
    // Update both the underlying user record (for admin visibility) and the local session
    Store.updateUser(userId, { role: 'participant', currentQuizId: quizId });
    const s = Store.getSession();
    if (s) {
        s.role = 'participant';
        s.quizId = quizId;
        Store.setSession(s);
    }
    toast(`SUCCESS! Joining ${q.collegeName}...`, 'success');
    closeModal('modal-join');
    // Visual feedback before reload
    const btn = $qs('#modal-join .btn-cyan');
    if (btn) {
        btn.textContent = 'JOINING...';
        btn.disabled = true;
    }
    setTimeout(() => {
        window.location.reload();
    }, 1200);
}
function submitQuizRequest() {
    const username = $id('cm-user').value.trim();
    const password = $id('cm-pass').value.trim();
    const collegeName = $id('cm-college').value.trim();
    const collegeCode = $id('cm-code').value.trim();
    const err = $id('cm-err');
    const suc = $id('cm-suc');
    err.textContent = '';
    suc.classList.add('hidden');
    if (!username || !password || !collegeName || !collegeCode) {
        err.textContent = 'All fields are required.';
        return;
    }
    Store.addQuizRequest({ username, password, collegeName, collegeCode });
    Store.addActivity(`New quiz conduct request from <strong>${collegeName}</strong>`, 'info');
    suc.classList.remove('hidden');
    setTimeout(() => {
        closeModal('modal-conduct');
        ['cm-user', 'cm-pass', 'cm-college', 'cm-code'].forEach(id => $id(id).value = '');
        suc.classList.add('hidden');
    }, 3000);
}
function joinAsContestant() {
    openModal('modal-join');
}
function alignToQuiz() {
    openModal('modal-join');
}
function scrollToJoin() {
    const el = $id('ph-align-id');
    if (el) {
        el.focus();
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.style.border = '2px solid var(--primary)';
        setTimeout(() => el.style.border = '', 2000);
    }
}
init();
