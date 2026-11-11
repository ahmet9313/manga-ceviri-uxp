// Panel editörü işlemleri ve Photoshop ↔ panel eşitleme.
"use strict";
const { app, core, constants, bp, modal, getDoc, findLayer, activeDoc, selectLayer, getDocProp, unitValue } = require("./ps/api");
const text = require("./ps/text");
const docs = require("./ps/document");
const geom = require("./util/geom");
const { log } = require("./util/common");

class Ops {
  constructor(store, pipeline, hooks) { this.store = store; this.pipeline = pipeline; this.hooks = hooks; }

  ctx() {
    const d = activeDoc();
    if (!d) throw new Error("Açık belge yok");
    const s = this.store.session(d.id);
    if (!s) throw new Error("Belge panele yükleniyor — bir saniye sonra tekrar deneyin.");
    return { d, s, docId: d.id };
  }

  /**
   * Toplu işlem (Tam İşlem, Dizgi, bölüm…) sürüyor mu? Sürerken panelin Photoshop'a yazan işlemleri çalıştırılmaz:
   * modal() iç içe çağrıyı aynı bağlamda yürüttüğü için işlemin "katmanı seç → etkin katmana uygula" çiftlerinin
   * arasına girer ve yanlış katmanı değiştirirdi. Photoshop olayları da (işlemin kendi katman seçimleri) yok sayılır.
   */
  get busy() { return !!(this.pipeline && this.pipeline.busy); }
  assertIdle() { if (this.busy) throw new Error(`"${this.pipeline.busyName || "İşlem"}" sürüyor — bitince tekrar deneyin.`); }

  /** Panelden öğe seçilince Photoshop'ta katmanı seç. */
  async selectItemLayer(item) {
    if (this.busy) return false;
    const { d, docId } = this.ctx();
    const id = item.layerId != null && findLayer(d, item.layerId) ? item.layerId : item.cleanLayerId != null && findLayer(d, item.cleanLayerId) ? item.cleanLayerId : null;
    if (id == null) return false;
    this._suppressSelectEvent = Date.now();
    await modal("Katmanı seç", () => selectLayer(id, false), {});
    return true;
  }

  /** Photoshop'taki etkin katman(lar)ı panel seçimine yansıt. */
  syncSelectionFromPs() {
    // İşlem sürerken gelen seçim olayları işlemin kendi katman seçimleridir; panel seçimini değiştirirlerse
    // "Seçili" kapsamındaki sonraki adımlar (ör. Tam İşlem'de dizgi) yanlış öğelerle çalışır.
    if (this.busy) return;
    if (this._suppressSelectEvent && Date.now() - this._suppressSelectEvent < 600) return;
    const d = activeDoc();
    if (!d) return;
    const ids = [];
    for (const L of d.activeLayers || []) {
      const it = this.store.itemByLayer(L.id, d.id);
      if (it) ids.push(it.id);
    }
    if (ids.length) this.store.select(ids, { fromPs: true });
  }

  /** Metin aracıyla yapılan değişiklikleri ve silinen/geri alınan katmanları panele yansıt. */
  async syncContentFromPs(onlyItemIds) {
    // İşlem sürerken eşitleme yok: dizgi katmana yeni metni yazmış ama lastApplied'ı henüz güncellememişken
    // okursak işlemin kendi yazdığı metni "kullanıcı elle değiştirdi" sanarız. İşlem bitince bir kez eşitlenir.
    if (this.busy) return 0;
    const d = activeDoc();
    if (!d) return 0;
    const s = this.store.session(d.id);
    if (!s) return 0;
    let changed = 0;
    for (const it of s.state.items) {
      if (onlyItemIds && !onlyItemIds.includes(it.id)) continue;
      if (it.layerId == null) continue;
      const L = findLayer(d, it.layerId);
      const missing = !L;
      if (missing !== !!it.layerMissing) { it.layerMissing = missing; changed++; }
      if (missing || String(L.kind) !== "text") continue;
      let cur;
      try { cur = await text.readTextLayer(d.id, it.layerId); } catch (e) { continue; }
      it.live = cur; // editörde gösterilecek güncel biçim
      const la = it.lastApplied || {};
      if (la.contents !== undefined && cur.contents !== la.contents) {
        // Metin değişince mürekkep sınırı da değişir: sınır birlikte güncellenir (yoksa sonraki dizgi "taşındı" sanıp kilitler)
        la.contents = cur.contents; la.bounds = cur.bounds; it.lastApplied = la;
        // Katmandaki metin panelin yazdığı metinse (olduğu gibi ya da BÜYÜK HARF hali) elle düzenleme değildir
        if (!text.matchesTranslation(cur.contents, it.translation, it.source)) { it.translation = cur.contents; it.translationEdited = true; changed++; }
      }
    }
    if (changed) this.store.touch(d.id, { reason: "ps-sync" });
    else this.store.emit("change", { docId: d.id, reason: "live" });
    return changed;
  }

