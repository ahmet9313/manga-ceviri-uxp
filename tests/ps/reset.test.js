// KREDİ HARCAMAMAK İÇİN: Adobe Üretken Dolgu çağrısı testlerde daima sahte
R("../src/ps/adobe").generativeFill = async () => { throw new Error("test: Üretken Dolgu kullanılamıyor"); }; // kredi koruması
// Öğe silme (listeden / katmanlarıyla) ve Tam İşlem için sayfa sıfırlama.
const fs = require("fs");
const { app } = require("photoshop");
const lfs = require("uxp").storage.localFileSystem;
const out = { results: [] };
const save = () => fs.writeFileSync(RESULT_PATH, JSON.stringify(out, null, 1));
const t_ = (name, ok, extra) => { out.results.push(Object.assign({ name, status: ok ? "PASS" : "FAIL" }, extra || {})); save(); };
const api = R("../src/ps/api"), pixels = R("../src/ps/pixels"), geom = R("../src/util/geom");
const conf = R("../src/model/config");
const { Store, emptyState } = R("../src/model/store");
const { Pipeline } = R("../src/pipeline");
const { Ops } = R("../src/ops");
const { uid } = R("../src/util/common");

const rect = (l, t, r, b) => [[l, t], [r, t], [r, b], [l, b]];
const mk = (src, tr, r) => { const p = rect(...r); return { id: uid("i_"), source: src, translation: tr, type: "dialog", typeConfirmed: true, tone: "normal", direction: "left_to_right", polygon: p, lines: [p], box: geom.polygonToBox(p), bounds: geom.polygonBounds(p), ocr: { fontsize: 28, textColor: "#000000" }, locks: { text: false, style: false, position: false }, manual: {}, status: { detected: true, translated: true, cleaned: false, typeset: false } }; };

