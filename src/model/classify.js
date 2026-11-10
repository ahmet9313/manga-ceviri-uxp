// Torii OCR / çeviri yanıtlarından öğe oluşturma ve öğe türü/ton ÖNERİSİ (kullanıcı düzeltebilir).
"use strict";
const geom = require("../util/geom");
const { uid } = require("../util/common");

const bgrToHex = (c) => (Array.isArray(c) && c.length >= 3 ? "#" + [c[2], c[1], c[0]].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("") : null);
const luma = (hex) => { if (!hex) return 128; const n = parseInt(hex.slice(1), 16); return 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255); };
const colorDist = (a, b) => { if (!a || !b) return 0; const x = parseInt(a.slice(1), 16), y = parseInt(b.slice(1), 16); return Math.hypot(((x >> 16) & 255) - ((y >> 16) & 255), ((x >> 8) & 255) - ((y >> 8) & 255), (x & 255) - (y & 255)); };

function median(arr) { if (!arr.length) return 0; const a = arr.slice().sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; }

/** Tür önerisi + gerekçe. f: {text, fontsize, medianFont, angle, confidence, bg, fg, stroke, hasBg, boxW, boxH} */
function suggestType(f) {
  const reasons = [];
  const len = (f.text || "").replace(/\s/g, "").length;
  const big = f.medianFont ? f.fontsize / f.medianFont : 1;
  const tilted = Math.abs(((f.angle || 0) + 540) % 360 - 180) < 172 && Math.abs(f.angle || 0) > 6;
  if ((big > 2.0 && len <= 16) || (tilted && len <= 12) || (f.confidence < 0.55 && len <= 8)) {
    reasons.push(big > 2 ? "çok büyük yazı" : tilted ? "eğik yazı" : "düşük güvenli kısa yazı");
    return { type: "sfx", reasons };
  }
  if (f.hasBg) {
    const L = luma(f.bg);
    if (L > 200) { reasons.push("açık ve düz zemin (balon)"); return { type: "dialog", reasons }; }
    reasons.push(L < 80 ? "koyu düz zemin" : "renkli düz zemin");
    return { type: "narration", reasons };
  }
  if (f.stroke && colorDist(f.stroke, f.fg) > 120) { reasons.push("konturlu yazı, düz zemin yok"); return { type: "offbubble", reasons }; }
  reasons.push("düz zemin tespit edilmedi");
  return { type: "offbubble", reasons };
}

function suggestTone(text, fontsizeRatio) {
  const s = (text || "").trim();
  if (/^[(（].*[)）]$/s.test(s)) return "thought";
  const letters = s.replace(/[^A-Za-zÀ-ÿ]/g, "");
  if (/[!！]{2,}/.test(s) || (/[!！]\s*$/.test(s) && fontsizeRatio > 1.25)) return "shout";
  if (fontsizeRatio && fontsizeRatio < 0.72) return "whisper";
  if (letters.length > 3 && /[!！]/.test(s) && fontsizeRatio > 1.1) return "shout";
  return "normal";
}

/** OCR paragrafları → öğeler. crop: {left, top, scale}. */
function itemsFromOcr(paragraphs, crop) {
  const paras = (paragraphs || []).filter((p) => !p.removed && (p.text || "").trim());
  const medianFont = median(paras.map((p) => p.fontsize || 0).filter(Boolean)) || 20;
  return paras.map((p) => {
    const poly = geom.polygonCropToDoc(p.polygon || [], crop);
    const box = geom.polygonToBox(poly);
    const lines = (p.lines || []).filter((l) => !l.removed).map((l) => geom.polygonCropToDoc(l.polygon || [], crop));
    const fg = bgrToHex(p.text_color), bg = bgrToHex(p.bg_color), st = bgrToHex(p.stroke_color);
    const fontsize = (p.fontsize || medianFont) / (crop.scale || 1);
    const sug = suggestType({ text: p.text, fontsize: p.fontsize || medianFont, medianFont, angle: p.angle, confidence: p.confidence, bg, fg, stroke: st, hasBg: !!p.has_dominant_bg_color });
    return {
      id: uid("i_"),
      source: p.text,
      translation: "",
      type: sug.type, typeSuggested: sug.type, typeReasons: sug.reasons, typeConfirmed: false,
      tone: suggestTone(p.text, (p.fontsize || medianFont) / medianFont),
      direction: p.direction || "left_to_right",
      sourceLang: p.language_details ? p.language_details.code : "",
      confidence: p.confidence == null ? null : Math.round(p.confidence * 1000) / 1000,
      polygon: poly, lines, box,
      bounds: geom.polygonBounds(poly),
      ocr: { fontsize, textColor: fg, bgColor: bg, strokeColor: st, hasBg: !!p.has_dominant_bg_color, align: p.alignment, angle: p.angle || 0 },
      locks: { text: false, style: false, position: false },
      manual: {},
      status: { detected: true, translated: false, cleaned: false, typeset: false },
    };
  });
}

