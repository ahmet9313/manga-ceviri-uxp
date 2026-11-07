// Belge oturumları: öğe listesi, katman eşleşmeleri, kilitler, manuel değerler.
// Kalıcılık: PSD XMP (asıl) + eklenti veri klasöründe sayfa önbelleği (bölüm geneli arama/değiştirme için).
"use strict";
const { Emitter, uid, debounce, log, clone } = require("../util/common");
const storage = require("./storage");

const STATE_VERSION = 1;

function emptyState() {
  return { version: STATE_VERSION, docUid: uid("d_"), items: [], groups: {}, chainContext: "", chapterId: null, pageIndex: null, profileId: null, history: [], updatedAt: Date.now() };
}

class Store extends Emitter {
  constructor() {
    super();
    this.sessions = new Map(); // docId → {docId, title, state, dirty}
    this.activeDocId = null;
    this.selected = new Set();
    this.settings = null;
    this.pending = []; // başka belgeye ait bekleyen sonuçlar
    this._persistFn = null; // ui/app tarafından atanır (modal içinde XMP yazar)
    this.persistSoon = debounce(() => this.persistDirty(), 1500);
  }

  session(docId) { return this.sessions.get(docId == null ? this.activeDocId : docId) || null; }
  get active() { return this.session(this.activeDocId); }

  attach(docId, title, state) {
    let s = this.sessions.get(docId);
    if (!s) { s = { docId, title, state: state || emptyState(), dirty: false }; this.sessions.set(docId, s); }
    else { s.title = title; if (state) s.state = state; }
    if (!s.state.items) s.state.items = [];
    return s;
  }

  detach(docId) { this.sessions.delete(docId); if (this.activeDocId === docId) this.activeDocId = null; }

  findByUid(docUid) { for (const s of this.sessions.values()) if (s.state.docUid === docUid) return s; return null; }

  items(docId) { const s = this.session(docId); return s ? s.state.items : []; }
  item(id, docId) { return this.items(docId).find((i) => i.id === id) || null; }
  itemByLayer(layerId, docId) { return this.items(docId).find((i) => i.layerId === layerId || i.cleanLayerId === layerId) || null; }

  /** Değişikliği kaydet: durum kirli işaretlenir, UI güncellenir, gecikmeli kalıcılaştırılır. */
  touch(docId, opts) {
    const s = this.session(docId);
    if (!s) return;
    s.state.updatedAt = Date.now();
    s.dirty = true;
    this.emit("change", { docId: s.docId, reason: opts && opts.reason });
    if (!(opts && opts.noPersist)) this.persistSoon();
  }

  select(ids, opts) {
    this.selected = new Set(ids);
    this.emit("selection", { ids: [...this.selected], fromPs: !!(opts && opts.fromPs) });
  }

  selectedItems(docId) { return this.items(docId).filter((i) => this.selected.has(i.id)); }

  reorder(docId, fromIdx, toIdx) {
    const arr = this.items(docId);
    if (fromIdx < 0 || fromIdx >= arr.length || toIdx < 0 || toIdx >= arr.length || fromIdx === toIdx) return false;
    const [it] = arr.splice(fromIdx, 1);
    arr.splice(toIdx, 0, it);
    arr.forEach((x, i) => { x.order = i + 1; });
    this.touch(docId, { reason: "reorder" });
    return true;
  }

  async persistDirty() {
    for (const s of this.sessions.values()) {
      if (!s.dirty || !this._persistFn) continue;
      try { await this._persistFn(s); s.dirty = false; }
      catch (e) { log("warn", "Durum PSD'ye yazılamadı (daha sonra tekrar denenecek)", String(e.message)); }
    }
  }

  // ---- Sayfa önbelleği (bölüm işlemleri) ----
  async mirrorPage(s) {
    try {
      const snap = { docUid: s.state.docUid, title: s.title, path: s.path || null, chapterId: s.state.chapterId, pageIndex: s.state.pageIndex, items: s.state.items.map((i) => ({ id: i.id, order: i.order, type: i.type, source: i.source, translation: i.translation, locks: i.locks, layerId: i.layerId })), updatedAt: s.state.updatedAt };
      await storage.writeJson("page_" + s.state.docUid + ".json", snap);
    } catch (e) { /* önbellek isteğe bağlı */ }
  }
  async readMirror(docUid) { return storage.readJson("page_" + docUid + ".json", null); }

  // ---- Bekleyen sonuçlar ----
  addPending(entry) { entry.id = uid("pend_"); entry.createdAt = Date.now(); this.pending.push(entry); this.emit("pending"); return entry; }
  takePending(docUid) { const mine = this.pending.filter((p) => p.docUid === docUid); this.pending = this.pending.filter((p) => p.docUid !== docUid); if (mine.length) this.emit("pending"); return mine; }
}

/** Panelde gösterilen tek bir işlem kaydı (geri alma için değil, bilgi için). */
function pushHistory(state, entry) {
  state.history = state.history || [];
  state.history.push(Object.assign({ t: Date.now() }, clone(entry)));
  if (state.history.length > 50) state.history.shift();
}

module.exports = { Store, emptyState, pushHistory, STATE_VERSION };
