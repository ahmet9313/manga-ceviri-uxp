// Küçük DOM yardımcıları ve bileşenler (UXP uyumlu, framework'süz).
// UXP yerel <button>/<input type=checkbox> öğelerini kendi stiliyle çizip CSS'i yok saydığı için
// düğme ve anahtarlar div tabanlıdır (klavye: Enter/Boşluk, devre dışı: [disabled]).
"use strict";

// İşlem sürerken (busy) yalnızca data-free işaretli kontroller (sekme, görünüm, Durdur, kart başlığı) çalışır.
const busyState = { on: false, onBlocked: null };
function isDisabled(el) {
  if (el.hasAttribute && el.hasAttribute("disabled")) return true;
  if (busyState.on && !(el.hasAttribute && el.hasAttribute("data-free"))) { if (busyState.onBlocked) busyState.onBlocked(); return true; }
  return false;
}

/** Tıklama + klavye etkinleştirme; devre dışıysa (veya işlem sürüyorsa) yok sayar. */
function activate(el, fn) {
  el.addEventListener("click", (e) => { if (!isDisabled(el)) fn(e); });
  el.addEventListener("keydown", (e) => { if ((e.key === "Enter" || e.key === " ") && !isDisabled(el)) { e.preventDefault(); fn(e); } });
}

/** h("button", {class:"btn cta"|"btn"|"mini"|"btn quiet"}) → div.btn varyantları */
function buttonClasses(cls) {
  cls = cls || "";
  const out = ["btn"];
  if (/\bcta\b/.test(cls)) out.push("primary");
  else if (/\bquiet\b/.test(cls)) out.push("ghost");
  if (/\bmini\b/.test(cls)) out.push("sm");
  if (/\bdanger\b/.test(cls)) out.push("danger");
  if (/\bseg\b/.test(cls)) out.push("sm");
  if (/\bactive\b/.test(cls)) out.push("primary");
  if (/\bblock\b/.test(cls)) out.push("block");
  if (/\bicon\b/.test(cls)) out.push("icon");
  return out.join(" ");
}

function h(tag, attrs, ...children) {
  let isButton = false;
  if (tag === "button") { isButton = true; tag = "div"; attrs = Object.assign({}, attrs, { class: buttonClasses(attrs && attrs.class), role: "button", tabindex: "0" }); }
  const el = document.createElement(tag);
  if (attrs) {
    for (const k of Object.keys(attrs)) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k === "html") el.innerHTML = v;
      else if (k.startsWith("on") && typeof v === "function") {
        const ev = k.slice(2).toLowerCase();
        if (isButton && ev === "click") activate(el, v);
        else el.addEventListener(ev, v);
      }
      else if (k === "value") el.value = v;
      else if (k === "checked") el.checked = !!v;
      else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
      else el.setAttribute(k, v === true ? "" : v);
    }
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
  }
  return el;
}

function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

function select(options, value, onChange, attrs) {
  const el = h("select", attrs || {});
  for (const o of options) {
    const [v, label] = Array.isArray(o) ? o : [o.id, o.label];
    const op = h("option", { value: v }, label);
    if (String(v) === String(value)) op.setAttribute("selected", "");
    el.appendChild(op);
  }
  el.value = value == null ? "" : value;
  if (onChange) el.addEventListener("change", () => onChange(el.value));
  return el;
}

function numberInput(value, onCommit, attrs) {
  const el = h("input", Object.assign({ type: "number", value: value == null ? "" : value }, attrs || {}));
  // min/max yalnızca görsel değil: sınır dışı (ör. 0 veya eksi punto) değerler sınıra çekilir
  const commit = () => {
    if (el.value === "") return onCommit(null);
    let n = Number(el.value);
    if (isNaN(n)) return;
    const lo = attrs && attrs.min, hi = attrs && attrs.max;
    if (lo != null && n < lo) n = lo;
    if (hi != null && n > hi) n = hi;
    if (String(n) !== el.value) el.value = n;
    onCommit(n);
  };
  el.addEventListener("change", commit);
  el.addEventListener("keydown", (e) => { if (e.key === "Enter") commit(); });
  return el;
}

function textInput(value, onCommit, attrs) {
  const el = h("input", Object.assign({ type: "text", value: value == null ? "" : value }, attrs || {}));
  el.addEventListener("change", () => onCommit(el.value));
  el.addEventListener("keydown", (e) => { if (e.key === "Enter") onCommit(el.value); });
  return el;
}

/** Anahtar (switch). Eski "checkbox" API'siyle uyumlu: checkbox(checked, onChange, label) */
function checkbox(checked, onChange, label, attrs) {
  const el = h("div", Object.assign({ class: "switch" + (checked ? " on" : ""), role: "switch", tabindex: "0", "aria-checked": checked ? "true" : "false" }, attrs || {}),
    h("div", { class: "track" }, h("div", { class: "knob" })),
    label ? h("span", { class: "slabel" }, label) : null);
  el.checked = !!checked;
  activate(el, (e) => {
    if (e && e.stopPropagation) e.stopPropagation();
    el.checked = !el.checked;
    el.classList.toggle("on", el.checked);
    el.setAttribute("aria-checked", el.checked ? "true" : "false");
    onChange(el.checked);
  });
  return el;
}

function colorInput(value, onCommit) {
  const sw = h("span", { class: "swatch", style: { background: value || "#000" } });
  const inp = textInput(value || "", (v) => {
    const ok = /^#?[0-9a-fA-F]{6}$/.test(v.trim());
    if (!ok) { inp.classList.add("err"); return; }
    inp.classList.remove("err");
    const hex = "#" + v.trim().replace("#", "").toLowerCase();
    sw.style.background = hex; onCommit(hex);
  }, { style: { width: "76px" }, placeholder: "#000000" });
  return h("span", { class: "row tight" }, sw, inp);
}

/** Açılır-kapanır kart. state: { [id]: bool } (açık/kapalı hatırlanır) */
function card(id, title, sub, bodyNodes, state, defaultOpen) {
  const open = state && id in state ? state[id] : defaultOpen !== false;
  const body = h("div", { class: "card-body" }, ...[].concat(bodyNodes));
  const chev = h("span", { class: "chev" }, open ? "▾" : "▸");
  const el = h("div", { class: "card" + (open ? "" : " collapsed") },
    h("div", { class: "card-head", role: "button", tabindex: "0", "data-free": "1", "aria-expanded": open ? "true" : "false" }, h("span", { class: "title" }, title), sub ? h("span", { class: "sub", title: sub }, sub) : null, chev),
    body);
  activate(el.firstChild, () => {
    const now = !el.classList.contains("collapsed");
    el.classList.toggle("collapsed", now);
    chev.textContent = now ? "▸" : "▾";
    el.firstChild.setAttribute("aria-expanded", now ? "false" : "true");
    if (state) { state[id] = !now; if (state.__save) state.__save(); }
  });
  return el;
}

function emptyState(icon, title, text, action) {
  return h("div", { class: "empty-state" }, h("div", { class: "big" }, icon), h("div", { class: "title" }, title), h("div", null, text), action || null);
}

function setDisabled(el, b) { if (b) el.setAttribute("disabled", ""); else el.removeAttribute("disabled"); }

module.exports = { h, clear, esc, select, numberInput, textInput, checkbox, colorInput, card, emptyState, setDisabled, activate, busyState };
