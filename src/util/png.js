// Minimal PNG kodlayıcı/çözücü (pako ile). Gri (1), RGB (3), RGBA (4) kanal.
"use strict";
const pako = require("../lib/pako.min.js");
const { concatBytes } = require("./bytes");

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes, start, end) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function u32(n) { return new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]); }

function chunk(type, data) {
  const t = new Uint8Array([type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3)]);
  const body = concatBytes([t, data]);
  return concatBytes([u32(data.length), body, u32(crc32(body, 0, body.length))]);
}

/** pixels: Uint8Array (chunky), channels: 1|3|4 */
function encodePng(pixels, width, height, channels, level) {
  const colorType = channels === 1 ? 0 : channels === 3 ? 2 : channels === 4 ? 6 : -1;
  if (colorType < 0) throw new Error("PNG: desteklenmeyen kanal sayısı " + channels);
  const stride = width * channels;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const ro = y * (stride + 1);
    const so = y * stride;
    // Filtre: "Up" (2) – maskelerde ve düz alanlarda iyi sıkışır.
    raw[ro] = y === 0 ? 0 : 2;
    if (y === 0) raw.set(pixels.subarray(so, so + stride), ro + 1);
    else {
      for (let x = 0; x < stride; x++) raw[ro + 1 + x] = (pixels[so + x] - pixels[so - stride + x]) & 255;
    }
  }
  const ihdr = new Uint8Array(13);
  ihdr.set(u32(width), 0); ihdr.set(u32(height), 4);
  ihdr[8] = 8; ihdr[9] = colorType; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const idat = pako.deflate(raw, { level: level == null ? 6 : level });
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  return concatBytes([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))]);
}

function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** → {width, height, channels, data: Uint8Array} (8 bit, paletli/gri-alfa dönüştürülür) */
function decodePng(bytes) {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) if (bytes[i] !== sig[i]) throw new Error("PNG imzası geçersiz");
  let off = 8, width = 0, height = 0, depth = 0, colorType = 0, interlace = 0;
  let palette = null, trns = null;
  const idats = [];
  while (off < bytes.length) {
    const len = ((bytes[off] << 24) | (bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3]) >>> 0;
    const type = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7]);
    const data = bytes.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      width = ((data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3]) >>> 0;
      height = ((data[4] << 24) | (data[5] << 16) | (data[6] << 8) | data[7]) >>> 0;
      depth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === "PLTE") palette = data;
    else if (type === "tRNS") trns = data;
    else if (type === "IDAT") idats.push(data);
    else if (type === "IEND") break;
    off += 12 + len;
  }
  if (interlace) throw new Error("Interlaced PNG desteklenmiyor");
  if (depth !== 8) throw new Error("Yalnızca 8 bit PNG destekleniyor (gelen: " + depth + ")");
  const spp = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  const raw = pako.inflate(concatBytes(idats));
  const stride = width * spp;
  const px = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const ri = y * (stride + 1) + 1, oi = y * stride, pi = oi - stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[ri + x];
      const a = x >= spp ? px[oi + x - spp] : 0;
      const b = y > 0 ? px[pi + x] : 0;
      const c = x >= spp && y > 0 ? px[pi + x - spp] : 0;
      let r;
      switch (f) {
        case 0: r = v; break;
        case 1: r = v + a; break;
        case 2: r = v + b; break;
        case 3: r = v + ((a + b) >> 1); break;
        case 4: r = v + paeth(a, b, c); break;
        default: throw new Error("PNG filtre türü bilinmiyor: " + f);
      }
      px[oi + x] = r & 255;
    }
  }
  if (colorType === 0 || colorType === 2 || colorType === 6) return { width, height, channels: spp, data: px };
  // Paletli veya gri+alfa → RGBA
  const out = new Uint8Array(width * height * 4);
  for (let i = 0, n = width * height; i < n; i++) {
    if (colorType === 3) {
      const idx = px[i];
      out[i * 4] = palette[idx * 3]; out[i * 4 + 1] = palette[idx * 3 + 1]; out[i * 4 + 2] = palette[idx * 3 + 2];
      out[i * 4 + 3] = trns && idx < trns.length ? trns[idx] : 255;
    } else {
      out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = px[i * 2];
      out[i * 4 + 3] = px[i * 2 + 1];
    }
  }
  return { width, height, channels: 4, data: out };
}

/** Kanal sayısını dönüştürür (1/3/4 arası). */
function convertChannels(data, width, height, from, to) {
  if (from === to) return data;
  const n = width * height;
  const out = new Uint8Array(n * to);
  for (let i = 0; i < n; i++) {
    let r, g, b, a = 255;
    if (from === 1) { r = g = b = data[i]; }
    else { r = data[i * from]; g = data[i * from + 1]; b = data[i * from + 2]; if (from === 4) a = data[i * from + 3]; }
    if (to === 1) out[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    else {
      out[i * to] = r; out[i * to + 1] = g; out[i * to + 2] = b;
      if (to === 4) out[i * to + 3] = a;
    }
  }
  return out;
}

module.exports = { encodePng, decodePng, convertChannels, crc32 };
