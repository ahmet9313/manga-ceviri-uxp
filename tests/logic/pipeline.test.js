// Photoshop GEREKTİRMEYEN iş akışı testleri: "photoshop" ve "uxp" modülleri sahtesiyle değiştirilir (Bun eklentisi).
// Kapsam: elle düzenleme / konum kilidi tespiti, işlem sürerken panel işlemleri, bekleyen sonuç, bul-değiştir.
// Çalıştırma: bun tests/logic/pipeline.test.js
const fakeApp = { documents: [], activeDocument: null, fonts: [] };
const nop = () => new Proxy(function () {}, { get: () => nop(), apply: () => nop() });
Bun.plugin({ name: "ps-stubs", setup(build) {
  build.module("photoshop", () => ({ exports: { app: fakeApp, core: nop(), action: nop(), constants: nop(), imaging: nop() }, loader: "object" }));
  build.module("uxp", () => ({ exports: { entrypoints: nop(), storage: nop(), pluginManager: nop() }, loader: "object" }));
} });
const root = require("path").join(__dirname, "..", "..");
const { Pipeline } = require(root + "/src/pipeline");
const { Ops } = require(root + "/src/ops");
const { Store, emptyState } = require(root + "/src/model/store");
const conf = require(root + "/src/model/config");
const ok = (c, m) => { console.log(c ? "ok  " : "FAIL", m); if (!c) process.exitCode = 1; };

function env() {
  const store = new Store(); store.settings = conf.defaultSettings();
  const notes = [];
  const pipeline = new Pipeline(store, null, { notify: (m) => notes.push(m), progress: () => {} });
  return { store, pipeline, ops: new Ops(store, pipeline, {}), notes };
}
const mkItem = (o) => Object.assign({ id: "i1", order: 1, source: "SNAP", translation: "Çat!", type: "sfx", locks: { text: false, style: false, position: false }, manual: {}, status: {} }, o);
const B = (l, t, r, b) => ({ left: l, top: t, right: r, bottom: b });
const snap = (o) => Object.assign({ font: "F", sizePx: 30, color: "#000000", tracking: 0, align: "center", leadingPct: 0, fauxBold: false, fauxItalic: false, contents: "ÇAT!", bounds: B(10, 10, 110, 60) }, o);

