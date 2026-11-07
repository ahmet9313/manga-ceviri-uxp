// Tür ayrımı (piksel tabanlı) + Tam İşlem temizliğinin çeviri kutusu dışına taşan yazıyı da silmesi.
// Torii'nin "inpainted" çıktısı yerine: orijinaldeki yazı pikselleri zemin rengiyle boyanmış sentetik görüntü.
// Çeviri kutuları bilerek orijinal yazıdan KÜÇÜK verilir (gerçek Torii davranışı).
const fs = require("fs");
const { app } = require("photoshop");
const lfs = require("uxp").storage.localFileSystem;
const out = { results: [] };
const save = () => fs.writeFileSync(RESULT_PATH, JSON.stringify(out, null, 1));
const api = R("../src/ps/api"), pixels = R("../src/ps/pixels"), geom = R("../src/util/geom");
const profiles = R("../src/model/profiles");
const { Store, emptyState } = R("../src/model/store");
const { Pipeline } = R("../src/pipeline");
const { uid } = R("../src/util/common");

// Orijinal yazı dikdörtgenleri (test sayfası) + tür beklentisi
const TEXTS = [
  { src: "XIAOFEI, I'M HEADING OUT FIRST. HURRY UP, OKAY?", r: [462, 860, 712, 1032], expect: "dialog", ink: "dark" },
  { src: "SUCH AN EASY-TO-UNDERSTAND LOOK...", r: [38, 3698, 427, 3784], expect: "dialog", ink: "dark" },
  { src: "BUT YOU'RE PRESSING EVEN CLOSER!", r: [296, 4203, 740, 4367], expect: "dialog", ink: "color" },
  { src: "SNAP.", r: [40, 6740, 362, 7100], expect: "sfx", ink: "color" },
  { src: "HUH HUH?", r: [578, 9503, 712, 9617], expect: "dialog", ink: "dark" },
];

