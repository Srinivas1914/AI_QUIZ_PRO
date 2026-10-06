// ===== SUPER ADMIN JS =====
(function initAuth() {
  const sess = Store.getSession();
  if(!sess) {
    const token = Store.getToken();
    if (!token) { window.location.href = '/index.html'; return; }
  } else if (!sess.isSuper) {
    window.location.href = sess.role === 'admin' ? '/admin' : '/index.html';
    return;
  }
})();

let aiQuestions = []; // Ensure global exists


let currentSec = 'dashboard';
let adminTimerIv = null;
let pendingImport = [];
let camRefreshIv = null;

// ─── NAV ──────────────────────────────────────────────────────
function goSection(id){
  document.querySelectorAll('.sec').forEach(s=>s.classList.add('hidden'));
  document.getElementById('sec-'+id)?.classList.remove('hidden');
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.toggle('active',n.dataset.sec===id));
  currentSec=id;
  renderSec(id);
  if(id==='camera'){ startCamRefresh(); } else { stopCamRefresh(); }
}
function openCameraMonitor(){ window.open('/camera-monitor.html', '_blank', 'width=1200,height=800'); }
function renderSec(id){
  if(id==='dashboard')  renderDashboard();
  if(id==='users')      renderUsers();
  if(id==='teams')      renderTeams();
  if(id==='rounds')     renderRounds();
  if(id==='questions')  renderQuestions();
  if(id==='control')    { renderControl(); renderCommandTargets(); }
  if(id==='camera')     renderCamera();

  if(id==='activity')   renderActivity();
  if(id==='settings')   loadSettings();
  if(id==='quiz-requests') renderRequests();
  if(id==='managed-admins') renderManaged();
  if(id==='admin-perf')     renderAdminPerf();
  if(id==='reports')        renderReports();
  if(id==='payments')       loadPayments();
}


// ─── CLOCK ────────────────────────────────────────────────────
setInterval(()=>{ const el=document.getElementById('sb-clock'); if(el) el.textContent=new Date().toLocaleTimeString('en-IN'); },1000);

// ─── DASHBOARD ────────────────────────────────────────────────
function renderDashboard(){
  try {
    const users=Store.getUsers(), teams=Store.getTeams(), aTeams=Store.getActiveTeams(),
          questions=Store.getQuestions(), rounds=Store.getRounds(), quiz=Store.getQuiz(),
          loginStatus=Store.getLoginStatus();

    const kpiEl = document.getElementById('kpi-row');
    if(kpiEl) {
      kpiEl.innerHTML=`
        <div class="kpi cyan clickable" onclick="goSection('users')">
          <span class="kpi-click-hint">↗ click</span>
          <div class="kpi-val">${users.length}</div>
          <div class="kpi-lbl">USERS</div>
        </div>
        <div class="kpi green clickable" onclick="goSection('users')">
          <span class="kpi-click-hint">↗ click</span>
          <div class="kpi-val">${users.filter(u=>u.role==='participant').length}</div>
          <div class="kpi-lbl">PARTICIPANTS</div>
        </div>
        <div class="kpi gold clickable" onclick="goSection('teams')">
          <span class="kpi-click-hint">↗ click</span>
          <div class="kpi-val">${aTeams.length}</div>
          <div class="kpi-lbl">ACTIVE TEAMS</div>
        </div>
        <div class="kpi purple clickable" onclick="goSection('rounds')">
          <span class="kpi-click-hint">↗ click</span>
          <div class="kpi-val">${rounds.length}</div>
          <div class="kpi-lbl">ROUNDS</div>
        </div>
        <div class="kpi red clickable" onclick="goSection('questions')">
          <span class="kpi-click-hint">↗ click</span>
          <div class="kpi-val">${questions.length}</div>
          <div class="kpi-lbl">QUESTIONS</div>
        </div>`;
    }

    // Quiz status
    const badgeEl = document.getElementById('d-status-badge');
    if(badgeEl) {
      const sColor={idle:'gray',round_intro:'cyan',running:'green',paused:'gold',participant_turn:'purple',round_end:'purple',finished:'cyan'};
      const sLabel={idle:'IDLE',round_intro:`R${quiz.currentRoundIdx+1} INTRO`,running:`R${quiz.currentRoundIdx+1} RUNNING`,paused:'PAUSED',participant_turn:'PARTICIPANTS ANSWERING',round_end:`R${quiz.currentRoundIdx+1} ENDED`,finished:'FINISHED'};
      badgeEl.innerHTML=`<span class="badge badge-${sColor[quiz.status]||'gray'}">${sLabel[quiz.status]||quiz.status.toUpperCase()}</span>`;
    }

    const infoEl = document.getElementById('d-quiz-info');
    if(infoEl) {
      const curQ=Store.getQuestions()[quiz.globalQIdx];
      infoEl.innerHTML=[
        ['Rounds', rounds.length],
        ['Questions', `${questions.length} / ${getTotalConfiguredQs(rounds)} slots`],
        ['Current Round', quiz.status==='idle'?'—':`Round ${quiz.currentRoundIdx+1}: ${rounds[quiz.currentRoundIdx]?.name||''}`],
        ['Current Q', quiz.status==='running'||quiz.status==='participant_turn'?`Q${quiz.currentQInRound+1}: ${(curQ?.text||'').slice(0,60)+'…'}`:'—'],
        ['Active Teams', aTeams.length],
      ].map(([k,v])=>`<div class="info-row"><span class="text-muted">${k}</span><span>${v}</span></div>`).join('');
    }

    // Team login status board
    const loginBoardEl=document.getElementById('d-login-status');
    if(loginBoardEl){
      loginBoardEl.innerHTML=aTeams.length?aTeams.map(t=>{
        const s=loginStatus[t.id]||{};
        return `<div class="login-chip ${s.loggedIn?'chip-on':'chip-off'}">
          <span class="chip-dot"></span>
          <span class="chip-name">T${t.teamNumber||'?'}: ${t.name}</span>
          <span class="chip-status">${s.loggedIn?'ONLINE':'OFFLINE'}</span>
        </div>`;
      }).join(''):'<span class="text-muted text-sm">No active teams</span>';
    }

    renderScoreboard('d-scores');
    renderTeamActivityGrid();
    renderRecentActivity();
    renderFeedback();
    renderSpeedWinners();
    renderLoginRecords();
    renderAlertsBadge();
  } catch (e) {
    console.error("[DASHBOARD] Render error:", e);
  }
}

function renderTeamActivityGrid(){
  const teams=Store.getActiveTeams(), questions=Store.getQuestions(), el=document.getElementById('d-team-activity');
  if(!el) return;
  if(!teams.length){ el.innerHTML='<div class="text-muted text-sm p-12">No active teams.</div>'; return; }
  el.innerHTML=teams.map(t=>{
    const answers=t.answers||{};
    let correct=0, wrong=0;
    const rows=Object.entries(answers).map(([qi,ans])=>{
      const q=questions[parseInt(qi)]; if(!q) return '';
      const isC=Array.isArray(ans)?JSON.stringify([...ans].sort())===JSON.stringify([...q.correct].sort()):q.correct.includes(ans);
      if(isC) correct++; else wrong++;
      return `<div class="ta-row ${isC?'ta-ok':'ta-bad'}"><span class="ta-qnum">Q${parseInt(qi)+1}</span><span>${Array.isArray(ans)?ans.map(a=>String.fromCharCode(65+a)).join(','):String.fromCharCode(65+ans)}</span><span>${isC?'✓':'✗'}</span></div>`;
    }).join('');
    const ls=Store.getLoginStatus()[t.id]||{};
    return `<div class="ta-card">
      <div class="ta-head"><strong>T${t.teamNumber||'?'}: ${t.name}</strong><div style="display:flex;gap:6px;align-items:center"><span class="badge badge-green">${t.score||0}pts</span><span class="login-dot ${ls.loggedIn?'dot-on':'dot-off'}"></span></div></div>
      <div class="ta-stats"><span class="text-green">✓${correct}</span><span class="text-red">✗${wrong}</span><span class="text-muted">↩${(t.passedQs||[]).length}</span></div>
      <div class="ta-rows">${rows||'<span class="text-muted text-xs">No answers yet</span>'}</div>
    </div>`;
  }).join('');
}

function renderRecentActivity(){
  const el=document.getElementById('d-activity');
  const list=Store.getActivity();
  if(!el) return;
  el.innerHTML=list.length?list.slice(0, 15).map(a=>`<div class="act-row"><div class="act-dot" style="background:${a.type==='error'?'var(--red)':a.type==='success'?'var(--green)':'var(--cyan)'}"></div><div class="act-time">${a.time}</div><div class="act-text">${a.text}</div></div>`).join(''):'<div class="empty-state">No recent activity</div>';
}

function renderFeedback(){
  const el = document.getElementById('d-feedback'), list = Store.getFeedback();
  if(!el) return;
  el.innerHTML = list.length ? list.map(f => `
    <div class="alert-row">
      <div style="flex:1">
        <div class="font-title text-xs text-gold">${f.name.toUpperCase()}</div>
        <div class="text-sm mt-1">${f.text}</div>
        <div class="text-xs text-muted mt-1">${f.time}</div>
      </div>
    </div>`).join('') : '<div class="empty-state">No feedback yet</div>';
}

function renderSpeedWinners(){
  const el = document.getElementById('d-speed-winners');
  if(!el) return;
  const quiz = Store.getQuiz(), ps = Store.getParticipants();
  const qIdx = quiz.globalQIdx;
  
  // Sort by answer time for the current question
  const list = ps.filter(p => p.answers?.[qIdx] && p.answers[qIdx].ok)
    .sort((a,b) => a.answers[qIdx].time - b.answers[qIdx].time)
    .slice(0, 10);
    
  el.innerHTML = list.length ? `<table class="dtable">
    <thead><tr><th>RANK</th><th>NAME</th><th>ANSWERED AT</th></tr></thead>
    <tbody>${list.map((p,i)=>`<tr><td class="font-title text-xs">#${i+1}</td><td>${p.name}</td><td class="font-mono text-xs text-gold">${format24(p.answers[qIdx].time)}</td></tr>`).join('')}</tbody>
  </table>` : '<div class="empty-state">No fast answers for current question</div>';
}

function renderLoginRecords(){
  const el = document.getElementById('d-login-records'), list = Store.getLoginHistory();
  if(!el) return;
  el.innerHTML = list.length ? `<table class="dtable">
    <thead><tr><th>USER</th><th>ROLE</th><th>LOGIN</th><th>LOGOUT</th><th>DURATION</th></tr></thead>
    <tbody>${list.map(r=>{
      const dur = r.logoutTime ? Math.floor((r.logoutTime - r.loginTime)/60000) + ' min' : '<span class="text-green">ACTIVE</span>';
      return `<tr><td class="font-title text-xs">${r.name}</td><td><span class="badge ${r.role==='admin'?'badge-red':r.role==='team'?'badge-gold':'badge-cyan'}">${r.role.toUpperCase()}</span></td><td class="font-mono text-xs">${format24(r.loginTime)}</td><td class="font-mono text-xs">${r.logoutTime?format24(r.logoutTime):'—'}</td><td class="text-xs">${dur}</td></tr>`;
    }).join('')}</tbody>
  </table>` : '<div class="empty-state">No login history</div>';
}

function format24(ts){
  if(!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleTimeString('en-IN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function renderAlertsBadge(){
  const alerts=Store.getAlerts().filter(a=>!a.dismissed);
  const badge=document.getElementById('cam-alert-badge');
  if(badge){ badge.textContent=alerts.length; badge.classList.toggle('hidden',!alerts.length); }
  
  const reqs = Store.getQuizRequests().filter(r=>r.status==='pending');
  const rbadge = document.getElementById('req-alert-badge');
  if(rbadge){ rbadge.textContent=reqs.length; rbadge.classList.toggle('hidden', !reqs.length); }
}

// ─── USERS ────────────────────────────────────────────────────
function renderUsers(){
  const users=Store.getUsers();
  const teams=Store.getTeams();
  const el=document.getElementById('users-table');
  if(!users.length){ el.innerHTML='<div class="empty-state">No registered users yet.</div>'; return; }
  const assignedIds=new Set();
  teams.forEach(t=>(t.memberIds||[]).forEach(id=>assignedIds.add(id)));

  el.innerHTML=`<table class="dtable" id="u-table-root"><thead><tr>
      <th style="width:280px">
        <div style="display:flex; gap:5px">
          <input type="checkbox" id="user-sel-all" onclick="toggleAllUsers(this.checked)">
          <button class="btn-xs btn-gold" onclick="repairUsers()" title="Recovery missing admin accounts from requests">🛠️ REPAIR</button>
        </div>
      </th>
      <th>#</th><th>NAME</th><th>USERNAME</th><th>ROLL</th><th>ROLE</th><th>IN TEAM</th><th>REGISTERED</th><th></th></tr></thead><tbody>`+
  users.map((u,i)=>{
    const inTeam=assignedIds.has(u.id);
    const tn=inTeam?teams.find(t=>(t.memberIds||[]).includes(u.id))?.name:'';
    return `<tr>
      <td><input type="checkbox" class="user-sel" value="${u.id}" onclick="updateCheckSelection()"></td>
      <td class="text-muted text-xs">${i+1}</td><td><strong>${u.name}</strong></td>
      <td class="text-cyan font-mono text-xs">${u.username}</td><td class="text-muted text-sm">${u.roll}</td>
      <td><select class="role-select" onchange="changeUserRole('${u.id}',this.value)">
        <option value="user" ${u.role==='user'?'selected':''}>User</option>
        <option value="participant" ${u.role==='participant'?'selected':''}>Participant</option>
        <option value="admin" ${u.role==='admin'?'selected':''}>Admin</option>
      </select></td>
      <td>${inTeam?`<span class="badge badge-green">${tn}</span>`:'—'}</td>
      <td class="text-xs text-muted">${new Date(u.registeredAt||0).toLocaleDateString('en-IN')}</td>
      <td><button class="btn-icon" onclick="openEditUser('${u.id}')">✏️</button><button class="btn-icon" onclick="deleteUser('${u.id}')">🗑️</button></td></tr>`;
  }).join('')+'</tbody></table>';
  updateCheckSelection();
}

function repairUsers(){
  const users = Store.getUsers();
  const managed = Store.getManagedQuizzes();
  const reqs = Store.getQuizRequests();
  let count = 0;
  
  managed.forEach(m => {
    // Check if admin exists
    if(!users.find(u => u.id === m.adminId)){
      // Try to find request to get password
      const r = reqs.find(req => req.username === m.username || (req.collegeName === m.collegeName && req.collegeCode === m.collegeCode));
      if(r){
        users.push({
          id: m.adminId,
          name: m.collegeName + ' Admin',
          roll: m.collegeCode,
          college: m.collegeName,
          username: r.username,
          password: r.password,
          role: 'admin',
          currentQuizId: m.quizId,
          registeredAt: r.timestamp || Date.now()
        });
        count++;
      }
    }
  });
  
  if(count > 0){
    Store.saveUsers(users);
    toast(`Successfully reconstructed ${count} missing admin accounts!`, 'success');
    renderUsers();
  } else {
    toast('No missing accounts detected.', 'info');
  }
}

function toggleAllUsers(chk){
  document.querySelectorAll('.user-sel').forEach(el => el.checked = chk);
  updateCheckSelection();
}

function updateCheckSelection(){
  const checked = document.querySelectorAll('.user-sel:checked');
  const btn = document.getElementById('btn-delete-multi');
  if(btn){
    btn.classList.toggle('hidden', checked.length === 0);
    btn.textContent = `🗑️ DELETE SELECTED (${checked.length})`;
  }
}

function deleteSelectedUsers(){
  const checked = [...document.querySelectorAll('.user-sel:checked')].map(el => el.value);
  if(!checked.length) return;
  customConfirm(`Delete <strong>${checked.length} selected users</strong>?`, '🗑️', () => {
    const all = Store.getUsers();
    const filtered = all.filter(u => !checked.includes(u.id));
    Store.saveUsers(filtered);
    toast(`${checked.length} users deleted`, 'warning');
    renderUsers();
  });
}
function toggleAdminFields(){
  const role = document.getElementById('um-role').value;
  const adminBox = document.getElementById('um-admin-fields');
  if(adminBox) adminBox.classList.toggle('hidden', role !== 'admin');
}

