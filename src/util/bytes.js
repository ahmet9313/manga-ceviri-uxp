// UTF-8 ve base64 yardımcıları (UXP'de TextEncoder bulunmadığı için elle).
"use strict";

function utf8Encode(str) {
  const out = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      const c2 = str.charCodeAt(i + 1);
      if (c2 >= 0xdc00 && c2 <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
        i++;
      }
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return new Uint8Array(out);
}

function utf8Decode(bytes) {
  let s = "";
  const CH = 0x2000;
  const codes = [];
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i++];
    let c;
    if (b < 0x80) c = b;
    else if (b < 0xe0) c = ((b & 31) << 6) | (bytes[i++] & 63);
    else if (b < 0xf0) c = ((b & 15) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63);
    else c = ((b & 7) << 18) | ((bytes[i++] & 63) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63);
    if (c > 0xffff) {
      c -= 0x10000;
      codes.push(0xd800 + (c >> 10), 0xdc00 + (c & 1023));
    } else codes.push(c);
    if (codes.length >= CH) { s += String.fromCharCode.apply(null, codes); codes.length = 0; }
  }
  return s + String.fromCharCode.apply(null, codes);
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64REV = (() => {
  const t = new Int16Array(256).fill(-1);
  for (let i = 0; i < 64; i++) t[B64.charCodeAt(i)] = i;
  t["-".charCodeAt(0)] = 62; t["_".charCodeAt(0)] = 63;
  return t;
})();

function base64Encode(bytes) {
  const parts = [];
  let chunk = [];
  const n = bytes.length;
  for (let i = 0; i < n; i += 3) {
    const a = bytes[i], b = i + 1 < n ? bytes[i + 1] : 0, c = i + 2 < n ? bytes[i + 2] : 0;
    const t = (a << 16) | (b << 8) | c;
    chunk.push(B64[(t >> 18) & 63], B64[(t >> 12) & 63], i + 1 < n ? B64[(t >> 6) & 63] : "=", i + 2 < n ? B64[t & 63] : "=");
    if (chunk.length >= 32768) { parts.push(chunk.join("")); chunk = []; }
  }
  parts.push(chunk.join(""));
  return parts.join("");
}

function base64Decode(str) {
  const clean = str.replace(/[^A-Za-z0-9+/\-_]/g, "");
  const len = Math.floor((clean.length * 3) / 4);
  const out = new Uint8Array(len);
  let o = 0, buf = 0, bits = 0;
  for (let i = 0; i < clean.length; i++) {
    const v = B64REV[clean.charCodeAt(i)];
    if (v < 0) continue;
    buf = (buf << 6) | v; bits += 6;
    if (bits >= 8) { bits -= 8; out[o++] = (buf >> bits) & 255; }
  }
  return o === len ? out : out.subarray(0, o);
}

/** "data:image/png;base64,...." → {mime, bytes} */
function parseDataUrl(url) {
  const m = /^data:([^;,]+)?(;base64)?,/.exec(url || "");
  if (!m) throw new Error("Geçersiz Data URL");
  return { mime: m[1] || "application/octet-stream", bytes: base64Decode(url.slice(m[0].length)) };
}

function concatBytes(list) {
  let total = 0;
  for (const a of list) total += a.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const a of list) { out.set(a, o); o += a.length; }
  return out;
}

module.exports = { utf8Encode, utf8Decode, base64Encode, base64Decode, parseDataUrl, concatBytes };