/** v2/upload (görsel) text[] → öğeler. x,y = kutu MERKEZİ. */
function itemsFromUpload(texts, crop) {
  const arr = (texts || []).filter((t) => (t.originalText || t.text || "").trim());
  const fontPx = (t) => parseFloat((String(t.font || "").match(/([\d.]+)px/) || [0, 0])[1]) || 0;
  const sizes = arr.map(fontPx).filter(Boolean);
  const medianFont = median(sizes) || 20;
  return arr.map((t) => {
    const box = geom.toriiBoxToDoc(t, crop);
    const poly = geom.boxToPolygon(box);
    const fpx = parseFloat((String(t.font || "").match(/([\d.]+)px/) || [0, 0])[1]) || medianFont;
    const fg = t.fillColor || null, st = t.lineWidth > 0 ? t.strokeColor : null;
    const sug = suggestType({ text: t.originalText, fontsize: fpx, medianFont, angle: t.angle, confidence: 1, fg, stroke: st, hasBg: !st, bg: st ? null : "#ffffff" });
    return {
      id: uid("i_"),
      source: t.originalText || "",
      translation: t.text || "",
      type: sug.type, typeSuggested: sug.type, typeReasons: sug.reasons.concat(["(görsel çeviri yanıtından)"]), typeConfirmed: false,
      tone: suggestTone(t.originalText, fpx / medianFont),
      direction: t.layout === "v" ? "top_to_bottom" : "left_to_right",
      sourceLang: "", confidence: null,
      polygon: poly, lines: [poly], box, bounds: geom.polygonBounds(poly),
      ocr: { fontsize: fpx / ((crop && crop.scale) || 1), textColor: fg, strokeColor: st, strokeWidth: t.lineWidth || 0, align: t.textAlign, angle: t.angle || 0, toriiFont: t.font },
      locks: { text: false, style: false, position: false },
      manual: {},
      status: { detected: true, translated: !!t.text, cleaned: false, typeset: false },
    };
  });
}

/**
 * Yeni tespitleri mevcut öğelerle birleştirir (aynı öğeden ikinci kayıt oluşmaz).
 * Eşleşme: sınır kutusu IoU > 0.35. Kilitli/elle düzeltilmiş alanlar korunur.
 */
function mergeDetections(existing, incoming) {
  const out = existing.slice();
  const added = [], updated = [];
  // Örtüşme: IoU veya küçük kutunun ne kadarının kesişimde olduğu (çeviri kutusu ≠ orijinal yazı kutusu olabilir)
  const overlap = (a, b) => {
    const i = geom.rectArea(geom.rectIntersect(a, b));
    return Math.max(geom.iou(a, b), i / (Math.min(geom.rectArea(a), geom.rectArea(b)) || 1) * 0.9);
  };
  for (const n of incoming) {
    let best = null, bestIou = 0.35;
    for (const e of out) {
      const v = overlap(e.bounds, n.bounds);
      if (v > bestIou) { bestIou = v; best = e; }
    }
    if (best) {
      if (!best.locks.text && !best.sourceEdited) best.source = n.source;
      if (!best.typeConfirmed) { best.type = n.type; best.typeSuggested = n.typeSuggested; best.typeReasons = n.typeReasons; }
      if (!best.toneEdited) best.tone = n.tone;
      const fromUpload = best.ocr && best.ocr.toriiFont && !(n.ocr && n.ocr.toriiFont);
      if (fromUpload) {
        // Görsel çeviri öğesine OCR geldi: dizgi kutusu korunur, temizlik için gerçek yazı poligonları eklenir
        best.maskPolygons = n.lines && n.lines.length ? n.lines : [n.polygon];
        best.textBounds = n.bounds;
      } else if (!best.locks.position && !best.boxEdited) { best.polygon = n.polygon; best.lines = n.lines; best.box = n.box; best.bounds = n.bounds; }
      best.ocr = Object.assign({}, best.ocr, n.ocr);
      // Yeni tespitin balon bilgisi taşınır (onaylı SFX/balon dışı öğelerde balon kullanılmaz)
      if ("bubble" in n) best.bubble = best.typeConfirmed && (best.type === "sfx" || best.type === "offbubble") ? null : n.bubble || null;
      best.confidence = n.confidence; best.direction = n.direction; best.sourceLang = n.sourceLang || best.sourceLang;
      if (n.translation && !best.locks.text && !best.translationEdited) best.translation = n.translation;
      updated.push(best);
    } else { out.push(n); added.push(n); }
  }
  return { items: out, added, updated };
}

