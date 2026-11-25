// ===== 網頁內容 → PDF 檔（2026-11-25）=====
// 為什麼：iPhone 從主畫面開的 App（PWA）不支援 window.print()，勞檢出勤表、薪資單在手機按「列印」沒反應。
// 改成直接產生 PDF：一個元素一頁（A4 直式），產好用分享選單（可列印、存檔案、傳 LINE），不支援分享就直接下載。
// 用 html2canvas＋jsPDF（第一次按才從 CDN 載入，平常不拖慢頁面）。名稱一律 pdfx 開頭（多頁共用，避免撞名）。

var _pdfxLibs = null;
function pdfxLoadLibs() {
  if (_pdfxLibs) return _pdfxLibs;
  const load = src => new Promise((ok, bad) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => bad(new Error('載入 PDF 元件失敗，請確認網路')); document.head.appendChild(s); });
  _pdfxLibs = Promise.all([
    window.html2canvas ? null : load('https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js'),
    (window.jspdf && window.jspdf.jsPDF) ? null : load('https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js'),
  ]).catch(e => { _pdfxLibs = null; throw e; });
  return _pdfxLibs;
}

/**
 * @param html     要轉成 PDF 的 HTML（含 <style> 也可以）
 * @param pageSel  每一頁的選擇器（例 '.sheet'、'.payslip-page'）；找不到就整段當一頁
 * @param filename 檔名（含 .pdf）
 * @param onProgress (已完成頁數, 總頁數) 可省略
 */
async function pdfxFromHtml(html, pageSel, filename, onProgress) {
  await pdfxLoadLibs();
  // 放在畫面外、固定 A4 寬（96dpi 下 794px）排版，才不會受手機螢幕寬度影響
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;left:-10000px;top:0;width:794px;background:#fff;color:#000;z-index:-1;';
  box.innerHTML = html;
  document.body.appendChild(box);
  try {
    await Promise.all([...box.querySelectorAll('img')].map(img => img.complete ? null : new Promise(r => { img.onload = img.onerror = r; })));
    let pages = [...box.querySelectorAll(pageSel)];
    if (!pages.length) pages = [box];
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
    const PW = 210, PH = 297, M = 8;
    for (let i = 0; i < pages.length; i++) {
      const el = pages[i];
      el.style.height = 'auto'; el.style.overflow = 'visible';   // 列印用的固定高度（277mm）在這裡會裁掉內容
      const canvas = await window.html2canvas(el, { scale: 2, backgroundColor: '#ffffff', useCORS: true, logging: false });
      const maxW = PW - M * 2, maxH = PH - M * 2;
      let w = maxW, h = canvas.height * w / canvas.width;
      if (h > maxH) { h = maxH; w = canvas.width * h / canvas.height; }   // 太長就整頁縮小，不切頁
      if (i) pdf.addPage();
      pdf.addImage(canvas.toDataURL('image/jpeg', 0.92), 'JPEG', (PW - w) / 2, M, w, h);
      if (onProgress) onProgress(i + 1, pages.length);
    }
    const blob = pdf.output('blob');
    const file = new File([blob], filename, { type: 'application/pdf' });
    // ⚠️ iPhone 的分享一定要在「手指按下的當下」呼叫：產 PDF 要好幾秒，等完再叫分享會被系統默默拒絕，
    //    改下載在主畫面 App 裡也常沒反應 → 使用者看到「按了沒反應」（2026-11-25）。
    //    所以能分享的裝置（手機）一律跳出「PDF 已產生」，讓使用者再按一次（新的手指動作）才分享。
    if (navigator.canShare && navigator.canShare({ files: [file] })) { box.remove(); return pdfxReadyDialog(file, blob); }
    pdfxDownload(blob, filename);
    return 'saved';
  } finally { box.remove(); }
}
function pdfxDownload(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}
/** 「PDF 已產生」：分享（列印、存檔案、傳 LINE）／下載／關閉 */
function pdfxReadyDialog(file, blob) {
  return new Promise(resolve => {
    const ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:100000;display:flex;align-items:flex-end;justify-content:center;';
    ov.innerHTML = `<div style="background:#fff;width:100%;max-width:520px;border-radius:18px 18px 0 0;padding:20px 18px 26px;font-family:inherit;box-sizing:border-box;">
      <div style="font-size:17px;font-weight:800;margin-bottom:4px;">📄 PDF 已產生</div>
      <div style="font-size:13px;color:#555;margin-bottom:14px;word-break:break-all;">${file.name.replace(/[<>&]/g, '')}（${Math.max(1, Math.round(file.size / 1024))} KB）</div>
      <button data-k="share" style="width:100%;min-height:48px;border:0;border-radius:12px;background:#0f766e;color:#fff;font-size:16px;font-weight:800;margin-bottom:8px;">📤 分享／列印／存到檔案</button>
      <button data-k="dl" style="width:100%;min-height:44px;border:1px solid #cbd5e1;border-radius:12px;background:#fff;color:#1c2321;font-size:15px;font-weight:700;margin-bottom:8px;">⬇️ 下載</button>
      <button data-k="close" style="width:100%;min-height:40px;border:0;background:none;color:#555;font-size:14px;">關閉</button></div>`;
    const done = r => { ov.remove(); resolve(r); };
    ov.addEventListener('click', async e => {
      const k = e.target && e.target.getAttribute && e.target.getAttribute('data-k');
      if (e.target === ov || k === 'close') return done('cancel');
      if (k === 'dl') { pdfxDownload(blob, file.name); return done('saved'); }
      if (k === 'share') {
        try { await navigator.share({ files: [file], title: file.name }); done('shared'); }
        catch (er) { if (!(er && er.name === 'AbortError')) { pdfxDownload(blob, file.name); done('saved'); } }
      }
    });
    document.body.appendChild(ov);
  });
}

