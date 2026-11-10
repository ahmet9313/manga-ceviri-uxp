// Düzenlenebilir Photoshop metin katmanları. PS 27.11'de doğrulanan kurallar:
//  • textClickPoint DAİMA yüzde (percentUnit) olarak yorumlanır → px/belgeGenişliği*100
//  • textShape.bounds punto cinsindendir → px * 72 / çözünürlük
//  • "textStyle" + typeStyleOperationType:3 yalnız verilen özelliği değiştirir (karakter aralıkları korunur)
//  • DOM characterStyle.font/color/tracking ayarlayıcıları diğer aralık biçimlerini korur
//  • layer.rotate/scale → transform matrisi; kutu boyutu → textShape.bounds (ayrı işlemler)
"use strict";
const { app, bp, constants, getDoc, findLayer, selectLayer, rgbDesc, descToHex, unitValue } = require("./api");

const pxToPt = (px, res) => (px * 72) / res;
const ptToPx = (pt, res) => (pt * res) / 72;

/**
 * Türkçe büyük harf (i→İ, ı→I). source verilirse: kaynak metinde aynen geçen kelimeler (çevrilmemiş isimler,
 * ör. "Xiao") Türkçe kurala girmez → "XIAO" ("XİAO" değil).
 */
function trUpper(s, source) {
  const keep = new Set(String(source || "").toLowerCase().match(/[a-z]+/g) || []);
  // Yalnızca çeviride BÜYÜK harfle başlayan (özel ad) ve kaynakta aynen geçen kelimeler korunur;
  // "in", "bin" gibi Türkçe kelimeler İngilizce kaynakta geçse bile Türkçe kurala girer.
  const isName = (w) => /^[A-Z][a-z]+$/.test(w) && keep.has(w.toLowerCase());
  return String(s).replace(/[^\s0-9.,!?…;:'"“”‘’«»()[\]{}\-–—/\\*~]+/g, (w) => isName(w) ? w.toUpperCase() : w.replace(/i/g, "İ").replace(/ı/g, "I").toUpperCase());
}
function toPsText(s) { return String(s == null ? "" : s).replace(/\r\n|\n/g, "\r"); }
function fromPsText(s) { return String(s == null ? "" : s).replace(/\r/g, "\n"); }

function docInfo(docId) {
  const d = getDoc(docId);
  if (!d) throw new Error("Belge kapalı");
  return { doc: d, W: d.width, H: d.height, res: d.resolution };
}

async function getTextKey(docId, layerId) {
  const r = await bp({ _obj: "get", _target: [{ _property: "textKey" }, { _ref: "layer", _id: layerId }, { _ref: "document", _id: docId }] });
  return r[0].textKey;
}

/** Kutu: {cx, cy, w, h, angle} (px). style: çözümlenmiş stil. → layerId */
async function createTextLayer(docId, groupId, text, box, style, name) {
  const { doc, W, H, res } = docInfo(docId);
  if (groupId != null) await bp({ _obj: "select", _target: [{ _ref: "layer", _id: groupId }], makeVisible: false });
  const content = toPsText(style.uppercase ? trUpper(text, style.uppercaseSource) : text);
  const len = Math.max(1, content.length);
  const left = box.cx - box.w / 2, top = box.cy - box.h / 2;
  const sizePt = pxToPt(style.sizePx || 24, res);
  const ts = {
    _obj: "textStyle",
    fontPostScriptName: style.font || "ArialMT",
    size: { _unit: "pointsUnit", _value: sizePt },
    color: rgbDesc(style.color || "#000000"),
    tracking: Math.round(style.tracking || 0),
    syntheticBold: !!style.fauxBold,
    syntheticItalic: !!style.fauxItalic,
  };
  if (style.leadingPct > 0) { ts.autoLeading = false; ts.leading = { _unit: "pointsUnit", _value: sizePt * style.leadingPct / 100 }; }
  else ts.autoLeading = true;
  await bp({
    _obj: "make", _target: [{ _ref: "textLayer" }],
    using: {
      _obj: "textLayer", name: name || content.slice(0, 40), textKey: content,
      textClickPoint: { _obj: "paint", horizontal: { _unit: "percentUnit", _value: (left / W) * 100 }, vertical: { _unit: "percentUnit", _value: (top / H) * 100 } },
      antiAlias: { _enum: "antiAliasType", _value: "antiAliasSmooth" },
      textShape: [{
        _obj: "textShape", char: { _enum: "char", _value: "box" }, orientation: { _enum: "orientation", _value: "horizontal" },
        transform: { _obj: "transform", xx: 1, xy: 0, yx: 0, yy: 1, tx: 0, ty: 0 },
        rowCount: 1, columnCount: 1, rowMajorOrder: true,
        rowGutter: { _unit: "pointsUnit", _value: 0 }, columnGutter: { _unit: "pointsUnit", _value: 0 }, spacing: { _unit: "pointsUnit", _value: 0 },
        frameBaselineAlignment: { _enum: "frameBaselineAlignment", _value: "alignByAscent" }, firstBaselineMinimum: { _unit: "pointsUnit", _value: 0 },
        base: { _obj: "paint", horizontal: 0, vertical: 0 },
        bounds: { _obj: "rectangle", top: 0, left: 0, bottom: pxToPt(box.h, res), right: pxToPt(box.w, res) },
      }],
      textStyleRange: [{ _obj: "textStyleRange", from: 0, to: len, textStyle: ts }],
      paragraphStyleRange: [{ _obj: "paragraphStyleRange", from: 0, to: len, paragraphStyle: { _obj: "paragraphStyle", align: { _enum: "alignmentType", _value: style.align || "center" }, hyphenate: false } }],
    },
  });
  const layer = doc.activeLayers[0];
  const g = groupId != null ? findLayer(doc, groupId) : null;
  if (g && (!layer.parent || layer.parent.id !== groupId)) layer.move(g, constants.ElementPlacement.PLACEINSIDE);
  if (box.angle) await layer.rotate(box.angle, constants.AnchorPosition.MIDDLECENTER);
  return layer.id;
}

/** Katmandaki güncel metni ve desteklenen biçimi okur (px birimlerinde). */
async function readTextLayer(docId, layerId) {
  const { doc, res } = docInfo(docId);
  const layer = findLayer(doc, layerId);
  if (!layer) return null;
  if (String(layer.kind) !== "text") return { missing: false, notText: true, name: layer.name };
  const tk = await getTextKey(docId, layerId);
  const st = (tk.textStyleRange && tk.textStyleRange[0] && tk.textStyleRange[0].textStyle) || {};
  const ps = (tk.paragraphStyleRange && tk.paragraphStyleRange[0] && tk.paragraphStyleRange[0].paragraphStyle) || {};
  const shape = tk.textShape && tk.textShape[0];
  // Katman dönüşümü textKey.transform'dadır (textShape[0].transform kutunun yerel dönüşümü, genelde birim matris)
  const tf = tk.transform || { xx: 1, xy: 0 };
  const scale = Math.hypot(tf.xx == null ? 1 : tf.xx, tf.xy || 0);
  const angle = Math.round(((Math.atan2(tf.xy || 0, tf.xx == null ? 1 : tf.xx) * 180) / Math.PI) * 100) / 100;
  const sizePt = unitValue(st.size) || unitValue(st.impliedFontSize) || 0;
  const b = layer.boundsNoEffects;
  const leadPt = st.autoLeading === false ? unitValue(st.impliedLeading) || unitValue(st.leading) : 0;
  return {
    contents: fromPsText(tk.textKey),
    font: st.fontPostScriptName,
    sizePx: Math.round(ptToPx(sizePt, res) * scale * 10) / 10,
    color: descToHex(st.color),
    tracking: st.tracking || 0,
    leadingPct: leadPt && sizePt ? Math.round((leadPt / sizePt) * 100) : 0,
    fauxBold: !!st.syntheticBold, fauxItalic: !!st.syntheticItalic,
    align: ps.align ? ps.align._value : "left",
    isBox: shape && shape.char && shape.char._value === "box",
    boxW: shape && shape.bounds ? Math.round(ptToPx(shape.bounds.right - shape.bounds.left, res)) : null,
    boxH: shape && shape.bounds ? Math.round(ptToPx(shape.bounds.bottom - shape.bounds.top, res)) : null,
    scalePct: Math.round(scale * 1000) / 10,
    angle,
    warp: tk.warp ? { style: tk.warp.warpStyle && tk.warp.warpStyle._value, bend: tk.warp.warpValue || 0 } : null,
    rangeCount: (tk.textStyleRange || []).length,
    rawSizePt: unitValue(st.size), impliedSizePt: unitValue(st.impliedFontSize),
    bounds: { left: b.left, top: b.top, right: b.right, bottom: b.bottom },
    name: layer.name,
  };
}

async function setContents(docId, layerId, text, uppercase, source) {
  const layer = findLayer(getDoc(docId), layerId);
  layer.textItem.contents = toPsText(uppercase ? trUpper(text, source) : text);
}

/** Yalnızca verilen alanları uygular; diğer karakter biçimleri korunur. */
async function applyStyle(docId, layerId, s) {
  const { doc, res } = docInfo(docId);
  const layer = findLayer(doc, layerId);
  if (!layer) throw new Error("Metin katmanı bulunamadı");
  const ti = layer.textItem, cs = ti.characterStyle;
  if (s.font) cs.font = s.font;
  if (s.color) { const c = new app.SolidColor(); const n = parseInt(s.color.replace("#", ""), 16); c.rgb.red = (n >> 16) & 255; c.rgb.green = (n >> 8) & 255; c.rgb.blue = n & 255; cs.color = c; }
  if (s.tracking != null) cs.tracking = Math.round(s.tracking);
  if (s.fauxBold != null) cs.fauxBold = !!s.fauxBold;
  if (s.fauxItalic != null) cs.fauxItalic = !!s.fauxItalic;
  if (s.align) {
    const J = constants.Justification;
    ti.paragraphStyle.justification = s.align === "left" ? J.LEFT : s.align === "right" ? J.RIGHT : J.CENTER;
  }
  const op = {};
  if (s.sizePx) op.size = { _unit: "pointsUnit", _value: pxToPt(s.sizePx, res) };
  if (s.leadingPct != null) {
    const base = s.sizePx || (await readTextLayer(docId, layerId)).sizePx;
    if (s.leadingPct > 0) { op.autoLeading = false; op.leading = { _unit: "pointsUnit", _value: pxToPt(base * s.leadingPct / 100, res) }; }
    else op.autoLeading = true;
  }
  if (Object.keys(op).length) {
    await selectLayer(layerId);
    await bp({ _obj: "set", _target: [{ _ref: "property", _property: "textStyle" }, { _ref: "textLayer", _enum: "ordinal", _value: "targetEnum" }], to: Object.assign({ _obj: "textStyle", textOverrideFeatureName: 808465458, typeStyleOperationType: 3 }, op) });
  }
}

/** textKey oku-değiştir-yaz (kutu boyutu, warp). Biçim aralıkları olduğu gibi geri yazılır. */
async function rmwTextKey(docId, layerId, mutate) {
  const tk = await getTextKey(docId, layerId);
  mutate(tk);
  await selectLayer(layerId);
  await bp({ _obj: "set", _target: [{ _ref: "textLayer", _enum: "ordinal", _value: "targetEnum" }], to: tk });
}

/** Metin KUTUSUNU yeniden boyutlandırır (yazı ölçeklenmez). Sol-üst köşe sabit kalır. */
async function resizeBox(docId, layerId, wPx, hPx) {
  const { res } = docInfo(docId);
  await rmwTextKey(docId, layerId, (tk) => {
    const sh = tk.textShape[0];
    if (!sh.char || sh.char._value !== "box") throw new Error("Bu bir paragraf (kutu) metni değil; önce kutuya çevirin.");
    // Katman dönüşümü (ölçek) varsa kutu yerel koordinattadır; görünür boyut için ölçeği hesaba kat.
    const tf = tk.transform || { xx: 1, xy: 0 };
    const sc = Math.hypot(tf.xx == null ? 1 : tf.xx, tf.xy || 0) || 1;
    sh.bounds = { _obj: "rectangle", top: 0, left: 0, right: pxToPt(wPx / sc, res), bottom: pxToPt(hPx / sc, res) };
  });
}

/** Nokta metnini kutu metnine çevirir. */
async function ensureParagraph(docId, layerId) {
  const layer = findLayer(getDoc(docId), layerId);
  if (layer.textItem.isPointText) layer.textItem.convertToParagraphText();
}

async function setWarp(docId, layerId, style, bend) {
  await rmwTextKey(docId, layerId, (tk) => {
    tk.warp = { _obj: "warp", warpStyle: { _enum: "warpStyle", _value: style || "warpNone" }, warpValue: Number(bend) || 0, warpPerspective: 0, warpPerspectiveOther: 0, warpRotate: { _enum: "orientation", _value: "horizontal" } };
  });
}

/** KATMANI ölçekler (dönüşüm). Kutu boyutundan ayrı işlemdir. */
async function scaleLayer(docId, layerId, pct) {
  const layer = findLayer(getDoc(docId), layerId);
  await layer.scale(pct, pct, constants.AnchorPosition.MIDDLECENTER);
}

async function rotateTo(docId, layerId, angle) {
  const cur = await readTextLayer(docId, layerId);
  const delta = (Number(angle) || 0) - (cur.angle || 0);
  if (Math.abs(delta) > 0.01) await findLayer(getDoc(docId), layerId).rotate(delta, constants.AnchorPosition.MIDDLECENTER);
}

function center(b) { return [(b.left + b.right) / 2, (b.top + b.bottom) / 2]; }

async function moveCenterTo(docId, layerId, cx, cy) {
  const layer = findLayer(getDoc(docId), layerId);
  const [x, y] = center(layer.boundsNoEffects);
  const dx = cx - x, dy = cy - y;
  if (Math.abs(dx) > 0.2 || Math.abs(dy) > 0.2) await layer.translate(dx, dy);
}

async function translateBy(docId, layerId, dx, dy) {
  const layer = findLayer(getDoc(docId), layerId);
  if (dx || dy) await layer.translate(dx, dy);
}

/**
 * İsteğe bağlı balona sığdırma. box: balon kutusu (px). İkili arama ile puntoyu bulur.
 * → {sizePx, overflow, textH}
 */
async function fitToBox(docId, layerId, box, opts) {
  const { doc, res } = docInfo(docId);
  const layer = findLayer(doc, layerId);
  const pad = Math.max(0, Math.min(40, opts.paddingPct == null ? 8 : opts.paddingPct)) / 100;
  const innerW = Math.max(8, box.w * (1 - pad)), innerH = Math.max(8, box.h * (1 - pad));
  const cur = await readTextLayer(docId, layerId);
  const angle = cur.angle || 0;
  if (Math.abs(angle) > 0.01) await layer.rotate(-angle, constants.AnchorPosition.MIDDLECENTER);
  if (Math.abs(cur.scalePct - 100) > 0.5) await layer.scale(10000 / cur.scalePct, 10000 / cur.scalePct, constants.AnchorPosition.MIDDLECENTER);
  await ensureParagraph(docId, layerId);
  // Ölçüm için kutuyu yüksek yap (taşan satırlar gizlenmesin)
  await resizeBox(docId, layerId, innerW, Math.max(innerH * 6, 400));
  // Ölçüm: seç + punto (ve satır aralığı) + sınır okuma TEK batchPlay çağrısında (3 gidiş-dönüş yerine 1)
  const measure = async (px) => {
    const op = { size: { _unit: "pointsUnit", _value: pxToPt(px, res) } };
    if (opts.leadingPct != null) {
      if (opts.leadingPct > 0) { op.autoLeading = false; op.leading = { _unit: "pointsUnit", _value: pxToPt(px * opts.leadingPct / 100, res) }; }
      else op.autoLeading = true;
    }
    try {
      const r = await bp([
        { _obj: "select", _target: [{ _ref: "layer", _id: layerId }], makeVisible: false },
        { _obj: "set", _target: [{ _ref: "property", _property: "textStyle" }, { _ref: "textLayer", _enum: "ordinal", _value: "targetEnum" }], to: Object.assign({ _obj: "textStyle", textOverrideFeatureName: 808465458, typeStyleOperationType: 3 }, op) },
        { _obj: "get", _target: [{ _property: "boundsNoEffects" }, { _ref: "layer", _id: layerId }] },
      ]);
      const bb = r[2] && r[2].boundsNoEffects;
      if (bb && bb.bottom && bb.top) {
        const v = (x) => (x && typeof x === "object" ? x._value : x);
        return { h: v(bb.bottom) - v(bb.top), w: v(bb.right) - v(bb.left) };
      }
    } catch (e) { /* aşağıdaki yavaş yola düş */ }
    await applyStyle(docId, layerId, { sizePx: px, leadingPct: opts.leadingPct });
    const b = findLayer(doc, layerId).boundsNoEffects;
    return { h: b.bottom - b.top, w: b.right - b.left };
  };
  let lo = Math.max(4, opts.minPx || 10), hi = Math.max(lo, opts.maxPx || 60), best = lo;
  // Kelime bölünmesin: en uzun kelimelerin genişliğini ölç, punto o kelime kutuya TEK satırda sığacak değeri aşmasın
  // (yalnızca tek biçimli katmanlarda; elle verilmiş karakter biçimleri bozulmasın diye)
  let wordLimited = false;
  if (cur.rangeCount <= 1 && cur.contents && /\S\s+\S|\S{2,}/.test(cur.contents)) {
    const words = cur.contents.split(/\s+/).filter(Boolean).sort((a, b) => b.length - a.length).slice(0, 2);
    const PROBE = 100;
    let perPx = 0;
    await resizeBox(docId, layerId, Math.max(innerW * 30, 4000), Math.max(innerH * 6, 400));
    try {
      for (const wd of words) {
        layer.textItem.contents = wd;
        const pm = await measure(PROBE); // tek çağrı: punto + sınır
        perPx = Math.max(perPx, pm.w / PROBE);
      }
    } finally {
      layer.textItem.contents = toPsText(cur.contents); // ölçüm hata verse de asıl metin geri yazılır
    }
    await resizeBox(docId, layerId, innerW, Math.max(innerH * 6, 400));
    if (perPx > 0) {
      const wordMax = Math.floor((innerW * 0.97) / perPx);
      if (wordMax < hi) { hi = Math.max(lo, wordMax); wordLimited = true; }
    }
  }
  // Arama: yazı yüksekliği ≈ punto² ile büyür → karekökle tahmin (ikiye bölmeden çok daha az Photoshop ölçümü)
  let m = await measure(hi), lastPx = hi;
  if (m.h <= innerH && m.w <= innerW * 1.02) best = hi;
  else {
    let hHi = m.h;
    for (let i = 0; i < 6 && hi - lo > 1; i++) {
      let guess = hi * Math.sqrt(innerH / Math.max(1, hHi)) * 0.98;
      if (!(guess > lo + 0.25 && guess < hi - 0.25)) guess = (lo + hi) / 2;
      m = await measure(guess); lastPx = guess;
      if (m.h <= innerH && m.w <= innerW * 1.02) { best = guess; lo = guess; } else { hi = guess; hHi = m.h; }
    }
  }
  const fin = Math.floor(best * 2) / 2;
  if (fin !== lastPx || !(m.h <= innerH)) m = await measure(fin);
  best = fin;
  const overflow = m.h > innerH * 1.03;
  // Son kutu: metni rahat kapsayacak yükseklik
  await resizeBox(docId, layerId, innerW, Math.max(innerH, m.h + best * 1.2));
  await moveCenterTo(docId, layerId, box.cx, box.cy);
  if (Math.abs(box.angle || 0) > 0.01) await findLayer(doc, layerId).rotate(box.angle, constants.AnchorPosition.MIDDLECENTER);
  return { sizePx: best, overflow, textH: m.h, innerH };
}

// ---------------- Katman efektleri (kontur / gölge) ----------------
async function getEffects(docId, layerId) {
  try {
    const r = await bp({ _obj: "get", _target: [{ _property: "layerEffects" }, { _ref: "layer", _id: layerId }, { _ref: "document", _id: docId }] });
    return r[0].layerEffects || null;
  } catch (e) { return null; }
}

/** Yalnızca kontur/gölge alanlarını değiştirir; kullanıcının diğer efektleri korunur. */
async function setStrokeShadow(docId, layerId, s) {
  const cur = (await getEffects(docId, layerId)) || { _obj: "layerEffects", scale: { _unit: "percentUnit", _value: 100 } };
  if (s.strokeEnabled != null) {
    if (s.strokeEnabled) {
      cur.frameFX = {
        _obj: "frameFX", enabled: true, present: true, showInDialog: true,
        style: { _enum: "frameStyle", _value: "outsetFrame" }, paintType: { _enum: "frameFill", _value: "solidColor" },
        mode: { _enum: "blendMode", _value: "normal" }, opacity: { _unit: "percentUnit", _value: 100 },
        size: { _unit: "pixelsUnit", _value: Math.max(1, Math.round(s.strokeSize || 3)) }, color: rgbDesc(s.strokeColor || "#ffffff"), overprint: false,
      };
    } else if (cur.frameFX) cur.frameFX.enabled = false;
  }
  if (s.shadowEnabled != null) {
    if (s.shadowEnabled) {
      cur.dropShadow = {
        _obj: "dropShadow", enabled: true, present: true, showInDialog: true, mode: { _enum: "blendMode", _value: "multiply" },
        color: rgbDesc(s.shadowColor || "#000000"), opacity: { _unit: "percentUnit", _value: s.shadowOpacity == null ? 75 : s.shadowOpacity },
        useGlobalAngle: false, localLightingAngle: { _unit: "angleUnit", _value: s.shadowAngle == null ? 120 : s.shadowAngle },
        distance: { _unit: "pixelsUnit", _value: s.shadowDistance == null ? 4 : s.shadowDistance }, chokeMatte: { _unit: "pixelsUnit", _value: 0 },
        blur: { _unit: "pixelsUnit", _value: s.shadowSize == null ? 4 : s.shadowSize }, noise: { _unit: "percentUnit", _value: 0 },
        antiAlias: false, transferSpec: { _obj: "shapeCurveType", name: "Linear" }, layerConceals: true,
      };
    } else if (cur.dropShadow) cur.dropShadow.enabled = false;
  }
  await selectLayer(layerId);
  await bp({ _obj: "set", _target: [{ _ref: "property", _property: "layerEffects" }, { _ref: "layer", _enum: "ordinal", _value: "targetEnum" }], to: cur });
}

async function readStrokeShadow(docId, layerId) {
  const fx = await getEffects(docId, layerId);
  const o = { strokeEnabled: false, shadowEnabled: false };
  if (fx && fx.frameFX && fx.frameFX.enabled !== false) { o.strokeEnabled = true; o.strokeSize = unitValue(fx.frameFX.size); o.strokeColor = descToHex(fx.frameFX.color); }
  if (fx && fx.dropShadow && fx.dropShadow.enabled !== false) { o.shadowEnabled = true; o.shadowColor = descToHex(fx.dropShadow.color); o.shadowDistance = unitValue(fx.dropShadow.distance); o.shadowSize = unitValue(fx.dropShadow.blur); }
  return o;
}

module.exports = {
  trUpper, toPsText, fromPsText, pxToPt, ptToPx,
  createTextLayer, readTextLayer, setContents, applyStyle, rmwTextKey, resizeBox, ensureParagraph, setWarp,
  scaleLayer, rotateTo, moveCenterTo, translateBy, fitToBox, getEffects, setStrokeShadow, readStrokeShadow,
};
