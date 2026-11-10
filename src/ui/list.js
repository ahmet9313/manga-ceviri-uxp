// Öğe listesi — ARTIMLI güncelleme: her öğenin satırı kimliğiyle saklanır, yalnızca değişen satır yeniden çizilir
// (her tuş vuruşunda/eşitlemede tüm liste baştan kurulmaz). Sıralama YALNIZCA tutamaçtan (⋮⋮) sürüklenerek;
// kenarda otomatik kaydırma, görünür bırakma çizgisi, Esc ile iptal. Klavye: ↑↓ gez, Alt+↑↓ sırala, Delete sil, Enter editör.
"use strict";
const { h, clear, emptyState } = require("./dom");

const TYPE_SHORT = { dialog: "Diyalog", narration: "Anlatım", offbubble: "Balon dışı", sfx: "SFX" };
const TONE_SHORT = { normal: "", shout: "Bağırma", whisper: "Fısıltı", thought: "Düşünce" };

class ItemList {
  constructor(root, store, callbacks) {
    this.root = root; this.store = store; this.cb = callbacks;
    this.drag = null;
    this.lastClicked = null;
    this.rows = new Map(); // id → { el, sig }
    this.emptyEl = null;
    root.addEventListener("keydown", (e) => this.onKey(e));
    // Tek dinleyici (olay devri): satır başına dinleyici kurulmaz
    root.addEventListener("click", (e) => this.onRootClick(e));
    root.addEventListener("pointerdown", (e) => {
      let hd = e.target; // UXP'de closest() garanti değil → elle yukarı yürü
      while (hd && hd !== root && !(hd.getAttribute && hd.getAttribute("data-handle"))) hd = hd.parentNode;
      if (!hd || hd === root) return;
      const row = hd.parentNode;
      const idx = this.store.items().findIndex((x) => x.id === row.getAttribute("data-id"));
      if (idx >= 0) this.startDrag(e, idx, row);
    });
  }

  signature(it, sel, allowed) {
    return [it.order, it.type, it.typeConfirmed ? 1 : 0, it.tone, it.translation, it.source, it.status.translated ? 1 : 0, it.status.cleaned ? 1 : 0, it.status.typeset ? 1 : 0,
      it.overflow ? 1 : 0, it.layerMissing ? 1 : 0, it.locks.text || it.locks.style || it.locks.position ? 1 : 0, sel ? 1 : 0, allowed ? 1 : 0, (it.typeReasons || []).join(",")].join("|");
  }

  buildRow(it, sel, allowed) {
    const flags = [];
    if (it.overflow) flags.push(h("span", { class: "flag warn", title: "Minimum puntoda bile taşıyor" }, "TAŞMA"));
    if (it.layerMissing) flags.push(h("span", { class: "flag danger", title: "Katman bulunamadı (silindi / geri alındı?)" }, "KATMAN?"));
    if (it.locks.text || it.locks.style || it.locks.position) flags.push(h("span", { class: "flag", title: "Kilitli — toplu işlemler dokunmaz" }, "🔒"));
    const dot = (on, ch, t) => h("span", { class: "sm-dot" + (on ? " on" : ""), title: t + (on ? " ✓" : " — bekliyor") }, ch);
    return h("div", {
      class: "item k-" + it.type + (sel ? " sel" : "") + (allowed ? "" : " dim"),
      role: "option", "aria-selected": sel ? "true" : "false", "data-id": it.id,
      title: (it.typeReasons || []).join(", "),
    },
    h("div", { class: "handle", title: "Sürükleyerek sırala (veya Alt+↑/↓)", "data-handle": "1" }, "⋮⋮"),
    h("div", { class: "num" }, String(it.order || 0).padStart(2, "0")),
    h("div", { class: "body" },
      h("div", { class: "meta" },
        h("span", { class: "pill " + it.type + (it.typeConfirmed ? "" : " unconfirmed"), title: it.typeConfirmed ? "Onaylı tür" : "Önerilen tür — onaylanmadı" }, TYPE_SHORT[it.type] || it.type),
        TONE_SHORT[it.tone] ? h("span", { class: "pill tone" }, TONE_SHORT[it.tone]) : null,
        ...flags,
        h("div", { class: "steps-mini" }, dot(it.status.cleaned, "T", "Temizlendi"), dot(it.status.translated, "Ç", "Çevrildi"), dot(it.status.typeset, "D", "Dizildi"))),
      h("div", { class: "tr" + (it.translation ? "" : " pending") }, it.translation || "Çeviri bekliyor"),
      it.source ? h("div", { class: "src" }, it.source) : null),
    h("div", { class: "del", "data-del": "1", title: "Bu öğeyi sil (Delete)", role: "button" }, "✕"));
  }

