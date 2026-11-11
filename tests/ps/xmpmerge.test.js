// XMP durum yazımı belgenin DİĞER meta verilerini koruyor mu? (Photoshop XMP'yi tek rdf:Description'da birleştirir.)
const out = {};
const save = () => require("fs").writeFileSync(RESULT_PATH, JSON.stringify(out, null, 1));
const api = R("../src/ps/api"), docs = R("../src/ps/document");
const { app } = require("photoshop");
api.modal("XMP birleşim", async () => {
  await app.documents.add({ width: 200, height: 200, resolution: 72, mode: "RGBColorMode", fill: "white", name: "MCS_XMPM" });
  const d = app.activeDocument;
  try {
    // Kullanıcının kendi meta verisi (Dosya Bilgisi › kaynak alanı gibi)
    const mine = '<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:source>MCS_KEEP_ME</dc:source></rdf:Description>';
    const x0 = await docs.readXmp(d.id);
    await api.bp({ _obj: "set", _target: [{ _ref: "property", _property: "XMPMetadataAsUTF8" }, { _ref: "document", _id: d.id }], to: { _obj: "document", XMPMetadataAsUTF8: x0.replace("</rdf:RDF>", mine + "</rdf:RDF>") } });
    out.userMetaSet = /MCS_KEEP_ME/.test(await docs.readXmp(d.id));
    await docs.writeState(d.id, { version: 1, items: [{ id: "a" }] });
    const x1 = await docs.readXmp(d.id);
    await docs.writeState(d.id, { version: 1, items: [{ id: "b" }] });
    const x2 = await docs.readXmp(d.id);
    await docs.writeState(d.id, { version: 1, items: [{ id: "c" }] });
    const x3 = await docs.readXmp(d.id);
    out.keptAfter1 = /MCS_KEEP_ME/.test(x1); out.keptAfter2 = /MCS_KEEP_ME/.test(x2); out.keptAfter3 = /MCS_KEEP_ME/.test(x3);
    out.creatorToolKept = /CreatorTool/.test(x3);
    out.xmp = x3.replace(/\s{3,}/g, "\n").slice(0, 1500);
    out.stateBlocks = (x3.match(/mct:state/g) || []).length; // tek durum kalmalı (açılış+kapanış etiketi = 2, öznitelik biçimi = 1)
    const st = await docs.readState(d.id);
    out.lastState = st && st.items && st.items[0] && st.items[0].id;
    out.pass = !!(out.userMetaSet && out.keptAfter1 && out.keptAfter2 && out.keptAfter3 && out.lastState === "c" && out.stateBlocks <= 2);
  } finally { await d.closeWithoutSaving(); }
  out.finished = true; save();
}).catch((e) => { out.fatal = String(e && (e.stack || e)); out.finished = true; save(); });
