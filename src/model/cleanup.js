// Temizlik: maske üretimi, bölge analizi (Otomatik yöntem seçimi), yerel düz dolgu ve kalite ölçütleri.
// Maskenin DIŞINDAKİ pikseller hiçbir yöntemde değişmez: sonuç ayrı katmana, yalnızca maske içine yazılır.
"use strict";
const geom = require("../util/geom");

const METHODS = {
  auto: { label: "Otomatik", kind: "auto" },
  torii: { label: "Torii Inpaint (varsayılan)", kind: "api", provider: "torii", cost: 0.02 },
  flat: { label: "Yerel düz dolgu (kredisiz)", kind: "local", provider: "local", cost: 0 },
  contentAware: { label: "Adobe İçerik Duyarlı Dolgu (yerel)", kind: "local", provider: "adobe-local", cost: 0 },
  adobeGenerative: { label: "Adobe Üretken Dolgu (Firefly)", kind: "adobe", provider: "adobe", cost: null },
  firefly: { label: "Firefly Services (sunucu)", kind: "server", provider: "adobe", cost: null },
};

/** Öğenin yazı maskesi (satır poligonları + genişletme). area: belge dikdörtgeni. */
function itemMask(item, area, dilatePx) {
  const w = area.right - area.left, h = area.bottom - area.top;
  const m = new Uint8Array(w * h);
  const fs = (item.ocr && item.ocr.fontsize) || 20;
  let polys = item.maskPolygons && item.maskPolygons.length ? item.maskPolygons : item.lines && item.lines.length ? item.lines : [item.polygon];
  if (!(item.maskPolygons && item.maskPolygons.length) && item.ocr && item.ocr.toriiFont && item.box) {
    // Görsel çeviriden gelen öğe: kutu ÇEVİRİNİN kutusu, orijinal yazı taşabilir → kutuyu yazı boyuna göre büyüt
    polys = [geom.boxToPolygon(Object.assign({}, item.box, { w: item.box.w + fs * 1.6, h: item.box.h + fs * 1.6 }))];
  }
  for (const p of polys) if (p && p.length >= 3) geom.fillPolygon(m, w, h, p, area, 255);
  const r = Math.max(dilatePx == null ? 4 : dilatePx, Math.round(fs * 0.12));
  return { mask: geom.dilate(m, w, h, r), width: w, height: h, area, radius: r };
}

/** Elle seçilmiş maske (Photoshop seçimi) varsa onu kullanır. */
function itemArea(item, docRect, margin) {
  const b = item.bounds || geom.polygonBounds(item.polygon);
  const fs = (item.ocr && item.ocr.fontsize) || 20;
  return geom.rectInflate(b, Math.max(margin || 24, fs * 1.5), docRect);
}

/** Maske çevresindeki halkada zemin istatistikleri. rgb: area boyutunda RGB. */
function analyzeRegion(rgb, w, h, mask, radius) {
  const outer = geom.dilate(mask, w, h, Math.max(4, Math.round(radius * 0.8)));
  const vals = [];
  let edges = 0, flips = 0, n = 0;
  const lum = (i) => 0.299 * rgb[i * 3] + 0.587 * rgb[i * 3 + 1] + 0.114 * rgb[i * 3 + 2];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (!outer[i] || mask[i]) continue;
      n++;
      vals.push(i);
      const gx = lum(i + 1) - lum(i - 1), gy = lum(i + w) - lum(i - w);
      if (Math.hypot(gx, gy) > 60) edges++;
      // Tram (screentone): komşu piksellerde ardışık işaret değişimi
      const a = lum(i - 1) - lum(i), b = lum(i) - lum(i + 1);
      if (Math.abs(a) > 18 && Math.abs(b) > 18 && Math.sign(a) !== Math.sign(b)) flips++;
    }
  }
  if (!n) return { kind: "unknown", n: 0 };
  const chan = [0, 1, 2].map((c) => vals.map((i) => rgb[i * 3 + c]).sort((p, q) => p - q));
  const med = chan.map((a) => a[Math.floor(a.length / 2)]);
  let near = 0, sq = 0;
  for (const i of vals) {
    const d = Math.hypot(rgb[i * 3] - med[0], rgb[i * 3 + 1] - med[1], rgb[i * 3 + 2] - med[2]);
    if (d < 22) near++;
    sq += d * d;
  }
  const stats = {
    n, median: med, std: Math.sqrt(sq / n), nearRatio: near / n, edgeRatio: edges / n, flipRatio: flips / n,
    medianHex: "#" + med.map((v) => v.toString(16).padStart(2, "0")).join(""),
  };
  stats.periodicity = periodicity(rgb, w, h, outer);
  if (stats.nearRatio > 0.94 && stats.edgeRatio < 0.04) stats.kind = "flat";
  else if (stats.periodicity.score > 0.35) stats.kind = "screentone";
  else stats.kind = "art";
  return stats;
}

