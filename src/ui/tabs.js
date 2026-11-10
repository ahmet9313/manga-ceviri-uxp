// Sekmeler: Bölüm, Profil, Temizlik, Ayarlar (Gelişmiş: BYOK, Firefly, Eylemler, araçlar, log).
// İlerleyen açılım: her bölüm açılır-kapanır karttır; nadir kullanılanlar kapalı başlar, durum ayarlarda saklanır.
"use strict";
const { h, clear, select, numberInput, textInput, checkbox, colorInput, esc, card, emptyState } = require("./dom");
const { fontPicker } = require("./fontpicker");
const { ITEM_TYPES, TONES, STYLE_FIELDS, CONDITION_FIELDS, OPERATORS } = require("../model/rules");
const conf = require("../model/config");
const storage = require("../model/storage");
const { METHODS } = require("../model/cleanup");
const { TRANSLATORS, BYOK_PROVIDERS } = require("../torii/client");
const { uid, logBuffer, redact } = require("../util/common");
const dialogs = require("./dialogs");

/** Kart açık/kapalı durumu: settings.ui.open (kalıcı). */
function openState(app) {
  const ui = app.settings.ui;
  ui.open = ui.open || {};
  if (!Object.prototype.hasOwnProperty.call(ui.open, "__save")) Object.defineProperty(ui.open, "__save", { value: () => app.saveSettings(), enumerable: false });
  return ui.open;
}
const field = (label, ...ctl) => h("div", { class: "field" }, h("label", null, label), ...ctl);
const hint = (t) => h("div", { class: "hint" }, t);

