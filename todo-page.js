let currentUser=null, appConfig={stores:[],shifts:[]};
let allTodos=[], myChecks={}, displayNameMap={}, empListCache={};
let editingId=null, curType='task', curRec=false;
let selTarget='self', selStores=[], selPersons=[];
let doneCollapsed=true, selCalDate=null;
let calY=new Date().getFullYear(), calM=new Date().getMonth();
let todoOrder=[], dragSrcId=null, touchDragId=null;

const isAdmin  =()=>['owner','admin'].includes(currentUser?.permission);
const isManager=()=>['manager','owner','admin'].includes(currentUser?.permission);
const myStore  =()=>currentUser?.store||'';
const myName   =()=>currentUser?.empName||'';
const myDisplay=()=>displayNameMap[myName()]||myName();

function showLoading(m){document.getElementById('loadingText').textContent=m||'載入中...';const o=document.getElementById('loadingOverlay');o.classList.remove('hidden');o.style.display='flex';}
function hideLoading(){document.getElementById('loadingOverlay').classList.add('hidden');setTimeout(()=>{document.getElementById('loadingOverlay').style.display='none';},400);}
function showToast(m){const t=document.getElementById('toast');t.textContent=m;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),2500);}
function openModal(id){document.getElementById(id).classList.add('active');}
function closeModal(id){document.getElementById(id).classList.remove('active');}
function getDN(n){return displayNameMap[n]||n;}
function handleBack(){if(window.history.length>1)window.history.back();else window.location.href='home.html';}
function toDay(){const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;}
function dateLbl(s){if(!s)return '';const[,m,d]=s.split('-');return `${parseInt(m)}/${parseInt(d)}`;}
function daysUntil(s){if(!s)return null;const t=new Date(s);t.setHours(23,59,59);return Math.ceil((t-new Date())/86400000);}

// 週期下次觸發
function calcNext(todo,from){
  const base=from?new Date(from):new Date();base.setHours(0,0,0,0);
  const start=todo.startDate?new Date(todo.startDate):base;
  const end=todo.recurringEnd?new Date(todo.recurringEnd):null;
  if(end&&base>end)return null;
  if(todo.recurringType==='weekly'){
    const tgt=parseInt(todo.recurringDay||1);
    const dow=base.getDay()===0?7:base.getDay();
    let diff=tgt-dow; if(diff<0)diff+=7;
    const next=new Date(base);next.setDate(base.getDate()+diff);
    if(next<start)next.setDate(next.getDate()+7);
    return(end&&next>end)?null:next;
  }
  if(todo.recurringType==='monthly'){
    const isLast=(todo.recurringDay==='last'||parseInt(todo.recurringDay)===0);
    const dayOf=(yr,mo)=> isLast ? new Date(yr,mo+1,0).getDate() : Math.min(parseInt(todo.recurringDay||1), new Date(yr,mo+1,0).getDate());
    let next=new Date(base.getFullYear(),base.getMonth(),dayOf(base.getFullYear(),base.getMonth()));
    if(next<base){const y=base.getFullYear(),m=base.getMonth()+1;next=new Date(y,m,dayOf(y,m));}
    if(next<start){const y=next.getFullYear(),m=next.getMonth()+1;next=new Date(y,m,dayOf(y,m));}
    return(end&&next>end)?null:next;
  }
  if(todo.recurringType==='custom'){
    const iv=parseInt(todo.recurringInterval||7);
    let cur=new Date(start);while(cur<base)cur.setDate(cur.getDate()+iv);
    return(end&&cur>end)?null:cur;
  }
  return null;
}
function nextStr(todo){
  const d=calcNext(todo);
  return d?`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`:null;
}
function recChkKey(id){
  const t=allTodos.find(x=>x.id===id)||{};
  // 每月型：當期＝「當月」(YYYY-MM)，完成後該月消失、下月自動重現
  if(t.recurringType==='monthly'){const n=new Date();return `${id}__${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}`;}
  const n=nextStr(t);return n?`${id}__${n}`:id;
}
// 循環任務「當期截止日」：每月型＝當月的截止日(取 endDate 的日)；其他型＝下次發生日+offset
function recDeadline(todo){
  if(!todo.isRecurring||!todo.endDate)return todo.endDate||null;
  const fmt=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const day=parseInt(todo.endDate.split('-')[2])||1;
  if(todo.recurringType==='monthly'){const n=new Date();return fmt(new Date(n.getFullYear(),n.getMonth(),day));}
  const nxt=calcNext(todo);if(!nxt)return todo.endDate;
  let off=0;if(todo.startDate)off=Math.max(0,Math.round((new Date(todo.endDate+'T00:00')-new Date(todo.startDate+'T00:00'))/86400000));
  return fmt(new Date(nxt.getFullYear(),nxt.getMonth(),nxt.getDate()+off));
}
function recLbl(t){
  if(t.recurringType==='weekly'){const d=['','週一','週二','週三','週四','週五','週六','週日'];return `每週${d[t.recurringDay]||''}`;}
  if(t.recurringType==='monthly')return (t.recurringDay==='last'||parseInt(t.recurringDay)===0)?'每月最後一天':`每月${t.recurringDay}號`;
  if(t.recurringType==='custom')return `每${t.recurringInterval}天`;
  return '週期';
}