/**
 * Tram (screentone) tespiti: maske dışındaki yatay satır parçalarında parlaklık otokorelasyonu.
 * Düzenli nokta deseninde r(lag) önce negatife iner, sonra periyotta tekrar yükselir; düz çizim/gradyanda tekdüze azalır.
 * → {score (0-1), period}
 */
function periodicity(rgb, w, h, excl) {
  const MAXL = 16, num = new Float64Array(MAXL + 1);
  let den = 0;
  const lum = (i) => 0.299 * rgb[i * 3] + 0.587 * rgb[i * 3 + 1] + 0.114 * rgb[i * 3 + 2];
  for (let y = 0; y < h; y += 2) {
    let x = 0;
    while (x < w) {
      while (x < w && excl[y * w + x]) x++;
      const s = x;
      while (x < w && !excl[y * w + x]) x++;
      const len = x - s;
      if (len < 40) continue;
      let mean = 0;
      for (let k = s; k < x; k++) mean += lum(y * w + k);
      mean /= len;
      const v = new Float64Array(len);
      for (let k = 0; k < len; k++) v[k] = lum(y * w + s + k) - mean;
      for (let k = 0; k < len; k++) den += v[k] * v[k];
      for (let l = 1; l <= MAXL; l++) for (let k = 0; k + l < len; k++) num[l] += v[k] * v[k + l];
    }
  }
  if (den <= 0) return { score: 0, period: 0 };
  const r = Array.from(num, (v) => v / den);
  let best = 0, period = 0;
  for (let L = 3; L <= MAXL; L++) {
    let dip = 1;
    for (let l = 1; l < L; l++) dip = Math.min(dip, r[l]);
    // tepe: komşularından büyük, öncesinde belirgin çukur
    if (r[L] > r[L - 1] && (L === MAXL || r[L] >= r[L + 1]) && dip < -0.05) {
      const sc = r[L] - dip;
      if (sc > best) { best = sc; period = L; }
    }
  }
  return { score: Math.min(1, best / 1.2), period };
}

/**
 * Otomatik yöntem seçimi. Ölçütler: çizgi bütünlüğü riski, yazı izi riski, süre, maliyet.
 * Adobe'ye geçiş HİÇBİR ZAMAN sessiz yapılmaz: öneri olarak döner, kullanıcı onayı gerekir.
 */
function chooseMethod(stats, item, available) {
  const av = available || {};
  if (stats.kind === "flat") {
    return { method: "flat", reason: `Düz zemin (%${Math.round(stats.nearRatio * 100)} tek renk, kenar %${Math.round(stats.edgeRatio * 100)}): yerel dolgu anında, kredisiz ve çizgiye dokunmaz.`, alt: "torii" };
  }
  if (stats.kind === "screentone") {
    return { method: "torii", reason: `Tramlı zemin (periyot ${stats.periodicity.period} px, düzenlilik %${Math.round(stats.periodicity.score * 100)}): desen sürekliliği için Torii Inpaint (0,02 kredi).`, alt: av.contentAware ? "contentAware" : null };
  }
  if (stats.kind === "art") {
    const sfx = item && item.type === "sfx";
    return {
      method: "torii",
      reason: `Çizim üstü ${sfx ? "SFX" : "yazı"} (kenar yoğunluğu %${Math.round(stats.edgeRatio * 100)}): Torii Inpaint seçildi. Sonuç zayıfsa Adobe Üretken Dolgu önerilir (onayınızla).`,
      alt: "adobeGenerative", suggestAdobe: sfx,
    };
  }
  return { method: "torii", reason: "Zemin analiz edilemedi; varsayılan Torii Inpaint.", alt: null };
}