  render() {
    const items = this.store.items();
    const sel = this.store.selected;
    if (!items.length) {
      for (const r of this.rows.values()) if (r.el.parentNode) r.el.parentNode.removeChild(r.el);
      this.rows.clear();
      if (!this.emptyEl || !this.emptyEl.parentNode) {
        clear(this.root);
        this.emptyEl = this.store.active
          ? emptyState("◎", "Henüz öğe yok", "▶ Tam İşlem sayfayı baştan işler. Yalnızca metinleri bulmak için 1 · Tespit.")
          : emptyState("▢", "Belge açık değil", "Photoshop'ta bir manga / webtoon sayfası açın; panel otomatik bağlanır.");
        this.root.appendChild(this.emptyEl);
      }
      return;
    }
    if (this.emptyEl && this.emptyEl.parentNode) this.emptyEl.parentNode.removeChild(this.emptyEl);
    this.emptyEl = null;
    const seen = new Set();
    let prev = null;
    for (const it of items) {
      const isSel = sel.has(it.id), allowed = this.cb.filterAllows(it);
      const sig = this.signature(it, isSel, allowed);
      let r = this.rows.get(it.id);
      if (!r || r.sig !== sig) {
        const el = this.buildRow(it, isSel, allowed);
        if (r && r.el.parentNode) r.el.parentNode.replaceChild(el, r.el);
        r = { el, sig };
        this.rows.set(it.id, r);
      }
      seen.add(it.id);
      // Sıra: önceki satırın hemen ardından gelmeli
      const want = prev ? prev.nextSibling : this.root.firstChild;
      if (want !== r.el) this.root.insertBefore(r.el, want);
      prev = r.el;
    }
    for (const [id, r] of this.rows) if (!seen.has(id)) { if (r.el.parentNode) r.el.parentNode.removeChild(r.el); this.rows.delete(id); }
    // Liste sonunda kalan başka düğümleri (eski bırakma çizgisi vb.) temizle
    while (prev && prev.nextSibling && !(this.drag && prev.nextSibling === this.drag.line)) this.root.removeChild(prev.nextSibling);
  }

  onRootClick(e) {
    let el = e.target;
    while (el && el !== this.root && !(el.getAttribute && el.getAttribute("data-id"))) {
      if (el.getAttribute && el.getAttribute("data-del")) { const row = el.parentNode; e.stopPropagation(); this.cb.onDelete([row.getAttribute("data-id")]); return; }
      if (el.getAttribute && el.getAttribute("data-handle")) return;
      el = el.parentNode;
    }
    if (!el || el === this.root) return;
    const items = this.store.items();
    const idx = items.findIndex((x) => x.id === el.getAttribute("data-id"));
    if (idx >= 0) this.onClick(e, items[idx], idx);
  }

  onClick(e, it, idx) {
    const items = this.store.items();
    let ids;
    if (e.shiftKey && this.lastClicked != null) {
      const a = Math.min(this.lastClicked, idx), b = Math.max(this.lastClicked, idx);
      ids = items.slice(a, b + 1).map((x) => x.id);
    } else if (e.ctrlKey || e.metaKey) {
      const s = new Set(this.store.selected);
      if (s.has(it.id)) s.delete(it.id); else s.add(it.id);
      ids = [...s];
    } else ids = [it.id];
    this.lastClicked = idx;
    this.store.select(ids);
    this.cb.onSelect(it);
  }

  onKey(e) {
    if (this.drag) { if (e.key === "Escape") { e.preventDefault(); this.endDrag(false); } return; }
    const items = this.store.items();
    if (!items.length) return;
    const cur = items.findIndex((x) => this.store.selected.has(x.id));
    if ((e.key === "Delete" || e.key === "Backspace") && this.store.selected.size) { e.preventDefault(); this.cb.onDelete([...this.store.selected]); return; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const dir = e.key === "ArrowDown" ? 1 : -1;
      if (e.altKey && cur >= 0) {
        if (this.store.reorder(this.store.activeDocId, cur, cur + dir)) { this.markOrderEdited(); this.scrollIntoView(items[cur + dir] ? items[cur].id : null); }
      } else {
        const ni = Math.max(0, Math.min(items.length - 1, (cur < 0 ? 0 : cur + dir)));
        this.store.select([items[ni].id]); this.lastClicked = ni; this.cb.onSelect(items[ni]); this.scrollIntoView(items[ni].id);
      }
      e.preventDefault();
    } else if (e.key === "Enter" && cur >= 0) this.cb.onOpenEditor(items[cur]);
    else if (e.key === "Escape" && this.store.selected.size) { this.store.select([]); e.preventDefault(); }
  }

