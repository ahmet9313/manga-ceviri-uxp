// Profil (kurallar, sözlük, karakterler), Bölüm (sayfalar, bul-değiştir), Temizlik, Araçlar, Ayarlar, Log sekmeleri.
"use strict";
const { h, clear, select, numberInput, textInput, checkbox, colorInput, esc } = require("./dom");
const { fontPicker } = require("./fontpicker");
const { ITEM_TYPES, TONES, STYLE_FIELDS, CONDITION_FIELDS, OPERATORS } = require("../model/rules");
const profiles = require("../model/profiles");
const storage = require("../model/storage");
const { METHODS } = require("../model/cleanup");
const { TRANSLATORS, BYOK_PROVIDERS } = require("../torii/client");
const { uid, logBuffer, redact } = require("../util/common");
const dialogs = require("./dialogs");

// ------------------------------------------------------------------ Kural editörü (kod yazmadan)
function ruleEditor(rules, onChange, checks) {
  const wrap = h("div", { class: "stack" });
  const draw = () => {
    clear(wrap);
    rules.sort((a, b) => (b.priority || 0) - (a.priority || 0));
    rules.forEach((r) => {
      const open = r._open;
      const summary = `${r.enabled === false ? "⏸ " : ""}${r.name} · öncelik ${r.priority || 0} · ${(r.types || []).length ? r.types.join("/") : "tüm türler"}${(r.tones || []).length ? " · " + r.tones.join("/") : ""} → ${Object.keys(r.style || {}).join(", ") || "(stil yok)"}`;
      const sec = h("div", { class: "section" },
        h("div", { class: "row" },
          h("button", { class: "mini", onclick: () => { r._open = !open; draw(); } }, open ? "▾" : "▸"),
          h("span", { class: "grow" }, summary),
          h("button", { class: "mini", title: "Çoğalt", onclick: () => { const c = JSON.parse(JSON.stringify(r)); c.id = uid("r_"); c.name += " (kopya)"; rules.push(c); onChange(); draw(); } }, "⧉"),
          h("button", { class: "mini", title: "Sil", onclick: () => { rules.splice(rules.indexOf(r), 1); onChange(); draw(); } }, "✕")));
      if (open) {
        const commit = () => { onChange(); };
        sec.appendChild(h("div", { class: "field" }, h("label", null, "Ad"), textInput(r.name, (v) => { r.name = v; commit(); })));
        sec.appendChild(h("div", { class: "field" }, h("label", null, "Öncelik"), numberInput(r.priority || 0, (v) => { r.priority = v || 0; commit(); draw(); }), checkbox(r.enabled !== false, (v) => { r.enabled = v; commit(); }, "Etkin")));
        sec.appendChild(h("div", { class: "field" }, h("label", null, "Öğe türü"),
          ...ITEM_TYPES.map((t) => checkbox((r.types || []).includes(t.id), (v) => { r.types = (r.types || []).filter((x) => x !== t.id); if (v) r.types.push(t.id); commit(); }, t.label))));
        sec.appendChild(h("div", { class: "field" }, h("label", null, "Ton"),
          ...TONES.map((t) => checkbox((r.tones || []).includes(t.id), (v) => { r.tones = (r.tones || []).filter((x) => x !== t.id); if (v) r.tones.push(t.id); commit(); }, t.label))));
        sec.appendChild(h("div", { class: "field" }, h("label", null, "Koşul eşleşmesi"), select([["all", "Tümü sağlanmalı"], ["any", "Herhangi biri"]], r.match || "all", (v) => { r.match = v; commit(); })));
        (r.conditions || []).forEach((c, ci) => {
          sec.appendChild(h("div", { class: "row wrap" },
            select(CONDITION_FIELDS.map((f) => [f.key, f.label]), c.field, (v) => { c.field = v; commit(); }),
            select(OPERATORS, c.op, (v) => { c.op = v; commit(); }),
            textInput(c.value == null ? "" : c.value, (v) => { c.value = v; commit(); }, { style: { width: "90px" } }),
            h("button", { class: "mini", onclick: () => { r.conditions.splice(ci, 1); commit(); draw(); } }, "✕")));
        });
        sec.appendChild(h("button", { class: "mini", onclick: () => { r.conditions = r.conditions || []; r.conditions.push({ field: "source", op: "contains", value: "" }); commit(); draw(); } }, "+ Koşul"));
        sec.appendChild(h("div", { class: "small muted" }, "Uygulanacak stil (işaretli alanlar):"));
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
          sec.appendChild(h("div", { class: "field" },
            h("label", null, checkbox(has, (on) => { r.style = r.style || {}; if (on) r.style[f.key] = f.type === "bool" ? true : f.type === "number" ? (f.min || 0) : f.type === "color" ? "#000000" : f.type === "select" ? f.options[0][0] : ""; else delete r.style[f.key]; commit(); draw(); }), " " + f.label),
            ctl));
        }
      }
      wrap.appendChild(sec);
    });
    wrap.appendChild(h("button", { class: "mini", onclick: () => { rules.push({ id: uid("r_"), name: "Yeni kural", enabled: true, priority: 10, types: [], tones: [], match: "all", conditions: [], style: {}, _open: true }); onChange(); draw(); } }, "+ Kural ekle"));
  };
  draw();
  return wrap;
}

