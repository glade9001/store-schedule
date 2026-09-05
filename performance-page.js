let currentUser=null, appConfig={}, curStore='', pnlCache={}, perfCache={}, editMonth='';
const PERF_EXCLUDE=new Set(['2026-04']); // 2026/4 系統剛上線、薪資未完整結算，人事成本一律不列入分析
const START='2025-07';
const isAdminOwner=()=>['owner','admin'].includes(currentUser?.permission);
const canUse=()=>['manager','owner','admin'].includes(currentUser?.permission);
const pad=n=>String(n).padStart(2,'0');
const money=n=>Math.round(n||0).toLocaleString('en-US');
const showLoading=t=>{document.getElementById('loadingText').textContent=t||'載入中…';document.getElementById('loadingOverlay').classList.remove('hidden');};
const hideLoading=()=>document.getElementById('loadingOverlay').classList.add('hidden');
let _tt;
function toast(m){const t=document.getElementById('toast');t.textContent=m;t.classList.add('show');clearTimeout(_tt);_tt=setTimeout(()=>t.classList.remove('show'),2200);}
function monthLabel(m){const[y,mo]=m.split('-');return `${y} 年 ${parseInt(mo)} 月`;}
function prevYearMonth(m){const[y,mo]=m.split('-');return `${parseInt(y)-1}-${mo}`;}

// 產生月份清單：START ~ 上個月（新→舊）
function monthList(){
  const now=new Date();
  const end=new Date(now.getFullYear(),now.getMonth(),1); end.setMonth(end.getMonth()-1); // 上個月
  const out=[]; let[sy,sm]=START.split('-').map(Number);
  let y=end.getFullYear(),mo=end.getMonth()+1;
  while(y>sy||(y===sy&&mo>=sm)){ out.push(`${y}-${pad(mo)}`); mo--; if(mo<1){mo=12;y--;} }
  return out; // 新→舊
}

window.onload=async()=>{
  showLoading('驗證登入…');
  const saved=localStorage.getItem('currentUser')||sessionStorage.getItem('currentUser');
  if(!saved){location.replace('home.html');return;}
  try{currentUser=JSON.parse(saved);}catch(e){location.replace('home.html');return;}
  const fb=await new Promise(r=>{const u=firebase.auth().onAuthStateChanged(x=>{u();r(x);});});
  if(!fb){localStorage.removeItem('currentUser');location.replace('home.html');return;}
  if(!canUse()){toast('僅店長以上可用');setTimeout(()=>location.replace('home.html'),1200);return;}
  try{
    const s=await window.db.collection('settings').doc('globalConfig').get();
    if(s.exists)appConfig=s.data();
  }catch(e){}
  const stores=appConfig.stores||[];
  if(isAdminOwner()){
    const sel=document.getElementById('storeSel'); sel.style.display='block';
    sel.innerHTML=stores.map(s=>`<option value="${s}">${s}</option>`).join('');
    curStore=stores[0]||currentUser.store||'';
    sel.value=curStore;
  }else{
    curStore=currentUser.store||'';
  }
  await loadList();
  hideLoading();
};

async function onStoreChange(){
  curStore=document.getElementById('storeSel').value;
  // ⚠️ 期間(anaFrom/anaTo)是全域的：換門市不重設的話，會沿用上一家的月份範圍。
  //    例：美德最新只到 7 月 → 切到有 8 月的聯鑫，anaTo 仍停在 2026-07（在新店也存在故不會被修正）→ 8 月被濾掉不見。
  anaFrom=''; anaTo='';
  showLoading('載入…'); await loadList(); if(curTab==='analysis')renderAnalysis(); hideLoading();
}

async function loadList(){
  pnlCache={}; perfCache={}; cmpData=null;
  try{
    const snap=await window.db.collection('stores').doc(curStore).collection('pnl').get();
    snap.forEach(d=>pnlCache[d.id]=d.data());
  }catch(e){ toast('讀取失敗：'+e.message); }
  try{
    const ps=await window.db.collection('stores').doc(curStore).collection('perfSnapshot').get();
    ps.forEach(d=>perfCache[d.id]=d.data());
  }catch(e){}
  renderList();
}

function renderList(){
  const months=monthList();
  const wrap=document.getElementById('listWrap');
  if(!months.length){ wrap.innerHTML=`<div class="empty">目前沒有需要輸入的月份</div>`; return; }
  const todo=months.filter(m=>!pnlCache[m]);
  let html='';
  if(todo.length) html+=`<div class="sec-title">🔴 待輸入（${todo.length}）</div>`+
    months.filter(m=>!pnlCache[m]).map(m=>monCard(m,false)).join('');
  const done=months.filter(m=>pnlCache[m]);
  if(done.length) html+=`<div class="sec-title">✅ 已輸入（${done.length}）</div>`+
    done.map(m=>monCard(m,true)).join('');
  wrap.innerHTML=html;
}
function monCard(m,done){
  return `<div class="mon-card" onclick="openEdit('${m}')">
    <div class="mon-title">${monthLabel(m)}</div>
    <div class="mon-badge ${done?'b-done':'b-todo'}">${done?'✅ 已輸入':'🔴 待輸入'}</div>
    <div class="mon-arrow">›</div>
  </div>`;
}