function openAddUser(){
  document.getElementById('um-id').value='';
  document.getElementById('um-name').value='';
  document.getElementById('um-roll').value='';
  document.getElementById('um-user').value='';
  document.getElementById('um-pass').value='';
  document.getElementById('um-role').value='user';
  
  document.getElementById('um-college').value='';
  document.getElementById('um-dept').value='';
  document.getElementById('um-year').value='1';
  
  document.getElementById('um-err').textContent='';
  document.getElementById('user-modal-title').textContent='CREATE USER';
  
  const optAdmin = document.querySelector('#um-role option[value="admin"]');
  if(optAdmin) optAdmin.style.display = 'block';

  toggleAdminFields();
  openModal('modal-user');
}
function openEditUser(id){
  const u=Store.getUserById(id); if(!u) return;
  document.getElementById('um-id').value=id;
  document.getElementById('um-name').value=u.name;
  document.getElementById('um-roll').value=u.roll;
  document.getElementById('um-user').value=u.username;
  document.getElementById('um-pass').value=u.password;
  document.getElementById('um-role').value=u.role;
  document.getElementById('um-college').value=u.college||'';
  document.getElementById('um-dept').value=u.dept||'';
  document.getElementById('um-year').value=u.year||'1';
  
  // Populate admin fields if editing an admin
  const managed = Store.getManagedQuizzes();
  const q = managed.find(m => m.adminId === id);
  if(q){
    document.getElementById('um-admin-college').value = q.collegeName;
    document.getElementById('um-admin-code').value = q.collegeCode;
    document.getElementById('um-admin-quizid').value = q.quizId;
  } else {
    document.getElementById('um-admin-college').value='';
    document.getElementById('um-admin-code').value='';
    document.getElementById('um-admin-quizid').value='';
  }

  document.getElementById('um-err').textContent='';
  document.getElementById('user-modal-title').textContent='EDIT USER';

  const optAdmin = document.querySelector('#um-role option[value="admin"]');
  if(optAdmin) optAdmin.style.display = 'block';

  toggleAdminFields();
  openModal('modal-user');
}
function saveUser(){

  const id=document.getElementById('um-id').value;
  const name=document.getElementById('um-name').value.trim();
  const roll=document.getElementById('um-roll').value.trim();
  const username=document.getElementById('um-user').value.trim();
  const password=document.getElementById('um-pass').value.trim();
  const role=document.getElementById('um-role').value;
  const college=document.getElementById('um-college').value.trim();
  const dept=document.getElementById('um-dept').value.trim();
  const year=document.getElementById('um-year').value;

  const adminCollege = document.getElementById('um-admin-college').value.trim();
  const adminCode = document.getElementById('um-admin-code').value.trim();
  const adminQuizId = document.getElementById('um-admin-quizid').value.trim().toUpperCase();

  const err=document.getElementById('um-err');
  if(!name||!roll||!username||!password||!college||!dept){ err.textContent='All fields are required.'; return; }
  
  if(role === 'admin' && (!adminCollege || !adminCode)){
    err.textContent = 'College name and code are required for Admins (in session details).';
    return;
  }

  const users=Store.getUsers();
  // if(users.find(u=>u.username===username&&u.id!==id)){ err.textContent='Username taken.'; return; }
  
  const userId = id || genId();

  if(id){
    Store.updateUser(id,{name,roll,username,password,role,college,dept,year});
    toast('User updated!','success');
    
    // Manage quiz session for admin
    if(role === 'admin'){
      const managed = Store.getManagedQuizzes();
      const existingIdx = managed.findIndex(m => m.adminId === id);
      const quizId = adminQuizId || (existingIdx >= 0 ? managed[existingIdx].quizId : Store.generateQuizId());
      
      const sessionData = {
        quizId,
        adminId: id,
        collegeName: adminCollege,
        collegeCode: adminCode,
        expiry: (existingIdx >= 0 ? managed[existingIdx].expiry : null),
        status: (existingIdx >= 0 ? managed[existingIdx].status : 'active')
      };

      if(existingIdx >= 0) {
        managed[existingIdx] = sessionData;
        Store.saveManagedQuizzes(managed);
      } else {
        Store.addManagedQuiz(sessionData);
      }
      Store.addActivity(`Admin session <strong>${quizId}</strong> updated for <strong>${name}</strong>`,'success');
    }
  } else {
    Store.addUser({id:userId,name,roll,username,password,role,college,dept,year,registeredAt:Date.now()});
    toast('User created!','success');
    Store.addActivity(`User <strong>${name}</strong> created by Superadmin`,'success');
    
    // Generate quiz if role is admin
    if(role === 'admin'){
      const quizId = adminQuizId || Store.generateQuizId();
      Store.addManagedQuiz({
        quizId,
        adminId: userId,
        collegeName: adminCollege,
        collegeCode: adminCode,
        expiry: null,
        status: 'active'
      });
      Store.addActivity(`Quiz <strong>${quizId}</strong> manual generated for new admin <strong>${name}</strong>`,'success');
    }
  }
  closeModal('modal-user'); 
  renderUsers();
  // Ensure the managed admins table is updated if role was admin
  if(role === 'admin') renderManaged();
}
function changeUserRole(id,role){ 
  const oldU = Store.getUserById(id);
  if(!oldU) return;

  Store.updateUser(id,{role}); 
  const u=Store.getUserById(id); 
  if(!u) return;
  
  if(role === 'admin'){
    const managed = Store.getManagedQuizzes();
    if(!managed.find(m => m.adminId === id)){
      const quizId = Store.generateQuizId();
      Store.addManagedQuiz({
        quizId,
        adminId: id,
        collegeName: u.name,
        collegeCode: u.roll || 'N/A',
        expiry: null,
        status: 'active'
      });
      Store.addActivity(`Quiz <strong>${quizId}</strong> auto-generated for promoted admin <strong>${u.name}</strong>`,'success');
      toast(`Promoted to Admin! Generated Quiz ID: ${quizId}`, 'success');
    }
  }
  
  Store.addActivity(`<strong>${u?.name}</strong> → ${role}`,'info'); 
  toast(`Role → ${role}`,'success'); 
  if(currentSec==='users') renderUsers(); 
  if(currentSec==='managed-admins') renderManaged();
}
function deleteUser(id){
  const u=Store.getUserById(id);
  customConfirm(`Delete <strong>${u?.name}</strong>?`, '🗑️', () => {
    Store.deleteUser(id);
    toast('User deleted','warning');
    renderUsers();
  });
}

// ─── TEAMS ────────────────────────────────────────────────────
function renderTeams(){
  const teams=Store.getTeams(), users=Store.getUsers(), el=document.getElementById('teams-table');
  if(!teams.length){ el.innerHTML='<div class="empty-state">No teams yet.</div>'; return; }
  el.innerHTML=`<table class="dtable"><thead><tr><th>#</th><th>NO.</th><th>TEAM NAME</th><th>USERNAME</th><th>MEMBERS</th><th>STATUS</th><th>SCORE</th><th></th></tr></thead><tbody>`+
  teams.map((t,i)=>{
    const memberNames=(t.memberIds||[]).map(id=>users.find(u=>u.id===id)?.name||'?').join(', ')||'—';
    return `<tr>
      <td class="text-muted text-xs">${i+1}</td>
      <td class="font-title text-cyan text-xs">T${t.teamNumber||'?'}</td>
      <td><strong>${t.name}</strong><div class="text-xs text-muted mt-1">${memberNames}</div></td>
      <td class="font-mono text-xs">${t.username}</td>
      <td class="text-sm">${(t.memberIds||[]).length}/${t.memberLimit||'?'}</td>
      <td><span class="badge ${t.status==='active'?'badge-green':'badge-gray'}">${(t.status||'inactive').toUpperCase()}</span></td>
      <td class="font-title text-green">${t.score||0}</td>
      <td>
        <button class="btn-icon" onclick="openEditTeam('${t.id}')">✏️</button>
        ${t.status!=='active'?`<button class="btn-icon" onclick="activateTeam('${t.id}')" title="Activate" style="color:var(--green)">✅</button>`:`<button class="btn-icon" onclick="deactivateTeam('${t.id}')" title="Deactivate" style="color:var(--muted)">⏸</button>`}
        <button class="btn-icon" onclick="deleteTeam('${t.id}')" style="color:var(--red)">🗑️</button>
      </td></tr>`;
  }).join('')+'</tbody></table>';
}

function openAddTeam(){
  document.getElementById('tm-id').value='';
  document.getElementById('team-modal-title').textContent='CREATE TEAM';
  renderTeamForm(null); openModal('modal-team');
}
function openEditTeam(id){
  const t=Store.getTeamById(id); if(!t) return;
  document.getElementById('tm-id').value=id;
  document.getElementById('team-modal-title').textContent='EDIT TEAM';
  renderTeamForm(t); openModal('modal-team');
}

function renderTeamForm(team){
  const users=Store.getUsers().filter(u=>u.role==='participant');
  const allTeams=Store.getTeams();
  const assignedIds=new Set();
  allTeams.forEach(t=>{ if(!team||t.id!==team.id)(t.memberIds||[]).forEach(id=>assignedIds.add(id)); });
  const selectedIds=team?(team.memberIds||[]):[];
  const limit=team?team.memberLimit:4;
  const memberOptions=users.map(u=>{
    const sel=selectedIds.includes(u.id);
    const avail=!assignedIds.has(u.id)||sel;
    return `<label class="member-checkbox ${!avail?'disabled':''}">
      <input type="checkbox" name="tm-members" value="${u.id}" ${sel?'checked':''} ${!avail?'disabled':''} onchange="checkMemberLimit()">
      <span>${u.name} <span class="text-muted text-xs">(${u.roll})</span></span>
    </label>`;
  }).join('');

  document.getElementById('team-modal-body').innerHTML=`
    <div class="frow">
      <div class="form-group"><label>TEAM NUMBER</label><input type="number" id="tm-num" value="${team?.teamNumber||''}" placeholder="1" min="1"></div>
      <div class="form-group"><label>TEAM NAME</label><input type="text" id="tm-name" value="${team?.name||''}" placeholder="e.g. Team Alpha"></div>
    </div>
    <div class="frow">
      <div class="form-group"><label>MEMBER LIMIT</label><input type="number" id="tm-limit" value="${limit||4}" min="1" max="10" onchange="checkMemberLimit()"></div>
      <div class="form-group"><label>TEAM USERNAME</label><input type="text" id="tm-user" value="${team?.username||''}" placeholder="Login username"></div>
    </div>
    <div class="form-group"><label>TEAM PASSWORD</label><input type="text" id="tm-pass" value="${team?.password||''}" placeholder="Login password"></div>
    <div class="form-group">
      <label>SELECT MEMBERS (participants only) — <span id="tm-count-lbl">0/${limit||4}</span></label>
      <div class="member-list">${users.length?memberOptions:'<div class="text-muted text-sm">No participants. Promote users first.</div>'}</div>
    </div>
    <div id="tm-err" class="err-msg"></div>
    <button class="btn-main btn-green" onclick="saveTeam()">SAVE TEAM</button>`;
  checkMemberLimit();
}

function checkMemberLimit(){
  const limit=parseInt(document.getElementById('tm-limit')?.value)||4;
  const checked=document.querySelectorAll('[name="tm-members"]:checked');
  const lbl=document.getElementById('tm-count-lbl');
  if(lbl) lbl.textContent=`${checked.length}/${limit}`;
  document.querySelectorAll('[name="tm-members"]').forEach(cb=>{
    if(!cb.checked&&!cb.disabled) cb.disabled=checked.length>=limit;
  });
}

function saveTeam(){
  const id=document.getElementById('tm-id').value;
  const teamNumber=parseInt(document.getElementById('tm-num').value)||0;
  const name=document.getElementById('tm-name').value.trim();
  const username=document.getElementById('tm-user').value.trim();
  const password=document.getElementById('tm-pass').value.trim();
  const memberLimit=parseInt(document.getElementById('tm-limit').value)||4;
  const memberIds=[...document.querySelectorAll('[name="tm-members"]:checked')].map(cb=>cb.value);
  const err=document.getElementById('tm-err');
  err.textContent='';
  if(!teamNumber){ err.textContent='Team number required.'; return; }
  if(!name){ err.textContent='Team name required.'; return; }
  if(!username||!password){ err.textContent='Username and password required.'; return; }
  const teams=Store.getTeams();
  if(teams.find(t=>t.username===username&&t.id!==id)){ err.textContent='Username already in use.'; return; }
  if(teams.find(t=>t.teamNumber===teamNumber&&t.id!==id)){ err.textContent='Team number already in use.'; return; }
  if(id){
    Store.updateTeam(id,{teamNumber,name,username,password,memberLimit,memberIds});
    toast('Team updated!','success');
  } else {
    const raw=load(KEYS.TEAMS,[])||[];
    raw.push({id:genId(),teamNumber,name,username,password,memberLimit,memberIds,status:'inactive',score:0,correctCount:0,answers:{},passedQs:[],roundScores:{}});
    save(KEYS.TEAMS,raw);
    toast('Team created!','success');
    Store.addActivity(`Team <strong>T${teamNumber}: ${name}</strong> created`,'success');
  }
  closeModal('modal-team'); renderTeams();
}

function activateTeam(id){ const t=Store.getTeamById(id); Store.updateTeam(id,{status:'active'}); toast(`T${t?.teamNumber}: ${t?.name} activated`,'success'); Store.addActivity(`Team <strong>${t?.name}</strong> activated`,'success'); renderTeams(); }
function deactivateTeam(id){ const t=Store.getTeamById(id); Store.updateTeam(id,{status:'inactive'}); toast(`Deactivated.`,'warning'); renderTeams(); }
function deleteTeam(id){
  const t=Store.getTeamById(id);
  customConfirm(`Delete <strong>${t?.name}</strong>?`, '🗑️', () => {
    Store.deleteTeam(id);
    toast('Team deleted','warning');
    renderTeams();
  });
}

// ─── AUTO TEAM ASSIGNMENT ─────────────────────────────────────
function openAutoTeamsModal(){ openModal('modal-auto-teams'); }
function generateAutoTeams(){
  const college = document.getElementById('at-college').value.trim().toLowerCase();
  const dept = document.getElementById('at-dept').value.trim().toLowerCase();
  const year = document.getElementById('at-year').value;
  const mode = document.getElementById('at-mode').value;
  const val = parseInt(document.getElementById('at-val').value);
  const err = document.getElementById('at-err');
  err.textContent = '';

  const users = Store.getUsers().filter(u => u.role === 'user' || u.role === 'participant');
  const loginStatus = Store.getLoginStatus();

  // Filter based on criteria
  let eligible = users.filter(u => {
    if(college && u.college?.toLowerCase() !== college) return false;
    if(dept && u.dept?.toLowerCase() !== dept) return false;
    if(year && u.year !== year) return false;
    return true;
  });

  if(!eligible.length){ err.textContent = 'No participants found matching these filters.'; return; }

  // Target online users first if possible, or just shuffle all eligible
  const online = eligible.filter(u => loginStatus[u.id]?.status === 'online').sort(()=>Math.random()-0.5);
  const offline = eligible.filter(u => loginStatus[u.id]?.status !== 'online').sort(()=>Math.random()-0.5);
  const finalPool = [...online, ...offline];

  let teamsToCreate = [];
  if(mode === 'count'){
    const count = Math.min(val, finalPool.length);
    for(let i=0; i<count; i++) teamsToCreate.push([]);
    finalPool.forEach((u, i) => teamsToCreate[i % count].push(u));
  } else {
    const size = Math.max(1, Math.min(val, finalPool.length));
    for(let i=0; i<finalPool.length; i+=size){
      teamsToCreate.push(finalPool.slice(i, i+size));
    }
  }

  customConfirm(`Generate <strong>${teamsToCreate.length} teams</strong> from ${finalPool.length} participants?`, '⚡', () => {
    const currentTeams = Store.getTeams();
    const newTeams = [];

    teamsToCreate.forEach((mems, i) => {
      if(!mems.length) return;
      const leader = mems[0]; 
      const teamId = genId();
      newTeams.push({
        id: teamId,
        name: `Team ${currentTeams.length + i + 1}`,
        teamNumber: currentTeams.length + i + 1,
        username: `team${currentTeams.length + i + 1}_auto`,
        password: Math.random().toString(36).substr(2, 6),
        quizId: 'GLOBAL',
        memberIds: mems.map(m => m.id),
        leaderId: leader.id,
        status: 'active',
        score: 0,
        correctCount: 0,
        answers: {},
        roundScores: {},
        passedQs: []
      });

      Store.addActivity(`Auto-Team: <strong>Team ${currentTeams.length + i + 1}</strong> created. Leader: ${leader.name}`, 'success');
    });

    Store.saveTeams([...currentTeams, ...newTeams]);
    toast(`Successfully generated ${newTeams.length} teams!`,'success');
    closeModal('modal-auto-teams');
    renderTeams();
  });
}

