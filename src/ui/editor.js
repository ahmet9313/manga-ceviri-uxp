// Seçili öğenin editörü: özet kartı + açılır-kapanır bölümler (Metin, Tür ve kilitler, Biçim, Tuval, Katman ve temizlik).
"use strict";
const { h, clear, select, numberInput, checkbox, colorInput, card, emptyState } = require("./dom");
const { fontPicker } = require("./fontpicker");
const { ITEM_TYPES, TONES, STYLE_FIELDS, LEVEL_LABEL } = require("../model/rules");
const { METHODS } = require("../model/cleanup");

const TYPE_LABEL = { dialog: "Diyalog", narration: "Anlatım", offbubble: "Balon dışı", sfx: "SFX" };
const TONE_LABEL = { normal: "Normal", shout: "Bağırma", whisper: "Fısıltı", thought: "Düşünce" };
const STYLE_GROUPS = [
  ["Font", ["font", "fallbackFont"]],
  ["Boyut ve sığdırma", ["sizePx", "minSizePx", "maxSizePx", "fit", "paddingPct"]],
  ["Aralık ve hizalama", ["align", "leadingPct", "tracking"]],
  ["Renk ve stil", ["color", "fauxBold", "fauxItalic", "uppercase"]],
  ["Kontur ve gölge", ["strokeEnabled", "strokeSize", "strokeColor", "shadowEnabled", "shadowColor", "shadowDistance", "shadowSize"]],
  ["Warp", ["warpStyle", "warpBend"]],
];

class Editor {
  constructor(root, app) {
    this.root = root; this.app = app; this.itemId = null; this.deferred = false;
    // Kartların açık/kapalı durumu ayarlarda saklanır (ilerleyen açılım: ilk açılışta yalnız Metin ve Tür açık)
    const ui = app.settings.ui;
    ui.editorOpen = Object.assign({ text: true, meta: true, style: false, canvas: false, layer: false }, ui.editorOpen || {});
    Object.defineProperty(ui.editorOpen, "__save", { value: () => app.saveSettings(), enumerable: false });
    app.cardState = ui.editorOpen;
    // Yazarken yeniden çizim yok: odak editörden çıkınca bekleyen güncelleme uygulanır
    root.addEventListener("focusout", () => setTimeout(() => { if (this.deferred && !this.isTyping()) { this.deferred = false; this.render(); } }, 0));
  }

  isTyping() {
    const a = document.activeElement;
    if (!a) return false;
    const tag = (a.tagName || "").toLowerCase();
    if (tag !== "input" && tag !== "textarea" && tag !== "select") return false;
    let n = a;
    while (n && n !== this.root) n = n.parentNode;
    return n === this.root;
  }