function baseStyleEditor(base, onChange, checks) {
  const sec = h("div");
  for (const f of STYLE_FIELDS) {
    const v = base[f.key];
    const set = (val) => { if (val === null || val === "") delete base[f.key]; else base[f.key] = val; onChange(); };
    let ctl;
    if (f.type === "font") ctl = fontPicker(v, set, checks, { allowEmpty: true, noPreview: f.key !== "font" });
    else if (f.type === "number") ctl = numberInput(v, set, { min: f.min, max: f.max });
    else if (f.type === "bool") ctl = select([["", "—"], ["true", "Evet"], ["false", "Hayır"]], v == null ? "" : String(v), (x) => set(x === "" ? null : x === "true"));
    else if (f.type === "color") ctl = colorInput(v, set);
    else if (f.type === "select") ctl = select([["", "—"]].concat(f.options), v || "", (x) => set(x || null));
    sec.appendChild(h("div", { class: "field" }, h("label", null, f.label), ctl));
  }
  return sec;
}

function listEditor(rows, cols, onChange) {
  const wrap = h("div", { class: "stack" });
  const draw = () => {
    clear(wrap);
    rows.forEach((r, i) => wrap.appendChild(h("div", { class: "row wrap" },
      ...cols.map((c) => textInput(r[c.key] || "", (v) => { r[c.key] = v; onChange(); }, { placeholder: c.label, style: { width: c.w || "90px" } })),
      h("button", { class: "mini", onclick: () => { rows.splice(i, 1); onChange(); draw(); } }, "✕"))));
    wrap.appendChild(h("button", { class: "mini", onclick: () => { rows.push({}); onChange(); draw(); } }, "+ Ekle"));
  };
  draw();
  return wrap;
}

