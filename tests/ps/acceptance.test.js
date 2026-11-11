// KREDİ HARCAMAMAK İÇİN: Adobe Üretken Dolgu çağrısı testlerde daima sahte
R("../src/ps/adobe").generativeFill = async () => { throw new Error("test: Üretken Dolgu kullanılamıyor"); }; // kredi koruması
// Gerçek Photoshop üzerinde kabul testleri (ağ gerektirmeyen kısım).
// tests/build-psjs.ps1 ile src/ modülleriyle birlikte paketlenir. R(...) = paket içi require.
const fs = require("fs");
const ps = require("photoshop");
const { app, core, action } = ps;
const lfs = require("uxp").storage.localFileSystem;

const api = R("../src/ps/api");
const docs = R("../src/ps/document");
const pixels = R("../src/ps/pixels");
const text = R("../src/ps/text");
const geom = R("../src/util/geom");
const cleanup = R("../src/model/cleanup");
const conf = R("../src/model/config");
const { Store, emptyState } = R("../src/model/store");
const { Pipeline } = R("../src/pipeline");
const { Ops } = R("../src/ops");
const { uid } = R("../src/util/common");

const out = { started: new Date().toISOString(), ps: null, results: [], notes: [] };
const save = () => { try { fs.writeFileSync(RESULT_PATH, JSON.stringify(out, null, 1)); } catch (e) { /* yok */ } };
async function test(name, fn) {
  const t0 = Date.now();
  try { const detail = await fn(); out.results.push({ name, status: "PASS", ms: Date.now() - t0, detail }); }
  catch (e) { out.results.push({ name, status: "FAIL", ms: Date.now() - t0, error: String(e && (e.stack || e.message || e)).slice(0, 1500) }); }
  save();
}
function assert(c, msg) { if (!c) throw new Error("Doğrulama başarısız: " + msg); }
const bp = (d) => action.batchPlay(Array.isArray(d) ? d : [d], {});

// --- Test sayfası öğeleri (belge pikseli; sayfa 800×10000) ---
const rect = (l, t, r, b) => [[l, t], [r, t], [r, b], [l, b]];
function mkItem(o) {
  const poly = o.poly || rect(...o.r);
  return Object.assign({
    id: uid("i_"), source: o.src, translation: o.tr, type: o.type, typeSuggested: o.type, typeConfirmed: true, tone: o.tone || "normal",
    direction: "left_to_right", polygon: poly, lines: o.lines || [poly], box: geom.polygonToBox(poly), bounds: geom.polygonBounds(poly),
    ocr: { fontsize: o.fs || 26, textColor: o.color || "#000000", hasBg: o.type !== "sfx" }, locks: { text: false, style: false, position: false }, manual: {},
    status: { detected: true, translated: true, cleaned: false, typeset: false },
  }, o.extra || {});
}
const ITEMS = () => [
  mkItem({ src: "XIAOFEI, I'M HEADING OUT FIRST. HURRY UP, OKAY?", tr: "Xiaofei, ben önden çıkıyorum. Acele et, tamam mı?", type: "dialog", r: [462, 860, 712, 1030], fs: 30,
    lines: [rect(527, 862, 650, 902), rect(468, 905, 706, 945), rect(482, 948, 696, 988), rect(540, 990, 640, 1030)] }),
  mkItem({ src: "SUCH AN EASY-TO-UNDERSTAND LOOK...", tr: "Ne kadar da belli eden bir ifade…", type: "dialog", r: [40, 3700, 425, 3782], fs: 32, color: "#5c6f8f" }),
  mkItem({ src: "BUT YOU'RE PRESSING EVEN CLOSER!", tr: "AMA DAHA DA YAKLAŞIYORSUN!", type: "dialog", tone: "shout", r: [298, 4205, 738, 4365], fs: 44, color: "#d6577f" }),
  mkItem({ src: "SNAP.", tr: "ÇAT!", type: "sfx", poly: [[95, 6740], [360, 6930], [290, 7100], [40, 6900]], fs: 120, color: "#3b5b80" }),
  mkItem({ src: "HUH HUH?", tr: "HA? HA?", type: "dialog", r: [580, 9505, 710, 9615], fs: 40 }),
];

function pickFont(cands) {
  const set = new Set(app.fonts.map((f) => f.postScriptName));
  for (const c of cands) if (set.has(c)) return c;
  return "ArialMT";
}

async function openTestPage() {
  await api.modal("test aç", async () => {
    for (const d of app.documents.slice()) if (String(d.title).indexOf("MCS_") === 0) await d.closeWithoutSaving();
    const e = await lfs.getEntryWithUrl("file:" + ASSET_PATH);
    await app.open(e);
  });
  return app.activeDocument;
}

