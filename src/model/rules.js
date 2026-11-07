// Stil çözümleme: alan bazında öncelik  manuel → bölüm → seri → genel → varsayılan.
// Her düzeyde: öncelik değeri en yüksek olan EŞLEŞEN kural kazanır; ardından o düzeyin taban stili.
"use strict";

const ITEM_TYPES = [
  { id: "dialog", label: "Diyalog balonu" },
  { id: "narration", label: "Anlatım kutusu" },
  { id: "offbubble", label: "Balon dışı metin" },
  { id: "sfx", label: "SFX" },
];
const TONES = [
  { id: "normal", label: "Normal" },
  { id: "shout", label: "Bağırma" },
  { id: "whisper", label: "Fısıltı" },
  { id: "thought", label: "Düşünce" },
];

/** Stil alanları — panel editörü ve kural editörü bu listeden üretilir. */
const STYLE_FIELDS = [
  { key: "font", label: "Font", type: "font" },
  { key: "fallbackFont", label: "Yedek font", type: "font" },
  { key: "sizePx", label: "Punto (px)", type: "number", min: 4, max: 400 },
  { key: "minSizePx", label: "Min. punto", type: "number", min: 4, max: 200 },
  { key: "maxSizePx", label: "Maks. punto", type: "number", min: 4, max: 400 },
  { key: "leadingPct", label: "Satır aralığı %", type: "number", min: 0, max: 300, hint: "0 = otomatik" },
  { key: "tracking", label: "Harf aralığı", type: "number", min: -200, max: 1000 },
  { key: "align", label: "Hizalama", type: "select", options: [["left", "Sola"], ["center", "Ortala"], ["right", "Sağa"]] },
  { key: "color", label: "Renk", type: "color" },
  { key: "fauxBold", label: "Kalın (sahte)", type: "bool" },
  { key: "fauxItalic", label: "İtalik (sahte)", type: "bool" },
  { key: "uppercase", label: "BÜYÜK HARF (Türkçe)", type: "bool" },
  { key: "strokeEnabled", label: "Kontur", type: "bool" },
  { key: "strokeSize", label: "Kontur kalınlığı", type: "number", min: 1, max: 50 },
  { key: "strokeColor", label: "Kontur rengi", type: "color" },
  { key: "shadowEnabled", label: "Gölge", type: "bool" },
  { key: "shadowColor", label: "Gölge rengi", type: "color" },
  { key: "shadowDistance", label: "Gölge mesafesi", type: "number", min: 0, max: 100 },
  { key: "shadowSize", label: "Gölge yumuşaklığı", type: "number", min: 0, max: 100 },
  { key: "fit", label: "Balona sığdır", type: "bool" },
  { key: "paddingPct", label: "Kenar boşluğu %", type: "number", min: 0, max: 40 },
  { key: "warpStyle", label: "Warp", type: "select", options: [["warpNone", "Yok"], ["warpArc", "Yay"], ["warpArch", "Kemer"], ["warpBulge", "Şişkin"], ["warpFlag", "Bayrak"], ["warpWave", "Dalga"], ["warpRise", "Yükselen"], ["warpSqueeze", "Sıkıştır"], ["warpTwist", "Burgu"], ["warpShellLower", "Kabuk alt"], ["warpShellUpper", "Kabuk üst"], ["warpFish", "Balık"], ["warpInflate", "Şişir"]] },
  { key: "warpBend", label: "Warp bükümü", type: "number", min: -100, max: 100 },
];

const DEFAULT_STYLE = {
  font: "ArialMT", fallbackFont: "ArialMT", sizePx: 28, minSizePx: 12, maxSizePx: 48, leadingPct: 0, tracking: 0,
  align: "center", color: "#000000", fauxBold: false, fauxItalic: false, uppercase: false,
  strokeEnabled: false, strokeSize: 3, strokeColor: "#ffffff", shadowEnabled: false, shadowColor: "#000000", shadowDistance: 4, shadowSize: 4,
  fit: true, paddingPct: 10, warpStyle: "warpNone", warpBend: 0,
};

const CONDITION_FIELDS = [
  { key: "source", label: "Kaynak metin" },
  { key: "translation", label: "Çeviri" },
  { key: "sourceAllCaps", label: "Kaynak tamamen büyük harf", bool: true },
  { key: "exclaim", label: "Ünlem içeriyor", bool: true },
  { key: "parenthesized", label: "Parantez içinde", bool: true },
  { key: "ellipsis", label: "Üç nokta içeriyor", bool: true },
  { key: "vertical", label: "Dikey yazı", bool: true },
  { key: "length", label: "Karakter sayısı", num: true },
  { key: "fontsizeRatio", label: "Yazı boyu / sayfa ortalaması", num: true },
  { key: "confidence", label: "OCR güveni (0-1)", num: true },
  { key: "sourceLang", label: "Kaynak dil kodu" },
];
const OPERATORS = [
  ["contains", "içerir"], ["notContains", "içermez"], ["equals", "eşittir"], ["startsWith", "ile başlar"], ["endsWith", "ile biter"],
  ["regex", "düzenli ifade"], ["gt", ">"], ["lt", "<"], ["isTrue", "evet"], ["isFalse", "hayır"],
];

