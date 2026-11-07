// Firefly Services vekil sunucusu (Node.js 18+, bağımlılık yok).
// Adobe sunucu kimlik bilgileri YALNIZCA burada, ortam değişkenlerinde tutulur; eklenti paketine girmez.
//
//   set FIREFLY_CLIENT_ID=...      (Adobe Developer Console › OAuth Server-to-Server)
//   set FIREFLY_CLIENT_SECRET=...
//   node server/firefly-proxy.mjs  → http://127.0.0.1:8787
//
// Uç noktalar (eklenti bunları çağırır):
//   GET  /health                      → {ok, models}
//   POST /fill     {image, mask, prompt}  (base64 PNG) → {mime, data}
//   POST /generate {prompt, width, height}             → {mime, data}
// Resmi API'ler: IMS token v3, Firefly v2/storage/image, v3/images/fill, v3/images/generate.
import http from "node:http";

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";
const CLIENT_ID = process.env.FIREFLY_CLIENT_ID || "";
const CLIENT_SECRET = process.env.FIREFLY_CLIENT_SECRET || "";
const SCOPES = process.env.FIREFLY_SCOPES || "openid,AdobeID,session,additional_info,read_organizations,firefly_api,ff_apis";
const FF = "https://firefly-api.adobe.io";

let token = null, tokenExp = 0;
async function getToken() {
  if (token && Date.now() < tokenExp - 60000) return token;
  const body = new URLSearchParams({ grant_type: "client_credentials", client_id: CLIENT_ID, client_secret: CLIENT_SECRET, scope: SCOPES });
  const r = await fetch("https://ims-na1.adobelogin.com/ims/token/v3", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  if (!r.ok) throw new Error("IMS token alınamadı: " + r.status + " " + (await r.text()).slice(0, 200));
  const j = await r.json();
  token = j.access_token; tokenExp = Date.now() + (j.expires_in || 3600) * 1000;
  return token;
}

async function ffHeaders(extra) {
  return Object.assign({ Authorization: "Bearer " + (await getToken()), "x-api-key": CLIENT_ID }, extra || {});
}

async function upload(pngB64) {
  const r = await fetch(FF + "/v2/storage/image", { method: "POST", headers: await ffHeaders({ "Content-Type": "image/png" }), body: Buffer.from(pngB64, "base64") });
  if (!r.ok) throw new Error("Firefly yükleme hatası: " + r.status + " " + (await r.text()).slice(0, 300));
  const j = await r.json();
  return j.images[0].id;
}

async function download(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error("Çıktı indirilemedi: " + r.status);
  const mime = r.headers.get("content-type") || "image/jpeg";
  return { mime: mime.split(";")[0], data: Buffer.from(await r.arrayBuffer()).toString("base64") };
}

async function fill({ image, mask, prompt }) {
  const imgId = await upload(image), maskId = await upload(mask);
  const r = await fetch(FF + "/v3/images/fill", { method: "POST", headers: await ffHeaders({ "Content-Type": "application/json" }), body: JSON.stringify({ image: { source: { uploadId: imgId } }, mask: { source: { uploadId: maskId } }, prompt: prompt || undefined, numVariations: 1 }) });
  if (!r.ok) throw new Error("Firefly fill hatası: " + r.status + " " + (await r.text()).slice(0, 300));
  const j = await r.json();
  return download(j.outputs[0].image.url);
}

async function generate({ prompt, width, height }) {
  const r = await fetch(FF + "/v3/images/generate", { method: "POST", headers: await ffHeaders({ "Content-Type": "application/json" }), body: JSON.stringify({ prompt, numVariations: 1, size: width && height ? { width, height } : undefined }) });
  if (!r.ok) throw new Error("Firefly generate hatası: " + r.status + " " + (await r.text()).slice(0, 300));
  const j = await r.json();
  return download(j.outputs[0].image.url);
}

function send(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(obj));
}

http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      if (!CLIENT_ID || !CLIENT_SECRET) return send(res, 200, { ok: false, reason: "FIREFLY_CLIENT_ID / FIREFLY_CLIENT_SECRET tanımlı değil" });
      await getToken();
      return send(res, 200, { ok: true, models: ["firefly-fill", "firefly-generate"] });
    }
    if (req.method !== "POST") return send(res, 404, { error: "bulunamadı" });
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (req.url === "/fill") return send(res, 200, await fill(body));
    if (req.url === "/generate") return send(res, 200, await generate(body));
    return send(res, 404, { error: "bulunamadı" });
  } catch (e) {
    console.error(e.message); // gizli bilgi loglanmaz
    send(res, 502, { error: e.message });
  }
}).listen(PORT, HOST, () => console.log(`Firefly vekili http://${HOST}:${PORT}`));