// ------------------------------------------------------------------ Kural editörü (kod yazmadan)
function ruleEditor(rules, onChange, checks) {
  const wrap = h("div", { class: "stack" });
  const draw = () => {
    clear(wrap);
    rules.sort((a, b) => (b.priority || 0) - (a.priority || 0));
    rules.forEach((r) => {
      const open = r._open;
      const summary = `${r.enabled === false ? "⏸ " : ""}${r.name} · öncelik ${r.priority || 0} · ${(r.types || []).length ? r.types.join("/") : "tüm türler"}${(r.tones || []).length ? " · " + r.tones.join("/") : ""}`;
      const sec = h("div", { class: "card" },
        h("div", { class: "row tight" },
          h("button", { class: "mini icon", title: open ? "Kapat" : "Düzenle", onclick: () => { r._open = !open; draw(); } }, open ? "▾" : "▸"),
          h("span", { class: "grow small" }, summary),
          h("button", { class: "mini icon", title: "Çoğalt", onclick: () => { const c = JSON.parse(JSON.stringify(r)); c.id = uid("r_"); c.name += " (kopya)"; rules.push(c); onChange(); draw(); } }, "⧉"),
          h("button", { class: "mini icon quiet danger", title: "Sil", onclick: () => { rules.splice(rules.indexOf(r), 1); onChange(); draw(); } }, "✕")));
      if (open) {
        const commit = () => { onChange(); };
        const body = h("div", { class: "stack", style: { marginTop: "8px" } });
        body.appendChild(field("Ad", textInput(r.name, (v) => { r.name = v; commit(); })));
        body.appendChild(field("Öncelik", numberInput(r.priority || 0, (v) => { r.priority = v || 0; commit(); draw(); }), checkbox(r.enabled !== false, (v) => { r.enabled = v; commit(); }, "Etkin")));
        body.appendChild(field("Öğe türü", ...ITEM_TYPES.map((t) => checkbox((r.types || []).includes(t.id), (v) => { r.types = (r.types || []).filter((x) => x !== t.id); if (v) r.types.push(t.id); commit(); }, t.label))));
        body.appendChild(field("Ton", ...TONES.map((t) => checkbox((r.tones || []).includes(t.id), (v) => { r.tones = (r.tones || []).filter((x) => x !== t.id); if (v) r.tones.push(t.id); commit(); }, t.label))));
        body.appendChild(field("Koşul eşleşmesi", select([["all", "Tümü sağlanmalı"], ["any", "Herhangi biri"]], r.match || "all", (v) => { r.match = v; commit(); })));
        (r.conditions || []).forEach((c, ci) => {
          body.appendChild(h("div", { class: "row" },
            select(CONDITION_FIELDS.map((f) => [f.key, f.label]), c.field, (v) => { c.field = v; commit(); }),
            select(OPERATORS, c.op, (v) => { c.op = v; commit(); }),
            textInput(c.value == null ? "" : c.value, (v) => { c.value = v; commit(); }, { style: { width: "90px" } }),
            h("button", { class: "mini icon quiet", onclick: () => { r.conditions.splice(ci, 1); commit(); draw(); } }, "✕")));
        });
        body.appendChild(h("button", { class: "mini", onclick: () => { r.conditions = r.conditions || []; r.conditions.push({ field: "source", op: "contains", value: "" }); commit(); draw(); } }, "+ Koşul"));
        body.appendChild(h("div", { class: "group-label" }, "UYGULANACAK STİL (işaretli alanlar)"));
        for (const f of STYLE_FIELDS) {
          const has = r.style && f.key in r.style;
          const set = (val) => { r.style = r.style || {}; r.style[f.key] = val; commit(); };
          let ctl = null;
          if (has) {
            const v = r.style[f.key];
            if (f.type === "font") ctl = fontPicker(v, set, checks, { noPreview: true });
            else if (f.type === "number") ctl = numberInput(v, set, { min: f.min, max: f.max });
            else if (f.type === "bool") ctl = checkbox(v, set);
            else if (f.type === "color") ctl = colorInput(v, set);
            else if (f.type === "select") ctl = select(f.options, v, set);
          }
          body.appendChild(h("div", { class: "field" },
            checkbox(has, (on) => { r.style = r.style || {}; if (on) r.style[f.key] = f.type === "bool" ? true : f.type === "number" ? (f.min || 0) : f.type === "color" ? "#000000" : f.type === "select" ? f.options[0][0] : ""; else delete r.style[f.key]; commit(); draw(); }, f.label),
            ctl));
        }
        sec.appendChild(body);
      }
      wrap.appendChild(sec);
    });
    wrap.appendChild(h("button", { class: "mini", onclick: () => { rules.push({ id: uid("r_"), name: "Yeni kural", enabled: true, priority: 10, types: [], tones: [], match: "all", conditions: [], style: {}, _open: true }); onChange(); draw(); } }, "+ Kural ekle"));
  };
  draw();
  return wrap;
}

function listEditor(rows, cols, onChange) {
  const wrap = h("div", { class: "stack" });
  const draw = () => {
    clear(wrap);
    rows.forEach((r, i) => wrap.appendChild(h("div", { class: "row" },
      ...cols.map((c) => textInput(r[c.key] || "", (v) => { r[c.key] = v; onChange(); }, { placeholder: c.label, style: { width: c.w || "90px" } })),
      h("button", { class: "mini icon quiet", title: "Sil", onclick: () => { rows.splice(i, 1); onChange(); draw(); } }, "✕"))));
    wrap.appendChild(h("button", { class: "mini", onclick: () => { rows.push({}); onChange(); draw(); } }, "+ Ekle"));
  };
  draw();
  return wrap;
}