// ─── ELIMINATION ─────────────────────────────────────────────
function openEliminationModal(){ openModal('modal-elimination'); }
function runElimination(){
  const criteria = document.getElementById('el-criteria').value;
  const val = parseInt(document.getElementById('el-val').value);
  const err = document.getElementById('el-err');
  err.textContent = '';

  const teams = Store.getTeams().filter(t => t.status === 'active');
  if(!teams.length){ err.textContent = 'No active teams to eliminate.'; return; }

  const sorted = [...teams].sort((a,b) => (b.score||0) - (a.score||0));
  let toEliminate = [];

  if(criteria === 'bottom'){
    toEliminate = sorted.slice(sorted.length - val);
  } else if(criteria === 'top'){
    toEliminate = sorted.slice(val);
  } else if(criteria === 'score'){
    toEliminate = sorted.filter(t => (t.score||0) < val);
  }

  if(!toEliminate.length){ err.textContent = 'No teams match the elimination criteria.'; return; }

  customConfirm(`Eliminate <strong>${toEliminate.length} teams</strong>? They will be set to inactive.`, '🚫', () => {
    toEliminate.forEach(t => {
      Store.updateTeam(t.id, { status: 'inactive' });
      Store.addActivity(`Team <strong>${t.name}</strong> ELIMINATED`, 'error');
    });
    toast(`Successfully eliminated ${toEliminate.length} teams!`,'success');
    closeModal('modal-elimination');
    renderTeams();
  });
}

// ─── ROUNDS ───────────────────────────────────────────────────
function renderRounds(){
  const rounds=Store.getRounds();
  const el=document.getElementById('rounds-table');
  const ov=document.getElementById('rounds-overview');
  if(!rounds.length){ el.innerHTML='<div class="empty-state">No rounds configured.</div>'; ov.innerHTML=''; return; }
  
  const total=rounds.reduce((a,b)=>a+(b.questionCount||0),0);
  const totalMins=rounds.reduce((a,b)=>a+Math.ceil(((b.questionCount||0)*(b.timePerQuestion||60) + (b.roundTimeLimit||0)*60)/60),0);
  ov.innerHTML=`<span class="badge badge-purple">${rounds.length} Rounds</span> <span class="badge badge-cyan">${total} Total Questions</span> <span class="badge badge-gold">~${totalMins} Minutes Est.</span>`;

  const questions = Store.getQuestions();
  el.innerHTML=`<table class="dtable"><thead><tr>
    <th style="width:30px"><input type="checkbox" id="chk-rounds-all" onclick="toggleSelectAll('rounds', this.checked)"></th>
    <th>ID</th><th>NAME</th><th>STAGE</th><th>QS</th><th>TIME/Q</th><th>SUBSEC</th><th></th></tr></thead><tbody>`+
  rounds.map((r,i)=>{
    const range = getRoundQRange(rounds, i);
    const roundQs = questions.slice(range.start, range.start + range.count);
    const isMissing = roundQs.length < r.questionCount || roundQs.some(q => !q || q.isPlaceholder);
    
    return `<tr>
    <td><input type="checkbox" class="chk-round" value="${r.id}" onclick="onSelectRow('rounds')"></td>
    <td class="text-xs text-muted">R${r.roundNumber || i+1}</td>
    <td><strong class="${isMissing ? 'text-red' : ''}">${r.name}</strong></td>
    <td><span class="badge badge-purple">${r.stage||'Preliminary'}</span></td>
    <td><span class="badge ${isMissing ? 'badge-red' : 'badge-cyan'}">${r.questionCount}</span></td>
    <td>${r.timePerQuestion}s</td>
    <td class="text-xs text-muted">${r.roundTimeLimit?`+${r.roundTimeLimit}m`:''}</td>
    <td style="white-space:nowrap">
      <button class="btn-icon" onclick="openEditRound('${r.id}')" title="Edit Round">✏️</button>
      <button class="btn-icon" onclick="openAIGenForRound(${i})" title="AI Generate Questions">🤖</button>
    </td></tr>`}).join('')+'</tbody></table>';
  onSelectRow('rounds');
}

function openAddRound(){ document.getElementById('rm-id').value=''; ['rm-name','rm-instr'].forEach(id=>document.getElementById(id).value=''); document.getElementById('rm-num').value=Store.getRounds().length+1; document.getElementById('rm-qcount').value='5'; document.getElementById('rm-stage').value='Preliminary'; document.getElementById('rm-qtime').value=Store.getSettings().defaultTimePerQuestion||'60'; document.getElementById('rm-rtime').value='0'; document.getElementById('rm-err').textContent=''; document.getElementById('round-modal-title').textContent='ADD ROUND'; openModal('modal-round'); }
function openEditRound(id){ const r=Store.getRounds().find(x=>x.id===id); if(!r) return; document.getElementById('rm-id').value=id; document.getElementById('rm-name').value=r.name; document.getElementById('rm-num').value=r.roundNumber||''; document.getElementById('rm-stage').value=r.stage||'Preliminary'; document.getElementById('rm-instr').value=r.instructions||''; document.getElementById('rm-qcount').value=r.questionCount; document.getElementById('rm-qtime').value=r.timePerQuestion; document.getElementById('rm-rtime').value=r.roundTimeLimit||0; document.getElementById('rm-err').textContent=''; document.getElementById('round-modal-title').textContent='EDIT ROUND'; openModal('modal-round'); }
function saveRound(){ const id=document.getElementById('rm-id').value; const name=document.getElementById('rm-name').value.trim(); const roundNumber=parseInt(document.getElementById('rm-num').value)||1; const stage=document.getElementById('rm-stage').value; const instructions=document.getElementById('rm-instr').value.trim(); const questionCount=parseInt(document.getElementById('rm-qcount').value)||0; const timePerQuestion=parseInt(document.getElementById('rm-qtime').value)||60; const roundTimeLimit=parseInt(document.getElementById('rm-rtime').value)||0; const err=document.getElementById('rm-err'); if(!name){err.textContent='Name required.';return;} if(questionCount<1){err.textContent='At least 1 question required.';return;} const rounds=Store.getRounds(); if(id){const idx=rounds.findIndex(r=>r.id===id);if(idx>=0)rounds[idx]={...rounds[idx],name,roundNumber,stage,instructions,questionCount,timePerQuestion,roundTimeLimit};toast('Updated!','success');}else{rounds.push({id:genId(),name,roundNumber,stage,instructions,questionCount,timePerQuestion,roundTimeLimit});toast('Added!','success');} Store.saveRounds(rounds); closeModal('modal-round'); renderRounds(); }
function deleteRound(id){ const r=Store.getRounds().find(x=>x.id===id); customConfirm(`Delete round <strong>${r?.name}</strong>? All mapped questions will remain in bank.`, '🗑️', () => { Store.saveRounds(Store.getRounds().filter(x=>x.id!==id)); toast('Round deleted','warning'); renderRounds(); }); }
function moveRound(id,dir){ const rounds=Store.getRounds(); const idx=rounds.findIndex(r=>r.id===id); const ni=idx+dir; if(ni<0||ni>=rounds.length) return; [rounds[idx],rounds[ni]]=[rounds[ni],rounds[idx]]; Store.saveRounds(rounds); renderRounds(); }


function openTemplatesModal(tab='quick'){
  switchTmplTab(tab);
  openModal('modal-templates');
  updateTemplatePreview();
}

function switchTmplTab(type){
  document.querySelectorAll('#modal-templates .ltab').forEach(t=>t.classList.remove('active'));
  document.querySelectorAll('#modal-templates .lpanel').forEach(p=>p.classList.remove('active'));
  document.getElementById('tab-tmpl-'+type)?.classList.add('active');
  document.getElementById('panel-tmpl-'+type)?.classList.add('active');
}

function autoSetTmplTime(){
  const r = parseInt(document.getElementById('tmpl-rounds').value);
  const tEl = document.getElementById('tmpl-time');
  const mapping = { 3:30, 4:35, 5:40, 10:50, 15:60 };
  const target = mapping[r] || Math.min(180, Math.max(5, r * 8));
  
  if(tEl) tEl.value = target;
  
  const badge = document.getElementById('auto-time-badge');
  if(badge) {
    badge.classList.remove('hidden');
    setTimeout(()=>badge.classList.add('hidden'), 2000);
  }
  updateTemplatePreview();
}

function applyPreset(name, rounds, time, qs) {
  applyQuizTemplate(name, rounds, time, qs);
}

function updateTemplatePreview(){

  const roundCount = parseInt(document.getElementById('tmpl-rounds')?.value || 3);
  const totalMins = parseInt(document.getElementById('tmpl-time')?.value || 30);
  const qsPerRound = parseInt(document.getElementById('tmpl-qs')?.value || 5);
  const totalQs = roundCount * qsPerRound;
  const timePerQ = Math.floor((totalMins * 60) / totalQs);
  
  // Calculate stage breakdown
  let stages = { Preliminary: 0, Selection: 0, Final: 0 };
  for(let i=1; i<=roundCount; i++){
    if(roundCount >= 5){
      const pctPos = i / roundCount;
      if(pctPos > 0.66) stages.Final++;
      else if(pctPos > 0.33) stages.Selection++;
      else stages.Preliminary++;
    } else if(roundCount >= 3){
      if(i === roundCount) stages.Final++;
      else if(i > 1) stages.Selection++;
      else stages.Preliminary++;
    } else { stages.Preliminary++; }
  }
  
  const el = document.getElementById('tmpl-preview');
  if(el) el.innerHTML = `
    <strong>${roundCount} rounds</strong> × ${qsPerRound} questions = <strong>${totalQs} total questions</strong><br>
    ⏱ <strong>${timePerQ}s</strong> per question (${totalMins} min total)<br>
    📊 Stages: <span style="color:var(--cyan)">${stages.Preliminary} Preliminary</span> → 
    <span style="color:var(--gold)">${stages.Selection} Selection</span> → 
    <span style="color:var(--green)">${stages.Final} Final</span>`;
}

function applyQuizTemplate(presetName = null, presetRounds = null, presetTime = null, presetQs = null){
  const roundCount = presetRounds || parseInt(document.getElementById('tmpl-rounds').value);
  const totalMins = presetTime || parseInt(document.getElementById('tmpl-time').value);
  const qsPerRound = presetQs || parseInt(document.getElementById('tmpl-qs').value) || 5;
  const finalName = presetName || "Quick Setup";
  const totalQs = roundCount * qsPerRound;
  const timePerQ = Math.floor((totalMins * 60) / totalQs);
  
  customConfirm(`Applying <strong>${finalName}</strong> will replace current rounds with <strong>${roundCount} rounds</strong> (${totalMins} min total). Continue?`, '⚡', () => {
    const newRounds = [];
    for(let i=1; i<=roundCount; i++){
      // Auto-assign tournament stages based on round position
      let stage = 'Preliminary';
      if(roundCount >= 5){
        const pctPos = i / roundCount;
        if(pctPos > 0.66) stage = 'Final';
        else if(pctPos > 0.33) stage = 'Selection';
      } else if(roundCount >= 3){
        if(i === roundCount) stage = 'Final';
        else if(i > 1) stage = 'Selection';
      }
      
      const stageLabels = { Preliminary: 'Qualifiers', Selection: 'Knowledge', Final: 'Finals' };
      newRounds.push({
        id: 'RND_' + Math.random().toString(36).substr(2, 6).toUpperCase(),
        name: `Round ${i}: ${i===1?'Qualifiers':i===roundCount?'Finals':stageLabels[stage]||'Knowledge'}`,
        roundNumber: i,
        stage: stage,
        instructions: `Welcome to Round ${i} (${stage} Stage). You have ${qsPerRound} questions in this round.`,
        questionCount: qsPerRound,
        timePerQuestion: timePerQ,
        roundTimeLimit: 0 
      });
    }
    
    Store.saveRounds(newRounds);
    const quiz = Store.getQuiz();
    quiz.templateName = finalName;
    quiz.templateDuration = totalMins;
    quiz.status = 'idle';
    quiz.currentRoundIdx = 0;
    quiz.globalQIdx = 0;
    Store.saveQuiz(quiz); 
    
    toast(`Template applied: ${finalName}`,'success');
    closeModal('modal-templates');
    renderRounds();
  });
}
// ─── QUESTIONS ────────────────────────────────────────────────
function renderQuestions(){
  const questions=Store.getQuestions(), rounds=Store.getRounds();
  const filterVal=document.getElementById('q-round-filter')?.value;
  const filterSel=document.getElementById('q-round-filter');
  if(filterSel) filterSel.innerHTML='<option value="">All Rounds</option>'+rounds.map((r,i)=>`<option value="${i}" ${filterVal==i?'selected':''}>R${r.roundNumber||i+1}: ${r.name}</option>`).join('');
  document.getElementById('q-summary').innerHTML=rounds.map((r,i)=>{const range=getRoundQRange(rounds,i);const have=Math.max(0,Math.min(r.questionCount,questions.length-range.start));return `<span class="badge ${have>=r.questionCount?'badge-green':'badge-red'}">${r.name}: ${have}/${r.questionCount}</span>`;}).join(' ')||'<span class="text-muted">No rounds</span>';
  const el=document.getElementById('questions-table');
  if(!questions.length){el.innerHTML='<div class="empty-state">No questions yet.</div>';return;}
  let filtered=questions.map((q,i)=>({...q,_gi:i}));
  if(filterVal!==''&&filterVal!=null&&filterVal!==undefined){const ri=parseInt(filterVal);const range=getRoundQRange(rounds,ri);filtered=filtered.filter(q=>q._gi>=range.start&&q._gi<=range.end);}
  el.innerHTML=`<table class="dtable"><thead><tr>
    <th style="width:30px"><input type="checkbox" id="chk-questions-all" onclick="toggleSelectAll('questions', this.checked)"></th>
    <th>#</th><th>RND</th><th>QUESTION</th><th>TYPE</th><th>ANSWER</th><th></th></tr></thead><tbody>`+
  filtered.map(q=>{
    let rLabel='—',qs=0;
    for(let i=0;i<rounds.length;i++){if(q._gi>=qs&&q._gi<qs+rounds[i].questionCount){rLabel=`R${rounds[i].roundNumber||i+1}`;break;}qs+=rounds[i].questionCount;}
    return `<tr>
      <td><input type="checkbox" class="chk-question" value="${q.id}" onclick="onSelectRow('questions')"></td>
      <td class="text-muted text-xs">${q._gi+1}</td><td><span class="badge badge-cyan">${rLabel}</span></td>
      <td class="text-sm" style="max-width:300px">${q.text}</td>
      <td><span class="badge ${q.type==='multiple'?'badge-purple':'badge-cyan'}">${q.type==='multiple'?'MULTI':'SINGLE'}</span></td>
      <td><span class="badge badge-green">${(q.correct||[]).map(c=>String.fromCharCode(65+c)).join(',')}</span></td>
      <td><button class="btn-icon" onclick="openEditQ('${q.id}')">✏️</button><button class="btn-icon" style="color:var(--red)" onclick="deleteQ('${q.id}')">🗑️</button></td></tr>`;
  }).join('')+'</tbody></table>';
  onSelectRow('questions');
}

