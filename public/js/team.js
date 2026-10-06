// ===== TEAM PAGE =====
const session = requireRole('team');
const { teamId } = session;

let sel = [], answered = false, lastGQ = -1, timerIv = null;
let camStream = null, camCapIv = null;

// ─── INIT ────────────────────────────────────────────────────
function init(){
  const t=Store.getTeamById(teamId); if(!t){ doLogout(); return; }
  document.getElementById('th-team-name').textContent=`T${t.teamNumber||'?'}: ${t.name}`;
  Store.setTeamLogin(teamId, t.name, true);

  const managed = Store.getManagedQuizzes();
  const quizInfo = managed.find(x => x.quizId === session.quizId);
  const btnConduct = document.querySelector('.qh-right button[onclick="openConductForm()"]');
  const adminContext = document.getElementById('th-admin-context');

  if (quizInfo) {
    if (adminContext) adminContext.style.display = 'block';
    if (document.getElementById('th-college-name')) document.getElementById('th-college-name').textContent = quizInfo.collegeName;
    if (document.getElementById('th-college-code')) document.getElementById('th-college-code').textContent = quizInfo.collegeCode;
    // Find admin name
    const admins = Store.getUsers().filter(u => u.role === 'admin');
    const adminUser = admins.find(a => a.id === quizInfo.adminId);
    if (document.getElementById('th-admin-name')) document.getElementById('th-admin-name').textContent = adminUser ? adminUser.name : 'Admin';
    
    // Hide buttons once joined with ID
    if (btnConduct) btnConduct.style.display = 'none';
    if (document.querySelector('aside .card .p-12')) document.querySelector('aside .card').style.display = 'none';
  }

  // Start camera
  initCamera();

  // Tab visibility monitoring (suspicious activity detection)
  document.addEventListener('visibilitychange', ()=>{
    const hidden=document.hidden;
    Store.updateCamStatus(teamId,{tabHidden:hidden, lastSeen:Date.now()});
    if(hidden){
      const alert={id:genId(),teamId,teamName:t.name,type:'tab_hidden',msg:'Tab hidden / switched away from quiz',time:new Date().toLocaleTimeString('en-IN'),dismissed:false};
      Store.addAlert(alert);
      Store.addActivity(`⚠ Team <strong>${t.name}</strong> switched tabs/hid window`,'warning');
    }
  });

  // Check for admin warnings
  setInterval(checkAdminWarn,3000);

  // Competition clock
  setInterval(()=>{
    const q=Store.getQuiz();
    const el=document.getElementById('th-comp-clock');
    if(el&&q.competitionStart) el.textContent=formatTime(Math.floor((Date.now()-q.competitionStart)/1000));
  },1000);

  render();
  onUpdate(render);
  initSocketListeners();
  setInterval(render, 1000);
}

function initSocketListeners(){
  const socket = window.socket || io({ auth: { token: Store.getToken() } });
  window.socket = socket;

  socket.on('admin_audio', (data) => {
    // data: { audio, target, quizId }
    if(data.target !== 'all' && data.target !== teamId) return;
    const audio = new Audio(data.audio);
    audio.play().catch(e => console.warn('Audio auto-play blocked:', e));
    toast(`📢 Public Announcement from ${data.sender||'Admin'}`, 'info');
  });

  socket.on('admin_cmd', (data) => {
    // data: { type, target, msg, status, sender }
    if(data.target !== 'all' && data.target !== teamId) return;
    
    if(data.type === 'warn'){
      const el = document.getElementById('admin-warning');
      document.getElementById('warn-sender').textContent = `FROM ${data.sender?.toUpperCase() || 'ADMIN'}`;
      document.getElementById('warn-msg').textContent = data.msg;
      el.classList.remove('hidden');
      // Auto-hide after 15s
      setTimeout(() => el.classList.add('hidden'), 15000);
    }
    
    if(data.type === 'hold'){
      const overlay = document.getElementById('hold-overlay');
      if(data.status) overlay.classList.remove('hidden');
      else overlay.classList.add('hidden');
    }
    
    if(data.type === 'msg'){
      toast(`💬 MESSAGE: ${data.msg}`, 'info', 8000);
    }
    
    if(data.type === 'winner'){
      const overlay = document.getElementById('winner-overlay');
      const wName = document.getElementById('winner-name');
      const wScore = document.getElementById('winner-score');
      if(overlay && wName && wScore){
        wName.textContent = data.teamName.toUpperCase();
        wScore.textContent = `FINAL SCORE: ${data.score}`;
        overlay.classList.remove('hidden');
        // Play victory sound if possible
        const winSound = new Audio('https://assets.mixkit.co/active_storage/sfx/2013/2013-preview.mp3');
        winSound.play().catch(() => {});
      }
    }
  });
}