// KREDİ HARCAMAMAK İÇİN: Adobe Üretken Dolgu çağrısı sahte (her zaman hata → otomatik İçerik Duyarlı yedeği)
R("../src/ps/adobe").replay = async () => { throw new Error("test: Üretken Dolgu kullanılamıyor"); };
api.modal("Tür ve temizlik testi", async () => {
  for (const d of app.documents.slice()) if (String(d.title).indexOf("turning-into-a-tentacle-monster-p1") === 0 || String(d.title).indexOf("MCS_") === 0) await d.closeWithoutSaving();
  await app.open(await lfs.getEntryWithUrl("file:" + ASSET_PATH));
  const doc = app.activeDocument, W = doc.width, H = doc.height;
  const orig = await pixels.readComposite(doc.id, { left: 0, top: 0, right: W, bottom: H });
  // Sentetik "inpainted": yazı mürekkebini (zeminden belirgin farklı pikseller) kutunun kenar rengiyle doldur
  const inp = { data: new Uint8Array(orig.data), width: W, height: H, channels: 3 };
  const L = (d, i) => 0.299 * d[i * 3] + 0.587 * d[i * 3 + 1] + 0.114 * d[i * 3 + 2];
  const inkMasks = [];
  for (const t of TEXTS) {
    const [l, tp, r, b] = t.r; const ink = [];
    // zemin: dikdörtgen kenarındaki medyan
    const edge = [];
    for (let x = l; x < r; x++) { edge.push(tp * W + x, (b - 1) * W + x); }
    const med = [0, 1, 2].map((c) => edge.map((i) => orig.data[i * 3 + c]).sort((a, z) => a - z)[edge.length >> 1]);
    for (let y = tp; y < b; y++) for (let x = l; x < r; x++) {
      const i = y * W + x;
      const d = Math.abs(orig.data[i * 3] - med[0]) + Math.abs(orig.data[i * 3 + 1] - med[1]) + Math.abs(orig.data[i * 3 + 2] - med[2]);
      if (d > 90) { inp.data[i * 3] = med[0]; inp.data[i * 3 + 1] = med[1]; inp.data[i * 3 + 2] = med[2]; ink.push(i); }
    }
    inkMasks.push(ink);
  }
  // Oturum + Torii benzeri öğeler: çeviri kutusu = orijinal yazının %65'i (üst kısma kaymış)
  const store = new Store(); store.settings = profiles.defaultSettings(); store.settings.fontChecks = {};
  const P = new Pipeline(store, null, { confirm: async () => 0, notify: () => {}, progress: () => {}, preview: async () => true });
  const s = store.attach(doc.id, doc.title, emptyState()); store.activeDocId = doc.id;
  s.state.items = TEXTS.map((t, k) => {
    const [l, tp, r, b] = t.r;
    const box = { cx: (l + r) / 2, cy: tp + (b - tp) * 0.38, w: (r - l) * 0.65, h: (b - tp) * 0.62, angle: 0 };
    const poly = geom.boxToPolygon(box);
    return { id: uid("i_"), order: k + 1, source: t.src, translation: "x", type: "offbubble", typeConfirmed: false, tone: "normal", direction: "left_to_right",
      polygon: poly, lines: [poly], box, bounds: geom.polygonBounds(poly), ocr: { fontsize: 30, toriiFont: "30px WildWords", strokeColor: "#ffffff", strokeWidth: 10, textColor: "#000000" },
      locks: { text: false, style: false, position: false }, manual: {}, status: { detected: true, translated: true, cleaned: false, typeset: false } };
  });
  // 1) Tür ayrımı
  P.refineTypes(s.state.items, { data: inp.data, width: W, height: H, bounds: { left: 0, top: 0 } }, true);
  s.state.items.forEach((it, k) => out.results.push({ name: `Tür: ${TEXTS[k].src.slice(0, 24)}`, status: it.type === TEXTS[k].expect ? "PASS" : "FAIL", got: it.type, expect: TEXTS[k].expect, why: it.typeReasons, stats: it.bgStats }));
  save();
  // 2) Temizlik: çeviri kutusu dışına taşan yazı da silinmeli
  const t = P.captureTarget();
  await P.applyInpaintedDiff(s, t, orig, inp, s.state.items);
  const after = await pixels.readOriginal(doc.id, { left: 0, top: 0, right: W, bottom: H }, [s.state.groups.trans]);
  TEXTS.forEach((tx, k) => {
    const ink = inkMasks[k]; let left = 0;
    for (const i of ink) { const d = Math.abs(after.data[i * 3] - inp.data[i * 3]) + Math.abs(after.data[i * 3 + 1] - inp.data[i * 3 + 1]) + Math.abs(after.data[i * 3 + 2] - inp.data[i * 3 + 2]); if (d > 30) left++; }
    const ratio = ink.length ? left / ink.length : 0;
    // SFX dikdörtgeni çizim (gömlek çizgileri) içerir; sentetik "mürekkep" bunları da sayar → SFX'te tolerans %5
    const tol = tx.expect === "sfx" ? 0.05 : 0.02;
    out.results.push({ name: `Temizlik izi: ${tx.src.slice(0, 24)}`, status: ratio < tol ? "PASS" : "FAIL", inkPixels: ink.length, leftover: left, leftoverPct: Math.round(ratio * 1000) / 10 });
  });
  // 3) Maske dışı değişmedi mi (temizlik katmanı yalnız yazı farkında)
  let outside = 0; const inkSet = new Set(inkMasks.flat());
  for (let i = 0; i < W * H; i++) { if (inkSet.has(i)) continue; const d = Math.abs(after.data[i * 3] - orig.data[i * 3]) + Math.abs(after.data[i * 3 + 1] - orig.data[i * 3 + 1]) + Math.abs(after.data[i * 3 + 2] - orig.data[i * 3 + 2]); if (d > 40) outside++; }
  out.results.push({ name: "Yazı dışında belirgin değişen piksel", status: outside === 0 ? "PASS" : "FAIL", outside });
  // 4) SFX görünümü: orijinal kontur + büyük/kalın/büyük harf
  const sfx = s.state.items.find((i) => i.type === "sfx");
  if (sfx) { const r = P.resolveFor(s.state, sfx); out.results.push({ name: "SFX orijinal görünüm", status: r.style.strokeEnabled && r.style.fauxBold && r.style.uppercase && r.style.maxSizePx >= 64 ? "PASS" : "FAIL", font: r.style.font, maxSizePx: r.style.maxSizePx, stroke: r.style.strokeColor }); }
  out.finished = true;
  out.summary = { pass: out.results.filter((r) => r.status === "PASS").length, fail: out.results.filter((r) => r.status === "FAIL").length };
  save();
}).catch((e) => { out.fatal = String(e && (e.stack || e)); out.finished = true; save(); });
