// Photoshop GEREKTİRMEYEN Torii istemci testleri (sahte fetch, kredi harcanmaz). Çalıştırma: bun tests/logic/client.test.js
const root = require("path").join(__dirname, "..", "..");
const { ToriiClient, AmbiguousRequestError, ToriiError } = require(root + "/src/torii/client");
const ok = (c, m) => { console.log(c ? "ok  " : "FAIL", m); if (!c) process.exitCode = 1; };
const fakeRes = (status, body, h) => { h = h || {}; return { status, ok: status >= 200 && status < 300, headers: { get: (k) => (k in h ? String(h[k]) : null) }, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) }; };
(async () => {
  let n = 0;
  let c = new ToriiClient(async () => "k", { minIntervalMs: 0, fetchImpl: async () => { n++; return fakeRes(524, "<!DOCTYPE html><html>timeout</html>"); } });
  try { await c.ocr({ bytes: new Uint8Array(10), mime: "image/png", width: 100, height: 100 }); ok(false, "524 hata vermeli"); } catch (e) { ok(e instanceof AmbiguousRequestError && n === 1, "ücretli 524 → belirsiz, otomatik tekrar yok: " + e.message); }
  c = new ToriiClient(async () => "k", { minIntervalMs: 0, fetchImpl: async () => ({ status: 200, ok: true, headers: { get: () => null }, text: () => new Promise(() => {}) }) });
  c._req = c._request;
  const t0 = Date.now();
  // gövde hiç gelmezse zaman aşımı → belirsiz (kısa süre için iç fonksiyon)
  try { await c._request("POST", "/api/v2/ocr", { paid: true, timeoutMs: 300, label: "OCR" }); ok(false, "takılan gövde"); } catch (e) { ok(e instanceof AmbiguousRequestError && Date.now() - t0 < 2000, "takılan yanıt gövdesi zaman aşımına düşer → belirsiz"); }
  c = new ToriiClient(async () => "k", { minIntervalMs: 0, fetchImpl: async () => fakeRes(401, "<html><b>Unauthorized</b> sk_torii_SECRETKEY123</html>") });
  try { await c.credits(); } catch (e) { ok(e instanceof ToriiError && /Ayarlar/.test(e.message) && !/<|SECRETKEY/.test(e.message), "401 mesajı Türkçe, eyleme dönük, HTML ve anahtar yok: " + e.message); }
  c = new ToriiClient(async () => "k", { minIntervalMs: 0, fetchImpl: async () => fakeRes(402, { error: "Insufficient credits" }) });
  try { await c.credits(); } catch (e) { ok(/kredi yükleyin/.test(e.message), "402 → kredi yükleyin: " + e.message); }
  n = 0;
  c = new ToriiClient(async () => "k", { minIntervalMs: 0, fetchImpl: async () => (++n < 2 ? fakeRes(429, "slow", { "retry-after": 1 }) : fakeRes(200, { credits: 5 }, { credits: 5 })) });
  const t1 = Date.now(); const cr = await c.credits(); ok(cr === 5 && Date.now() - t1 >= 900, "429 Retry-After'a uyuldu");
})();