function radioVal(name){ const el=document.querySelector(`input[name="${name}"]:checked`); return el?el.value:''; }
function onInvChange(){
  const t=radioVal('invType'); const inv=document.getElementById('fInv'); const amt=Math.abs(num('fInv')||0);
  inv.disabled=(t==='none'); if(t==='none') inv.value='';
  const p=document.getElementById('invPreview');
  if(t==='none'){ p.textContent='→ 本月無盤點'; p.style.color='#64748b'; }
  else if(t==='loss'){ p.textContent=`→ 本月盤損 ${money(amt)} 元（損失，計入損耗）`; p.style.color='#c5221f'; }
  else { p.textContent=`→ 本月盤盈 ${money(amt)} 元（收益，抵減損耗）`; p.style.color='#137333'; }
}
// ⚠️ 不要求店長自己打負號（2026-09-05 店長回報「打不出負號」）：
//    input 帶 inputmode="numeric" 時 Android 跳的是純數字鍵盤，**沒有負號鍵**，
//    溢餘那個月根本輸入不了。比照旁邊的「盤點結果」改成「選狀態＋填正金額」，
//    資料庫存的仍是有號數（正＝短少、負＝溢餘），下游圖表與淨損耗公式完全不動。
function onCashChange(){
  const t=radioVal('cashType'); const el=document.getElementById('fCash');
  const amt=Math.abs(num('fCash')||0);
  el.disabled=(t==='none'); if(t==='none') el.value='';
  const p=document.getElementById('cashPreview');
  if(t==='none'||!amt){ p.textContent='→ 本月無短溢'; p.style.color='#64748b'; }
  else if(t==='over'){ p.textContent=`→ 本月現金溢餘 ${money(amt)} 元（抵減成本）`; p.style.color='#137333'; }
  else { p.textContent=`→ 本月現金短少 ${money(amt)} 元（費用，計入損耗）`; p.style.color='#c5221f'; }
}

function openEdit(m){
  editMonth=m;
  document.getElementById('editTitle').textContent=`${monthLabel(m)}　${curStore}`;
  const d=pnlCache[m]||{};
  document.getElementById('fNetSales').value=d.netSales??'';
  document.getElementById('fGross').value=d.grossMargin??'';
  document.getElementById('fBad').value=d.badGoodsCost??'';
  document.getElementById('fElec').value=d.elecCost??'';
  document.getElementById('fMisc').value=d.miscCost??'';
  document.getElementById('fReward').value=d.operatingReward??'';
  // 盤點結果 radio
  const invT=(d.noStocktake||d.invResult==null)?'none':((d.invResult>0)?'gain':'loss');
  document.querySelector(`input[name="invType"][value="${invT}"]`).checked=true;
  document.getElementById('fInv').value=(invT==='none')?'':Math.abs(d.invResult);
  // 現金短溢：直接顯示含負號的數字（正=短少、負=溢餘），照損益表
  const cd=(d.cashDiff==null)?null:Number(d.cashDiff);
  const cashT=(cd==null)?'':(cd===0?'none':(cd>0?'short':'over'));
  document.querySelectorAll('input[name="cashType"]').forEach(r=>{ r.checked=(r.value===cashT); });
  document.getElementById('fCash').value=(cd==null||cd===0)?'':Math.abs(cd);
  onInvChange(); onCashChange();
  document.getElementById('cmpBox').innerHTML='';
  if(pnlCache[m]) viewMode(m); else editMode();   // 已輸入→檢視；待輸入→直接編輯
  document.getElementById('editOverlay').classList.add('show');
}
function viewMode(m){
  document.getElementById('formSection').style.display='none';
  document.getElementById('editBtn').style.display='block';
  document.getElementById('editSub').textContent='已輸入 · 點右上「編輯」可修改數字';
  showComparison(m);
}
function editMode(){
  document.getElementById('formSection').style.display='block';
  document.getElementById('editBtn').style.display='none';
  document.getElementById('editSub').textContent=pnlCache[editMonth]?'修改數字後重新儲存並比較':'請照公司損益表填入';
  document.getElementById('cmpBox').innerHTML='';
}
function switchToEdit(){ editMode(); }
function closeEdit(){ document.getElementById('editOverlay').classList.remove('show'); }

const num=id=>{const v=parseFloat(document.getElementById(id).value);return isNaN(v)?null:v;};

async function saveMonth(){
  const netSales=num('fNetSales'), grossMargin=num('fGross'), badGoodsCost=num('fBad'),
        elecCost=num('fElec'), miscCost=num('fMisc'), operatingReward=num('fReward');
  // 盤點結果：狀態選擇→符號(盤損=負/盤盈=正/無盤點=null)
  const invType=radioVal('invType');
  const noStocktake=(invType==='none');
  let invResult;
  if(noStocktake){ invResult=null; }
  else { const a=Math.abs(num('fInv')||0); invResult=(invType==='gain')?a:-a; }
  // 現金短溢：照損益表數字直接填(含負號，正=短少/負=溢餘)，未填視為 0
  const cashType=radioVal('cashType');
  let cashDiff=0;
  if(cashType && cashType!=='none'){ const ca=Math.abs(num('fCash')||0); cashDiff=(cashType==='over')?-ca:ca; }
  // 必填檢查
  if([netSales,grossMargin,badGoodsCost,elecCost,miscCost,operatingReward].some(v=>v===null) || !invType || !cashType){
    toast('請完整填寫營業淨額/毛利率/壞品/電費/雜支/經營報酬，並選盤點狀態與現金短溢狀態'); return;
  }
  showLoading('儲存中…');
  const rec={ store:curStore, month:editMonth, netSales, grossMargin, badGoodsCost, elecCost, miscCost, cashDiff,
    operatingReward, invResult, noStocktake, badGoodsSubsidy: firebase.firestore.FieldValue.delete(),
    submittedBy:currentUser.empName||'', submittedByName:(currentUser.displayName||currentUser.empName||''),
    submittedAt:new Date().toISOString(), updatedAt:new Date().toISOString() };
  try{
    await window.db.collection('stores').doc(curStore).collection('pnl').doc(editMonth).set(rec,{merge:true});
    pnlCache[editMonth]=rec;
    // 新存的月份若比目前分析範圍還新 → 把範圍拉到它，否則剛輸入的月份在統計分析看不到
    if(anaTo && editMonth>anaTo) anaTo=editMonth;
    if(anaFrom && editMonth<anaFrom) anaFrom=editMonth;
    // 只有「有去年同期資料」才會通知全體（回填月份無同期→不發送）
    let hasPrev=false;
    try{ const ps=await window.db.collection('stores').doc(curStore).collection('pnl').doc(prevYearMonth(editMonth)).get(); hasPrev=ps.exists; }catch(e){}
    toast(hasPrev ? '✅ 已儲存，已通知全體店長' : '✅ 已儲存');
    renderList();
    viewMode(editMonth); // 存完切回檢視模式（只看績效，右上可再編輯）
  }catch(e){ toast('儲存失敗：'+e.message); }
  hideLoading();
}