/** Düz renk dolgu yaması (RGBA). Maske dışı alfa=0. */
function flatFillPatch(w, h, mask, hex) {
  const n = parseInt(hex.slice(1), 16), r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const out = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    if (!mask[i]) continue;
    out[i * 4] = r; out[i * 4 + 1] = g; out[i * 4 + 2] = b; out[i * 4 + 3] = 255;
  }
  return out;
}

/** RGB sonucu maskeyle RGBA yamaya çevirir (maske dışı alfa=0). */
function patchFromResult(resultRgb, channels, w, h, mask) {
  const out = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    if (!mask[i]) continue;
    out[i * 4] = resultRgb[i * channels]; out[i * 4 + 1] = resultRgb[i * channels + 1]; out[i * 4 + 2] = resultRgb[i * channels + 2];
    out[i * 4 + 3] = 255;
  }
  return out;
}

/** Görsel çeviri "inpainted" çıktısı ile orijinal arasındaki farkı, yalnız izin verilen bölgede maskeler. */
function diffMask(orig, origCh, inp, inpCh, w, h, allowMask, thr) {
  const m = new Uint8Array(w * h);
  const t = thr == null ? 24 : thr;
  for (let i = 0; i < w * h; i++) {
    if (!allowMask[i]) continue;
    const d = Math.abs(orig[i * origCh] - inp[i * inpCh]) + Math.abs(orig[i * origCh + 1] - inp[i * inpCh + 1]) + Math.abs(orig[i * origCh + 2] - inp[i * inpCh + 2]);
    if (d > t) m[i] = 255;
  }
  const d = geom.dilate(m, w, h, 2);
  for (let i = 0; i < w * h; i++) if (!allowMask[i]) d[i] = 0;
  return d;
}

/**
 * Kalite ölçütleri (karşılaştırma için):
 *  residual: maske içinde, sonucun halka-zemin medyanından sapması (düşük = az yazı izi)
 *  lineBreak: maske kenar bandında orijinal ile sonuç arasındaki gradyan farkı (düşük = çizgi bütünlüğü korunmuş)
 *  outsideChanged: maske dışında değişen piksel sayısı (HER ZAMAN 0 olmalı)
 */
function qualityMetrics(origRgb, resultRgba, w, h, mask, stats) {
  const med = (stats && stats.median) || [255, 255, 255];
  let res = 0, rn = 0, lb = 0, ln = 0;
  const lum = (a, i, c) => 0.299 * a[i * c] + 0.587 * a[i * c + 1] + 0.114 * a[i * c + 2];
  const inner = new Uint8Array(w * h);
  // kenar bandı: maske içi, maske dışına 3 px yakın
  const outsideD = geom.dilate(mask.map((v) => (v ? 0 : 255)), w, h, 3);
  for (let i = 0; i < w * h; i++) {
    if (!mask[i]) continue;
    if (resultRgba[i * 4 + 3]) {
      res += Math.hypot(resultRgba[i * 4] - med[0], resultRgba[i * 4 + 1] - med[1], resultRgba[i * 4 + 2] - med[2]); rn++;
    }
    if (outsideD[i]) inner[i] = 1;
  }
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    if (!inner[i]) continue;
    const go = Math.abs(lum(origRgb, i + 1, 3) - lum(origRgb, i - 1, 3)) + Math.abs(lum(origRgb, i + w, 3) - lum(origRgb, i - w, 3));
    const comp = (j) => (resultRgba[j * 4 + 3] ? 0.299 * resultRgba[j * 4] + 0.587 * resultRgba[j * 4 + 1] + 0.114 * resultRgba[j * 4 + 2] : lum(origRgb, j, 3));
    const gr = Math.abs(comp(i + 1) - comp(i - 1)) + Math.abs(comp(i + w) - comp(i - w));
    lb += Math.abs(go - gr); ln++;
  }
  let outside = 0;
  for (let i = 0; i < w * h; i++) if (!mask[i] && resultRgba[i * 4 + 3]) outside++;
  return { residual: rn ? Math.round((res / rn) * 10) / 10 : 0, lineBreak: ln ? Math.round((lb / ln) * 10) / 10 : 0, outsideChanged: outside };
}

