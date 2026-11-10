// Manga Çeviri Stüdyosu — panel denetleyicisi.
"use strict";
const T_START = Date.now(); // panel açılış süresi (log: "Panel hazır (N ms)")
const { entrypoints } = require("uxp");
const { app: psApp, action, modal, activeDoc, getDoc, findLayer } = require("./src/ps/api");
const docs = require("./src/ps/document");
const pixels = require("./src/ps/pixels");
const storage = require("./src/model/storage");
const conf = require("./src/model/config");
const { Store, emptyState } = require("./src/model/store");
const { ToriiClient } = require("./src/torii/client");
const { FireflyClient } = require("./src/firefly");
const { Pipeline } = require("./src/pipeline");
const { Ops } = require("./src/ops");
const { ItemList } = require("./src/ui/list");
const { Editor } = require("./src/ui/editor");
const tabs = require("./src/ui/tabs");
const dialogs = require("./src/ui/dialogs");
const { h, clear, activate, busyState } = require("./src/ui/dom");
const { log, debounce, clone, uid } = require("./src/util/common");

const $ = (id) => document.getElementById(id);
// UXP'de NodeList için for…of/yayma garanti değil → diziye çevir
const $$ = (sel, root) => Array.prototype.slice.call((root || document).querySelectorAll(sel));

function deepMerge(base, over) {
  if (!over || typeof over !== "object" || Array.isArray(over)) return over === undefined ? base : over;
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  for (const k of Object.keys(over)) out[k] = base && typeof base[k] === "object" && !Array.isArray(base[k]) ? deepMerge(base[k], over[k]) : over[k];
  return out;
}