// 指標比較 → HTML
function fmtInv(rec){
  if(!rec||rec.noStocktake||rec.invResult==null) return '本月無盤點';
  if(rec.invResult<0) return `盤損 ${money(-rec.invResult)}元`;
  if(rec.invResult>0) return `盤盈 ${money(rec.invResult)}元`;
  return '0 元';
}
async function showComparison(m){
  const cur=pnlCache[m];
  const pm=prevYearMonth(m);
  let prev=null;
  try{ const ps=await window.db.collection('stores').doc(curStore).collection('pnl').doc(pm).get(); if(ps.exists)prev=ps.data(); }catch(e){}
  const rows=[];
  const upDown=(curV,prevV,unit,goodUp,fmt)=>{
    if(prev==null||prevV==null) return `<div class="cmp-delta neu">（同期無資料）</div>`;
    const d=curV-prevV, abs=fmt(Math.abs(d));
    const better = goodUp ? d>=0 : d<=0;
    const word = goodUp ? (d>=0?'成長':'衰退') : (d<=0?'減少':'增加');
    const mark = better?'✅':'❌';
    return `<div class="cmp-delta ${better?'up':'down'}">（較同期${word} ${mark} ${abs}${unit}）</div>`;
  };
  const neutralDelta=(curV,prevV,unit,fmt)=>{
    if(prev==null||prevV==null) return `<div class="cmp-delta neu">（同期無資料）</div>`;
    const d=curV-prevV;
    const word=d>=0?'增加':'減少';
    return `<div class="cmp-delta neu">（較同期${word} ${fmt(Math.abs(d))}${unit}）</div>`;
  };
  rows.push(`<div class="cmp-row"><div class="cmp-metric">營業淨額 ${money(cur.netSales)}</div>${upDown(cur.netSales,prev?.netSales,'元',true,money)}</div>`);
  rows.push(`<div class="cmp-row"><div class="cmp-metric">壞品 ${money(cur.badGoodsCost)}元</div>${upDown(cur.badGoodsCost,prev?.badGoodsCost,'元',false,money)}</div>`);
  // 盤損
  let invCmp;
  if(prev==null||prev.noStocktake||prev.invResult==null) invCmp=`<div class="cmp-delta neu">（同期無盤點）</div>`;
  else if(cur.noStocktake||cur.invResult==null) invCmp=`<div class="cmp-delta neu">（本月無盤點）</div>`;
  else invCmp=upDown(cur.invResult,prev.invResult,'元',true,money);
  rows.push(`<div class="cmp-row"><div class="cmp-metric">${fmtInv(cur)}</div>${invCmp}</div>`);
  rows.push(`<div class="cmp-row"><div class="cmp-metric">毛利 ${cur.grossMargin}%</div>${upDown(cur.grossMargin,prev?.grossMargin,'%',true,v=>v.toFixed(2))}</div>`);
  rows.push(`<div class="cmp-row"><div class="cmp-metric">門市電費 ${money(cur.elecCost)}元</div>${upDown(cur.elecCost,prev?.elecCost,'元',false,money)}</div>`);
  rows.push(`<div class="cmp-row"><div class="cmp-metric">雜支 ${money(cur.miscCost)}元</div>${upDown(cur.miscCost,prev?.miscCost,'元',false,money)}</div>`);
  rows.push(`<div class="cmp-row"><div class="cmp-metric">現金短少 ${money(cur.cashDiff)}元${cur.cashDiff>0?'（短少）':cur.cashDiff<0?'（溢餘）':''}</div>${neutralDelta(cur.cashDiff,prev?.cashDiff,'元',money)}</div>`);
  rows.push(`<div class="cmp-row"><div class="cmp-metric">經營報酬 ${money(cur.operatingReward)}元</div>${upDown(cur.operatingReward,prev?.operatingReward,'元',true,money)}</div>`);
  document.getElementById('cmpBox').innerHTML=`<div class="cmp"><div class="cmp-title">${curStore} ${m.split('-')[0]}年${parseInt(m.split('-')[1])}月 經營績效</div>${rows.join('')}</div>`;
}

