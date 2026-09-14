// CITY手順同步：把「手順查詢工具」（sh-line-liff.vercel.app，原作者已授權）的資料抓回來，
// 跟我們已發佈的版本比對，產生「待確認的變動」給 admin 審核。這支**不會**直接改員工看得到的內容
// （唯一例外：釘選沿用對方，已發佈的品項會直接同步 pinned）。
//
// 集合（規則見 firestore.rules，city* 一律只有 admin 能寫）：
//   cityRecipes/{itemId}   已發佈的做法（員工讀）      ← admin 在確認頁發佈
//   citySpecs/{snippetId}  已發佈的基本規格速查（員工讀）
//   cityPending/{id}       待確認的變動（recipe_{itemId} / spec_{snippetId}）
//   cityIgnored/{kwId}     不收的品項（例：食安退費），之後不再跳出
//   cityImages/{sha1(src)} 圖片複製紀錄：對方網址 → 我們 Storage 的下載網址
//   cityMeta/sync          最近一次同步結果（失敗也會寫，首頁提醒靠它，避免安靜失敗）
//
// ⚠️ 對方沒有 updated_at，只能比內容指紋（srcHash）。
// ⚠️ 對方資料庫前端可寫（任何人都可能亂改/清空），所以筆數驟減時整次中止，不產生大量「刪除」。
const admin = require("firebase-admin");
const crypto = require("crypto");

const SRC_BASE = "https://rybazinqtazzgyxvdglk.supabase.co";
// 對方前端 bundle 內公開的 publishable key（唯讀用途）。刻意不抓 admin_config（對方的管理密碼）。
const SRC_KEY = "sb_publishable_oMHxmXF2MeGf0rKllDGIPQ_j4zcInFy";
const BUCKET = "store-schedule-3b056-city";
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

// 對方機器名稱寫法不一（大小寫、前後空白），統一成這份清單的寫法
const KNOWN_MACHINES = ["CITY CAFE", "CITY PEARL", "不可思議茶Bar", "現萃茶", "精品咖啡", "珍珠飲品", "果汁Bar", "雙豆槽"];

// 機器名稱空白時，用內文猜一個給 admin 參考（依序比對，先中先贏）
const MACHINE_RULES = [
  ["CITY CAFE", /咖啡螢幕|咖啡機/],
  ["現萃茶", /萃茶機|現萃茶/],
  ["不可思議茶Bar", /茶機按鍵|不可思議茶/],
  ["果汁Bar", /冰沙機|果汁/],
  ["珍珠飲品", /珍珠/],
];

const sha1 = (s) => crypto.createHash("sha1").update(s).digest("hex");

function normMachine(raw) {
  const t = String(raw || "").trim();
  if (!t) return "";
  const key = t.replace(/\s+/g, "").toLowerCase();
  return KNOWN_MACHINES.find((m) => m.replace(/\s+/g, "").toLowerCase() === key) || t;
}

function suggestMachine(sections) {
  const text = sections.map((s) => s.text).join("\n");
  const hit = MACHINE_RULES.find(([, re]) => re.test(text));
  return hit ? hit[0] : "";
}

// 對方 content 是 JSON 字串 [{text, image_url}]，舊資料可能是純文字（照對方前端 yo() 的解析）
function parseSections(content, itemImage) {
  let blocks;
  try {
    const t = JSON.parse(content);
    blocks = Array.isArray(t) ? t : null;
  } catch (e) {
    blocks = null;
  }
  if (!blocks) blocks = [{ text: content || "", image_url: "" }];
  const out = blocks
    .map((b) => ({ text: String((b && b.text) || "").trim(), srcImage: String((b && b.image_url) || "").trim() }))
    .filter((b) => b.text || b.srcImage);
  const top = String(itemImage || "").trim();
  if (top) out.unshift({ text: "", srcImage: top });
  return out;
}

// 標籤 → 搜尋用別名（去掉跟品名一樣的）。對方用逗號或空白分隔都有。
function aliasesOf(title, tags) {
  const parts = String(tags || "").split(/[,，、]+/).flatMap((p) => {
    const t = p.trim();
    // 整段等於品名就不拆（品名本身可能含空白，例：精品 KAVALAN 熟成風味拿鐵咖啡）
    return t === title ? [t] : t.split(/\s+/);
  });
  return [...new Set(parts.map((p) => p.trim()).filter((p) => p && p !== title))];
}

