// SFX (çizim üstü) temizliği: Torii değil, SFX yöntemi (öğretilmemişse İçerik Duyarlı Dolgu), kesin harf maskesiyle.
const fs = require("fs");
const { app } = require("photoshop");
const lfs = require("uxp").storage.localFileSystem;
const out = { results: [] };
const save = () => fs.writeFileSync(RESULT_PATH, JSON.stringify(out, null, 1));
const t_ = (name, ok, extra) => { out.results.push(Object.assign({ name, status: ok ? "PASS" : "FAIL" }, extra || {})); save(); };
const api = R("../src/ps/api"), pixels = R("../src/ps/pixels"), geom = R("../src/util/geom");
const profiles = R("../src/model/profiles");
const { Store, emptyState } = R("../src/model/store");
const { Pipeline } = R("../src/pipeline");
const { uid } = R("../src/util/common");

api.modal("SFX temizlik testi", async () => {
  for (const d of app.documents.slice()) if (String(d.title).indexOf("MCS_") === 0) await d.closeWithoutSaving();
  await app.open(await lfs.getEntryWithUrl("file:" + ASSET_PATH));
  const doc = app.activeDocument, W = doc.width, H = doc.height;
  const store = new Store(); store.settings = profiles.defaultSettings(); store.settings.fontChecks = {}; store.settings.cleanup.preview = false;
  const asked = [];
  const P = new Pipeline(store, null, { confirm: async (title) => { asked.push(title); return 0; }, notify: () => {}, progress: () => {}, preview: async () => true, busy: () => {} });
  const s = store.attach(doc.id, doc.title, emptyState()); store.activeDocId = doc.id;
  const orig = await pixels.readComposite(doc.id, { left: 0, top: 0, right: W, bottom: H });
  // SNAP: sentetik "inpainted" (Torii'nin bulanık sonucu yerine) — yalnız fark maskesi çıkarmak için
  const R0 = [40, 6740, 362, 7100], inp = { data: new Uint8Array(orig.data), width: W, height: H, channels: 3 };
  for (let y = R0[1]; y < R0[3]; y++) for (let x = R0[0]; x < R0[2]; x++) {
    const i = y * W + x, r = orig.data[i * 3], g = orig.data[i * 3 + 1], b = orig.data[i * 3 + 2];
    if (b > r + 40 && b > 90 && r < 120) { inp.data[i * 3] = 235; inp.data[i * 3 + 1] = 235; inp.data[i * 3 + 2] = 240; } // lacivert SFX mürekkebi
  }
  const box = { cx: 200, cy: 6900, w: 210, h: 230, angle: 0 };
  const poly = geom.boxToPolygon(box);
  s.state.items = [{ id: uid("i_"), order: 1, source: "SNAP.", translation: "ÇAT!", type: "sfx", typeConfirmed: true, tone: "normal", direction: "left_to_right", polygon: poly, lines: [poly], box, bounds: geom.polygonBounds(poly),
    ocr: { fontsize: 90, toriiFont: "90px WildWords", textColor: "#3b5b80", strokeColor: "#ffffff", strokeWidth: 10 }, bgStats: { uniform: 0.3 }, locks: { text: false, style: false, position: false }, manual: {}, status: { translated: true, cleaned: false, typeset: false } }];
  const it = s.state.items[0];
  // KREDİ HARCAMAMAK İÇİN: gerçek Üretken Dolgu çağrısı yerine her zaman hata veren sahte çağrı (otomatik yedek zincirini test eder)
  const adobeMod = R("../src/ps/adobe");
  let adobeCalls = 0;
  adobeMod.generativeFill = async () => { adobeCalls++; throw new Error("test: Üretken Dolgu kullanılamıyor"); };
  t_("Otomatik SFX yöntemi önce Adobe Üretken Dolgu'yu dener", P.sfxMethod() === "adobeGenerative", { method: P.sfxMethod() });
  const t = P.captureTarget();
  try { await P.applyInpaintedDiff(s, t, orig, inp, s.state.items); }
  catch (e) { t_("SFX temizliği çalıştı", false, { error: String(e.message) }); }
  t_("Adobe başarısız → aynı öğe OTOMATİK İçerik Duyarlı Dolgu ile temizlendi (elle adım yok)", it.cleanMethod === "contentAware" && adobeCalls === 1, { method: it.cleanMethod, reason: it.cleanReason, adobeCalls });
  t_("Başarısızlık hatırlandı: sonraki SFX'ler doğrudan İçerik Duyarlı", !!P._adobeFail && store.settings.adobe.last && store.settings.adobe.last.ok === false && P.sfxMethod() === "contentAware", { next: P.sfxMethod() });
  const L = it.cleanLayerId != null && api.findLayer(doc, it.cleanLayerId);
  t_("Temizlik katmanı Temizlik grubunda", !!L && L.parent && L.parent.id === s.state.groups.clean);
  // SFX harflerinin yerinde lacivert mürekkep kaldı mı + maske dışı değişti mi
  const after = await pixels.readOriginal(doc.id, { left: 0, top: 0, right: W, bottom: H }, [s.state.groups.trans]);
  let ink = 0, left = 0, outside = 0;
  for (let y = R0[1]; y < R0[3]; y++) for (let x = R0[0]; x < R0[2]; x++) {
    const i = y * W + x, r = orig.data[i * 3], g = orig.data[i * 3 + 1], b = orig.data[i * 3 + 2];
    if (b > r + 40 && b > 90 && r < 120) { ink++; const r2 = after.data[i * 3], b2 = after.data[i * 3 + 2]; if (b2 > r2 + 40 && b2 > 90 && r2 < 120) left++; }
  }
  const maskOv = P._maskOverrides[it.id];
  const md = maskOv ? geom.dilate(maskOv.mask, maskOv.width, maskOv.height, 12) : null;
  for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) {
    const i = y * W + x;
    const inMask = md && x >= maskOv.area.left && x < maskOv.area.right && y >= maskOv.area.top && y < maskOv.area.bottom && md[(y - maskOv.area.top) * maskOv.width + (x - maskOv.area.left)];
    if (inMask) continue;
    if (Math.abs(after.data[i * 3] - orig.data[i * 3]) + Math.abs(after.data[i * 3 + 1] - orig.data[i * 3 + 1]) + Math.abs(after.data[i * 3 + 2] - orig.data[i * 3 + 2]) > 6) outside++;
  }
  t_("SFX mürekkebi silindi", ink > 0 && left / ink < 0.03, { ink, left, pct: Math.round(left / ink * 1000) / 10 });
  t_("Maske dışında piksel değişmedi", outside === 0, { outside });
  t_("Onay soruldu mu (yalnız Adobe'de sorulmalı; İçerik Duyarlı yerel)", !asked.some((a) => /Adobe/.test(a)), { asked });
  // Görsel kontrol için önce/sonra kırpıntısı
  const png = R("../src/util/png");
  const cw = 420, ch = 460, cx0 = 0, cy0 = 6690;
  const crop = (src) => { const o = new Uint8Array(cw * ch * 3); for (let y = 0; y < ch; y++) o.set(src.subarray(((cy0 + y) * W + cx0) * 3, ((cy0 + y) * W + cx0 + cw) * 3), y * cw * 3); return o; };
  fs.writeFileSync(RESULT_PATH.replace(/\.json$/, "_before.png"), png.encodePng(crop(orig.data), cw, ch, 3));
  fs.writeFileSync(RESULT_PATH.replace(/\.json$/, "_after.png"), png.encodePng(crop(after.data), cw, ch, 3));
  // Temiz bırak: testin açtığı belgeleri (yalnızca MCS_ ile başlayanlar) kaydetmeden kapat
  for (const d of app.documents.slice()) if (String(d.title).indexOf("MCS_") === 0) await d.closeWithoutSaving();
  out.finished = true;
  out.summary = { pass: out.results.filter((r) => r.status === "PASS").length, fail: out.results.filter((r) => r.status === "FAIL").length };
  save();
}).catch((e) => { out.fatal = String(e && (e.stack || e)); out.finished = true; save(); });