// ------------------------------------------------------------------ Profil sekmesi
function renderProfile(root, app) {
  clear(root);
  const S = app.settings;
  const p = app.pipeline.profile(app.store.active && app.store.active.state);
  const save = () => app.saveSettings();
  const checks = S.fontChecks || (S.fontChecks = {});
  root.appendChild(h("div", { class: "section" }, h("h4", null, "Seri profili"),
    h("div", { class: "row wrap" },
      select(S.profiles.map((x) => [x.id, x.name]), p.id, (v) => { app.setProfile(v); }),
      h("button", { class: "mini", onclick: () => { const n = profiles.defaultProfile("Yeni seri"); S.profiles.push(n); app.setProfile(n.id); } }, "Yeni"),
      h("button", { class: "mini", onclick: () => { const c = profiles.copyProfile(p); S.profiles.push(c); app.setProfile(c.id); } }, "Kopyala"),
      h("button", { class: "mini", onclick: async () => { if (S.profiles.length < 2) return app.notify("Son profil silinemez.", "warn"); const ok = await dialogs.confirm("Profili sil", `"${esc(p.name)}" silinsin mi?`, ["Sil", "Vazgeç"]); if (ok === 0) { S.profiles = S.profiles.filter((x) => x.id !== p.id); app.setProfile(S.profiles[0].id); } } }, "Sil"),
      h("button", { class: "mini", onclick: async () => { const f = await storage.pickSaveFile(p.name.replace(/[^\w\-ğüşıöçĞÜŞİÖÇ ]/g, "_") + ".mcsprofil.json", ["json"]); if (f) { await f.write(JSON.stringify(profiles.exportProfile(p), null, 1)); app.notify("Profil dışa aktarıldı (anahtar içermez).", "ok"); } } }, "Dışa aktar"),
      h("button", { class: "mini", onclick: async () => { const f = await storage.pickOpenFile(["json"]); if (!f) return; try { const np = profiles.importProfile(await f.read()); S.profiles.push(np); app.setProfile(np.id); app.notify("Profil içe aktarıldı: " + np.name, "ok"); } catch (e) { app.notify(e.message, "error"); } } }, "İçe aktar")),
    h("div", { class: "field" }, h("label", null, "Ad"), textInput(p.name, (v) => { p.name = v; save(); app.renderHeader(); })),
    h("div", { class: "field" }, h("label", null, "Kaynak dil"), select([["auto", "Otomatik algıla (tüm diller)"]].concat(profiles.LANGS.filter((l) => l[0] !== "tr")), p.sourceLang || "auto", (v) => { p.sourceLang = v; save(); })),
    h("div", { class: "field-hint", style: { margin: "-4px 0 8px 110px" } }, "Seçilirse yalnızca bu dildeki yazılar çevrilip silinir; diğer dillerdeki yazılar (ör. arka plandaki Korece) olduğu gibi kalır."),
    h("div", { class: "field" }, h("label", null, "Hedef dil"), select(profiles.LANGS, p.targetLang || "tr", (v) => { p.targetLang = v; save(); })),
    h("div", { class: "field" }, h("label", null, "Okuma yönü"), select([["ltr", "Soldan sağa (webtoon/manhwa)"], ["rtl", "Sağdan sola (manga)"]], p.readingDir, (v) => { p.readingDir = v; save(); })),
    h("div", { class: "field" }, h("label", null, "Çeviri modeli"), select(TRANSLATORS.map((t) => [t.id, t.label]), p.translator, (v) => { p.translator = v; save(); })),
    h("div", { class: "field" }, h("label", null, "Düşünme"), select([["none", "Yok"], ["low", "Düşük"], ["medium", "Orta"], ["high", "Yüksek"]], p.reasoning || "none", (v) => { p.reasoning = v; save(); }))));

  const instr = h("textarea", { rows: 3, placeholder: "Çeviri talimatı (ton, üslup, isim kuralları)…" }); instr.value = p.instruction || "";
  instr.addEventListener("change", () => { p.instruction = instr.value; save(); });
  const hon = h("textarea", { rows: 2, placeholder: "Hitap biçimi (ör. -san → Bey/Hanım, senpai → abi/abla)" }); hon.value = p.honorifics || "";
  hon.addEventListener("change", () => { p.honorifics = hon.value; save(); });
  root.appendChild(h("div", { class: "section" }, h("h4", null, "Çeviri bağlamı (Torii custom_prompt + context)"),
    instr, hon,
    h("div", { class: "small muted" }, "Seri sözlüğü (kaynak → hedef):"), listEditor(p.glossary, [{ key: "src", label: "Kaynak" }, { key: "tgt", label: "Hedef" }, { key: "note", label: "Not" }], save),
    h("div", { class: "small muted" }, "Karakter adları:"), listEditor(p.characters, [{ key: "name", label: "Ad" }, { key: "tr", label: "Türkçe yazımı" }, { key: "note", label: "Not (cinsiyet, hitap)" }], save)));

  root.appendChild(h("div", { class: "section" }, h("h4", null, "Seri taban stili"), baseStyleEditor(p.base, save, checks)));
  root.appendChild(h("div", { class: "section" }, h("h4", null, "Seri kuralları (koşul + stil)"),
    h("div", { class: "small muted" }, "Aynı öğeye birden çok kural uyarsa en yüksek öncelikli eşleşme kazanır (alan bazında)."),
    h("button", { class: "mini", onclick: () => { p.rules.push(...profiles.exampleRules()); save(); renderProfile(root, app); } }, "Örnek kural seti ekle (normal/bağırma/fısıltı/düşünce/SFX)"),
    ruleEditor(p.rules, save, checks)));

  const tk = p.turkish || (p.turkish = { enabled: true });
  let testFont = p.base.font || "ArialMT";
  const testOut = h("div", { class: "small" });
  root.appendChild(h("div", { class: "section" }, h("h4", null, "Türkçe düzeltme ve glif testi"),
    checkbox(tk.enabled, (v) => { tk.enabled = v; save(); }, "Türkçe düzeltme profili"),
    checkbox(tk.circumflexToPlain, (v) => { tk.circumflexToPlain = v; save(); }, "â/Â → a/A (diğer Türkçe harfler korunur)"),
    checkbox(tk.smartPunct, (v) => { tk.smartPunct = v; save(); }, "Akıllı noktalama (… ve boşluk düzeltme)"),
    h("div", { class: "row wrap" }, fontPicker(testFont, (v) => { testFont = v; }, checks),
      h("button", { class: "mini", onclick: async () => {
        try {
          testOut.textContent = "Test ediliyor…";
          const r = await require("../ps/fontcheck").checkFont(testFont);
          checks[testFont] = r; save();
          testOut.className = r.missing.length ? "small warn" : "small ok";
          testOut.textContent = r.missing.length ? `Eksik glif: ${r.missing.join(" ")} — dizgide yedek font uygulanır.` : `ÇĞİÖŞÜ çğıöşü tamam.${r.missingCircumflex.length ? " (â/Â eksik → â→a seçeneğini açın)" : ""}`;
        } catch (e) { testOut.textContent = e.message; testOut.className = "small err"; }
      } }, "Glif testi")),
    testOut));

  root.appendChild(h("div", { class: "section" }, h("h4", null, "Genel kurallar (tüm seriler)"), ruleEditor(S.global.rules, save, checks),
    h("div", { class: "small muted" }, "Genel taban stili:"), baseStyleEditor(S.global.base, save, checks)));
}