function checkAdminWarn(){
  const key='sq_team_warn_'+teamId;
  const w=load(key,null);
  if(w&&Date.now()-w.time<30000){
    toast(w.msg,'warning',6000);
    localStorage.removeItem(key);
  }
}

// ─── CAMERA ───────────────────────────────────────────────────
async function initCamera(){
  try{
    camStream=await navigator.mediaDevices.getUserMedia({video:{width:320,height:240,facingMode:'user'},audio:false});
    const vid=document.getElementById('th-cam-video');
    if(vid){ vid.srcObject=camStream; vid.play(); }
    const canvas=document.getElementById('th-cam-canvas');
    camCapIv=setInterval(()=>{
      if(!canvas||!vid) return;
      const ctx=canvas.getContext('2d');
      canvas.width=320; canvas.height=240;
      ctx.drawImage(vid,0,0,320,240);
      const frame=canvas.toDataURL('image/jpeg',0.4);
      Store.saveCamFrame(teamId,frame);
      Store.updateCamStatus(teamId,{tabHidden:document.hidden,lastSeen:Date.now()});
    },2500);
    document.getElementById('th-cam-indicator').innerHTML='<span class="badge badge-green" style="font-size:8px">📷 CAMERA ON</span>';
  } catch(e){
    console.warn('Camera not available:',e);
    document.getElementById('th-cam-indicator').innerHTML='<span class="badge badge-gray" style="font-size:8px">📷 NO CAMERA</span>';
    // Still send status without frame
    setInterval(()=>Store.updateCamStatus(teamId,{tabHidden:document.hidden,lastSeen:Date.now()}),3000);
  }
}

// ─── RENDER ───────────────────────────────────────────────────
function render(){
  const quiz=Store.getQuiz(), teams=Store.getActiveTeams(),
        questions=Store.getQuestions(), rounds=Store.getRounds(),
        team=Store.getTeamById(teamId);

  document.getElementById('th-score').textContent=team?.score||0;

  const ri=document.getElementById('th-round-info');
  if(quiz.status!=='idle'&&rounds[quiz.currentRoundIdx]) ri.textContent=rounds[quiz.currentRoundIdx].name;
  else ri.textContent='';

  // Always render scoreboard regardless of state
  renderScoreboard();
  RenderEngine.quizMap('quiz-map-container');

  if(quiz.status==='idle'){
    showState('waiting');
    const settings = Store.getSettings();
    const welcomeEl = document.getElementById('th-welcome-msg');
    const prizesEl = document.getElementById('th-prizes-box');
    
    // Dynamic Welcome Message
    if(welcomeEl) welcomeEl.innerHTML = `HELLO, <strong>${(session.teamName||'TEAM').toUpperCase()}</strong>! 👋`;
    
    // Prizes
    if(prizesEl && settings.prizes && settings.prizes.length > 0){
      prizesEl.innerHTML = `<div class="prize-title">🎁 COMPETITION PRIZES</div>` + 
        settings.prizes.map((p,i)=>`<div class="prize-item">${p}</div>`).join('');
      prizesEl.classList.remove('hidden');
    }

    if(settings.globalInstructions){
      const instrEl = document.getElementById('th-general-instr');
      if(instrEl){
        instrEl.textContent = settings.globalInstructions;
        instrEl.classList.remove('hidden');
      }
    }
    return;
  }
  if(quiz.status==='round_intro'){ showState('round-intro'); renderRoundIntro(quiz,rounds); return; }
  if(quiz.status==='round_end'){ showState('round-end'); renderRoundEnd(quiz,rounds); return; }
  if(quiz.status==='finished'){ showState('finished'); renderFinal(); return; }

  const q=questions[quiz.globalQIdx];
  if(!q){ showState('waiting'); return; }

  // Reset on new question
  if(quiz.globalQIdx!==lastGQ){ lastGQ=quiz.globalQIdx; sel=[]; answered=false; }

  // Participant turn — show participant timer to ALL teams
  if(quiz.status==='participant_turn'){
    showState('participant-turn');
    renderParticipantTurnView(quiz,q,rounds);
    return;
  }

  const cur=teams[quiz.currentTeamIdx];
  const isMyTurn=cur?.id===teamId;
  const range=getRoundQRange(rounds,quiz.currentRoundIdx);

  if(isMyTurn){ showState('myturn'); renderMyTurn(quiz,q,range); }
  else { showState('wait-turn'); renderWaitTurn(quiz,q,teams,cur,range); }

  tickTimer(quiz);
}