/** Ayarlar › yalnızca gerçekten gereken çeviri ayarları (seri profili yok; stil/kurallar otomatik varsayılanla). */
function translationCards(app, O, save) {
  const c = app.pipeline.cfg();
  const instr = h("textarea", { rows: 3, placeholder: "İsteğe bağlı: ton, üslup, isim kuralları (ör. \"Resmî hitap kullanma\")" }); instr.value = c.instruction || "";
  instr.addEventListener("change", () => { c.instruction = instr.value; save(); });
  c.glossary = c.glossary || []; c.characters = c.characters || [];
  return [
    card("s-tr", "Çeviri", `${(conf.LANGS.find((l) => l[0] === c.targetLang) || ["", c.targetLang])[1]} · ${(TRANSLATORS.find((t) => t.id === c.translator) || { label: c.translator }).label}`, [
      field("Kaynak dil", select([["auto", "Otomatik algıla"]].concat(conf.LANGS.filter((l) => l[0] !== "tr")), c.sourceLang || "auto", (v) => { c.sourceLang = v; save(); })),
      hint("Bir dil seçilirse yalnızca o dildeki yazılar çevrilip silinir; diğer dillerdeki yazılar olduğu gibi kalır."),
      field("Hedef dil", select(conf.LANGS, c.targetLang || "tr", (v) => { c.targetLang = v; save(); })),
      field("Okuma yönü", select([["ltr", "Soldan sağa (webtoon/manhwa)"], ["rtl", "Sağdan sola (manga)"]], c.readingDir || "ltr", (v) => { c.readingDir = v; save(); })),
      field("Çeviri modeli", select(TRANSLATORS.map((t) => [t.id, t.label]), c.translator, (v) => { c.translator = v; save(); })),
    ], O, true),
    card("s-ctx", "Talimat ve sözlük", `${c.glossary.length} terim · ${c.characters.length} karakter`, [
      instr,
      h("div", { class: "group-label" }, "SÖZLÜK (kaynak → hedef)"), listEditor(c.glossary, [{ key: "src", label: "Kaynak" }, { key: "tgt", label: "Hedef" }], save),
      h("div", { class: "group-label" }, "KARAKTER ADLARI"), listEditor(c.characters, [{ key: "name", label: "Ad" }, { key: "tr", label: "Türkçe yazımı" }], save),
    ], O, false),
  ];
}