// 可見判斷
let showAllAnn = false; // admin 清理模式：顯示全部公告（含過期/非發生日/未到起始/所有對象）
function toggleShowAllAnn(){
  showAllAnn = !showAllAnn;
  const b = document.getElementById('showAllAnnBtn');
  if(b) b.style.background = showAllAnn ? 'rgba(255,255,255,0.5)' : 'rgba(255,255,255,0.18)';
  showToast(showAllAnn ? '👁️ 已顯示全部公告（含過期/非發生日）' : '已恢復一般顯示');
  renderAll();
}
function visible(todo){
  if(todo.deleted)return false;
  // admin 清理：全部「公告」都顯示，方便找出殘留公告刪除（不影響代辦）
  if(showAllAnn && isAdmin() && todo.type==='announcement') return true;
  return visibleNormal(todo);
}
function visibleNormal(todo){
  const td=toDay();
  // 未到顯示日：僅「建立者本人」看得到，以便先編輯/確認（標「排程中」）；其他人一律隱藏到顯示日
  if(todo.startDate&&td<todo.startDate&&todo.createdBy!==myName())return false;
  if(todo.deleted)return false;
  // 截止日判斷（非週期公告）
  if(!todo.isRecurring&&todo.type==='announcement'&&todo.endDate&&td>todo.endDate)return false;
  // 週期型：先判斷是否有下一次，再判斷 targetType
  if(todo.isRecurring&&calcNext(todo)===null)return false;
  // 週期「公告」只在發生日「當天」顯示（如每月最後一天提醒）— 對所有人(含建立者)一致，避免混淆；週期「代辦」則持續顯示到完成
  if(todo.isRecurring&&todo.type==='announcement'&&nextStr(todo)!==toDay())return false;

  // ✅ targetType 判斷（週期型也要走這裡）
  const tt=todo.targetType;
  if(tt==='self')return todo.createdBy===myName();
  if(tt==='all')return true;
  if(tt==='store')return todo.targetStore===myStore()||(todo.targetStores||[]).includes(myStore());
  if(tt==='stores_manager'){if(!isManager())return false;const s=todo.targetStores||[];return s.length===0||s.includes(myStore())||todo.targetStore===myStore();}
  if(tt==='specific')return(todo.targetEmps||[]).includes(myName());
  return false;
}
function canManage(todo){
  if(todo.targetType==='self'&&todo.createdBy!==myName())return false;
  if(todo.createdBy===myName())return true;
  if(isAdmin())return true;
  if(isManager()){const s=todo.targetStores||[];return todo.targetStore===myStore()||s.includes(myStore());}
  return false;
}

// 初始化
window.onload=async()=>{
  showLoading('驗證登入...');
  const saved=localStorage.getItem('currentUser')||sessionStorage.getItem('currentUser');
  if(!saved){window.location.replace('home.html');return;}
  try{currentUser=JSON.parse(saved);}catch(e){window.location.replace('home.html');return;}
  const _fbAuth = await new Promise(r => { const u = firebase.auth().onAuthStateChanged(fb => { u(); r(fb); }); });
  if (!_fbAuth) { localStorage.removeItem('currentUser'); sessionStorage.removeItem('currentUser'); window.location.replace('home.html'); return; }
  try{
    const cached=localStorage.getItem('appConfig');
    if(cached)try{appConfig=JSON.parse(cached);}catch(e){}
    try{
      const s=await Promise.race([window.db.collection('settings').doc('globalConfig').get(),new Promise((_,r)=>setTimeout(()=>r(new Error('t')),5000))]);
      if(s.exists){appConfig=s.data();localStorage.setItem('appConfig',JSON.stringify(appConfig));}
    }catch(e){}
    const accSnap=await window.db.collection('users').where('store','==',myStore()).get().catch(()=>null);
    if(accSnap)accSnap.forEach(d=>{const a=d.data();if(a.empName&&a.displayName)displayNameMap[a.empName]=a.displayName;});
    document.getElementById('headerAddBtn').style.display='flex';
    if(isAdmin()) document.getElementById('showAllAnnBtn').style.display='flex'; // admin 才有「顯示全部公告」清理鈕
    await loadTodos();
    renderCal();
    document.getElementById('appShell').classList.add('active');
    hideLoading();
  }catch(e){hideLoading();alert('載入失敗：'+e.message);}
};