  render() {
    const { store, pipeline } = this.app;
    const sel = store.selectedItems();
    // Aynı öğe düzenlenirken (odak bir alanda) editör yeniden kurulmaz → imleç/yazı kaybolmaz
    if (sel.length === 1 && sel[0].id === this.itemId && this.isTyping()) { this.deferred = true; return; }
    const scroll = this.root.scrollTop, sameItem = sel.length === 1 && sel[0].id === this.itemId;
    clear(this.root);
    if (!sel.length) {
      this.root.appendChild(emptyState("☐", "Öğe seçilmedi", "Listeden bir öğe seçin. Photoshop'ta bir çeviri katmanı seçtiğinizde de burada açılır."));
      return;
    }
    if (sel.length > 1) { this.renderMulti(sel); return; }
    const it = sel[0];
    this.itemId = it.id;
    const s = store.active;
    const resolved = pipeline.resolveFor(s.state, it);
    const live = it.live || it.lastApplied || {};
    const act = (fn) => async (...a) => { try { await fn(...a); } catch (e) { this.app.notify(e.message, "error"); } };
    const ops = this.app.ops;
    const cs = this.app.cardState;
    const hasLayer = it.layerId != null && !it.layerMissing;

    // ---- Özet kartı ----
    const layerStatus = it.layerId == null ? "Henüz dizilmedi" : it.layerMissing ? "Katman bulunamadı (geri alındı/silindi?)" : "Metin katmanı bağlı";
    this.root.appendChild(h("div", { class: "hero" },
      h("div", { class: "hero-top" },
        h("span", { class: "hero-num" }, "#" + String(it.order).padStart(2, "0")),
        h("span", { class: "pill " + it.type + (it.typeConfirmed ? "" : " unconfirmed") }, TYPE_LABEL[it.type] || it.type),
        it.tone && it.tone !== "normal" ? h("span", { class: "pill tone" }, TONE_LABEL[it.tone]) : null,
        h("span", { class: "hero-status" }, layerStatus)),
      it.overflow ? h("div", { class: "notice warn" }, "Yazı minimum puntoda bile balona sığmıyor. Kutuyu büyütün, metni kısaltın veya punto girin.") : null,
      resolved.warnings ? h("div", { class: "notice warn" }, resolved.warnings.join(" · ")) : null,
      h("div", { class: "row tight" },
        h("button", { class: "mini", onclick: act(async () => { store.select([it.id]); await pipeline.translate("selected", { force: true, forceEvenLocked: true }); }) }, "↻ Yeniden çevir"),
        h("button", { class: "mini", onclick: act(async () => { store.select([it.id]); await pipeline.clean("selected", { force: true }); }) }, "✦ Temizle"),
        h("button", { class: "mini", onclick: act(async () => { store.select([it.id]); await pipeline.typeset("selected", {}); }) }, "T Dizgi"),
        hasLayer ? h("button", { class: "mini quiet", onclick: act(() => ops.selectItemLayer(it)) }, "Katmanı seç") : null,
        h("button", { class: "mini quiet danger", title: "Öğeyi sil (Delete)", onclick: () => this.app.askDelete([it.id]) }, "✕ Sil"))));

    // ---- Metin ----
    const srcTa = h("textarea", { "aria-label": "Kaynak metin" }); srcTa.value = it.source || "";
    srcTa.addEventListener("change", () => ops.setField(it.id, "source", srcTa.value));
    const trTa = h("textarea", { "aria-label": "Çeviri", style: { height: "72px" } }); trTa.value = it.translation || "";
    trTa.addEventListener("change", act(() => ops.setTranslation(it.id, trTa.value)));
    this.root.appendChild(card("text", "Metin", it.translationEdited ? "elle düzenlendi" : "", [
      h("span", { class: "label-sm" }, "Çeviri"), trTa,
      h("span", { class: "label-sm" }, "Kaynak (OCR) — düzeltilebilir"), srcTa,
      h("div", { class: "hint" }, `${it.direction === "top_to_bottom" ? "Dikey yazı" : "Yatay yazı"} · dil ${it.sourceLang || "?"} · güven ${it.confidence != null ? Math.round(it.confidence * 100) + "%" : "—"}`),
    ], cs));

    // ---- Tür, sıra, kilitler ----
    this.root.appendChild(card("meta", "Tür, sıra ve kilitler", it.typeConfirmed ? "" : "öneri onay bekliyor", [
      h("div", { class: "field" }, h("label", null, "Öğe türü"), select(ITEM_TYPES, it.type, (v) => ops.setField(it.id, "type", v)),
        it.typeConfirmed ? h("span", { class: "small ok" }, "✓ onaylı") : h("button", { class: "mini", onclick: () => ops.setField(it.id, "type", it.type) }, "Onayla")),
      it.typeSuggested ? h("div", { class: "hint" }, `Öneri: ${TYPE_LABEL[it.typeSuggested]}${it.typeReasons ? " — " + it.typeReasons.join(", ") : ""}`) : null,
      h("div", { class: "field" }, h("label", null, "Ton"), select(TONES, it.tone || "normal", (v) => ops.setField(it.id, "tone", v))),
      h("div", { class: "field" }, h("label", null, "Okuma sırası"), numberInput(it.order, (v) => {
        const items = store.items(); const from = items.indexOf(it); const to = Math.max(0, Math.min(items.length - 1, (v || 1) - 1));
        if (store.reorder(store.activeDocId, from, to)) store.active.state.orderEdited = true;
      }, { min: 1 })),
      h("div", { class: "row tight", style: { marginTop: "4px" } },
        checkbox(it.locks.text, () => ops.toggleLock(it.id, "text"), "Metin kilidi"),
        checkbox(it.locks.style, () => ops.toggleLock(it.id, "style"), "Biçim kilidi"),
        checkbox(it.locks.position, () => ops.toggleLock(it.id, "position"), "Konum kilidi")),
    ], cs));

    // ---- Biçim ----
    const checks = this.app.settings.fontChecks || {};
    const fieldMap = {};
    for (const f of STYLE_FIELDS) fieldMap[f.key] = f;
    const styleNodes = [h("div", { class: "hint" }, "Öncelik: Manuel → Bölüm → Seri → Genel → Varsayılan. Turuncu etiket = sizin değeriniz (↺ ile kurala döner).")];
    for (const [gname, keys] of STYLE_GROUPS) {
      styleNodes.push(h("div", { class: "group-label" }, gname.toLocaleUpperCase("tr")));
      for (const key of keys) {
        const f = fieldMap[key];
        const v = resolved.style[key];
        const src = resolved.sources[key] || {};
        const set = act((val) => ops.setStyleField(it.id, key, val));
        let ctl;
        if (f.type === "font") ctl = fontPicker(v, set, checks, { noPreview: key !== "font" });
        else if (f.type === "number") ctl = numberInput(v, set, { min: f.min, max: f.max });
        else if (f.type === "bool") ctl = checkbox(v, set);
        else if (f.type === "color") ctl = colorInput(v, set);
        else if (f.type === "select") ctl = select(f.options, v, set);
        const tag = h("span", { class: "src-tag" + (src.level === "manual" ? " manual" : ""), title: src.rule ? "Kural: " + src.rule : src.label || "" }, (LEVEL_LABEL[src.level] || src.level || "") + (src.rule ? " · " + src.rule : ""));
        const reset = src.level === "manual" ? h("button", { class: "mini quiet", title: "Manuel değeri kaldır", onclick: act(() => ops.setStyleField(it.id, key, null)) }, "↺") : null;
        styleNodes.push(h("div", { class: "field" }, h("label", null, f.label), ctl, tag, reset));
      }
    }
    if (live && live.rangeCount > 1) styleNodes.push(h("div", { class: "hint" }, `Katmanda ${live.rangeCount} farklı karakter biçimi var; bir alan değişince diğerleri korunur.`));
    this.root.appendChild(card("style", "Biçim", (resolved.style.font || "") + " · " + Math.round(resolved.style.sizePx || 0) + " px", styleNodes, cs));

    // ---- Tuval ----
    if (hasLayer) {
      const b = live.bounds || it.bounds;
      const cx = b ? Math.round((b.left + b.right) / 2) : 0, cy = b ? Math.round((b.top + b.bottom) / 2) : 0;
      const ix = numberInput(cx, () => {}), iy = numberInput(cy, () => {});
      const bw = numberInput(live.boxW, () => {}), bh = numberInput(live.boxH, () => {});
      const sc = numberInput(100, () => {}, { min: 10, max: 1000 });
      const ang = numberInput(live.angle || 0, () => {}, { min: -360, max: 360 });
      const pad = (ico, label, kind) => {
        const el = h("div", { class: "pad", tabindex: "0", title: `Sürükleyin: ${label}. Bırakınca tek geçmiş adımı; Esc veya odak kaybı → başlangıca döner.` }, h("span", { class: "ico" }, ico), h("span", { class: "lbl" }, label));
        el.addEventListener("pointerdown", (e) => this.padDrag(e, el, it.id, kind));
        return el;
      };
      this.root.appendChild(card("canvas", "Tuval", "belge pikseli", [
        h("div", { class: "pads" }, pad("✥", "Taşı", "move"), pad("⟳", "Döndür", "rotate"), pad("▭", "Kutu", "box")),
        h("div", { class: "field" }, h("label", null, "Merkez X / Y"), ix, iy, h("button", { class: "mini", onclick: act(() => ops.moveTo(it.id, Number(ix.value), Number(iy.value))) }, "Taşı")),
        h("div", { class: "field" }, h("label", null, "Metin kutusu"), bw, bh, h("button", { class: "mini", title: "Yazı ölçeklenmez; yalnız kutu değişir", onclick: act(() => ops.resizeBox(it.id, Number(bw.value), Number(bh.value))) }, "Boyutlandır")),
        h("div", { class: "field" }, h("label", null, "Katman ölçeği %"), sc, h("button", { class: "mini", title: "Katman dönüşümü; kutu boyutlandırmadan ayrı", onclick: act(() => ops.scaleLayer(it.id, Number(sc.value))) }, "Ölçekle"),
          live.scalePct && live.scalePct !== 100 ? h("span", { class: "hint" }, `şu an %${live.scalePct}`) : null),
        h("div", { class: "field" }, h("label", null, "Açı°"), ang, h("button", { class: "mini", onclick: act(() => ops.rotateTo(it.id, Number(ang.value))) }, "Döndür")),
        h("div", { class: "row tight" },
          h("button", { class: "mini", onclick: act(() => ops.refit(it.id)) }, "Balona sığdır"),
          h("button", { class: "mini", title: "Photoshop Taşıma aracı; Ctrl+T ile Serbest Dönüştür", onclick: act(async () => { await ops.selectItemLayer(it); await ops.nativeTool("move"); this.app.notify("Taşıma aracı etkin — serbest dönüştürme için Ctrl+T.", "info"); }) }, "PS dönüştür"),
          h("button", { class: "mini", onclick: act(async () => { await ops.selectItemLayer(it); await ops.nativeTool("type"); }) }, "Metin aracı"),
          h("button", { class: "mini quiet", title: "Katman sırası (liste sırasından bağımsız)", onclick: act(() => ops.layerOrder(it.id, +1)) }, "Katman ↑"),
          h("button", { class: "mini quiet", onclick: act(() => ops.layerOrder(it.id, -1)) }, "Katman ↓")),
      ], cs));
    }

    // ---- Katman ve temizlik ----
    this.root.appendChild(card("layer", "Katman ve temizlik", it.cleanMethod ? (METHODS[it.cleanMethod] || {}).label : "temizlenmedi", [
      it.cleanMethod ? h("div", { class: "notice" }, `${(METHODS[it.cleanMethod] || {}).label || it.cleanMethod}: ${it.cleanReason || ""}`) : null,
      it.cleanMetrics ? h("div", { class: "hint" }, `Yazı izi ${it.cleanMetrics.residual} · çizgi kırılması ${it.cleanMetrics.lineBreak} · maske dışı değişim ${it.cleanMetrics.outsideChanged}`) : null,
      h("div", { class: "row tight" },
        h("button", { class: "mini", title: "Photoshop'ta seçili mevcut metin katmanını bu öğeye bağla", onclick: act(() => ops.linkActiveLayer(it.id)) }, "Seçili PS katmanını eşle"),
        it.type === "sfx" && hasLayer ? h("button", { class: "mini", title: "Görünen kopya rasterleşir; düzenlenebilir metin gizli 'SFX Kaynak' grubunda saklanır", onclick: act(() => ops.rasterizeSfx(it.id)) }, it.rasterized ? "Kaynaktan yeniden raster" : "SFX rasterleştir") : null),
    ], cs));
    if (sameItem) this.root.scrollTop = scroll;
  }