(async () => {
  const { pipeline } = env();

  // 1) Panel metni değiştirdi (katman = çevirinin BÜYÜK HARF hali), sınır doğal olarak değişti → kilit YOK, "elle düzenlendi" YOK
  let it = mkItem({ translation: "Çatırt!", lastApplied: snap() });
  pipeline.captureManualEdits(it, snap({ contents: "ÇATIRT!", bounds: B(0, 10, 120, 60) }));
  ok(!it.locks.position && !it.translationEdited && it.translation === "Çatırt!", "metin değişimi konumu kilitlemez, büyük harf hali elle düzenleme sayılmaz");

  // 2) Kullanıcı Photoshop'ta metni gerçekten değiştirdi → çeviri güncellenir, konum kilitlenmez
  it = mkItem({ lastApplied: snap() });
  pipeline.captureManualEdits(it, snap({ contents: "Elle yazıldı", bounds: B(0, 10, 120, 60) }));
  ok(it.translation === "Elle yazıldı" && it.translationEdited && !it.locks.position, "Photoshop'ta elle yazılan metin korunur");

  // 3) Punto değişti → manuel punto; sınır değişimi taşıma sayılmaz
  it = mkItem({ lastApplied: snap() });
  pipeline.captureManualEdits(it, snap({ sizePx: 40, bounds: B(0, 5, 120, 65) }));
  ok(it.manual.sizePx === 40 && !it.locks.position, "punto değişimi manuel değer olur, konumu kilitlemez");

  // 4) Yalnızca taşındı → konum kilidi
  it = mkItem({ lastApplied: snap() });
  pipeline.captureManualEdits(it, snap({ bounds: B(50, 40, 150, 90) }));
  ok(it.locks.position && !it.translationEdited && !Object.keys(it.manual).length, "gerçek taşıma konumu kilitler");

  // 5) İşlem sürerken panel işlemleri
  const e = env();
  fakeApp.documents = [{ id: 1, title: "p1", width: 100, height: 100, layers: [], activeLayers: [{ id: 77 }] }];
  fakeApp.activeDocument = fakeApp.documents[0];
  const s = e.store.attach(1, "p1", emptyState()); e.store.activeDocId = 1;
  s.state.items = [mkItem({ id: "a", layerId: 77 }), mkItem({ id: "b", order: 2, layerId: 78 })];
  e.store.select(["a", "b"]);
  e.pipeline.busy = true; e.pipeline.busyName = "Tam İşlem";
  e.ops.syncSelectionFromPs();
  ok(e.store.selected.size === 2, "işlem sürerken Photoshop seçim olayı panel seçimini değiştirmez");
  ok((await e.ops.syncContentFromPs()) === 0 && (await e.ops.selectItemLayer(s.state.items[0])) === false, "işlem sürerken eşitleme / katman seçimi yapılmaz");
  let threw = "";
  try { await e.ops.deleteItems(["a"], true); } catch (err) { threw = err.message; }
  ok(/Tam İşlem/.test(threw) && s.state.items.length === 2, "işlem sürerken silme reddedilir: " + threw);
  await e.ops.setTranslation("a", "Yeni metin");
  ok(s.state.items[0].translation === "Yeni metin" && s.state.items[0].translationEdited, "işlem sürerken yazılan çeviri kaybolmaz (yalnız panel verisi)");
  e.pipeline.busy = false;
  e.ops.syncSelectionFromPs();
  ok(e.store.selected.size === 1 && e.store.selected.has("a"), "işlem bitince Photoshop seçimi yeniden izlenir");

  // 6) Bekleyen sonuç: belge kapatılıp yeniden açılınca (yeni Photoshop kimliği) yazma adımı güncel kimliği kullanır
  const p = env();
  const st = emptyState();
  p.store.attach(1, "sayfa", st);
  const t = { docId: 1, docUid: st.docUid, title: "sayfa", w: 100, h: 100 };
  fakeApp.documents = [{ id: 2, title: "başka", width: 50, height: 50 }]; fakeApp.activeDocument = fakeApp.documents[0];
  let seen = null;
  const r = await p.pipeline.applyOrDefer(t, "Test", async (sess) => { seen = { docId: t.docId, sess: sess.docId }; return "yazıldı"; });
  ok(r === null && p.store.pending.length === 1, "kapalı belgede sonuç bekletilir");
  p.store.detach(1); p.store.attach(5, "sayfa", st);
  fakeApp.documents = [{ id: 5, title: "sayfa", width: 100, height: 100 }]; fakeApp.activeDocument = fakeApp.documents[0];
  const applied = await p.store.takePending(st.docUid)[0].apply();
  ok(applied === "yazıldı" && seen.docId === 5 && seen.sess === 5, "yeniden açılan belgede güncel kimlik kullanılır: " + JSON.stringify(seen));

  // 7) Bul-değiştir: düz metinde "$" özel anlam taşımaz; düzenli ifadede grup başvurusu çalışır
  const f = env();
  fakeApp.documents = [{ id: 1, title: "p1", width: 100, height: 100 }]; fakeApp.activeDocument = fakeApp.documents[0];
  const fs2 = f.store.attach(1, "p1", emptyState()); f.store.activeDocId = 1;
  fs2.state.items = [mkItem({ translation: "5 dolar verdim" })];
  let m = await f.pipeline.findAll("dolar", "$& $1 $$", { field: "translation" });
  ok(m.length === 1 && m[0].after === "5 $& $1 $$ verdim", "düz metin: " + (m[0] && m[0].after));
  m = await f.pipeline.findAll("(\\d+) dolar", "$1 lira", { field: "translation", regex: true });
  ok(m.length === 1 && m[0].after === "5 lira verdim", "düzenli ifade: " + (m[0] && m[0].after));
})().catch((e) => { console.log("FAIL beklenmeyen hata", e && (e.stack || e)); process.exitCode = 1; });