/**
 * Piksel tabanlı tür düzeltmesi (ücretsiz). Torii'nin kontur bilgisine güvenmez; zemine bakar.
 *  sample(it) → { ring: {light, uniform, medianLuma, edge, n} }  — yazının ÇEVRESİNDEKİ zemin istatistikleri
 *  Kurallar:
 *   • açık ve düz zemin (beyaz/açık balon)        → Diyalog
 *   • düz ama koyu zemin (siyah/renkli kutu)       → Anlatım
 *   • çizim üstü + (büyük / kısa / eğik / ünlemli) → SFX
 *   • çizim üstü, diğerleri                         → Balon dışı
 */
function refineTypeByStats(it, st, medianFont) {
  const text = (it.source || "").trim();
  const len = text.replace(/\s/g, "").length;
  const ratio = medianFont ? ((it.ocr && it.ocr.fontsize) || medianFont) / medianFont : 1;
  const angle = Math.abs(((it.box && it.box.angle) || 0) % 180);
  const tilted = angle > 8 && angle < 172;
  const onomato = /^[A-Za-zÀ-ÿ!?.…~\-\s]{1,14}$/.test(text) && /[!.?~]$|^[A-Z!?.…~\-\s]+$/.test(text);
  const cjkShort = /^[぀-ヿ㐀-鿿가-힯!?！？…~\s]{1,6}$/.test(text);
  const reasons = [];
  // Yazının kendisi SFX gibi mi? Kısa yansıma sözcüğü + kutusuna göre çok büyük/eğik yazılmış
  const fs = (it.ocr && it.ocr.fontsize) || medianFont || 24;
  const boxArea = it.box ? it.box.w * it.box.h : 0;
  const areaPerChar = len ? boxArea / (len * fs * fs) : 0; // diyalogda ~0.5–1.5, SFX'te çok daha büyük
  const sfxLike = len > 0 && len <= 12 && (onomato || cjkShort) && (ratio >= 1.5 || tilted || areaPerChar > 4);
  let type;
  if (it.bubble) {
    // Kapalı balonun içindeki yazı: balon rengine göre diyalog / anlatım (SFX değil)
    const n = parseInt(String(it.bubble.bg || "#ffffff").slice(1), 16), lum = 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
    // Dikdörtgen kutu → anlatım; oval/dikenli balon → diyalog
    if (it.bubble.rectangular) { type = "narration"; reasons.push("kapalı dikdörtgen kutu" + (lum < 90 ? " (koyu)" : "")); }
    else { type = "dialog"; reasons.push("kapalı balon içinde" + (lum < 90 ? " (koyu balon)" : "")); }
  } else if (sfxLike) { type = "sfx"; reasons.push("kısa yansıma sözcüğü" + (ratio >= 1.5 ? ", büyük yazı" : "") + (tilted ? ", eğik" : "") + (areaPerChar > 4 ? ", geniş alana yayılmış" : "")); }
  else if (st.light >= 0.62 && st.uniform >= 0.6) { type = "dialog"; reasons.push(`açık düz zemin %${Math.round(st.light * 100)}`); }
  else if (st.uniform >= 0.75) {
    type = st.medianLuma < 150 ? "narration" : "dialog";
    reasons.push(st.medianLuma < 150 ? "koyu düz kutu" : "renkli düz balon");
  } else if (ratio >= 1.6 || tilted || (len <= 10 && (onomato || cjkShort)) || (len <= 4)) {
    type = "sfx"; reasons.push("çizim üstü" + (ratio >= 1.6 ? ", büyük yazı" : "") + (tilted ? ", eğik" : "") + (len <= 10 ? ", kısa/yansıma" : ""));
  } else { type = "offbubble"; reasons.push("çizim üstü uzun metin"); }
  return { type, reasons };
}