function renderOptFields(){ const type=document.getElementById('qm-type').value; const wrap=document.getElementById('qm-opts'); wrap.innerHTML=`<div class="form-group"><label>OPTIONS ${type==='multiple'?'(check all correct)':'(select correct)'}</label>`+['A','B','C','D'].map((l,i)=>`<div class="opt-row"><input type="${type==='multiple'?'checkbox':'radio'}" name="q-correct" value="${i}" id="qc-${i}" style="accent-color:var(--green)"><label for="qc-${i}" class="opt-lbl">${l}</label><input type="text" id="qopt-${i}" placeholder="Option ${l}"></div>`).join('')+'</div>'; }
function openAddQ(){ document.getElementById('qm-id').value=''; document.getElementById('qm-text').value=''; document.getElementById('qm-type').value='single'; document.getElementById('qm-expl').value=''; document.getElementById('qm-err').textContent=''; document.getElementById('q-modal-title').textContent='ADD QUESTION'; renderOptFields(); openModal('modal-question'); }
function openEditQ(id){ const q=Store.getQuestions().find(x=>x.id===id); if(!q) return; document.getElementById('qm-id').value=id; document.getElementById('qm-text').value=q.text; document.getElementById('qm-type').value=q.type; document.getElementById('qm-expl').value=q.explanation||''; document.getElementById('qm-err').textContent=''; document.getElementById('q-modal-title').textContent='EDIT QUESTION'; renderOptFields(); setTimeout(()=>{q.options.forEach((opt,i)=>{const el=document.getElementById(`qopt-${i}`);if(el)el.value=opt;});q.correct.forEach(c=>{const el=document.getElementById(`qc-${c}`);if(el)el.checked=true;});},20); openModal('modal-question'); }
function saveQuestion(){ const id=document.getElementById('qm-id').value; const text=document.getElementById('qm-text').value.trim(); const type=document.getElementById('qm-type').value; const expl=document.getElementById('qm-expl').value.trim(); const err=document.getElementById('qm-err'); if(!text){err.textContent='Text required.';return;} const options=[]; for(let i=0;i<4;i++){const v=document.getElementById(`qopt-${i}`)?.value.trim();if(!v){err.textContent=`Option ${String.fromCharCode(65+i)} required.`;return;}options.push(v);} const correct=[...document.querySelectorAll('[name="q-correct"]:checked')].map(c=>parseInt(c.value)); if(!correct.length){err.textContent='Mark at least one correct answer.';return;} if(type==='single'&&correct.length>1){err.textContent='Single: one correct only.';return;} const qs=Store.getQuestions(); if(id){const idx=qs.findIndex(q=>q.id===id);if(idx>=0)qs[idx]={...qs[idx],text,type,options,correct,explanation:expl};toast('Updated!','success');}else{qs.push({id:genId(),text,type,options,correct,explanation:expl});toast('Added!','success');} Store.saveQuestions(qs); closeModal('modal-question'); renderQuestions(); }
function deleteQ(id){ customConfirm('Permanently delete this question?', '🗑️', () => { Store.saveQuestions(Store.getQuestions().filter(q=>q.id!==id)); toast('Question deleted','warning'); renderQuestions(); }); }
function openUpload(){ document.getElementById('upload-preview').innerHTML=''; document.getElementById('btn-import').classList.add('hidden'); openModal('modal-upload'); }
function handleDrop(e){ e.preventDefault(); e.currentTarget.classList.remove('drag-over'); processFile(e.dataTransfer.files[0]); }
function handleFileInput(e){ processFile(e.target.files[0]); }
function processFile(file){ if(!file) return; const reader=new FileReader(); reader.onload=e=>{const lines=e.target.result.split('\n').filter(l=>l.trim()); pendingImport=[]; let errs=0; lines.forEach(line=>{const p=line.split('|').map(x=>x.trim()); if(p.length<6){errs++;return;} const[qText,a,b,c,d,ans]=p; const correct=ans.toUpperCase().split(',').map(s=>s.trim()).map(l=>l.charCodeAt(0)-65).filter(n=>n>=0&&n<4); const type=correct.length>1?'multiple':'single'; if(!qText||!a||!b||!c||!d||!correct.length){errs++;return;} pendingImport.push({id:genId(),text:qText,options:[a,b,c,d],correct,type,explanation:''});}); const prev=document.getElementById('upload-preview'); prev.innerHTML=`<span class="badge badge-green">✓ ${pendingImport.length} ready</span>${errs?` <span class="badge badge-red">⚠ ${errs} skipped</span>`:''}${pendingImport.slice(0,5).map((q,i)=>`<div class="text-xs text-muted" style="padding:3px 0">${i+1}. ${q.text}</div>`).join('')}`; document.getElementById('btn-import').classList.toggle('hidden',!pendingImport.length); }; reader.readAsText(file); }
function importQuestions(){ if(!pendingImport.length) return; Store.saveQuestions([...Store.getQuestions(),...pendingImport]); toast(`${pendingImport.length} imported!`,'success'); Store.addActivity(`${pendingImport.length} questions imported via CSV`,'success'); pendingImport=[]; closeModal('modal-upload'); renderQuestions(); }


// ─── QUIZ CONTROL ─────────────────────────────────────────────
function renderControl(){
  const quiz=Store.getQuiz(), teams=Store.getActiveTeams(),
        questions=Store.getQuestions(), rounds=Store.getRounds();
  const s=quiz.status;
  const dotClass={idle:'',round_intro:'dot-paused',running:'dot-active',paused:'dot-paused',participant_turn:'dot-active dot-purple',round_end:'dot-paused',finished:''};
  document.getElementById('c-dot').className='sdot '+(dotClass[s]||'');
  const curStage = rounds[quiz.currentRoundIdx]?.stage || 'Preliminary';
  const sLabel={idle:'IDLE',round_intro:`ROUND ${quiz.currentRoundIdx+1} INTRO`,running:`ROUND ${quiz.currentRoundIdx+1} RUNNING`,paused:'PAUSED',participant_turn:'PARTICIPANTS ANSWERING',round_end:`ROUND ${quiz.currentRoundIdx+1} ENDED`,finished:'FINISHED'};
  document.getElementById('c-status-txt').textContent=sLabel[s]||s.toUpperCase();
  const ri=document.getElementById('c-round-info');
  if(s!=='idle'&&rounds[quiz.currentRoundIdx]){
    ri.style.display='inline-flex';
    ri.innerHTML=`<span class="badge badge-gold" style="margin-right:6px;font-size:9px">${curStage.toUpperCase()}</span> Round ${quiz.currentRoundIdx+1}: ${rounds[quiz.currentRoundIdx].name}`;
  }else ri.style.display='none';

  const tBadge = document.getElementById('c-template-badge');
  if(tBadge){
    if(quiz.templateName){
      tBadge.classList.remove('hidden');
      tBadge.style.display = 'inline-flex';
      tBadge.innerHTML = `📋 ${quiz.templateName} · ${quiz.templateDuration} min`;
    } else {
      tBadge.classList.add('hidden');
      tBadge.style.display = 'none';
    }
  }


  const sh=id=>document.getElementById(id)?.classList.remove('hidden');
  const hd=id=>document.getElementById(id)?.classList.add('hidden');
  const shSt=(id,v)=>{ const el=document.getElementById(id); if(el) el.style.display=v; };
  shSt('btn-start',s==='idle'||s==='finished'?'inline-flex':'none');
  s==='round_intro'?sh('btn-begin'):hd('btn-begin');
  s==='running'?sh('btn-pause'):hd('btn-pause');
  s==='paused'?sh('btn-resume'):hd('btn-resume');
  shSt('btn-next',s==='running'||s==='paused'?'inline-flex':'none');
  (s==='running'||s==='paused')?sh('btn-end-round'):hd('btn-end-round');
  s==='round_end'?sh('btn-next-round'):hd('btn-next-round');
  s==='finished'?(document.getElementById('btn-next-round').classList.remove('hidden'), document.getElementById('btn-next-round').textContent='🏆 ANNOUNCE WINNER'):null;


  // Current question view - ALWAYS show latest from store
  const qv=document.getElementById('c-question-view'), qb=document.getElementById('c-q-badge');
  if(s==='idle'){ qv.innerHTML=`<div class="empty-state">${questions.length} questions · ${teams.length} active teams · ${rounds.length} rounds</div>`; qb.innerHTML=''; }
  else if(s==='round_intro'){ const r=rounds[quiz.currentRoundIdx]; qv.innerHTML=`<div class="round-intro-preview"><div class="font-title text-purple mb-1"><span class="badge badge-gold" style="font-size:10px;margin-right:6px">${curStage.toUpperCase()} STAGE</span> ${r?.name} — INTRO</div><div class="text-sm text-muted" style="white-space:pre-wrap">${r?.instructions||'No instructions.'}</div><p class="text-xs text-gold mt-2">⚠ Round will NOT start automatically. Click BEGIN ROUND when ready.</p></div>`; qb.innerHTML=''; }
  else if(s==='round_end'||s==='finished'){
    let endMsg = s==='finished' ? '🏆 Quiz complete!' : 'Round ended.';
    if(s==='round_end'){
      const nextIdx = quiz.currentRoundIdx + 1;
      const nextR = rounds[nextIdx];
      const nextStage = nextR?.stage || 'Preliminary';
      if(nextR && nextStage !== curStage){
        endMsg += `<div class="mt-2" style="background:rgba(255,215,0,0.1);border:1px solid var(--gold);padding:10px;border-radius:8px"><div class="font-title text-gold" style="font-size:14px">⚡ STAGE TRANSITION</div><div class="text-xs text-muted mt-1">${curStage.toUpperCase()} → ${nextStage.toUpperCase()}</div><div class="text-xs text-muted mt-1">Use <strong>ELIMINATE TEAMS</strong> to remove teams before proceeding.</div></div>`;
      } else {
        endMsg += ' Press NEXT ROUND to continue.';
      }
    }
    qv.innerHTML=`<div class="empty-state">${endMsg}</div>`; qb.innerHTML='';
  }
  else {
    const range=getRoundQRange(rounds,quiz.currentRoundIdx);
    const q=questions[quiz.globalQIdx];
    qb.innerHTML=`<span class="badge badge-cyan">Q${quiz.currentQInRound+1} / ${range.count}</span>`;
    if(q){
      const activeTeamName = quiz.currentTeamIdx===-1||s==='participant_turn' ? '📢 PARTICIPANTS' : (teams[quiz.currentTeamIdx]?.name||'?');
      qv.innerHTML=`<div class="q-now-label text-xs font-title text-muted mb-1">NOW ANSWERING: <span class="text-gold">${activeTeamName}</span></div>
        <div class="q-text" style="font-size:14px;margin-bottom:10px">${q.text}</div>
        <div class="opts-grid">${q.options.map((o,i)=>`<div class="opt-view ${q.correct.includes(i)?'opt-correct':''}"><span class="opt-lbl-sm">${String.fromCharCode(65+i)}</span>${o}${q.correct.includes(i)?'<span class="ml-auto text-green">✓</span>':''}</div>`).join('')}</div>
        ${q.explanation?`<div class="text-xs text-muted mt-1">💡 ${q.explanation}</div>`:''}`;
    } else { qv.innerHTML='<div class="empty-state text-sm">No question at this index.</div>'; }
  }

  // Pass chain
  const passEl=document.getElementById('c-pass-chain');
  if(quiz.passChain?.length||s==='participant_turn'){
    passEl.innerHTML=`<div class="pass-chain">${teams.map((t,i)=>{const passed=quiz.passChain.includes(t.id),current=i===quiz.currentTeamIdx;return `<span class="pchip ${passed?'pchip-passed':current?'pchip-cur':''}">${t.name}</span>${i<teams.length-1?'<span class="parr">→</span>':''}`}).join('')}${(s==='participant_turn'||quiz.currentTeamIdx===-1)?'<span class="parr">→</span><span class="pchip pchip-cur">PARTICIPANTS</span>':''}</div>`;
  } else { passEl.innerHTML='<span class="text-muted text-sm">No passes yet.</span>'; }

  document.getElementById('c-active-team').textContent = s==='participant_turn'||quiz.currentTeamIdx===-1 ? '📢 PARTICIPANTS' : (teams[quiz.currentTeamIdx]?.name||'—');
  renderTeamAnswers();
  renderScoreboard('c-scores');
  renderLoginStatusPanel();
  startAdminTimer();
}

function renderLoginStatusPanel(){
  const el=document.getElementById('c-login-status'); if(!el) return;
  const teams=Store.getActiveTeams(), ls=Store.getLoginStatus();
  el.innerHTML=teams.map(t=>{
    const s=ls[t.id]||{};
    return `<div class="login-chip ${s.loggedIn?'chip-on':'chip-off'}"><span class="chip-dot"></span><span class="chip-name">T${t.teamNumber}: ${t.name}</span><span class="chip-status">${s.loggedIn?'🟢 Online':'🔴 Offline'}</span></div>`;
  }).join('')||'<span class="text-muted text-sm">No active teams</span>';
}

function startAdminTimer(){
  if(adminTimerIv) clearInterval(adminTimerIv);
  tickAdminTimer();
  adminTimerIv=setInterval(tickAdminTimer,500);
}

function tickAdminTimer(){
  const quiz=Store.getQuiz();
  const timerEl=document.getElementById('c-timer'), bar=document.getElementById('c-tbar');
  const rtEl=document.getElementById('c-round-timer-info');
  const ccEl=document.getElementById('c-comp-clock'), ccLbl=document.getElementById('c-comp-label');
  const ptEl=document.getElementById('c-participant-timer'), ptBar=document.getElementById('c-pt-bar');

  // Competition clock
  if(ccEl&&quiz.competitionStart){ ccEl.textContent=formatTime(Math.floor((Date.now()-quiz.competitionStart)/1000)); if(ccLbl) ccLbl.textContent=quiz.overallTimeLimit>0?`Limit: ${quiz.overallTimeLimit}min`:'Running'; }
  else if(ccEl){ ccEl.textContent='00:00'; if(ccLbl) ccLbl.textContent='Not started'; }

  // Participant timer (show prominently)
  const ptWrap=document.getElementById('c-pt-wrap');
  if(quiz.status==='participant_turn'&&quiz.participantTimerStart){
    const rem=Math.max(0,quiz.participantTimeLimit-Math.floor((Date.now()-quiz.participantTimerStart)/1000));
    if(ptWrap) ptWrap.style.display='block';
    if(ptEl){ ptEl.textContent=rem; ptEl.className='timer-big'+(rem<=5?' danger':rem<=10?' warn':''); }
    if(ptBar){ ptBar.style.width=((rem/quiz.participantTimeLimit)*100)+'%'; ptBar.className='tbar'+(rem<=5?' tbar-danger':rem<=10?' tbar-warn':''); }
    if(rem===0 && !quiz._participantTimerHandled){ 
       const q=Store.getQuiz(); 
       if(q._participantTimerHandled) return;
       q._participantTimerHandled=true; 
       Store.saveQuiz(q); 
       Store.addActivity('⏰ Participant time up → next question','warning'); 
       advanceToNextQuestion(); 
    }
  } else { if(ptWrap) ptWrap.style.display='none'; }

  if(quiz.status!=='running'){ if(timerEl){timerEl.textContent=quiz.timerLimit||'—';timerEl.className='timer-big';} if(bar){bar.style.width='100%';bar.className='tbar';} if(rtEl) rtEl.textContent=''; return; }

  const elapsed=quiz.timerStart?Math.floor((Date.now()-quiz.timerStart)/1000):0;
  const limit=quiz.timerLimit||60, rem=Math.max(0,limit-elapsed), pct=(rem/limit)*100;
  if(timerEl){ timerEl.textContent=rem; timerEl.className='timer-big'+(rem<=10?' danger':rem<=20?' warn':''); }
  if(bar){ bar.style.width=pct+'%'; bar.className='tbar'+(rem<=10?' tbar-danger':rem<=20?' tbar-warn':''); }

  if(rtEl&&quiz.roundTimerStart&&quiz.roundTimeLimit>0){ const re=Math.floor((Date.now()-quiz.roundTimerStart)/1000),rl=quiz.roundTimeLimit*60,rr=Math.max(0,rl-re); rtEl.textContent=`Round: ${formatTime(rr)} left`; if(rr===0&&!quiz._roundTimerEnded){const q2=Store.getQuiz();q2._roundTimerEnded=true;Store.saveQuiz(q2);endRound();}}
  else if(rtEl) rtEl.textContent='';

  if(rem===0&&!quiz._timerEndHandled){ const q2=Store.getQuiz();if(q2._timerEndHandled) return; q2._timerEndHandled=true;Store.saveQuiz(q2); Store.addActivity('⏰ Time up → passing','warning'); passToNext(); }
}

function renderTeamAnswers(){
  const quiz=Store.getQuiz(),teams=Store.getActiveTeams(),questions=Store.getQuestions();
  const q=questions[quiz.globalQIdx],el=document.getElementById('c-team-answers');if(!el) return;
  if(!q){el.innerHTML='<span class="text-muted text-sm">—</span>';return;}
  let html=teams.map(t=>{const ans=(t.answers||{})[quiz.globalQIdx];if(ans===undefined) return '';const isC=Array.isArray(ans)?JSON.stringify([...ans].sort())===JSON.stringify([...q.correct].sort()):q.correct.includes(ans);return `<div class="act-row"><div class="act-dot" style="background:${isC?'var(--green)':'var(--red)'}"></div><span><strong>${t.name}</strong>: ${Array.isArray(ans)?ans.map(a=>String.fromCharCode(65+a)).join(','):String.fromCharCode(65+ans)} <span class="${isC?'text-green':'text-red'}">${isC?'✓':'✗'}</span></span></div>`;}).join('');
  Store.getParticipants().forEach(p=>{const ans=(p.answers||{})[quiz.globalQIdx];if(ans===undefined) return;const isC=Array.isArray(ans)?JSON.stringify([...ans].sort())===JSON.stringify([...q.correct].sort()):q.correct.includes(ans);html+=`<div class="act-row"><div class="act-dot" style="background:${isC?'var(--cyan)':'var(--red)'}"></div><span class="text-muted">[P] <strong>${p.name}</strong>: ${Array.isArray(ans)?ans.map(a=>String.fromCharCode(65+a)).join(','):String.fromCharCode(65+ans)} <span class="${isC?'text-cyan':'text-red'}">${isC?'✓':'✗'}</span></span></div>`;});
  el.innerHTML=html||'<span class="text-muted text-sm">No answers yet.</span>';
}