// ------------------------------------------------------------------ Bölüm sekmesi
function renderChapter(root, app) {
  clear(root);
  const S = app.settings, store = app.store, O = openState(app);
  const sess = store.active;
  const ch = sess && sess.state.chapterId ? S.chapters.find((c) => c.id === sess.state.chapterId) : null;
  const save = () => app.saveSettings();
  const act = (fn) => async () => { try { await fn(); } catch (e) { app.notify(e.message, "error"); } };
  if (!sess) { root.appendChild(emptyState("▢", "Belge açık değil", "Bölüm, açık sayfalardan veya bir klasörden oluşturulur.")); return; }
  root.appendChild(card("c-main", "Bölüm", ch ? `${ch.name} · ${ch.pages.length} sayfa` : "bu sayfa bir bölüme ait değil", [
    field("Bu sayfanın bölümü", select([["", "(bölüm yok)"]].concat(S.chapters.map((c) => [c.id, c.name])), ch ? ch.id : "", (v) => app.assignChapter(v || null))),
    h("div", { class: "row" },
      h("button", { class: "mini", onclick: act(() => app.chapterFromOpenDocs()) }, "Açık belgelerden oluştur"),
      h("button", { class: "mini", onclick: act(() => app.chapterFromFolder()) }, "Klasörden oluştur")),
    ch ? field("Bölüm adı", textInput(ch.name, (v) => { ch.name = v; save(); })) : null,
    ch ? hint(`Bağlam zinciri ${ch.chainContext ? ch.chainContext.length + " karakter" : "boş"} — sayfadan sayfaya taşınır. Üstte Kapsam › Bölüm seçip adımları çalıştırın.`) : null,
    ch ? h("div", { class: "stack" }, ...ch.pages.map((p) => h("div", { class: "row tight small" }, h("span", { class: "muted" }, p.index + "."), h("span", { class: "grow" }, p.title), h("span", { class: store.findByUid(p.docUid) ? "ok" : "muted" }, store.findByUid(p.docUid) ? "açık" : "kapalı")))) : null,
    ch ? h("button", { class: "mini quiet", onclick: () => { ch.chainContext = ""; for (const s of store.sessions.values()) if (s.state.chapterId === ch.id) s.state.chainContext = ""; save(); app.notify("Bağlam sıfırlandı.", "ok"); renderChapter(root, app); } }, "Bağlamı sıfırla") : null,
  ], O, true));
  if (ch) {
    const instr = h("textarea", { rows: 2, placeholder: "Bölüme özel çeviri talimatı" }); instr.value = ch.instruction || "";
    instr.addEventListener("change", () => { ch.instruction = instr.value; save(); });
    ch.rules = ch.rules || []; ch.base = ch.base || {};
    root.appendChild(card("c-rules", "Bölüm kuralları", `${ch.rules.length} kural · seri kurallarından önce`, [instr, ruleEditor(ch.rules, save, S.fontChecks || {})], O, false));
  }
  // Bul-değiştir (önizlemeli)
  const q = h("input", { type: "text", placeholder: "Bul", class: "grow" });
  const r = h("input", { type: "text", placeholder: "Değiştir", class: "grow" });
  let fieldName = "translation", rx = false, cs = false, matches = [];
  const out = h("div", { class: "stack" });
  const preview = async () => {
    clear(out);
    if (!q.value) { out.appendChild(hint("Aranacak metni yazın.")); return; }
    try { matches = await app.pipeline.findAll(q.value, r.value, { field: fieldName, regex: rx, caseSensitive: cs }); }
    catch (e) { out.appendChild(h("div", { class: "err small" }, e.message)); return; }
    out.appendChild(h("div", { class: "small" }, `${matches.length} eşleşme · ${matches.filter((m) => m.locked).length} kilitli (atlanır) · ${matches.filter((m) => !m.open).length} kapalı sayfada (yalnız önizleme)`));
    for (const m of matches.slice(0, 200)) out.appendChild(h("div", { class: "row tight small" + (m.locked ? " muted" : "") }, h("span", null, `${m.title} #${m.order}${m.locked ? " 🔒" : ""}: `), h("span", { class: "grow" }, `${m.before} → ${m.after}`)));
    if (matches.length) out.appendChild(h("button", { class: "btn cta", onclick: act(async () => {
      const res = await app.pipeline.applyReplacements(matches, fieldName);
      app.notify(`${res.n} öğe değişti.${res.skippedClosed ? ` ${res.skippedClosed} kapalı sayfa atlandı (sayfayı açıp tekrar uygulayın).` : ""}`, "ok"); preview();
    }) }, "Uygula"));
  };
  root.appendChild(card("c-find", "Bul-değiştir", ch ? "bölüm geneli" : "bu sayfa", [
    h("div", { class: "row" }, q), h("div", { class: "row" }, r),
    h("div", { class: "row" }, select([["translation", "Çeviride"], ["source", "Kaynakta"]], fieldName, (v) => { fieldName = v; }), checkbox(rx, (v) => { rx = v; }, "Düzenli ifade"), checkbox(cs, (v) => { cs = v; }, "Büyük/küçük harf"),
      h("button", { class: "mini", onclick: preview }, "Önizle")), out,
  ], O, false));
}

