// Torii'den PNG dışı (JPEG) görsel gelirse çözülebiliyor mu? (Data URL türü yanlış etiketli olsa bile)
const out = { results: [] };
const save = () => require("fs").writeFileSync(RESULT_PATH, JSON.stringify(out, null, 1));
const api = R("../src/ps/api");
const { Pipeline } = R("../src/pipeline");
const { base64Encode } = R("../src/util/bytes");
const png = R("../src/util/png");
api.modal("Çözme testi", async () => {
  const P = new Pipeline({ settings: {} }, null, { notify() {}, progress() {} });
  // 1) JPEG, "image/png" diye etiketlenmiş Data URL içinde (Torii'deki hatanın birebir benzeri)
  const jpg = new Uint8Array(require("fs").readFileSync(ASSET_PATH));
  try {
    const d = await P.decodeImage("data:image/png;base64," + base64Encode(jpg), "test jpeg");
    out.results.push({ name: "JPEG (png etiketli)", status: d.width === 800 && d.height === 10000 && d.channels === 3 ? "PASS" : "FAIL", w: d.width, h: d.height, ch: d.channels, sample: Array.from(d.data.subarray(0, 6)) });
  } catch (e) { out.results.push({ name: "JPEG (png etiketli)", status: "FAIL", error: String(e.stack || e) }); }
  // 2) Gerçek PNG
  try {
    const p = png.encodePng(new Uint8Array(30 * 20 * 3).fill(200), 30, 20, 3);
    const d = await P.decodeImage("data:image/png;base64," + base64Encode(p), "test png");
    out.results.push({ name: "PNG", status: d.width === 30 && d.data[0] === 200 ? "PASS" : "FAIL" });
  } catch (e) { out.results.push({ name: "PNG", status: "FAIL", error: String(e) }); }
  // 3) Bilinmeyen biçim → anlaşılır hata
  try { await P.decodeImage(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]), "çöp"); out.results.push({ name: "Bilinmeyen", status: "FAIL" }); }
  catch (e) { out.results.push({ name: "Bilinmeyen biçim anlaşılır hata", status: /tanınmayan/.test(e.message) ? "PASS" : "FAIL", error: e.message }); }
  out.docsAfter = require("photoshop").app.documents.map((d) => d.title);
  out.finished = true; save();
}).catch((e) => { out.fatal = String(e && (e.stack || e)); out.finished = true; save(); });