// ===== 📊 統計分析（Phase 1：損益指標逐月趨勢）=====
let curTab='input', anaFrom='', anaTo='';
function switchTab(t){
  curTab=t;
  document.getElementById('tab-input').classList.toggle('active',t==='input');
  document.getElementById('tab-analysis').classList.toggle('active',t==='analysis');
  document.getElementById('tabInput').style.display=t==='input'?'block':'none';
  document.getElementById('tabAnalysis').style.display=t==='analysis'?'block':'none';
  if(t==='analysis')renderAnalysis();
}
// 點值精簡格式：萬/整數/一位小數
function ptFmt(v){ if(v==null)return''; const a=Math.abs(v); if(a>=10000)return (v/10000).toFixed(1)+'萬'; if(Number.isInteger(v))return String(v); return v.toFixed(1); }
function lineChart(points,opt){
  opt=opt||{};
  const esc=s=>String(s==null?'':s).replace(/['"\\<>]/g,'');
  const fmtV=v=>opt.fmt?opt.fmt(v):ptFmt(v);
  // 去掉前後端連續空值（前期沒資料就不留空白、不用往左滑找）
  let a=0,b=points.length-1;
  while(a<=b && points[a].value==null)a++;
  while(b>=a && points[b].value==null)b--;
  if(a>b)return '<div style="font-size:12px;color:var(--text-muted);">尚無資料</div>';
  points=points.slice(a,b+1);
  const vals=points.map(p=>p.value).filter(v=>v!=null);
  if(!vals.length)return '<div style="font-size:12px;color:var(--text-muted);">尚無資料</div>';
  const n=points.length, W=Math.max(600,n*58), H=192, pl=38,pr=42,pt=28,pb=28, iw=W-pl-pr, ih=H-pt-pb;
  let min=Math.min(...vals),max=Math.max(...vals);if(min===max){min=min-Math.abs(min||1)*0.1;max=max+Math.abs(max||1)*0.1;}
  const X=i=>pl+(n<=1?iw/2:i/(n-1)*iw);
  const Y=v=>pt+ih-(v-min)/(max-min)*ih;
  // 平均線（虛線）＋左上標示
  // Y 軸刻度線（3 等分，淺灰）
  let grid='';
  for(let t=0;t<=3;t++){const gv=min+(max-min)*t/3, gy=Y(gv);
    grid+=`<line x1="${pl}" y1="${gy.toFixed(1)}" x2="${(W-pr).toFixed(1)}" y2="${gy.toFixed(1)}" stroke="#eef1f4" stroke-width="1"/>`+
      `<text x="${(pl-5)}" y="${(gy+3).toFixed(1)}" font-size="8" fill="#bbb" text-anchor="end">${ptFmt(gv)}</text>`;}
  const avg=vals.reduce((s,v)=>s+v,0)/vals.length, avgY=Y(avg);
  const avgLine=`<line x1="${pl}" y1="${avgY.toFixed(1)}" x2="${(W-pr).toFixed(1)}" y2="${avgY.toFixed(1)}" stroke="${opt.color}" stroke-width="1" stroke-dasharray="4 3" opacity=".45"/>`+
    `<text x="${(pl+2)}" y="${(avgY-4).toFixed(1)}" font-size="8.5" fill="${opt.color}" text-anchor="start" opacity=".9" font-weight="700">均 ${fmtV(avg)}</text>`;
  let path='',dots='',taps='',vlabels='',labels='';
  points.forEach((p,i)=>{if(p.value==null)return;const x=X(i),y=Y(p.value);
    path+=(path?' L':'M')+x.toFixed(1)+' '+y.toFixed(1);
    dots+=`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.8" fill="${opt.color}"/>`;
    taps+=`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="14" fill="transparent" style="cursor:pointer" onclick="showPt('${esc(p.label)}','${esc(fmtV(p.value))}','${esc(p.detail||'')}')"/>`;
    vlabels+=`<text x="${x.toFixed(1)}" y="${(y-6).toFixed(1)}" font-size="9" fill="${opt.color}" text-anchor="middle" font-weight="800">${ptFmt(p.value)}</text>`;});
  points.forEach((p,i)=>{labels+=`<text x="${X(i).toFixed(1)}" y="${H-8}" font-size="9" fill="#999" text-anchor="middle">${p.label}</text>`;});
  const scroll = W>600 ? 'min-width:'+W+'px;' : 'width:100%;';
  return `<div style="overflow-x:auto;"><svg viewBox="0 0 ${W} ${H}" style="${scroll}height:auto;">
    ${grid}${avgLine}<path d="${path}" fill="none" stroke="${opt.color}" stroke-width="2.2"/>${dots}${taps}${vlabels}${labels}</svg></div>`;
}
function showPt(title,val,detail){
  const el=document.getElementById('ptPop'); if(!el)return;
  el.innerHTML=`<div style="font-weight:900;font-size:14px;">${title}</div>`+
    `<div style="font-size:17px;font-weight:900;color:var(--primary);margin:2px 0 4px;">${val}</div>`+
    (detail?`<div style="font-size:12px;color:var(--text-muted);line-height:1.7;">${String(detail).split('｜').join('<br>')}</div>`:'');
  el.style.display='block';
  clearTimeout(window._ptT); window._ptT=setTimeout(()=>{el.style.display='none';},4500);
}
// 多線圖（三店同圖比較）：series=[{name,color,values:[...]}]，values 對齊 months
function multiLineChart(months, series, opt){
  opt=opt||{};
  const esc=s=>String(s==null?'':s).replace(/['"\\<>]/g,'');
  const fmtV=v=>opt.fmt?opt.fmt(v):ptFmt(v);
  const mlbl=m=>{const p=String(m).split('-');return `${p[0].slice(2)}/${parseInt(p[1])}`;};
  const hasAny=i=>series.some(s=>s.values[i]!=null);
  let a=0,b=months.length-1; while(a<=b&&!hasAny(a))a++; while(b>=a&&!hasAny(b))b--;
  if(a>b)return '<div style="font-size:12px;color:var(--text-muted);">此期間尚無資料</div>';
  months=months.slice(a,b+1); series=series.map(s=>({name:s.name,color:s.color,values:s.values.slice(a,b+1)}));
  const allV=[]; series.forEach(s=>s.values.forEach(v=>{if(v!=null)allV.push(v);}));
  if(!allV.length)return '<div style="font-size:12px;color:var(--text-muted);">此期間尚無資料</div>';
  const n=months.length, W=Math.max(600,n*58), H=214, pl=38,pr=42,pt=42,pb=28, iw=W-pl-pr, ih=H-pt-pb;
  let min=Math.min(...allV),max=Math.max(...allV); if(min===max){min=min-Math.abs(min||1)*0.1;max=max+Math.abs(max||1)*0.1;}
  const X=i=>pl+(n<=1?iw/2:i/(n-1)*iw), Y=v=>pt+ih-(v-min)/(max-min)*ih;
  let grid='';
  for(let t=0;t<=3;t++){const gv=min+(max-min)*t/3, gy=Y(gv);
    grid+=`<line x1="${pl}" y1="${gy.toFixed(1)}" x2="${(W-pr).toFixed(1)}" y2="${gy.toFixed(1)}" stroke="#eef1f4" stroke-width="1"/>`+
      `<text x="${(pl-5)}" y="${(gy+3).toFixed(1)}" font-size="8" fill="#bbb" text-anchor="end">${ptFmt(gv)}</text>`;}
  let body='';
  series.forEach(s=>{let path='',dots='',taps='';
    s.values.forEach((v,i)=>{if(v==null)return;const x=X(i),y=Y(v);
      path+=(path?' L':'M')+x.toFixed(1)+' '+y.toFixed(1);
      dots+=`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.6" fill="${s.color}"/>`;
      taps+=`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="12" fill="transparent" style="cursor:pointer" onclick="showPt('${esc(s.name)} · ${esc(mlbl(months[i]))}','${esc(fmtV(v))}','')"/>`;});
    body+=`<path d="${path}" fill="none" stroke="${s.color}" stroke-width="${s.dash?2:2.2}"${s.dash?' stroke-dasharray="6 4"':''}/>${dots}${taps}`;});
  let legend=''; series.forEach((s,i)=>{const lx=pl+i*96;legend+=`<circle cx="${lx}" cy="18" r="4.5" fill="${s.color}"/><text x="${lx+9}" y="22" font-size="11" fill="#333" font-weight="800">${esc(s.name)}</text>`;});
  let labels=''; months.forEach((m,i)=>{labels+=`<text x="${X(i).toFixed(1)}" y="${H-8}" font-size="9" fill="#999" text-anchor="middle">${mlbl(m)}</text>`;});
  const scroll=W>600?'min-width:'+W+'px;':'width:100%;';
  return `<div style="overflow-x:auto;"><svg viewBox="0 0 ${W} ${H}" style="${scroll}height:auto;">${grid}${legend}${body}${labels}</svg></div>`;
}
async function renderStoreTrend(){
  const box=document.getElementById('storeTrendBox'); if(!box)return;
  await loadAllForCompare();
  const sts=(appConfig.stores||[]).filter(s=>s!=='人力支援');
  const mset=new Set();
  sts.forEach(s=>Object.keys((cmpData[s]||{}).pnl||{}).forEach(k=>{if(/^\d{4}-\d{2}$/.test(k)&&k>=anaFrom&&k<=anaTo)mset.add(k);}));
  // 人事效率類指標也把有 perf 的月份納入(即使 pnl 缺，仍可能想看)；但目前指標多需 pnl，故以 pnl 月為主
  const months=[...mset].sort();
  if(!months.length){box.innerHTML='<div style="font-size:12px;color:var(--text-muted);">此期間尚無資料</div>';return;}
  const M=METRICS[cmpMetric]||METRICS.netSales;
  const series=sts.map(s=>({name:s,color:STORE_COLORS[s]||'#888',values:months.map(m=>{
    const pn=(cmpData[s]||{}).pnl[m];
    const pf=PERF_EXCLUDE.has(m)?null:(cmpData[s]||{}).perf[m];
    return M.get(pn, pf);
  })}));
  // 聚合線：門市餘裕用「總計」，其餘用「平均」
  const isSum=M.agg==='sum';
  const aggVals=months.map((m,i)=>{const vs=series.map(s=>s.values[i]).filter(v=>v!=null);
    if(!vs.length)return null; const sum=vs.reduce((a,b)=>a+b,0); return isSum?sum:sum/vs.length;});
  series.push({name:isSum?'總計':'平均',color:'#94a3b8',dash:true,values:aggVals});
  box.innerHTML=multiLineChart(months, series, {fmt:M.fmt})
    +`<div style="font-size:11px;color:var(--text-muted);margin-top:6px;">點線上的點看該店該月數值；人事類指標 2026/4 不列入。錦花無損益資料，僅工時相關可見。</div>`;
}
function renderAnalysis(){
  const wrap=document.getElementById('tabAnalysis');
  const allM=Object.keys(pnlCache).sort();
  if(!allM.length){wrap.innerHTML=`<div class="empty">尚無損益資料，請先在「損益輸入」建檔（從 2025/7 起）</div>`;return;}
  if(!anaFrom||!allM.includes(anaFrom))anaFrom=allM[0];
  if(!anaTo||!allM.includes(anaTo)||anaTo<anaFrom)anaTo=allM[allM.length-1];
  const months=allM.filter(m=>m>=anaFrom&&m<=anaTo);
  const mOpt=(sel)=>allM.map(m=>`<option value="${m}"${m===sel?' selected':''}>${m.split('-')[0]}/${parseInt(m.split('-')[1])}</option>`).join('');
  const rangeBar=`<div style="display:flex;align-items:center;gap:6px;margin-bottom:12px;font-size:13px;flex-wrap:wrap;">
    <span style="color:var(--text-muted);font-weight:800;">📅 期間</span>
    <select onchange="anaFrom=this.value;renderAnalysis();" style="padding:7px 8px;border:1.5px solid var(--border);border-radius:8px;font-weight:700;">${mOpt(anaFrom)}</select>
    <span>～</span>
    <select onchange="anaTo=this.value;renderAnalysis();" style="padding:7px 8px;border:1.5px solid var(--border);border-radius:8px;font-weight:700;">${mOpt(anaTo)}</select>
  </div>`;
  const lbl=m=>{const p=m.split('-');return `${p[0].slice(2)}/${parseInt(p[1])}`;};
  const pts=months.map(m=>({m,d:pnlCache[m]}));
  const last=months[months.length-1],L=pnlCache[last];
  const yoyD=pnlCache[prevYearMonth(last)]||null;
  const kpi=(label,cur,ym,fmt,unit,goodUp)=>{
    let delta='';
    if(ym!=null){const dv=cur-ym,better=goodUp?dv>=0:dv<=0;delta=`<div class="kpi-delta ${better?'up':'down'}">${better?'▲':'▼'} 同期${goodUp?(dv>=0?'+':''):''}${fmt(Math.abs(dv))}${unit}</div>`;}
    else delta=`<div class="kpi-delta neu">同期無資料</div>`;
    return `<div class="kpi"><div class="kpi-label">${label}</div><div class="kpi-val">${fmt(cur)}${unit}</div>${delta}</div>`;
  };
  // 人事費率 KPI（人事成本含支援÷營業淨額，越低越好；需該月已結算 perfSnapshot）
  const perfMs=months.filter(m=>perfCache[m]&&!PERF_EXCLUDE.has(m)&&pnlCache[m]&&pnlCache[m].netSales);
  const lp=perfMs.length?perfMs[perfMs.length-1]:null;
  let rateKpi='';
  let surplusKpi='';
  if(lp){const yp=prevYearMonth(lp);const cur=perfCache[lp].laborCost/pnlCache[lp].netSales*100;const ymv=(perfCache[yp]&&pnlCache[yp]&&pnlCache[yp].netSales)?perfCache[yp].laborCost/pnlCache[yp].netSales*100:null;rateKpi=kpi('人事費率',cur,ymv,v=>v.toFixed(1),'%',false);
    const sCur=pnlCache[lp].operatingReward-perfCache[lp].laborCost;const sYm=(perfCache[yp]&&pnlCache[yp])?pnlCache[yp].operatingReward-perfCache[yp].laborCost:null;surplusKpi=kpi('門市餘裕',sCur,sYm,money,'',true);}
  const kpiHtml=`<div class="kpi-row">
    ${kpi('營業淨額',L.netSales,yoyD&&yoyD.netSales,money,'',true)}
    ${kpi('毛利率',L.grossMargin,yoyD&&yoyD.grossMargin,v=>v.toFixed(2),'%',true)}
    ${kpi('經營報酬',L.operatingReward,yoyD&&yoyD.operatingReward,money,'',true)}
    ${rateKpi}
    ${surplusKpi}
  </div><div style="font-size:12px;color:var(--text-muted);margin:-6px 4px 12px;">最新：${last.split('-')[0]}年${parseInt(last.split('-')[1])}月 · ${curStore}（KPI 與去年同期比）</div>`;
  const chart=(title,key,fmt,color,unit)=>`<div class="chart-card"><div class="chart-title">${title}</div>${lineChart(pts.map(p=>({label:lbl(p.m),value:p.d[key]!=null?p.d[key]:null})),{fmt:v=>fmt(v)+unit,color})}</div>`;
  const derived=(title,color,fn,fmt,unit)=>{const dp=pts.map(p=>{
    const usable=perfCache[p.m]&&!PERF_EXCLUDE.has(p.m)&&p.d&&p.d.netSales;
    const pf=perfCache[p.m],pn=p.d;
    const det=usable?`營業淨額 ${money(pn.netSales)} 元｜經營報酬 ${money(pn.operatingReward)} 元｜人事成本(含支援) ${money(pf.laborCost)} 元｜總工時 ${pf.totalHours}h（本店${pf.ownHours} 支入${pf.supportInHours||0} 支出${pf.supportOutHours||0}）`:'';
    return {label:lbl(p.m),value:usable?fn(pf,pn):null,detail:det};
  });if(!dp.some(x=>x.value!=null))return '';return `<div class="chart-card"><div class="chart-title">${title}</div>${lineChart(dp,{fmt:v=>fmt(v)+unit,color})}</div>`;};
  wrap.innerHTML=rangeBar+kpiHtml
    +chart('營業淨額（元）','netSales',money,'#1a73e8','')
    +chart('毛利率（%）','grossMargin',v=>v.toFixed(1),'#34a853','')
    +chart('經營報酬（元）','operatingReward',money,'#e67e22','')
    +chart('壞品（元）','badGoodsCost',money,'#c5221f','')
    +chart('門市電費（元）','elecCost',money,'#0891b2','')
    +chart('雜支（元）','miscCost',money,'#7c3aed','')
    +chart('現金短少（元，正＝短少為成本）','cashDiff',money,'#c0620f','')
    +`<div class="chart-card"><div class="chart-title">淨損耗（壞品＋盤損＋現金短少，元，越低越好）</div>${lineChart(pts.map(p=>({label:lbl(p.m),value:p.d?((p.d.badGoodsCost||0)-(p.d.invResult||0)+(p.d.cashDiff||0)):null})),{fmt:money,color:'#b91c1c'})}</div>`
    +`<div style="font-size:12px;color:var(--text-muted);font-weight:700;margin:8px 4px 8px;">📈 人力效率（含支援，需該月薪資已結算，2026/5 起；2026/4 系統剛上線不列入）</div>`
    +derived('人事費率（人事成本÷營業淨額 %，越低越好）','#9334e6',(pf,pn)=>pf.laborCost/pn.netSales*100,v=>v.toFixed(1),'%')
    +derived('每工時營收（營業淨額÷總工時，元/h）','#0891b2',(pf,pn)=>pf.totalHours?pn.netSales/pf.totalHours:null,v=>Math.round(v).toLocaleString('en-US'),'')
    +derived('門市實際餘裕（經營報酬−人事成本，元）','#137333',(pf,pn)=>pn.operatingReward-pf.laborCost,money,'')
    +(isAdminOwner()?`<div class="chart-card">
      <div class="chart-title" style="margin-bottom:10px;">🏪 三店比較</div>
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-bottom:8px;">
        <span style="font-size:12.5px;font-weight:800;color:var(--text-muted);">趨勢</span>
        <select id="cmpMetricSel" onchange="cmpMetric=this.value;renderStoreTrend();" style="padding:6px 8px;border:1.5px solid var(--border);border-radius:8px;font-weight:700;font-size:12px;">${Object.keys(METRICS).map(k=>`<option value="${k}"${k===cmpMetric?' selected':''}>${METRICS[k].t}</option>`).join('')}</select>
      </div>
      <div id="storeTrendBox"><div style="font-size:12px;color:var(--text-muted);">載入中…</div></div>
      <div style="height:1px;background:var(--border);margin:14px 0 10px;"></div>
      <div style="font-size:12.5px;font-weight:800;color:var(--text-muted);margin-bottom:6px;">單月對照</div>
      <div id="compareBox"><div style="font-size:12px;color:var(--text-muted);">載入中…</div></div>
    </div>`:'');
  if(isAdminOwner()){ renderStoreTrend(); renderCompare(months[months.length-1]); }
}
let cmpData=null; // {store:{pnl:{m:..},perf:{m:..}}}
let cmpMonth=''; // 三店對照選定的分析年月（獨立於上方範圍）
let cmpMetric='netSales'; // 三店趨勢比較選定指標
const STORE_COLORS={'美德':'#1a73e8','聯鑫':'#e67e22','錦花':'#34a853'};
const METRICS={
  netSales:{t:'營業淨額',fmt:money,get:(pn,pf)=>pn?pn.netSales:null,agg:'sum'},
  grossMargin:{t:'毛利率(%)',fmt:v=>v.toFixed(1),get:(pn,pf)=>pn?pn.grossMargin:null},
  operatingReward:{t:'經營報酬',fmt:money,get:(pn,pf)=>pn?pn.operatingReward:null,agg:'sum'},
  badGoodsCost:{t:'壞品(元)',fmt:money,get:(pn,pf)=>pn?pn.badGoodsCost:null,agg:'sum'},
  elecCost:{t:'門市電費(元)',fmt:money,get:(pn,pf)=>pn?pn.elecCost:null,agg:'sum'},
  miscCost:{t:'雜支(元)',fmt:money,get:(pn,pf)=>pn?pn.miscCost:null,agg:'sum'},
  cashDiff:{t:'現金短少(元)',fmt:money,get:(pn,pf)=>pn?pn.cashDiff:null,agg:'sum'},
  netLoss:{t:'淨損耗(元)',fmt:money,get:(pn,pf)=>pn?((pn.badGoodsCost||0)-(pn.invResult||0)+(pn.cashDiff||0)):null,agg:'sum'},
  laborRate:{t:'人事費率(%)',fmt:v=>v.toFixed(1),get:(pn,pf)=>(pn&&pf&&pn.netSales)?pf.laborCost/pn.netSales*100:null},
  revPerHour:{t:'每工時營收',fmt:money,get:(pn,pf)=>(pn&&pf&&pf.totalHours)?pn.netSales/pf.totalHours:null},
  surplus:{t:'門市餘裕(報酬−人事)',fmt:money,get:(pn,pf)=>(pn&&pf)?pn.operatingReward-pf.laborCost:null,agg:'sum'}
};
async function loadAllForCompare(){
  if(cmpData)return;
  cmpData={};
  for(const s of (appConfig.stores||[])){
    cmpData[s]={pnl:{},perf:{}};
    try{const p=await window.db.collection('stores').doc(s).collection('pnl').get();p.forEach(d=>cmpData[s].pnl[d.id]=d.data());}catch(e){}
    try{const q=await window.db.collection('stores').doc(s).collection('perfSnapshot').get();q.forEach(d=>cmpData[s].perf[d.id]=d.data());}catch(e){}
  }
}
async function renderCompare(defaultM){
  const box=document.getElementById('compareBox');if(!box)return;
  await loadAllForCompare();
  const stores=(appConfig.stores||[]).filter(s=>s!=='人力支援');
  // 跨店有資料的年月(union)，供對照選單
  const mset=new Set();
  Object.values(cmpData||{}).forEach(sd=>Object.keys(sd.pnl||{}).forEach(k=>{ if(/^\d{4}-\d{2}$/.test(k)) mset.add(k); }));
  const allMonths=[...mset].sort();
  if(!allMonths.length){ box.innerHTML='<div style="font-size:12px;color:var(--text-muted);padding:8px 4px;">尚無對照資料</div>'; return; }
  let m = (cmpMonth && allMonths.includes(cmpMonth)) ? cmpMonth
        : (defaultM && allMonths.includes(defaultM)) ? defaultM
        : allMonths[allMonths.length-1];
  cmpMonth=m;
  const mOpt=allMonths.map(x=>`<option value="${x}" ${x===m?'selected':''}>${x.split('-')[0]}年${parseInt(x.split('-')[1])}月</option>`).join('');
  const cell=(v)=>v==null?'<td style="text-align:right;color:#bbb;">—</td>':`<td style="text-align:right;">${v}</td>`;
  let rows='';
  const acc={net:[],gm:[],rew:[],bad:[],rate:[],rev:[]};
  stores.forEach(s=>{const pn=cmpData[s]&&cmpData[s].pnl[m];const pf=(cmpData[s]&&!PERF_EXCLUDE.has(m))?cmpData[s].perf[m]:null;
    const rateN=(pf&&pn&&pn.netSales)?pf.laborCost/pn.netSales*100:null;
    const revN=(pf&&pn&&pf.totalHours)?pn.netSales/pf.totalHours:null;
    if(pn){acc.net.push(pn.netSales);acc.gm.push(pn.grossMargin);acc.rew.push(pn.operatingReward);if(pn.badGoodsCost!=null)acc.bad.push(pn.badGoodsCost);}
    if(rateN!=null)acc.rate.push(rateN); if(revN!=null)acc.rev.push(revN);
    rows+=`<tr><td style="font-weight:800;">${s}</td>${cell(pn?money(pn.netSales):null)}${cell(pn?pn.grossMargin+'%':null)}${cell(pn?money(pn.operatingReward):null)}${cell(pn&&pn.badGoodsCost!=null?money(pn.badGoodsCost):null)}${cell(rateN!=null?rateN.toFixed(1)+'%':null)}${cell(revN!=null?Math.round(revN).toLocaleString('en-US'):null)}</tr>`;
  });
  const avg=a=>a.length?a.reduce((x,y)=>x+y,0)/a.length:null;
  const sum=a=>a.length?a.reduce((x,y)=>x+y,0):null;
  const acell=(v)=>v==null?'<td style="text-align:right;color:#bbb;">—</td>':`<td style="text-align:right;font-weight:800;">${v}</td>`;
  // 金額用總計、比率用平均，分兩列
  rows+=`<tr style="border-top:1.5px solid var(--border);background:#f8fafc;"><td style="font-weight:800;color:var(--primary);">總計</td>`+
    `${acell(sum(acc.net)!=null?money(sum(acc.net)):null)}${acell(null)}`+
    `${acell(sum(acc.rew)!=null?money(sum(acc.rew)):null)}${acell(sum(acc.bad)!=null?money(sum(acc.bad)):null)}${acell(null)}${acell(null)}</tr>`;
  rows+=`<tr style="background:#f8fafc;"><td style="font-weight:800;color:var(--primary);">平均</td>`+
    `${acell(null)}${acell(avg(acc.gm)!=null?avg(acc.gm).toFixed(1)+'%':null)}`+
    `${acell(null)}${acell(null)}${acell(avg(acc.rate)!=null?avg(acc.rate).toFixed(1)+'%':null)}`+
    `${acell(avg(acc.rev)!=null?Math.round(avg(acc.rev)).toLocaleString('en-US'):null)}</tr>`;
  box.innerHTML=`
    <div style="display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-bottom:8px;">
      <select onchange="cmpMonth=this.value;renderCompare();" style="padding:6px 8px;border:1.5px solid var(--border);border-radius:8px;font-weight:700;font-size:12px;">${mOpt}</select>
    </div>
    <div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;font-size:12.5px;white-space:nowrap;">
    <thead><tr style="color:var(--text-muted);font-size:11px;"><th style="text-align:left;padding:4px;">門市</th><th style="text-align:right;padding:4px;">營業淨額</th><th style="text-align:right;">毛利率</th><th style="text-align:right;">經營報酬</th><th style="text-align:right;">壞品</th><th style="text-align:right;">人事費率</th><th style="text-align:right;">每工時營收</th></tr></thead>
    <tbody>${rows}</tbody></table></div>
    <div style="font-size:11px;color:var(--text-muted);margin-top:6px;">人事費率＝人事成本(含支援)÷營業淨額；2026/4 不列入；—代表該月尚無資料</div>`;
}
