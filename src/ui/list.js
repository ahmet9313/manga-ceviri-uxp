// Öğe listesi. Sıralama YALNIZCA tutamaçtan (⋮⋮) sürüklenerek yapılır; metin seçme ve tekerlek kaydırma sürükleme başlatmaz.
// Kenara yaklaşınca kontrollü otomatik kaydırma, görünür bırakma çizgisi, Esc ile iptal, Alt+↑/↓ ile klavyeden sıralama.
"use strict";
const { h, clear } = require("./dom");

const TYPE_SHORT = { dialog: "Diyalog", narration: "Anlatım", offbubble: "Balon dışı", sfx: "SFX" };
const TONE_SHORT = { normal: "", shout: "Bağırma", whisper: "Fısıltı", thought: "Düşünce" };

class ItemList {
  constructor(root, store, callbacks) {
    this.root = root; this.store = store; this.cb = callbacks;
    this.drag = null;
    this.lastClicked = null;
    root.parentNode.addEventListener("keydown", (e) => this.onKey(e));
  }

  render() {
    const items = this.store.items();
    const sel = this.store.selected;
    const scroll = this.root.scrollTop;
    clear(this.root);
    if (!items.length) {
      const { emptyState } = require("./dom");
      this.root.appendChild(this.store.active
        ? emptyState("◎", "Henüz öğe yok", "Alttaki 1 · Tespit ile Torii OCR çalıştırın ya da Araçlar sekmesinden mevcut bir metin katmanını öğe yapın.")
        : emptyState("▢", "Belge açık değil", "Photoshop'ta bir manga / webtoon sayfası açın."));
      return;
    }
    const allowed = (it) => this.cb.filterAllows(it);
    items.forEach((it, idx) => {
      const flags = [];
      if (it.status.translated) flags.push(h("span", { class: "flag ok", title: "Çevrildi" }, "Ç"));
      if (it.status.cleaned) flags.push(h("span", { class: "flag ok", title: "Temizlendi" }, "T"));
      if (it.status.typeset) flags.push(h("span", { class: "flag ok", title: "Dizildi" }, "D"));
      if (it.overflow) flags.push(h("span", { class: "flag warn", title: "Minimum puntoda bile taşıyor" }, "TAŞMA"));
      if (it.layerMissing) flags.push(h("span", { class: "flag danger", title: "Katman bulunamadı" }, "KATMAN?"));
      if (it.locks.text || it.locks.style || it.locks.position) flags.push(h("span", { class: "flag", title: "Kilitli" }, "KİLİT"));
      if (it.awaitingHandoff) flags.push(h("span", { class: "flag warn", title: "Adobe arayüzünde bekliyor" }, "ADOBE"));
      const row = h("div", {
        class: "item k-" + it.type + (sel.has(it.id) ? " sel" : "") + (allowed(it) ? "" : " dim"),
        role: "option", "aria-selected": sel.has(it.id) ? "true" : "false", "data-idx": idx, "data-id": it.id,
        title: (it.typeReasons || []).join(", "),
      },
      h("div", { class: "handle", title: "Sürükleyerek sırala (veya Alt+↑/↓)", "data-handle": "1" }, "⋮⋮"),
      h("div", { class: "num" }, String(it.order || idx + 1).padStart(2, "0")),
      h("div", { class: "body" },
        h("div", { class: "meta" },
          h("span", { class: "pill " + it.type + (it.typeConfirmed ? "" : " unconfirmed"), title: it.typeConfirmed ? "Onaylı tür" : "Önerilen tür — onaylanmadı" }, TYPE_SHORT[it.type] || it.type),
          TONE_SHORT[it.tone] ? h("span", { class: "pill tone" }, TONE_SHORT[it.tone]) : null),
        h("div", { class: "tr" + (it.translation ? "" : " empty") }, it.translation || "Çeviri bekliyor"),
        it.source ? h("div", { class: "src" }, it.source) : null),
      h("div", { class: "side" }, h("div", { class: "flags" }, ...flags), h("div", { class: "del", "data-del": "1", title: "Bu öğeyi sil", role: "button", tabindex: "0" }, "✕")));
      row.addEventListener("click", (e) => {
        if (e.target.getAttribute("data-del")) { e.stopPropagation(); this.cb.onDelete([it.id]); return; }
        if (!e.target.getAttribute("data-handle")) this.onClick(e, it, idx);
      });
      row.querySelector(".handle").addEventListener("pointerdown", (e) => this.startDrag(e, idx, row));
      this.root.appendChild(row);
    });
    this.root.scrollTop = scroll;
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
    if (this.drag) { if (e.key === "Escape") this.endDrag(false); return; }
    const tag = (e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return;
    const items = this.store.items();
    if (!items.length) return;
    const cur = items.findIndex((x) => this.store.selected.has(x.id));
    if ((e.key === "Delete" || e.key === "Backspace") && this.store.selected.size) { e.preventDefault(); this.cb.onDelete([...this.store.selected]); return; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const dir = e.key === "ArrowDown" ? 1 : -1;
      if (e.altKey && cur >= 0) {
        // Klavye ile sıralama
        if (this.store.reorder(this.store.activeDocId, cur, cur + dir)) { this.markOrderEdited(); this.render(); this.scrollIntoView(cur + dir); }
      } else {
        const ni = Math.max(0, Math.min(items.length - 1, (cur < 0 ? 0 : cur + dir)));
        this.store.select([items[ni].id]); this.lastClicked = ni; this.cb.onSelect(items[ni]); this.scrollIntoView(ni);
      }
      e.preventDefault();
    } else if (e.key === "Enter" && cur >= 0) this.cb.onOpenEditor(items[cur]);
  }

  scrollIntoView(idx) {
    const row = this.root.children[idx];
    if (!row) return;
    const top = row.offsetTop, bot = top + row.offsetHeight;
    if (top < this.root.scrollTop) this.root.scrollTop = top;
    else if (bot > this.root.scrollTop + this.root.clientHeight) this.root.scrollTop = bot - this.root.clientHeight;
  }

  markOrderEdited() { const s = this.store.active; if (s) s.state.orderEdited = true; }

  // ---------------- sürükle-bırak (yalnız tutamaç) ----------------
  startDrag(e, idx, row) {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const listRect = this.root.getBoundingClientRect();
    this.drag = { idx, row, startY: e.clientY, y: e.clientY, active: false, dropIdx: idx, line: null, timer: null, listRect };
    const move = (ev) => this.onDragMove(ev);
    const up = (ev) => { this.endDrag(true); };
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
      d.timer = setInterval(() => this.autoScroll(), 30);
    }
    this.updateDrop();
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
    const rows = Array.prototype.slice.call(this.root.querySelectorAll(".item"));
    const r = this.root.getBoundingClientRect();
    let drop = rows.length;
    for (let i = 0; i < rows.length; i++) {
      const rr = rows[i].getBoundingClientRect();
      if (d.y < rr.top + rr.height / 2) { drop = i; break; }
    }
    d.dropIdx = drop;
    const ref = rows[Math.min(drop, rows.length - 1)];
    const rr = ref.getBoundingClientRect();
    const y = (drop >= rows.length ? rr.bottom : rr.top) - r.top + this.root.scrollTop;
    d.line.style.top = Math.round(y - 1) + "px";
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
      let to = d.dropIdx > d.idx ? d.dropIdx - 1 : d.dropIdx;
      if (to !== d.idx && this.store.reorder(this.store.activeDocId, d.idx, to)) this.markOrderEdited();
    }
    this.render();
  }
}

module.exports = { ItemList };
