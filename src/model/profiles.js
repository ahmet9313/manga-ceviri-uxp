// Seri profilleri, genel ayarlar, bölümler. Profiller anahtar İÇERMEZ; dışa aktarımda ayrıca temizlenir.
"use strict";
const { uid, clone, redact } = require("../util/common");
const { DEFAULT_STYLE } = require("./rules");

/** Her yeni seride hazır gelen, düzenlenebilir SFX kuralı. Font/renk/kontur belirtilmez → orijinal görünüm + türe göre font. */
function defaultSfxRule() {
  return { id: uid("r_"), name: "SFX (varsayılan)", enabled: true, priority: 5, types: ["sfx"], tones: [], match: "all", conditions: [],
    style: { fauxBold: true, uppercase: true, minSizePx: 18, maxSizePx: 140, paddingPct: 2, fit: true } };
}

function defaultProfile(name) {
  return {
    id: uid("p_"), name: name || "Yeni seri", targetLang: "tr", readingDir: "ltr",
    translator: "gemini-3.1-flash-lite", reasoning: "none",
    // Font bilerek boş: kural yoksa türe göre kurulu çizgi roman fontu seçilir (Diyalog / SFX ayrı)
    base: { sizePx: 28, minSizePx: 12, maxSizePx: 44, align: "center", fit: true, paddingPct: 10 },
    rules: [defaultSfxRule()],
    glossary: [], characters: [], honorifics: "", instruction: "",
    cleanup: { method: "auto", dilatePx: 4, flatTolerance: 14 },
    turkish: { enabled: true, circumflexToPlain: false, smartPunct: true },
  };
}

/** Örnek: kullanıcının istediği "normal/bağırma/fısıltı/düşünce/SFX" kural seti. */
function exampleRules(fonts) {
  const F = fonts || {};
  return [
    { id: uid("r_"), name: "Normal balon", enabled: true, priority: 10, types: ["dialog"], tones: ["normal"], match: "all", conditions: [], style: { font: F.a || "ArialMT" } },
    { id: uid("r_"), name: "Bağırma", enabled: true, priority: 50, types: ["dialog"], tones: ["shout"], match: "all", conditions: [], style: { font: F.b || "Arial-BoldMT", strokeEnabled: true, strokeSize: 4, strokeColor: "#ffffff" } },
    { id: uid("r_"), name: "Fısıltı", enabled: true, priority: 40, types: ["dialog"], tones: ["whisper"], match: "all", conditions: [], style: { font: F.c || "ArialMT", sizePx: 20, maxSizePx: 26 } },
    { id: uid("r_"), name: "Düşünce balonu", enabled: true, priority: 40, types: ["dialog"], tones: ["thought"], match: "all", conditions: [], style: { font: F.d || "Arial-ItalicMT", fauxItalic: !F.d } },
    { id: uid("r_"), name: "SFX", enabled: true, priority: 30, types: ["sfx"], tones: [], match: "all", conditions: [], style: { font: F.e || "Impact", shadowEnabled: true, strokeEnabled: true, strokeSize: 5, strokeColor: "#ffffff", fit: true, maxSizePx: 120 } },
  ];
}

function defaultSettings() {
  const p = defaultProfile("Varsayılan seri");
  return {
    version: 1,
    activeProfileId: p.id,
    profiles: [p],
    // Genel taban boş: değerler "Varsayılan" düzeyinden gelir, böylece türe göre görünüm (SFX, orijinal renk) devreye girebilir
    global: { base: {}, rules: [] },
    chapters: [],
    ui: { scope: "page", filters: { dialog: true, narration: true, offbubble: true, sfx: true }, bubblesOnly: false, fullMode: "auto" },
    torii: { translator: "gemini-3.1-flash-lite", reasoning: "none", byokProvider: "", byokFallback: true, minFontPx: 10 },
    cleanup: { preview: false, verified: {} },
    firefly: { proxyUrl: "" },
    adobe: { model: "firefly", modelLabel: "Adobe Firefly (Üretken dolgu)", prompt: "", templates: [] },
  };
}

/** Sözlük, karakterler ve talimattan Torii custom_prompt (≤1000) üretir. */
function buildCustomPrompt(profile, chapter, extra) {
  const parts = [];
  if (profile.instruction) parts.push(profile.instruction.trim());
  if (chapter && chapter.instruction) parts.push(chapter.instruction.trim());
  if (profile.honorifics) parts.push("Hitap biçimi: " + profile.honorifics.trim());
  if (extra) parts.push(extra.trim());
  parts.push("Türkçe imla kurallarına uy; ÇĞİÖŞÜ çğıöşü harflerini doğru kullan.");
  parts.push("Ses efektlerini (SFX) anlamıyla değil, kısa Türkçe yansıma sözcükle çevir (ör. SNAP → ÇAT!, BANG → BAM!, THUD → GÜM!, HUH? → HA?). Kişi ve yer adlarını değiştirme.");
  let s = parts.join("\n");
  if (s.length > 1000) s = s.slice(0, 997) + "…";
  return s;
}

