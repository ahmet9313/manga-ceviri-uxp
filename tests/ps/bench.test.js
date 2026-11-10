// Performans kıyaslaması (800×10000 test sayfası). Torii yanıtları SAHTE (kredi harcanmaz, ağ süresi yok):
// yalnızca eklentinin kendi işi ölçülür. Sahte istemcinin kendi harcadığı süre toplamdan düşülür.
const fs = require("fs");
const { app } = require("photoshop");
const lfs = require("uxp").storage.localFileSystem;
const out = { runs: [] };
const save = () => fs.writeFileSync(RESULT_PATH, JSON.stringify(out, null, 1));
const api = R("../src/ps/api"), pixels = R("../src/ps/pixels"), geom = R("../src/util/geom");
const png = R("../src/util/png");
const { base64Encode } = R("../src/util/bytes");
const conf = R("../src/model/config");
const { Store, emptyState } = R("../src/model/store");
const { Pipeline } = R("../src/pipeline");
R("../src/ps/adobe").generativeFill = async () => { throw new Error("test: Üretken Dolgu kullanılamıyor"); }; // kredi koruması // kredi koruması

// Test sayfasındaki yazılar (belge pikseli) — OCR paragrafı ve görsel çeviri text[] üretmek için
const TEXTS = [
  { src: "XIAOFEI, I'M HEADING OUT FIRST. HURRY UP, OKAY?", tr: "Xiaofei, ben önden çıkıyorum. Acele et, tamam mı?", r: [462, 860, 712, 1032], fs: 30, color: [0, 0, 0] },
  { src: "OKAY.", tr: "Tamam.", r: [140, 1490, 240, 1530], fs: 30, color: [0, 0, 0] },
  { src: "WHAT ARE YOU DOING?! IF I GET CAUGHT, I'M DEAD!", tr: "NE YAPIYORSUN?! YAKALANIRSAM ÖLDÜM!", r: [432, 2203, 738, 2290], fs: 26, color: [40, 40, 190] },
  { src: "SUCH AN EASY-TO-UNDERSTAND LOOK...", tr: "Ne kadar da belli eden bir ifade…", r: [38, 3698, 427, 3784], fs: 32, color: [140, 110, 90] },
  { src: "BUT YOU'RE PRESSING EVEN CLOSER!", tr: "AMA DAHA DA YAKLAŞIYORSUN!", r: [296, 4203, 740, 4367], fs: 44, color: [127, 87, 214] },
  { src: "I CAN'T HOLD ON...", tr: "Daha fazla…", r: [90, 5040, 200, 5100], fs: 22, color: [127, 87, 214] },
  { src: "MUCH LONGER!", tr: "Dayanamayacağım!", r: [320, 5330, 520, 5370], fs: 28, color: [127, 87, 214] },
  { src: "SNAP.", tr: "ÇAT!", r: [40, 6740, 362, 7100], fs: 110, color: [128, 91, 59] },
  { src: "HUH?", tr: "Ha?", r: [120, 9150, 230, 9230], fs: 34, color: [0, 0, 0] },
  { src: "HUH HUH?", tr: "HA? HA?", r: [578, 9503, 712, 9617], fs: 40, color: [0, 0, 0] },
];
const rect = (l, t, r, b) => [[l, t], [r, t], [r, b], [l, b]];

function makeStubClient(origRgb, W, H) {
  const st = { ms: 0, calls: {} };
  const tick = async (name, fn) => { const t0 = Date.now(); try { return await fn(); } finally { st.ms += Date.now() - t0; st.calls[name] = (st.calls[name] || 0) + 1; } };
  // "Temizlenmiş" sayfa: yazı dikdörtgenlerindeki koyu/renkli mürekkep zemine boyanır (Torii inpainted taklidi)
  const inpRgb = new Uint8Array(origRgb);
  for (const t of TEXTS) {
    const [l, tp, r, b] = t.r;
    for (let y = tp; y < b; y++) for (let x = l; x < r; x++) {
      const i = (y * W + x) * 3;
      const lum = 0.299 * origRgb[i] + 0.587 * origRgb[i + 1] + 0.114 * origRgb[i + 2];
      if (lum < 170) { inpRgb[i] = 250; inpRgb[i + 1] = 250; inpRgb[i + 2] = 250; }
    }
  }
  let inpaintedDataUrl = null; // gerçek Torii JPEG döndürür; JPEG kodlayıcı güvenli olmadığından TEST_INPAINTED_JPEG verilirse o, yoksa PNG
  return {
    st, inpRgb,
    async prepare() {
      // Gerçek Torii gibi JPEG (run-ps-test.ps1 üretir); yoksa PNG
      const jpgPath = ASSET_PATH.replace(/MCS_TEST_page\.jpg$/, "MCS_TEST_inpainted.jpg");
      let jpg = null;
      try { jpg = new Uint8Array(fs.readFileSync(jpgPath)); } catch (e) { jpg = null; }
      inpaintedDataUrl = jpg ? "data:image/jpeg;base64," + base64Encode(jpg) : "data:image/png;base64," + base64Encode(png.encodePng(inpRgb, W, H, 3, 1));
      out.inpaintedFormat = jpg ? "jpeg" : "png";
    },
    lastCredits: 1000, onCredits: null,
    credits: () => tick("credits", async () => 1000),
    ocr: (image) => tick("ocr", async () => TEXTS.map((t) => ({
      text: t.src, polygon: rect(...t.r), fontsize: t.fs, angle: 0, alignment: "center", direction: "left_to_right",
      bg_color: [255, 255, 255], text_color: t.color, stroke_color: [255, 255, 255], has_dominant_bg_color: true, confidence: 0.97,
      language_details: { language: "ENGLISH", code: "en", confidence: 0.99 }, removed: false,
      lines: [{ text: t.src, polygon: rect(...t.r), removed: false }],
    }))),
    translateTexts: (texts) => tick("translateTexts", async () => ({ text: texts.map((s) => (TEXTS.find((t) => t.src === s) || { tr: s }).tr), metadata: { credits_used: 1.1 } })),
    inpaint: (image, mask) => tick("inpaint", async () => {
      const im = png.decodePng(image.bytes), mk = png.decodePng(mask.bytes);
      for (let i = 0; i < im.width * im.height; i++) if (mk.data[i]) { im.data[i * im.channels] = 250; im.data[i * im.channels + 1] = 250; im.data[i * im.channels + 2] = 250; }
      return "data:image/png;base64," + base64Encode(png.encodePng(im.data, im.width, im.height, im.channels, 1));
    }),
    translateImage: (image) => tick("translateImage", async () => ({
      inpainted: inpaintedDataUrl,
      text: TEXTS.map((t) => { const [l, tp, r, b] = t.r; return { x: (l + r) / 2, y: (tp + b) / 2, width: (r - l) * 0.8, height: (b - tp) * 0.8, text: t.tr, originalText: t.src, textAlign: "center", fillColor: "#000000", strokeColor: "#ffffff", lineWidth: 8, font: `${t.fs}px WildWords`, angle: 0, layout: "h" }; }),
      metadata: { credits_used: 7.8 },
    })),
  };
}