  scrollIntoView(id) {
    const r = id && this.rows.get(id);
    if (!r) return;
    const row = r.el, top = row.offsetTop, bot = top + row.offsetHeight;
    if (top < this.root.scrollTop) this.root.scrollTop = top;
    else if (bot > this.root.scrollTop + this.root.clientHeight) this.root.scrollTop = bot - this.root.clientHeight;
  }

  markOrderEdited() { const s = this.store.active; if (s) s.state.orderEdited = true; }

  // ---------------- sürükle-bırak (yalnız tutamaç) ----------------
  startDrag(e, idx, row) {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    this.drag = { idx, row, startY: e.clientY, y: e.clientY, active: false, dropIdx: idx, line: null, timer: null, rects: null, pending: false };
    const move = (ev) => this.onDragMove(ev);
    const up = () => this.endDrag(true);
    const cancel = () => this.endDrag(false);
    this.drag.off = () => {
      document.removeEventListener("pointermove", move); document.removeEventListener("pointerup", up);
      document.removeEventListener("pointercancel", cancel); window.removeEventListener("blur", cancel);
    };
    document.addEventListener("pointermove", move); document.addEventListener("pointerup", up);
    document.addEventListener("pointercancel", cancel); window.addEventListener("blur", cancel);
  }

  onDragMove(ev) {
    const d = this.drag;
    if (!d) return;
    d.y = ev.clientY;
    if (!d.active) {
      if (Math.abs(d.y - d.startY) < 4) return; // küçük titreşim sürükleme başlatmaz
      d.active = true; d.row.classList.add("dragging");
      d.line = h("div", { class: "dropline" }); this.root.appendChild(d.line);
      // Satır konumları bir kez ölçülür (her harekette yerleşim hesaplanmaz); kaydırma ofsetiyle düzeltilir
      d.scroll0 = this.root.scrollTop;
      d.rects = Array.prototype.slice.call(this.root.querySelectorAll(".item")).map((r) => { const b = r.getBoundingClientRect(); return { top: b.top, mid: b.top + b.height / 2, bottom: b.bottom }; });
      d.listTop = this.root.getBoundingClientRect().top;
      d.timer = setInterval(() => this.autoScroll(), 30);
    }
    if (!d.pending) { d.pending = true; (typeof requestAnimationFrame === "function" ? requestAnimationFrame : (f) => setTimeout(f, 16))(() => { if (this.drag) { this.drag.pending = false; this.updateDrop(); } }); }
  }

  autoScroll() {
    const d = this.drag;
    if (!d || !d.active) return;
    const r = this.root.getBoundingClientRect();
    const edge = 32;
    let v = 0;
    if (d.y < r.top + edge) v = -Math.ceil(((r.top + edge - d.y) / edge) * 14);
    else if (d.y > r.bottom - edge) v = Math.ceil(((d.y - (r.bottom - edge)) / edge) * 14);
    if (v) { this.root.scrollTop = Math.max(0, Math.min(this.root.scrollHeight, this.root.scrollTop + Math.max(-24, Math.min(24, v)))); this.updateDrop(); }
  }

  updateDrop() {
    const d = this.drag;
    if (!d || !d.rects || !d.rects.length) return;
    const dy = this.root.scrollTop - d.scroll0; // ölçümden beri kaydırma
    const y = d.y + dy;
    let drop = d.rects.length;
    for (let i = 0; i < d.rects.length; i++) if (y < d.rects[i].mid) { drop = i; break; }
    d.dropIdx = drop;
    const ref = d.rects[Math.min(drop, d.rects.length - 1)];
    const lineY = (drop >= d.rects.length ? ref.bottom : ref.top) - d.listTop + d.scroll0;
    d.line.style.top = Math.round(lineY - 2) + "px";
  }

  endDrag(commit) {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    d.off();
    if (d.timer) clearInterval(d.timer);
    if (d.line && d.line.parentNode) d.line.parentNode.removeChild(d.line);
    d.row.classList.remove("dragging");
    if (!d.active) return;
    if (commit) {
      const to = d.dropIdx > d.idx ? d.dropIdx - 1 : d.dropIdx;
      if (to !== d.idx && this.store.reorder(this.store.activeDocId, d.idx, to)) this.markOrderEdited();
    }
    this.render();
  }
}

module.exports = { ItemList };