function renderScoreboard(containerId){
  const teams=Store.getActiveTeams().sort((a,b)=>(b.score||0)-(a.score||0));
  const el=document.getElementById(containerId);if(!el) return;
  if(!teams.length){el.innerHTML='<div class="text-muted text-sm p-12">No active teams.</div>';return;}
  el.innerHTML=`<div class="sb-list">${teams.map((t,i)=>`<div class="sb-row"><span class="sb-rank r${i+1}">${i===0?'🥇':i===1?'🥈':i===2?'🥉':`#${i+1}`}</span><span class="sb-name">T${t.teamNumber}: ${t.name}<small class="text-muted"> ${t.correctCount||0}✓ ${(t.passedQs||[]).length}↩</small></span><span class="sb-pts">${t.score||0}</span></div>`).join('')}</div>`;
}

// ─── QUIZ FLOW ─────────────────────────────────────────────────
function quizStart(){
  const teams=Store.getActiveTeams(),questions=Store.getQuestions(),rounds=Store.getRounds(),settings=Store.getSettings();
  if(!teams.length){toast('No active teams!','error');return;}
  if(!questions.length){toast('No questions!','error');return;}
  if(!rounds.length){toast('No rounds!','error');return;}
  const needed=getTotalConfiguredQs(rounds);
  if(questions.length<needed&&!confirm(`Only ${questions.length}/${needed} questions. Continue?`)) return;

  // Reset everything
  load(KEYS.TEAMS,[]).forEach(t=>Store.updateTeam(t.id,{score:0,correctCount:0,answers:{},passedQs:[],roundScores:{}}));
  Store.saveParticipants([]);
  // Store.clearLoginStatus(); // Keep teams online when starting the quiz

  const r0=rounds[0];
  const quiz={
    status:'round_intro',
    currentRoundIdx:0, currentQInRound:0, globalQIdx:0,
    questionStartTeamIdx:0, currentTeamIdx:0,
    passChain:[], participantTurn:false, participantTimerStart:null,
    participantTimeLimit:settings.participantTimeLimit||30,
    timerStart:null, timerLimit:r0?.timePerQuestion||settings.defaultTimePerQuestion||60,
    roundTimerStart:null, roundTimeLimit:r0?.roundTimeLimit||0,
    competitionStart:Date.now(), overallTimeLimit:settings.overallTimeLimit||0,
    _timerEndHandled:false, _roundTimerEnded:false, _participantTimerHandled:false, _advancing:false,
  };
  Store.saveQuiz(quiz);
  Store.addActivity(`🚀 Quiz started! ${rounds.length} rounds, ${questions.length} Qs, ${teams.length} teams`,'success');
  toast('Quiz started! Round 1 intro shown.','success');
  renderControl();
}

function beginRound(){
  const quiz=Store.getQuiz(),rounds=Store.getRounds(),teams=Store.getActiveTeams();
  if(quiz.status!=='round_intro') return;
  const r=rounds[quiz.currentRoundIdx];
  const range=getRoundQRange(rounds,quiz.currentRoundIdx);
  // questionStartTeamIdx already set; currentTeamIdx = questionStartTeamIdx
  const q2={...quiz, status:'running', timerStart:Date.now(),
    timerLimit:r?.timePerQuestion||60, roundTimerStart:Date.now(),
    roundTimeLimit:r?.roundTimeLimit||0, _timerEndHandled:false, _roundTimerEnded:false, _advancing:false};
  Store.saveQuiz(q2);
  const t=teams[q2.currentTeamIdx];
  Store.addActivity(`▶ Round ${q2.currentRoundIdx+1} started → <strong>${t?.name}</strong>`,'success');
  toast(`Round ${q2.currentRoundIdx+1} started!`,'success');
  renderControl();
}

function quizPause(){ const quiz=Store.getQuiz(); quiz.status='paused'; quiz._pausedAt=Date.now(); quiz._timerEndHandled=false; Store.saveQuiz(quiz); toast('Paused.','warning'); renderControl(); }
function quizResume(){ const quiz=Store.getQuiz(); const dur=quiz._pausedAt?Date.now()-quiz._pausedAt:0; quiz.timerStart=(quiz.timerStart||Date.now())+dur; if(quiz.roundTimerStart)quiz.roundTimerStart+=dur; if(quiz.participantTimerStart)quiz.participantTimerStart+=dur; quiz.status='running'; quiz._timerEndHandled=false; delete quiz._pausedAt; Store.saveQuiz(quiz); toast('Resumed!','success'); renderControl(); }

function quizNext(){
  // Manual advance — treated as "move on regardless"
  advanceToNextQuestion();
  renderControl();
}

function endRound(){
  if(adminTimerIv) clearInterval(adminTimerIv);
  const quiz=Store.getQuiz(),rounds=Store.getRounds();
  const q2={...quiz,status:'round_end',_timerEndHandled:false,_advancing:false,passChain:[],participantTurn:false};
  Store.saveQuiz(q2);
  Store.addActivity(`🏁 Round ${quiz.currentRoundIdx+1} (${rounds[quiz.currentRoundIdx]?.name}) ended`,'success');
  toast(`Round ${quiz.currentRoundIdx+1} complete!`,'success');
  showRoundScores(quiz.currentRoundIdx);
  renderControl();
}

function showRoundScores(ri){ const rounds=Store.getRounds(),teams=Store.getActiveTeams().sort((a,b)=>(b.score||0)-(a.score||0)); document.getElementById('rs-title').textContent=`${rounds[ri]?.name||`Round ${ri+1}`} — COMPLETE!`; document.getElementById('rs-body').innerHTML=`<div class="sb-list mt-1">${teams.map((t,i)=>`<div class="sb-row" style="padding:10px 12px"><span class="sb-rank r${i+1}">${i===0?'🥇':i===1?'🥈':i===2?'🥉':`#${i+1}`}</span><span class="sb-name">T${t.teamNumber}: ${t.name}<small class="text-muted"> ${t.correctCount||0}✓</small></span><span class="sb-pts">${t.score||0}</span></div>`).join('')}</div><div class="text-center text-sm text-muted mt-2">${rounds[ri+1]?`Next: <strong class="text-gold">${rounds[ri+1].name}</strong>`:'🏆 All rounds complete!'}</div>`; openModal('modal-round-scores'); }

function nextRound(){
  const quiz=Store.getQuiz(),rounds=Store.getRounds(),teams=Store.getActiveTeams();
  const ni=quiz.currentRoundIdx+1;
  if(ni>=rounds.length){ 
    const q2={...quiz,status:'finished'}; 
    Store.saveQuiz(q2); 
    Store.addActivity('🏆 Quiz FINISHED! identifying winners...','success'); 
    toast('Quiz complete! Click ANNOUNCE WINNER.','success'); 
    renderControl(); 
    return; 
  }

  
  const curStage = rounds[quiz.currentRoundIdx]?.stage || 'Preliminary';
  const nextStage = rounds[ni]?.stage || 'Preliminary';
  
  if(curStage !== nextStage){
    customConfirm(`<div style="text-align:center"><div style="font-size:28px;margin-bottom:8px">⚡</div><div class="font-title" style="font-size:16px;color:var(--gold);margin-bottom:8px">${curStage.toUpperCase()} → ${nextStage.toUpperCase()}</div><div class="text-sm text-muted">You are transitioning to the <strong>${nextStage}</strong> stage. Currently <strong>${teams.length} active teams</strong> remain.<br><br>Make sure you have eliminated teams if needed before proceeding.</div></div>`, '⚡', () => {
      proceedToNextRound(quiz, rounds, teams, ni);
    });
    return;
  }
  
  proceedToNextRound(quiz, rounds, teams, ni);
}

function proceedToNextRound(quiz, rounds, teams, ni){
  const r=rounds[ni], range=getRoundQRange(rounds,ni);
  const nextStartTeam=(quiz.questionStartTeamIdx+1)%teams.length;
  const q2={...quiz, status:'round_intro', currentRoundIdx:ni, currentQInRound:0, globalQIdx:range.start,
    questionStartTeamIdx:nextStartTeam, currentTeamIdx:nextStartTeam,
    passChain:[], participantTurn:false, participantTimerStart:null,
    timerLimit:r?.timePerQuestion||60, _timerEndHandled:false, _roundTimerEnded:false, _advancing:false};
  Store.saveQuiz(q2);
  Store.addActivity(`📋 Round ${ni+1} (${r?.name}) — ${r?.stage || 'Preliminary'} Stage intro`,'info');
  toast(`Moving to ${r?.name} [${r?.stage || 'Preliminary'} Stage]!`,'info');
  renderControl();
}

function passToNext(){
  const quiz=Store.getQuiz(),teams=Store.getActiveTeams();
  if(!quiz||quiz.status!=='running') return;
  const cur=teams[quiz.currentTeamIdx];
  if(!quiz.passChain) quiz.passChain=[];
  if(cur&&!quiz.passChain.includes(cur.id)) quiz.passChain.push(cur.id);
  // Track on team
  if(cur){ const passedQs=(cur.passedQs||[]); if(!passedQs.includes(quiz.globalQIdx)) passedQs.push(quiz.globalQIdx); Store.updateTeam(cur.id,{passedQs}); }

  // LIMIT: Question only goes to ONE PASS TEAM after the starting team
  const passLimit = Math.min(2, teams.length);
  if(quiz.passChain.length >= passLimit){
    // ALL allowed teams passed → participant turn
    const settings=Store.getSettings();
    const q2={...quiz,status:'participant_turn',currentTeamIdx:-1,participantTurn:true,participantTimerStart:Date.now(),participantTimeLimit:settings.participantTimeLimit||30,_participantTimerHandled:false};
    Store.saveQuiz(q2);
    Store.addActivity(`📢 Max passes reached Q${quiz.currentQInRound+1} → PARTICIPANTS (${settings.participantTimeLimit||30}s)`,'warning');
    toast('Goes to participants!','warning');
    renderControl(); return;
  }

  // Next team in cyclic order that hasn't passed
  let next=(quiz.currentTeamIdx+1)%teams.length, loops=0;
  while(quiz.passChain.includes(teams[next]?.id)&&loops<teams.length){next=(next+1)%teams.length;loops++;}
  const q2={...quiz,currentTeamIdx:next,timerStart:Date.now(),_timerEndHandled:false};
  Store.saveQuiz(q2);
  Store.addActivity(`🔄 Q${quiz.currentQInRound+1} → <strong>${teams[next]?.name}</strong>`,'info');
  renderControl();
}

function quizReset(){
  customConfirm('<strong>RESET ENTIRE QUIZ?</strong><br>This will clear all scores and history!', '🔄', () => {
    if(adminTimerIv) clearInterval(adminTimerIv);
    Store.saveQuiz({...DEFAULT_QUIZ});
    load(KEYS.TEAMS,[]).forEach(t=>Store.updateTeam(t.id,{score:0,correctCount:0,answers:{},passedQs:[],roundScores:{}}));
    Store.saveParticipants([]); Store.clearLoginStatus();
    Store.addActivity('🔄 Quiz RESET','warning');
    toast('Tournament Reset!','warning'); renderControl();
  });
}

// ─── CAMERA MONITORING ────────────────────────────────────────
function renderCamera(){
  const monitored=Store.getMonitoredUsers(), camStatus=Store.getCamStatus();
  const alerts=Store.getAlerts().filter(a=>!a.dismissed);
  const el=document.getElementById('cam-grid');
  const alertsEl=document.getElementById('cam-alerts');

  if(!monitored.length){ el.innerHTML='<div class="empty-state">No active cameras.</div>'; return; }

  el.innerHTML=monitored.map(u=>{
    const cs=camStatus[u.id]||{};
    const frame=Store.getCamFrame(u.id);
    const lastSeen=cs.lastSeen?Math.floor((Date.now()-cs.lastSeen)/1000):null;
    const staleSec=30;
    const stale=lastSeen===null||lastSeen>staleSec;
    return `<div class="cam-card ${cs.suspicious?'cam-suspicious':''}">
      <div class="cam-head">
        <span class="font-title text-xs"><span class="badge ${u.monitorType==='TEAM'?'badge-gold':'badge-cyan'}" style="padding:1px 3px;font-size:8px;margin-right:4px">${u.ident}</span> ${u.name}</span>
        <div style="display:flex;gap:5px;align-items:center">
          ${cs.tabHidden?'<span class="badge badge-red" style="font-size:8px">TAB HIDDEN</span>':''}
          ${cs.suspicious?'<span class="badge badge-red" style="font-size:8px;animation:tflash .5s infinite">⚠ SUSPICIOUS</span>':''}
          <span class="login-dot ${stale?'dot-off':'dot-on'}" style="width:8px;height:8px"></span>
        </div>
      </div>
      <div class="cam-frame-wrap">
        ${frame&&!stale?`<img src="${frame}" class="cam-img" alt="${u.name} camera">`
          :`<div class="cam-offline"><span>${stale?'📷 Camera offline / no feed':'⏳ Waiting for feed...'}</span></div>`}
      </div>
      <div class="cam-foot text-xs text-muted">${lastSeen!==null?`Last seen: ${lastSeen}s ago`:'No connection'}</div>
    </div>`;
  }).join('');

  // Alerts
  if(alertsEl){
    alertsEl.innerHTML=alerts.length?alerts.map(a=>`
      <div class="alert-row ${a.dismissed?'alert-dim':''}">
        <div class="act-dot" style="background:var(--red);width:8px;height:8px;flex-shrink:0;border-radius:50%"></div>
        <div style="flex:1">
          <strong>${a.teamName}</strong>: ${a.msg}
          <span class="text-xs text-muted ml-1">${a.time}</span>
        </div>
        <button class="btn-sm btn-red" style="font-size:8px;padding:3px 8px" onclick="dismissAlert('${a.id}')">DISMISS</button>
        <button class="btn-sm" style="font-size:8px;padding:3px 8px" onclick="warnTeam('${a.teamId}')">WARN TEAM</button>
      </div>`).join(''):'<div class="text-muted text-sm p-12">No active alerts.</div>';
  }
  renderAlertsBadge();
}

function dismissAlert(id){ Store.dismissAlert(id); renderCamera(); }
function warnTeam(teamId){
  const t=Store.getTeamById(teamId);
  save('sq_team_warn_'+teamId, { msg:'⚠ Warning from admin: Suspicious activity detected on your device. Please focus on the quiz only.', time:Date.now() });
  toast(`Warning sent to ${t?.name}`,'warning');
  Store.addActivity(`⚠ Admin warned team <strong>${t?.name}</strong>`,'warning');
}

function startCamRefresh(){ stopCamRefresh(); renderCamera(); camRefreshIv=setInterval(renderCamera,2000); }
function stopCamRefresh(){ if(camRefreshIv){ clearInterval(camRefreshIv); camRefreshIv=null; } }

// ─── ACTIVITY ─────────────────────────────────────────────────
function renderActivityFeed(id,limit=60){
  const el=document.getElementById(id);if(!el)return;
  const list=Store.getActivity().slice(0,limit);
  const colors={success:'var(--green)',warning:'var(--gold)',error:'var(--red)',info:'var(--cyan)'};
  el.innerHTML=list.map(a=>`<div class="act-row"><div class="act-dot" style="background:${colors[a.type]||'var(--cyan)'}"></div><span class="act-time">${a.time}</span><span class="act-text">${a.text}</span></div>`).join('')||'<span class="text-muted text-sm">No activity.</span>'; 
}function renderActivity(){ renderActivityFeed('full-activity',200); }
function clearLog(){ if(!confirm('Clear?')) return; Store.clearActivity(); renderActivity(); }

// ─── SETTINGS ─────────────────────────────────────────────────
function loadSettings(){
  const sess = Store.getSession();
  const s = Store.getSettings();
  
  if (!sess.isSuper) {
    const u = Store.getUserById(sess.userId);
    if(u){
      document.getElementById('s-admin-user').value = u.username;
      document.getElementById('s-admin-pw').value = u.password;
    }
  } else {
    document.getElementById('s-admin-user').value = s.adminUsername || '';
    document.getElementById('s-admin-pw').value = s.adminPassword || '';
  }

  document.getElementById('s-captcha').value=s.captchaCode||''; 
  document.getElementById('s-q-time').value=s.defaultTimePerQuestion;
  document.getElementById('s-p-time').value=s.participantTimeLimit;
  document.getElementById('s-overall-time').value=s.overallTimeLimit;
  document.getElementById('s-instructions').value=s.globalInstructions;
  document.getElementById('s-ai-price').value=s.ai_request_price || 10;
  
  if(s.prizes){
    document.getElementById('s-prize-1').value = s.prizes[0] || '';
    document.getElementById('s-prize-2').value = s.prizes[1] || '';
    document.getElementById('s-prize-3').value = s.prizes[2] || '';
  }
}