/**
 * 全螢幕預覽（使用者 2026-11-25：手機不用 PDF，直接預覽就好）
 * 一頁一張按 A4 寬（794px）排版，縮到螢幕寬（雙指可再放大）；右上角關閉。
 * @param html 要預覽的 HTML（各頁自己的 <style> 也可以放進來）  @param title 標題
 */
function pdfxPreview(html, title) {
  const ov = document.createElement('div');
  // -webkit-text-size-adjust：iPhone 會把縮小顯示的寬版面裡某些字自動放大（「溝通事項」變超大、半頁被擠到裁掉），要關掉
  ov.style.cssText = 'position:fixed;inset:0;z-index:100000;background:#e5e7eb;display:flex;flex-direction:column;-webkit-text-size-adjust:100%;text-size-adjust:100%;';
  const safe = String(title || '預覽').replace(/[<>&]/g, '');
  ov.innerHTML = `<div style="flex:0 0 auto;display:flex;align-items:center;gap:10px;padding:10px 14px;padding-top:max(10px, env(safe-area-inset-top));background:#0f766e;color:#fff;">
      <div style="flex:1;font-size:16px;font-weight:800;">👀 ${safe}</div>
      <button data-k="close" style="min-height:40px;padding:0 16px;border:0;border-radius:10px;background:#fff;color:#0f766e;font-size:15px;font-weight:800;">關閉</button></div>
    <div data-k="scroll" style="flex:1;overflow:auto;-webkit-overflow-scrolling:touch;padding:12px;">
      <div data-k="paper" style="width:794px;transform-origin:top left;"></div></div>`;
  const paper = ov.querySelector('[data-k=paper]');
  paper.innerHTML = html;
  // 每一頁畫成一張 A4（210×297mm），四邊留白同列印（使用者 2026-11-25：要看到印出來的樣子）
  //   出勤紀錄表（.sheet）：上下 8mm、左右 9mm；薪資單（.payslip-page）：四邊 8mm、內容高 277mm（兩人一頁）
  //   ⚠️ 不可改高度：薪資單半頁有固定高度，改掉就不是印出來的樣子
  paper.querySelectorAll('.sheet').forEach(p => {
    p.style.cssText += ';background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.18);width:210mm;min-height:297mm;padding:8mm 9mm;margin:0 0 14px;box-sizing:border-box;';
  });
  paper.querySelectorAll('.payslip-page').forEach(p => {
    p.style.cssText += ';background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.18);width:210mm;height:297mm;padding:8mm;margin:0 0 14px;box-sizing:border-box;';
  });
  const fit = () => { const w = ov.querySelector('[data-k=scroll]').clientWidth - 24; paper.style.zoom = String(Math.min(1, w / 794)); };
  ov.addEventListener('click', e => { if (e.target.getAttribute && e.target.getAttribute('data-k') === 'close') { window.removeEventListener('resize', fit); ov.remove(); } });
  window.addEventListener('resize', fit);
  document.body.appendChild(ov);
  fit();
}