async function loadTodos(){
  showLoading('載入代辦事項...');
  try{
    const[snap,chkSnap,ordSnap]=await Promise.all([
      window.db.collection('todos').where('deleted','==',false).get(),
      window.db.collection('todoChecks').where('empName','==',myName()).get(),
      window.db.collection('todoOrders').doc(myName()).get().catch(()=>null)
    ]);
    allTodos=[];
    snap.forEach(d=>allTodos.push({id:d.id,...d.data()}));
    allTodos.sort((a,b)=>(b.createdAt?.toDate?.()?.getTime()??0)-(a.createdAt?.toDate?.()?.getTime()??0));
    myChecks={};
    chkSnap.forEach(d=>{const dt=d.data();if(dt.checked)myChecks[dt.checkKey||dt.todoId]=true;});
    todoOrder=(ordSnap&&ordSnap.exists)?(ordSnap.data().order||[]):[];
    renderAll();
  }catch(e){showToast('讀取失敗：'+e.message);}
  hideLoading();
}

function renderAll(){
  const el=document.getElementById('mainContent');
  let vis=allTodos.filter(t=>visible(t)&&!t.deleted);
  if(selCalDate){
    vis=vis.filter(t=>{
      if(t.isRecurring)return nextStr(t)===selCalDate;
      if(t.startDate&&t.startDate>selCalDate)return false;
      if(t.endDate&&t.endDate<selCalDate)return false;
      return true;
    });
  }
  const ann=vis.filter(t=>t.type==='announcement');          // 公告(含循環公告)→ 📢 區、無勾選框
  const tasks=vis.filter(t=>t.type!=='announcement');          // 代辦(含循環代辦)→ 勾選完成
  const pending=tasks.filter(t=>!myChecks[t.isRecurring?recChkKey(t.id):t.id]);
  const done=tasks.filter(t=>!!myChecks[t.isRecurring?recChkKey(t.id):t.id]);

  ann.sort((a,b)=>{if(!a.endDate&&!b.endDate)return 0;if(!a.endDate)return 1;if(!b.endDate)return -1;return a.endDate.localeCompare(b.endDate);});
  pending.sort((a,b)=>{const ia=todoOrder.indexOf(a.id),ib=todoOrder.indexOf(b.id);if(ia===-1&&ib===-1)return 0;if(ia===-1)return 1;if(ib===-1)return -1;return ia-ib;});

  let html='';
  if(ann.length){
    html+=`<div class="sec-header"><div class="sec-title">📢 公告事項</div><div class="sec-count">${ann.length}</div></div>`;
    html+=ann.map(t=>card(t)).join('');
  }
  html+=`<div class="sec-header"><div class="sec-title">☐ 待辦清單</div><div class="sec-count">${pending.length}</div></div>`;
  if(pending.length){
    html+=`<div id="taskList">${pending.map(t=>card(t)).join('')}</div>`;
  }else{
    html+=`<div class="empty-block"><div style="font-size:32px;margin-bottom:8px;">✅</div><div>沒有待辦事項</div></div>`;
  }
  if(done.length){
    html+=`<div class="collapse-hdr" onclick="toggleDone()">
      <span class="collapse-arrow ${doneCollapsed?'':'open'}" id="doneArrow">›</span>
      <span class="sec-title">✓ 已完成</span>
      <span class="sec-count">${done.length}</span>
    </div>
    <div id="doneList" style="display:${doneCollapsed?'none':'block'};">${done.map(t=>card(t,true)).join('')}</div>`;
  }
  el.innerHTML=html;
  bindDrag();
  renderCal();
}

function toggleDone(){
  doneCollapsed=!doneCollapsed;
  const l=document.getElementById('doneList'),a=document.getElementById('doneArrow');
  if(l)l.style.display=doneCollapsed?'none':'block';
  if(a)a.classList.toggle('open',!doneCollapsed);
}

