// Çizim üstü SFX otomatik yedek zinciri: Üretken Dolgu → İçerik Duyarlı → Torii. Her yöntemde MASKE DIŞI piksel değişmemeli.
// Adobe ve Torii SAHTE (kredi harcanmaz). Sahte Üretken Dolgu bilerek TÜM katmanı boyar: maskemizin uygulandığı doğrulanır.
const fs = require("fs");
const { app } = require("photoshop");
const lfs = require("uxp").storage.localFileSystem;
const out = { results: [] };
const save = () => fs.writeFileSync(RESULT_PATH, JSON.stringify(out, null, 1));
const t_ = (name, ok, extra) => { out.results.push(Object.assign({ name, status: ok ? "PASS" : "FAIL" }, extra || {})); save(); };
const api = R("../src/ps/api"), pixels = R("../src/ps/pixels"), geom = R("../src/util/geom"), png = R("../src/util/png");
const { base64Encode } = R("../src/util/bytes");
const conf = R("../src/model/config");
const { Store, emptyState } = R("../src/model/store");
const { Pipeline } = R("../src/pipeline");
const { uid } = R("../src/util/common");
const adobeMod = R("../src/ps/adobe");

const R0 = [40, 6740, 362, 7100];
const isInk = (d, i) => { const r = d[i * 3], b = d[i * 3 + 2]; return b > r + 40 && b > 90 && r < 120; }; // lacivert SNAP mürekkebi

async function scenario(label, setup) {
  for (const d of app.documents.slice()) if (String(d.title).indexOf("MCS_") === 0) await d.closeWithoutSaving();
  await app.open(await lfs.getEntryWithUrl("file:" + ASSET_PATH));
  const doc = app.activeDocument, W = doc.width, H = doc.height;
  const store = new Store(); store.settings = conf.defaultSettings(); store.settings.fontChecks = {};
  // Sahte Torii: inpaint maskeli alanı açık griyle doldurur
  const client = { lastCredits: 100, async inpaint(image, mask) {
    const im = png.decodePng(image.bytes), mk = png.decodePng(mask.bytes);
    for (let i = 0; i < im.width * im.height; i++) if (mk.data[i]) { im.data[i * 3] = 236; im.data[i * 3 + 1] = 236; im.data[i * 3 + 2] = 240; }
    return "data:image/png;base64," + base64Encode(png.encodePng(im.data, im.width, im.height, 3, 1));
  } };
  const P = new Pipeline(store, client, { confirm: async () => 0, notify: () => {}, progress: () => {}, preview: async () => true, ambiguous: async () => false, busy: () => {} });
  const s = store.attach(doc.id, doc.title, emptyState()); store.activeDocId = doc.id;
  const orig = await pixels.readComposite(doc.id, { left: 0, top: 0, right: W, bottom: H });
  const inp = { data: new Uint8Array(orig.data), width: W, height: H, channels: 3 };
  for (let y = R0[1]; y < R0[3]; y++) for (let x = R0[0]; x < R0[2]; x++) { const i = y * W + x; if (isInk(orig.data, i)) { inp.data[i * 3] = 235; inp.data[i * 3 + 1] = 235; inp.data[i * 3 + 2] = 240; } }
  const box = { cx: 200, cy: 6900, w: 210, h: 230, angle: 0 }, poly = geom.boxToPolygon(box);
  s.state.items = [{ id: uid("i_"), order: 1, source: "SNAP.", translation: "ÇAT!", type: "sfx", typeConfirmed: true, tone: "normal", direction: "left_to_right", polygon: poly, lines: [poly], box, bounds: geom.polygonBounds(poly),
    ocr: { fontsize: 90, toriiFont: "90px WildWords", textColor: "#3b5b80", strokeColor: "#ffffff", strokeWidth: 10 }, bgStats: { uniform: 0.3 }, locks: { text: false, style: false, position: false }, manual: {}, status: { translated: true, cleaned: false, typeset: false } }];
  const it = s.state.items[0];
  const calls = setup(P);
  try { await P.applyInpaintedDiff(s, P.captureTarget(), orig, inp, s.state.items); }
  catch (e) { t_(`${label}: çalıştı`, false, { error: String(e && e.message) }); return; }
  const after = await pixels.readOriginal(doc.id, { left: 0, top: 0, right: W, bottom: H }, [s.state.groups.trans]);
  let ink = 0, left = 0, outside = 0;
  for (let y = R0[1]; y < R0[3]; y++) for (let x = R0[0]; x < R0[2]; x++) { const i = y * W + x; if (isInk(orig.data, i)) { ink++; if (isInk(after.data, i)) left++; } }
  const ov = P._maskOverrides[it.id];
  const md = ov ? geom.dilate(ov.mask, ov.width, ov.height, 12) : null;
  for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) {
    const i = y * W + x;
    const inMask = md && x >= ov.area.left && x < ov.area.right && y >= ov.area.top && y < ov.area.bottom && md[(y - ov.area.top) * ov.width + (x - ov.area.left)];
    if (inMask) continue;
    if (Math.abs(after.data[i * 3] - orig.data[i * 3]) + Math.abs(after.data[i * 3 + 1] - orig.data[i * 3 + 1]) + Math.abs(after.data[i * 3 + 2] - orig.data[i * 3 + 2]) > 6) outside++;
  }
  const L = it.cleanLayerId != null && api.findLayer(doc, it.cleanLayerId);
  return { it, ink, left, outside, layerOk: !!L && L.parent && L.parent.id === s.state.groups.clean, calls, P };
}