  /** Mevcut bir Photoshop metin katmanını öğeyle eşleştir. */
  async linkActiveLayer(itemId) {
    this.assertIdle();
    const { d, s, docId } = this.ctx();
    const L = d.activeLayers[0];
    if (!L || String(L.kind) !== "text") throw new Error("Önce Photoshop'ta bir METİN katmanı seçin.");
    const other = this.store.itemByLayer(L.id, docId);
    if (other && other.id !== itemId) throw new Error(`Bu katman zaten #${other.order} öğesine bağlı.`);
    const it = this.store.item(itemId, docId);
    const cur = await text.readTextLayer(docId, L.id);
    it.layerId = L.id; it.translation = cur.contents; it.translationEdited = true; it.status.typeset = true;
    it.lastApplied = Object.assign({}, cur);
    this.store.touch(docId, { reason: "link" });
  }

  /** Seçili metin katmanından yeni öğe oluştur (OCR'sız). */
  async itemFromActiveLayer() {
    this.assertIdle();
    const { d, s, docId } = this.ctx();
    const L = d.activeLayers[0];
    if (!L || String(L.kind) !== "text") throw new Error("Önce bir METİN katmanı seçin.");
    if (this.store.itemByLayer(L.id, docId)) throw new Error("Bu katman zaten bir öğeye bağlı.");
    const cur = await text.readTextLayer(docId, L.id);
    const b = cur.bounds;
    const poly = [[b.left, b.top], [b.right, b.top], [b.right, b.bottom], [b.left, b.bottom]];
    const it = {
      id: require("./util/common").uid("i_"), source: "", translation: cur.contents, type: "dialog", typeSuggested: "dialog", typeReasons: ["mevcut katmandan"], typeConfirmed: true, tone: "normal",
      direction: "left_to_right", polygon: poly, lines: [poly], box: geom.polygonToBox(poly), bounds: b, ocr: {}, locks: { text: false, style: false, position: false }, manual: {},
      status: { detected: false, translated: true, cleaned: false, typeset: true }, layerId: L.id, translationEdited: true, lastApplied: cur, order: s.state.items.length + 1,
    };
    s.state.items.push(it);
    this.store.touch(docId, { reason: "link" });
    return it;
  }

  // ---------------- Alan düzenleme (tek geçmiş adımı) ----------------
  async setTranslation(itemId, value) {
    const { docId } = this.ctx();
    const it = this.store.item(itemId, docId);
    it.translation = value; it.translationEdited = true; it.status.translated = true;
    // İşlem sürerken yalnızca panel verisi güncellenir (yazılan metin kaybolmaz); katman bir sonraki dizgide eşitlenir
    if (!this.busy && it.layerId != null && findLayer(getDoc(docId), it.layerId)) {
      const st = this.pipeline.resolveFor(this.store.session(docId).state, it).style;
      await modal("Metni güncelle", async () => {
        await text.setContents(docId, it.layerId, value, st.uppercase, it.source);
        it.lastApplied = Object.assign({}, it.lastApplied, { contents: st.uppercase ? text.trUpper(value, it.source) : value }, text.layerBounds(docId, it.layerId));
      }, { documentID: docId, historyName: `#${it.order} metin` });
    }
    this.store.touch(docId);
  }

