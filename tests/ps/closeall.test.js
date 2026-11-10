// Testlerin açtığı belgeleri (yalnızca adı MCS_ ile başlayanlar) kaydetmeden kapatır. Kullanıcının belgelerine dokunmaz.
const fs = require("fs");
const { app } = require("photoshop");
const out = { closed: [] };
R("../src/ps/api").modal("MCS_ belgelerini kapat", async () => {
  for (const d of app.documents.slice()) if (String(d.title).indexOf("MCS_") === 0) { out.closed.push(d.title); await d.closeWithoutSaving(); }
  out.finished = true; fs.writeFileSync(RESULT_PATH, JSON.stringify(out));
}).catch((e) => { out.fatal = String(e && (e.stack || e)); out.finished = true; fs.writeFileSync(RESULT_PATH, JSON.stringify(out)); });