// ------------------------------------------------------------------ Bölüm sekmesi
function renderChapter(root, app) {
  clear(root);
  const S = app.settings, store = app.store;
  const sess = store.active;
  const ch = sess && sess.state.chapterId ? S.chapters.find((c) => c.id === sess.state.chapterId) : null;
  const save = () => app.saveSettings();
  root.appendChild(h("div", { class: "section" }, h("h4", null, "Bölüm"),
    h("div", { class: "row wrap" },
      select([["", "(bölüm yok)"]].concat(S.chapters.map((c) => [c.id, c.name])), ch ? ch.id : "", (v) => app.assignChapter(v || null)),
      h("button", { class: "mini", onclick: () => app.chapterFromOpenDocs() }, "Açık belgelerden bölüm oluştur"),
      h("button", { class: "mini", onclick: () => app.chapterFromFolder() }, "Klasörden bölüm oluştur")),
    ch ? h("div", null,
      h("div", { class: "field" }, h("label", null, "Bölüm adı"), textInput(ch.name, (v) => { ch.name = v; save(); })),
      h("div", { class: "small muted" }, `${ch.pages.length} sayfa · bağlam zinciri ${ch.chainContext ? ch.chainContext.length + " karakter" : "boş"}`),
      h("button", { class: "mini", onclick: () => { ch.chainContext = ""; for (const s of store.sessions.values()) if (s.state.chapterId === ch.id) s.state.chainContext = ""; save(); app.notify("Bağlam sıfırlandı.", "ok"); renderChapter(root, app); } }, "Bağlamı sıfırla"),
      h("div", null, ...ch.pages.map((p) => h("div", { class: "row small" }, h("span", { class: "muted" }, p.index + "."), h("span", { class: "grow" }, p.title), h("span", { class: "muted" }, store.findByUid(p.docUid) ? "açık" : "kapalı"))))) : null));
  if (ch) {
    const instr = h("textarea", { rows: 2, placeholder: "Bölüme özel çeviri talimatı" }); instr.value = ch.instruction || "";
    instr.addEventListener("change", () => { ch.instruction = instr.value; save(); });
    ch.rules = ch.rules || []; ch.base = ch.base || {};
    root.appendChild(h("div", { class: "section" }, h("h4", null, "Bölüm kuralları (seri kurallarından önce gelir)"), instr, ruleEditor(ch.rules, save, S.fontChecks || {})));
  }
  // Bul-değiştir
  const q = h("input", { type: "text", placeholder: "Bul", class: "grow" });
  const r = h("input", { type: "text", placeholder: "Değiştir", class: "grow" });
  let field = "translation", rx = false, cs = false, matches = [];
  const out = h("div");
  const preview = async () => {
    clear(out);
    if (!q.value) return;
    try { matches = await app.pipeline.findAll(q.value, r.value, { field, regex: rx, caseSensitive: cs }); }
    catch (e) { out.appendChild(h("div", { class: "err" }, e.message)); return; }
    out.appendChild(h("div", { class: "small" }, `${matches.length} eşleşme · ${matches.filter((m) => m.locked).length} kilitli (atlanır) · ${matches.filter((m) => !m.open).length} kapalı sayfada (yalnız önizleme)`));
    for (const m of matches.slice(0, 200)) out.appendChild(h("div", { class: "row small" + (m.locked ? " muted" : "") }, h("span", null, `${m.title} #${m.order}${m.locked ? " 🔒" : ""}: `), h("span", { class: "grow" }, `${m.before} → ${m.after}`)));
    if (matches.length) out.appendChild(h("button", { class: "btn cta", onclick: async () => {
      try { const res = await app.pipeline.applyReplacements(matches, field); app.notify(`${res.n} öğe değişti.${res.skippedClosed ? ` ${res.skippedClosed} kapalı sayfa atlandı (sayfayı açıp tekrar uygulayın).` : ""}`, "ok"); preview(); }
      catch (e) { app.notify(e.message, "error"); }
    } }, "Uygula"));
  };
  root.appendChild(h("div", { class: "section" }, h("h4", null, "Bul-değiştir (bölüm geneli, önizlemeli)"),
    h("div", { class: "row" }, q), h("div", { class: "row" }, r),
    h("div", { class: "row wrap" }, select([["translation", "Çeviride"], ["source", "Kaynakta"]], field, (v) => { field = v; }), checkbox(rx, (v) => { rx = v; }, "Düzenli ifade"), checkbox(cs, (v) => { cs = v; }, "Büyük/küçük harf"),
      h("button", { class: "mini", onclick: preview }, "Önizle")), out));
}

