// Kurulu Photoshop fontlarından seçim (arama + filtreli liste) ve Türkçe karakter önizlemesi.
"use strict";
const { h } = require("./dom");

const TR_SAMPLE = "ÇĞİÖŞÜ çğıöşü";
let FONT_CACHE = null;

function fonts() {
  if (FONT_CACHE) return FONT_CACHE;
  try {
    const { app } = require("photoshop");
    FONT_CACHE = app.fonts.map((f) => ({ ps: f.postScriptName, name: f.name, family: f.family, style: f.style }))
      .filter((f) => f.ps && !/emoji/i.test(f.ps))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (e) { FONT_CACHE = []; }
  return FONT_CACHE;
}

function fontByPs(ps) { return fonts().find((f) => f.ps === ps) || null; }

/** checks: settings.fontChecks → { [ps]: {missing:[...] } } */
function fontPicker(value, onChange, checks, opts) {
  opts = opts || {};
  const all = fonts();
  const search = h("input", { type: "text", placeholder: "Ara…", class: "fsearch" });
  const sel = h("select", { "aria-label": "Font" });
  const info = h("div", { class: "info" });
  const preview = h("div", { class: "preview-font" }, TR_SAMPLE);
  const fill = () => {
    const q = search.value.trim().toLocaleLowerCase("tr");
    while (sel.firstChild) sel.removeChild(sel.firstChild);
    if (opts.allowEmpty) sel.appendChild(h("option", { value: "" }, "(kuraldan / varsayılan)"));
    let list = q ? all.filter((f) => (f.name + " " + f.ps).toLocaleLowerCase("tr").includes(q)) : all;
    const cur = fontByPs(value);
    if (list.length > 250) list = list.slice(0, 250);
    if (cur && !list.includes(cur)) list = [cur].concat(list);
    if (value && !cur) sel.appendChild(h("option", { value }, value + " (KURULU DEĞİL)"));
    for (const f of list) sel.appendChild(h("option", { value: f.ps }, f.name));
    sel.value = value || "";
  };
  const describe = (ps) => {
    const f = fontByPs(ps);
    const c = checks && checks[ps];
    info.className = "info";
    if (ps && !f) { info.textContent = "⚠ Kurulu değil — yedek font uygulanır"; info.className = "info warn"; }
    else if (c && c.missing && c.missing.length) { info.textContent = "⚠ Eksik glif: " + c.missing.join(" ") + " — yedek font uygulanır"; info.className = "info warn"; }
    else if (c) { info.textContent = "✓ Türkçe glifler tamam"; info.className = "info ok"; }
    else info.textContent = "";
    try { preview.style.fontFamily = f ? `"${f.family}"` : ""; } catch (e) { /* yok */ }
  };
  search.addEventListener("input", fill);
  sel.addEventListener("change", () => { describe(sel.value); onChange(sel.value || null); });
  fill(); describe(value);
  return h("div", { class: "fontpick" }, h("div", { class: "row tight" }, search, sel), opts.noPreview ? null : preview, info);
}

module.exports = { fontPicker, fonts, fontByPs, TR_SAMPLE };
