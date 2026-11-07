// Torii resmi API istemcisi — https://toriitranslate.com/api (Kasım 2026 dokümanına göre).
// Hız sınırı: 1 istek/sn (100 patlama). 429/503 → üstel geri çekilme ile yeniden dene (istek reddedildiği için ücret yok).
// Ağ hatası / zaman aşımı → ücretli uç noktalarda OTOMATİK TEKRAR YOK: AmbiguousRequestError fırlatılır.
"use strict";
const { utf8Encode, concatBytes } = require("../util/bytes");
const { sleep, log, redact } = require("../util/common");

const BASE_URL = "https://api.toriitranslate.com";
const LIMITS = { maxBytes: 50 * 1024 * 1024, maxSide: 100000, maxPixels: 100e6, ocrMinSide: 50 };

const TRANSLATORS = [
  { id: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash Lite (varsayılan)", family: "gemini" },
  { id: "gemini-3-flash", label: "Gemini 3 Flash", family: "gemini" },
  { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", family: "gemini" },
  { id: "gpt-6-luna", label: "GPT-6 Luna", family: "openai" },
  { id: "gpt-6.1-sol", label: "GPT-6.1 Sol", family: "openai" },
  { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash", family: "deepseek" },
  { id: "grok-4.20", label: "Grok 4.20", family: "xai" },
  { id: "kimi-k2.5", label: "Kimi K2.5", family: "other" },
  { id: "claude-sonnet-5.5", label: "Claude Sonnet 5.5", family: "anthropic" },
  { id: "claude-opus-5.5", label: "Claude Opus 5.5", family: "anthropic" },
];
const BYOK_PROVIDERS = ["google", "openai", "openrouter", "anthropic", "deepseek", "xai"];
const TORII_FONTS = ["wildwords", "noto", "badcomic", "mashanzheng", "komika", "bangers", "edo", "ridi", "bushidoo", "hayah", "itim", "mogul", "heroika", "shonen"];

class ToriiError extends Error {
  constructor(message, status, body) { super(message); this.name = "ToriiError"; this.status = status; this.body = body; }
}
/** Sunucuya ulaşıp ulaşmadığı bilinmeyen ücretli istek. Kullanıcıya sorulmadan tekrar gönderilmez. */
class AmbiguousRequestError extends Error {
  constructor(message, info) { super(message); this.name = "AmbiguousRequestError"; this.info = info; }
}

function makeMultipart(fields) {
  const boundary = "----MCSBoundary" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  const parts = [];
  for (const f of fields) {
    if (f.value == null) continue;
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${f.name}"`;
    if (f.filename) head += `; filename="${f.filename}"\r\nContent-Type: ${f.type || "application/octet-stream"}`;
    head += "\r\n\r\n";
    parts.push(utf8Encode(head));
    parts.push(f.value instanceof Uint8Array ? f.value : utf8Encode(String(f.value)));
    parts.push(utf8Encode("\r\n"));
  }
  parts.push(utf8Encode(`--${boundary}--\r\n`));
  return { body: concatBytes(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

function checkImageLimits(bytes, width, height, endpoint) {
  if (bytes.length > LIMITS.maxBytes) throw new ToriiError(`Görsel ${Math.round(bytes.length / 1048576)} MB; Torii sınırı 50 MB.`, 0);
  if (width && height) {
    if (Math.max(width, height) > LIMITS.maxSide) throw new ToriiError("Görselin uzun kenarı 100.000 px sınırını aşıyor.", 0);
    if (width * height > LIMITS.maxPixels) throw new ToriiError("Görsel 100 megapiksel sınırını aşıyor.", 0);
    if (endpoint === "ocr" && Math.min(width, height) < LIMITS.ocrMinSide) throw new ToriiError("OCR için görsel en az 50×50 px olmalı.", 0);
  }
}

class ToriiClient {
  /** getKey: async () => string ; options: { minIntervalMs, fetchImpl } */
  constructor(getKey, options) {
    this.getKey = getKey;
    this.minIntervalMs = (options && options.minIntervalMs) || 1050;
    this.fetch = (options && options.fetchImpl) || ((...a) => fetch(...a));
    this._chain = Promise.resolve();
    this._lastStart = 0;
    this.lastCredits = null;
    this.onCredits = null;
  }

  /** Tüm istekleri sıraya alır ve 1 istek/sn hızını uygular. */
  _schedule(fn) {
    const run = async () => {
      const wait = this._lastStart + this.minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      this._lastStart = Date.now();
      return fn();
    };
    const p = this._chain.then(run, run);
    this._chain = p.catch(() => {});
    return p;
  }

  async _request(method, path, { body, contentType, headers, paid, timeoutMs, label }) {
    const key = await this.getKey();
    if (!key) throw new ToriiError("Torii API anahtarı tanımlı değil. Ayarlar sekmesinden ekleyin.", 401);
    const url = BASE_URL + path;
    let attempt = 0;
    for (;;) {
      attempt++;
      const started = Date.now();
      let res;
      if (this.onWait) this.onWait(label || path);
      try {
        res = await this._schedule(() => this._fetchWithTimeout(url, {
          method,
          headers: Object.assign({ Authorization: "Bearer " + key }, contentType ? { "Content-Type": contentType } : {}, headers || {}),
          body: body ? body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) : undefined,
        }, timeoutMs || 120000));
      } catch (e) {
        log("warn", `${label || path}: ağ hatası/zaman aşımı`, { attempt, error: String(e && e.message) });
        if (paid) {
          throw new AmbiguousRequestError(
            "İstek zaman aşımına uğradı veya bağlantı koptu. Sunucunun isteği işleyip işlemediği bilinmiyor; kredi düşmüş olabilir.",
            { path, label, elapsedMs: Date.now() - started, creditsBefore: this.lastCredits });
        }
        if (attempt < 3) { await sleep(1000 * attempt); continue; }
        throw new ToriiError("Torii'ye bağlanılamadı: " + (e && e.message), 0);
      }
      const creditsHdr = res.headers.get("credits");
      if (creditsHdr != null && creditsHdr !== "") {
        const c = Number(creditsHdr);
        if (!isNaN(c)) { this.lastCredits = c; if (this.onCredits) this.onCredits(c); }
      }
      if (res.status === 429 || res.status === 503) {
        if (attempt <= 5) {
          const backoff = Math.min(30000, 1000 * Math.pow(2, attempt - 1)) + Math.random() * 400;
          log("warn", `${label || path}: hız sınırı (${res.status}), ${Math.round(backoff)} ms sonra tekrar`);
          await sleep(backoff);
          continue;
        }
        throw new ToriiError("Torii hız sınırı aşıldı, daha sonra deneyin.", res.status);
      }
      const text = await res.text();
      const successHdr = res.headers.get("success");
      if (!res.ok || successHdr === "false") {
        log("error", `${label || path}: HTTP ${res.status}`, text.slice(0, 500));
        throw new ToriiError(this._errorMessage(res.status, text), res.status, redact(text.slice(0, 2000)));
      }
      let json;
      try { json = JSON.parse(text); } catch (e) { throw new ToriiError("Torii yanıtı JSON değil: " + text.slice(0, 200), res.status); }
      log("info", `${label || path}: tamam (${Date.now() - started} ms)`, json && json.metadata ? { credits_used: json.metadata.credits_used } : undefined);
      return json;
    }
  }

  _errorMessage(status, text) {
    let msg = text;
    try { const j = JSON.parse(text); msg = j.error || j.message || j.detail || text; } catch (e) { /* düz metin */ }
    msg = redact(String(msg)).slice(0, 400);
    if (status === 401 || status === 403) return "Torii anahtarı reddedildi (" + status + "): " + msg;
    if (status === 402) return "Yetersiz kredi: " + msg;
    if (status === 413) return "Görsel çok büyük: " + msg;
    return `Torii hatası (${status}): ${msg}`;
  }

  async _fetchWithTimeout(url, init, ms) {
    let timer;
    const ctrl = typeof AbortController === "function" ? new AbortController() : null;
    if (ctrl) init.signal = ctrl.signal;
    const timeout = new Promise((_, rej) => { timer = setTimeout(() => { if (ctrl) ctrl.abort(); rej(new Error("zaman aşımı (" + ms / 1000 + " sn)")); }, ms); });
    try { return await Promise.race([this.fetch(url, init), timeout]); } finally { clearTimeout(timer); }
  }

  // ---------------- Ücretsiz uç noktalar ----------------
  async credits() {
    const j = await this._request("GET", "/api/credits", { paid: false, timeoutMs: 20000, label: "Kredi" });
    if (typeof j.credits === "number") { this.lastCredits = j.credits; if (this.onCredits) this.onCredits(j.credits); }
    return j.credits;
  }
  keys() { return this._request("GET", "/api/keys", { paid: false, timeoutMs: 20000, label: "Anahtarlar" }); }

  // ---------------- Ücretli uç noktalar ----------------
  /** OCR — 1 kredi. image: {bytes, mime, width, height} → paragraf dizisi */
  async ocr(image) {
    checkImageLimits(image.bytes, image.width, image.height, "ocr");
    const mp = makeMultipart([{ name: "file", value: image.bytes, filename: image.mime === "image/png" ? "page.png" : "page.jpg", type: image.mime }]);
    const j = await this._request("POST", "/api/v2/ocr", { body: mp.body, contentType: mp.contentType, paid: true, timeoutMs: 120000, label: "OCR" });
    if (!Array.isArray(j)) throw new ToriiError("OCR yanıtı beklenen dizi değil", 200);
    return j;
  }

  /** Görsel çevirisi (tek istekte OCR+çeviri+inpaint). */
  async translateImage(image, opts) {
    checkImageLimits(image.bytes, image.width, image.height, "upload");
    const fields = this._translateFields(opts);
    fields.unshift({ name: "file", value: image.bytes, filename: image.mime === "image/png" ? "page.png" : "page.jpg", type: image.mime });
    const mp = makeMultipart(fields);
    return this._request("POST", "/api/v2/upload", { body: mp.body, contentType: mp.contentType, headers: this._byokHeaders(opts), paid: true, timeoutMs: 300000, label: "Görsel çeviri" });
  }

  /** Yalnızca metin çevirisi. Sıra korunur: dönen text[i] ↔ texts[i]. */
  async translateTexts(texts, opts) {
    if (!texts.length) return { text: [], context: opts && opts.context };
    const fields = this._translateFields(opts);
    fields.unshift({ name: "texts", value: JSON.stringify(texts) });
    const mp = makeMultipart(fields);
    const j = await this._request("POST", "/api/v2/upload", { body: mp.body, contentType: mp.contentType, headers: this._byokHeaders(opts), paid: true, timeoutMs: 180000, label: "Metin çeviri" });
    if (!Array.isArray(j.text) || j.text.length !== texts.length) {
      throw new ToriiError(`Çeviri sayısı uyuşmuyor (gönderilen ${texts.length}, gelen ${j.text ? j.text.length : 0}).`, 200);
    }
    return j;
  }

  /** Inpaint — 0,02 kredi. image ve mask aynı boyutta PNG. → Data URL */
  async inpaint(image, mask) {
    checkImageLimits(image.bytes, image.width, image.height, "inpaint");
    if (image.width !== mask.width || image.height !== mask.height) throw new ToriiError("Maske ve görsel aynı boyutta olmalı.", 0);
    const mp = makeMultipart([
      { name: "image", value: image.bytes, filename: "image.png", type: image.mime },
      { name: "mask", value: mask.bytes, filename: "mask.png", type: "image/png" },
    ]);
    const j = await this._request("POST", "/api/inpaint", { body: mp.body, contentType: mp.contentType, paid: true, timeoutMs: 180000, label: "Inpaint" });
    if (!j.image) throw new ToriiError("Inpaint yanıtında görsel yok", 200);
    return j.image;
  }

  _translateFields(o) {
    o = o || {};
    const f = [{ name: "target_lang", value: o.target_lang || "tr" }];
    const add = (n, v) => { if (v !== undefined && v !== null && v !== "") f.push({ name: n, value: v }); };
    add("translator", o.translator);
    add("reasoning_effort", o.reasoning_effort);
    add("font", o.font);
    add("text_align", o.text_align);
    if (o.min_font_size) add("min_font_size", Math.max(6, Math.min(100, Math.round(o.min_font_size))));
    if (o.stroke_disabled != null) add("stroke_disabled", o.stroke_disabled ? "true" : "false");
    if (o.bubbles_only != null) add("bubbles_only", o.bubbles_only ? "true" : "false");
    if (o.source_langs_whitelist && o.source_langs_whitelist.length) add("source_langs_whitelist", JSON.stringify(o.source_langs_whitelist));
    if (o.custom_prompt) add("custom_prompt", String(o.custom_prompt).slice(0, 1000));
    if (o.context) add("context", String(o.context).slice(-10000));
    if (o.byok && o.byok.provider && o.byok.key) {
      // Dokümandaki örnek kod BYOK'u form alanı olarak da gönderiyor; ikisini birlikte gönderiyoruz.
      add("x-byok-" + o.byok.provider, o.byok.key);
      add("x-byok-fallback", o.byok.fallback ? "true" : "false");
    }
    return f;
  }

  _byokHeaders(o) {
    if (!o || !o.byok || !o.byok.provider || !o.byok.key) return {};
    return { ["x-byok-" + o.byok.provider]: o.byok.key, "x-byok-fallback": o.byok.fallback ? "true" : "false" };
  }
}

/** Kredi tahmini (Torii dokümanı: çeviri ≥1, OCR 1, inpaint 0,02; BYOK görsel 1 / metin 0,1). */
function estimateCredits(plan) {
  let min = 0;
  const notes = [];
  for (const p of plan) {
    if (p.kind === "upload-image") { min += 1; notes.push("Görsel çeviri ≥1"); }
    if (p.kind === "ocr") { min += 1; }
    if (p.kind === "translate-texts") { min += p.byok ? 0.1 : 1; }
    if (p.kind === "inpaint") { min += 0.02; }
  }
  return { min: Math.round(min * 100) / 100, approx: true, notes };
}

module.exports = { ToriiClient, ToriiError, AmbiguousRequestError, TRANSLATORS, BYOK_PROVIDERS, TORII_FONTS, LIMITS, estimateCredits, makeMultipart, BASE_URL };