// ------------------------------------------------------------------ Temizlik sekmesi
function renderClean(root, app) {
  clear(root);
  const S = app.settings;
  const p = app.pipeline.profile(app.store.active && app.store.active.state);
  const save = () => app.saveSettings();
  const v = S.cleanup.verified || (S.cleanup.verified = {});
  const ffOk = !!(S.firefly.proxyUrl && v.firefly);
  const A = S.adobe || (S.adobe = { model: "firefly", templates: [], prompt: "" });
  const act = (fn) => async () => { try { await fn(); } catch (e) { app.notify(e.message, "error"); } };
  const genState = A.directFailed ? `bu Photoshop'ta çalışmadı → otomatik İçerik Duyarlı` : A.directVerified ? "otomatik (çalışıyor)" : "otomatik denenir, olmazsa İçerik Duyarlı";
  const status = {
    auto: "önerilen", torii: app.hasKey ? "otomatik" : "API anahtarı gerekli", flat: "otomatik, kredisiz", contentAware: "otomatik, kredisiz",
    adobeRemove: "eklenti komutu yok → otomatik İçerik Duyarlı", adobeGenerative: genState, firefly: ffOk ? "sunucu" : "vekil sunucu gerekli",
  };
  const opts = Object.keys(METHODS).map((k) => [k, `${METHODS[k].label} — ${status[k]}`]);
  const methodSel = select(opts, p.cleanup.method || "auto", (val) => {
    if (val === "firefly" && !ffOk) { app.notify("Firefly Services için önce Ayarlar'da vekil sunucuyu kurup test edin.", "warn"); methodSel.value = p.cleanup.method || "auto"; return; }
    p.cleanup.method = val; save(); renderClean(root, app);
  });
  root.appendChild(h("div", { class: "section" }, h("h4", null, "Temizlik yöntemi (tamamen otomatik)"),
    h("div", { class: "field" }, h("label", null, "Balonlar ve metin"), methodSel),
    h("div", { class: "small muted", style: { marginBottom: "8px" } }, "Otomatik: düz balon → yerel dolgu; tramlı/renkli zemin → Torii Inpaint. Hiçbir adımda sizden işlem istenmez; bir yöntem çalışmazsa otomatik yedeğe geçilir."),
    h("div", { class: "field" }, h("label", null, "SFX (çizim üstü)"),
      select([["auto", `Otomatik — şu an: ${METHODS[app.pipeline.sfxMethod()].label}`], ["adobeGenerative", `${METHODS.adobeGenerative.label} — ${genState}`], ["contentAware", METHODS.contentAware.label], ["torii", METHODS.torii.label + " (bulanık olabilir)"]],
        p.cleanup.sfxMethod || "auto", (val) => { p.cleanup.sfxMethod = val; save(); renderClean(root, app); })),
    h("div", { class: "small muted", style: { marginBottom: "8px" } }, "Torii çizim üstündeki SFX'i silmeyebilir ya da bulanıklaştırabilir. Otomatik: Adobe Üretken Dolgu denenir; çalışmazsa aynı öğe anında İçerik Duyarlı Dolgu ile temizlenir. Maske, SFX harflerinin tam şeklidir."),
    h("div", { class: "field" }, h("label", null, "Maske genişletme px"), numberInput(p.cleanup.dilatePx, (x) => { p.cleanup.dilatePx = x || 0; save(); }, { min: 0, max: 40 }))));
  const promptIn = h("input", { type: "text", class: "grow", placeholder: "Üretken Dolgu istemi (boş = yazıyı sil, zemini tamamla)", value: A.prompt || "" });
  promptIn.addEventListener("change", () => { A.prompt = promptIn.value; save(); });
  root.appendChild(h("div", { class: "section" }, h("h4", null, "Adobe Üretken Dolgu"),
    h("div", { class: A.directFailed ? "notice warn" : A.directVerified ? "notice" : "small muted", style: { marginBottom: "8px" } },
      A.directFailed ? `Bu Photoshop'ta panelden çalışmadı (${A.directFailReason || "bilinmiyor"}). SFX'ler otomatik olarak İçerik Duyarlı Dolgu ile temizleniyor.`
        : A.directVerified ? "✓ Panelden otomatik çalışıyor (Firefly)." : "İlk SFX'te otomatik denenecek; çalışmazsa otomatik yedeğe geçilir. Adobe üretken kredisi harcanabilir."),
    h("div", { class: "field" }, h("label", null, "İstem"), promptIn),
    h("div", { class: "row" },
      h("button", { class: "btn", onclick: act(() => app.pipeline.clean("selected", { method: "adobeGenerative", force: true, prompt: A.prompt })) }, "Seçili öğeleri Üretken Dolgu ile temizle"),
      A.directFailed ? h("button", { class: "btn quiet", title: "Photoshop güncellendiyse veya oturum açtıysanız tekrar denensin", onclick: () => { A.directFailed = false; A.directFailReason = ""; save(); renderClean(root, app); } }, "Adobe'yi tekrar denemeye aç") : null)));
  root.appendChild(h("div", { class: "section" }, h("h4", null, "Temizle"),
    h("div", { class: "small muted" }, "Sonuç ayrı katmana, yalnızca maske içine yazılır; maske dışı pikseller değişmez."),
    h("div", { class: "row wrap" },
      h("button", { class: "btn", onclick: act(() => app.pipeline.clean(app.scope(), { force: true })) }, "Kapsamı temizle"),
      h("button", { class: "btn", title: "Photoshop'taki seçimi maskeye ekleyerek temizler", onclick: act(() => app.pipeline.clean("region", { force: true, useSelectionMask: true, selectionOnly: false })) }, "Seçimle düzeltilmiş maskeyle"),
      h("button", { class: "btn", title: "Bu oturumdaki son Tam İşlem'in temizlenmiş görselini tekrar uygular", onclick: act(() => app.pipeline.reapplyLastInpaint()) }, "Temizliği yeniden uygula (kredisiz)"))));
  root.appendChild(h("div", { class: "section" }, h("h4", null, "Nesne Kaldır"),
    h("div", { class: "small muted" }, "Photoshop'ta kaldırılacak nesnenin çevresini seçin; seçili alan otomatik temizlenir."),
    h("div", { class: "row wrap" },
      h("button", { class: "btn", onclick: act(() => app.pipeline.clean("region", { objectRemoval: true, useSelectionMask: true, selectionOnly: true, force: true, method: "torii" })) }, "Torii Inpaint ile kaldır"),
      h("button", { class: "btn", onclick: act(() => app.pipeline.clean("region", { objectRemoval: true, useSelectionMask: true, selectionOnly: true, force: true, method: "contentAware" })) }, "İçerik Duyarlı ile kaldır"),
      h("button", { class: "btn", onclick: act(() => app.pipeline.clean("region", { objectRemoval: true, useSelectionMask: true, selectionOnly: true, force: true, method: "adobeGenerative", prompt: A.prompt })) }, "Üretken Dolgu ile kaldır"))));
  const prompt = h("input", { type: "text", class: "grow", placeholder: "Görsel açıklaması (Firefly)" });
  root.appendChild(h("div", { class: "section" }, h("h4", null, "Görsel Üret"),
    h("div", { class: "row" }, prompt),
    h("div", { class: "row wrap" },
      h("button", { class: "btn", disabled: ffOk ? null : true, title: ffOk ? "" : "Kurulum ister: Firefly vekil sunucusu", onclick: act(() => app.generateImage(prompt.value)) }, "Firefly Services ile üret (ayrı katman)")),
    h("div", { class: "small muted" }, ffOk ? "Firefly vekili doğrulandı." : "Firefly Services: kurulum ister (server/firefly-proxy.mjs).")));
  root.appendChild(h("div", { class: "section" }, h("h4", null, "Yöntem karşılaştırma (seçili öğeler)"),
    h("div", { class: "small muted" }, "Seçili öğelerde Yerel dolgu ve Torii Inpaint'i çalıştırır; yazı izi, çizgi kırılması, süre ve maliyeti gösterir. Katmana yazmaz."),
    h("button", { class: "btn", onclick: act(() => app.compareMethods()) }, "Karşılaştır")));
}