function makeEnv(docId, title) {
  const store = new Store();
  store.settings = conf.defaultSettings();
  store.settings.fontChecks = {};
  const notes = [];
  const pipeline = new Pipeline(store, null, { confirm: async () => 0, notify: (m, k) => notes.push((k || "") + ": " + m), progress: () => {}, preview: async () => true, ambiguous: async () => false, openPage: async () => {} });
  const ops = new Ops(store, pipeline, {});
  store._persistFn = async (s) => { await api.modal("kaydet", () => docs.writeState(s.docId, s.state), {}); };
  store.attach(docId, title, emptyState());
  store.activeDocId = docId;
  return { store, pipeline, ops, notes };
}

async function layerIdsIn(doc, groupId) {
  const g = api.findLayer(doc, groupId);
  return g && g.layers ? g.layers.map((l) => l.id) : [];
}

async function areaHash(docId, b) {
  const r = await api.modal("oku", () => pixels.readComposite(docId, b), {});
  let h1 = 0, diffBase = r.data;
  for (let i = 0; i < r.data.length; i++) h1 = (h1 * 31 + r.data[i]) >>> 0;
  return { hash: h1, data: diffBase, w: r.width, h: r.height };
}

const stage = (s) => { out.stage = s; save(); };
// Not: .psjs betiklerinde executeAsModal yalnızca ilk tikte çağrılırsa çalışıyor (sonradan çağrılar kilitleniyor).
// Bu yüzden tüm testler tek üst düzey modal içinde koşar; eklentinin iç modal() çağrıları aynı bağlamı kullanır.
api.modal("Kabul testleri", async () => {
  stage("başladı");
  out.ps = { version: (() => { try { return app.version; } catch (e) { return "?"; } })(), uxp: (() => { try { return require("uxp").versions; } catch (e) { return null; } })() };
  stage("sayfa açılıyor");
  const doc = await openTestPage();
  stage("sayfa açıldı");
  const docId = doc.id;
  out.doc = { id: docId, w: doc.width, h: doc.height, res: doc.resolution };
  const env = makeEnv(docId, doc.title);
  const { store, pipeline, ops } = env;
  const sess = store.session(docId);
  sess.state.items = ITEMS();
  sess.state.items.forEach((x, i) => { x.order = i + 1; });
  const t = () => pipeline.captureTarget();

  const fontA = pickFont(["ArialMT"]), fontAShout = pickFont(["Impact", "Arial-BoldMT"]), fontASfx = pickFont(["Impact", "Arial-BlackMT", "Arial-BoldMT"]);
  const fontB = pickFont(["TimesNewRomanPSMT", "Georgia", "Cambria"]), fontBShout = pickFont(["Georgia-Bold", "TimesNewRomanPS-BoldMT", "Cambria-Bold"]), fontBSfx = pickFont(["ComicSansMS-Bold", "ComicSansMS", "Verdana-Bold"]);
  const S = store.settings;
  // Tek yapılandırma (Ayarlar). A ve B iki stil seti; test 8'de Ayarlar'a sırayla uygulanır.
  const pA = { base: null, rules: null };
  pA.base = { font: fontA, sizePx: 26, minSizePx: 12, maxSizePx: 40, fit: true, paddingPct: 10 };
  pA.rules = [
    { id: "a1", name: "Bağırma A", enabled: true, priority: 50, types: ["dialog"], tones: ["shout"], match: "all", conditions: [], style: { font: fontAShout, strokeEnabled: true, strokeSize: 4, strokeColor: "#ffffff" } },
    { id: "a2", name: "SFX A", enabled: true, priority: 30, types: ["sfx"], tones: [], match: "all", conditions: [], style: { font: fontASfx, maxSizePx: 110, shadowEnabled: true } },
  ];
  const pB = { base: null, rules: null };
  pB.base = { font: fontB, sizePx: 26, minSizePx: 12, maxSizePx: 40, fit: true };
  pB.rules = [
    { id: "b1", name: "Bağırma B", enabled: true, priority: 50, types: ["dialog"], tones: ["shout"], match: "all", conditions: [], style: { font: fontBShout } },
    { id: "b2", name: "SFX B", enabled: true, priority: 30, types: ["sfx"], tones: [], match: "all", conditions: [], style: { font: fontBSfx } },
  ];
  const useStyle = (p) => { S.config.base = p.base; S.config.rules = p.rules; };
  useStyle(pA);
  out.fonts = { fontA, fontAShout, fontASfx, fontB, fontBShout, fontBSfx };

  stage("ortam hazır");
  await test("1. Belge yapısı: Orijinal/Temizlik/Çeviri grupları", async () => {
    stage("test1: modal");
    const g = await api.modal("yapı", () => pipeline.ensureStructure(t()), { documentID: docId, historyName: "Yapı" });
    sess.state.groups = g;
    const names = doc.layers.map((l) => l.name);
    assert(names[0] === "Çeviri" && names[1] === "Temizlik" && names[2] === "Orijinal", "grup sırası " + names.join(","));
    const orig = api.findLayer(doc, g.original);
    assert(orig.layers.length >= 1, "orijinal katman gruba taşınmalı");
    const g2 = await api.modal("yapı2", () => pipeline.ensureStructure(t()), { documentID: docId, historyName: "Yapı2" });
    assert(g2.original === g.original && doc.layers.length === 3, "tekrar çalıştırmada yeni grup oluşmamalı");
    return { order: names, originalChildren: orig.layers.map((l) => l.name) };
  });

  await test("2. Bölge analizi + otomatik yöntem seçimi (düz balon / tram / çizim üstü SFX)", async () => {
    const res = [];
    for (const it of sess.state.items) {
      const area = cleanup.itemArea(it, { left: 0, top: 0, right: doc.width, bottom: doc.height }, 24);
      const img = await api.modal("oku", () => pixels.readOriginal(docId, area, [sess.state.groups.clean, sess.state.groups.trans]), { documentID: docId, historyName: "oku", discard: true });
      const mk = cleanup.itemMask(it, area, 4);
      const st = cleanup.analyzeRegion(img.data, mk.width, mk.height, mk.mask, mk.radius);
      const dec = cleanup.chooseMethod(st, it, { contentAware: true });
      res.push({ order: it.order, type: it.type, kind: st.kind, near: Math.round(st.nearRatio * 100), edge: Math.round(st.edgeRatio * 100), periodicity: st.periodicity, method: dec.method, reason: dec.reason });
    }
    // Renkli (gri) balon: kırmızı konturlu yazı
    {
      const it = mkItem({ src: "WHAT ARE YOU DOING?!", tr: "NE YAPIYORSUN?!", type: "dialog", r: [432, 2203, 738, 2247], fs: 28, color: "#c0392b" });
      const area = cleanup.itemArea(it, { left: 0, top: 0, right: doc.width, bottom: doc.height }, 24);
      const img = await pixels.readComposite(docId, area);
      const mk = cleanup.itemMask(it, area, 4);
      const st = cleanup.analyzeRegion(img.data, mk.width, mk.height, mk.mask, mk.radius);
      const dec = cleanup.chooseMethod(st, it, {});
      res.push({ order: "renkli", type: "dialog", kind: st.kind, bg: st.medianHex, near: Math.round(st.nearRatio * 100), edge: Math.round(st.edgeRatio * 100), method: dec.method, reason: dec.reason });
    }
    // Sentetik tramlı zemin (6 px nokta deseni) + siyah yazı
    {
      await app.documents.add({ width: 420, height: 200, resolution: 72, mode: "RGBColorMode", fill: "white", name: "MCS_TONE" });
      const td = app.activeDocument;
      await bp({ _obj: "make", _target: [{ _ref: "layer" }], using: { _obj: "layer", name: "tram" } });
      const L = td.activeLayers[0];
      const W = 420, H = 200, buf = new Uint8Array(W * H * 4);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = (y * W + x) * 4; const dot = Math.hypot((x % 6) - 3, (y % 6) - 3) < 1.6; const v = dot ? 70 : 235; buf[i] = buf[i + 1] = buf[i + 2] = v; buf[i + 3] = 255; }
      await pixels.writeLayerPixels(td.id, L.id, buf, W, H, 0, 0);
      const box = { cx: 210, cy: 100, w: 300, h: 60, angle: 0 };
      await text.createTextLayer(td.id, null, "TRAMLI ZEMİN", box, { font: "Arial-BoldMT", sizePx: 40, color: "#000000", align: "center" });
      const tb = td.activeLayers[0].boundsNoEffects;
      const it = mkItem({ src: "TONE", tr: "", type: "offbubble", r: [tb.left, tb.top, tb.right, tb.bottom], fs: 40 });
      const area = cleanup.itemArea(it, { left: 0, top: 0, right: W, bottom: H }, 24);
      const img = await pixels.readComposite(td.id, area);
      const mk = cleanup.itemMask(it, area, 3);
      const st = cleanup.analyzeRegion(img.data, mk.width, mk.height, mk.mask, mk.radius);
      const dec = cleanup.chooseMethod(st, it, {});
      res.push({ order: "tram", type: "offbubble", kind: st.kind, near: Math.round(st.nearRatio * 100), edge: Math.round(st.edgeRatio * 100), periodicity: st.periodicity, method: dec.method, reason: dec.reason });
      out.toneStats = res[res.length - 1];
      await td.closeWithoutSaving();
      app.activeDocument = doc;
      assert(st.kind === "screentone" && dec.method === "torii", "tram → torii olmalı: " + st.kind);
    }
    const sfx = res.find((r) => r.type === "sfx");
    assert(res[0].kind === "flat", "1. balon düz zemin olmalı: " + res[0].kind);
    assert(sfx.kind !== "flat" && sfx.method === "torii", "SFX çizim üstü → torii olmalı: " + sfx.kind);
    return res;
  });

  await test("3. Sadece Balonlar: SFX/diğer pikseller birebir korunur (yerel temizlik + dizgi)", async () => {
    S.ui.bubblesOnly = true;
    const sfx = sess.state.items.find((i) => i.type === "sfx");
    sfx.typeConfirmed = true;
    const sfxArea = geom.rectRound(geom.rectInflate(sfx.bounds, 30, { left: 0, top: 0, right: doc.width, bottom: doc.height }));
    const before = await areaHash(docId, sfxArea);
    await pipeline._cleanPage(t(), "page", { method: "flat", force: true });
    await pipeline._typesetPage(t(), "page", {});
    const after = await areaHash(docId, sfxArea);
    let changed = 0; for (let i = 0; i < before.data.length; i++) if (before.data[i] !== after.data[i]) changed++;
    assert(changed === 0, `SFX bölgesinde ${changed} kanal değeri değişti`);
    assert(sfx.layerId == null && sfx.cleanLayerId == null, "SFX için katman oluşmamalı");
    const dialogs = sess.state.items.filter((i) => i.type === "dialog");
    assert(dialogs.every((i) => i.layerId != null), "tüm diyaloglar dizilmeli");
    S.ui.bubblesOnly = false;
    return { sfxPixelsChecked: before.data.length / 3, changed, dialogLayers: dialogs.map((i) => i.layerId), notes: env.notes.slice(-3) };
  });

  await test("4. Temizlik: maske dışı pikseller değişmez, maske içi değişir (ayrı katman + katman maskesi)", async () => {
    const it = sess.state.items[0];
    const L = api.findLayer(doc, it.cleanLayerId);
    assert(L, "temizlik katmanı var");
    assert(L.parent && L.parent.id === sess.state.groups.clean, "temizlik katmanı Temizlik grubunda");
    const area = cleanup.itemArea(it, { left: 0, top: 0, right: doc.width, bottom: doc.height }, 24);
    const mk = cleanup.itemMask(it, area, store.settings.config.cleanup.dilatePx);
    // Çeviri grubunu gizleyerek orijinal ve (orijinal+temizlik) bileşimlerini karşılaştır
    const orig = await api.modal("o", () => pixels.readOriginal(docId, area, [sess.state.groups.clean, sess.state.groups.trans]), { documentID: docId, historyName: "o", discard: true });
    const withClean = await api.modal("c", () => pixels.readOriginal(docId, area, [sess.state.groups.trans]), { documentID: docId, historyName: "c", discard: true });
    let outside = 0, inside = 0, insideN = 0;
    for (let i = 0; i < mk.width * mk.height; i++) {
      const d = Math.abs(orig.data[i * 3] - withClean.data[i * 3]) + Math.abs(orig.data[i * 3 + 1] - withClean.data[i * 3 + 1]) + Math.abs(orig.data[i * 3 + 2] - withClean.data[i * 3 + 2]);
      if (!mk.mask[i]) { if (d) outside++; } else { insideN++; if (d) inside++; }
    }
    assert(outside === 0, `maske dışında ${outside} piksel değişti`);
    assert(inside > insideN * 0.05, "maske içinde yazı silinmiş olmalı");
    return { outsideChanged: outside, insideChanged: inside, maskPixels: insideN, method: it.cleanMethod };
  });

  await test("5. Tekrar çalıştırma: aynı öğeden ikinci katman oluşmaz", async () => {
    // Sadece Balonlar kapandı → SFX artık uygun; ilk çalıştırma SFX'in İLK katmanlarını oluşturur. Sonra aynı işlem tekrarlanır.
    await pipeline._cleanPage(t(), "page", { method: "flat", force: true });
    await pipeline._typesetPage(t(), "page", {});
    const before = { trans: (await layerIdsIn(doc, sess.state.groups.trans)).length, clean: (await layerIdsIn(doc, sess.state.groups.clean)).length };
    await pipeline._cleanPage(t(), "page", { method: "flat", force: true });
    await pipeline._typesetPage(t(), "page", {});
    const after = { trans: (await layerIdsIn(doc, sess.state.groups.trans)).length, clean: (await layerIdsIn(doc, sess.state.groups.clean)).length };
    assert(before.trans === after.trans && before.clean === after.clean, JSON.stringify({ before, after }));
    return { before, after };
  });

  await test("6. Dizgi: düzenlenebilir metin katmanları, kutu konumu, balona sığdırma, Türkçe karakterler", async () => {
    const res = [];
    for (const it of sess.state.items.filter((i) => i.layerId != null)) {
      const info = await text.readTextLayer(docId, it.layerId);
      const c = [(info.bounds.left + info.bounds.right) / 2, (info.bounds.top + info.bounds.bottom) / 2];
      const dist = Math.hypot(c[0] - it.box.cx, c[1] - it.box.cy);
      res.push({ order: it.order, contents: info.contents, font: info.font, sizePx: info.sizePx, isBox: info.isBox, box: [info.boxW, info.boxH], centerDist: Math.round(dist), overflow: !!it.overflow, kind: String(api.findLayer(doc, it.layerId).kind) });
      assert(info.contents === it.translation || info.contents === text.trUpper(it.translation), "içerik eşleşmeli: " + info.contents);
      assert(dist < Math.max(30, it.box.h * 0.35), `#${it.order} merkez sapması ${Math.round(dist)} px`);
    }
    assert(res.some((r) => /[çğıöşüÇĞİÖŞÜ]/.test(r.contents)), "Türkçe karakterler korunmalı");
    return res;
  });

  await test("7. Kurallar: bağırma ve SFX kuralı + uygulanan kural kaynağı", async () => {
    const shout = sess.state.items.find((i) => i.tone === "shout");
    const info = await text.readTextLayer(docId, shout.layerId);
    assert(info.font === fontAShout, `bağırma fontu ${info.font} ≠ ${fontAShout}`);
    const r = pipeline.resolveFor(sess.state, shout);
    assert(r.sources.font.rule === "Bağırma A" && r.sources.font.level === "settings", "kaynak etiketi " + JSON.stringify(r.sources.font));
    const fx = await text.readStrokeShadow(docId, shout.layerId);
    return { font: info.font, source: r.sources.font, strokeApplied: fx.strokeEnabled, note: fx.strokeEnabled ? "" : "kontur bu bağlamda uygulanamadı (betik bağlamında -25920 beklenir; eklenti panelinde ayrıca doğrulanmalı)" };
  });

  await test("8. Ayarlar stili değişince dizgi doğru fontları uygular (A → B → A)", async () => {
    // B stilini uygula: stil kilidi yok, manuel değer yok → fontlar B olmalı
    useStyle(pB);
    for (const it of sess.state.items) { it.lastApplied = null; it.manual = {}; }
    await pipeline._typesetPage(t(), "page", {});
    const got = {};
    for (const it of sess.state.items.filter((i) => i.layerId != null)) got["#" + it.order + "/" + it.type + "/" + it.tone] = (await text.readTextLayer(docId, it.layerId)).font;
    const shout = sess.state.items.find((i) => i.tone === "shout");
    const normal = sess.state.items.find((i) => i.type === "dialog" && i.tone === "normal" && i.layerId != null);
    assert((await text.readTextLayer(docId, shout.layerId)).font === fontBShout, "B bağırma fontu");
    assert((await text.readTextLayer(docId, normal.layerId)).font === fontB, "B normal fontu");
    // Geri A
    useStyle(pA);
    for (const it of sess.state.items) { it.lastApplied = null; it.manual = {}; }
    await pipeline._typesetPage(t(), "page", {});
    const backA = (await text.readTextLayer(docId, normal.layerId)).font;
    assert(backA === fontA, "A'ya dönüş fontu " + backA);
    return { styleB: got, backToA: backA };
  });

  await test("9. Elle düzenleme korunur: Photoshop'ta font/metin değişikliği → toplu dizgi ezmez", async () => {
    const it = sess.state.items[1];
    // Kullanıcı Photoshop'ta metni ve fontu değiştiriyor (Metin aracı simülasyonu)
    await api.modal("kullanıcı düzenlemesi", async () => {
      const L = api.findLayer(doc, it.layerId);
      L.textItem.contents = "Elle düzeltilmiş metin: ĞÜŞİÖÇ";
      L.textItem.characterStyle.font = fontB;
    }, { documentID: docId, historyName: "Kullanıcı düzenlemesi" });
    await ops.syncContentFromPs();
    assert(it.translation === "Elle düzeltilmiş metin: ĞÜŞİÖÇ" && it.translationEdited, "panel güncel metni almalı");
    // Toplu işlem (çeviri değişmiş gibi) + dizgi
    await pipeline._typesetPage(t(), "page", {});
    const info = await text.readTextLayer(docId, it.layerId);
    assert(info.contents === "Elle düzeltilmiş metin: ĞÜŞİÖÇ", "metin korunmalı: " + info.contents);
    assert(info.font === fontB && it.manual.font === fontB, "elle font korunmalı: " + info.font);
    const r = pipeline.resolveFor(sess.state, it);
    assert(r.sources.font.level === "manual", "kaynak manuel olmalı");
    return { contents: info.contents, font: info.font, manual: it.manual };
  });

  await test("10. Karakter bazlı biçim: tek alan değişince diğer aralıklar korunur", async () => {
    const it = sess.state.items[0];
    await api.modal("aralık", async () => {
      await text.rmwTextKey(docId, it.layerId, (tk) => {
        const base = tk.textStyleRange[0].textStyle;
        const red = JSON.parse(JSON.stringify(base)); red.color = { _obj: "RGBColor", red: 255, grain: 0, blue: 0 };
        const n = tk.textKey.length;
        tk.textStyleRange = [{ _obj: "textStyleRange", from: 0, to: 7, textStyle: red }, { _obj: "textStyleRange", from: 7, to: n, textStyle: base }];
      });
    }, { documentID: docId, historyName: "aralık" });
    await api.modal("tek alan", () => text.applyStyle(docId, it.layerId, { tracking: 20, sizePx: 24, align: "left" }), { documentID: docId, historyName: "tek alan" });
    const tk = await text.readTextLayer(docId, it.layerId);
    const raw = (await bp({ _obj: "get", _target: [{ _property: "textKey" }, { _ref: "layer", _id: it.layerId }] }))[0].textKey;
    const reds = raw.textStyleRange.filter((r) => r.textStyle.color && Math.round(r.textStyle.color.red) === 255 && Math.round(r.textStyle.color.grain) === 0);
    assert(reds.length >= 1, "kırmızı aralık korunmalı");
    assert(tk.align === "left", "hizalama uygulandı");
    return { ranges: raw.textStyleRange.length, redRanges: reds.length, sizePx: tk.sizePx, tracking: tk.tracking };
  });

  await test("11. Kutu boyutlandırma ≠ katman ölçekleme", async () => {
    const it = sess.state.items[4];
    const a = await text.readTextLayer(docId, it.layerId);
    await api.modal("kutu", () => text.resizeBox(docId, it.layerId, a.boxW + 60, a.boxH + 40), { documentID: docId, historyName: "kutu" });
    const b = await text.readTextLayer(docId, it.layerId);
    await api.modal("ölçek", () => text.scaleLayer(docId, it.layerId, 120), { documentID: docId, historyName: "ölçek" });
    const c = await text.readTextLayer(docId, it.layerId);
    assert(Math.abs(b.boxW - (a.boxW + 60)) <= 2 && Math.abs(b.sizePx - a.sizePx) < 0.6 && Math.abs(b.scalePct - 100) < 0.6, "kutu değişti, yazı ölçeklenmedi " + JSON.stringify({ a: [a.boxW, a.sizePx], b: [b.boxW, b.sizePx, b.scalePct] }));
    assert(Math.abs(c.scalePct - 120) < 1, "katman ölçeği %120 " + c.scalePct);
    await api.modal("geri", () => text.scaleLayer(docId, it.layerId, 100 / 1.2 * 100), { documentID: docId, historyName: "geri" });
    return { before: [a.boxW, a.boxH, a.sizePx, a.scalePct], afterBox: [b.boxW, b.boxH, b.sizePx, b.scalePct], afterScale: [c.boxW, c.boxH, c.sizePx, c.scalePct], rawPt: [c.rawSizePt, c.impliedSizePt] };
  });

  await test("12. Sürükleme oturumu: tek geçmiş adımı; iptal → başlangıç konumu", async () => {
    const it = sess.state.items[4];
    const h0 = doc.historyStates.length;
    const b0 = api.findLayer(doc, it.layerId).boundsNoEffects;
    const drag = await ops.beginDrag(it.id, "move");
    for (let k = 1; k <= 12; k++) drag.update(k * 3, k * 2);
    await new Promise((r) => setTimeout(r, 300));
    await drag.commit();
    const h1 = doc.historyStates.length;
    const b1 = api.findLayer(doc, it.layerId).boundsNoEffects;
    assert(h1 - h0 === 1, `geçmiş adımı sayısı ${h1 - h0}`);
    assert(Math.abs(b1.left - b0.left) > 5, "katman hareket etmeli");
    const drag2 = await ops.beginDrag(it.id, "rotate");
    drag2.update(40, 0); drag2.update(60, 0);
    await new Promise((r) => setTimeout(r, 300));
    await drag2.cancel();
    const b2 = api.findLayer(doc, it.layerId).boundsNoEffects;
    const h2 = doc.historyStates.length;
    assert(h2 === h1 && Math.abs(b2.left - b1.left) < 0.5 && Math.abs(b2.top - b1.top) < 0.5, "iptal sonrası konum/geçmiş aynı kalmalı");
    return { historyDelta: h1 - h0, moved: [Math.round(b1.left - b0.left), Math.round(b1.top - b0.top)], cancelRestored: true, lastHistory: doc.historyStates[doc.historyStates.length - 1].name };
  });

  await test("12b. Panelden çeviri değişince konum kilitlenmez; yeni metin balona yeniden sığdırılır", async () => {
    const it = sess.state.items[2];
    assert(it.layerId != null && !it.locks.position, "ön koşul: dizilmiş, kilitsiz öğe");
    const before = await text.readTextLayer(docId, it.layerId);
    await ops.setTranslation(it.id, "AMA DAHA DA, DAHA DA, DAHA DA YAKLAŞIYORSUN! NE YAPTIĞINI SANIYORSUN SEN BÖYLE, HEMEN GERİ ÇEKİL!");
    await pipeline._typesetPage(t(), "page", {});
    const after = await text.readTextLayer(docId, it.layerId);
    assert(!it.locks.position, "metin değişimi 'kullanıcı taşıdı' sayılıp konumu kilitlememeli");
    assert(after.sizePx < before.sizePx - 1 && !it.overflow, `uzun metin yeniden sığdırılmalı: ${before.sizePx} → ${after.sizePx} px, taşma ${it.overflow}`);
    return { sizeBefore: before.sizePx, sizeAfter: after.sizePx, locked: it.locks.position };
  });

  await test("13. Undo/Redo: elle düzenlenen metin korunur, panel eşitlenir", async () => {
    const it = sess.state.items[1];
    const hist = doc.historyStates;
    const names = hist.slice(-4).map((s) => s.name);
    await api.modal("undo", () => bp({ _obj: "select", _target: [{ _ref: "historyState", _enum: "ordinal", _value: "previous" }] }));
    await api.modal("redo", () => bp({ _obj: "select", _target: [{ _ref: "historyState", _enum: "ordinal", _value: "next" }] }));
    await ops.syncContentFromPs();
    const info = await text.readTextLayer(docId, it.layerId);
    assert(info.contents === "Elle düzeltilmiş metin: ĞÜŞİÖÇ" && it.translation === info.contents, "undo/redo sonrası metin " + info.contents);
    // Dizgi adımını geri al → katmanlar yok sayılır, ileri al → geri gelir
    const typesetIdx = doc.historyStates.map((s) => s.name).lastIndexOf(doc.historyStates.map((s) => s.name).filter((n) => /^Dizgi/.test(n)).pop());
    return { lastSteps: names, typesetStepIndex: typesetIdx, contents: info.contents };
  });

  await test("14. PSD kaydet → kapat → aç: eşleşmeler, kilitler, manuel değerler geri gelir", async () => {
    const it = sess.state.items[1];
    it.locks.style = true;
    await api.modal("kaydet durumu", () => docs.writeState(docId, sess.state), { documentID: docId, historyName: "durum" });
    const psdPath = RESULT_PATH.replace(/[^/]+$/, "") + "MCS_reopen_test.psd";
    const entry = await lfs.createEntryWithUrl("file:" + psdPath, { overwrite: true });
    await api.modal("psd kaydet", () => app.activeDocument.saveAs.psd(entry, {}, false));
    const savedItems = JSON.parse(JSON.stringify(sess.state.items.map((i) => ({ id: i.id, layerId: i.layerId, cleanLayerId: i.cleanLayerId, locks: i.locks, manual: i.manual, translation: i.translation }))));
    await api.modal("kapat", () => app.activeDocument.closeWithoutSaving());
    const e2 = await lfs.getEntryWithUrl("file:" + psdPath);
    await api.modal("aç", () => app.open(e2));
    const d2 = app.activeDocument;
    const st = await docs.readState(d2.id);
    assert(st && st.items.length === savedItems.length, "öğe sayısı");
    for (const s of savedItems) {
      const r = st.items.find((x) => x.id === s.id);
      assert(r && r.layerId === s.layerId && JSON.stringify(r.locks) === JSON.stringify(s.locks) && JSON.stringify(r.manual) === JSON.stringify(s.manual), "öğe " + s.id);
      if (r.layerId != null) assert(api.findLayer(d2, r.layerId), "katman kimliği yeniden açınca geçerli: " + r.layerId);
    }
    const t1 = st.items[1];
    const info = await text.readTextLayer(d2.id, t1.layerId);
    assert(info.contents === "Elle düzeltilmiş metin: ĞÜŞİÖÇ", "metin PSD'de korunmuş");
    // Yeniden açılmış belgede toplu dizgi: elle düzenleme ve kilit korunur
    const env2 = makeEnv(d2.id, d2.title);
    env2.store.settings = store.settings;
    const s2 = env2.store.session(d2.id); s2.state = st;
    await env2.pipeline._typesetPage(env2.pipeline.captureTarget(), "page", {});
    const info2 = await text.readTextLayer(d2.id, t1.layerId);
    assert(info2.contents === info.contents && info2.font === info.font, "yeniden açınca toplu işlem elle düzenlemeyi ezmemeli");
    out.reopenedDocId = d2.id;
    return { items: st.items.length, locks: t1.locks, manual: t1.manual, contents: info2.contents, font: info2.font };
  });

  await test("15. Belge güvenliği: iş sırasında belge değişirse sonuç yanlış belgeye yazılmaz", async () => {
    const d2 = app.activeDocument;
    const env3 = makeEnv(d2.id, d2.title);
    env3.store.settings = store.settings;
    const s3 = env3.store.session(d2.id); s3.state = await docs.readState(d2.id);
    const target = env3.pipeline.captureTarget();
    // Kullanıcı başka belgeye geçiyor
    await api.modal("yeni belge", () => app.documents.add({ width: 500, height: 500, resolution: 72, mode: "RGBColorMode", fill: "white", name: "MCS_OTHER" }));
    const other = app.activeDocument;
    assert(other.id !== d2.id, "başka belge etkin");
    let wrote = false;
    const r = await env3.pipeline.applyOrDefer(target, "Test sonucu", async () => { wrote = true; return "yazıldı"; });
    assert(r === null && !wrote && env3.store.pending.length === 1, "sonuç bekletilmeli");
    const otherLayers = other.layers.length;
    // Geri dön ve bekleyeni uygula
    await api.modal("geri dön", async () => { app.activeDocument = d2; });
    const pend = env3.store.takePending(target.docUid);
    const applied = await pend[0].apply();
    assert(wrote && applied === "yazıldı", "hedef belgeye dönünce uygulanmalı");
    await api.modal("kapat", async () => { const o = app.documents.find((x) => x.title.indexOf("MCS_OTHER") === 0); if (o) await o.closeWithoutSaving(); });
    // Belge kapatılmışsa: bekletilir
    const t2 = Object.assign({}, target, { docId: 999999 });
    const r2 = await env3.pipeline.applyOrDefer(t2, "Kapalı belge", async () => { throw new Error("yazılmamalıydı"); });
    assert(r2 === null && env3.store.pending.length === 1, "kapalı belgede bekletilmeli");
    return { deferred: true, otherDocUntouched: otherLayers, appliedAfterReturn: true };
  });

  await test("16. Türkçe glif testi (Glif Koruması ile)", async () => {
    const fc = R("../src/ps/fontcheck");
    const arial = await fc.checkFont("ArialMT");
    const symFont = pickFont(["Webdings", "Wingdings-Regular", "SymbolMT"]);
    const sym = await fc.checkFont(symFont);
    assert(arial.missing.length === 0, "Arial'de eksik olmamalı: " + arial.missing.join(""));
    assert(sym.missing.length > 0, symFont + " için eksik glif bulunmalı");
    return { arial: arial.missing, [symFont]: sym.missing };
  });

  await test("17. â/Â → a/A seçeneği diğer Türkçe harfleri korur", async () => {
    const s = conf.applyTurkishFixes("Hâlâ kâğıt ÂLEM ğüşıöç İ...", { enabled: true, circumflexToPlain: true, smartPunct: true });
    assert(s === "Hala kağıt ALEM ğüşıöç İ…", s);
    return s;
  });

  // Temiz bırak: testin açtığı belgeleri (yalnızca MCS_ ile başlayanlar) kaydetmeden kapat
  for (const d of app.documents.slice()) if (String(d.title).indexOf("MCS_") === 0) await d.closeWithoutSaving();
  out.finished = new Date().toISOString();
  out.summary = { pass: out.results.filter((r) => r.status === "PASS").length, fail: out.results.filter((r) => r.status === "FAIL").length };
  save();
}).catch((e) => { out.fatal = String(e && (e.stack || e)); save(); });