function saveSettings(){
  const sess = Store.getSession();
  const s = Store.getSettings();
  const newU = document.getElementById('s-admin-user').value.trim();
  const newP = document.getElementById('s-admin-pw').value.trim();

  if (!sess.isSuper) {
    if(!newU || !newP){ toast('Username and Password cannot be empty', 'error'); return; }
    Store.updateUser(sess.userId, { username: newU, password: newP });
    Store.addActivity(`Admin <strong>${sess.name}</strong> updated their own credentials`, 'success');
  } else {
    s.adminUsername = newU || s.adminUsername;
    s.adminPassword = newP || s.adminPassword;
  }

  Store.saveSettings({
    ...s,
    captchaCode: document.getElementById('s-captcha').value.trim() || s.captchaCode,
    defaultTimePerQuestion: parseInt(document.getElementById('s-q-time').value) || 60,
    participantTimeLimit: parseInt(document.getElementById('s-p-time').value) || 30,
    overallTimeLimit: parseInt(document.getElementById('s-overall-time').value) || 0,
    ai_request_price: parseInt(document.getElementById('s-ai-price').value) || 10,
    globalInstructions: document.getElementById('s-instructions').value,
    prizes: [
      document.getElementById('s-prize-1').value,
      document.getElementById('s-prize-2').value,
      document.getElementById('s-prize-3').value
    ]
  });
  toast('Settings saved successfully','success');
}



// ─── MODALS ───────────────────────────────────────────────────
function openModal(id){ 
  const el = document.getElementById(id);
  if(el) el.classList.add('open'); 
}
function closeModal(id){ 
  const el = document.getElementById(id);
  if(el) el.classList.remove('open'); 
}

onUpdate(({key})=>{
  if(key===KEYS.QUIZ||key===KEYS.TEAMS||key===KEYS.LOGIN_STATUS || key.includes('sq_quiz_') || key.includes('sq_teams_')){ 
    if(currentSec==='control') renderControl(); 
    if(currentSec==='dashboard') renderDashboard(); 
    if(currentSec==='reports') renderReports();
  }
  if(key===KEYS.USERS){
    if(currentSec==='users') renderUsers();
  }
  if(key===KEYS.QUIZ_REQUESTS || key===KEYS.MANAGED_QUIZZES){
    if(currentSec==='quiz-requests') renderRequests();
    if(currentSec==='managed-admins') renderManaged();
    if(currentSec==='reports') renderReports();
    renderAlertsBadge();
  }
});

// ─── QUIZ REQUESTS ────────────────────────────────────────────
function renderRequests(){
  const reqs = Store.getQuizRequests();
  const el = document.getElementById('requests-table');
  if(!reqs.length){ el.innerHTML='<div class="empty-state">No requests yet.</div>'; return; }
  
  el.innerHTML=`<table class="dtable"><thead><tr><th>TIME</th><th>COLLEGE</th><th>CODE</th><th>PENDING ADMIN</th><th>STATUS</th><th>ACTIONS</th></tr></thead><tbody>`+
  reqs.map(r=>{
    const statusClass = r.status==='pending'?'badge-gold':r.status==='accepted'?'badge-green':'badge-red';
    return `<tr>
      <td class="text-xs text-muted">${new Date(r.time).toLocaleString()}</td>
      <td><strong>${r.collegeName}</strong></td>
      <td class="text-cyan font-mono text-xs">${r.collegeCode}</td>
      <td class="text-sm">${r.username}</td>
      <td><span class="badge ${statusClass}">${r.status.toUpperCase()}</span></td>
      <td>
        ${r.status==='pending' ? `
          <button class="btn-sm btn-green" onclick="openQuizAction('${r.id}','accept')">ACCEPT</button>
          <button class="btn-sm btn-red" onclick="openQuizAction('${r.id}','ignore')">IGNORE</button>
        ` : `<span class="text-xs text-muted">${r.reason||'Processed'}</span>`}
        <button class="btn-icon ml-1" onclick="deleteQuizRequest('${r.id}')" style="color:var(--red); font-size:14px">🗑️</button>
      </td>
    </tr>`;
  }).join('')+'</tbody></table>';
  
  const badge = document.getElementById('req-alert-badge');
  const count = reqs.filter(r=>r.status==='pending').length;
  if(badge){ badge.textContent=count; badge.classList.toggle('hidden', !count); }
}

function renderManaged(){
  const managed = Store.getManagedQuizzes();
  const el = document.getElementById('managed-table');
  if(!managed.length){ el.innerHTML='<div class="empty-state">No managed sessions yet.</div>'; return; }
  
  el.innerHTML=`<table class="dtable"><thead><tr><th>QUIZ ID</th><th>COLLEGE</th><th>ADMIN ID</th><th>EXPIRY (REMAINING)</th><th>STATUS</th><th>ACTIVITY</th><th>ACTIONS</th></tr></thead><tbody>`+
  managed.map(m=>{
    const isExpired = m.expiry && Date.now() > m.expiry;
    let timeRemaining = '-';
    if(m.expiry && !isExpired) {
      const diffStr = Math.max(0, Math.floor((m.expiry - Date.now())/60000));
      timeRemaining = `(${diffStr} mins left)`;
    }
    const isPaused = m.status === 'paused';
    
    return `<tr>
      <td class="font-title text-gold text-sm">${m.quizId}</td>
      <td><strong>${m.collegeName}</strong> <small class="text-muted">(${m.collegeCode})</small></td>
      <td class="text-xs font-mono">${m.adminId}</td>
      <td class="text-xs ${isExpired?'text-red':(isPaused?'text-gold':'text-green')}">
        ${m.expiry?new Date(m.expiry).toLocaleString():'NO LIMIT'} <br>
        <span style="font-weight:bold">${isExpired?'EXPIRED':timeRemaining}</span>
      </td>
      <td><span class="badge ${m.status==='active'?'badge-green':(m.status==='paused'?'badge-gold':'badge-gray')}">${m.status.toUpperCase()}</span></td>
      <td><button class="btn-sm btn-cyan" onclick="showAdminActivity('${m.quizId}')">VIEW</button></td>
      <td style="display:flex;gap:4px">
        <button class="btn-icon" onclick="toggleManagedStatus('${m.quizId}')" title="${isPaused ? 'Resume' : 'Pause'}">${isPaused ? '▶️' : '⏸️'}</button>
        <button class="btn-icon" onclick="openQuizAction('${m.quizId}','edit')">✏️</button>
        <button class="btn-icon" onclick="removeManagedQuiz('${m.quizId}')" style="color:var(--red)">🗑️</button>
      </td>
    </tr>`;
  }).join('')+'</tbody></table>';
}

function toggleManagedStatus(quizId){
  const managed = Store.getManagedQuizzes();
  const m = managed.find(x=>x.quizId===quizId); 
  if(!m) return;
  m.status = m.status === 'paused' ? 'active' : 'paused';
  Store.saveManagedQuizzes(managed);
  toast(`Session ${m.status === 'active' ? 'resumed' : 'paused'}`, 'success');
  renderManaged();
}

function showAdminActivity(quizId){
  const summary = Store.getQuizSummary(quizId);
  document.getElementById('ma-team-count').textContent = summary.teamCount;
  document.getElementById('ma-round').textContent = summary.round;
  
  const statusBox = document.getElementById('ma-status-box');
  statusBox.innerHTML = `
    <div class="info-row"><span>Current Status</span><span class="badge badge-cyan">${summary.status.toUpperCase()}</span></div>
    <div class="info-row"><span>Last Pulse</span><span>${summary.lastSeen}</span></div>
  `;
  
  const actFeed = document.getElementById('ma-activity');
  actFeed.innerHTML = summary.activities.length ? summary.activities.map(a => `
    <div class="act-row">
      <div class="act-dot" style="background:${a.type==='error'?'var(--red)':a.type==='success'?'var(--green)':'var(--cyan)'}"></div>
      <div class="act-time">${a.time}</div>
      <div class="act-text">${a.text}</div>
    </div>
  `).join('') : '<div class="empty-state">No activity Yet</div>';
  
  openModal('modal-managed-activity');
}

function openQuizAction(id, type){
  const reqs = Store.getQuizRequests();
  const managed = Store.getManagedQuizzes();
  const elD = document.getElementById('qam-details');
  const elT = document.getElementById('qam-title');
  const elFormA = document.getElementById('qam-form-accept');
  const elFormI = document.getElementById('qam-form-ignore');
  const elFormE = document.getElementById('qam-form-edit');
  
  document.getElementById('qam-id').value = id;
  document.getElementById('qam-type').value = type;
  document.getElementById('qam-err').textContent = '';
  
  [elFormA, elFormI, elFormE].forEach(f=>f.classList.add('hidden'));

  if(type==='accept' || type==='ignore'){
    const r = reqs.find(x=>x.id===id); if(!r) return;
    elT.textContent = type==='accept'?'APPROVE REQUEST':'IGNORE REQUEST';
    elD.innerHTML = `<div class="info-row"><span>College</span><span>${r.collegeName}</span></div>
                    <div class="info-row"><span>Username</span><span>${r.username}</span></div>`;
    if(type==='accept') elFormA.classList.remove('hidden');
    else elFormI.classList.remove('hidden');
  } else if(type==='edit'){
    const m = managed.find(x=>x.quizId===id); if(!m) return;
    elT.textContent = 'EDIT MANAGED SESSION';
    elD.innerHTML = `<div class="info-row"><span>Quiz ID</span><span class="text-gold">${m.quizId}</span></div>`;
    document.getElementById('qam-college').value = m.collegeName;
    document.getElementById('qam-code').value = m.collegeCode;
    if(m.expiry) document.getElementById('qam-expiry-edit').value = new Date(m.expiry - (new Date().getTimezoneOffset()*60000)).toISOString().slice(0,16);
    document.getElementById('qam-status').value = m.status;
    elFormE.classList.remove('hidden');
  }
  
  openModal('modal-quiz-action');
}

function advanceToNextQuestion(overrideCycleHalt = false){
  const quiz=Store.getQuiz(), teams=Store.getActiveTeams(), rounds=Store.getRounds(), settings=Store.getSettings();
  if(!quiz||quiz.status==='finished') return;

  const nextGQ = quiz.globalQIdx + 1;
  const range = getRoundQRange(rounds, quiz.currentRoundIdx);
  const isEndRound = (quiz.currentQInRound + 1) >= range.count;

  if(isEndRound){
     endRound();
     return;
  }

  const nextQInRound = quiz.currentQInRound + 1;
  const teamsCount = teams.length;

  // --- CYCLE COMPLETENESS CHECK ---
  if (!overrideCycleHalt && nextQInRound % teamsCount === 0) {
     const questionsRemaining = range.count - nextQInRound;
     if (questionsRemaining > 0 && questionsRemaining < teamsCount) {
        quiz.status = 'paused';
        Store.saveQuiz(quiz);
        window.dispatchEvent(new CustomEvent('quiz_cycle_halt', { 
          detail: { remaining: questionsRemaining, teamsCount } 
        }));
        return;
     }
  }

  const nextStartTeam = (quiz.questionStartTeamIdx + 1) % teamsCount;
  const r = rounds[quiz.currentRoundIdx];

  const q2 = {
    ...quiz,
    status: 'running',
    globalQIdx: nextGQ,
    currentQInRound: nextQInRound,
    questionStartTeamIdx: nextStartTeam,
    currentTeamIdx: nextStartTeam,
    passChain: [],
    participantTurn: false,
    participantTimerStart: null,
    timerStart: Date.now(),
    timerLimit: r?.timePerQuestion || settings.defaultTimePerQuestion || 60,
    _timerEndHandled: false,
    _participantTimerHandled: false,
    _advancing: false
  };

  Store.saveQuiz(q2);
  Store.addActivity(`⏭ Moving to Q${q2.currentQInRound+1} → <strong>${teams[nextStartTeam]?.name}</strong>`, 'info');
  toast(`Question ${q2.currentQInRound+1}!`, 'info');
  renderControl();
}

function submitQuizAction(){
  const id = document.getElementById('qam-id').value;
  const type = document.getElementById('qam-type').value;
  const err = document.getElementById('qam-err');
  
  if(type==='accept'){
    const expiryStr = document.getElementById('qam-expiry').value;
    if(!expiryStr){ err.textContent='Please select an expiration time.'; return; }
    const expiry = new Date(expiryStr).getTime();
    actionAccept(id, expiry);
  } else if(type==='ignore'){
    const reason = document.getElementById('qam-reason').value.trim();
    if(!reason){ err.textContent='Reason is required.'; return; }
    actionIgnore(id, reason);
  } else if(type==='edit'){
    const collegeName = document.getElementById('qam-college').value.trim();
    const collegeCode = document.getElementById('qam-code').value.trim();
    const expiryStr = document.getElementById('qam-expiry-edit').value;
    const status = document.getElementById('qam-status').value;
    if(!collegeName || !collegeCode){ err.textContent='College info required.'; return; }
    actionEdit(id, { collegeName, collegeCode, expiry: expiryStr?new Date(expiryStr).getTime():null, status });
  }
}

function actionAccept(reqId, expiry){
  const reqs = Store.getQuizRequests();
  const idx = reqs.findIndex(x=>x.id===reqId); if(idx===-1) return;
  const r = reqs[idx];
  
  // 1. Mark request as accepted
  r.status = 'accepted';
  Store.saveQuizRequests(reqs);
  
  // 2. Generate Quiz ID
  const quizId = Store.generateQuizId();
  const adminId = genId();

  // 3. Create Admin user with Quiz ID link
  Store.addUser({
    id: adminId,
    name: r.collegeName + ' Admin',
    roll: r.collegeCode,
    college: r.collegeName, // Added for backend institutional isolation
    username: r.username,
    password: r.password,
    role: 'admin',
    currentQuizId: quizId,
    registeredAt: Date.now()
  });
  
  // 4. Add to Managed
  Store.addManagedQuiz({
    quizId,
    adminId,
    collegeName: r.collegeName,
    collegeCode: r.collegeCode,
    expiry,
    status: 'active'
  });
  
  Store.addActivity(`Quiz <strong>${quizId}</strong> approved for <strong>${r.collegeName}</strong>`,'success');
  toast(`Approved! Generated Quiz ID: ${quizId}`, 'success');
  closeModal('modal-quiz-action');
  renderRequests();
  renderUsers();
  renderManaged();
}

function actionIgnore(reqId, reason){
  const reqs = Store.getQuizRequests();
  const r = reqs.find(x=>x.id===reqId); if(!r) return;
  r.status = 'ignored';
  r.reason = reason;
  Store.saveQuizRequests(reqs);
  Store.addActivity(`Quiz request from <strong>${r.collegeName}</strong> ignored: ${reason}`,'warning');
  toast('Request ignored','warning');
  closeModal('modal-quiz-action');
  renderRequests();
}

function actionEdit(quizId, patch){
  const managed = Store.getManagedQuizzes();
  const m = managed.find(x=>x.quizId===quizId); if(!m) return;
  Object.assign(m, patch);
  Store.saveManagedQuizzes(managed);
  toast('Session updated','success');
  closeModal('modal-quiz-action');
  renderManaged();
}

function removeManagedQuiz(quizId){
  customConfirm(`Remove session <strong>${quizId}</strong>?<br>This will stop the session but keep current data.`, '🗑️', () => {
    Store.saveManagedQuizzes(Store.getManagedQuizzes().filter(x=>x.quizId!==quizId));
    toast('Session removed','warning');
    renderManaged();
  });
}

// ─── REPORTS ──────────────────────────────────────────────────
function getConsolidatedReportData(){
  const managed = Store.getManagedQuizzes();
  const users = Store.getUsers();
  
  return managed.map(m => {
    const qid = m.quizId;
    const quizState = load(`${KEYS.QUIZ}_${qid}`, DEFAULT_QUIZ);
    const teams = load(`${KEYS.TEAMS}_${qid}`, []);
    const rounds = load(`${KEYS.ROUNDS}_${qid}`, []);
    const questions = load(`${KEYS.QUESTIONS}_${qid}`, []);
    
    // Find Administrative context
    const adminUser = users.find(u => u.id === m.adminId);
    const adminName = adminUser ? adminUser.name : 'Unknown';
    
    // Calculate Winner
    const sortedTeams = [...teams].sort((a,b) => (b.score||0) - (a.score||0));
    const winner = sortedTeams.length ? sortedTeams[0] : null;
    
    return {
      quizId: qid,
      admin: adminName,
      college: m.collegeName,
      status: quizState.status,
      teamCount: teams.length,
      roundCount: rounds.length,
      questionCount: questions.length,
      winnerName: winner ? winner.name : 'N/A',
      winnerScore: winner ? (winner.score || 0) : 0
    };
  });
}