  renderMulti(sel) {
    const { ops } = this.app;
    const ids = sel.map((i) => i.id);
    this.root.appendChild(h("div", { class: "hero" },
      h("div", { class: "hero-top" }, h("span", { class: "hero-num" }, String(sel.length)), h("span", { class: "hero-status" }, "öğe seçili — toplu düzenleme")),
      h("div", { class: "field" }, h("label", null, "Türü ayarla"), select([["", "—"]].concat(ITEM_TYPES.map((t) => [t.id, t.label])), "", (v) => { if (v) ids.forEach((id) => ops.setField(id, "type", v)); })),
      h("div", { class: "field" }, h("label", null, "Tonu ayarla"), select([["", "—"]].concat(TONES.map((t) => [t.id, t.label])), "", (v) => { if (v) ids.forEach((id) => ops.setField(id, "tone", v)); })),
      h("div", { class: "row tight" },
        h("button", { class: "mini", onclick: () => ids.forEach((id) => { const it = this.app.store.item(id); if (it && !it.typeConfirmed) ops.setField(id, "type", it.type); }) }, "✓ Türleri onayla"),
        h("button", { class: "mini", onclick: () => ids.forEach((id) => { const it = this.app.store.item(id); if (it && !it.locks.text) ops.toggleLock(id, "text"); }) }, "Metni kilitle"),
        h("button", { class: "mini quiet", onclick: () => ids.forEach((id) => { const it = this.app.store.item(id); if (it && it.locks.text) ops.toggleLock(id, "text"); }) }, "Kilidi aç"),
        h("button", { class: "mini quiet danger", onclick: () => this.app.askDelete(ids) }, `✕ ${ids.length} öğeyi sil`))));
  }

