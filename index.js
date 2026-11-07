// Manga Çeviri Stüdyosu — panel denetleyicisi.
"use strict";
const { entrypoints } = require("uxp");
const { app: psApp, action, modal, activeDoc, getDoc, findLayer } = require("./src/ps/api");
const docs = require("./src/ps/document");
const pixels = require("./src/ps/pixels");
const storage = require("./src/model/storage");
const profiles = require("./src/model/profiles");
const { Store, emptyState } = require("./src/model/store");
const { ToriiClient } = require("./src/torii/client");
const { FireflyClient } = require("./src/firefly");
const { Pipeline } = require("./src/pipeline");
const { Ops } = require("./src/ops");
const { ItemList } = require("./src/ui/list");
const { Editor } = require("./src/ui/editor");
const tabs = require("./src/ui/tabs");
const dialogs = require("./src/ui/dialogs");
const { h, clear, setDisabled, activate } = require("./src/ui/dom");
const { log, debounce, clone, uid } = require("./src/util/common");
const png = require("./src/util/png");
const { parseDataUrl } = require("./src/util/bytes");

const $ = (id) => document.getElementById(id);
// UXP'de NodeList için for…of/yayma garanti değil → diziye çevir
const qsa = (sel, root) => Array.prototype.slice.call((root || document).querySelectorAll(sel));

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
    this.settings = deepMerge(profiles.defaultSettings(), await storage.readJson("settings.json", {}));
    if (!this.settings.profiles.length) this.settings.profiles.push(profiles.defaultProfile());
    // Tek seferlik taşıma: eski şablondaki sabit "ArialMT" taban fontu kaldırılır (türe göre font seçimi devreye girsin)
    this.settings.migrations = this.settings.migrations || {};
    if (!this.settings.migrations.typeFonts) {
      for (const p of this.settings.profiles) if (p.base && p.base.font === "ArialMT") delete p.base.font;
      this.settings.migrations.typeFonts = true;
      this.saveSettings();
    }
    if (!this.settings.migrations.sfxLook) {
      // Genel taban, varsayılanın değiştirilmemiş kopyasıysa boşalt; SFX kuralı olmayan serilere hazır SFX kuralını ekle
      const { DEFAULT_STYLE } = require("./src/model/rules");
      const gb = this.settings.global.base || {};
      if (Object.keys(DEFAULT_STYLE).every((k) => gb[k] === undefined || gb[k] === DEFAULT_STYLE[k])) this.settings.global.base = {};
      for (const p of this.settings.profiles) if (!(p.rules || []).some((r) => (r.types || []).includes("sfx"))) (p.rules = p.rules || []).push(profiles.defaultSfxRule());
      this.settings.migrations.sfxLook = true;
      this.saveSettings();
    }
    this.store = new Store();
    this.store.settings = this.settings;
    this.client = new ToriiClient(() => storage.getSecret("torii_api_key"));
    this.client.onCredits = (c) => { $("credits").textContent = (Math.round(c * 100) / 100) + " kredi"; $("creditPill").classList.add("live"); const b = $("creditsBig"); if (b) b.textContent = String(c); };
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
    this.pipeline.firefly = this.firefly;
    this.ops = new Ops(this.store, this.pipeline, {});
    this.store._persistFn = (s) => this.persistSession(s);
    this.list = new ItemList($("list"), this.store, {
      onSelect: (it) => { this.ops.selectItemLayer(it).catch(() => {}); this.editor.render(); },
      onOpenEditor: () => this.setView("editor"),
      filterAllows: (it) => this.pipeline.filtersAllow(it),
      onDelete: (ids) => this.askDelete(ids),
    });
    this.editor = new Editor($("editor"), this);
    this.store.on("change", () => { this.list.render(); this.editor.render(); this.renderHeader(); });
    this.store.on("selection", (e) => { this.list.render(); this.editor.render(); if (e.fromPs && this.isNarrow()) this.setView("editor"); });
    this.store.on("pending", () => this.renderHeader());
    this.wireUi();
    this.listenPhotoshop();
    // Güvence: Photoshop belge değişimi olayını göndermezse de etkin belgeyi yakala (hafif kontrol, sn'de bir)
    if (!window.__MCS_PREVIEW) setInterval(() => {
      if (this.busyInfo || this._ensuring) return;
      const d = activeDoc();
      const cur = this.store.activeDocId;
      if ((d && (cur !== d.id || !this.store.session(d.id))) || (!d && cur != null)) {
        this._ensuring = true;
        this.onActiveDocChanged().catch(() => {}).finally(() => { this._ensuring = false; });
      }
    }, 1000);
    await this.onActiveDocChanged();
    if (this.hasKey) this.client.credits().catch(() => {});
    this.layout();
    log("info", "Panel hazır");
  },

  saveSettings: debounce(function () {
    const s = clone(App.settings);
    for (const p of s.profiles) for (const r of p.rules || []) delete r._open;
    storage.writeJson("settings.json", s).catch((e) => log("warn", "Ayarlar kaydedilemedi", e.message));
  }, 500),

  notify(msg, kind) {
    const el = $("status");
    el.textContent = msg; el.className = kind || "";
    el.title = msg;
    log(kind === "error" ? "error" : "info", msg);
  },

  /** İşlem içindeki adım: çalışıyor satırında gösterilir (f: 0–1, bilinmiyorsa kayan çubuk). */
  progress(label, f) {
    const b = this.busyInfo;
    if (b) { if (label) b.step = label; b.frac = f > 0 ? f : null; this.tickBusy(); return; }
    $("progressBar").style.width = Math.round((f || 0) * 100) + "%";
    $("progressBar").style.left = "0px";
  },

  /** İşlem başladı/bitti — tüm işlemler (alt düğmeler, editör, sekmeler) buradan geçer. */
  onBusy(on, name, info) {
    const app = $("app");
    if (on) {
      this.busyInfo = { name, step: name + "…", t0: Date.now(), frame: 0, frac: null };
      app.classList.add("busy");
      $("btnFull").textContent = "Çalışıyor…";
      for (const id of ["btnDetect", "btnClean", "btnTranslate", "btnTypeset", "btnFull"]) setDisabled($(id), true);
      $("status").textContent = ""; $("status").className = "";
      clearInterval(this.busyTimer);
      this.busyTimer = setInterval(() => this.tickBusy(), 160);
      this.tickBusy();
    } else {
      clearInterval(this.busyTimer); this.busyTimer = null;
      this.busyInfo = null;
      app.classList.remove("busy");
      $("btnFull").textContent = "▶  Tam İşlem";
      for (const id of ["btnDetect", "btnClean", "btnTranslate", "btnTypeset", "btnFull"]) setDisabled($(id), false);
      const bar = $("progressBar");
      bar.style.left = "0px"; bar.style.width = info && info.ok ? "100%" : "0";
      setTimeout(() => { if (!this.busyInfo) bar.style.width = "0"; }, 1800);
      const sec = info ? Math.round(info.ms / 100) / 10 : 0;
      const st = $("status");
      // İşlem kendi sonuç mesajını yazdıysa onu koru, başına "✓ Bitti" ekle
      if (info && info.ok) { st.textContent = `✓ ${name} bitti · ${sec} sn${st.textContent ? " — " + st.textContent : ""}`; st.className = "done"; }
      this.list.render(); this.editor.render(); this.renderHeader();
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

  scope() { return this.settings.ui.scope || "page"; },

  // ------------------------------------------------------------------ UI
  wireUi() {
    const S = this.settings;
    for (const b of qsa(".tab")) activate(b, () => this.showTab(b.getAttribute("data-tab")));
    for (const b of qsa("#viewSeg .opt")) activate(b, () => this.setView(b.getAttribute("data-view")));
    for (const o of qsa("#scopeSeg .opt")) activate(o, () => { S.ui.scope = o.getAttribute("data-scope"); this.saveSettings(); this.renderScope(); });
    for (const c of qsa("[data-filter]")) {
      const k = c.getAttribute("data-filter");
      activate(c, () => {
        if (S.ui.bubblesOnly) return;
        S.ui.filters[k] = !S.ui.filters[k]; this.saveSettings(); this.renderFilters(); this.list.render();
      });
    }
    activate($("bubblesOnly"), () => {
      S.ui.bubblesOnly = !S.ui.bubblesOnly;
      if (S.ui.bubblesOnly) this.notify("Sadece Balonlar: yalnızca ONAYLANAN diyalog balonları çevrilir, temizlenir ve dizilir. Diğer pikseller değişmez.", "info");
      this.saveSettings(); this.list.render(); this.renderFilters(); this.editor.render();
    });
    $("profileSel").addEventListener("change", () => this.setProfile($("profileSel").value));
    const run = (fn) => async () => { if (this.busyInfo) { this.notify("Bir işlem zaten sürüyor — bitmesini bekleyin.", "warn"); return; } await fn(); };
    activate($("btnDetect"), run(() => this.pipeline.detect(this.scope())));
    activate($("btnClean"), run(() => this.pipeline.clean(this.scope())));
    activate($("btnTranslate"), run(() => this.pipeline.translate(this.scope())));
    activate($("btnTypeset"), run(() => this.pipeline.typeset(this.scope())));
    activate($("btnFull"), run(() => this.pipeline.full(this.scope())));
    activate($("btnStop"), () => { this.pipeline.cancelRequested = true; this.notify("Durdurma istendi: mevcut sayfa bitince durulacak.", "warn"); });
    this.renderListToolbar();
    this.wireSplitter();
    window.addEventListener("resize", debounce(() => this.layout(), 80));
    window.addEventListener("focus", () => this.ops.syncContentFromPs().catch(() => {}));
    this.renderFilters();
    this.renderScope();
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
    for (const o of qsa("#scopeSeg .opt")) o.classList.toggle("on", o.getAttribute("data-scope") === this.scope());
  },

  renderFilters() {
    const S = this.settings;
    const bo = S.ui.bubblesOnly;
    for (const c of qsa("[data-filter]")) {
      const k = c.getAttribute("data-filter");
      c.classList.toggle("on", bo ? k === "dialog" : !!S.ui.filters[k]);
      c.classList.toggle("disabled", bo);
    }
    $("bubblesOnly").classList.toggle("on", !!bo);
  },

  renderListToolbar() {
    const tb = clear($("listToolbar"));
    const act = (fn) => async () => { try { await fn(); } catch (e) { this.notify(e.message, "error"); } };
    tb.appendChild(h("button", { class: "mini", title: "Tüm önerilen türleri onayla", onclick: () => { for (const it of this.store.items()) it.typeConfirmed = true; this.store.touch(); } }, "✓ Türleri onayla"));
    tb.appendChild(h("button", { class: "mini", title: "Eksik balonu Photoshop'ta seçip yalnız o bölgeyi okut", onclick: act(() => this.pipeline.detect("region")) }, "⌖ Seçimi okut"));
    tb.appendChild(h("button", { class: "mini", title: "Diyalog / Anlatım / Balon dışı / SFX türlerini zemin piksellerine göre yeniden öner (kredisiz; onaylı türlere dokunmaz)", onclick: act(() => this.pipeline.reclassify()) }, "◑ Türleri yeniden öner"));
    tb.appendChild(h("button", { class: "mini quiet", title: "Metin aracıyla yapılan değişiklikleri al", onclick: act(() => this.ops.syncContentFromPs()) }, "↻ Eşitle"));
    tb.appendChild(h("button", { class: "mini quiet danger", title: "Seçili öğeleri sil (Delete tuşu)", onclick: () => this.askDelete([...this.store.selected]) }, "✕ Seçilenleri sil"));
    tb.appendChild(h("button", { class: "mini quiet danger", title: "Bu sayfadaki tüm öğeleri sil", onclick: () => this.askDelete(this.store.items().map((i) => i.id), true) }, "Listeyi temizle"));
  },

  /** Silme onayı: yalnız listeden mi, eklentinin katmanlarıyla birlikte mi? */
  async askDelete(ids, all) {
    if (!ids || !ids.length) return this.notify("Silinecek öğe seçilmedi. Listeden öğe seçin (Ctrl/Shift ile çoklu seçim).", "warn");
    const n = ids.length;
    const withLayers = this.store.items().filter((i) => ids.includes(i.id) && (i.layerId != null || i.cleanLayerId != null)).length;
    const msg = `${all ? "Sayfadaki tüm öğeler" : n + " öğe"} silinecek.` + (withLayers ? `<br><br>${withLayers} öğenin Photoshop'ta çeviri/temizlik katmanı var. <b>Katmanlarıyla sil</b> derseniz bu katmanlar da silinir (orijinal görsele dokunulmaz). Geri almak için Photoshop'ta Ctrl+Z.` : "");
    const buttons = withLayers ? ["Katmanlarıyla sil", "Yalnız listeden kaldır", "İptal"] : ["Sil", "İptal"];
    const c = await dialogs.confirm("Öğeleri sil", msg, buttons);
    if (c === buttons.length - 1) return;
    try {
      const k = await this.ops.deleteItems(ids, withLayers ? c === 0 : false);
      this.notify(`${k} öğe silindi${withLayers && c === 0 ? " (katmanlarıyla)" : ""}.`, "ok");
    } catch (e) { this.notify(e.message, "error"); }
  },

  setBusy(b) { for (const id of ["btnDetect", "btnClean", "btnTranslate", "btnTypeset", "btnFull"]) setDisabled($(id), b); },

  showTab(name) {
    this.currentTab = name;
    for (const b of qsa(".tab")) b.classList.toggle("active", b.getAttribute("data-tab") === name);
    for (const p of qsa(".pane")) p.classList.toggle("active", p.getAttribute("data-pane") === name);
    const pane = document.querySelector(`.pane[data-pane="${name}"]`);
    if (name === "profile") tabs.renderProfile(pane, this);
    else if (name === "chapter") tabs.renderChapter(pane, this);
    else if (name === "clean") tabs.renderClean(pane, this);
    else if (name === "tools") tabs.renderTools(pane, this);
    else if (name === "settings") tabs.renderSettings(pane, this);
    else if (name === "log") tabs.renderLog(pane);
  },

  isNarrow() { return document.body.clientWidth < 540; },
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
    for (const b of qsa("#viewSeg .opt")) b.classList.toggle("on", b.getAttribute("data-view") === v);
  },

  renderHeader() {
    const s = this.store.active;
    const pend = this.store.pending.length;
    $("docTitle").textContent = s ? s.title : "Belge açık değil";
    if (s) {
      const it = s.state.items;
      const done = it.filter((i) => i.status.typeset).length;
      $("docMeta").textContent = `${it.length} öğe · ${it.filter((i) => i.status.translated).length} çevrildi · ${done} dizildi${pend ? ` · ${pend} bekleyen sonuç` : ""}`;
    } else $("docMeta").textContent = "Photoshop'ta bir sayfa açın";
    const lt = $("listTitle");
    if (lt) lt.textContent = s ? `ÖĞELER · ${s.state.items.length}` : "ÖĞELER";
    const sel = $("profileSel");
    clear(sel);
    const cur = this.pipeline.profile(s && s.state);
    for (const p of this.settings.profiles) { const o = h("option", { value: p.id }, p.name); if (p.id === cur.id) o.setAttribute("selected", ""); sel.appendChild(o); }
    sel.value = cur.id;
  },

  setProfile(id) {
    const s = this.store.active;
    if (s) { s.state.profileId = id; this.store.touch(s.docId); }
    this.settings.activeProfileId = id;
    this.saveSettings();
    this.renderHeader();
    if (this.currentTab !== "items") this.showTab(this.currentTab);
    this.editor.render();
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

  // ------------------------------------------------------------------ Temizlik araçları
  async compareMethods() {
    const sel = this.store.selectedItems();
    if (!sel.length) return this.notify("Önce listeden öğe seçin.", "warn");
    const rows = [];
    for (const method of ["flat", "torii"]) {
      const t0 = Date.now();
      const plan = await this.pipeline.clean("selected", { method, force: true, dryRun: true });
      if (!plan) continue;
      for (const p of plan) rows.push({ item: p.item ? "#" + p.item.order : "seçim", kind: p.stats.kind, method, m: p.metrics || {}, ms: p.ms != null ? p.ms : Date.now() - t0, cost: p.cost });
    }
    const auto = await this.pipeline.clean("selected", { method: "auto", force: true, decideOnly: true });
    const tbl = h("table", { class: "metrics" }, h("tr", null, ...["Öğe", "Zemin", "Yöntem", "Yazı izi ↓", "Çizgi kırılması ↓", "Maske dışı", "Süre ms", "Kredi"].map((x) => h("th", null, x))),
      ...rows.map((r) => h("tr", null, h("td", null, r.item), h("td", null, r.kind), h("td", null, r.method), h("td", null, String(r.m.residual)), h("td", null, String(r.m.lineBreak)), h("td", null, String(r.m.outsideChanged)), h("td", null, String(r.ms)), h("td", null, r.cost != null ? r.cost.toFixed(3) : "—"))));
    const autoTxt = (auto || []).map((p) => `${p.item ? "#" + p.item.order : "seçim"}: ${p.decision.method} — ${p.decision.reason}`).join("\n");
    await dialogs.show("Yöntem karşılaştırma", [tbl, h("p", { class: "small" }, "Otomatik seçim:"), h("div", { class: "log" }, autoTxt)], ["Kapat"], { width: 640, height: 480 });
  },

  async generateImage(prompt) {
    const d = activeDoc();
    if (!d) throw new Error("Açık belge yok");
    if (!prompt) throw new Error("Açıklama girin.");
    const t = this.pipeline.captureTarget();
    this.progress("Firefly görsel üretiyor…", 0.3);
    const r = await this.firefly.generate(prompt, Math.min(2048, t.w), Math.min(2048, t.h));
    const dec = r.mime === "image/png" ? png.decodePng(r.bytes) : await modal("Görseli çöz", () => pixels.decodeViaPhotoshop(r.bytes, "jpg"), {});
    await this.pipeline.applyOrDefer(t, "Üretilen görsel", async (sess) => {
      await modal("Görsel üret", async () => {
        const g = await this.pipeline.ensureStructure(t);
        const id = await docs.makePixelLayerIn(t.docId, g.clean, "Üretilen: " + prompt.slice(0, 30));
        const rgba = png.convertChannels(dec.data, dec.width, dec.height, dec.channels, 4);
        await pixels.writeLayerPixels(t.docId, id, rgba, dec.width, dec.height, 0, 0);
      }, { documentID: t.docId, historyName: "Firefly görsel" });
    });
    this.progress("", 0);
    this.notify("Üretilen görsel ayrı katman olarak eklendi.", "ok");
  },
};

entrypoints.setup({
  panels: {
    mainPanel: {
      show() { App.ops && App.ops.syncContentFromPs().catch(() => {}); },
    },
  },
});

App.init().catch((e) => { log("error", "Başlatma hatası", e && e.stack ? e.stack : String(e)); const st = document.getElementById("status"); if (st) { st.textContent = "Başlatma hatası: " + e.message; st.className = "error"; } });
window.MCS = App; // hata ayıklama için (UDT konsolu)