// ------------------------------------------------------------------ Temizlik sekmesi
function renderClean(root, app) {
  clear(root);
  const S = app.settings, O = openState(app);
  const p = app.pipeline.cfg();
  const save = () => app.saveSettings();
  const A = S.adobe || (S.adobe = { prompt: "" });
  const ffOk = !!(S.firefly.proxyUrl && S.cleanup.verified && S.cleanup.verified.firefly);
  const act = (fn) => async () => { try { await fn(); } catch (e) { app.notify(e.message, "error"); } };
  const sfxNow = app.pipeline.sfxMethod();
  const genLine = app.pipeline._adobeFail
    ? `Üretken Dolgu bu oturumda çalışmadı (${app.pipeline._adobeFail}) → SFX'ler İçerik Duyarlı Dolgu ile temizleniyor.`
    : A.last && A.last.ok ? `Üretken Dolgu panelden çalışıyor (son: ${A.last.at.slice(0, 16).replace("T", " ")}).`
      : "Üretken Dolgu ilk çizim üstü SFX'te otomatik denenir; çalışmazsa İçerik Duyarlı Dolgu, o da olmazsa Torii.";
  const mainOpts = [["auto", "Otomatik (önerilen)"], ["flat", METHODS.flat.label], ["torii", METHODS.torii.label + (app.hasKey ? "" : " — anahtar gerekli")], ["contentAware", METHODS.contentAware.label]];
  if (ffOk) mainOpts.push(["firefly", METHODS.firefly.label]);
  root.appendChild(card("k-method", "Temizlik yöntemi", "tamamen otomatik", [
    field("Balon ve metin", select(mainOpts, p.cleanup.method || "auto", (v) => { p.cleanup.method = v; save(); })),
    hint("Otomatik: düz balon → yerel dolgu (kredisiz, balon içindeki tüm parçalar); tramlı/renkli zemin → Torii Inpaint."),
    field("SFX (çizim üstü)", select([["auto", "Otomatik: Üretken Dolgu → İçerik Duyarlı → Torii"], ["contentAware", METHODS.contentAware.label], ["torii", METHODS.torii.label + " (bulanık olabilir)"]], p.cleanup.sfxMethod === "adobeGenerative" ? "auto" : p.cleanup.sfxMethod || "auto", (v) => { p.cleanup.sfxMethod = v; save(); renderClean(root, app); })),
    h("div", { class: "notice" + (app.pipeline._adobeFail ? " warn" : "") }, `Şu an: ${METHODS[sfxNow].label}. ${genLine}`),
    field("Maske genişletme", numberInput(p.cleanup.dilatePx, (x) => { p.cleanup.dilatePx = x || 0; save(); }, { min: 0, max: 40 }), h("span", { class: "small muted" }, "px")),
  ], O, true));

  const L = app.pipeline.lastInpainted, doc = app.store.active;
  root.appendChild(card("k-run", "Temizle", "sonuç ayrı katmanda", [
    hint("Sonuç ayrı katmana, yalnızca maske içine yazılır; maske dışı pikseller değişmez. Her işlem tek geçmiş adımıdır (Ctrl+Z)."),
    h("div", { class: "row" },
      h("button", { class: "btn", onclick: act(() => app.pipeline.clean(app.scope(), { force: true })) }, "Kapsamı temizle"),
      h("button", { class: "btn", title: "Photoshop'taki seçimi maskeye ekleyerek temizler", onclick: act(() => app.pipeline.clean("region", { force: true, useSelectionMask: true, selectionOnly: false })) }, "Seçimle düzelt"),
      L && doc && L.docUid === doc.state.docUid ? h("button", { class: "btn", title: "Bu oturumdaki son tek-istek Tam İşlem'in temizlenmiş görselini tekrar uygular", onclick: act(() => app.pipeline.reapplyLastInpaint()) }, "Yeniden uygula (kredisiz)") : null),
  ], O, true));

  root.appendChild(card("k-remove", "Nesne kaldır", "Photoshop seçimiyle", [
    hint("Photoshop'ta kaldırılacak alanı seçin; seçili alan otomatik temizlenir."),
    h("div", { class: "row" },
      h("button", { class: "mini", onclick: act(() => app.pipeline.clean("region", { objectRemoval: true, useSelectionMask: true, selectionOnly: true, force: true, method: "contentAware" })) }, "İçerik Duyarlı"),
      h("button", { class: "mini", onclick: act(() => app.pipeline.clean("region", { objectRemoval: true, useSelectionMask: true, selectionOnly: true, force: true, method: "torii" })) }, "Torii Inpaint (0,02 kr)"),
      h("button", { class: "mini", onclick: act(() => app.pipeline.clean("region", { objectRemoval: true, useSelectionMask: true, selectionOnly: true, force: true, method: "adobeGenerative", prompt: A.prompt })) }, "Üretken Dolgu")),
  ], O, false));

  const promptIn = h("input", { type: "text", class: "grow", placeholder: "Boş = yazıyı sil, zemini tamamla" }); promptIn.value = A.prompt || "";
  promptIn.addEventListener("change", () => { A.prompt = promptIn.value; save(); });
  root.appendChild(card("k-adv", "Gelişmiş", A.prompt ? "özel istem" : "", [
    field("Üretken Dolgu istemi", promptIn),
    hint("Boş bırakılırsa Üretken Dolgu yazıyı siler ve zemini tamamlar (önerilen)."),
    ffOk ? hint("Firefly Services vekili doğrulandı: yöntem listesinde seçilebilir.") : hint("Firefly Services: kurulum gerekli (Ayarlar › Gelişmiş)."),
  ], O, false));
}