async function freshDoc() {
  for (const d of app.documents.slice()) if (String(d.title).indexOf("MCS_") === 0) await d.closeWithoutSaving();
  await app.open(await lfs.getEntryWithUrl("file:" + ASSET_PATH));
  return app.activeDocument;
}

function makeEnv(doc, client) {
  const store = new Store(); store.settings = conf.defaultSettings(); store.settings.fontChecks = {};
  const notes = [];
  const P = new Pipeline(store, client, { confirm: async () => 0, notify: (m, k) => notes.push(m), progress: () => {}, preview: async () => true, ambiguous: async () => false, busy: () => {} });
  store.attach(doc.id, doc.title, emptyState()); store.activeDocId = doc.id;
  return { store, P, notes };
}

async function timed(label, fn, client, rec) {
  const c0 = client.st.ms, t0 = Date.now();
  const r = await fn();
  const total = Date.now() - t0, stub = client.st.ms - c0;
  rec[label] = { ms: total - stub, stubMs: stub };
  return r;
}

api.modal("Performans kıyaslaması", async () => {
  // Ham ölçümler: tam sayfa okuma + PNG kodlama (her istekte yapılan iş)
  {
    const doc = await freshDoc();
    const rec = {};
    let t0 = Date.now();
    const img = await pixels.readComposite(doc.id, { left: 0, top: 0, right: doc.width, bottom: doc.height });
    rec.readFullPage = Date.now() - t0;
    t0 = Date.now(); const pngBytes = png.encodePng(img.data, img.width, img.height, 3, 4); rec.pngEncodeFullPage = Date.now() - t0; rec.pngBytes = pngBytes.length;
    // NOT: imaging.encodeImageData betik modalında hiç dönmeyip Photoshop'u kilitledi (10.11.2026) — kullanılmaz.
    out.raw = rec; save();
  }
  for (const mode of ["modular", "single"]) {
    const doc = await freshDoc();
    const pre = await pixels.readComposite(doc.id, { left: 0, top: 0, right: doc.width, bottom: doc.height });
    const client = makeStubClient(pre.data, doc.width, doc.height);
    await client.prepare();
    const { store, P, notes } = makeEnv(doc, client);
    P.debug = true; P._prof = {};
    store.settings.ui.fullMode = mode;
    const rec = { mode };
    const T0 = Date.now(); const s0 = client.st.ms;
    const t = P.captureTarget();
    if (mode === "modular") {
      await timed("detect", () => P._detectPage(t, false), client, rec);
      await timed("translate", () => P._translatePage(t, "page", {}), client, rec);
      await timed("clean", () => P._cleanPage(t, "page", {}), client, rec);
      await timed("typeset", () => P._typesetPage(t, "page", {}), client, rec);
    } else {
      await timed("fullSingle", () => P._fullSingleRequest(t), client, rec);
    }
    rec.totalMs = Date.now() - T0 - (client.st.ms - s0);
    rec.items = store.session(doc.id).state.items.length;
    rec.typesetCount = store.session(doc.id).state.items.filter((i) => i.status.typeset).length;
    rec.cleanedCount = store.session(doc.id).state.items.filter((i) => i.status.cleaned).length;
    rec.stubCalls = client.st.calls;
    rec.notes = notes.slice(-4);
    rec.typesetProfile = P._prof;
    out.runs.push(rec); save();
  }
  for (const d of app.documents.slice()) if (String(d.title).indexOf("MCS_") === 0) await d.closeWithoutSaving();
  out.finished = true; save();
}).catch((e) => { out.fatal = String(e && (e.stack || e)); out.finished = true; save(); });
