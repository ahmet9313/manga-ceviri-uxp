// Ayarlar: tek çeviri/stil yapılandırması (settings.config) + genel ayarlar + bölümler.
// Seri profili sistemi kaldırıldı (1.2.0): eski ayar dosyalarındaki profiller silinir, yapılandırma varsayılana döner.
// Ayarlar anahtar İÇERMEZ (anahtarlar UXP Secure Storage'da).
"use strict";
const { uid, clone } = require("../util/common");

/** Hazır gelen, düzenlenebilir SFX kuralı. Font/renk/kontur belirtilmez → orijinal görünüm + türe göre font. */
function defaultSfxRule() {
  return { id: uid("r_"), name: "SFX (varsayılan)", enabled: true, priority: 5, types: ["sfx"], tones: [], match: "all", conditions: [],
    style: { fauxBold: true, uppercase: true, maxSizePx: 160, paddingPct: 2, fit: true } }; // min. punto: orijinal yazı boyundan (applyOriginalLook)
}

/** Çeviri + stil + temizlik yapılandırması (eski "seri profili"nin yerini alır; tektir). */
function defaultConfig() {
  return {
    sourceLang: "auto", targetLang: "tr", readingDir: "ltr",
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
  return {
    version: 2,
    config: defaultConfig(),
    chapters: [],
    ui: { scope: "page", filters: { dialog: true, narration: true, offbubble: true, sfx: true }, bubblesOnly: false, fullMode: "modular", tab: "items", open: {} },
    torii: { byokProvider: "", byokFallback: true },
    cleanup: { preview: false, verified: {} },
    firefly: { proxyUrl: "" },
    adobe: { prompt: "" }, // Üretken Dolgu istemi (boş = yazıyı sil, zemini tamamla)
  };
}

/**
 * Eski "seri profilleri" kaldırılır: profiller, "Genel" kurallar ve etkin profil kimliği SİLİNİR, değerleri taşınmaz
 * (kullanıcı tercihi). Yapılandırma varsayılana döner (Torii: OCR, çeviri, temizlik). Dönüş: true = eski profil vardı.
 */
function migrateProfiles(S) {
  if (!S || !("profiles" in S || "global" in S || "activeProfileId" in S)) return false;
  delete S.profiles; delete S.activeProfileId; delete S.global;
  if (S.torii) { delete S.torii.translator; delete S.torii.reasoning; }
  S.config = defaultConfig();
  return true;
}

/** Sözlük, karakterler ve talimattan Torii custom_prompt (≤1000) üretir. */
function buildCustomPrompt(cfg, chapter, extra) {
  const parts = [];
  if (cfg.instruction) parts.push(cfg.instruction.trim());
  if (chapter && chapter.instruction) parts.push(chapter.instruction.trim());
  if (cfg.honorifics) parts.push("Hitap biçimi: " + cfg.honorifics.trim());
  if (extra) parts.push(extra.trim());
  const tr = !cfg.targetLang || cfg.targetLang === "tr";
  if (tr) parts.push("Türkçe imla kurallarına uy; ÇĞİÖŞÜ çğıöşü harflerini doğru kullan.");
  parts.push(tr ? "Ses efektlerini (SFX) anlamıyla değil, kısa Türkçe yansıma sözcükle çevir (ör. SNAP → ÇAT!, BANG → BAM!, THUD → GÜM!, HUH? → HA?). Kişi ve yer adlarını değiştirme."
    : "Translate sound effects (SFX) as short onomatopoeia of the target language, not literally. Keep person and place names.");
  let s = parts.join("\n");
  if (s.length > 1000) s = s.slice(0, 997) + "…";
  return s;
}

/** Sözlük + karakter adları + önceki sayfa bağlamı → Torii context (≤10000, son kısım tutulur). */
function buildContext(cfg, chapter, chainContext) {
  const lines = [];
  if (cfg.characters && cfg.characters.length) {
    lines.push("Karakterler:");
    for (const c of cfg.characters) lines.push(`- ${c.name}${c.tr ? " → " + c.tr : ""}${c.note ? " (" + c.note + ")" : ""}`);
  }
  if (cfg.glossary && cfg.glossary.length) {
    lines.push("Seri sözlüğü (kaynak → hedef):");
    for (const g of cfg.glossary) lines.push(`- ${g.src} → ${g.tgt}${g.note ? " (" + g.note + ")" : ""}`);
  }
  const head = lines.join("\n");
  const chain = chainContext ? String(chainContext) : "";
  let s = chain ? (head ? head + "\n\n" + chain : chain) : head;
  if (s.length > 10000) s = head.slice(0, 3000) + "\n…\n" + chain.slice(-(10000 - Math.min(3000, head.length) - 3));
  return s;
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

module.exports = { LANGS, sourceWhitelist, defaultSfxRule, defaultConfig, exampleRules, defaultSettings, migrateProfiles, buildCustomPrompt, buildContext, applyTurkishFixes };
