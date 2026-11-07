// Modal diyaloglar: onay, belirsiz zaman aşımı, temizlik önizlemesi (orijinal / maske / sonuç).
"use strict";
const { h, clear } = require("./dom");
const png = require("../util/png");
const { base64Encode } = require("../util/bytes");

let queue = Promise.resolve();

/** Diyaloglar sırayla gösterilir (UXP aynı anda tek modal destekler). */
function show(title, bodyNodes, buttons, size) {
  const run = () => new Promise((resolve) => {
    const dlg = document.getElementById("dlg");
    const body = clear(document.getElementById("dlgBody"));
    body.appendChild(h("h3", null, title));
    for (const n of [].concat(bodyNodes)) if (n) body.appendChild(n);
    const acts = h("div", { class: "dlg-actions" });
    buttons.forEach((b, i) => {
      acts.appendChild(h("button", { class: "btn" + (i === 0 ? " cta" : ""), onclick: () => { dlg.close(String(i)); } }, b));
    });
    body.appendChild(acts);
    const done = (v) => resolve(v == null || v === "" || v === "reasonCanceled" ? buttons.length - 1 : Number(v));
    if (dlg.uxpShowModal) {
      dlg.uxpShowModal({ title, resize: "both", size: size || { width: 520, height: 420 } }).then(done, () => done(null));
    } else {
      dlg.addEventListener("close", function f() { dlg.removeEventListener("close", f); done(dlg.returnValue); });
      dlg.showModal();
    }
  });
  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return p;
}

function confirm(title, html, buttons) {
  return show(title, h("div", { html }), buttons || ["Tamam", "İptal"]);
}

/** Belirsiz zaman aşımı: ücretli isteği tekrar göndermeden önce kullanıcıya durumu göster. → true = yeniden gönder */
async function ambiguous(d) {
  const before = d.info && d.info.creditsBefore;
  const after = d.creditsAfter;
  let creditNote = "Kredi bilgisi alınamadı.";
  if (before != null && after != null) {
    creditNote = after < before
      ? `Kredi ${before} → ${after} düştü: istek büyük olasılıkla sunucuda İŞLENDİ, ancak yanıt alınamadı. Tekrar göndermek yeniden ücretlendirebilir.`
      : `Kredi değişmedi (${after}): istek muhtemelen işlenmedi.`;
  }
  const r = await show("Belirsiz istek durumu", [
    h("p", null, `${d.label}: ${d.message}`),
    h("p", { class: "muted" }, `Geçen süre: ${Math.round(((d.info && d.info.elapsedMs) || 0) / 1000)} sn`),
    h("p", { class: after != null && before != null && after < before ? "warn" : "" }, creditNote),
  ], ["Yeniden gönder (ücret alınabilir)", "Vazgeç"]);
  return r === 0;
}

function toDataUrl(data, w, hgt, ch) { return "data:image/png;base64," + base64Encode(png.encodePng(data, w, hgt, ch, 3)); }

/** Temizlik önizlemesi: her öğe için Orijinal / Maske / Sonuç + ölçütler. → true = onay */
async function cleanupPreview(plans) {
  const nodes = [];
  for (const p of plans.slice(0, 6)) {
    const w = p.mask.width, hh = p.mask.height;
    // Sonuç = orijinal + maske içinde yama
    const comp = new Uint8Array(w * hh * 3);
    for (let i = 0; i < w * hh; i++) {
      const a = p.patch[i * 4 + 3];
      comp[i * 3] = a ? p.patch[i * 4] : p.rgb[i * 3];
      comp[i * 3 + 1] = a ? p.patch[i * 4 + 1] : p.rgb[i * 3 + 1];
      comp[i * 3 + 2] = a ? p.patch[i * 4 + 2] : p.rgb[i * 3 + 2];
    }
    const urls = { orig: toDataUrl(p.rgb, w, hh, 3), mask: toDataUrl(p.mask.mask, w, hh, 1), res: toDataUrl(comp, w, hh, 3) };
    const img = h("img", { class: "cmp-img", src: urls.res });
    const tabsRow = h("div", { class: "segmented", style: { marginBottom: "8px" } });
    const mk = (k, label) => {
      const o = h("div", { class: "opt" + (k === "res" ? " on" : ""), tabindex: "0" }, label);
      o.addEventListener("click", () => { img.src = urls[k]; Array.prototype.slice.call(tabsRow.children).forEach((b) => b.classList.remove("on")); o.classList.add("on"); });
      tabsRow.appendChild(o);
      return o;
    };
    mk("orig", "Orijinal"); mk("mask", "Maske"); mk("res", "Sonuç");
    const m = p.metrics || {};
    nodes.push(h("div", { class: "section" },
      h("div", { class: "row" }, h("b", null, p.item ? `#${p.item.order} ${p.item.type}` : "Seçim"), h("span", { class: "muted" }, " — " + p.decision.reason)),
      tabsRow,
      img,
      h("div", { class: "small muted" }, `Yazı izi: ${m.residual} · Çizgi kırılması: ${m.lineBreak} · Maske dışı değişen piksel: ${m.outsideChanged} · Süre: ${p.ms || 0} ms · Maliyet: ${p.cost != null ? p.cost.toFixed(3) + " kr" : "—"}`)));
  }
  if (plans.length > 6) nodes.push(h("p", { class: "muted" }, `…ve ${plans.length - 6} öğe daha.`));
  const r = await show("Temizlik önizlemesi", nodes, ["Onayla ve katmana yaz", "İptal"], { width: 620, height: 640 });
  return r === 0;
}

module.exports = { show, confirm, ambiguous, cleanupPreview, toDataUrl };
