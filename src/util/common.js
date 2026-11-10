// Ortak yardımcılar: kimlik, olay yayıcı, log (anahtar maskeleme), gecikme.
"use strict";

function uid(prefix) {
  return (prefix || "") + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function debounce(fn, ms) {
  let t = null;
  return function (...args) {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), ms);
  };
}

function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }

class Emitter {
  constructor() { this._h = {}; }
  on(ev, fn) { (this._h[ev] = this._h[ev] || []).push(fn); return () => this.off(ev, fn); }
  off(ev, fn) { this._h[ev] = (this._h[ev] || []).filter((f) => f !== fn); }
  emit(ev, ...a) { for (const f of (this._h[ev] || []).slice()) { try { f(...a); } catch (e) { console.error(e); } } }
}

// ---- Gizli bilgi maskeleme ----
const SECRET_PATTERNS = [
  /sk_torii_[A-Za-z0-9_\-]+/g,
  /(Bearer\s+)[A-Za-z0-9._\-]+/gi,
  /("?(?:x-byok-[a-z]+|authorization|api[_-]?key|apiKey|token|client_secret)"?\s*[:=]\s*"?)([^",\s}]+)/gi,
  /AIza[0-9A-Za-z_\-]{20,}/g,
  /sk-[A-Za-z0-9_\-]{16,}/g,
  /xai-[A-Za-z0-9_\-]{16,}/g,
];

function redact(input) {
  let s = typeof input === "string" ? input : safeStringify(input);
  s = s.replace(SECRET_PATTERNS[0], "sk_torii_****");
  s = s.replace(SECRET_PATTERNS[1], "$1****");
  s = s.replace(SECRET_PATTERNS[2], "$1****");
  s = s.replace(SECRET_PATTERNS[3], "AIza****");
  s = s.replace(SECRET_PATTERNS[4], "sk-****");
  s = s.replace(SECRET_PATTERNS[5], "xai-****");
  return s;
}

function safeStringify(o) {
  try {
    return JSON.stringify(o, (k, v) => {
      if (typeof v === "string" && v.length > 300 && /^data:/.test(v)) return v.slice(0, 40) + "…(" + v.length + " karakter)";
      if (v instanceof Uint8Array) return "<" + v.length + " bayt>";
      return v;
    });
  } catch (e) { return String(o); }
}

const logBuffer = [];
const logEmitter = new Emitter();
function log(level, msg, data) {
  const line = {
    t: new Date().toISOString().slice(11, 19),
    level,
    msg: redact(String(msg)),
    data: data === undefined ? undefined : redact(data),
  };
  logBuffer.push(line);
  if (logBuffer.length > 500) logBuffer.shift();
  try { (level === "error" ? console.error : console.log)("[MCS]", line.msg, line.data || ""); } catch (e) { /* yok say */ }
  logEmitter.emit("line", line);
}

module.exports = { uid, sleep, debounce, clone, Emitter, redact, log, logBuffer, logEmitter };