// ------------------------------------------------------------------ Araçlar sekmesi
function renderTools(root, app) {
  clear(root);
  const sets = app.ops.listActions();
  let setName = sets[0] ? sets[0].name : "", actName = sets[0] && sets[0].actions[0] ? sets[0].actions[0] : "";
  const actSel = h("select", { class: "grow" });
  const fillActs = () => { clear(actSel); const s = sets.find((x) => x.name === setName); for (const a of (s ? s.actions : [])) actSel.appendChild(h("option", { value: a }, a)); actSel.value = actName = s && s.actions[0] ? s.actions[0] : ""; };
  actSel.addEventListener("change", () => { actName = actSel.value; });
  const setSel = select(sets.map((s) => [s.name, s.name]), setName, (v) => { setName = v; fillActs(); }, { class: "grow" });
  fillActs();
  const act = (fn) => async () => { try { await fn(); } catch (e) { app.notify(e.message, "error"); } };
  root.appendChild(h("div", { class: "section" }, h("h4", null, "Photoshop Eylemleri (Actions)"),
    h("div", { class: "row" }, setSel), h("div", { class: "row" }, actSel),
    h("div", { class: "row" }, h("button", { class: "btn", onclick: act(async () => { await app.ops.playAction(setName, actName); app.notify("Eylem çalıştı: " + actName, "ok"); }) }, "Çalıştır"),
      h("button", { class: "mini", onclick: () => renderTools(root, app) }, "Listeyi yenile"))));
  const tools = [["move", "Taşıma (Ctrl+T dönüştür)"], ["type", "Metin aracı"], ["lasso", "Kement (eksik balon seçimi)"], ["marquee", "Dikdörtgen seçim"], ["remove", "Kaldırma aracı"], ["heal", "Nokta düzeltme fırçası"]];
  root.appendChild(h("div", { class: "section" }, h("h4", null, "Yerel Photoshop araçlarına geç"),
    h("div", { class: "row wrap" }, ...tools.map(([k, l]) => h("button", { class: "mini", onclick: act(async () => { const ok = await app.ops.nativeTool(k); app.notify(ok ? l + " etkin." : l + " seçilemedi.", ok ? "info" : "warn"); }) }, l)))));
  let fullSingle = false;
  root.appendChild(h("div", { class: "section" }, h("h4", null, "Canlı kabul testi (geliştirici)"),
    h("div", { class: "small muted" }, "Etkin belgede gerçek Torii çağrılarıyla Tespit → Sadece Balonlar çeviri/temizlik/dizgi → piksel koruma → efekt → iki profil testlerini çalıştırır. Rapor: eklenti veri klasörü › selftest-report.json"),
    checkbox(false, (v) => { fullSingle = v; }, "Tam İşlem tek istek testini de çalıştır (kopya belgede)"),
    h("button", { class: "btn", onclick: act(async () => {
      const ok = await dialogs.confirm("Canlı kabul testi", `Torii kredisi harcanır (yaklaşık: OCR 2 + çeviri ≥1 + inpaint 0,02${fullSingle ? " + görsel çeviri ≥1" : ""}). Etkin belge: <b>${esc(app.store.active ? app.store.active.title : "—")}</b>. Belgede katmanlar oluşturulur.`, ["Başlat", "İptal"]);
      if (ok !== 0) return;
      const rep = await require("../selftest").runLive(app, { fullSingle });
      await dialogs.show("Canlı test sonucu", h("div", { class: "log" }, rep.steps.map((s) => `${s.status} ${s.name} (${s.ms} ms)${s.error ? " — " + s.error : ""}`).join("\n")), ["Kapat"], { width: 620, height: 460 });
    }) }, "Canlı testi başlat")));
  root.appendChild(h("div", { class: "section" }, h("h4", null, "Katman eşleme"),
    h("div", { class: "row wrap" },
      h("button", { class: "mini", onclick: act(async () => { const it = await app.ops.itemFromActiveLayer(); app.store.select([it.id]); app.notify("Katmandan öğe oluşturuldu: #" + it.order, "ok"); }) }, "Seçili metin katmanından öğe oluştur"),
      h("button", { class: "mini", onclick: act(async () => { const n = await app.ops.syncContentFromPs(); app.notify(`Photoshop'tan eşitlendi (${n} değişiklik).`, "ok"); }) }, "Photoshop'tan eşitle"))));
}