/**
 * Renge dayalı yazı maskesi (Torii yazıyı silmediğinde yedek yol).
 * rgb: alan görüntüsü; core: alan içi çekirdek dikdörtgen (yerel koordinat); textHex: yazı rengi (yoksa tahmin edilir).
 * Yazı rengine yakın pikseller → çekirdeğe bağlı olanlar (harfler arası boşluk için genişletme ile) → kontur payı.
 */
function colorTextMask(rgb, w, h, core, textHex, opts) {
  opts = opts || {};
  const px = (i) => [rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]];
  let tc = null;
  if (textHex && /^#?[0-9a-f]{6}$/i.test(textHex)) { const n = parseInt(textHex.replace("#", ""), 16); tc = [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  // Tahmin/doğrulama: çekirdekteki piksellerden, çekirdek medyanından en uzak %15'in ortalaması
  const coreIdx = [];
  for (let y = core.top; y < core.bottom; y++) for (let x = core.left; x < core.right; x++) coreIdx.push(y * w + x);
  if (!coreIdx.length) return new Uint8Array(w * h);
  const med = [0, 1, 2].map((c) => coreIdx.map((i) => rgb[i * 3 + c]).sort((a, b) => a - b)[coreIdx.length >> 1]);
  const dist = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
  if (!tc || dist(tc, med) < 60) {
    const far = coreIdx.map((i) => [dist(px(i), med), i]).sort((a, b) => b[0] - a[0]).slice(0, Math.max(10, Math.round(coreIdx.length * 0.15)));
    tc = [0, 1, 2].map((c) => Math.round(far.reduce((s, f) => s + rgb[f[1] * 3 + c], 0) / far.length));
  }
  const tol = opts.tolerance || 60;
  let m = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) if (dist(px(i), tc) < tol) m[i] = 255;
  // Morfolojik açma: aynı renkteki İNCE çizgileri (çizim konturları) at, KALIN harfleri tut
  if (opts.openR > 0) {
    const inv = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) inv[i] = m[i] ? 0 : 255;
    const eroded = geom.dilate(inv, w, h, opts.openR); // tersin genişlemesi = aşınma
    for (let i = 0; i < w * h; i++) eroded[i] = eroded[i] ? 0 : 255;
    const opened = geom.dilate(eroded, w, h, opts.openR);
    for (let i = 0; i < w * h; i++) m[i] = m[i] && opened[i] ? 255 : 0;
  }
  // çekirdeğe bağlı parçalar
  const joined = geom.dilate(m, w, h, opts.joinR || 6);
  const seen = new Uint8Array(w * h), q = new Int32Array(w * h);
  let qh = 0, qt = 0;
  for (const i of coreIdx) if (joined[i] && !seen[i]) { seen[i] = 1; q[qt++] = i; }
  while (qh < qt) {
    const i = q[qh++], x = i % w, y = (i / w) | 0;
    if (x > 0 && joined[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; q[qt++] = i - 1; }
    if (x < w - 1 && joined[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; q[qt++] = i + 1; }
    if (y > 0 && joined[i - w] && !seen[i - w]) { seen[i - w] = 1; q[qt++] = i - w; }
    if (y < h - 1 && joined[i + w] && !seen[i + w]) { seen[i + w] = 1; q[qt++] = i + w; }
  }
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) if (m[i] && seen[i]) out[i] = 255;
  return geom.dilate(out, w, h, opts.strokeR || 4);
}


/**
 * Balon içindeki TÜM yazı parçaları (kopuk nokta, taşan satır, ünlem) — OCR poligonunun dışında kalsalar bile.
 * Balon içi = zemin rengine benzeyen bölge (R). Balon çerçevesinin dışına bağlı olmayan, R olmayan pikseller = mürekkep.
 * Kontura değen harf mürekkep sayılmaz (kontur korunur); onu OCR maskesi zaten kapsar.
 * rgb: area görüntüsü; bubble.rect/bg belge koordinatı; box: yazı kutusu (tohum). → Uint8Array(w*h) 255 = mürekkep
 */