  setField(itemId, field, value) {
    const { docId } = this.ctx();
    const it = this.store.item(itemId, docId);
    it[field] = value;
    if (field === "source") it.sourceEdited = true;
    if (field === "type") { it.typeConfirmed = true; if (value === "sfx" || value === "offbubble") it.bubble = null; }
    if (field === "tone") it.toneEdited = true;
    this.store.touch(docId);
  }

  toggleLock(itemId, kind) {
    const { docId } = this.ctx();
    const it = this.store.item(itemId, docId);
    it.locks[kind] = !it.locks[kind];
    if (kind === "text" && !it.locks.text) it.translationEdited = false; // kilit kalkınca tekrar toplu işleme açık
    this.store.touch(docId);
  }

  /** Stil alanını manuel değer olarak kaydeder ve katmana uygular (diğer karakter biçimleri korunur). */
  async setStyleField(itemId, field, value) {
    this.assertIdle();
    const { docId } = this.ctx();
    const it = this.store.item(itemId, docId);
    if (value === null || value === "" || value === undefined) delete it.manual[field]; else it.manual[field] = value;
    const exists = it.layerId != null && findLayer(getDoc(docId), it.layerId);
    if (exists) {
      const st = this.pipeline.resolveFor(this.store.session(docId).state, it).style;
      await modal("Stil", async () => {
        const one = {}; one[field] = st[field];
        if (["font", "color", "tracking", "align", "fauxBold", "fauxItalic", "sizePx", "leadingPct"].includes(field)) await text.applyStyle(docId, it.layerId, one);
        else if (field.startsWith("stroke") || field.startsWith("shadow")) await text.setStrokeShadow(docId, it.layerId, { strokeEnabled: !!st.strokeEnabled, strokeSize: st.strokeSize, strokeColor: st.strokeColor, shadowEnabled: !!st.shadowEnabled, shadowColor: st.shadowColor, shadowDistance: st.shadowDistance, shadowSize: st.shadowSize });
        else if (field === "warpStyle" || field === "warpBend") await text.setWarp(docId, it.layerId, st.warpStyle, st.warpBend);
        else if (field === "uppercase") await text.setContents(docId, it.layerId, it.translation, st.uppercase, it.source);
        it.lastApplied = await this.pipeline.snapshotLayer({ docId }, it.layerId);
      }, { documentID: docId, historyName: `#${it.order} ${field}` });
    }
    this.store.touch(docId);
  }

  /** Metin kutusunu yeniden boyutlandır (yazı ölçeklenmez). */
  async resizeBox(itemId, w, h) {
    this.assertIdle();
    const { docId } = this.ctx();
    const it = this.store.item(itemId, docId);
    await modal("Kutu boyutu", async () => { await text.ensureParagraph(docId, it.layerId); await text.resizeBox(docId, it.layerId, w, h); }, { documentID: docId, historyName: `#${it.order} kutu boyutu` });
    it.manualBox = Object.assign({}, it.manualBox, { w, h });
    this.refreshAppliedBounds(it, docId);
    this.store.touch(docId);
  }

  /** Panel katmanın sınırını değiştirdi: lastApplied'daki sınır güncellenir (sonraki dizgi bunu elle taşıma sanmasın). */
  refreshAppliedBounds(it, docId) {
    if (it.lastApplied) Object.assign(it.lastApplied, text.layerBounds(docId, it.layerId));
  }

  /** Katmanı ölçekle (dönüşüm) — kutu boyutlandırmadan ayrı. */
  async scaleLayer(itemId, pct) {
    this.assertIdle();
    const { docId } = this.ctx();
    const it = this.store.item(itemId, docId);
    await modal("Ölçekle", () => text.scaleLayer(docId, it.layerId, pct), { documentID: docId, historyName: `#${it.order} ölçek %${pct}` });
    it.locks.position = true;
    this.refreshAppliedBounds(it, docId);
    this.store.touch(docId);
  }