function showState(name){
  ['waiting','round-intro','myturn','wait-turn','participant-turn','round-end','finished'].forEach(s=>{
    const el=document.getElementById('ts-'+s); if(el) el.classList.add('hidden');
  });
  const el=document.getElementById('ts-'+name); if(el) el.classList.remove('hidden');
}

function renderRoundIntro(quiz,rounds){
  const r=rounds[quiz.currentRoundIdx];
  document.getElementById('th-ri-name').textContent=(r?.name||`ROUND ${quiz.currentRoundIdx+1}`).toUpperCase();
  document.getElementById('th-ri-instr').textContent=r?.instructions||'No instructions provided.';
}

function renderMyTurn(quiz,q,range){
  document.getElementById('th-q-label').textContent=`Q${quiz.currentQInRound+1} OF ${range.count}`;
  document.getElementById('th-q-text').textContent=q.text;
  document.getElementById('th-multi-hint').classList.toggle('hidden',q.type!=='multiple');
  const optsEl=document.getElementById('th-opts');
  optsEl.innerHTML=q.options.map((o,i)=>`
    <button class="opt-btn ${sel.includes(i)?'opt-sel':''} ${answered ? (q.correct.includes(i)?'opt-ok':(sel.includes(i)?'opt-bad':'')) : ''}"
      onclick="selectOpt(${i})" ${answered?'disabled':''}>
      <span class="opt-lbl">${String.fromCharCode(65+i)}</span>${o}
    </button>`).join('');
  const rev=document.getElementById('th-reveal');
  if(answered){
    const ok=checkOk(sel,q.correct,q.type);
    rev.className='answer-reveal show';
    rev.innerHTML=`<div style="color:${ok?'var(--green)':'var(--red)'}">${ok?'✓ Correct! +10 points':'✗ Wrong Answer — moving to next question'}</div>
      <div class="text-sm text-muted mt-1">Correct: ${q.correct.map(c=>String.fromCharCode(65+c)+'. '+q.options[c]).join(', ')}</div>
      ${q.explanation?`<div class="text-sm text-muted mt-1">${q.explanation}</div>`:''}`;
  } else { rev.className='answer-reveal'; }
  const passBtn=document.getElementById('th-btn-pass'), subBtn=document.getElementById('th-btn-submit');
  if(passBtn) passBtn.disabled=answered||quiz.status==='paused';
  if(subBtn) subBtn.disabled=answered||!sel.length||quiz.status==='paused';
}

function renderWaitTurn(quiz,q,teams,cur,range){
  const el1=document.getElementById('th-wt-qlabel'), el2=document.getElementById('th-wt-text'), el3=document.getElementById('th-wt-badge');
  if(el1) el1.textContent=`Q${quiz.currentQInRound+1} OF ${range.count}`;
  if(el2) el2.textContent=q.text;
  if(el3) el3.textContent=`${cur?.name}'s Turn`;
  const cEl=document.getElementById('th-wt-chain');
  if(cEl&&quiz.passChain?.length) cEl.innerHTML=`<div class="pass-chain">${teams.map((t,i)=>`<span class="pchip ${quiz.passChain.includes(t.id)?'pchip-passed':teams[quiz.currentTeamIdx]?.id===t.id?'pchip-cur':''}">${t.name}</span>${i<teams.length-1?'<span class="parr">→</span>':''}`).join('')}</div>`;
  else if(cEl) cEl.innerHTML='<span class="text-muted text-sm">No passes yet.</span>';
  tickTimer(quiz);
}