const App = {
  settings: null, store: null, client: null, firefly: null, pipeline: null, ops: null, list: null, editor: null,
  hasKey: false, currentTab: "items", view: "list",

  async init() {
    this.settings = deepMerge(conf.defaultSettings(), await storage.readJson("settings.json", {}));
    this.migrate();
    this.store = new Store();
    this.store.settings = this.settings;
    this.client = new ToriiClient(() => storage.getSecret("torii_api_key"));
    this.client.onCredits = () => this.renderCredits();
    this.firefly = new FireflyClient(() => this.settings.firefly.proxyUrl);
    this.hasKey = !!(await storage.getSecret("torii_api_key"));
    this.pipeline = new Pipeline(this.store, this.client, {
      confirm: (t, html, b) => dialogs.confirm(t, html, b),
      notify: (m, k) => this.notify(m, k),
      progress: (l, f) => this.progress(l, f),
      preview: (plans) => dialogs.cleanupPreview(plans),
      ambiguous: (d) => dialogs.ambiguous(d),
      openPage: (p) => this.openPage(p),
      busy: (on, name, info) => this.onBusy(on, name, info),
      ensureDoc: () => this.ensureActiveSession(),
      saveSettings: () => this.saveSettings(),
    });
    // Ağ beklemesi de görünür olsun
    this.client.onWait = (label) => { if (this.busyInfo) this.progress(`Torii yanıtı bekleniyor — ${label}`, 0); };
    this.pipeline.firefly = this.settings.firefly.proxyUrl ? this.firefly : null;
    this.ops = new Ops(this.store, this.pipeline, {});
    this.store._persistFn = (s) => this.persistSession(s);
    this.list = new ItemList($("list"), this.store, {
      onSelect: (it) => { this.ops.selectItemLayer(it).catch(() => {}); },
      onOpenEditor: () => this.setView("editor"),
      filterAllows: (it) => this.pipeline.filtersAllow(it),
      onDelete: (ids) => this.askDelete(ids),
    });
    this.editor = new Editor($("editor"), this);
    // Yeniden çizimler kare başına birleştirilir (art arda gelen olaylar tek çizim)
    this.store.on("change", () => this.scheduleRender());
    this.store.on("selection", (e) => { this.scheduleRender(); if (e.fromPs && this.isNarrow()) this.setView("editor"); });
    this.store.on("pending", () => this.renderHeader());
    busyState.onBlocked = () => this.notify(`"${this.busyInfo ? this.busyInfo.name : "İşlem"}" sürüyor — bitmesini bekleyin veya ■ Durdur.`, "warn");
    this.wireUi();
    this.listenPhotoshop();
    await this.onActiveDocChanged();
    if (this.hasKey) this.client.credits().catch(() => {});
    else this.notify("Başlamak için Ayarlar › Torii API anahtarını girin.", "warn");
    this.layout();
    this.showTab(this.settings.ui.tab && $$(`.tab[data-tab="${this.settings.ui.tab}"]`).length ? this.settings.ui.tab : "items");
    this.renderModeLine();
    log("info", `Panel hazır (${Date.now() - T_START} ms)`);
    try { require("./src/dev/showpanel")(); } catch (e) { /* paketlenmiş sürümde src/dev yok */ }
  },

  /** Eski ayar dosyalarını yeni yapıya taşır (tek seferlik, sessiz). Eski dosyada seri profilleri varsa önce onlarda düzeltilir, sonra tek yapılandırmaya taşınır. */
  migrate() {
    const S = this.settings;
    const M = S.migrations = S.migrations || {};
    const cfgs = () => (Array.isArray(S.profiles) ? S.profiles : [S.config]);
    if (!M.typeFonts) { for (const p of cfgs()) if (p.base && p.base.font === "ArialMT") delete p.base.font; M.typeFonts = true; }
    if (!M.sfxLook) {
      const { DEFAULT_STYLE } = require("./src/model/rules");
      const gb = (S.global && S.global.base) || null;
      if (gb && Object.keys(DEFAULT_STYLE).every((k) => gb[k] === undefined || gb[k] === DEFAULT_STYLE[k])) S.global.base = {};
      for (const p of cfgs()) if (!(p.rules || []).some((r) => (r.types || []).includes("sfx"))) (p.rules = p.rules || []).push(conf.defaultSfxRule());
      M.sfxLook = true;
    }
    if (!M.sfxSize) {
      for (const p of cfgs()) for (const r of p.rules || []) if (r.name === "SFX (varsayılan)" && r.style && r.style.minSizePx === 18) { delete r.style.minSizePx; if (r.style.maxSizePx === 140) r.style.maxSizePx = 160; }
      M.sfxSize = true;
    }
    if (!M.v2) {
      // Sadeleştirme: öğret/kaydet ve partner modelleri kaldırıldı; Tam İşlem varsayılanı modüler (ucuz)
      S.adobe = { prompt: (S.adobe && S.adobe.prompt) || "" };
      if (S.torii) delete S.torii.minFontPx;
      if (!S.ui.fullMode || S.ui.fullMode === "auto") S.ui.fullMode = "modular";
      for (const p of cfgs()) if (p.cleanup && (p.cleanup.sfxMethod === "adobeRemove" || p.cleanup.sfxMethod === "adobeGenerative")) p.cleanup.sfxMethod = "auto";
      for (const p of cfgs()) if (p.cleanup && (p.cleanup.method === "adobeRemove" || p.cleanup.method === "adobeGenerative")) p.cleanup.method = "auto";
      M.v2 = true;
    }
    // 1.2.0: seri profili sistemi kaldırıldı (profiller silinir, değerler taşınmaz)
    if (conf.migrateProfiles(S)) log("info", "Seri profilleri kaldırıldı; ayarlar varsayılana döndü");
    if (S.ui.tab === "profile") S.ui.tab = "settings";
    this.saveSettings();
  },

  saveSettings: debounce(function () {
    const s = clone(App.settings);
    for (const r of (s.config && s.config.rules) || []) delete r._open;
    for (const ch of s.chapters || []) for (const r of ch.rules || []) delete r._open;
    storage.writeJson("settings.json", s).catch((e) => log("warn", "Ayarlar kaydedilemedi", e.message));
  }, 500),

  scheduleRender() {
    if (this._renderQueued) return;
    this._renderQueued = true;
    const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (f) => setTimeout(f, 16);
    raf(() => { this._renderQueued = false; this.list.render(); this.editor.render(); this.renderHeader(); });
  },

  notify(msg, kind) {
    const el = $("status");
    const icon = kind === "error" ? "✕ " : kind === "warn" ? "⚠ " : kind === "ok" ? "✓ " : "";
    el.textContent = /^[✓✕⚠■]/.test(msg) ? msg : icon + msg;
    el.className = "status " + (kind || "");
    el.setAttribute("title", msg);
    log(kind === "error" ? "error" : kind === "warn" ? "warn" : "info", msg);
  },

  /** İşlem içindeki adım: çalışıyor kutusunda gösterilir (f: 0–1, bilinmiyorsa kayan çubuk). */
  progress(label, f) {
    const b = this.busyInfo;
    if (!b) return;
    if (label) b.step = label;
    b.frac = f > 0 ? f : null;
    this.tickBusy();
  },

  /** İşlem başladı/bitti — tüm işlemler (alt düğmeler, editör, sekmeler) buradan geçer. */
  onBusy(on, name, info) {
    const app = $("app");
    if (on) {
      this.busyInfo = { name, step: name + "…", t0: Date.now(), frame: 0, frac: null };
      busyState.on = true;
      app.classList.add("is-busy");
      $("btnFull").textContent = "Çalışıyor…";
      $("status").textContent = ""; $("status").className = "status";
      clearInterval(this.busyTimer);
      this.busyTimer = setInterval(() => this.tickBusy(), 200);
      this.tickBusy();
    } else {
      clearInterval(this.busyTimer); this.busyTimer = null;
      this.busyInfo = null;
      busyState.on = false;
      app.classList.remove("is-busy");
      $("btnFull").textContent = "▶  Tam İşlem";
      const st = $("status");
      const sec = info ? Math.round(info.ms / 100) / 10 : 0;
      // İşlem kendi sonuç mesajını yazdıysa korunur; başına süre (ve harcanan kredi) eklenir. Uyarı/hata rengi korunur.
      if (info && info.ok) {
        const credit = (info.credits != null && info.credits > 0 ? ` · ${info.credits} kredi` : "") + (info.reused ? ` · ${info.reused} ücretli yanıt önbellekten (kredisiz)` : "");
        const prev = st.textContent.replace(/^[✓⚠]\s*/, "");
        const warn = /\bwarn\b/.test(st.className);
        st.textContent = `${warn ? "⚠" : "✓"} ${name} · ${sec} sn${credit}${prev ? " — " + prev : ""}`;
        st.className = "status " + (warn ? "warn" : "done");
      }
      if (info) this.lastRun = { name, ok: info.ok, sec, credits: info.credits, mode: info.mode };
      this.renderModeLine();
      this.scheduleRender();
    }
  },

  tickBusy() {
    const b = this.busyInfo;
    if (!b) return;
    const frames = ["◐", "◓", "◑", "◒"];
    b.frame = (b.frame + 1) % 4;
    $("spinner").textContent = frames[b.frame];
    const s = Math.floor((Date.now() - b.t0) / 1000);
    $("elapsed").textContent = s < 60 ? `${s} sn` : `${Math.floor(s / 60)} dk ${s % 60} sn`;
    $("busyText").textContent = b.step;
    const bar = $("progressBar"), track = $("progress").clientWidth || 300;
    if (b.frac != null) { bar.style.left = "0px"; bar.style.width = Math.round(b.frac * 100) + "%"; }
    else {
      // belirsiz süre: kayan parça
      const w = Math.round(track * 0.28), pos = ((Date.now() - b.t0) / 6) % (track + w) - w;
      bar.style.width = w + "px"; bar.style.left = Math.round(pos) + "px";
    }
  },

  renderCredits() {
    const c = this.client.lastCredits;
    $("credits").textContent = c == null ? "— kr" : (Math.round(c * 100) / 100).toLocaleString("tr-TR") + " kr";
    $("creditPill").classList.toggle("live", c != null);
    $("creditPill").classList.toggle("low", c != null && c < 10);
  },

  /** Alt satır: kullanılan Tam İşlem modu ve son çalıştırmanın süresi/maliyeti. */
  renderModeLine() {
    const mode = this.settings.ui.fullMode === "single" ? "Tek istek (~6–8 kr/sayfa)" : "Modüler (~2 kr/sayfa)";
    const L = this.lastRun;
    const last = L ? ` · son: ${L.name}${L.mode ? " (" + L.mode + ")" : ""} ${L.sec} sn${L.credits != null ? ", " + L.credits + " kr" : ""}` : "";
    $("modeLine").textContent = `Tam İşlem modu: ${mode}${last}`;
  },

  scope() { return this.settings.ui.scope || "page"; },

  // ------------------------------------------------------------------ UI
  wireUi() {
    const S = this.settings;
    for (const b of $$(".tab")) activate(b, () => this.showTab(b.getAttribute("data-tab")));
    // Sekmelerde ← → ile gezinme
    document.querySelector(".tabs").addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const tabs = $$(".tab"), i = tabs.findIndex((t) => t.classList.contains("active"));
      const n = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
      this.showTab(n.getAttribute("data-tab")); n.focus();
    });
    for (const b of $$("#viewSeg .opt")) activate(b, () => this.setView(b.getAttribute("data-view")));
    for (const o of $$("#scopeSeg .opt")) activate(o, () => { S.ui.scope = o.getAttribute("data-scope"); this.saveSettings(); this.renderScope(); });
    for (const c of $$("[data-filter]")) {
      const k = c.getAttribute("data-filter");
      activate(c, () => {
        if (S.ui.bubblesOnly) return this.notify("Sadece Balonlar açıkken yalnızca onaylı diyaloglar işlenir. Türleri seçmek için önce onu kapatın.", "info");
        S.ui.filters[k] = !S.ui.filters[k]; this.saveSettings(); this.renderFilters(); this.list.render();
      });
    }
    activate($("bubblesOnly"), () => {
      S.ui.bubblesOnly = !S.ui.bubblesOnly;
      this.notify(S.ui.bubblesOnly ? "Sadece Balonlar: yalnızca ONAYLANAN diyalog balonları çevrilir, temizlenir ve dizilir. Diğer pikseller değişmez." : "Sadece Balonlar kapalı: seçili türlerin tümü işlenir.", "info");
      this.saveSettings(); this.list.render(); this.renderFilters(); this.editor.render();
    });
    activate($("creditPill"), () => { if (!this.hasKey) return this.showTab("settings"); this.client.credits().then(() => this.notify("Kredi güncellendi.", "ok"), (e) => this.notify(e.message, "error")); });
    activate($("btnDetect"), () => this.pipeline.detect(this.scope()));
    activate($("btnClean"), () => this.pipeline.clean(this.scope()));
    activate($("btnTranslate"), () => this.pipeline.translate(this.scope()));
    activate($("btnTypeset"), () => this.pipeline.typeset(this.scope()));
    activate($("btnFull"), () => this.pipeline.full(this.scope()));
    activate($("btnStop"), () => this.requestStop());
    // Esc: işlem sürerken durdurma isteği
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && this.busyInfo) { e.preventDefault(); this.requestStop(); } });
    this.renderListToolbar();
    this.wireSplitter();
    window.addEventListener("resize", debounce(() => this.layout(), 80));
    window.addEventListener("focus", () => { this.quickDocCheck(); this.ops.syncContentFromPs().catch(() => {}); });
    // Belge değişimi için yoklama YOK: Photoshop olayları + panele her tıklamada ucuz kimlik karşılaştırması + işlem öncesi doğrulama
    $("app").addEventListener("pointerdown", () => this.quickDocCheck(), true);
    this.renderFilters();
    this.renderScope();
  },

  requestStop() {
    if (!this.busyInfo) return;
    this.pipeline.cancelRequested = true;
    this.busyInfo.step = "Durduruluyor — mevcut adım bitince duracak…";
    this.tickBusy();
  },

  /** Etkin belge panel oturumundan farklıysa yükle (yalnız kimlik karşılaştırması; ucuz). */
  quickDocCheck() {
    if (this.busyInfo || this._ensuring) return;
    let d = null;
    try { d = activeDoc(); } catch (e) { return; }
    const cur = this.store.activeDocId;
    if ((d && (cur !== d.id || !this.store.session(d.id))) || (!d && cur != null)) {
      this._ensuring = true;
      this.onActiveDocChanged().catch(() => {}).finally(() => { this._ensuring = false; });
    }
  },

  /** Liste ↔ editör ayırıcısı: sürükle (canlı), çift tık = varsayılan, ← → = 20 px. Genişlik ayarlarda saklanır. */
  wireSplitter() {
    const sp = $("splitter"), list = $("listWrap"), split = $("itemsSplit");
    const MIN_LIST = 180, MIN_EDITOR = 220;
    const apply = (px) => {
      const total = split.clientWidth || 600;
      const w = Math.max(MIN_LIST, Math.min(total - MIN_EDITOR - 12, Math.round(px)));
      list.style.flex = "0 0 " + w + "px";
      list.style.width = w + "px";
      return w;
    };
    const restore = () => { const w = this.settings.ui.listWidth; if (w) apply(w); else { list.style.flex = ""; list.style.width = ""; } };
    this._applyListWidth = restore;
    restore();
    // Sürükleme: yalnızca hafif bir kılavuz çizgisi hareket eder (liste/editör yeniden yerleşmez → takılma yok);
    // genişlik bırakınca TEK seferde uygulanır. Hareketler kare başına birleştirilir.
    const ghost = h("div", { class: "split-ghost" }, h("span", { class: "split-label" }, ""));
    split.appendChild(ghost);
    const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (f) => setTimeout(f, 16);
    const clampW = (px) => {
      const total = split.clientWidth || 600;
      return Math.max(MIN_LIST, Math.min(total - MIN_EDITOR - 12, Math.round(px)));
    };
    let drag = null;
    const paint = () => {
      if (!drag) return;
      drag.pending = false;
      ghost.style.left = (drag.w + drag.pad) + "px";
      ghost.firstChild.textContent = drag.w + " px";
    };
    const move = (e) => {
      if (!drag) return;
      drag.w = clampW(drag.w0 + (e.clientX - drag.x0));
      if (!drag.pending) { drag.pending = true; raf(paint); }
    };
    const end = (commit) => {
      if (!drag) return;
      const d = drag; drag = null;
      ghost.classList.remove("on"); sp.classList.remove("dragging");
      document.removeEventListener("pointermove", move); document.removeEventListener("pointerup", up);
      document.removeEventListener("pointercancel", up); document.removeEventListener("keydown", esc);
      window.removeEventListener("blur", up);
      if (commit && d.w !== d.w0) { apply(d.w); this.settings.ui.listWidth = d.w; this.saveSettings(); }
    };
    // İmleç panelden çıkarsa / odak kaybolursa son konum uygulanır; Esc iptal eder
    const up = () => end(true), esc = (e) => { if (e.key === "Escape") end(false); };
    sp.addEventListener("pointerdown", (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      e.preventDefault();
      const w0 = Math.round(list.getBoundingClientRect().width);
      const pad = Math.round(list.getBoundingClientRect().left - split.getBoundingClientRect().left);
      drag = { x0: e.clientX, w0, w: w0, pad, pending: false };
      sp.classList.add("dragging"); ghost.classList.add("on");
      paint();
      try { if (sp.setPointerCapture && e.pointerId != null) sp.setPointerCapture(e.pointerId); } catch (err) { /* desteklenmiyor */ }
      document.addEventListener("pointermove", move); document.addEventListener("pointerup", up);
      document.addEventListener("pointercancel", up); document.addEventListener("keydown", esc);
      window.addEventListener("blur", up);
    });
    sp.addEventListener("dblclick", () => { this.settings.ui.listWidth = null; this.saveSettings(); restore(); });
    sp.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      const w = apply(list.getBoundingClientRect().width + (e.key === "ArrowLeft" ? -20 : 20));
      this.settings.ui.listWidth = w; this.saveSettings();
    });
  },

  renderScope() {
    for (const o of $$("#scopeSeg .opt")) { const on = o.getAttribute("data-scope") === this.scope(); o.classList.toggle("on", on); o.setAttribute("aria-checked", on ? "true" : "false"); }
  },

  renderFilters() {
    const S = this.settings;
    const bo = S.ui.bubblesOnly;
    for (const c of $$("[data-filter]")) {
      const k = c.getAttribute("data-filter");
      c.classList.toggle("on", bo ? k === "dialog" : !!S.ui.filters[k]);
      c.classList.toggle("disabled", bo);
    }
    $("bubblesOnly").classList.toggle("on", !!bo);
  },

  /** Liste araç çubuğu: sık kullanılanlar görünür, gerisi "⋯" menüsünde (dar panelde taşma olmaz). */
  renderListToolbar() {
    const tb = clear($("listToolbar"));
    const act = (fn) => async () => { try { await fn(); } catch (e) { this.notify(e.message, "error"); } };
    tb.appendChild(h("button", { class: "mini icon", title: "Önerilen tüm türleri onayla", onclick: () => { const n = this.store.items().filter((i) => !i.typeConfirmed).length; for (const it of this.store.items()) it.typeConfirmed = true; this.store.touch(); this.notify(`${n} tür onaylandı.`, "ok"); } }, "✓ Onayla"));
    tb.appendChild(h("button", { class: "mini icon", title: "Eksik balonu Photoshop'ta seçip yalnız o bölgeyi okut (1 kredi)", onclick: act(() => this.pipeline.detect("region")) }, "⌖ Seçimi okut"));
    tb.appendChild(h("button", { class: "mini icon", title: "Diğer işlemler", onclick: () => this.moreMenu() }, "⋯"));
  },

  async moreMenu() {
    const items = this.store.items();
    const choice = await dialogs.show("Öğe işlemleri", h("div", { class: "small muted" }, `${items.length} öğe · ${this.store.selected.size} seçili`),
      ["Türleri yeniden öner (kredisiz)", "Photoshop'tan eşitle", "Seçilenleri sil", "Listeyi temizle", "Kapat"], { width: 420, height: 260 });
    try {
      if (choice === 0) await this.pipeline.reclassify();
      else if (choice === 1) { const n = await this.ops.syncContentFromPs(); this.notify(`Photoshop'tan eşitlendi (${n} değişiklik).`, "ok"); }
      else if (choice === 2) await this.askDelete([...this.store.selected]);
      else if (choice === 3) await this.askDelete(items.map((i) => i.id), true);
    } catch (e) { this.notify(e.message, "error"); }
  },

  /** Silme onayı: yalnız listeden mi, eklentinin katmanlarıyla birlikte mi? */
  async askDelete(ids, all) {
    if (!ids || !ids.length) return this.notify("Silinecek öğe seçilmedi. Listeden öğe seçin (Ctrl/Shift ile çoklu seçim).", "warn");
    const n = ids.length;
    const withLayers = this.store.items().filter((i) => ids.includes(i.id) && (i.layerId != null || i.cleanLayerId != null)).length;
    const msg = `${all ? "Sayfadaki tüm öğeler" : n + " öğe"} silinecek.` + (withLayers ? `<br><br>${withLayers} öğenin Photoshop'ta çeviri/temizlik katmanı var. <b>Katmanlarıyla sil</b> derseniz bu katmanlar da silinir (orijinal görsele dokunulmaz). Geri almak için Ctrl+Z.` : "");
    const buttons = withLayers ? ["Katmanlarıyla sil", "Yalnız listeden kaldır", "İptal"] : ["Sil", "İptal"];
    const c = await dialogs.confirm("Öğeleri sil", msg, buttons);
    if (c === buttons.length - 1) return;
    try {
      const k = await this.ops.deleteItems(ids, withLayers ? c === 0 : false);
      this.notify(`${k} öğe silindi${withLayers && c === 0 ? " (katmanlarıyla)" : ""}.`, "ok");
    } catch (e) { this.notify(e.message, "error"); }
  },

  showTab(name) {
    this.currentTab = name;
    if (this.settings.ui.tab !== name) { this.settings.ui.tab = name; this.saveSettings(); }
    for (const b of $$(".tab")) { const on = b.getAttribute("data-tab") === name; b.classList.toggle("active", on); b.setAttribute("aria-selected", on ? "true" : "false"); }
    for (const p of $$(".pane")) p.classList.toggle("active", p.getAttribute("data-pane") === name);
    const pane = document.querySelector(`.pane[data-pane="${name}"]`);
    if (name === "chapter") tabs.renderChapter(pane, this);
    else if (name === "clean") tabs.renderClean(pane, this);
    else if (name === "settings") tabs.renderSettings(pane, this);
  },

  isNarrow() { return document.body.clientWidth < 520; },
  layout() {
    const app = $("app");
    app.classList.toggle("narrow", this.isNarrow());
    // Dar görünümde liste tam genişlik (kayıtlı ayırıcı genişliği uygulanmaz); genişte kayıtlı genişlik geri gelir
    if (this.isNarrow()) { $("listWrap").style.flex = ""; $("listWrap").style.width = ""; }
    else if (this._applyListWidth) this._applyListWidth();
    this.setView(this.view);
  },
  setView(v) {
    this.view = v;
    const app = $("app");
    app.classList.toggle("view-list", v === "list");
    app.classList.toggle("view-editor", v === "editor");
    for (const b of $$("#viewSeg .opt")) b.classList.toggle("on", b.getAttribute("data-view") === v);
  },

  renderHeader() {
    const s = this.store.active;
    const pend = this.store.pending.length;
    $("docTitle").textContent = s ? s.title : "Belge açık değil";
    if (s) {
      const it = s.state.items;
      const c = (f) => it.filter(f).length;
      $("docMeta").textContent = it.length
        ? `${it.length} öğe · ${c((i) => i.status.cleaned)} temiz · ${c((i) => i.status.translated)} çevrildi · ${c((i) => i.status.typeset)} dizildi${pend ? ` · ${pend} bekleyen sonuç` : ""}`
        : "Henüz öğe yok — ▶ Tam İşlem ile başlayın";
    } else $("docMeta").textContent = "Photoshop'ta bir sayfa açın";
    $("listTitle").textContent = s ? `ÖĞELER · ${s.state.items.length}` : "ÖĞELER";
  },


  // ------------------------------------------------------------------ Photoshop olayları
  listenPhotoshop() {
    const docChanged = debounce(() => this.onActiveDocChanged().catch((e) => log("warn", "belge değişimi", e.message)), 120);
    const syncSoon = debounce(() => this.ops.syncContentFromPs().catch(() => {}), 250);
    action.addNotificationListener(["select", "open", "close", "make", "set", "delete", "historyStateChanged", "newDocument", "transform", "move"], (evt, desc) => {
      try {
        const t = desc && desc._target && desc._target[0];
        if (evt === "open" || evt === "close" || evt === "newDocument" || (evt === "select" && t && t._ref === "document")) { docChanged(); return; }
        if (evt === "select" && t && t._ref === "layer") { this.ops.syncSelectionFromPs(); return; }
        if (evt === "historyStateChanged" || evt === "set" || evt === "delete" || evt === "transform" || evt === "move") syncSoon();
      } catch (e) { /* yok say */ }
    });
  },

  /** Etkin belge ile paneldeki oturum uyuşmuyorsa (kapat-aç, başka belgeye geçiş) oturumu yükle. Uyuşuyorsa hiçbir şey yapmaz. */
  async ensureActiveSession() {
    const d = activeDoc();
    if (!d) return;
    if (this.store.activeDocId === d.id && this.store.session(d.id)) return;
    await this.onActiveDocChanged();
  },

  async onActiveDocChanged() {
    const d = activeDoc();
    // Kapanan belgelerin oturumlarını bırak
    for (const id of [...this.store.sessions.keys()]) if (!getDoc(id)) this.store.detach(id);
    if (!d) { this.store.activeDocId = null; this.renderHeader(); this.list.render(); this.editor.render(); return; }
    let s = this.store.session(d.id);
    if (!s) {
      let state = null;
      try { state = await docs.readState(d.id); } catch (e) { log("warn", "PSD durumu okunamadı", e.message); }
      if (!state) {
        // Önbellekten kurtarma (ör. XMP yazılamayan dosya biçimleri)
        state = emptyState();
      }
      s = this.store.attach(d.id, d.title, state);
      try { s.path = d.path; } catch (e) { /* kaydedilmemiş */ }
      log("info", `Belge yüklendi: ${d.title} (${state.items.length} öğe)`);
    }
    this.store.activeDocId = d.id;
    this.store.selected = new Set();
    // Bu belgeye ait bekleyen sonuçları uygula
    const pend = this.store.takePending(s.state.docUid);
    for (const p of pend) {
      try { await p.apply(); this.notify(`Bekleyen "${p.label}" sonucu "${s.title}" belgesine uygulandı.`, "ok"); }
      catch (e) { this.notify(`Bekleyen sonuç uygulanamadı: ${e.message}`, "error"); }
    }
    this.renderHeader();
    this.list.render(); this.editor.render();
    await this.ops.syncContentFromPs().catch(() => {});
  },

  /** Durumu PSD'ye yaz (gecikmeli). Belge kapalıysa atla. */
  async persistSession(s) {
    if (!getDoc(s.docId)) return;
    await modal("Çeviri verisini kaydet", async () => { await docs.writeState(s.docId, s.state); }, {});
    this.store.mirrorPage(s);
  },

  // ------------------------------------------------------------------ Bölüm
  async assignChapter(chId) {
    const s = this.store.active;
    if (!s) return;
    const old = s.state.chapterId && this.settings.chapters.find((c) => c.id === s.state.chapterId);
    if (old) old.pages = old.pages.filter((p) => p.docUid !== s.state.docUid);
    s.state.chapterId = chId;
    const ch = chId && this.settings.chapters.find((c) => c.id === chId);
    if (ch && !ch.pages.find((p) => p.docUid === s.state.docUid)) ch.pages.push({ index: ch.pages.length + 1, title: s.title, docUid: s.state.docUid });
    this.store.touch(s.docId); this.saveSettings(); this.showTab("chapter");
  },

  async chapterFromOpenDocs() {
    const docsOpen = psApp.documents.slice().sort((a, b) => a.title.localeCompare(b.title, "tr", { numeric: true }));
    if (!docsOpen.length) return this.notify("Açık belge yok.", "warn");
    const ch = { id: uid("c_"), name: "Bölüm " + (this.settings.chapters.length + 1), pages: [], rules: [], base: {}, chainContext: "" };
    for (let i = 0; i < docsOpen.length; i++) {
      const d = docsOpen[i];
      let s = this.store.session(d.id);
      if (!s) s = this.store.attach(d.id, d.title, (await docs.readState(d.id).catch(() => null)) || emptyState());
      s.state.chapterId = ch.id; s.state.pageIndex = i + 1; s.dirty = true;
      ch.pages.push({ index: i + 1, title: d.title, docUid: s.state.docUid });
    }
    this.settings.chapters.push(ch);
    this.saveSettings(); this.store.persistSoon();
    this.notify(`"${ch.name}" oluşturuldu: ${ch.pages.length} sayfa.`, "ok");
    this.showTab("chapter");
  },

  async chapterFromFolder() {
    const folder = await storage.pickFolder();
    if (!folder) return;
    const entries = (await folder.getEntries()).filter((e) => e.isFile && /\.(psd|psb|png|jpe?g|webp|tif?f)$/i.test(e.name)).sort((a, b) => a.name.localeCompare(b.name, "tr", { numeric: true }));
    const fs = require("uxp").storage.localFileSystem;
    const ch = { id: uid("c_"), name: folder.name, pages: [], rules: [], base: {}, chainContext: "" };
    for (let i = 0; i < entries.length; i++) ch.pages.push({ index: i + 1, title: entries[i].name, docUid: null, token: await fs.createPersistentToken(entries[i]) });
    this.settings.chapters.push(ch);
    this.saveSettings();
    this.notify(`"${ch.name}" bölümü: ${ch.pages.length} sayfa (işlem sırasında açılır).`, "ok");
  },

  async openPage(p) {
    const fs = require("uxp").storage.localFileSystem;
    if (!p.token) throw new Error("Sayfanın dosya bağlantısı yok: " + p.title);
    const entry = await fs.getEntryForPersistentToken(p.token);
    await modal("Sayfayı aç", () => psApp.open(entry), {});
    await this.onActiveDocChanged();
    const s = this.store.active;
    const ch = this.settings.chapters.find((c) => c.pages.includes(p));
    if (s) {
      if (!p.docUid) p.docUid = s.state.docUid;
      else if (p.docUid !== s.state.docUid) { s.state.docUid = p.docUid; }
      if (ch) { s.state.chapterId = ch.id; s.state.pageIndex = p.index; }
      this.store.touch(s.docId);
      this.saveSettings();
    }
  },

};

entrypoints.setup({
  panels: {
    mainPanel: {
      show() { if (App.ops) { App.quickDocCheck(); App.ops.syncContentFromPs().catch(() => {}); } if (App.hasKey && App.client) App.client.credits().catch(() => {}); },
    },
  },
});

App.init().catch((e) => { log("error", "Başlatma hatası", e && e.stack ? e.stack : String(e)); const st = document.getElementById("status"); if (st) { st.textContent = "✕ Başlatma hatası: " + e.message + " — paneli kapatıp açın; sürerse Ayarlar › Gelişmiş › Log."; st.className = "status error"; } });
