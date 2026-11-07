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
  if (sfxLike) { type = "sfx"; reasons.push("kısa yansıma sözcüğü" + (ratio >= 1.5 ? ", büyük yazı" : "") + (tilted ? ", eğik" : "") + (areaPerChar > 4 ? ", geniş alana yayılmış" : "")); }
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

module.exports = { suggestType, suggestTone, itemsFromOcr, itemsFromUpload, mergeDetections, bgrToHex, median, refineTypeByStats, ringStats };