function renderReports(){
  const data = getConsolidatedReportData();
  const tbody = document.getElementById('reports-body');
  if(!tbody) return;
  
  if(!data.length){
    tbody.innerHTML = '<tr><td colspan="8" class="text-center text-muted p-12">No quiz data found to report.</td></tr>';
    return;
  }
  
  tbody.innerHTML = data.map(r => `
    <tr>
      <td class="font-title text-gold text-sm">${r.quizId}</td>
      <td>
        <div class="font-title text-xs text-white">${r.admin.toUpperCase()}</div>
        <div class="text-xs text-muted">${r.college}</div>
      </td>
      <td class="text-center"><span class="badge badge-cyan">${r.teamCount}</span></td>
      <td class="text-center"><span class="badge badge-purple">${r.roundCount}</span></td>
      <td class="text-center"><span class="badge badge-gold">${r.questionCount}</span></td>
      <td><span class="badge ${r.status==='finished'?'badge-green':'badge-gray'}">${r.status.toUpperCase()}</span></td>
      <td class="text-cyan"><strong>${r.winnerName}</strong></td>
      <td class="text-green font-title">${r.winnerScore}</td>
      <td>
        <button class="btn-icon" onclick="downloadIndividualReport('${r.quizId}')" title="Summary CSV">📊</button>
        <button class="btn-icon" onclick="downloadDetailedCSV('${r.quizId}')" title="Detailed Grid CSV" style="color:var(--purple)">📑</button>
      </td>
    </tr>
  `).join('');
}

function downloadIndividualReport(quizId){
  const data = getConsolidatedReportData().find(r => r.quizId === quizId);
  if(!data){ toast('No data for this quiz', 'error'); return; }
  
  const headers = ['METRIC', 'VALUE'];
  const rows = [
    ['QUIZ ID', data.quizId],
    ['ADMIN', data.admin],
    ['COLLEGE', data.college],
    ['STATUS', data.status.toUpperCase()],
    ['TOTAL TEAMS', data.teamCount],
    ['TOTAL ROUNDS', data.roundCount],
    ['TOTAL QUESTIONS', data.questionCount],
    ['WINNER NAME', data.winnerName],
    ['WINNER SCORE', data.winnerScore]
  ];
  
  // Also add detailed team scores
  const teams = Store.getTeams(quizId);
  if(teams.length){
    rows.push(['---', '---']);
    rows.push(['TEAM NAME', 'SCORE']);
    teams.forEach(t => {
      rows.push([t.name, t.score || 0]);
    });
  }

  const csvContent = [
    headers.join(','),
    ...rows.map(row => row.map(cell => `"${cell}"`).join(','))
  ].join('\n');
  
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', `Quiz_Report_${quizId}_${new Date().toISOString().slice(0,10)}.csv`);
  link.style.visibility = 'hidden';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  toast('Individual report downloaded!', 'success');
}

function downloadDetailedCSV(quizId) {
  const ps = Store.getParticipants(quizId);
  const qs = Store.getQuestions(quizId);
  if(!ps.length) { toast('No participant data for this quiz.', 'warning'); return; }

  let csv = "Roll Number,Name," + qs.map((_, i) => `Q${i+1}`).join(",") + ",Total,Percentage\n";
  ps.forEach(p => {
    let total = 0;
    const ans = p.answers || {};
    const row = [p.roll || p.username, p.name];
    qs.forEach((q, i) => {
      const res = ans[i];
      if(res && res.ok) total++;
      row.push(res ? (res.ok ? "1" : "0") : "—");
    });
    row.push(total);
    row.push(qs.length ? ((total / qs.length) * 100).toFixed(2) + "%" : "0%");
    csv += row.join(",") + "\n";
  });

  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `detailed_report_${quizId}_${Date.now()}.csv`;
  a.click();
  toast('Detailed report exported!', 'success');
}

function downloadFullReport(){
  const data = getConsolidatedReportData();
  if(!data.length){ toast('No data to export', 'error'); return; }
  
  const headers = ['QUIZ ID', 'ADMIN', 'COLLEGE', 'STATUS', 'TEAMS', 'ROUNDS', 'QUESTIONS', 'WINNER', 'WINNER SCORE'];
  const csvContent = [
    headers.join(','),
    ...data.map(r => [
      r.quizId,
      `"${r.admin}"`,
      `"${r.college}"`,
      r.status.toUpperCase(),
      r.teamCount,
      r.roundCount,
      r.questionCount,
      `"${r.winnerName}"`,
      r.winnerScore
    ].join(','))
  ].join('\n');
  
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', `Consolidated_Quiz_Report_${new Date().toISOString().slice(0,10)}.csv`);
  link.style.visibility = 'hidden';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  toast('Report downloaded!', 'success');
}

document.querySelectorAll('.modal-bg').forEach(m=>m.addEventListener('click',e=>{ if(e.target===m) m.classList.remove('open'); }));

// Show ROOT Unique ID for testing
(function(){
  const rootId = 'SA-' + Math.random().toString(36).substr(2, 4).toUpperCase();
  const el = document.getElementById('sb-root-id');
  if(el) el.textContent = `ROOT ID: ${rootId}`;
})();

function renderCommandTargets(){
  const teams = Store.getActiveTeams();
  const sel = document.getElementById('cmd-target-team');
  if(!sel) return;
  const cur = sel.value;
  sel.innerHTML = '<option value="">All Active Teams</option>' + 
    teams.map(t => `<option value="${t.id}" ${t.id===cur?'selected':''}>T${t.teamNumber}: ${t.name}</option>`).join('');
}

function sendGlobalMsg(){
  const msg = document.getElementById('cmd-broadcast-msg').value.trim();
  if(!msg) return;
  window.socket.emit('admin_cmd', { type: 'msg', target: 'all', msg });
  document.getElementById('cmd-broadcast-msg').value = '';
  toast('Global message sent', 'success');
  Store.addActivity(`📢 Superadmin Broadcast: ${msg}`, 'info');
}

function cmdAction(action){
  const target = document.getElementById('cmd-target-team').value;
  const msgInput = document.getElementById('cmd-broadcast-msg');
  const msg = msgInput.value.trim();
  
  if(action === 'hold'){
    const quiz = Store.getQuiz();
    if(!quiz.holdStatus) quiz.holdStatus = {};
    const currentStatus = !!quiz.holdStatus[target];
    quiz.holdStatus[target] = !currentStatus;
    Store.saveQuiz(quiz);
    window.socket.emit('admin_cmd', { type: 'hold', target, status: !currentStatus });
    toast(`${target ? 'Team' : 'All teams'} ${!currentStatus ? 'HELD' : 'RELEASED'}`, 'warning');
    Store.addActivity(`🛑 Superadmin ${!currentStatus ? 'held' : 'released'} ${target || 'all teams'}`, 'warning');
    return;
  }

  if(!msg && (action === 'warn' || action === 'msg')) {
    toast('Please enter a message first', 'error');
    return;
  }

  window.socket.emit('admin_cmd', { type: action, target: target || 'all', msg });
  msgInput.value = '';
  toast(`${action.toUpperCase()} sent`, 'success');
  Store.addActivity(`⚠️ Superadmin ${action}: ${msg} (Target: ${target || 'All'})`, 'warning');
}

// ─── MIC BROADCAST (PTT) ─────────────────────────────────────
let mediaRecorder = null;
let audioChunks = [];

async function startMicBroadcast(){
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(stream);
    audioChunks = [];
    
    mediaRecorder.ondataavailable = e => { if(e.data.size > 0) audioChunks.push(e.data); };
    mediaRecorder.onstop = () => {
      const blob = new Blob(audioChunks, { type: 'audio/webm' });
      const target = document.getElementById('cmd-target-team')?.value || 'all';
      const reader = new FileReader();
      reader.onload = () => {
        window.socket.emit('admin_audio', { audio: reader.result, target });
      };
      reader.readAsDataURL(blob);
      stream.getTracks().forEach(t => t.stop());
    };
    
    mediaRecorder.start();
    document.getElementById('btn-admin-mic').style.boxShadow = '0 0 15px var(--red)';
    document.getElementById('btn-admin-mic').style.transform = 'scale(1.2)';
    Store.addActivity('🎤 Superadmin speaking...', 'warning');
  } catch(e) {
    toast('Mic error: ' + e.message, 'error');
  }
}

function stopMicBroadcast(){
  if(mediaRecorder && mediaRecorder.state !== 'inactive'){
    mediaRecorder.stop();
    document.getElementById('btn-admin-mic').style.boxShadow = 'none';
    document.getElementById('btn-admin-mic').style.transform = 'scale(1)';
  }
}


function adminLogout(){ 
  const sess = Store.getSession();
  if(sess && sess.rid) Store.updateLogout(sess.rid);
  Store.clearSession(); 
  window.location.href='/index.html'; 
}

// ─── ADMIN PERFORMANCE ANALYTICS ──────────────────────────────
async function renderAdminPerf(){
  const el = document.getElementById('admin-perf-body');
  if(!el) return;
  el.innerHTML = '<tr><td colspan="6" class="p-12 text-center">AGGREGATING ANALYTICS...</td></tr>';
  
  try {
    const resp = await fetch('/api/admin-perf');
    const res = await resp.json();
    if(res.success && res.data){
      if(!res.data.length){
        el.innerHTML = '<tr><td colspan="6" class="p-12 text-center text-muted">No quiz activity data found to generate reports.</td></tr>';
        return;
      }
      el.innerHTML = res.data.map(a => `
        <tr>
          <td><strong>${a.name}</strong></td>
          <td><span class="badge badge-purple">${a.college}</span></td>
          <td class="text-center"><strong>${a.quizCount}</strong></td>
          <td class="text-center">${a.totalTeams}</td>
          <td class="text-muted text-xs">${new Date(a.lastActivity).toLocaleString()}</td>
          <td><button class="btn-sm btn-cyan" onclick="viewAdminHistory('${a.name}')">HISTORY</button></td>
        </tr>
      `).join('');
    } else {
      el.innerHTML = '<tr><td colspan="6" class="p-12 text-center text-red">Server error.</td></tr>';
    }
  } catch(e){
    el.innerHTML = '<tr><td colspan="6" class="p-12 text-center text-red">Error connecting to server.</td></tr>';
  }
}

function viewAdminHistory(name){
  toast(`Loading conduct history for ${name}...`, 'info');
  goSection('reports');
}

function exportAdminPerf(){
  toast('Admin Performance CSV Exported!', 'success');
}
 


// AI QUESTION GENERATOR LOGIC

function openAIGenForRound(idx) {
  goSection('questions');
  openAIGenModal();
  setTimeout(() => {
    const sel = document.getElementById('ai-round');
    if(sel) {
      sel.value = idx;
      onAIRoundChange();
    }
  }, 100);
}

function openAIGenModal(){
  const managed = Store.getManagedQuizzes();
  const targetSel = document.getElementById('ai-target-quiz');
  if(targetSel){
    targetSel.innerHTML = '<option value="global">GLOBAL BANK (Shared)</option>' + 
      managed.map(q => `<option value="${q.quizId}">${q.quizId}: ${q.collegeName || 'Admin'}</option>`).join('');
  }
  onAITargetChange();
  document.getElementById('ai-preview-area').classList.add('hidden');
  document.getElementById('ai-preview-list').innerHTML = '';
  openModal('modal-ai-gen');
}

function onAITargetChange(){
  const target = document.getElementById('ai-target-quiz').value;
  const roundSel = document.getElementById('ai-round');
  const rounds = (target === 'global') ? [] : (load(`sq_rounds_${target}`, []));
  
  if(roundSel) {
    if(!rounds.length){
      roundSel.innerHTML = '<option value="">BANK (No rounds in this quiz)</option>';
    } else {
      roundSel.innerHTML = '<option value="">BANK (Manual Assignment)</option>' + 
        rounds.map((r,i)=>`<option value="${i}">R${r.roundNumber||i+1}: ${r.name} (${r.questionCount||0} Qs)</option>`).join('');
    }
  }
  onAIRoundChange();
}

function onAIRoundChange() {
  const target = document.getElementById('ai-target-quiz').value;
  const roundIdx = document.getElementById('ai-round').value;
  const countInput = document.getElementById('ai-count');
  const btn = document.getElementById('btn-ai-gen');

  if(roundIdx !== '') {
    const rounds = (target === 'global') ? [] : (load(`sq_rounds_${target}`, []));
    const r = rounds[parseInt(roundIdx)];
    if(r && r.questionCount) {
      countInput.value = r.questionCount;
      btn.textContent = `GENERATE ${r.questionCount} QUESTIONS FOR "${r.name.toUpperCase()}"`;
    } else {
      countInput.value = 5;
      btn.textContent = `GENERATE 5 QUESTIONS`;
    }
  } else {
    countInput.value = 5;
    btn.textContent = `GENERATE QUESTIONS (BANK)`;
  }
}

async function generateAIQuestions() {
  const topic = document.getElementById('ai-topic').value.trim();
  const count = document.getElementById('ai-count').value;
  const difficulty = document.getElementById('ai-difficulty').value;
  const err = document.getElementById('ai-err');
  const btn = document.getElementById('btn-ai-gen');
  const loader = document.getElementById('ai-loading');
  const preview = document.getElementById('ai-preview-area');
  
  if(!topic) { err.textContent = 'Please enter a subject/topic.'; return; }
  
  err.textContent = '';
  btn.disabled = true;
  loader.classList.remove('hidden');
  preview.classList.add('hidden');

  try {
    const token = localStorage.getItem('sq_token');
    const response = await fetch('/api/ai/generate', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ topic, count, difficulty })
    });
    
    // Ensure we are getting JSON back
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      const txt = await response.text();
      console.error('[AI] Non-JSON response:', txt.substring(0, 200));
      throw new Error('Server returned HTML instead of JSON. Check backend logs.');
    }

    const res = await response.json();
    if (res.requirePayment) {
      toast('Free limit reached. Proceeding to payment...', 'warning');
      await handleRazorpayPayment(topic, count, difficulty);
      return;
    }
    
    if(!res.success) throw new Error(res.message);
    
    // VERIFY data structure from server
    if (!res.questions || !Array.isArray(res.questions)) {
       throw new Error('Invalid data format received from AI server.');
    }

    aiQuestions = res.questions;
    renderAIPreview();
    preview.classList.remove('hidden');
    // Scroll to preview
    setTimeout(() => preview.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
    toast(`Successfully generated ${aiQuestions.length} questions!`, 'success');
  } catch(e) {
    err.textContent = 'AI Error: ' + e.message;
    toast('AI Generation Failed', 'error');
  } finally {
    loader.classList.add('hidden');
    btn.disabled = false;
  }
}

async function handleRazorpayPayment(topic, count, difficulty) {
  const btn = document.getElementById('btn-ai-gen');
  const loader = document.getElementById('ai-loading');
  const preview = document.getElementById('ai-preview-area');
  const err = document.getElementById('ai-err');
  
  try {
    // 1. Create Order
    const token = localStorage.getItem('sq_token');
    const orderResp = await fetch('http://localhost:5000/py-api/payment/create_order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ topic, count, difficulty })
    });
    
    const orderData = await orderResp.json();
    if (!orderData.success) throw new Error(orderData.detail || 'Failed to create payment order');
    
    // 2. Load Razorpay Script dynamically if not present
    if (!window.Razorpay) {
      await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://checkout.razorpay.com/v1/checkout.js';
        script.onload = resolve;
        script.onerror = reject;
        document.body.appendChild(script);
      });
    }
    
    // 3. Open Razorpay Checkout
    const options = {
      key: orderData.key_id,
      amount: orderData.amount,
      currency: orderData.currency,
      name: "Quiz Application",
      description: "AI Question Generation Request",
      order_id: orderData.order_id,
      handler: async function (response) {
        try {
          loader.classList.remove('hidden');
          // 4. Verify Payment on Backend
          const verifyResp = await fetch('http://localhost:5000/py-api/payment/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({
              razorpay_order_id: response.razorpay_order_id,
              razorpay_payment_id: response.razorpay_payment_id,
              razorpay_signature: response.razorpay_signature
            })
          });
          
          const verifyData = await verifyResp.json();
          if (!verifyData.success) throw new Error(verifyData.detail || verifyData.message || 'Payment verification failed');
          
          aiQuestions = verifyData.questions;
          renderAIPreview();
          preview.classList.remove('hidden');
          setTimeout(() => preview.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
          toast(`Payment successful! Generated ${aiQuestions.length} questions!`, 'success');
        } catch (e) {
          err.textContent = 'Verification Error: ' + e.message;
          toast('Verification Failed', 'error');
        } finally {
          loader.classList.add('hidden');
          btn.disabled = false;
        }
      },
      prefill: {
        name: "Superadmin",
        email: "superadmin@example.com",
        contact: "9999999999"
      },
      theme: {
        color: "#d4af37"
      }
    };
    
    const rzp = new window.Razorpay(options);
    rzp.on('payment.failed', function (response){
      err.textContent = 'Payment Failed: ' + response.error.description;
      toast('Payment Failed', 'error');
      loader.classList.add('hidden');
      btn.disabled = false;
    });
    rzp.open();
    
  } catch (e) {
    err.textContent = 'Payment Error: ' + e.message;
    toast('Payment Setup Failed', 'error');
    loader.classList.add('hidden');
    btn.disabled = false;
  }
}