  async rotateTo(itemId, angle) {
    this.assertIdle();
    const { docId } = this.ctx();
    const it = this.store.item(itemId, docId);
    await modal("Döndür", () => text.rotateTo(docId, it.layerId, angle), { documentID: docId, historyName: `#${it.order} döndür` });
    it.manualBox = Object.assign({}, it.manualBox, { angle });
    this.refreshAppliedBounds(it, docId);
    this.store.touch(docId);
  }

  async moveTo(itemId, cx, cy) {
    this.assertIdle();
    const { docId } = this.ctx();
    const it = this.store.item(itemId, docId);
    await modal("Taşı", () => text.moveCenterTo(docId, it.layerId, cx, cy), { documentID: docId, historyName: `#${it.order} konum` });
    it.locks.position = true;
    this.refreshAppliedBounds(it, docId);
    this.store.touch(docId);
  }

  async refit(itemId) {
    this.assertIdle();
    const { docId, s } = this.ctx();
    const it = this.store.item(itemId, docId);
    const st = this.pipeline.resolveFor(s.state, it).style;
    await modal("Balona sığdır", async () => {
      await this.pipeline.fitItem({ docId }, it, st, this.pipeline.typesetBox(it));
      it.lastApplied = await this.pipeline.snapshotLayer({ docId }, it.layerId);
    }, { documentID: docId, historyName: `#${it.order} sığdır` });
    this.store.touch(docId);
    return it.overflow;
  }