function renderParticipantTurnView(quiz,q,rounds){
  const range=getRoundQRange(rounds,quiz.currentRoundIdx);
  // Show question and a countdown timer for participants
  const el=document.getElementById('th-pt-content');
  if(!el) return;
  const rem=quiz.participantTimerStart?Math.max(0,quiz.participantTimeLimit-Math.floor((Date.now()-quiz.participantTimerStart)/1000)):quiz.participantTimeLimit;
  const pct=quiz.participantTimeLimit>0?(rem/quiz.participantTimeLimit)*100:100;
  el.innerHTML=`
    <div class="font-title text-xs" style="color:var(--purple);letter-spacing:3px;margin-bottom:10px">ALL TEAMS PASSED — PARTICIPANTS ANSWERING</div>
    <div class="q-text mb-2" style="font-size:14px">${q.text}</div>
    <div class="text-xs text-muted mb-1">Q${quiz.currentQInRound+1} OF ${range.count}</div>
    <div style="margin:12px 0;text-align:center">
      <div class="font-title text-xs text-muted mb-1">PARTICIPANT TIMER</div>
      <div class="timer-num ${rem<=5?'danger':rem<=10?'warn':''}" style="font-size:52px">${rem}</div>
      <div class="tbar-wrap"><div class="tbar ${rem<=5?'tbar-danger':rem<=10?'tbar-warn':''}" style="width:${pct}%"></div></div>
    </div>
    <div class="text-muted text-sm text-center">Next question starts automatically when time expires.</div>`;
  if(rem<=0 && !quiz._participantTimerHandled){
    Store.addActivity('⏰ Participant time up → next question','warning');
    advanceToNextQuestion(quiz.globalQIdx);
  }
  // Keep updating the timer in this state
  clearTimeout(window._ptRefreshTO);
  if(rem>0) window._ptRefreshTO=setTimeout(()=>render(),500);
}

