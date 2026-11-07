// Ağ gerektirmeyen birim testleri (Torii istemcisi sahte fetch ile; dokümandaki örnek yanıtlar).
const out = { results: [] };
const save = () => require("fs").writeFileSync(RESULT_PATH, JSON.stringify(out, null, 1));
async function test(name, fn) { try { out.results.push({ name, status: "PASS", detail: await fn() }); } catch (e) { out.results.push({ name, status: "FAIL", error: String(e && (e.stack || e)).slice(0, 800) }); } save(); }
const assert = (c, m) => { if (!c) throw new Error(m); };
const { ToriiClient, AmbiguousRequestError } = R("../src/torii/client");
const { utf8Decode } = R("../src/util/bytes");
const classify = R("../src/model/classify");
const geom = R("../src/util/geom");
const png = R("../src/util/png");
const { resolveStyle } = R("../src/model/rules");
const { redact } = R("../src/util/common");

function fakeRes(status, body, headers) {
  const h = Object.assign({ success: status === 200 ? "true" : "false" }, headers || {});
  return { status, ok: status >= 200 && status < 300, headers: { get: (k) => (k in h ? String(h[k]) : null) }, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) };
}

// .psjs içinde zamanlayıcılar yalnızca modal kapsamda çalışıyor → testler tek modal içinde
R("../src/ps/api").modal("Birim testleri", async () => {
  await test("Multipart: v2/upload texts alanları + Bearer", async () => {
    let seen;
    const c = new ToriiClient(async () => "sk_torii_TESTKEY", { minIntervalMs: 0, fetchImpl: async (url, init) => { seen = { url, init }; return fakeRes(200, { text: ["Merhaba", "Yarın görüşürüz"], detected_lang: "en", metadata: { credits_used: 0.25 }, context: "ctx1" }, { credits: 99.5 }); } });
    const j = await c.translateTexts(["Hello", "See you tomorrow"], { target_lang: "tr", translator: "gemini-3.1-flash-lite", custom_prompt: "x".repeat(1200), context: "y".repeat(12000), byok: { provider: "google", key: "AIzaFAKE", fallback: true } });
    const body = utf8Decode(new Uint8Array(seen.init.body));
    assert(seen.url === "https://api.toriitranslate.com/api/v2/upload", seen.url);
    assert(seen.init.headers.Authorization === "Bearer sk_torii_TESTKEY", "auth");
    assert(/multipart\/form-data; boundary=/.test(seen.init.headers["Content-Type"]), "content-type");
    assert(body.includes('name="texts"') && body.includes('["Hello","See you tomorrow"]'), "texts alanı");
    assert(body.includes('name="target_lang"\r\n\r\ntr'), "target_lang");
    assert(/name="custom_prompt"\r\n\r\nx{1000}\r\n/.test(body), "custom_prompt 1000 ile sınırlı");
    assert(/name="context"\r\n\r\ny{10000}\r\n/.test(body), "context son 10000");
    assert(seen.init.headers["x-byok-google"] === "AIzaFAKE", "BYOK başlığı");
    assert(j.text[1] === "Yarın görüşürüz" && c.lastCredits === 99.5, "yanıt + kredi başlığı");
    return { bytes: body.length };
  });

  await test("429 → üstel geri çekilme ile yeniden dene (ücretsiz ret)", async () => {
    let n = 0;
    const c = new ToriiClient(async () => "k", { minIntervalMs: 0, fetchImpl: async () => (++n < 3 ? fakeRes(429, "slow down") : fakeRes(200, { credits: 5 })) });
    const v = await c.credits();
    assert(v === 5 && n === 3, "deneme sayısı " + n);
    return { attempts: n };
  });

  await test("Belirsiz zaman aşımı: ücretli istek OTOMATİK tekrar gönderilmez", async () => {
    let n = 0;
    const c = new ToriiClient(async () => "k", { minIntervalMs: 0, fetchImpl: async () => { n++; throw new Error("network down"); } });
    let err = null;
    try { await c.ocr({ bytes: new Uint8Array(10), mime: "image/png", width: 100, height: 100 }); } catch (e) { err = e; }
    assert(err instanceof AmbiguousRequestError && n === 1, "tek deneme + belirsiz hata; n=" + n);
    return { attempts: n, message: err.message };
  });

  await test("Hız sınırı: istekler arası ≥1 sn", async () => {
    const times = [];
    const c = new ToriiClient(async () => "k", { minIntervalMs: 1000, fetchImpl: async () => { times.push(Date.now()); return fakeRes(200, { credits: 1 }); } });
    await Promise.all([c.credits(), c.credits(), c.credits()]);
    const gaps = [times[1] - times[0], times[2] - times[1]];
    assert(gaps.every((g) => g >= 990), "aralıklar " + gaps);
    return { gaps };
  });

  await test("v2/upload text[]: x,y MERKEZ → belge kutusu (+ kırpma ofseti)", async () => {
    const t = { x: 623.0, y: 326.5, width: 50.0, height: 141.0, text: "Tanjiro", originalText: "炭治郎", textAlign: "center", strokeColor: "#f9f7f9", lineWidth: 10, fillColor: "#0e0c0f", font: "36px WildWords", angle: 0, layout: "v", textDir: "ltr" };
    const items = classify.itemsFromUpload([t], { left: 100, top: 2000, scale: 1 });
    const b = items[0].bounds;
    assert(Math.abs(b.left - (100 + 623 - 25)) < 0.01 && Math.abs(b.top - (2000 + 326.5 - 70.5)) < 0.01, JSON.stringify(b));
    assert(items[0].direction === "top_to_bottom" && items[0].translation === "Tanjiro", "yön/çeviri");
    return { bounds: b, type: items[0].type };
  });

  await test("v2/ocr: BGR renk, poligon, kırpma ofseti, tür önerisi", async () => {
    const para = { text: "Thank you very much!", polygon: [[10, 320], [170, 320], [170, 370], [10, 370]], fontsize: 24, angle: 0, alignment: "center", direction: "left_to_right", bg_color: [255, 255, 255], text_color: [0, 0, 200], stroke_color: [0, 0, 0], has_dominant_bg_color: true, confidence: 0.998, language_details: { language: "ENGLISH", code: "en", confidence: 0.999 }, removed: false, lines: [{ text: "Thank you", polygon: [[11, 326], [165, 327], [165, 361], [11, 360]], removed: false }] };
    const removed = Object.assign({}, para, { removed: true });
    const items = classify.itemsFromOcr([para, removed], { left: 50, top: 1000, scale: 1 });
    assert(items.length === 1, "removed elenmeli");
    assert(items[0].ocr.textColor === "#c80000", "BGR→RGB " + items[0].ocr.textColor);
    assert(items[0].bounds.left === 60 && items[0].bounds.top === 1320, JSON.stringify(items[0].bounds));
    assert(items[0].type === "dialog", "beyaz düz zemin → diyalog");
    const sfx = classify.itemsFromOcr([Object.assign({}, para, { text: "BAM", fontsize: 120, has_dominant_bg_color: false }), para, para], { left: 0, top: 0 });
    assert(sfx[0].type === "sfx", "büyük kısa yazı → SFX: " + sfx[0].type);
    return { item: { bounds: items[0].bounds, type: items[0].type, lang: items[0].sourceLang } };
  });

  await test("Birleştirme: aynı öğe ikinci kez eklenmez, kilitli metin korunur", async () => {
    const mk = (txt, x) => classify.itemsFromOcr([{ text: txt, polygon: [[x, 0], [x + 100, 0], [x + 100, 50], [x, 50]], fontsize: 20, has_dominant_bg_color: true, bg_color: [255, 255, 255], text_color: [0, 0, 0] }], { left: 0, top: 0 })[0];
    const a = mk("HELLO", 0); a.locks.text = true; a.translation = "MERHABA"; a.translationEdited = true;
    const r = classify.mergeDetections([a], [mk("HELL0 changed", 3), mk("OTHER", 400)]);
    assert(r.items.length === 2 && r.added.length === 1 && r.items[0].source === "HELLO" && r.items[0].translation === "MERHABA", JSON.stringify(r.items.map((i) => i.source)));
    return { items: r.items.length };
  });

  await test("Stil önceliği: manuel → bölüm → seri → genel → varsayılan; en yüksek öncelikli kural", async () => {
    const item = { type: "dialog", tone: "shout", source: "NO WAY!!", translation: "OLAMAZ!!", manual: { color: "#123456" }, ocr: {} };
    const levels = [
      { level: "chapter", label: "Bölüm", rules: [{ name: "B-bağırma", priority: 5, types: ["dialog"], tones: ["shout"], style: { sizePx: 50 } }], base: {} },
      { level: "series", label: "Seri", rules: [{ name: "S-düşük", priority: 10, tones: ["shout"], style: { font: "Low", sizePx: 20 } }, { name: "S-yüksek", priority: 90, tones: ["shout"], style: { font: "High", strokeEnabled: true } }], base: { font: "Base", tracking: 30 } },
      { level: "global", label: "Genel", rules: [], base: { align: "left", tracking: 99 } },
    ];
    const r = resolveStyle(item, levels, { medianFont: 20 });
    assert(r.style.color === "#123456" && r.sources.color.level === "manual", "manuel renk");
    assert(r.style.sizePx === 50 && r.sources.sizePx.level === "chapter", "bölüm punto");
    assert(r.style.font === "High" && r.sources.font.rule === "S-yüksek", "en yüksek öncelikli seri kuralı");
    assert(r.style.tracking === 30 && r.style.align === "left" && r.sources.leadingPct.level === "default", "seri taban > genel > varsayılan");
    return r.sources;
  });

  await test("PNG kodla/çöz gidiş-dönüş (maske + RGB)", async () => {
    const w = 37, h = 23, rgb = new Uint8Array(w * h * 3), m = new Uint8Array(w * h);
    for (let i = 0; i < rgb.length; i++) rgb[i] = (i * 31) & 255;
    for (let i = 0; i < m.length; i++) m[i] = i % 7 ? 0 : 255;
    const a = png.decodePng(png.encodePng(rgb, w, h, 3)), b = png.decodePng(png.encodePng(m, w, h, 1));
    assert(a.width === w && a.channels === 3 && a.data.every((v, i) => v === rgb[i]), "rgb");
    assert(b.channels === 1 && b.data.every((v, i) => v === m[i]), "mask");
    return "ok";
  });

  await test("Loglarda anahtar maskeleme", async () => {
    const s = redact('Authorization: Bearer sk_torii_80n3FabcdefBUfA {"x-byok-google":"AIzaSyABCDEFGHIJKLMNOPQRSTUV"}');
    assert(!/80n3Fabcdef/.test(s) && !/AIzaSyABCDEFGHIJ/.test(s), s);
    return s;
  });

  await test("Ekran→belge dönüşümü (zoom, DPI)", async () => {
    const a = geom.screenDeltaToDoc(10, 20, { zoom: 0.5, devicePixelRatio: 1.25 });
    assert(Math.abs(a[0] - 25) < 1e-9 && Math.abs(a[1] - 50) < 1e-9, String(a));
    return a;
  });

  out.finished = true;
  out.summary = { pass: out.results.filter((r) => r.status === "PASS").length, fail: out.results.filter((r) => r.status === "FAIL").length };
  save();
}).catch((e) => { out.fatal = String(e && (e.stack || e)); save(); });