/** Halka (ring) istatistikleri: rgb = alan görüntüsü, inside = yazı maskesi (bu piksellerin dışı ölçülür) */
function ringStats(rgb, w, h, inside, ringPx, includeInside) {
  const outer = geom.dilate(inside, w, h, ringPx);
  const lum = [];
  let edges = 0;
  const L = (i) => 0.299 * rgb[i * 3] + 0.587 * rgb[i * 3 + 1] + 0.114 * rgb[i * 3 + 2];
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    if (!outer[i] || (inside[i] && !includeInside)) continue;
    const v = L(i); lum.push(v);
    if (Math.abs(L(i + 1) - L(i - 1)) + Math.abs(L(i + w) - L(i - w)) > 70) edges++;
  }
  if (!lum.length) return { light: 0, uniform: 0, medianLuma: 128, edge: 1, n: 0 };
  const sorted = lum.slice().sort((a, b) => a - b), med = sorted[sorted.length >> 1];
  let light = 0, uni = 0;
  for (const v of lum) { if (v > 215) light++; if (Math.abs(v - med) < 18) uni++; }
  return { light: light / lum.length, uniform: uni / lum.length, medianLuma: med, edge: edges / lum.length, n: lum.length };
}

/**
 * Balonun kendisini bul: yazı kutusunun ortasından, zemin rengine benzeyen piksellerle taşma (flood fill).
 * Yazı harfleri taşmayı durdurmaz (etrafından dolanır); balon konturu durdurur.
 * Dolgu arama penceresinin kenarına ulaşırsa → kapalı balon yok (ör. çizim, sayfa boşluğu) → null.
 * img: {data(RGB), width, height, bounds:{left,top}} — belge koordinatlı görüntü (temizlenmiş olması tercih edilir)
 * → { rect:{left,top,right,bottom}, cx, cy, w, h, bg } (belge pikseli)
 */
