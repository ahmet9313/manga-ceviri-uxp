// Her modülü ayrı ayrı yükler; sözdizimi/yükleme hatalarını modül adıyla raporlar.
const out = { results: [] };
const mods = ["util/bytes", "util/common", "util/geom", "util/png", "torii/client", "ps/api", "ps/pixels", "ps/document", "ps/text", "ps/fontcheck", "ps/adobe",
  "model/rules", "model/storage", "model/config", "model/classify", "model/cleanup", "model/store", "firefly", "pipeline", "ops", "dev/selftest",
  "ui/dom", "ui/dialogs", "ui/list", "ui/fontpicker", "ui/editor", "ui/tabs"];
for (const m of mods) {
  try { R("../src/" + m); out.results.push({ name: m, status: "PASS" }); }
  catch (e) { out.results.push({ name: m, status: "FAIL", error: String(e && (e.message || e)).slice(0, 300) }); }
}
out.finished = true;
require("fs").writeFileSync(RESULT_PATH, JSON.stringify(out, null, 1));