function card(todo,isDone=false){
  const isAnn=todo.type==='announcement'; // 公告(含循環公告)：顯示 📢、無勾選框
  const isRec=todo.isRecurring;
  const ck=isRec?recChkKey(todo.id):todo.id;
  const chked=!!myChecks[ck];
  let sc='task'; if(isAnn)sc='announce'; else if(isRec)sc=(todo.type==='announcement'?'rec-announce':'rec-task');
  const chkHtml=isAnn
    ?`<div class="chk-wrap"><div class="chk no-chk">📢</div></div>`
    :`<div class="chk-wrap" onclick="event.stopPropagation();doCheck('${todo.id}',${isRec})"><div class="chk ${chked?'done':''}">${chked?'✓':''}</div></div>`;

  let dlTag='';
  const _dl = isRec ? recDeadline(todo) : todo.endDate; // 循環任務用當期截止日，不再卡在舊固定日
  if(_dl){const d=daysUntil(_dl);const lbl=d===null?'':d<0?'已截止':d===0?'今天截止':`${d}天後截止`;dlTag=`<span class="tag ${d!==null&&d<=2?'dl-soon':'dl'}">📅 ${dateLbl(_dl)} ${lbl}</span>`;}
  let recTag=isRec?`<span class="tag rec">🔄 ${recLbl(todo)}${calcNext(todo)?` · 下次${calcNext(todo).getMonth()+1}/${calcNext(todo).getDate()}`:''}</span>`:'';
  let scopeTag=''; const tt=todo.targetType;
  if(tt==='all')scopeTag=`<span class="tag scope">全體</span>`;
  else if(tt==='store')scopeTag=`<span class="tag scope">${todo.targetStore||'指定門市'}</span>`;
  else if(tt==='stores_manager')scopeTag=`<span class="tag scope">店長群</span>`;
  else if(tt==='specific')scopeTag=`<span class="tag scope">指定人員</span>`;
  const privTag=todo.targetType==='self'?`<span class="tag priv">🔒 僅自己可見</span>`:'';
  const _notStarted=todo.startDate&&toDay()<todo.startDate;
  const schedTag=_notStarted?`<span class="tag" style="background:#fef3c7;color:#b45309;">🕒 排程中·顯示從 ${dateLbl(todo.startDate)}</span>`:'';
  // admin 清理模式下，標示「平常不會顯示給員工」的公告(過期/非發生日/未到起始/非本人對象)
  const hiddenTag=(showAllAnn&&isAdmin()&&!visibleNormal(todo))?`<span class="tag" style="background:#fee2e2;color:#b91c1c;">🔕 平常不顯示</span>`:'';
  const emps=todo.targetEmps||[];
  const personsHtml=emps.length?`<div class="todo-persons">👤 ${emps.map(n=>getDN(n)).join('、')}</div>`:'';
  const dragHtml=!isAnn&&!isDone?`<div class="drag-handle" data-id="${todo.id}" ontouchstart="tStart(event,'${todo.id}')" ontouchmove="tMove(event)" ontouchend="tEnd(event)">⠿</div>`:'';

  return `<div class="todo-card ${isDone?'is-done':''}" id="card-${todo.id}" data-id="${todo.id}" onclick="openDet('${todo.id}')">
    <div class="stripe ${sc}"></div>
    ${chkHtml}
    <div class="todo-body">
      <div class="todo-title ${isDone?'done-txt':''}">${todo.title}</div>
      ${todo.note?`<div class="todo-note">${todo.note}</div>`:''}
      <div class="todo-foot">${hiddenTag}${schedTag}${dlTag}${recTag}${scopeTag}${privTag}</div>
      ${personsHtml}
    </div>
    ${dragHtml}
  </div>`;
}

// 勾選
async function doCheck(id,isRec=false){
  const ck=isRec?recChkKey(id):id;
  const nv=!myChecks[ck]; myChecks[ck]=nv; renderAll();
  try{
    const docId=`${ck}__${myName()}`;
    await window.db.collection('todoChecks').doc(docId).set({todoId:id,checkKey:ck,empName:myName(),checked:nv,checkedAt:toDay()});
  }catch(e){showToast('儲存失敗');}
}

// 拖曳（桌面）
function bindDrag(){
  document.querySelectorAll('.drag-handle[data-id]').forEach(h=>{
    const c=h.closest('.todo-card');
    h.draggable=true;
    h.addEventListener('dragstart',e=>{dragSrcId=c.dataset.id;c.classList.add('dragging');e.dataTransfer.effectAllowed='move';});
    h.addEventListener('dragend',()=>{c.classList.remove('dragging');document.querySelectorAll('.todo-card').forEach(x=>x.classList.remove('drag-over'));saveTodoOrder();});
  });
  document.querySelectorAll('.todo-card[id^="card-"]').forEach(c=>{
    c.addEventListener('dragover',e=>{e.preventDefault();if(c.dataset.id===dragSrcId)return;document.querySelectorAll('.todo-card').forEach(x=>x.classList.remove('drag-over'));c.classList.add('drag-over');});
    c.addEventListener('drop',e=>{e.preventDefault();if(!dragSrcId||c.dataset.id===dragSrcId)return;reorder(dragSrcId,c.dataset.id);});
  });
}
function reorder(src,tgt){
  if(!todoOrder.includes(src))todoOrder.push(src);
  if(!todoOrder.includes(tgt))todoOrder.push(tgt);
  const si=todoOrder.indexOf(src);todoOrder.splice(si,1);
  const ti=todoOrder.indexOf(tgt);todoOrder.splice(ti,0,src);
  renderAll();
}
async function saveTodoOrder(){
  try{await window.db.collection('todoOrders').doc(myName()).set({order:todoOrder,updatedAt:toDay()});}catch(e){}
}

