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
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: filename }); return 'shared'; }
      catch (e) { if (e && e.name === 'AbortError') return 'cancel'; }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    return 'saved';
  } finally { box.remove(); }
}
