// ===== CAMERA MONITOR (TypeScript) =====

(function () {
  const camSocket = window.socket;
  let quiz: any = {};
  let teams: any[] = [];
  let participants: any[] = [];
  let camStatus: Record<string, any> = {};
  let alerts: any[] = [];

  function renderAll(): void {
    const grid = document.getElementById('cam-grid');
    if (!grid) return;

    const activeTeam = teams[quiz.currentTeamIdx];
    const searchEl = document.getElementById('mon-search') as HTMLInputElement | null;
    const search = (searchEl?.value || '').toLowerCase();
    const viewModeEl = document.getElementById('mon-view-mode') as HTMLSelectElement | null;
    const viewMode = viewModeEl?.value || 'grid';

    const allMonitored = Store.getMonitoredUsers();
    const myTeams = allMonitored.filter((u: any) => u.monitorType === 'TEAM');
    const myParts = allMonitored.filter((u: any) => u.monitorType === 'PART');

    const streamable = allMonitored.filter((u: any) => {
      if (search && !u.name.toLowerCase().includes(search) && !u.ident.toLowerCase().includes(search)) return false;
      const status = camStatus[u.id];
      return status && Date.now() - status.lastSeen < 120000;
    });

    streamable.sort((a: any, b: any) => {
      const as = camStatus[a.id]?.suspicious ? 1 : 0;
      const bs = camStatus[b.id]?.suspicious ? 1 : 0;
      if (a.id === activeTeam?.id) return -1;
      if (b.id === activeTeam?.id) return 1;
      if (bs !== as) return bs - as;
      return a.name.localeCompare(b.name);
    });

    if (!streamable.length) {
      grid.innerHTML = `<div class="empty" style="grid-column: 1/-1">
        <div style="font-size:40px; margin-bottom:15px">📡</div>
        No active camera feeds detected.<br>
        <span style="font-size:11px; opacity:0.6">Ensure participants are logged in and camera permission is granted.</span>
      </div>`;
    } else {
      grid.style.gridTemplateColumns =
        viewMode === 'focus' ? 'repeat(auto-fill, minmax(300px, 1fr))' : 'repeat(auto-fill, minmax(200px, 1fr))';

      grid.innerHTML = streamable
        .map((u: any) => {
          const frame = Store.getCamFrame(u.id);
          const status = camStatus[u.id] || {};
          const isSusp = status.suspicious || status.tabHidden;
          const isActive = u.monitorType === 'TEAM' && u.id === activeTeam?.id;

          return `
            <div class="cam-card ${isSusp ? 'suspicious' : ''} ${isActive ? 'active-turn' : ''}" style="${isActive ? 'border-color:var(--gold); box-shadow:0 0 20px rgba(255,215,0,0.3)' : ''}">
              ${isActive ? `<div style="position:absolute; top:0; left:50%; transform:translateX(-50%); background:var(--gold); color:black; font-size:7px; font-weight:900; padding:2px 8px; border-radius:0 0 6px 6px; z-index:10">CURRENT TURN</div>` : ''}
              ${frame ? `<img src="${frame}" class="cam-img">` : `<div style="height:100%; display:flex; align-items:center; justify-content:center; color:#333; font-size:10px; background:#111">RECONNECTING...</div>`}
              <div class="cam-overlay"></div>
              <div class="cam-info">
                <div class="cam-name"><span class="badge ${u.monitorType === 'TEAM' ? 'bg-warning text-dark' : 'bg-info text-dark'}" style="margin-right:5px; padding:1px 4px; font-size:8px">${u.ident}</span> ${u.name}</div>
                <div class="cam-status" style="color:${isSusp ? '#ff4d4d' : '#22c55e'}">${status.tabHidden ? 'TAB HIDDEN' : isSusp ? 'SUSPICIOUS' : 'ONLINE'}</div>
              </div>
              <div class="cam-actions">
                <button class="act-btn btn-warn" onclick="monAction('warn','${u.id}','${u.name}')" title="Send Official Warning">⚠</button>
                <button class="act-btn btn-msg" onclick="monAction('msg','${u.id}','${u.name}')" title="Message User">💬</button>
                ${u.monitorType === 'TEAM' ? `<button class="act-btn btn-hold" onclick="monAction('hold','${u.id}','${u.name}')" title="${quiz.holdStatus?.[u.id] ? 'Release Turn' : 'Hold Turn'}">${quiz.holdStatus?.[u.id] ? '▶' : '🛑'}</button>` : ''}
              </div>
            </div>`;
        })
        .join('');
    }

    const stTeams = document.getElementById('stat-teams');
    const stParts = document.getElementById('stat-parts');
    const stSusp = document.getElementById('stat-susp');
    if (stTeams) stTeams.textContent = String(myTeams.length);
    if (stParts) stParts.textContent = String(myParts.length);
    if (stSusp) stSusp.textContent = String(streamable.filter((u: any) => camStatus[u.id]?.suspicious).length);

    renderAlerts();
    renderActivity();
  }

  function renderAlerts(): void {
    const el = document.getElementById('mon-alerts');
    if (!el) return;
    const activeAlerts = alerts.filter((a: any) => !a.dismissed).slice(0, 10).reverse();
    if (!activeAlerts.length) {
      el.innerHTML = '<div class="empty">No active security alerts.</div>';
      return;
    }

    el.innerHTML = activeAlerts
      .map((a: any) => {
        const u = [...teams, ...participants].find((x: any) => x.id === a.teamId);
        return `
          <div class="alert-card">
            <div style="display:flex; justify-content:space-between; align-items:start">
              <span class="badge bg-danger" style="font-size:8px">${(a.type || 'ALERT').toUpperCase()}</span>
              <span class="log-time">${a.time}</span>
            </div>
            <div style="font-weight:700; font-size:12px; margin-top:5px">${u?.name || 'Unknown'}</div>
            <div style="font-size:11px; opacity:0.8; margin-top:3px">${a.msg}</div>
            <div style="margin-top:10px; display:flex; gap:5px">
               <button class="btn btn-danger btn-sm py-0 px-2" style="font-size:10px" onclick="monAction('warn','${a.teamId}','${u?.name || 'User'}')">WARN</button>
               <button class="btn btn-secondary btn-sm py-0 px-2" style="font-size:10px" onclick="dismissAlert('${a.time}')">DISMISS</button>
            </div>
          </div>`;
      })
      .join('');
  }

  function renderActivity(): void {
    const el = document.getElementById('mon-activity');
    if (!el) return;
    const act = Store.getActivity().slice(0, 30);
    if (!act.length) return;
    el.innerHTML = act
      .map(
        (a: any) => `
        <div class="log-row">
          <div class="log-time">${a.time}</div>
          <div style="color:${a.type === 'error' ? '#ff4d4d' : a.type === 'success' ? '#22c55e' : 'white'}">${a.text}</div>
        </div>`
      )
      .join('');
  }

  window.renderAll = renderAll;

  window.switchPane = function (id: string, ev?: Event): void {
    document.querySelectorAll('.stab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.side-pane').forEach((p) => p.classList.remove('active'));
    const target = (ev?.target as HTMLElement) || document.getElementById('stab-' + id);
    target?.classList.add('active');
    document.getElementById('pane-' + id)?.classList.add('active');
  };

  window.monAction = function (type: string, id: string, name: string): void {
    let msg: string | null = '';
    if (type === 'warn') msg = prompt(`Send SECURITY WARNING to ${name}:`, 'Suspicious activity detected! Please keep your attention on the screen.');
    if (type === 'msg') msg = prompt(`Send Message to ${name}:`);
    if (type === 'hold') {
      const isHeld = !!(quiz.holdStatus && quiz.holdStatus[id]);
      camSocket?.emit('admin_cmd', { type: 'hold', target: id, status: !isHeld });
      return;
    }
    if (!msg) return;
    camSocket?.emit('admin_cmd', { type, target: id, msg });
  };

  window.dismissAlert = function (time: string): void {
    const all = Store.getAlerts();
    const updated = all.map((a: any) => (a.time === time ? { ...a, dismissed: true } : a));
    localStorage.setItem('sq_alerts', JSON.stringify(updated));
    renderAll();
  };

  window.monGlobalAction = function (type: string): void {
    if (type === 'pause') {
      const nextStatus = quiz.status === 'paused' ? 'running' : 'paused';
      camSocket?.emit('admin_cmd', { type: 'quiz_status', status: nextStatus });
      toast(`QUIZ ${nextStatus.toUpperCase()}`, 'info');
    }
    if (type === 'alert_all') {
      const msg = prompt('SEND URGENT ALERT TO ALL CONTESTANTS:', 'Attention! Please maintain quiz integrity.');
      if (msg) camSocket?.emit('admin_cmd', { type: 'msg', target: 'all', msg });
    }
  };

  onUpdate(() => {
    quiz = Store.getQuiz();
    teams = Store.getActiveTeams();
    participants = Store.getParticipants();
    camStatus = Store.getCamStatus();
    alerts = Store.getAlerts();

    const sess = Store.getSession();
    const qBadge = document.getElementById('quiz-id-badge');
    if (sess?.quizId && qBadge) qBadge.textContent = `QUIZ: ${sess.quizId}`;
    const syncEl = document.getElementById('mon-sync-status');
    if (syncEl) syncEl.textContent = `SYNCED: ${new Date().toLocaleTimeString()}`;

    renderAll();
  });

  setInterval(renderAll, 3000);
})();
