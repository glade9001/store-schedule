// 通知紀錄（2026-11-01）：後端 sendPushToUids 每送一則就存到 users/{uid}/notifications，這頁列出自己的。
// 本人只能把 read 改成 true；新增一律由後端寫（firestore.rules）。保留 60 天（scheduledDailyCleanup）。
const NF_PAGE = 30;
let nfUid = '', nfItems = [], nfLast = null, nfMore = false, nfBusy = false;

const nfEsc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nfCol = () => window.db.collection('users').doc(nfUid).collection('notifications');
function nfWhen(ts) {
  const d = ts && ts.toDate ? ts.toDate() : null;
  if (!d) return '';
  const min = (Date.now() - d) / 60000;
  if (min < 1) return '剛剛';
  if (min < 60) return `${Math.floor(min)} 分鐘前`;
  if (min < 1440) return `${Math.floor(min / 60)} 小時前`;
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function nfDraw(err) {
  const el = document.getElementById('nfList');
  const all = document.getElementById('nfAll');
  all.hidden = !nfItems.some(n => !n.read);
  if (err) { el.innerHTML = `<div class="nf-empty">${nfEsc(err)}</div>`; return; }
  if (!nfItems.length) { el.innerHTML = '<div class="nf-empty">還沒有任何通知<br>收到的推播都會留在這裡</div>'; return; }
  el.innerHTML = nfItems.map((n, i) => `<button type="button" class="nf-item${n.read ? '' : ' unread'}" onclick="nfOpen(${i})">
    <i class="nf-dot" aria-hidden="true"></i>
    <div><b>${nfEsc(n.title)}</b><span class="t">${nfEsc(n.body)}</span><small>${nfWhen(n.createdAt)}</small></div>
  </button>`).join('') + (nfMore ? '<button type="button" class="nf-more" onclick="nfLoad(true)">看更早的通知</button>' : '');
}
async function nfLoad(next) {
  if (nfBusy) return; nfBusy = true;
  try {
    let q = nfCol().orderBy('createdAt', 'desc').limit(NF_PAGE);
    if (next && nfLast) q = q.startAfter(nfLast);
    const snap = await Promise.race([q.get(), new Promise((_, no) => setTimeout(() => no(new Error('timeout')), 15000))]); // Firestore 沒有逾時
    nfItems = nfItems.concat(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    nfLast = snap.docs[snap.docs.length - 1] || nfLast;
    nfMore = snap.docs.length === NF_PAGE;
    nfDraw();
  } catch (e) { console.warn('[通知紀錄]', e); nfDraw('讀取失敗，請重新整理再試'); }
  nfBusy = false;
}
async function nfMarkRead(items) {
  if (!items.length) return;
  const b = window.db.batch();
  items.forEach(n => b.update(nfCol().doc(n.id), { read: true }));
  await b.commit().catch(e => console.warn('[通知紀錄] 標已讀失敗', e));
  items.forEach(n => { n.read = true; });
  nfDraw();
}
async function nfOpen(i) {
  const n = nfItems[i]; if (!n) return;
  if (!n.read) await nfMarkRead([n]);
  if (n.url) location.href = n.url;
}
document.getElementById('nfAll').onclick = () => nfMarkRead(nfItems.filter(n => !n.read));

window.onload = () => {
  const u = firebase.auth().onAuthStateChanged(fb => {
    u();
    if (!fb) { location.replace('home.html'); return; }
    nfUid = fb.uid;
    nfLoad(false);
  });
};