async function fetchTable(table, columns) {
  const res = await fetch(`${SRC_BASE}/rest/v1/${table}?select=${columns}`, {
    headers: { apikey: SRC_KEY, Authorization: `Bearer ${SRC_KEY}` },
  });
  // 刻意列出欄位名：對方改欄位時這裡會 HTTP 400 直接報錯，而不是靜靜抓到一堆空值
  if (!res.ok) throw new Error(`抓取 ${table} 失敗：HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error(`${table} 回傳格式不是陣列`);
  if (data.length >= 1000) throw new Error(`${table} 筆數達 1000（API 上限），可能被截斷`);
  return data;
}

async function copyImage(srcUrl, imagesById, bucket) {
  const id = sha1(srcUrl);
  if (imagesById.has(id)) return imagesById.get(id);
  const res = await fetch(srcUrl);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const contentType = (res.headers.get("content-type") || "").split(";")[0];
  if (!contentType.startsWith("image/")) throw new Error(`不是圖片（${contentType || "無類型"}）`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_IMAGE_BYTES) throw new Error(`檔案過大（${buf.length} bytes）`);
  const ext = (contentType.split("/")[1] || "jpg").replace("jpeg", "jpg").replace(/[^a-z0-9]/g, "");
  const path = `city/${id}.${ext}`;
  const token = crypto.randomUUID();
  await bucket.file(path).save(buf, {
    contentType,
    resumable: false,
    metadata: { cacheControl: "public, max-age=31536000", metadata: { firebaseStorageDownloadTokens: token, src: srcUrl } },
  });
  // 下載權杖網址：不經 Storage 規則（規則全擋），不可列舉，員工端 <img> 直接用
  const url = `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/${encodeURIComponent(path)}?alt=media&token=${token}`;
  const rec = { src: srcUrl, path, url, contentType, size: buf.length, copiedAt: admin.firestore.FieldValue.serverTimestamp() };
  await admin.firestore().collection("cityImages").doc(id).set(rec);
  imagesById.set(id, rec);
  return rec;
}

// 小型併發池，避免一次對對方丟 100 個請求
async function pool(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx]);
    }
  });
  await Promise.all(workers);
}

const docsById = (snap) => new Map(snap.docs.map((d) => [d.id, d.data()]));

async function runCitySync(trigger) {
  const db = admin.firestore();
  const metaRef = db.collection("cityMeta").doc("sync");
  const startedAt = Date.now();
  try {
    const [keywords, items, snippets] = await Promise.all([
      fetchTable("keywords", "id,title,tags,pinned,sort_order,created_at"),
      fetchTable("keyword_items", "id,keyword_id,machine_name,content,image_url,sort_order,created_at"),
      fetchTable("snippets", "id,category,label,content,sort_order"),
    ]);

    const [metaSnap, ignoredSnap, recipesSnap, specsSnap, pendingSnap, imagesSnap] = await Promise.all([
      metaRef.get(),
      db.collection("cityIgnored").get(),
      db.collection("cityRecipes").get(),
      db.collection("citySpecs").get(),
      db.collection("cityPending").get(),
      db.collection("cityImages").get(),
    ]);

    // 防呆：對方被清空或壞掉時，整次中止，不要產生一大堆「刪除」
    const last = (metaSnap.exists && metaSnap.data().sourceCounts) || null;
    if (!keywords.length || !items.length) throw new Error(`對方資料是空的（品項 ${keywords.length}、內容 ${items.length}），本次中止`);
    if (last && last.items && items.length < last.items * 0.5) {
      throw new Error(`對方內容筆數驟減（上次 ${last.items} → 這次 ${items.length}），疑似資料被清空，本次中止`);
    }

    const ignored = new Set(ignoredSnap.docs.map((d) => d.id));
    const recipes = docsById(recipesSnap);
    const specs = docsById(specsSnap);
    const pending = docsById(pendingSnap);
    const imagesById = new Map(imagesSnap.docs.map((d) => [d.id, d.data()]));
    const kwById = new Map(keywords.map((k) => [k.id, k]));

    // ── 1. 整理對方資料成我們的格式 ──
    const srcRecipes = new Map();
    for (const it of items) {
      const kw = kwById.get(it.keyword_id);
      if (!kw || ignored.has(kw.id)) continue;
      const title = String(kw.title || "").trim();
      const machineSrc = normMachine(it.machine_name);
      const sections = parseSections(it.content, it.image_url);
      const tags = String(kw.tags || "").trim();
      const srcHash = sha1(JSON.stringify({ title, tags, machineSrc, sections: sections.map((s) => [s.text, s.srcImage]) }));
      srcRecipes.set(it.id, {
        itemId: it.id,
        keywordId: kw.id,
        title,
        tags,
        aliases: aliasesOf(title, tags),
        machineSrc,
        suggestedMachine: machineSrc || suggestMachine(sections),
        pinned: !!kw.pinned,
        kwSort: kw.sort_order ?? 0,
        itemSort: it.sort_order ?? 0,
        srcCreatedAt: it.created_at || kw.created_at || null,
        sections,
        srcHash,
      });
    }

    // ── 2. 複製圖片（只複製「需要進待確認」的內容用到的圖）──
    const needs = [...srcRecipes.values()].filter((r) => !recipes.has(r.itemId) || recipes.get(r.itemId).srcHash !== r.srcHash);
    const imageErrors = {};
    const urls = [...new Set(needs.flatMap((r) => r.sections.map((s) => s.srcImage).filter(Boolean)))];
    const bucket = admin.storage().bucket(BUCKET);
    let copied = 0;
    await pool(urls, 5, async (u) => {
      try {
        const had = imagesById.has(sha1(u));
        await copyImage(u, imagesById, bucket);
        if (!had) copied++;
      } catch (e) {
        imageErrors[u] = String(e.message || e);
      }
    });

    // ── 3. 算出每筆應有的待確認狀態 ──
    const now = admin.firestore.FieldValue.serverTimestamp();
    const wantPending = new Map(); // pendingId → data
    const pinUpdates = [];

    for (const r of srcRecipes.values()) {
      const pub = recipes.get(r.itemId);
      if (pub && pub.pinned !== r.pinned) pinUpdates.push([r.itemId, { pinned: r.pinned, kwSort: r.kwSort, itemSort: r.itemSort }]);
      if (pub && pub.srcHash === r.srcHash) continue;
      const sections = r.sections.map((s) => {
        const img = s.srcImage ? imagesById.get(sha1(s.srcImage)) : null;
        return { text: s.text, srcImage: s.srcImage, image: img ? img.url : null };
      });
      wantPending.set(`recipe_${r.itemId}`, {
        kind: "recipe",
        change: pub ? "update" : "add",
        srcId: r.itemId,
        srcHash: r.srcHash,
        prevHash: pub ? pub.srcHash : null,
        imageMissing: sections.some((s) => s.srcImage && !s.image),
        src: { ...r, sections },
      });
    }
    for (const [id, pub] of recipes) {
      if (srcRecipes.has(id)) continue;
      // 被加進略過清單的品項不算「對方刪除」
      if (pub.keywordId && ignored.has(pub.keywordId)) continue;
      // admin 已選「保留並標示已下架」的，不要每週再跳一次刪除
      if (pub.srcDeleted) continue;
      wantPending.set(`recipe_${id}`, { kind: "recipe", change: "delete", srcId: id, srcHash: null, prevHash: pub.srcHash, imageMissing: false, src: null, title: pub.title });
    }

    const srcSpecs = new Map();
    for (const s of snippets) {
      const rec = { specId: s.id, category: String(s.category || "").trim(), label: String(s.label || "").trim(), content: String(s.content || "").trim(), sort: s.sort_order ?? 0 };
      rec.srcHash = sha1(JSON.stringify([rec.category, rec.label, rec.content]));
      srcSpecs.set(s.id, rec);
      const pub = specs.get(s.id);
      if (pub && pub.srcHash === rec.srcHash) continue;
      wantPending.set(`spec_${s.id}`, { kind: "spec", change: pub ? "update" : "add", srcId: s.id, srcHash: rec.srcHash, prevHash: pub ? pub.srcHash : null, imageMissing: false, src: rec });
    }
    for (const [id, pub] of specs) {
      if (srcSpecs.has(id)) continue;
      wantPending.set(`spec_${id}`, { kind: "spec", change: "delete", srcId: id, srcHash: null, prevHash: pub.srcHash, imageMissing: false, src: null, title: pub.label });
    }

    // ── 4. 寫入（只寫有變的，保留 firstDetectedAt）──
    const writes = [];
    for (const [id, want] of wantPending) {
      const cur = pending.get(id);
      if (cur && cur.srcHash === want.srcHash && cur.change === want.change && cur.imageMissing === want.imageMissing) continue;
      writes.push((b) => b.set(db.collection("cityPending").doc(id), {
        ...want,
        firstDetectedAt: cur && cur.firstDetectedAt ? cur.firstDetectedAt : now,
        detectedAt: now,
      }));
    }
    for (const id of pending.keys()) {
      if (!wantPending.has(id)) writes.push((b) => b.delete(db.collection("cityPending").doc(id)));
    }
    for (const [id, data] of pinUpdates) writes.push((b) => b.update(db.collection("cityRecipes").doc(id), data));

    for (let i = 0; i < writes.length; i += 400) {
      const batch = db.batch();
      writes.slice(i, i + 400).forEach((w) => w(batch));
      await batch.commit();
    }

    const counts = { add: 0, update: 0, delete: 0 };
    for (const w of wantPending.values()) counts[w.change]++;
    const result = {
      ok: true,
      trigger,
      lastRunAt: now,
      durationMs: Date.now() - startedAt,
      sourceCounts: { keywords: keywords.length, items: items.length, snippets: snippets.length, ignoredKeywords: ignored.size },
      pending: { ...counts, total: wantPending.size, imageMissing: [...wantPending.values()].filter((w) => w.imageMissing).length },
      pinsSynced: pinUpdates.length,
      imagesCopied: copied,
      imageErrors,
      error: null,
    };
    await metaRef.set(result);
    console.log("[citySync] ok", JSON.stringify({ ...result, lastRunAt: undefined }));
    return { ...result, lastRunAt: undefined };
  } catch (e) {
    console.error("[citySync] failed", e);
    // 保留上次成功的 sourceCounts，驟減檢查才有基準
    await metaRef.set({ ok: false, trigger, lastRunAt: admin.firestore.FieldValue.serverTimestamp(), error: String(e.message || e) }, { merge: true });
    throw e;
  }
}

module.exports = { runCitySync, normMachine, suggestMachine, parseSections, aliasesOf };
