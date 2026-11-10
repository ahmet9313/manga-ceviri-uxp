// Photoshop GEREKTİRMEYEN mantık testleri (Bun ile): balon tespiti, balon içi mürekkep maskesi, tür önerisi.
// Çalıştırma: bun tests/logic/bubble.test.js
const root = require("path").join(__dirname, "..", "..");
const { detectBubble, refineTypeByStats } = require(root + "/src/model/classify");
const { bubbleInkMask } = require(root + "/src/model/cleanup");
const assert = (c, m) => { if (!c) { console.log("FAIL", m); process.exitCode = 1; } else console.log("ok", m.split(":")[0]); };
const W = 800, H = 1200, data = new Uint8Array(W * H * 3).fill(255);
const rect = (l, t, r, b, v) => { for (let y = t; y < b; y++) for (let x = l; x < r; x++) { const i = (y * W + x) * 3; data[i] = data[i + 1] = data[i + 2] = v; } };
rect(0, 0, W, 300, 90); rect(0, 700, W, H, 90);
const img = { data, width: W, height: H, bounds: { left: 0, top: 0 } }, page = { W, H };
assert(detectBubble(img, { box: { cx: 400, cy: 500, w: 300, h: 60 } }, page) === null, "boşluk balon değil");
for (let y = 760; y < 1000; y++) for (let x = 0; x < 400; x++) { const d = ((x - 120) / 260) ** 2 + ((y - 880) / 110) ** 2; const i = (y * W + x) * 3; const v = d < 0.92 ? 255 : d < 1.05 ? 0 : 90; data[i] = data[i + 1] = data[i + 2] = v; }
// yazı + kopuk nokta balonda
rect(60, 860, 180, 900, 0); rect(200, 940, 206, 946, 0);
const cut = detectBubble(img, { box: { cx: 120, cy: 880, w: 180, h: 60 } }, page);
assert(cut && cut.rect.left === 0 && !cut.rectangular, "kesik balon: " + JSON.stringify(cut));
for (let y = 100; y < 220; y++) for (let x = 500; x < 560; x++) { const i = (y * W + x) * 3; data[i] = 220; data[i + 1] = 30; data[i + 2] = 30; }
assert(detectBubble(img, { box: { cx: 530, cy: 160, w: 60, h: 120 } }, page) === null, "SFX harfi balon değil");
assert(detectBubble(img, { box: { cx: 400, cy: 500, w: 300, h: 60 } }, { W: 2000, H: 5000 }) === null, "kırpma kenarı");
// dikdörtgen anlatım kutusu
rect(450, 400, 750, 520, 0); rect(453, 403, 747, 517, 255); rect(500, 450, 700, 470, 0);
const box = detectBubble(img, { box: { cx: 600, cy: 460, w: 220, h: 40 } }, page);
assert(box && box.rectangular, "dikdörtgen kutu: " + JSON.stringify(box));
const r = refineTypeByStats({ source: "THE NEXT DAY", bubble: box, ocr: { fontsize: 20 }, box: { w: 220, h: 40, angle: 0 } }, { light: 1, uniform: 1, medianLuma: 255 }, 20);
assert(r.type === "narration", "kutu → anlatım: " + r.type);
// mürekkep maskesi: kesik balonda yazı + kopuk nokta; kontur değil
const area = { left: 0, top: 740, right: 420, bottom: 1010 }, aw = 420, ah = 270, rgb = new Uint8Array(aw * ah * 3);
for (let y = 0; y < ah; y++) rgb.set(data.subarray(((y + 740) * W) * 3, ((y + 740) * W + aw) * 3), y * aw * 3);
const ink = bubbleInkMask(rgb, aw, ah, area, cut, { cx: 120, cy: 880, w: 180, h: 60 });
const at = (x, y) => ink[(y - 740) * aw + x];
assert(at(100, 880) && at(203, 943), "yazı ve kopuk nokta maskede");
assert(!at(120, 775 - 6) && !at(370, 880), "kontur/dışarı maskede değil");