// 拖曳（手機）
function tStart(e,id){touchDragId=id;e.stopPropagation();}
function tMove(e){
  if(!touchDragId)return;e.preventDefault();
  const t=e.touches[0];const el=document.elementFromPoint(t.clientX,t.clientY);
  const c=el?.closest('.todo-card');
  document.querySelectorAll('.todo-card').forEach(x=>x.classList.remove('drag-over'));
  if(c&&c.dataset.id!==touchDragId)c.classList.add('drag-over');
}
function tEnd(){
  if(!touchDragId)return;
  const ov=document.querySelector('.todo-card.drag-over');
  if(ov)reorder(touchDragId,ov.dataset.id);
  document.querySelectorAll('.todo-card').forEach(x=>x.classList.remove('drag-over'));
  touchDragId=null;saveTodoOrder();
}

// 詳細 Modal
function openDet(id){
  const todo=allTodos.find(t=>t.id===id);if(!todo)return;
  const isAnn=todo.type==='announcement'&&!todo.isRecurring;
  const isRec=todo.isRecurring;
  let bc='task',bt='☐ 代辦';
  if(isAnn){bc='announce';bt='📢 公告';}
  else if(isRec&&todo.type==='announcement'){bc='rec-announce';bt='🔄 週期公告';}
  else if(isRec){bc='rec-task';bt='🔄 週期代辦';}
  const nxt=isRec?calcNext(todo):null;
  document.getElementById('detTitle').textContent=todo.title;
  const _detDl=isRec?recDeadline(todo):todo.endDate;
  const dl=_detDl?daysUntil(_detDl):null;
  document.getElementById('detContent').innerHTML=`
    <div class="det-badge ${bc}">${bt}</div>
    ${todo.note?`<div style="background:#f8fafc;border-radius:8px;padding:10px 12px;font-size:13px;line-height:1.7;margin-bottom:10px;">${todo.note}</div>`:''}
    <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px;">
      ${_detDl?`<span class="tag ${dl!==null&&dl<=2?'dl-soon':'dl'}">📅 ${dateLbl(_detDl)} ${dl===null?'':dl<0?'已截止':dl===0?'今天截止':`${dl}天後截止`}</span>`:''}
      ${todo.startDate?`<span class="tag scope">顯示從 ${dateLbl(todo.startDate)}</span>`:''}
      ${isRec?`<span class="tag rec">${recLbl(todo)}</span>`:''}
      ${isRec&&nxt?`<span class="tag dl">下次：${nxt.getMonth()+1}/${nxt.getDate()}</span>`:''}
      ${todo.targetType==='self'?`<span class="tag priv">🔒 僅自己可見</span>`:''}
    </div>
    ${(todo.targetEmps||[]).length?`<div class="todo-persons" style="margin-bottom:8px;">👤 ${todo.targetEmps.map(n=>getDN(n)).join('、')}</div>`:''}
    <div style="font-size:11px;color:var(--text-muted);">由 ${todo.createdByDisplay||getDN(todo.createdBy)} ${todo.createdByStore?`（${todo.createdByStore}）`:''} 建立</div>`;
  document.getElementById('detActions').innerHTML=canManage(todo)
    ?`<button class="det-btn edit" onclick="openEdit('${id}')">✏️ 編輯</button><button class="det-btn del" onclick="delTodo('${id}')">🗑️ 刪除</button>`:'' ;
  openModal('detailModal');
}

// 刪除
async function delTodo(id){
  if(!confirm('確定要刪除？'))return;
  closeModal('detailModal');showLoading('刪除中...');
  try{
    await window.db.collection('todos').doc(id).update({deleted:true,deletedBy:myDisplay(),deletedAt:toDay()});
    allTodos=allTodos.filter(t=>t.id!==id);renderAll();showToast('✅ 已刪除');
  }catch(e){showToast('❌ 失敗：'+e.message);}
  hideLoading();
}