function detectBubble(img, it, page) {
  const b = it.box || {};
  if (!b.w || !b.h) return null;
  const W = img.width, H = img.height, ox = img.bounds.left || 0, oy = img.bounds.top || 0;
  // Belge boyutu: kırpılmış görüntünün kenarı SAYFA kenarı değildir (bölge tespiti / yeniden öneri)
  const PW = (page && page.W) || ox + W, PH = (page && page.H) || oy + H;
  const reach = Math.max(b.w, b.h) * 1.6 + 40;
  const win = {
    left: Math.max(0, Math.floor(b.cx - b.w / 2 - reach - ox)), top: Math.max(0, Math.floor(b.cy - b.h / 2 - reach - oy)),
    right: Math.min(W, Math.ceil(b.cx + b.w / 2 + reach - ox)), bottom: Math.min(H, Math.ceil(b.cy + b.h / 2 + reach - oy)),
  };
  const ww = win.right - win.left, wh = win.bottom - win.top;
  if (ww < 8 || wh < 8) return null;
  const px = (x, y) => { const i = ((y + win.top) * W + (x + win.left)) * 3; return [img.data[i], img.data[i + 1], img.data[i + 2]]; };
  // Zemin rengi: kutu içindeki piksellerin medyanı (yazı azınlıktadır)
  const bx0 = Math.max(0, Math.round(b.cx - b.w / 2 - ox - win.left)), by0 = Math.max(0, Math.round(b.cy - b.h / 2 - oy - win.top));
  const bx1 = Math.min(ww, Math.round(b.cx + b.w / 2 - ox - win.left)), by1 = Math.min(wh, Math.round(b.cy + b.h / 2 - oy - win.top));
  const samp = [[], [], []];
  for (let y = by0; y < by1; y += 2) for (let x = bx0; x < bx1; x += 2) { const c = px(x, y); samp[0].push(c[0]); samp[1].push(c[1]); samp[2].push(c[2]); }
  if (!samp[0].length) return null;
  const bg = samp.map((a) => a.sort((p, q) => p - q)[a.length >> 1]);
  const near = (x, y) => { const c = px(x, y); return Math.abs(c[0] - bg[0]) + Math.abs(c[1] - bg[1]) + Math.abs(c[2] - bg[2]) < 48; };
  // Pencere kenarı sayfa kenarı mı? (belge koordinatı)
  const atL = ox + win.left <= 0, atT = oy + win.top <= 0, atR = ox + win.right >= PW, atB = oy + win.bottom >= PH;
  const flood = (shrink) => {
    const seen = new Uint8Array(ww * wh), q = new Int32Array(ww * wh);
    let qh = 0, qt = 0;
    // Tohumlar: kutudaki zemin renkli pikseller (shrink > 0 → yalnız kutunun ortası; oval balonda köşe dışarıda kalabilir)
    const sx0 = Math.round(bx0 + (bx1 - bx0) * shrink), sx1 = Math.round(bx1 - (bx1 - bx0) * shrink);
    const sy0 = Math.round(by0 + (by1 - by0) * shrink), sy1 = Math.round(by1 - (by1 - by0) * shrink);
    for (let y = sy0; y < Math.max(sy1, sy0 + 1) && y < wh; y++) for (let x = sx0; x < Math.max(sx1, sx0 + 1) && x < ww; x++) { const i = y * ww + x; if (!seen[i] && near(x, y)) { seen[i] = 1; q[qt++] = i; } }
    if (!qt) return null;
    const rowMin = new Int32Array(wh).fill(ww), rowMax = new Int32Array(wh).fill(-1);
    let l = ww, t = wh, r = -1, bt = -1, n = 0;
    let pL = false, pR = false, pT = false, pB = false;
    while (qh < qt) {
      const i = q[qh++], x = i % ww, y = (i / ww) | 0;
      n++;
      if (x < l) l = x; if (x > r) r = x; if (y < t) t = y; if (y > bt) bt = y;
      if (x < rowMin[y]) rowMin[y] = x; if (x > rowMax[y]) rowMax[y] = x;
      // Arama penceresinin İÇ kenarına taşma = kapalı balon yok. Sayfa kenarına değmek serbest (sayfadan taşan balonlar).
      if ((x === 0 && !atL) || (y === 0 && !atT) || (x === ww - 1 && !atR) || (y === wh - 1 && !atB)) return null;
      if (x === 0) pL = true; if (x === ww - 1) pR = true; if (y === 0) pT = true; if (y === wh - 1) pB = true;
      if (x === 0 || y === 0 || x === ww - 1 || y === wh - 1) continue;
      const nb = [i - 1, i + 1, i - ww, i + ww];
      for (let k = 0; k < 4; k++) { const j = nb[k]; if (!seen[j]) { const jx = j % ww, jy = (j / ww) | 0; if (near(jx, jy)) { seen[j] = 1; q[qt++] = j; } } }
    }
    // Karşılıklı İKİ sayfa kenarına değen bölge balon değil, paneller arası boşluktur (balon yalnızca bir kenardan kesilir)
    if ((pL && pR) || (pT && pB)) return null;
    const rect = { left: l + win.left + ox, top: t + win.top + oy, right: r + 1 + win.left + ox, bottom: bt + 1 + win.top + oy };
    const rw = rect.right - rect.left, rh = rect.bottom - rect.top;
    // Makullük: balon, yazı kutusundan küçük olamaz; çok dolu değilse (ince şerit vb.) reddet
    if (rw < b.w * 0.8 || rh < b.h * 0.8 || n < rw * rh * 0.35) return null;
    // Bölge yazıyı ÇEVRELEMELİ: düz renkli SFX harfinin içi kendi "balonu" sayılmasın (en az bir boyutta kutudan büyük olmalı)
    if (rw <= b.w * 1.02 && rh <= b.h * 1.02) return null;
    // Şekil: satır aralıklarının (yazı boşlukları dahil) dikdörtgene oranı — dikdörtgen kutu ~1, oval ~0.78
    let span = 0;
    for (let y = t; y <= bt; y++) if (rowMax[y] >= rowMin[y]) span += rowMax[y] - rowMin[y] + 1;
    const fill = span / (rw * rh);
    return {
      rect, cx: (rect.left + rect.right) / 2, cy: (rect.top + rect.bottom) / 2, w: rw, h: rh,
      bg: "#" + bg.map((v) => v.toString(16).padStart(2, "0")).join(""),
      fill: Math.round(fill * 100) / 100, rectangular: fill > 0.93, // dikdörtgen kutu → anlatım; oval/dikenli balon → diyalog
    };
  };
  // Önce tüm kutudan; sızarsa (oval balonda kutu köşesi dışarıda) yalnız ortadan
  return flood(0) || flood(0.25);
}


module.exports = { suggestType, suggestTone, itemsFromOcr, itemsFromUpload, mergeDetections, bgrToHex, median, refineTypeByStats, ringStats, detectBubble };
