// ===== LIVE FEED STAGE (TypeScript) =====

(function () {
  const liveSocket = window.socket;
  let quiz: any = {};
  let teams: any[] = [];
  let rounds: any[] = [];
  let questions: any[] = [];
  let mediaRecorder: MediaRecorder | null = null;
  let audioChunks: BlobPart[] = [];

  function renderAll(): void {
    const s = quiz.status;
    const r = rounds[quiz.currentRoundIdx];

    const stageEl = document.getElementById('live-stage');
    const roundEl = document.getElementById('live-round');
    if (stageEl) stageEl.textContent = r?.stage || 'IDLE';
    if (roundEl) roundEl.textContent = `ROUND ${(quiz.currentRoundIdx || 0) + 1}`;

    const overlay = document.getElementById('msg-overlay');
    if (overlay) {
      if (s === 'idle' || s === 'finished') {
        overlay.style.display = 'flex';
        const ot = document.getElementById('overlay-title');
        const ob = document.getElementById('overlay-body');
        if (ot) ot.textContent = s === 'idle' ? 'GET READY!' : 'QUIZ FINISHED';
        if (ob) ob.textContent = s === 'idle' ? 'The competition will begin shortly.' : 'Tournament complete.';
      } else {
        overlay.style.display = 'none';
      }
    }

    const qArea = document.getElementById('q-area');
    const introArea = document.getElementById('intro-area');
    if (s === 'round_intro') {
      if (qArea) qArea.style.display = 'none';
      if (introArea) introArea.style.display = 'block';
      const it = document.getElementById('intro-title');
      const ib = document.getElementById('intro-body');
      if (it) it.textContent = r?.name || 'ROUND START';
      if (ib) ib.textContent = r?.instructions || '';
    } else {
      if (qArea) qArea.style.display = 'flex';
      if (introArea) introArea.style.display = 'none';
      const q = questions[quiz.globalQIdx];
      if (q) {
        const qt = document.getElementById('q-text');
        const og = document.getElementById('opts-grid');
        if (qt) qt.textContent = q.text;
        if (og) {
          og.innerHTML = q.options
            .map(
              (o: string, i: number) => `
              <div class="opt-big ${quiz.status === 'round_end' && q.correct?.includes(i) ? 'correct' : ''}">
                <span class="opt-letter">${String.fromCharCode(65 + i)}</span>
                <span>${o}</span>
              </div>`
            )
            .join('');
        }
      }
    }

    const activeTeam = s === 'participant_turn' ? { name: '📢 PARTICIPANTS' } : teams[quiz.currentTeamIdx];
    const atEl = document.getElementById('live-active-team');
    if (atEl) atEl.textContent = activeTeam?.name || '—';

    const sorted = [...teams].sort((a, b) => (b.score || 0) - (a.score || 0));
    const scoresEl = document.getElementById('live-scores');
    if (scoresEl) {
      scoresEl.innerHTML = sorted
        .map(
          (t, i) => `
          <div class="sb-row-big">
            <span class="sb-rank-big">${i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `#${i + 1}`}</span>
            <span class="sb-name-big">${t.name}</span>
            <span class="sb-pts-big">${t.score || 0}</span>
          </div>`
        )
        .join('');
    }
  }

  function updateTimer(): void {
    let rem = 0;
    let limit = 60;
    if (quiz.status === 'participant_turn') {
      rem = Math.max(0, (quiz.participantTimeLimit || 30) - Math.floor((Date.now() - (quiz.participantTimerStart || Date.now())) / 1000));
      limit = quiz.participantTimeLimit || 30;
    } else {
      rem = Math.max(0, (quiz.timerLimit || 60) - Math.floor((Date.now() - (quiz.timerStart || Date.now())) / 1000));
      limit = quiz.timerLimit || 60;
    }
    const lt = document.getElementById('live-timer');
    const lf = document.getElementById('live-tfill');
    if (lt) {
      lt.textContent = String(rem);
      lt.style.color = rem <= 5 ? 'var(--red)' : 'var(--gold)';
    }
    if (lf) lf.style.width = `${(rem / limit) * 100}%`;
  }

  function updateCamera(): void {
    const activeTeam = teams[quiz.currentTeamIdx];
    const primaryEl = document.getElementById('live-cam') as HTMLImageElement | null;
    const placeholderEl = document.getElementById('cam-placeholder');

    if (activeTeam && quiz.status !== 'participant_turn') {
      const frame = Store.getCamFrame(activeTeam.id);
      if (frame && primaryEl && placeholderEl) {
        primaryEl.src = frame;
        primaryEl.style.display = 'block';
        placeholderEl.style.display = 'none';
      } else if (primaryEl && placeholderEl) {
        primaryEl.style.display = 'none';
        placeholderEl.style.display = 'flex';
      }
    } else if (primaryEl && placeholderEl) {
      primaryEl.style.display = 'none';
      placeholderEl.style.display = 'flex';
    }

    const gridEl = document.getElementById('cam-grid-live');
    if (gridEl) {
      const allMonitored = Store.getMonitoredUsers();
      gridEl.innerHTML = allMonitored
        .map((u: any) => {
          const frame = Store.getCamFrame(u.id);
          const isActive = u.id === activeTeam?.id;
          return `<div style="aspect-ratio:4/3; background:black; border-radius:4px; overflow:hidden; position:relative; border:1px solid ${isActive ? 'var(--gold)' : 'var(--border)'}">
            ${frame ? `<img src="${frame}" style="width:100%; height:100%; object-fit:cover">` : '<div style="height:100%; display:flex; align-items:center; justify-content:center; font-size:8px; color:#444">OFF</div>'}
            <div style="position:absolute; bottom:2px; left:2px; font-size:6px; background:rgba(0,0,0,0.6); padding:1px 3px; border-radius:2px">${u.ident}</div>
            <div class="cam-btns" style="position:absolute; top:2px; right:2px; display:flex; flex-direction:column; gap:2px">
               <button onclick="liveAction('warn','${u.id}', event)" style="background:#ef4444; border:none; color:white; font-size:6px; padding:2px; border-radius:2px; cursor:pointer" title="Warn">⚠️</button>
               <button onclick="liveAction('msg','${u.id}', event)" style="background:#06b6d4; border:none; color:black; font-size:6px; padding:2px; border-radius:2px; cursor:pointer" title="Message">💬</button>
               ${u.monitorType === 'TEAM' ? `<button onclick="liveAction('hold','${u.id}', event)" style="background:#eab308; border:none; color:black; font-size:6px; padding:2px; border-radius:2px; cursor:pointer" title="Hold">🛑</button>` : ''}
            </div>
          </div>`;
        })
        .join('');
    }
  }

  function updateTargetList(): void {
    const sel = document.getElementById('live-cmd-target') as HTMLSelectElement | null;
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML =
      '<option value="all">ALL TEAMS</option>' +
      teams
        .filter((t) => t.status === 'active')
        .map((t) => `<option value="${t.id}" ${t.id === cur ? 'selected' : ''}>T${t.teamNumber}: ${t.name}</option>`)
        .join('');
  }

  window.startMicBroadcast = async function (): Promise<void> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorder = new MediaRecorder(stream);
      audioChunks = [];
      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunks.push(e.data);
      };
      mediaRecorder.onstop = () => {
        const blob = new Blob(audioChunks, { type: 'audio/webm' });
        const target = (document.getElementById('live-cmd-target') as HTMLSelectElement)?.value || 'all';
        const reader = new FileReader();
        reader.onload = () => liveSocket?.emit('admin_audio', { audio: reader.result, target });
        reader.readAsDataURL(blob);
        stream.getTracks().forEach((t) => t.stop());
      };
      mediaRecorder.start();
      const btn = document.getElementById('btn-live-mic');
      if (btn) {
        btn.style.boxShadow = '0 0 15px var(--red)';
        btn.style.transform = 'scale(1.2)';
      }
    } catch (e: any) {
      alert('Mic error: ' + e.message);
    }
  };

  window.stopMicBroadcast = function (): void {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
      const btn = document.getElementById('btn-live-mic');
      if (btn) {
        btn.style.boxShadow = 'none';
        btn.style.transform = 'scale(1)';
      }
    }
  };

  window.liveAction = function (type: string, teamId: string, event?: Event): void {
    if (event) event.stopPropagation();
    const t = teams.find((x) => x.id === teamId);
    if (!t) return;
    let msg: string | null = '';
    if (type === 'warn') msg = prompt(`Send WARNING to ${t.name}:`, 'Suspicious activity detected! Please focus on the quiz.');
    if (type === 'msg') msg = prompt(`Send MESSAGE to ${t.name}:`);
    if (type === 'hold') {
      const isHeld = !!(quiz.holdStatus && quiz.holdStatus[teamId]);
      liveSocket?.emit('admin_cmd', { type: 'hold', target: teamId, status: !isHeld });
      toast(`${t.name} ${!isHeld ? 'HELD' : 'RELEASED'}`, 'info');
      return;
    }
    if (!msg) return;
    liveSocket?.emit('admin_cmd', { type, target: teamId, msg });
    toast(`${type.toUpperCase()} sent to ${t.name}`, 'info');
  };

  liveSocket?.on('admin_cmd', (data: any) => {
    if (data.type === 'msg' || data.type === 'warn') {
      toast(data.msg || (data.type === 'warn' ? 'Official Warning Sent' : ''), 'warning');
    }
  });

  onUpdate(() => {
    quiz = Store.getQuiz();
    teams = Store.getActiveTeams();
    rounds = Store.getRounds();
    questions = Store.getQuestions();
    renderAll();
    updateTargetList();
  });

  setInterval(() => {
    if (quiz.status === 'running' || quiz.status === 'participant_turn') updateTimer();
    updateCamera();
  }, 1000);
})();