// 新增/編輯
function openAddModal(){
  editingId=null;curType='task';curRec=false;
  selTarget=isManager()?'store':'self';selStores=[];selPersons=[];
  document.getElementById('addTitle').textContent='新增代辦';
  document.getElementById('addBtn').textContent='確認新增';
  document.getElementById('fTitle').value='';document.getElementById('fNote').value='';
  document.getElementById('fStart').value=toDay();document.getElementById('fEnd').value='';
  document.getElementById('fRecType').value='weekly';document.getElementById('fRecDay').value='1';
  document.getElementById('fRecInt').value='7';document.getElementById('fRecEnd').value='';
  setType('task');setRec(false);renderTgtGrp();onRecTypeChange();
  // 員工私密提示
  document.getElementById('empPrivateHint').style.display=!isManager()?'flex':'none';
  openModal('addModal');
}
function openEdit(id){
  closeModal('detailModal');
  const todo=allTodos.find(t=>t.id===id);if(!todo)return;
  editingId=id;curType=todo.type||'task';curRec=!!todo.isRecurring;
  selTarget=todo.targetType||'self';
  selStores=todo.targetStores||(todo.targetStore?[todo.targetStore]:[]);
  selPersons=todo.targetEmps||[];
  document.getElementById('addTitle').textContent='編輯代辦';
  document.getElementById('addBtn').textContent='儲存修改';
  document.getElementById('fTitle').value=todo.title||'';document.getElementById('fNote').value=todo.note||'';
  document.getElementById('fStart').value=todo.startDate||toDay();document.getElementById('fEnd').value=todo.endDate||'';
  document.getElementById('fRecType').value=todo.recurringType||'weekly';
  document.getElementById('fRecDay').value=todo.recurringDay||'1';
  document.getElementById('fRecInt').value=todo.recurringInterval||'7';
  document.getElementById('fRecEnd').value=todo.recurringEnd||'';
  setType(curType);setRec(curRec);renderTgtGrp();onRecTypeChange();
  document.getElementById('empPrivateHint').style.display='none';
  openModal('addModal');
}

function setType(t){
  curType=t;
  document.getElementById('pillTask').classList.toggle('on',t==='task');
  document.getElementById('pillAnn').classList.toggle('on',t==='announcement');
  document.getElementById('fEndGroup').style.display=t==='announcement'?'block':'none';
}
function setRec(r){
  curRec=r;
  document.getElementById('pillOnce').classList.toggle('on',!r);
  document.getElementById('pillRec').classList.toggle('on',r);
  document.getElementById('recSub').classList.toggle('show',r);
}
function onRecTypeChange(){
  const t=document.getElementById('fRecType').value;
  document.getElementById('recDayGrp').style.display=t==='custom'?'none':'block';
  document.getElementById('recIntGrp').style.display=t==='custom'?'block':'none';
  document.getElementById('recDayLbl').textContent=t==='monthly'?'每月幾號':'星期幾';
  const cur=document.getElementById('fRecDay');
  if(t==='monthly'){
    const ns=document.createElement('select');ns.id='fRecDay';ns.className=cur.className;
    for(let d=1;d<=31;d++){const o=document.createElement('option');o.value=String(d);o.textContent=d+'號';ns.appendChild(o);}
    const ol=document.createElement('option');ol.value='last';ol.textContent='最後一天（月底）';ns.appendChild(ol);
    ns.value='1';cur.replaceWith(ns);
  } else if(t==='weekly'){
    const ns=document.createElement('select');ns.id='fRecDay';ns.className=cur.className;
    ['週一','週二','週三','週四','週五','週六','週日'].forEach((d,i)=>{const o=document.createElement('option');o.value=String(i+1);o.textContent=d;ns.appendChild(o);});
    ns.value='1';cur.replaceWith(ns);
  }
}