  /** Katman sırasını değiştir (liste sırası ve tuval konumundan bağımsız). */
  async layerOrder(itemId, dir) {
    this.assertIdle();
    const { docId } = this.ctx();
    const it = this.store.item(itemId, docId);
    await modal("Katman sırası", async () => {
      await selectLayer(it.layerId);
      await bp({ _obj: "move", _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }], to: { _ref: "layer", _enum: "ordinal", _value: dir > 0 ? "next" : "previous" } });
    }, { documentID: docId, historyName: `#${it.order} katman sırası` });
  }

  /** SFX: düzenlenebilir metin kaynağı gizli "SFX Kaynak" grubunda korunur, görünen kopya rasterleştirilir. */
  async rasterizeSfx(itemId) {
    this.assertIdle();
    const { d, docId, s } = this.ctx();
    const it = this.store.item(itemId, docId);
    if (it.layerId == null || !findLayer(d, it.layerId)) throw new Error("Önce dizgi yapın.");
    await modal("SFX rasterleştir", async () => {
      const src = findLayer(d, it.sourceTextLayerId) || null;
      const textLayer = src || findLayer(d, it.layerId);
      if (!src) {
        // Kaynağı sakla
        let g = d.layers.flatMap((l) => [l, ...(l.layers || [])]).find((l) => l.name === docs.GROUP_NAMES.sfxSrc);
        if (!g) {
          await selectLayer(s.state.groups.trans);
          await bp({ _obj: "make", _target: [{ _ref: "layerSection" }], using: { _obj: "layerSection", name: docs.GROUP_NAMES.sfxSrc } });
          g = d.activeLayers[0];
          await bp({ _obj: "hide", null: [{ _ref: "layer", _id: g.id }] });
        }
        const dup = await textLayer.duplicate(g, constants.ElementPlacement.PLACEINSIDE);
        it.sourceTextLayerId = (dup && dup.id) || d.activeLayers[0].id;
        await bp({ _obj: "rasterizeLayer", _target: [{ _ref: "layer", _id: it.layerId }] });
      } else {
        // Kaynaktan yeniden oluştur
        await bp({ _obj: "delete", _target: [{ _ref: "layer", _id: it.layerId }] });
        const dup = await src.duplicate(findLayer(d, s.state.groups.trans), constants.ElementPlacement.PLACEINSIDE);
        const nid = (dup && dup.id) || d.activeLayers[0].id;
        await bp({ _obj: "show", null: [{ _ref: "layer", _id: nid }] });
        await bp({ _obj: "rasterizeLayer", _target: [{ _ref: "layer", _id: nid }] });
        it.layerId = nid;
      }
      it.rasterized = true;
      await this.pipeline.persistInModal(s);
    }, { documentID: docId, historyName: `#${it.order} SFX raster` });
    this.store.touch(docId, { noPersist: true });
  }

  /** Birden çok öğeyi siler; alsoLayers → eklentinin oluşturduğu çeviri/temizlik katmanları da (tek geçmiş adımı). */
  async deleteItems(ids, alsoLayers) {
    this.assertIdle();
    const { d, docId, s } = this.ctx();
    const set = new Set(ids);
    const victims = s.state.items.filter((x) => set.has(x.id));
    if (!victims.length) return 0;
    await modal("Öğeleri sil", async () => {
      if (alsoLayers) {
        for (const it of victims) for (const id of [it.layerId, it.cleanLayerId, it.sourceTextLayerId]) {
          if (id != null && findLayer(d, id) && !s.state.items.some((o) => !set.has(o.id) && (o.cleanLayerId === id || o.layerId === id))) await docs.deleteLayer(docId, id);
        }
      }
      s.state.items = s.state.items.filter((x) => !set.has(x.id));
      s.state.items.forEach((x, i) => { x.order = i + 1; });
      await this.pipeline.persistInModal(s);
    }, { documentID: docId, historyName: `${victims.length} öğe silindi${alsoLayers ? " (katmanlarıyla)" : ""}` });
    this.store.selected = new Set([...this.store.selected].filter((x) => !set.has(x)));
    this.store.touch(docId, { noPersist: true });
    return victims.length;
  }

  async deleteItem(itemId, alsoLayers) {
    this.assertIdle();
    const { d, docId, s } = this.ctx();
    const it = this.store.item(itemId, docId);
    if (alsoLayers) {
      await modal("Öğeyi sil", async () => {
        for (const id of [it.layerId, it.cleanLayerId, it.sourceTextLayerId]) if (id != null && findLayer(d, id)) await docs.deleteLayer(docId, id);
        s.state.items = s.state.items.filter((x) => x.id !== itemId);
        s.state.items.forEach((x, i) => { x.order = i + 1; });
        await this.pipeline.persistInModal(s);
      }, { documentID: docId, historyName: `#${it.order} sil` });
      this.store.touch(docId, { noPersist: true });
    } else {
      s.state.items = s.state.items.filter((x) => x.id !== itemId);
      s.state.items.forEach((x, i) => { x.order = i + 1; });
      this.store.touch(docId);
    }
  }

  // ---------------- Tuval sürükleme oturumu (önizleme + tek geçmiş adımı) ----------------
  /**
   * kind: 'move' | 'rotate' | 'box'. Döner: {update(dxCss, dyCss), commit(), cancel()}
   * Tüm sürükleme tek modal + suspendHistory içinde: bırakınca TEK adım, Esc/odak kaybı → başlangıca dönüş.
   */
  async beginDrag(itemId, kind) {
    this.assertIdle();
    const { d, docId } = this.ctx();
    const it = this.store.item(itemId, docId);
    if (it.layerId == null || !findLayer(d, it.layerId)) throw new Error("Bu öğenin metin katmanı yok.");
    const view = await this.viewInfo(docId);
    const startInfo = await text.readTextLayer(docId, it.layerId);
    const queue = [];
    let wake = null, finished = false, target = { dx: 0, dy: 0 }, applied = { dx: 0, dy: 0, rot: 0, bw: startInfo.boxW, bh: startInfo.boxH };
    const push = (m) => { queue.push(m); if (wake) { const w = wake; wake = null; w(); } };
    const next = () => (queue.length ? Promise.resolve(queue.shift()) : new Promise((r) => { wake = () => r(queue.shift()); }));
    const names = { move: "taşı", rotate: "döndür", box: "kutu boyutu" };
    const done = modal("Sürükle: " + names[kind], async (ctx) => {
      const sid = await ctx.hostControl.suspendHistory({ documentID: docId, name: `#${it.order} ${names[kind]}` });
      try {
        for (;;) {
          let m = await next();
          // Biriken hareketleri birleştir (yalnız sonuncusu uygulanır)
          while (queue.length && queue[0].type === "update" && m.type === "update") m = queue.shift();
          if (m.type === "update") {
            target = m;
            const [ddx, ddy] = geom.screenDeltaToDoc(m.dx, m.dy, view);
            const L = findLayer(getDoc(docId), it.layerId);
            if (kind === "move") {
              const mx = ddx - applied.dx, my = ddy - applied.dy;
              if (Math.abs(mx) >= 0.5 || Math.abs(my) >= 0.5) { await L.translate(mx, my); applied.dx += mx; applied.dy += my; }
            } else if (kind === "rotate") {
              const ang = Math.round(m.dx * 0.5);
              if (ang !== applied.rot) { await L.rotate(ang - applied.rot, constants.AnchorPosition.MIDDLECENTER); applied.rot = ang; }
            } else if (kind === "box") {
              const bw = Math.max(16, Math.round(startInfo.boxW + ddx)), bh = Math.max(12, Math.round(startInfo.boxH + ddy));
              if (bw !== applied.bw || bh !== applied.bh) { await text.resizeBox(docId, it.layerId, bw, bh); applied.bw = bw; applied.bh = bh; }
            }
          } else if (m.type === "commit") { await ctx.hostControl.resumeHistory(sid, true); return { committed: true, applied }; }
          else { await ctx.hostControl.resumeHistory(sid, false); return { committed: false }; }
        }
      } catch (e) {
        try { await ctx.hostControl.resumeHistory(sid, false); } catch (e2) { /* yok */ }
        throw e;
      }
    }, {});
    const self = this;
    return {
      update(dx, dy) { if (!finished) push({ type: "update", dx, dy }); },
      async commit() {
        if (finished) return; finished = true; push({ type: "commit" });
        const r = await done;
        if (r && r.committed) {
          if (kind === "move" || kind === "rotate") it.locks.position = true;
          if (kind === "box") it.manualBox = Object.assign({}, it.manualBox, { w: r.applied.bw, h: r.applied.bh });
          if (kind === "rotate") it.manualBox = Object.assign({}, it.manualBox, { angle: (startInfo.angle || 0) + r.applied.rot });
          self.refreshAppliedBounds(it, docId);
          self.store.touch(docId);
        }
      },
      async cancel() { if (finished) return; finished = true; push({ type: "cancel" }); try { await done; } catch (e) { /* yok */ } },
      done,
    };
  }

  /** Görünüm bilgisi: yakınlaştırma ve ekran ölçeği (dönüşümler geom.screenDeltaToDoc'ta tek yerde). */
  async viewInfo(docId) {
    let zoom = 1;
    try { zoom = unitValue(await getDocProp(docId, "zoom")) || 1; } catch (e) { /* varsayılan */ }
    let dpr = 1;
    try { dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1; } catch (e) { /* yok */ }
    return { zoom, devicePixelRatio: dpr, panelScale: 1 };
  }

  // ---------------- Photoshop Actions ----------------
  listActions() {
    try { return app.actionTree.map((set) => ({ name: set.name, actions: set.actions.map((a) => a.name) })); }
    catch (e) { return []; }
  }

  async playAction(setName, actionName) {
    this.assertIdle();
    const set = app.actionTree.find((s) => s.name === setName);
    const a = set && set.actions.find((x) => x.name === actionName);
    if (!a) throw new Error("Eylem bulunamadı");
    const d = activeDoc();
    await modal("Eylem: " + actionName, () => a.play(), d ? { documentID: d.id, historyName: "Eylem: " + actionName } : {});
  }

  // ---------------- Yerel araçlara geçiş ----------------
  async nativeTool(tool) {
    const map = { move: "moveTool", type: "typeCreateOrEditTool", lasso: "lassoTool", remove: "removeTool", heal: "spotHealingBrushTool", marquee: "marqueeRectTool" };
    try { await modal("Araç", () => bp({ _obj: "select", _target: [{ _ref: map[tool] || tool }] }), {}); return true; }
    catch (e) { log("warn", "Araç seçilemedi", e.message); return false; }
  }
}

module.exports = { Ops };