  /** Tuval sürükleme pedi: canlı önizleme, bırakınca tek geçmiş adımı, Esc/odak kaybı iptal. */
  async padDrag(e, el, itemId, kind) {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    const x0 = e.clientX, y0 = e.clientY;
    // Oturum hazırlanırken (Photoshop okuması) düğme bırakılırsa: bırakma olayı kaçar ve Photoshop, bir sonraki tıklamaya
    // kadar modal durumda (kilitli) kalırdı → erken bırakmayı yakala, oturumu hemen iptal et.
    let released = false;
    const early = () => { released = true; };
    document.addEventListener("pointerup", early); document.addEventListener("pointercancel", early);
    const offEarly = () => { document.removeEventListener("pointerup", early); document.removeEventListener("pointercancel", early); };
    let session;
    try { session = await this.app.ops.beginDrag(itemId, kind); }
    catch (err) { offEarly(); this.app.notify(err.message, "error"); return; }
    offEarly();
    if (released) { try { await session.cancel(); } catch (err) { /* yok */ } return; }
    el.classList.add("active");
    let ended = false;
    const move = (ev) => session.update(ev.clientX - x0, ev.clientY - y0);
    const finish = async (commit) => {
      if (ended) return; ended = true;
      document.removeEventListener("pointermove", move); document.removeEventListener("pointerup", up);
      document.removeEventListener("pointercancel", cancel); document.removeEventListener("keydown", key); window.removeEventListener("blur", cancel);
      el.classList.remove("active");
      try { if (commit) await session.commit(); else { await session.cancel(); this.app.notify("Sürükleme iptal edildi; başlangıç konumuna dönüldü.", "info"); } }
      catch (err) { this.app.notify(err.message, "error"); }
      await this.app.ops.syncContentFromPs([itemId]);
    };
    const up = () => finish(true);
    const cancel = () => finish(false);
    const key = (ev) => { if (ev.key === "Escape") finish(false); };
    document.addEventListener("pointermove", move); document.addEventListener("pointerup", up);
    document.addEventListener("pointercancel", cancel); document.addEventListener("keydown", key); window.addEventListener("blur", cancel);
  }
}

module.exports = { Editor };