// 指派對象
function renderTgtGrp(){
  const grp=document.getElementById('targetGrp');
  if(!isManager()){grp.style.display='none';return;}
  grp.style.display='block';
  const opts=isAdmin()
    ?[{v:'self',l:'只有我'},{v:'store',l:'指定門市'},{v:'stores_manager',l:'指定店長'},{v:'specific',l:'特定人員'},{v:'all',l:'全體'}]
    :[{v:'self',l:'只有我'},{v:'store',l:'本店全部'},{v:'stores_manager',l:'其他店長'},{v:'specific',l:'特定人員'}];
  document.getElementById('tgtChips').innerHTML=opts.map(o=>`<span class="target-chip ${selTarget===o.v?'on':''}" onclick="setTgt('${o.v}')">${o.l}</span>`).join('');
  // ✅ 只有我的私密提示
  document.getElementById('privateHint').classList.toggle('show',selTarget==='self');
  renderStoreChips();renderPersonChips();updateTgtPreview();
}
function setTgt(v){selTarget=v;selStores=[];selPersons=[];renderTgtGrp();}
function renderStoreChips(){
  const g=document.getElementById('storeGrp');
  const show=(isAdmin()&&['store','stores_manager'].includes(selTarget))||(!isAdmin()&&isManager()&&selTarget==='stores_manager');
  if(!show){g.style.display='none';return;}
  g.style.display='block';
  document.getElementById('storeChips').innerHTML=(appConfig.stores||[]).map(s=>`<span class="target-chip ${selStores.includes(s)?'on':''}" onclick="togStore('${s}')">${s}</span>`).join('');
  updateTgtPreview();
}
function togStore(s){const i=selStores.indexOf(s);if(i>=0)selStores.splice(i,1);else selStores.push(s);renderStoreChips();}
async function renderPersonChips(){
  const g=document.getElementById('personGrp');
  if(selTarget!=='specific'){g.style.display='none';updateTgtPreview();return;}
  g.style.display='block';
  const stores=isAdmin()?(appConfig.stores||[]):[myStore()];
  let emps=[];
  for(const s of stores){
    if(!empListCache[s]){const snap=await window.db.collection('stores').doc(s).collection('employees').get().catch(()=>null);empListCache[s]=[];if(snap)snap.forEach(d=>{if(!['離職','調走'].includes(d.data().status))empListCache[s].push(d.id);});}
    emps=emps.concat(empListCache[s].map(n=>({s,n})));
  }
  document.getElementById('personChips').innerHTML=emps.map(e=>`<span class="person-chip ${selPersons.includes(e.n)?'on':''}" onclick="togPerson('${e.n}')">${getDN(e.n)}${stores.length>1?` <small style="color:var(--text-muted);">${e.s}</small>`:''}</span>`).join('');
  updateTgtPreview();
}
function togPerson(n){const i=selPersons.indexOf(n);if(i>=0)selPersons.splice(i,1);else selPersons.push(n);renderPersonChips();}
async function updateTgtPreview(){
  const prev=document.getElementById('tgtPreview'),names=document.getElementById('tgtPreviewNames');
  if(!prev||!names)return;
  if(selTarget==='self'){prev.classList.remove('show');return;}
  if(selTarget==='all'){prev.classList.add('show');names.textContent='全體員工';return;}
  if(selTarget==='stores_manager'){
    // ✅ 從 account 讀取實際店長名字
    const stores=selStores.length>0?selStores:(appConfig.stores||[]);
    try{
      const accSnap=await window.db.collection('users').where('permission','==','manager').get();
      const mgrs=[];
      accSnap.forEach(d=>{
        const a=d.data();
        if(stores.includes(a.store)){mgrs.push(getDN(a.empName)||a.displayName||a.empName||'');}
      });
      if(mgrs.length>0){prev.classList.add('show');names.textContent=mgrs.join('、');return;}
    }catch(e){}
    prev.classList.add('show');names.textContent='各門市店長';return;
  }
  const stores=selTarget==='store'?(selStores.length>0?selStores:[myStore()]):[myStore()];
  let ns=[];
  if(selTarget==='specific'){ns=selPersons.map(n=>getDN(n));}
  else{for(const s of stores){if(!empListCache[s]){const snap=await window.db.collection('stores').doc(s).collection('employees').get().catch(()=>null);empListCache[s]=[];if(snap)snap.forEach(d=>{if(!['離職','調走'].includes(d.data().status))empListCache[s].push(d.id);});}empListCache[s].forEach(n=>ns.push(getDN(n)));}}
  if(!ns.length){prev.classList.remove('show');return;}
  prev.classList.add('show');names.textContent=ns.join('、');
}

// 儲存
async function saveTodo(){
  const title=document.getElementById('fTitle').value.trim();
  if(!title){showToast('⚠️ 請輸入標題');return;}
  const recDayEl=document.getElementById('fRecDay');
  let tStore='',tStores=[],tEmps=[];
  if(['store','stores_manager'].includes(selTarget)){
    if(isAdmin()||selTarget==='stores_manager'){tStores=selStores.length>0?[...selStores]:[...(appConfig.stores||[])];}
    else tStore=myStore();
  }
  if(selTarget==='specific')tEmps=[...selPersons];
  const data={
    type:curType,isRecurring:curRec,title,
    note:document.getElementById('fNote').value.trim(),
    startDate:document.getElementById('fStart').value||toDay(),
    endDate:curType==='announcement'?(document.getElementById('fEnd').value||''):'',
    targetType:isManager()?selTarget:'self',
    targetStore:tStore,targetStores:tStores,targetEmps:tEmps,
    createdBy:myName(),createdByDisplay:myDisplay(),createdByStore:myStore(),
    deleted:false,
  };
  if(curRec){
    data.recurringType=document.getElementById('fRecType').value;
    data.recurringDay=recDayEl?recDayEl.value:'1';
    data.recurringInterval=parseInt(document.getElementById('fRecInt').value)||7;
    data.recurringEnd=document.getElementById('fRecEnd').value||'';
  }
  showLoading('儲存中...');
  try{
    if(editingId){
      await window.db.collection('todos').doc(editingId).update({...data,updatedAt:new Date().toISOString()});
      const i=allTodos.findIndex(t=>t.id===editingId);if(i>=0)allTodos[i]={...allTodos[i],...data};
      showToast('✅ 已更新');
    }else{
      data.createdAt=firebase.firestore.FieldValue.serverTimestamp();
      const ref=await window.db.collection('todos').add(data);
      allTodos.unshift({id:ref.id,...data});showToast('✅ 已新增');
    }
    closeModal('addModal');renderAll();
  }catch(e){showToast('❌ 儲存失敗：'+e.message);}
  hideLoading();
}