function bubbleInkMask(rgb, w, h, area, bubble, box) {
  const out = new Uint8Array(w * h);
  if (!bubble || !bubble.rect || !bubble.bg) return out;
  const n = parseInt(bubble.bg.slice(1), 16), bg = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const L = Math.max(0, Math.floor(bubble.rect.left - area.left) - 2), T = Math.max(0, Math.floor(bubble.rect.top - area.top) - 2);
  const Rr = Math.min(w, Math.ceil(bubble.rect.right - area.left) + 2), B = Math.min(h, Math.ceil(bubble.rect.bottom - area.top) + 2);
  if (Rr - L < 4 || B - T < 4) return out;
  const near = (i) => Math.abs(rgb[i * 3] - bg[0]) + Math.abs(rgb[i * 3 + 1] - bg[1]) + Math.abs(rgb[i * 3 + 2] - bg[2]) < 48;
  const reg = new Uint8Array(w * h), q = new Int32Array((Rr - L) * (B - T) + 4);
  let qh = 0, qt = 0;
  // R: yazı kutusundaki zemin renkli piksellerden taşma (balon konturu durdurur; kutu köşesi balon dışındaysa bile mürekkep sonucu değişmez)
  const cx0 = Math.max(L, Math.round(box.cx - box.w * 0.5 - area.left)), cx1 = Math.min(Rr, Math.round(box.cx + box.w * 0.5 - area.left));
  const cy0 = Math.max(T, Math.round(box.cy - box.h * 0.5 - area.top)), cy1 = Math.min(B, Math.round(box.cy + box.h * 0.5 - area.top));
  for (let y = cy0; y < Math.max(cy1, cy0 + 1); y++) for (let x = cx0; x < Math.max(cx1, cx0 + 1); x++) { const i = y * w + x; if (y < B && x < Rr && !reg[i] && near(i)) { reg[i] = 1; q[qt++] = i; } }
  while (qh < qt) {
    const i = q[qh++], x = i % w, y = (i / w) | 0;
    if (x > L && !reg[i - 1] && near(i - 1)) { reg[i - 1] = 1; q[qt++] = i - 1; }
    if (x < Rr - 1 && !reg[i + 1] && near(i + 1)) { reg[i + 1] = 1; q[qt++] = i + 1; }
    if (y > T && !reg[i - w] && near(i - w)) { reg[i - w] = 1; q[qt++] = i - w; }
    if (y < B - 1 && !reg[i + w] && near(i + w)) { reg[i + w] = 1; q[qt++] = i + w; }
  }
  // O: çerçeve kenarından R olmayan piksellerle taşma (balon dışı + kontur + kontura bağlı çizimler)
  const outside = new Uint8Array(w * h);
  qh = 0; qt = 0;
  const seed = (x, y) => { const i = y * w + x; if (!reg[i] && !outside[i]) { outside[i] = 1; q[qt++] = i; } };
  for (let x = L; x < Rr; x++) { seed(x, T); seed(x, B - 1); }
  for (let y = T; y < B; y++) { seed(L, y); seed(Rr - 1, y); }
  while (qh < qt) {
    const i = q[qh++], x = i % w, y = (i / w) | 0;
    if (x > L && !reg[i - 1] && !outside[i - 1]) { outside[i - 1] = 1; q[qt++] = i - 1; }
    if (x < Rr - 1 && !reg[i + 1] && !outside[i + 1]) { outside[i + 1] = 1; q[qt++] = i + 1; }
    if (y > T && !reg[i - w] && !outside[i - w]) { outside[i - w] = 1; q[qt++] = i - w; }
    if (y < B - 1 && !reg[i + w] && !outside[i + w]) { outside[i + w] = 1; q[qt++] = i + w; }
  }
  let cnt = 0, s1 = 0, s2 = 0;
  for (let y = T; y < B; y++) for (let x = L; x < Rr; x++) {
    const i = y * w + x;
    if (!reg[i] && !outside[i]) out[i] = 255;
    else if (reg[i]) { const v = 0.299 * rgb[i * 3] + 0.587 * rgb[i * 3 + 1] + 0.114 * rgb[i * 3 + 2]; cnt++; s1 += v; s2 += v * v; }
  }
  // Balon zemininin düzlüğü (parlaklık std): düşükse yerel düz dolgu yeterli
  out.bgStd = cnt ? Math.sqrt(Math.max(0, s2 / cnt - (s1 / cnt) * (s1 / cnt))) : 99;
  out.regionPx = cnt;
  return out;
}
module.exports = { bubbleInkMask, colorTextMask, METHODS, itemMask, itemArea, analyzeRegion, chooseMethod, flatFillPatch, patchFromResult, diffMask, qualityMetrics };