function featuresOf(item, pageStats) {
  const src = item.source || "";
  const letters = src.replace(/[^A-Za-zÀ-ÿ]/g, "");
  return {
    source: src, translation: item.translation || "",
    sourceAllCaps: letters.length >= 2 && letters === letters.toUpperCase(),
    exclaim: /[!！]/.test(src) || /!/.test(item.translation || ""),
    parenthesized: /^\s*[(（].*[)）]\s*$/s.test(src),
    ellipsis: /(\.\.\.|…|。。。)/.test(src),
    vertical: item.direction === "top_to_bottom",
    length: (item.translation || src).length,
    fontsizeRatio: item.ocr && item.ocr.fontsize && pageStats && pageStats.medianFont ? item.ocr.fontsize / pageStats.medianFont : 1,
    confidence: item.confidence == null ? 1 : item.confidence,
    sourceLang: item.sourceLang || "",
  };
}

function testCondition(c, f) {
  const v = f[c.field];
  const val = c.value;
  switch (c.op) {
    case "isTrue": return !!v;
    case "isFalse": return !v;
    case "gt": return Number(v) > Number(val);
    case "lt": return Number(v) < Number(val);
    case "equals": return String(v).toLocaleLowerCase("tr") === String(val).toLocaleLowerCase("tr");
    case "contains": return String(v).toLocaleLowerCase("tr").includes(String(val).toLocaleLowerCase("tr"));
    case "notContains": return !String(v).toLocaleLowerCase("tr").includes(String(val).toLocaleLowerCase("tr"));
    case "startsWith": return String(v).toLocaleLowerCase("tr").startsWith(String(val).toLocaleLowerCase("tr"));
    case "endsWith": return String(v).toLocaleLowerCase("tr").endsWith(String(val).toLocaleLowerCase("tr"));
    case "regex": try { return new RegExp(val, "i").test(String(v)); } catch (e) { return false; }
    default: return false;
  }
}

/** Kural: {id, name, enabled, priority, types[], tones[], match:'all'|'any', conditions[], style{}} */
function ruleMatches(rule, item, f) {
  if (rule.enabled === false) return false;
  if (rule.types && rule.types.length && !rule.types.includes(item.type)) return false;
  if (rule.tones && rule.tones.length && !rule.tones.includes(item.tone || "normal")) return false;
  const conds = rule.conditions || [];
  if (!conds.length) return true;
  return rule.match === "any" ? conds.some((c) => testCondition(c, f)) : conds.every((c) => testCondition(c, f));
}

/**
 * levels: [{level:'chapter'|'series'|'global', label, rules[], base{}}] (yüksekten düşüğe)
 * → { style, sources: {field: {level, label, rule}} }
 */
function resolveStyle(item, levels, pageStats) {
  const f = featuresOf(item, pageStats);
  const style = {}, sources = {};
  const take = (field, value, src) => {
    if (value === undefined || value === null || value === "" || field in style) return;
    style[field] = value; sources[field] = src;
  };
  // 1) Manuel değerler
  for (const k of Object.keys(item.manual || {})) take(k, item.manual[k], { level: "manual", label: "Manuel değer" });
  // 2..4) Bölüm → seri → genel
  for (const lv of levels) {
    if (!lv) continue;
    const matched = (lv.rules || []).filter((r) => ruleMatches(r, item, f)).sort((a, b) => (b.priority || 0) - (a.priority || 0));
    for (const r of matched) for (const k of Object.keys(r.style || {})) take(k, r.style[k], { level: lv.level, label: lv.label, rule: r.name });
    for (const k of Object.keys(lv.base || {})) take(k, lv.base[k], { level: lv.level, label: lv.label + " (taban)" });
  }
  // 5) Varsayılan
  for (const k of Object.keys(DEFAULT_STYLE)) take(k, DEFAULT_STYLE[k], { level: "default", label: "Varsayılan" });
  // OCR renklerini, kural renk belirtmemişse varsayılanın yerine kullan
  if (sources.color && sources.color.level === "default" && item.ocr && item.ocr.textColor) { style.color = item.ocr.textColor; sources.color = { level: "ocr", label: "Orijinal yazı rengi (OCR)" }; }
  return { style, sources };
}

const LEVEL_LABEL = { manual: "Manuel", chapter: "Bölüm", series: "Seri", global: "Genel", default: "Varsayılan", ocr: "OCR" };

module.exports = { ITEM_TYPES, TONES, STYLE_FIELDS, DEFAULT_STYLE, CONDITION_FIELDS, OPERATORS, featuresOf, testCondition, ruleMatches, resolveStyle, LEVEL_LABEL };