// 月曆
function toggleCal(){document.getElementById('calBar').classList.toggle('collapsed');}
function changeCalMonth(o){calM+=o;if(calM>11){calM=0;calY++;}if(calM<0){calM=11;calY--;}renderCal();}

let longPressTimer=null;
function calDayLongPress(ds){
  longPressTimer=setTimeout(()=>{
    longPressTimer=null;
    // 長按某天 → 開啟新增 Modal 並帶入日期
    openAddModal();
    document.getElementById('fStart').value=ds;
    showToast(`📅 已選擇 ${dateLbl(ds)}，填入開始日期`);
  },500);
}
function calDayLongPressCancel(){if(longPressTimer){clearTimeout(longPressTimer);longPressTimer=null;}}

function renderCal(){
  document.getElementById('calLabel').textContent=`${calY}年${calM+1}月`;
  const hdr=document.getElementById('calHdr'),days=document.getElementById('calDays');
  if(!hdr||!days)return;
  hdr.innerHTML=['一','二','三','四','五','六','日'].map(d=>`<div class="cal-wday">${d}</div>`).join('');
  const today=toDay();
  const events={};
  allTodos.filter(t=>visible(t)).forEach(t=>{
    const add=(ds,type)=>{if(!events[ds])events[ds]=new Set();events[ds].add(type);};
    if(t.isRecurring){
      // 掃描本月所有週，找出所有觸發日
      const firstDay=new Date(calY,calM,1);
      const lastDay=new Date(calY,calM+1,0);
      if(t.recurringType==='weekly'||t.recurringType==='monthly'){
        // 只掃一次本月的觸發
        let cur=new Date(firstDay);
        while(cur<=lastDay){
          const n=calcNext(t,cur);
          if(!n||n>lastDay)break;
          const ds=`${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-${String(n.getDate()).padStart(2,'0')}`;
          add(ds,t.type==='announcement'?'announce':'recurring');
          cur=new Date(n);cur.setDate(cur.getDate()+1);
          if(t.recurringType==='monthly')break; // 每月只有一次
        }
      } else if(t.recurringType==='custom'){
        const iv=parseInt(t.recurringInterval||7);
        const start=t.startDate?new Date(t.startDate):firstDay;
        let cur=new Date(start);
        while(cur<firstDay)cur.setDate(cur.getDate()+iv);
        while(cur<=lastDay){
          const ds=`${cur.getFullYear()}-${String(cur.getMonth()+1).padStart(2,'0')}-${String(cur.getDate()).padStart(2,'0')}`;
          add(ds,t.type==='announcement'?'announce':'recurring');
          cur.setDate(cur.getDate()+iv);
        }
      }
    } else {
      const mo=`${calY}-${String(calM+1).padStart(2,'0')}`;
      if(t.type==='announcement'&&t.endDate&&t.endDate.startsWith(mo))add(t.endDate,'announce');
      if(t.startDate&&t.startDate.startsWith(mo))add(t.startDate,t.type==='announcement'?'announce':'task');
    }
  });
  const firstDow=new Date(calY,calM,1).getDay();
  const dim=new Date(calY,calM+1,0).getDate();
  const prev=new Date(calY,calM,0).getDate();
  const off=(firstDow+6)%7; // 週一為第一天
  let html='';
  for(let i=off-1;i>=0;i--)html+=`<div class="cal-day other-month">${prev-i}</div>`;
  for(let d=1;d<=dim;d++){
    const ds=`${calY}-${String(calM+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const isT=ds===today,isSel=ds===selCalDate;
    const ev=events[ds]?[...events[ds]]:[];
    const dots=ev.map(t=>`<div class="cal-dot ${t}"></div>`).join('');
    // 長按新增代辦
    html+=`<div class="cal-day${isT?' today':''}${isSel?' selected':''}"
      onclick="selDate('${ds}')"
      onmousedown="calDayLongPress('${ds}')" onmouseup="calDayLongPressCancel()" onmouseleave="calDayLongPressCancel()"
      ontouchstart="calDayLongPress('${ds}')" ontouchend="calDayLongPressCancel()" ontouchmove="calDayLongPressCancel()">
      ${d}${ev.length?`<div class="cal-dots">${dots}</div>`:''}
    </div>`;
  }
  // ✅ 補滿最後一週，確保 6 行全部顯示（避免最後一週被切掉）
  const totalCells=off+dim;
  const rem=totalCells%7===0?0:7-(totalCells%7);
  for(let d=1;d<=rem;d++)html+=`<div class="cal-day other-month">${d}</div>`;
  days.innerHTML=html;
}
function selDate(ds){
  if(longPressTimer)return; // 長按中不觸發選擇
  selCalDate=(selCalDate===ds)?null:ds;
  if(selCalDate&&document.getElementById('calBar').classList.contains('collapsed'))document.getElementById('calBar').classList.remove('collapsed');
  renderAll();
}