/** Sözlük + karakter adları + önceki sayfa bağlamı → Torii context (≤10000, son kısım tutulur). */
function buildContext(profile, chapter, chainContext) {
  const lines = [];
  if (profile.characters && profile.characters.length) {
    lines.push("Karakterler:");
    for (const c of profile.characters) lines.push(`- ${c.name}${c.tr ? " → " + c.tr : ""}${c.note ? " (" + c.note + ")" : ""}`);
  }
  if (profile.glossary && profile.glossary.length) {
    lines.push("Seri sözlüğü (kaynak → hedef):");
    for (const g of profile.glossary) lines.push(`- ${g.src} → ${g.tgt}${g.note ? " (" + g.note + ")" : ""}`);
  }
  const head = lines.join("\n");
  const chain = chainContext ? String(chainContext) : "";
  let s = chain ? (head ? head + "\n\n" + chain : chain) : head;
  if (s.length > 10000) s = head.slice(0, 3000) + "\n…\n" + chain.slice(-(10000 - Math.min(3000, head.length) - 3));
  return s;
}

/** Profili dışa aktarmaya hazırla: kimlik ve gizli bilgi yok. */
function exportProfile(profile) {
  const p = clone(profile);
  delete p.byokKey; delete p.apiKey;
  return JSON.parse(redact(JSON.stringify({ format: "manga-ceviri-profil", version: 1, profile: p })));
}

function importProfile(json) {
  const o = typeof json === "string" ? JSON.parse(json) : json;
  const p = o && o.profile ? o.profile : o;
  if (!p || typeof p !== "object" || !p.name) throw new Error("Geçersiz profil dosyası");
  const base = defaultProfile(p.name);
  const merged = Object.assign(base, p, { id: uid("p_") });
  merged.rules = (merged.rules || []).map((r) => Object.assign({}, r, { id: uid("r_") }));
  return merged;
}

function copyProfile(profile, newName) {
  const p = clone(profile);
  p.id = uid("p_"); p.name = newName || profile.name + " (kopya)";
  p.rules = (p.rules || []).map((r) => Object.assign({}, r, { id: uid("r_") }));
  return p;
}

// ---- Türkçe düzeltme ----
function applyTurkishFixes(text, opts) {
  if (!opts || !opts.enabled || !text) return text;
  let s = String(text);
  if (opts.circumflexToPlain) s = s.replace(/â/g, "a").replace(/Â/g, "A"); // yalnızca â/Â; diğer harfler korunur
  if (opts.smartPunct) {
    s = s.replace(/\.\.\./g, "…").replace(/ +([!?…,.])/g, "$1");
  }
  return s;
}

// Torii dil kodları (dokümandaki listeden sık kullanılanlar)
const LANGS = [
  ["tr", "Türkçe"], ["en", "İngilizce"], ["ja", "Japonca"], ["ko", "Korece"], ["zh", "Çince"], ["zh-cn", "Çince (Basitleştirilmiş)"], ["zh-tw", "Çince (Geleneksel)"],
  ["es", "İspanyolca"], ["es-419", "İspanyolca (Latin Amerika)"], ["pt-br", "Portekizce (Brezilya)"], ["fr", "Fransızca"], ["de", "Almanca"], ["it", "İtalyanca"],
  ["ru", "Rusça"], ["ar", "Arapça"], ["id", "Endonezce"], ["vi", "Vietnamca"], ["th", "Tayca"], ["pl", "Lehçe"], ["uk", "Ukraynaca"], ["az", "Azerbaycanca"], ["fa", "Farsça"],
];

/** Torii source_langs_whitelist: profil kaynak dili "auto" değilse o dil (zh ailesi birlikte). */
function sourceWhitelist(p) {
  const s = p && p.sourceLang;
  if (!s || s === "auto") return undefined;
  if (s.indexOf("zh") === 0) return ["zh", "zh-cn", "zh-tw"];
  return [s];
}

module.exports = { LANGS, sourceWhitelist, defaultSfxRule, defaultProfile, exampleRules, defaultSettings, buildCustomPrompt, buildContext, exportProfile, importProfile, copyProfile, applyTurkishFixes };
