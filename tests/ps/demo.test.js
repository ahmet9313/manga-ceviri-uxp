// Ekran görüntüsü için demo: MCS_ test kopyasını açar, örnek öğeleri PSD durumuna (XMP) yazar ve AÇIK bırakır.
// Panel belgeyi algılayınca öğeleri gösterir. Torii çağrısı YOK. Kapatmak için: -Name closeall
const fs = require("fs");
const { app } = require("photoshop");
const lfs = require("uxp").storage.localFileSystem;
const out = { results: [] };
const save = () => fs.writeFileSync(RESULT_PATH, JSON.stringify(out, null, 1));
const api = R("../src/ps/api"), docs = R("../src/ps/document"), geom = R("../src/util/geom");
const { emptyState } = R("../src/model/store");
const { uid } = R("../src/util/common");

const TEXTS = [
  ["XIAOFEI, I'M HEADING OUT FIRST. HURRY UP, OKAY?", "Xiaofei, ben önden çıkıyorum. Acele et, tamam mı?", [462, 860, 712, 1032], "dialog", 1, 1, 1],
  ["OKAY.", "Tamam.", [140, 1490, 240, 1530], "dialog", 1, 1, 1],
  ["WHAT ARE YOU DOING?! IF I GET CAUGHT, I'M DEAD!", "NE YAPIYORSUN?! YAKALANIRSAM ÖLDÜM!", [432, 2203, 738, 2290], "dialog", 1, 1, 0],
  ["SUCH AN EASY-TO-UNDERSTAND LOOK...", "Ne kadar da belli eden bir ifade…", [38, 3698, 427, 3784], "narration", 1, 1, 0],
  ["BUT YOU'RE PRESSING EVEN CLOSER!", "AMA DAHA DA YAKLAŞIYORSUN!", [296, 4203, 740, 4367], "dialog", 0, 1, 0],
  ["I CAN'T HOLD ON...", "", [90, 5040, 200, 5100], "offbubble", 0, 0, 0],
  ["SNAP.", "ÇAT!", [40, 6740, 362, 7100], "sfx", 0, 1, 0],
  ["HUH HUH?", "HA? HA?", [578, 9503, 712, 9617], "dialog", 0, 0, 0],
];

api.modal("Demo belge", async () => {
  for (const d of app.documents.slice()) if (String(d.title).indexOf("MCS_") === 0) await d.closeWithoutSaving();
  await app.open(await lfs.getEntryWithUrl("file:" + ASSET_PATH));
  const doc = app.activeDocument;
  const st = emptyState();
  st.items = TEXTS.map(([src, tr, r, type, cleaned, translated, typeset], i) => {
    const box = { cx: (r[0] + r[2]) / 2, cy: (r[1] + r[3]) / 2, w: r[2] - r[0], h: r[3] - r[1], angle: 0 }, poly = geom.boxToPolygon(box);
    return { id: uid("i_"), order: i + 1, source: src, translation: tr, type, typeSuggested: type, typeConfirmed: i < 5, typeReasons: [type === "sfx" ? "kısa yansıma sözcüğü, büyük yazı" : "kapalı balon içinde"], tone: /!$/.test(tr) ? "shout" : "normal",
      direction: "left_to_right", polygon: poly, lines: [poly], box, bounds: geom.polygonBounds(poly), ocr: { fontsize: 30 }, locks: { text: i === 1, style: false, position: false }, manual: {},
      status: { detected: true, translated: !!translated, cleaned: !!cleaned, typeset: !!typeset } };
  });
  await docs.writeState(doc.id, st);
  out.results.push({ name: "demo yazıldı", status: "PASS", doc: doc.title, items: st.items.length });
  out.finished = true; save();
}).catch((e) => { out.fatal = String(e && (e.stack || e)); out.finished = true; save(); });