function renderRoundEnd(quiz,rounds){
  const r=rounds[quiz.currentRoundIdx], next=rounds[quiz.currentRoundIdx+1];
  const el=document.getElementById('th-re-name'); if(el) el.textContent=`${r?.name||`ROUND ${quiz.currentRoundIdx+1}`} COMPLETE!`;
  const ne=document.getElementById('th-re-next'); if(ne) ne.textContent=next?`Next: ${next.name}`:'🏆 Final round complete!';
  const teams=Store.getActiveTeams().sort((a,b)=>(b.score||0)-(a.score||0));
  const el2=document.getElementById('th-re-scores');
  if(el2) el2.innerHTML=teams.map((t,i)=>`<div class="sb-row ${t.id===teamId?'sb-me':''}"><span class="sb-rank r${i+1}">${i===0?'🥇':i===1?'🥈':i===2?'🥉':`#${i+1}`}</span><span class="sb-name">T${t.teamNumber}: ${t.name} ${t.id===teamId?'<span class="badge badge-gold" style="font-size:8px">YOU</span>':''}</span><span class="sb-pts">${t.score||0}</span></div>`).join('');
}

function renderFinal(){
  const teams=Store.getActiveTeams().sort((a,b)=>(b.score||0)-(a.score||0));
  const el=document.getElementById('th-final-scores');
  if(el) el.innerHTML=teams.map((t,i)=>`<div class="sb-row ${t.id===teamId?'sb-me':''}"><span class="sb-rank r${i+1}">${i===0?'🥇':i===1?'🥈':i===2?'🥉':`#${i+1}`}</span><span class="sb-name">T${t.teamNumber}: ${t.name} ${t.id===teamId?'<span class="badge badge-gold">YOU</span>':''}<small class="text-muted"> ${t.correctCount||0}✓</small></span><span class="sb-pts">${t.score||0}</span></div>`).join('');
}

function renderScoreboard(){
  const teams=Store.getActiveTeams().sort((a,b)=>(b.score||0)-(a.score||0));
  const el=document.getElementById('th-scoreboard'); if(!el) return;
  el.innerHTML=`<div class="sb-list">${teams.map((t,i)=>`<div class="sb-row ${t.id===teamId?'sb-me':''}"><span class="sb-rank r${i+1}">${i===0?'🥇':i===1?'🥈':i===2?'🥉':`#${i+1}`}</span><span class="sb-name">T${t.teamNumber}: ${t.name}</span><span class="sb-pts">${t.score||0}</span></div>`).join('')}</div>`;
}

// ─── TIMER ────────────────────────────────────────────────────
function tickTimer(quiz){
  clearInterval(timerIv);
  function tick(){
    const q=Store.getQuiz();
    ['th-timer','th-wt-timer'].forEach(eid=>{
      const el=document.getElementById(eid); if(!el) return;
      const bar=document.getElementById(eid==='th-timer'?'th-tbar':'th-wt-tbar');
      if(q.status!=='running'){ el.textContent=q.timerLimit||'—'; el.className='timer-num'; if(bar){bar.style.width='100%';bar.className='tbar';} return; }
      const elapsed=q.timerStart?Math.floor((Date.now()-q.timerStart)/1000):0;
      const limit=q.timerLimit||60, rem=Math.max(0,limit-elapsed), pct=(rem/limit)*100;
      el.textContent=rem;
      const c=rem<=10?'danger':rem<=20?'warn':'';
      el.className='timer-num'+(c?' '+c:'');
      if(bar){bar.style.width=pct+'%';bar.className='tbar'+(c?' tbar-'+c:'');}
    });
  }
  tick(); timerIv=setInterval(tick,500);
}

// ─── ANSWER LOGIC ─────────────────────────────────────────────
function selectOpt(i){
  if(answered) return;
  const quiz=Store.getQuiz(), q=Store.getQuestions()[quiz.globalQIdx]; if(!q) return;
  sel=q.type==='single'?[i]:sel.includes(i)?sel.filter(x=>x!==i):[...sel,i];
  document.querySelectorAll('#th-opts .opt-btn').forEach((b,idx)=>b.classList.toggle('opt-sel',sel.includes(idx)));
  const subBtn=document.getElementById('th-btn-submit'); if(subBtn) subBtn.disabled=!sel.length;
}

function checkOk(s,correct,type){
  if(type==='single') return s.length===1&&correct.includes(s[0]);
  return JSON.stringify([...s].sort())===JSON.stringify([...correct].sort());
}

function submitAns(){
  const quiz=Store.getQuiz(), q=Store.getQuestions()[quiz.globalQIdx];
  if(!q||answered||!sel.length) return;
  if(quiz.currentTeamIdx<0||Store.getActiveTeams()[quiz.currentTeamIdx]?.id!==teamId) return; // not our turn
  answered=true;

  const team=Store.getTeamById(teamId);
  const ok=checkOk(sel,q.correct,q.type);
  const answers={...(team.answers||{})}; answers[quiz.globalQIdx]=sel;
  Store.updateTeam(teamId,{answers, score:(team.score||0)+(ok?10:0), correctCount:(team.correctCount||0)+(ok?1:0)});
  Store.addActivity(`Team <strong>${team.name}</strong> Q${quiz.currentQInRound+1}: ${ok?'✓ CORRECT (+10)':'✗ WRONG'}`,ok?'success':'error');
  toast(ok?'✓ Correct! +10':'✗ Wrong — next question',ok?'success':'error');

  render(); // show reveal

  // ONLY advance to next question if CORRECT. 
  // Otherwise, trigger the pass logic (which goes either to the next team or the audience).
  setTimeout(()=>{
    if(ok) {
      advanceToNextQuestion(quiz.globalQIdx);
    } else {
      // For consistency, a wrong answer now behaves like a pass (goes to bonus team or audience)
      passQ();
    }
  }, 1800);
}

function passQ(){
  const quiz=Store.getQuiz(), teams=Store.getActiveTeams(), team=Store.getTeamById(teamId);
  if(!quiz||quiz.status!=='running') return;
  if(teams[quiz.currentTeamIdx]?.id!==teamId) return;
  answered=true;

  const passChain=quiz.passChain||[];
  if(!passChain.includes(teamId)) passChain.push(teamId);
  const passedQs=(team.passedQs||[]); if(!passedQs.includes(quiz.globalQIdx)) passedQs.push(quiz.globalQIdx);
  Store.updateTeam(teamId,{passedQs});

  // LIMIT: Question only goes to ONE PASS TEAM (max 2 teams total including start)
  const passLimit = 2; // Standard: Only 1 extra team gets a chance
  if(passChain.length >= passLimit){
    // Limit reached → participant turn
    const settings=Store.getSettings();
    const q2={...quiz,status:'participant_turn',currentTeamIdx:-1,passChain,participantTurn:true,participantTimerStart:Date.now(),participantTimeLimit:settings.participantTimeLimit||30,_participantTimerHandled:false};
    Store.saveQuiz(q2);
    Store.addActivity(`📢 Max passes reached Q${quiz.currentQInRound+1} → PARTICIPANTS`,'warning');
    toast('Goes to participants!','warning');
  } else {
    let next=(quiz.currentTeamIdx+1)%teams.length, loops=0;
    while(passChain.includes(teams[next]?.id)&&loops<teams.length){next=(next+1)%teams.length;loops++;}
    const q2={...quiz,currentTeamIdx:next,passChain,timerStart:Date.now(),_timerEndHandled:false};
    Store.saveQuiz(q2);
    Store.addActivity(`<strong>${team.name}</strong> passed → <strong>${teams[next]?.name}</strong>`,'info');
    toast(`Passed to ${teams[next]?.name}`,'info');
  }
  render();
}

function doLogout(){
  if(session.rid) Store.updateLogout(session.rid);
  Store.setTeamLogin(teamId, session.teamName, false);
  if(camCapIv) clearInterval(camCapIv);
  if(camStream) camStream.getTracks().forEach(t=>t.stop());
  Store.clearSession();
  window.location.href='../index.html';
}

function submitFeedback(){
  const text = document.getElementById('th-f-text')?.value.trim();
  if(!text) return;
  Store.addFeedback(session.teamName, text);
  document.getElementById('th-f-text').value = '';
  document.getElementById('th-f-msg').classList.remove('hidden');
  setTimeout(()=>document.getElementById('th-f-msg').classList.add('hidden'), 5000);
}

function alignToQuiz(){
  const quizId = document.getElementById('th-align-id').value.trim().toUpperCase();
  if(!quizId){ toast('Enter a Quiz ID', 'warning'); return; }
  
  const managed = Store.getManagedQuizzes();
  const q = managed.find(x => x.quizId === quizId);
  if(!q){ toast('Invalid Quiz ID', 'error'); return; }
  if(q.status !== 'active'){ toast('This quiz session is not active.', 'error'); return; }
  
  const s = Store.getSession();
  s.quizId = quizId;
  Store.setSession(s);
  toast(`Aligned to Quiz: ${quizId}`, 'success');
  setTimeout(() => window.location.reload(), 1000);
}

// CONDUCT QUIZ logic
function openConductForm(){ document.getElementById('modal-conduct').classList.add('open'); }
function closeModal(id){ document.getElementById(id).classList.remove('open'); }

function submitQuizRequest(){
  const username = document.getElementById('cm-user').value.trim();
  const password = document.getElementById('cm-pass').value.trim();
  const collegeName = document.getElementById('cm-college').value.trim();
  const collegeCode = document.getElementById('cm-code').value.trim();
  const err = document.getElementById('cm-err');
  const suc = document.getElementById('cm-suc');
  
  err.textContent = '';
  suc.classList.add('hidden');
  
  if(!username || !password || !collegeName || !collegeCode){
    err.textContent = 'All fields are required.'; return;
  }
  
  Store.addQuizRequest({ username, password, collegeName, collegeCode });
  Store.addActivity(`New quiz conduct request from <strong>${collegeName}</strong>`, 'info');
  
  suc.classList.remove('hidden');
  setTimeout(() => {
    closeModal('modal-conduct');
    ['cm-user','cm-pass','cm-college','cm-code'].forEach(id => document.getElementById(id).value = '');
    suc.classList.add('hidden');
  }, 3000);
}

init();