api.modal("SFX yedek zinciri testi", async () => {
  // A) Üretken Dolgu ÇALIŞIR (sahte): yeni katman, ama TÜM katmanı boyar → maskemiz yalnız harfleri göstermeli
  const a = await scenario("Üretken Dolgu", (P) => {
    const c = { n: 0 };
    adobeMod.generativeFill = async () => {
      c.n++;
      await api.bp({ _obj: "make", _target: [{ _ref: "layer" }] });
      await api.bp({ _obj: "set", _target: [{ _ref: "channel", _property: "selection" }], to: { _enum: "ordinal", _value: "allEnum" } });
      await api.bp({ _obj: "fill", using: { _enum: "fillContents", _value: "white" }, opacity: { _unit: "percentUnit", _value: 100 }, mode: { _enum: "blendMode", _value: "normal" } });
    };
    return c;
  });
  if (a) {
    t_("Üretken Dolgu: yöntem adobeGenerative, tek çağrı", a.it.cleanMethod === "adobeGenerative" && a.calls.n === 1, { method: a.it.cleanMethod, calls: a.calls.n });
    t_("Üretken Dolgu: SFX mürekkebi silindi", a.ink > 0 && a.left / a.ink < 0.03, { ink: a.ink, left: a.left });
    t_("Üretken Dolgu: maske DIŞI piksel değişmedi (katman tümüyle boyansa bile)", a.outside === 0, { outside: a.outside });
    t_("Üretken Dolgu: katman Temizlik grubunda", a.layerOk);
  }
  // B) Üretken Dolgu VE İçerik Duyarlı başarısız → Torii (sahte) otomatik
  const b = await scenario("Torii yedeği", (P) => {
    const c = { gen: 0, ca: 0 };
    adobeMod.generativeFill = async () => { c.gen++; throw new Error("test: Üretken Dolgu yok"); };
    P.contentAwareClean = async () => { c.ca++; throw new Error("test: İçerik Duyarlı yok"); };
    return c;
  });
  if (b) {
    t_("Zincir: Üretken → İçerik Duyarlı → Torii (otomatik, elle adım yok)", b.it.cleanMethod === "torii" && b.calls.gen === 1 && b.calls.ca === 1, { method: b.it.cleanMethod, reason: b.it.cleanReason, calls: b.calls });
    t_("Torii yedeği: SFX mürekkebi silindi", b.ink > 0 && b.left / b.ink < 0.03, { ink: b.ink, left: b.left });
    t_("Torii yedeği: maske DIŞI piksel değişmedi", b.outside === 0, { outside: b.outside });
    t_("Gerekçe sonuç mesajına yazılabilir (neden belli)", /Üretken Dolgu kullanılamadı/.test(b.it.cleanReason || "") || /İçerik Duyarlı da çalışmadı/.test(b.it.cleanReason || ""), { reason: b.it.cleanReason });
  }
  for (const d of app.documents.slice()) if (String(d.title).indexOf("MCS_") === 0) await d.closeWithoutSaving();
  out.finished = true;
  out.summary = { pass: out.results.filter((r) => r.status === "PASS").length, fail: out.results.filter((r) => r.status === "FAIL").length };
  save();
}).catch((e) => { out.fatal = String(e && (e.stack || e)); out.finished = true; save(); });
