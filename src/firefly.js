// Firefly Services istemcisi — Adobe kimlik bilgileri eklentide DEĞİL, sunucu tarafındaki vekilde (server/firefly-proxy.mjs) durur.
// Panel yalnızca vekilin URL'sini bilir. Vekil alan adı manifest.json › requiredPermissions.network.domains içinde olmalıdır.
"use strict";
const { base64Encode, base64Decode, utf8Encode } = require("./util/bytes");
const { log } = require("./util/common");

class FireflyClient {
  constructor(getUrl) { this.getUrl = getUrl; }

  async _post(path, body, timeoutMs) {
    const base = (this.getUrl() || "").replace(/\/+$/, "");
    if (!base) throw new Error("Firefly vekil sunucusu tanımlı değil (Ayarlar › Firefly Services). Kurulum gerekiyor.");
    let timer;
    const t = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("Firefly zaman aşımı")), timeoutMs || 180000); });
    try {
      const res = await Promise.race([fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: utf8Encode(JSON.stringify(body)).buffer }), t]);
      const txt = await res.text();
      if (!res.ok) throw new Error(`Firefly vekil hatası (${res.status}): ${txt.slice(0, 300)}`);
      return JSON.parse(txt);
    } finally { clearTimeout(timer); }
  }

  async health() {
    const base = (this.getUrl() || "").replace(/\/+$/, "");
    if (!base) return { ok: false, reason: "URL yok" };
    try { const r = await fetch(base + "/health"); const j = await r.json(); return { ok: r.ok && j.ok, models: j.models || [], reason: j.reason }; }
    catch (e) { return { ok: false, reason: e.message }; }
  }

  /** Maskeli dolgu. image/mask: PNG baytları. → {mime, bytes} */
  async fill(imagePng, maskPng, prompt) {
    const j = await this._post("/fill", { image: base64Encode(imagePng), mask: base64Encode(maskPng), prompt: prompt || "" });
    log("info", "Firefly dolgu tamam");
    return { mime: j.mime, bytes: base64Decode(j.data) };
  }
}

module.exports = { FireflyClient };