function renderAIPreview(){
  const list = document.getElementById('ai-preview-list');
  const preview = document.getElementById('ai-preview-area');
  
  if(!aiQuestions || !aiQuestions.length){
    list.innerHTML = '<div class="empty-state">No questions generated. Try a different topic.</div>';
    return;
  }

  const diffMap = { 
    easy: {lbl:'EASY', cls:'badge-green'}, 
    medium: {lbl:'MEDIUM', cls:'badge-gold'}, 
    hard: {lbl:'HARD', cls:'badge-red'},
    "Easy (Recall)": {lbl:'EASY', cls:'badge-green'},
    "Medium (Applied)": {lbl:'MEDIUM', cls:'badge-gold'},
    "Hard (Advanced)": {lbl:'HARD', cls:'badge-red'}
  };
  
  list.innerHTML = aiQuestions.map((q, i) => {
    const dAttr = q.difficulty || document.getElementById('ai-difficulty').value;
    const d = diffMap[dAttr] || diffMap.medium;
    return `<div class="ai-q-card" style="display:block !important; visibility:visible !important; opacity:1 !important">
      <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:8px">
        <span><span class="ai-q-num">${i+1}</span> <strong style="color:var(--txt)">${q.text}</strong></span>
        <span class="badge ${d.cls}" style="font-size:9px">${d.lbl}</span>
      </div>
      <div class="opts-grid" style="margin-left:28px">
        ${q.options.map((opt, oi) => `
          <div class="ai-opt ${q.correct.includes(oi) ? 'correct' : ''}">
            <strong>${String.fromCharCode(65+oi)}.</strong> ${opt} ${q.correct.includes(oi) ? '✓' : ''}
          </div>
        `).join('')}
      </div>
      ${q.explanation ? `<div class="ai-expl" style="margin-left:28px; color:var(--muted); font-size:11px">💡 ${q.explanation}</div>` : ''}
    </div>`;
  }).join('');
  preview.classList.remove('hidden');
}

// ─── BULK ACTIONS ─────────────────────────────────────────────
function toggleSelectAll(type, checked){
  document.querySelectorAll(`.chk-${type.slice(0,-1)}`).forEach(c => c.checked = checked);
  onSelectRow(type);
}

function onSelectRow(type){
  const checked = document.querySelectorAll(`.chk-${type.slice(0,-1)}:checked`);
  const btn = document.getElementById(`btn-${type}-delete-multi`);
  if(btn) btn.classList.toggle('hidden', checked.length === 0);
  const allChk = document.getElementById(`chk-${type}-all`);
  if(allChk) {
    const total = document.querySelectorAll(`.chk-${type.slice(0,-1)}`).length;
    allChk.checked = total > 0 && checked.length === total;
  }
}

function deleteSelectedRounds(){
  const checked = [...document.querySelectorAll('.chk-round:checked')].map(c => c.value);
  if(!checked.length) return;
  customConfirm(`Delete <strong>${checked.length} selected rounds</strong>?`, '🗑️', () => {
    Store.saveRounds(Store.getRounds().filter(r => !checked.includes(r.id)));
    toast('Rounds deleted', 'warning');
    renderRounds();
  });
}

// ─── PAYMENTS ─────────────────────────────────────────────────
async function loadPayments() {
  const tbody = document.getElementById('payments-body');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="6" class="text-center p-12 text-muted">Loading payments...</td></tr>';
  try {
    const token = localStorage.getItem('sq_token');
    const res = await fetch('http://localhost:5000/py-api/payments', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.detail || 'Failed to load');
    
    if (!data.payments || data.payments.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="text-center p-12 text-muted">No payments found.</td></tr>';
      return;
    }
    
    tbody.innerHTML = data.payments.map(p => `
      <tr>
        <td class="text-xs text-muted">${new Date(p.created_at).toLocaleString()}</td>
        <td class="font-title text-gold">${p.order_id}</td>
        <td>${p.user_id}</td>
        <td class="text-xs">${p.topic || '-'} (${p.count || 0})</td>
        <td class="text-green font-title">₹${(p.amount / 100).toFixed(2)}</td>
        <td>
          <span class="badge ${p.status === 'paid' ? 'badge-green' : (p.status === 'failed' ? 'badge-red' : 'badge-gold')}">${p.status.toUpperCase()}</span>
        </td>
      </tr>
    `).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" class="text-center p-12 text-red">Error: ${err.message}</td></tr>`;
  }
}

function resetAllRounds(){
  customConfirm('<strong>Delete ALL rounds</strong> and clear question bank?', '🔄', () => {
    Store.saveRounds([]);
    Store.saveQuestions([]);
    toast('Quiz cleared', 'warning');
    renderRounds(); renderQuestions();
  });
}

function deleteSelectedQuestions(){
  const checked = [...document.querySelectorAll('.chk-question:checked')].map(c => c.value);
  if(!checked.length) return;
  customConfirm(`Delete <strong>${checked.length} selected questions</strong>?`, '🗑️', () => {
    Store.saveQuestions(Store.getQuestions().filter(q => !checked.includes(q.id)));
    toast('Questions deleted', 'warning');
    renderQuestions();
  });
}

function resetAllQuestions(){
  customConfirm('<strong>Delete ALL questions</strong> from the bank?', '🔄', () => {
    Store.saveQuestions([]);
    toast('Bank cleared', 'warning');
    renderQuestions();
  });
}


function addAllAIToBank(){
  const target = document.getElementById('ai-target-quiz').value;
  const roundIdx = document.getElementById('ai-round').value;
  
  const qKey = (target === 'global') ? 'sq_questions' : `sq_questions_${target}`;
  const rKey = (target === 'global') ? 'sq_rounds' : `sq_rounds_${target}`;
  
  let questions = load(qKey, []);
  let rounds = load(rKey, []);
  
  if(!aiQuestions || !aiQuestions.length){
    toast('No questions found to add!', 'error');
    return;
  }

  let insertIdx = questions.length;
  if(roundIdx !== ''){
    const ri = parseInt(roundIdx);
    const range = getRoundQRange(rounds, ri);
    
    // FILL GAPS: If the target round starts beyond current length, pad with placeholders
    // to maintain strict positional isolation.
    if(questions.length < range.start) {
      const paddingCount = range.start - questions.length;
      const placeholders = Array.from({length: paddingCount}, (_, k) => ({
        id: 'PLACEHOLDER_' + Math.random().toString(36).substr(2, 5).toUpperCase(),
        text: '--- Pending Question Assignment ---',
        options: ['','','',''],
        correct: [0],
        type: 'single',
        isPlaceholder: true
      }));
      questions.push(...placeholders);
    }

    // Remove existing questions in that range first to prevent "merging/spilling"
    const countToRemove = Math.min(questions.length - range.start, range.count);
    if (countToRemove > 0) {
      questions.splice(range.start, countToRemove);
    }
    insertIdx = range.start;
  }

  // Create proper question objects
  const toAdd = aiQuestions.map(q => ({
    id: 'Q_' + Math.random().toString(36).substr(2, 9).toUpperCase(),
    text: q.text,
    options: q.options,
    correct: q.correct,
    type: q.correct.length > 1 ? 'multiple' : 'single',
    explanation: q.explanation || '',
    difficulty: q.difficulty || document.getElementById('ai-difficulty').value
  }));

  questions.splice(insertIdx, 0, ...toAdd);
  save(qKey, questions);
  
  toast(`Successfully added ${toAdd.length} questions to ${target}!`, 'success');
  Store.addActivity(`🤖 AI Import: Added ${toAdd.length} questions for topic "${document.getElementById('ai-topic').value}" to ${target}`, 'success', true);
  closeModal('modal-ai-gen');
  if(target === (Store.getSession()?.quizId || 'global')){
    if(typeof renderQuestions === 'function') renderQuestions();
  }
}

function openLiveFeed(){ window.open('/live-feed.html', '_blank'); }

function announceWinner(){
  const teams = Store.getActiveTeams().sort((a,b) => (b.score||0)-(a.score||0));
  if(!teams.length) return toast('No teams to announce!', 'error');
  const winner = teams[0];
  window.socket.emit('admin_cmd', { type: 'winner', target: 'all', teamName: winner.name, score: winner.score });
  toast(`Winner Announced: ${winner.name}!`, 'success');
  Store.addActivity(`🏆 FINAL WINNER ANNOUNCED: ${winner.name} (${winner.score} pts)`, 'success');
}

// ─── FINAL INITIALIZATION ─────────────────────────────────────
function customConfirm(msg, icon, onYes){
  const elMsg = document.getElementById('conf-msg');
  const elIcon = document.getElementById('conf-icon');
  if(elMsg) elMsg.innerHTML = msg;
  if(elIcon) elIcon.textContent = icon || '❓';
  const btn = document.getElementById('btn-conf-yes');
  if(btn) btn.onclick = () => { onYes(); closeModal('modal-confirm'); };
  openModal('modal-confirm');
}

// Start app
goSection('dashboard');
renderOptFields();

// Global tick for real-time updates
setInterval(()=>{
  if(currentSec === 'dashboard') renderDashboard();
  if(currentSec === 'control'){
    renderTeamAnswers();
    tickAdminTimer();
    renderScoreboard('c-scores');
    renderLoginStatusPanel();
    const quiz = Store.getQuiz();
    const statusEl = document.getElementById('c-status-txt');
    if(statusEl) {
      const sLabel={idle:'IDLE',round_intro:`ROUND ${quiz.currentRoundIdx+1} INTRO`,running:`ROUND ${quiz.currentRoundIdx+1} RUNNING`,paused:'PAUSED',participant_turn:'PARTICIPANTS ANSWERING',round_end:`ROUND ${quiz.currentRoundIdx+1} ENDED`,finished:'FINISHED'};
      statusEl.textContent = sLabel[quiz.status]||quiz.status.toUpperCase();
    }
  }
}, 1000);

// Root ID Display
(function(){
  const rootId = 'SA-' + Math.random().toString(36).substr(2, 4).toUpperCase();
  const el = document.getElementById('sb-root-id');
  if(el) el.textContent = `ROOT ID: ${rootId}`;
})();

// Handle Quiz Cycle Completeness Halt
window.addEventListener('quiz_cycle_halt', (e) => {
  const { remaining, teamsCount } = e.detail;
  const currentRoundIdx = Store.getQuiz().currentRoundIdx;
  const rounds = Store.getRounds();
  const r = rounds[currentRoundIdx];

  const html = `
    <div class="text-sm">
      <p class="mb-2">⚠️ <strong>IMBALANCED CYCLE DETECTED</strong></p>
      <p>Only <strong>${remaining} questions</strong> remain in this round, but there are <strong>${teamsCount} teams</strong>.</p>
      <p class="mt-1 text-muted">Proceeding will mean ${teamsCount - remaining} teams won't get a turn to start in this cycle.</p>
      <div class="mt-3" style="display:flex; flex-direction:column; gap:8px">
        <button class="btn-main font-title" style="background:var(--gold); color:black; font-size:11px" onclick="advanceToNextQuestion(true); closeModal('modal-confirm')">⚡ PROCEED ANYWAY (IMBALANCED)</button>
        <button class="btn-main font-title" style="background:var(--cyan); color:black; font-size:11px" onclick="closeModal('modal-confirm'); goSection('rounds'); openEditRound('${r?.id}')">➕ ADD ${teamsCount - remaining} MORE QUESTIONS</button>
        <button class="btn-main font-title" style="background:var(--red); font-size:11px" onclick="endRound(); closeModal('modal-confirm')">🏁 END ROUND NOW</button>
      </div>
    </div>
  `;
  
  customConfirm(html, '🚨', null);
  const footer = document.querySelector('#modal-confirm .modal-foot');
  if(footer) footer.style.display = 'none';
});

// ─── ADMIN DETAILS MODAL (SUPERADMIN) ─────────────────────────
async function openAdminDetails(adminId) {
  const token = localStorage.getItem('sq_token');
  if (!token) return;
  
  document.getElementById('ad-name').textContent = '🔍 ' + adminId;
  document.getElementById('ad-login-count').textContent = '...';
  document.getElementById('ad-last-login').textContent = '...';
  document.getElementById('ad-created').textContent = '...';
  document.getElementById('ad-total-paid').textContent = '...';
  document.getElementById('ad-active-pkg').textContent = '...';
  document.getElementById('ad-rem-quizzes').textContent = '...';
  
  openModal('modal-admin-details');
  switchAdTab('logins');
  
  try {
    const resp = await fetch(`http://localhost:5000/py-api/admin-details/${encodeURIComponent(adminId)}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await resp.json();
    
    if (!data.success) {
      toast('Failed to load admin details', 'error');
      return;
    }
    
    // Account
    document.getElementById('ad-login-count').textContent = data.loginCount || 0;
    document.getElementById('ad-last-login').textContent = data.lastLogin ? new Date(data.lastLogin).toLocaleString() : 'Never';
    document.getElementById('ad-created').textContent = data.logins.length ? new Date(data.logins[data.logins.length-1].loginAt).toLocaleDateString() : '—';
    
    // Payments
    document.getElementById('ad-total-paid').textContent = '₹' + ((data.totalPaid || 0) / 100).toFixed(2);
    document.getElementById('ad-active-pkg').innerHTML = data.activePackage 
      ? '<span style="color:var(--green)">✅ YES</span>' 
      : '<span style="color:var(--red)">❌ NO</span>';
    document.getElementById('ad-rem-quizzes').innerHTML = `<span style="color:var(--cyan)">${data.remainingQuizzes || 0}</span>`;
    
    // Login History Tab
    const loginBody = document.getElementById('ad-login-body');
    if (data.logins.length) {
      loginBody.innerHTML = data.logins.map(l => `<tr>
        <td class="text-xs text-muted">${new Date(l.loginAt).toLocaleString()}</td>
        <td class="text-xs">${l.ip || 'N/A'}</td>
        <td class="text-xs">${(l.device || 'Unknown').substring(0, 50)}</td>
      </tr>`).join('');
    } else {
      loginBody.innerHTML = '<tr><td colspan="3" class="text-center text-muted text-xs p-12">No login records</td></tr>';
    }
    
    // Quiz History Tab
    const quizBody = document.getElementById('ad-quiz-body');
    if (data.quizActivations.length) {
      quizBody.innerHTML = data.quizActivations.map(a => `<tr>
        <td class="text-xs text-muted">${new Date(a.activatedAt).toLocaleString()}</td>
        <td class="text-xs font-title">${a.quizId}</td>
        <td class="text-xs">—</td>
        <td class="text-xs">—</td>
      </tr>`).join('');
    } else {
      quizBody.innerHTML = '<tr><td colspan="4" class="text-center text-muted text-xs p-12">No quizzes conducted</td></tr>';
    }
    
    // Payment History Tab
    const payBody = document.getElementById('ad-payment-body');
    if (data.payments.length) {
      payBody.innerHTML = data.payments.map(p => {
        let col = p.status==='paid'?'green':p.status==='failed'?'red':'gold';
        return `<tr>
          <td class="text-xs text-muted">${new Date(p.created_at).toLocaleString()}</td>
          <td class="font-mono text-xs">${p.order_id}</td>
          <td class="font-mono text-xs">₹${(p.amount/100).toFixed(2)}</td>
          <td><span class="badge badge-${col}">${(p.status||'UNKNOWN').toUpperCase()}</span></td>
        </tr>`;
      }).join('');
    } else {
      payBody.innerHTML = '<tr><td colspan="4" class="text-center text-muted text-xs p-12">No payment records</td></tr>';
    }
    
  } catch(e) {
    console.error('openAdminDetails error:', e);
    toast('Error loading admin details: ' + e.message, 'error');
  }
}

function switchAdTab(tab) {
  document.querySelectorAll('.ad-tab-content').forEach(el => el.classList.add('hidden'));
  document.querySelectorAll('.ltab').forEach(el => el.classList.remove('active'));
  
  document.getElementById('ad-tab-' + tab)?.classList.remove('hidden');
  document.getElementById('btn-ad-' + tab)?.classList.add('active');
}

// ─── RECORD LOGIN ON SUPERADMIN PAGE LOAD ─────────────────────
(async function recordLogin() {
  try {
    const token = localStorage.getItem('sq_token');
    if (!token) return;
    await fetch('http://localhost:5000/py-api/record-login', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` }
    });
  } catch(e) { /* silent */ }
})();
