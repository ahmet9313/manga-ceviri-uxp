// XMP durum yazımı geçmiş adımı oluşturuyor mu?
const out = {};
const save = () => require("fs").writeFileSync(RESULT_PATH, JSON.stringify(out, null, 1));
const api = R("../src/ps/api"), docs = R("../src/ps/document");
const { app } = require("photoshop");
api.modal("XMP geçmiş", async () => {
  await app.documents.add({ width: 200, height: 200, resolution: 72, mode: "RGBColorMode", fill: "white", name: "MCS_XMPH" });
  const d = app.activeDocument;
  const h0 = d.historyStates.map((s) => s.name);
  await docs.writeState(d.id, { version: 1, items: [{ id: "x" }], t: Date.now() });
  const h1 = d.historyStates.map((s) => s.name);
  out.before = h0; out.after = h1; out.addsHistory = h1.length !== h0.length;
  out.readBack = !!(await docs.readState(d.id));
  await d.closeWithoutSaving();
  out.finished = true; save();
}).catch((e) => { out.fatal = String(e); out.finished = true; save(); });