// ------------------------------------------------------------------ Ayarlar sekmesi
function renderSettings(root, app) {
  clear(root);
  const S = app.settings, T = S.torii;
  const save = () => app.saveSettings();
  const key = h("input", { type: "password", class: "grow", placeholder: app.hasKey ? "•••••••• (kayıtlı)" : "sk_torii_…", "aria-label": "Torii API Anahtarı" });
  const out = h("div", { class: "small" });
  const act = (fn) => async () => { try { await fn(); } catch (e) { out.textContent = e.message; out.className = "small err"; } };
  root.appendChild(h("div", { class: "section" }, h("h4", null, "Torii API"),
    h("div", { class: "field" }, h("label", null, "Torii API Anahtarı"), key),
    h("div", { class: "small muted" }, "Anahtar UXP Secure Storage'da şifreli saklanır; profillere, dışa aktarımlara ve loglara yazılmaz."),
    h("div", { class: "row wrap" },
      h("button", { class: "btn", onclick: act(async () => { const v = key.value.trim(); if (!v) return; await storage.setSecret("torii_api_key", v); key.value = ""; app.hasKey = true; key.placeholder = "•••••••• (kayıtlı)"; out.textContent = "Kaydedildi."; out.className = "small ok"; }) }, "Kaydet"),
      h("button", { class: "btn", onclick: act(async () => { out.textContent = "Test ediliyor…"; const c = await app.client.credits(); const k = await app.client.keys().catch(() => null); const cur = k && k.keys ? k.keys.find((x) => x.current) : null; out.textContent = `Bağlantı tamam. Kalan kredi: ${c}${cur ? " · anahtar: " + (cur.name || cur.display_key) : ""}`; out.className = "small ok"; }) }, "Bağlantıyı Test Et"),
      h("button", { class: "btn quiet", onclick: act(async () => { await storage.setSecret("torii_api_key", ""); app.hasKey = false; key.placeholder = "sk_torii_…"; out.textContent = "Anahtar silindi."; }) }, "Anahtarı sil")),
    h("div", { class: "field" }, h("label", null, "Kalan Kredi"), h("b", { id: "creditsBig" }, app.client.lastCredits == null ? "—" : String(app.client.lastCredits)), h("button", { class: "mini", onclick: act(async () => { await app.client.credits(); renderSettings(root, app); }) }, "Yenile")),
    out));
  const byokKey = h("input", { type: "password", class: "grow", placeholder: "Sağlayıcı anahtarı (isteğe bağlı)" });
  root.appendChild(h("div", { class: "section" }, h("h4", null, "Çeviri modeli (Torii üzerinden)"),
    h("div", { class: "field" }, h("label", null, "Varsayılan model"), select(TRANSLATORS.map((t) => [t.id, t.label]), T.translator, (v) => { T.translator = v; save(); })),
    h("div", { class: "small muted" }, "Gemini seçenekleri Torii üzerinden çalışır. Seri profili kendi modelini seçebilir."),
    h("div", { class: "field" }, h("label", null, "BYOK sağlayıcı"), select([["", "Yok (Torii kredisi)"]].concat(BYOK_PROVIDERS.map((p) => [p, p === "google" ? "Google Gemini" : p])), T.byokProvider || "", (v) => { T.byokProvider = v; save(); })),
    h("div", { class: "field" }, h("label", null, "BYOK anahtarı"), byokKey, h("button", { class: "mini", onclick: act(async () => { if (!T.byokProvider) throw new Error("Önce sağlayıcı seçin."); await storage.setSecret("byok_" + T.byokProvider, byokKey.value.trim()); byokKey.value = ""; out.textContent = "BYOK anahtarı kaydedildi (Secure Storage)."; out.className = "small ok"; }) }, "Kaydet")),
    checkbox(T.byokFallback !== false, (v) => { T.byokFallback = v; save(); }, "Kendi anahtarım başarısız olursa Torii modeline geç (x-byok-fallback)"),
    h("div", { class: "field" }, h("label", null, "Min. punto (Torii)"), numberInput(T.minFontPx, (v) => { T.minFontPx = v; save(); }, { min: 6, max: 100 })),
    h("div", { class: "field" }, h("label", null, "Tam İşlem modu"), select([["auto", "Otomatik (boş sayfada tek istek)"], ["single", "Tek istek (v2/upload dosya)"], ["modular", "Modüler (OCR → çeviri → inpaint)"]], S.ui.fullMode, (v) => { S.ui.fullMode = v; save(); }))));
  const ffUrl = h("input", { type: "text", class: "grow", placeholder: "http://127.0.0.1:8787" }); ffUrl.value = S.firefly.proxyUrl || "";
  const ffOut = h("div", { class: "small" });
  root.appendChild(h("div", { class: "section" }, h("h4", null, "Firefly Services (sunucu tarafı)"),
    h("div", { class: "small muted" }, "Adobe kimlik bilgileri eklentide tutulmaz; server/firefly-proxy.mjs vekilinde ortam değişkenlerindedir. Vekil alan adı manifest.json içinde izinli olmalıdır."),
    h("div", { class: "field" }, h("label", null, "Vekil URL"), ffUrl),
    h("button", { class: "mini", onclick: async () => { S.firefly.proxyUrl = ffUrl.value.trim(); const r = await app.firefly.health(); S.cleanup.verified.firefly = !!r.ok; save(); ffOut.textContent = r.ok ? "Vekil doğrulandı: " + r.models.join(", ") : "Doğrulanamadı: " + r.reason; ffOut.className = r.ok ? "small ok" : "small err"; } }, "Kaydet ve test et"), ffOut));
}

function renderLog(root) {
  clear(root);
  const pre = h("div", { class: "log" }, logBuffer.map((l) => `${l.t} ${l.level.toUpperCase()} ${l.msg}${l.data ? " " + l.data : ""}`).join("\n") || "Log boş.");
  root.appendChild(h("div", { class: "row" },
    h("button", { class: "mini", onclick: () => renderLog(root) }, "Yenile"),
    h("button", { class: "mini", onclick: async () => { try { await navigator.clipboard.setContent({ "text/plain": redact(pre.textContent) }); } catch (e) { /* yok */ } } }, "Kopyala (anahtarlar gizli)")));
  root.appendChild(pre);
}

module.exports = { renderProfile, renderChapter, renderClean, renderTools, renderSettings, renderLog };