// ------------------------------------------------------------------ Ayarlar sekmesi
function renderSettings(root, app) {
  const scroll = root.scrollTop;
  clear(root);
  const S = app.settings, T = S.torii, O = openState(app);
  const save = () => app.saveSettings();
  const key = h("input", { type: "password", class: "grow", placeholder: app.hasKey ? "•••••••• (kayıtlı)" : "sk_torii_…", "aria-label": "Torii API anahtarı" });
  const out = h("div", { class: "small muted" });
  const act = (fn) => async () => { try { await fn(); } catch (e) { out.textContent = e.message; out.className = "small err"; app.notify(e.message, "error"); } };
  root.appendChild(card("s-torii", "Torii API", app.hasKey ? (app.client.lastCredits != null ? app.client.lastCredits + " kredi" : "anahtar kayıtlı") : "anahtar gerekli", [
    field("API anahtarı", key),
    hint("Anahtar UXP Secure Storage'da şifreli saklanır; profillere, dışa aktarımlara ve loglara yazılmaz."),
    h("div", { class: "row" },
      h("button", { class: "btn cta", onclick: act(async () => { const v = key.value.trim(); if (!v) throw new Error("Anahtarı yapıştırın."); if (/…|\.\.\./.test(v)) throw new Error("Bu anahtar kısaltılmış (…) görünüyor. Torii panelinden TAM anahtarı kopyalayın."); await storage.setSecret("torii_api_key", v); key.value = ""; app.hasKey = true; key.placeholder = "•••••••• (kayıtlı)"; const c = await app.client.credits(); out.textContent = `Kaydedildi ve doğrulandı. Kalan kredi: ${c}`; out.className = "small ok"; }) }, "Kaydet"),
      h("button", { class: "btn", onclick: act(async () => { out.textContent = "Test ediliyor…"; out.className = "small muted"; const c = await app.client.credits(); const k = await app.client.keys().catch(() => null); const cur = k && k.keys ? k.keys.find((x) => x.current) : null; out.textContent = `Bağlantı tamam. Kalan kredi: ${c}${cur ? " · anahtar: " + (cur.name || cur.display_key) : ""}`; out.className = "small ok"; }) }, "Bağlantıyı test et"),
      app.hasKey ? h("button", { class: "btn quiet danger", onclick: act(async () => { const ok = await dialogs.confirm("Anahtarı sil", "Torii API anahtarı bu bilgisayardan silinsin mi?", ["Sil", "Vazgeç"]); if (ok !== 0) return; await storage.setSecret("torii_api_key", ""); app.hasKey = false; app.client.lastCredits = null; app.renderCredits(); renderSettings(root, app); app.notify("Anahtar silindi.", "ok"); }) }, "Anahtarı sil") : null),
    out,
  ], O, true));

  for (const c of translationCards(app, O, save)) root.appendChild(c);
  root.appendChild(card("s-run", "Tam İşlem", S.ui.fullMode === "single" ? "tek istek" : "modüler (ucuz)", [
    field("Mod", select([["modular", "Modüler: OCR → çeviri → temizlik (önerilen)"], ["single", "Tek istek: Torii görsel çeviri"]], S.ui.fullMode === "single" ? "single" : "modular", (v) => { S.ui.fullMode = v; save(); app.renderModeLine(); renderSettings(root, app); })),
    hint(S.ui.fullMode === "single"
      ? "Tek istek: Torii sayfayı kendisi temizler ve çevirir. Ölçülen maliyet 800×10000 sayfada 6–8,4 kredi."
      : "Modüler: OCR 1 + çeviri ≥1 + çizim üstü inpaint 0,02 kredi. Balonlar kredisiz yerel dolguyla temizlenir. Çalıştırma sonunda harcanan kredi gösterilir."),
  ], O, true));

  // ---- Gelişmiş ----
  const adv = [];
  const byokKey = h("input", { type: "password", class: "grow", placeholder: "Sağlayıcı anahtarı" });
  adv.push(h("div", { class: "group-label" }, "KENDİ MODEL ANAHTARIN (BYOK)"),
    field("Sağlayıcı", select([["", "Yok (Torii kredisi)"]].concat(BYOK_PROVIDERS.map((p) => [p, p === "google" ? "Google Gemini" : p])), T.byokProvider || "", (v) => { T.byokProvider = v; save(); renderSettings(root, app); })),
    T.byokProvider ? field("Anahtar", byokKey, h("button", { class: "mini", onclick: act(async () => { if (!byokKey.value.trim()) throw new Error("Önce sağlayıcı anahtarını yapıştırın."); await storage.setSecret("byok_" + T.byokProvider, byokKey.value.trim()); byokKey.value = ""; out.textContent = "BYOK anahtarı kaydedildi (Secure Storage)."; out.className = "small ok"; }) }, "Kaydet")) : null,
    T.byokProvider ? checkbox(T.byokFallback !== false, (v) => { T.byokFallback = v; save(); }, "Kendi anahtarım başarısız olursa Torii modeline geç") : null);

  const ffUrl = h("input", { type: "text", class: "grow", placeholder: "http://127.0.0.1:8787" }); ffUrl.value = S.firefly.proxyUrl || "";
  const ffOut = h("div", { class: "small muted" }, S.firefly.proxyUrl ? (S.cleanup.verified.firefly ? "Vekil doğrulandı." : "Doğrulanmadı.") : "Firefly Services: kurulum gerekli (server/firefly-proxy.mjs, README).");
  adv.push(h("div", { class: "group-label" }, "FIREFLY SERVICES (SUNUCU)"), ffOut,
    field("Vekil URL", ffUrl, h("button", { class: "mini", onclick: act(async () => { S.firefly.proxyUrl = ffUrl.value.trim(); const r = await app.firefly.health(); S.cleanup.verified.firefly = !!r.ok; app.pipeline.firefly = r.ok ? app.firefly : null; save(); ffOut.textContent = r.ok ? "Vekil doğrulandı: " + r.models.join(", ") : "Doğrulanamadı: " + r.reason; ffOut.className = r.ok ? "small ok" : "small err"; }) }, "Test")));

  // Photoshop Eylemleri
  const sets = app.ops.listActions();
  let setName = sets[0] ? sets[0].name : "", actName = sets[0] && sets[0].actions[0] ? sets[0].actions[0] : "";
  const actSel = h("select", { class: "grow" });
  const fillActs = () => { clear(actSel); const s = sets.find((x) => x.name === setName); for (const a of (s ? s.actions : [])) actSel.appendChild(h("option", { value: a }, a)); actSel.value = actName = s && s.actions[0] ? s.actions[0] : ""; };
  actSel.addEventListener("change", () => { actName = actSel.value; });
  const setSel = select(sets.map((s) => [s.name, s.name]), setName, (v) => { setName = v; fillActs(); }, { class: "grow" });
  fillActs();
  adv.push(h("div", { class: "group-label" }, "PHOTOSHOP EYLEMLERİ"),
    sets.length ? h("div", { class: "row" }, setSel, actSel, h("button", { class: "mini", onclick: act(async () => { await app.ops.playAction(setName, actName); app.notify("Eylem çalıştı: " + actName, "ok"); }) }, "Çalıştır")) : hint("Eylem bulunamadı."));

  const tools = [["move", "Taşıma"], ["type", "Metin"], ["lasso", "Kement"], ["marquee", "Dikdörtgen seçim"], ["heal", "Nokta düzeltme"]];
  adv.push(h("div", { class: "group-label" }, "ARAÇLAR VE KATMAN EŞLEME"),
    h("div", { class: "row" }, ...tools.map(([k, l]) => h("button", { class: "mini", onclick: act(async () => { const ok = await app.ops.nativeTool(k); app.notify(ok ? l + " aracı etkin." : l + " seçilemedi.", ok ? "info" : "warn"); }) }, l))),
    h("div", { class: "row" },
      h("button", { class: "mini", onclick: act(async () => { const it = await app.ops.itemFromActiveLayer(); app.store.select([it.id]); app.showTab("items"); app.notify("Katmandan öğe oluşturuldu: #" + it.order, "ok"); }) }, "Seçili metin katmanından öğe"),
      h("button", { class: "mini", onclick: act(async () => { const n = await app.ops.syncContentFromPs(); app.notify(`Photoshop'tan eşitlendi (${n} değişiklik).`, "ok"); }) }, "Photoshop'tan eşitle")));

  const pre = h("div", { class: "log" }, logBuffer.slice(-200).map((l) => `${l.t} ${l.level.toUpperCase()} ${l.msg}${l.data ? " " + l.data : ""}`).join("\n") || "Log boş.");
  adv.push(h("div", { class: "group-label" }, "LOG"),
    h("div", { class: "row" },
      h("button", { class: "mini", onclick: () => renderSettings(root, app) }, "Yenile"),
      h("button", { class: "mini", onclick: async () => { try { await navigator.clipboard.setContent({ "text/plain": redact(pre.textContent) }); app.notify("Log kopyalandı (anahtarlar gizli).", "ok"); } catch (e) { app.notify("Panoya kopyalanamadı.", "warn"); } } }, "Kopyala (anahtarlar gizli)")),
    pre);

  // Geliştirici: yalnızca src/dev mevcutsa (UDT ile yüklenen geliştirme kopyası; .ccx paketinde yoktur)
  let dev = null;
  try { dev = require("../dev/selftest"); } catch (e) { dev = null; }
  if (dev) {
    adv.push(h("div", { class: "group-label" }, "GELİŞTİRİCİ (pakette yok)"),
      h("button", { class: "mini", onclick: act(async () => {
        const ok = await dialogs.confirm("Canlı kabul testi", `GERÇEK Torii kredisi harcanır (yaklaşık OCR 2 + çeviri ≥1 + inpaint 0,02). Etkin belge: <b>${esc(app.store.active ? app.store.active.title : "—")}</b>.`, ["Başlat", "İptal"]);
        if (ok !== 0) return;
        const rep = await dev.runLive(app, {});
        await dialogs.show("Canlı test sonucu", h("div", { class: "log" }, rep.steps.map((s) => `${s.status} ${s.name} (${s.ms} ms)${s.error ? " — " + s.error : ""}`).join("\n")), ["Kapat"], { width: 620, height: 460 });
      }) }, "Canlı kabul testi (kredi harcar)"));
  }
  root.appendChild(card("s-adv", "Gelişmiş", "BYOK · Firefly · Eylemler · Log", adv, O, false));
  root.scrollTop = scroll;
}

module.exports = { renderChapter, renderClean, renderSettings };
