// Photoshop GEREKTİRMEYEN mantık testleri: tespit birleştirme ve "katmandaki metin = panelin yazdığı metin" karşılaştırması.
// Çalıştırma: bun tests/logic/merge.test.js
const fs = require("fs"), path = require("path");
const root = path.join(__dirname, "..", "..");
const classify = require(root + "/src/model/classify");
const ok = (c, m) => { console.log(c ? "ok  " : "FAIL", m); if (!c) process.exitCode = 1; };

const para = (text, l, t, r, b) => ({ text, polygon: [[l, t], [r, t], [r, b], [l, b]], fontsize: 20, has_dominant_bg_color: true, bg_color: [255, 255, 255], text_color: [0, 0, 0] });
const items = (ps) => classify.itemsFromOcr(ps, { left: 0, top: 0, scale: 1 });

// Aynı yanıtta iç içe iki paragraf: küçük olan büyüğün kutusunda. İkisi de ayrı öğe kalmalı, metinler karışmamalı.
let r = classify.mergeDetections([], items([para("WHAT ARE YOU DOING HERE", 0, 0, 300, 120), para("!?", 250, 80, 290, 115)]));
ok(r.items.length === 2 && r.added.length === 2 && r.items[0].source === "WHAT ARE YOU DOING HERE" && r.items[1].source === "!?", "aynı yanıttaki örtüşen paragraflar birleşmez: " + JSON.stringify(r.items.map((i) => i.source)));

// Yeniden tespit: var olan öğe güncellenir, ikinci kayıt oluşmaz; yeni paragraf eklenir
const first = classify.mergeDetections([], items([para("HELLO", 0, 0, 100, 50)])).items;
first[0].translation = "MERHABA"; first[0].locks.text = true;
r = classify.mergeDetections(first, items([para("HELL0", 2, 1, 101, 50), para("OTHER", 400, 0, 500, 50)]));
ok(r.items.length === 2 && r.updated.length === 1 && r.added.length === 1 && r.items[0].source === "HELLO" && r.items[0].translation === "MERHABA", "yeniden tespit: çift kayıt yok, kilitli metin korunur");

// matchesTranslation: text.js kaynağından (Photoshop modülü yüklenmeden)
const src = fs.readFileSync(path.join(root, "src", "ps", "text.js"), "utf8");
const pick = (name) => src.match(new RegExp("function " + name + "[\\s\\S]*?\\n}\\n"))[0];
const matches = new Function(pick("trUpper") + pick("matchesTranslation") + "; return matchesTranslation;")();
ok(matches("ÇAT!", "Çat!", "SNAP"), "BÜYÜK HARF hali aynı metin sayılır");
ok(matches("İYİ MİSİN, XIAO?", "İyi misin, Xiao?", "ARE YOU OK, XIAO?"), "Türkçe büyük harf + korunan özel ad");
ok(matches("satır 1\nsatır 2", "satır 1\r\nsatır 2", ""), "satır sonu farkı elle düzenleme değildir");
ok(!matches("Elle düzeltilmiş", "Çat!", "SNAP"), "gerçek elle düzenleme ayırt edilir");
