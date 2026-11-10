// Türkçe büyük harf (text.js trUpper kopyası değil: kaynaktan okunur). Çalıştırma: bun tests/logic/upper.test.js
const fs = require("fs"), path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "..", "src", "ps", "text.js"), "utf8");
const fn = src.match(/function trUpper[\s\S]*?\n}\n/)[0];
const trUpper = new Function(fn + "; return trUpper;")();
const cases = [
  ["Xiao Zheng? İyi misin, şimdi!", "XIAO ZHENG?", "XIAO ZHENG? İYİ MİSİN, ŞİMDİ!"],
  ["Aşağı in, bin lira ver! Ñandú", "GET IN, I'LL BIN IT", "AŞAĞI İN, BİN LİRA VER! ÑANDÚ"],
  ["ıhlamur ve inci", "", "IHLAMUR VE İNCİ"],
];
for (const [s, src2, want] of cases) { const got = trUpper(s, src2); console.log(got === want ? "ok  " : "FAIL", JSON.stringify(s), "→", got); if (got !== want) process.exitCode = 1; }