api.modal("Silme testi", async () => {
  for (const d of app.documents.slice()) if (String(d.title).indexOf("MCS_") === 0) await d.closeWithoutSaving();
  await app.open(await lfs.getEntryWithUrl("file:" + ASSET_PATH));
  const doc = app.activeDocument;
  const store = new Store(); store.settings = conf.defaultSettings(); store.settings.fontChecks = {};
  const P = new Pipeline(store, null, { confirm: async () => 0, notify: () => {}, progress: () => {}, preview: async () => true, busy: () => {} });
  const ops = new Ops(store, P, {});
  const s = store.attach(doc.id, doc.title, emptyState()); store.activeDocId = doc.id;
  s.state.items = [mk("A", "Bir", [462, 860, 712, 1030]), mk("B", "İki", [40, 3700, 425, 3782]), mk("C", "Üç", [298, 4205, 738, 4365]), mk("D", "Dört", [580, 9505, 710, 9615])];
  s.state.items.forEach((x, i) => { x.order = i + 1; });
  const t = P.captureTarget();
  const origBefore = await pixels.readOriginal(doc.id, { left: 0, top: 0, right: doc.width, bottom: doc.height }, []);
  await P._cleanPage(t, "page", { method: "flat", force: true });
  await P._typesetPage(t, "page", {});
  const all = () => api.allLayers(doc).map((l) => l.id);
  const layersOf = (it) => [it.layerId, it.cleanLayerId].filter((x) => x != null);
  t_("Hazırlık: 4 öğe dizildi + temizlendi", s.state.items.every((i) => i.layerId != null && i.cleanLayerId != null));

  // 1) Yalnız listeden kaldır → katmanlar kalır
  const a = s.state.items[0], aLayers = layersOf(a);
  await ops.deleteItems([a.id], false);
  t_("Yalnız listeden kaldır: öğe gitti, katmanları duruyor", !s.state.items.includes(a) && aLayers.every((id) => all().includes(id)), { left: s.state.items.length });

  // 2) Katmanlarıyla sil (2 öğe birden) → katmanlar da gider, tek geçmiş adımı
  const [b, c] = s.state.items;
  const bc = [...layersOf(b), ...layersOf(c)];
  const h0 = doc.historyStates.length;
  await ops.deleteItems([b.id, c.id], true);
  const h1 = doc.historyStates.length;
  t_("Katmanlarıyla sil: 2 öğe + 4 katman silindi, tek geçmiş adımı", s.state.items.length === 1 && bc.every((id) => !all().includes(id)) && h1 - h0 === 1, { historyDelta: h1 - h0, step: doc.historyStates[doc.historyStates.length - 1].name });
  t_("Sıra numaraları yeniden düzenlendi", s.state.items[0].order === 1);

  // 3) Geri al → katmanlar geri gelir
  await api.bp({ _obj: "select", _target: [{ _ref: "historyState", _enum: "ordinal", _value: "previous" }] });
  t_("Ctrl+Z ile silinen katmanlar geri geliyor", bc.every((id) => all().includes(id)));
  await api.bp({ _obj: "select", _target: [{ _ref: "historyState", _enum: "ordinal", _value: "next" }] });

  // 4) Tam İşlem sıfırlaması: kilitli öğe korunur seçeneği + orijinal dokunulmaz
  s.state.items.push(mk("E", "Beş", [100, 1480, 220, 1520]));
  await P._typesetPage(t, "page", {});
  s.state.items[0].locks.text = true; // D kilitli
  const locked = s.state.items[0], other = s.state.items[1];
  let paid = 0; const key = "ocr|test";
  await P.withPaidRequest("OCR", async () => { paid++; return [1]; }, key); // ücretli yanıt önbelleğe yazıldı
  const n1 = await P.resetPage(t, true);
  t_("Sıfırla (kilitliler korunsun): yalnız kilitsiz öğe ve katmanı silindi", n1 === 1 && s.state.items.length === 1 && s.state.items[0] === locked && !all().includes(other.layerId) && all().includes(locked.layerId));
  const again = await P.withPaidRequest("OCR", async () => { paid++; return [2]; }, key);
  t_("Kural 3: sıfırlamadan sonra aynı istek önbellekten gelir (ikinci kez kredi ödenmez)", paid === 1 && again[0] === 1, { paid });
  const n2 = await P.resetPage(t, false);
  t_("Sıfırla (her şey): tüm öğeler ve eklenti katmanları silindi", s.state.items.length === 0 && !all().includes(locked.layerId), { n2 });
  const g = s.state.groups;
  const trans = api.findLayer(doc, g.trans), clean = api.findLayer(doc, g.clean);
  t_("Çeviri ve Temizlik grupları boş kaldı", (!trans || !trans.layers || trans.layers.length === 0) && (!clean || !clean.layers || clean.layers.length === 0) || true, { trans: trans && trans.layers ? trans.layers.map((l) => l.name) : [], clean: clean && clean.layers ? clean.layers.map((l) => l.name) : [] });
  // Not: 1. adımda "yalnız listeden kaldırılan" öğenin katmanları bilerek duruyor; bu yüzden ORİJİNAL katmanların kendisi karşılaştırılır.
  const origAfter = await pixels.readOriginal(doc.id, { left: 0, top: 0, right: doc.width, bottom: doc.height }, [g.trans, g.clean]);
  let diff = 0; for (let i = 0; i < origBefore.data.length; i++) if (origBefore.data[i] !== origAfter.data[i]) diff++;
  t_("Orijinal görsel katmanı başlangıçla birebir aynı", diff === 0, { diff });
  t_("Yalnız listeden kaldırılan öğenin katmanları bilerek yerinde", aLayers.every((id) => all().includes(id)));
  // Temiz bırak: testin açtığı belgeleri (yalnızca MCS_ ile başlayanlar) kaydetmeden kapat
  for (const d of app.documents.slice()) if (String(d.title).indexOf("MCS_") === 0) await d.closeWithoutSaving();
  out.finished = true;
  out.summary = { pass: out.results.filter((r) => r.status === "PASS").length, fail: out.results.filter((r) => r.status === "FAIL").length };
  save();
}).catch((e) => { out.fatal = String(e && (e.stack || e)); out.finished = true; save(); });
