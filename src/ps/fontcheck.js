// Türkçe glif testi: geçici belgede her karakteri ayrı katmanda dener.
// Eksik glif ölçütleri: (1) Photoshop "Glif Koruması" karakteri başka fonta çevirirse aralık fontu değişir,
// (2) karakter, fontta olmayan özel kullanım karakteriyle (U+E000) aynı genişlik/yükseklikte çizilirse (.notdef kutusu).
"use strict";
const { app, bp, modal } = require("./api");

const TR_CHARS = ["Ç", "Ğ", "İ", "Ö", "Ş", "Ü", "ç", "ğ", "ı", "ö", "ş", "ü", "â", "Â"];

async function checkFont(psName) {
  return modal("Glif testi", async () => {
    const prevDoc = app.activeDocument;
    await app.documents.add({ width: 400, height: 200, resolution: 72, mode: "RGBColorMode", fill: "white", name: "MCS_GLYPH_TEST" });
    const doc = app.activeDocument;
    // Güvenlik: yalnızca kendi oluşturduğumuz geçici belge üzerinde çalış (kullanıcı belgesini asla kapatma)
    if (!doc || (prevDoc && doc.id === prevDoc.id) ||String(doc.title).indexOf("MCS_GLYPH_TEST") !== 0) throw new Error("Geçici test belgesi oluşturulamadı.");
    const measure = async (ch) => {
      await bp({ _obj: "make", _target: [{ _ref: "textLayer" }], using: { _obj: "textLayer", textKey: ch,
        textClickPoint: { _obj: "paint", horizontal: { _unit: "percentUnit", _value: 20 }, vertical: { _unit: "percentUnit", _value: 60 } },
        textStyleRange: [{ _obj: "textStyleRange", from: 0, to: ch.length, textStyle: { _obj: "textStyle", fontPostScriptName: psName, size: { _unit: "pointsUnit", _value: 60 } } }] } });
      const L = doc.activeLayers[0];
      const tk = (await bp({ _obj: "get", _target: [{ _property: "textKey" }, { _ref: "layer", _id: L.id }] }))[0].textKey;
      const fontsUsed = (tk.textStyleRange || []).map((r) => r.textStyle.fontPostScriptName);
      const b = L.boundsNoEffects;
      await bp({ _obj: "delete", _target: [{ _ref: "layer", _id: L.id }] });
      return { fonts: fontsUsed, w: Math.round(b.right - b.left), h: Math.round(b.bottom - b.top) };
    };
    const missing = [];
    let notdef = null;
    try {
      notdef = await measure("");
      for (const ch of TR_CHARS) {
        const m = await measure(ch);
        const substituted = m.fonts.some((f) => f && f !== psName);
        const isNotdef = notdef && notdef.w > 0 && m.w === notdef.w && m.h === notdef.h && !["ı", "İ"].includes(ch) ? true : false;
        if (substituted || m.w === 0 || isNotdef) missing.push(ch);
      }
    } finally {
      await doc.closeWithoutSaving();
      if (prevDoc) try { app.activeDocument = prevDoc; } catch (e) { /* yok */ }
    }
    return { font: psName, missing: missing.filter((c) => c !== "â" && c !== "Â"), missingCircumflex: missing.filter((c) => c === "â" || c === "Â"), testedAt: Date.now() };
  }, {});
}

module.exports = { checkFont, TR_CHARS };
