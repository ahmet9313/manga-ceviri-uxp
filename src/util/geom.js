// Koordinat dönüşümleri ve maske geometrisi. TÜM koordinatlar belge pikselidir.
// Kırpma ofseti/ölçek, ekran↔belge (zoom, DPI, panel ölçüsü) dönüşümleri yalnızca burada yapılır.
"use strict";

/** Kırpılmış (ve ölçeklenmiş) görüntüdeki noktayı belge pikseline çevirir. crop = {left, top, scale} */
function cropToDoc(pt, crop) {
  const s = crop.scale || 1;
  return [crop.left + pt[0] / s, crop.top + pt[1] / s];
}

function polygonCropToDoc(poly, crop) { return poly.map((p) => cropToDoc(p, crop)); }

/** Torii v2/upload text[] öğesi: x,y = kutunun MERKEZİ. → belge koordinatında kutu. */
function toriiBoxToDoc(t, crop) {
  const s = (crop && crop.scale) || 1;
  const c = cropToDoc([t.x, t.y], crop || { left: 0, top: 0, scale: 1 });
  return { cx: c[0], cy: c[1], w: (t.width || 0) / s, h: (t.height || 0) / s, angle: Number(t.angle) || 0 };
}

function boxToPolygon(b) {
  const a = ((b.angle || 0) * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
  const hw = b.w / 2, hh = b.h / 2;
  return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([x, y]) => [b.cx + x * cos - y * sin, b.cy + x * sin + y * cos]);
}

/** Poligondan döndürülmüş kutu: kenar uzunlukları + açı (ilk kenarın yönü). */
function polygonToBox(poly) {
  if (!poly || poly.length < 3) return null;
  let cx = 0, cy = 0;
  for (const p of poly) { cx += p[0]; cy += p[1]; }
  cx /= poly.length; cy /= poly.length;
  if (poly.length === 4) {
    const dx = poly[1][0] - poly[0][0], dy = poly[1][1] - poly[0][1];
    const w = Math.hypot(dx, dy);
    const h = Math.hypot(poly[3][0] - poly[0][0], poly[3][1] - poly[0][1]);
    let angle = (Math.atan2(dy, dx) * 180) / Math.PI;
    if (Math.abs(angle) < 1.5) angle = 0;
    return { cx, cy, w, h, angle };
  }
  const r = polygonBounds(poly);
  return { cx: (r.left + r.right) / 2, cy: (r.top + r.bottom) / 2, w: r.right - r.left, h: r.bottom - r.top, angle: 0 };
}

function polygonBounds(poly) {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const [x, y] of poly) {
    if (x < left) left = x; if (x > right) right = x;
    if (y < top) top = y; if (y > bottom) bottom = y;
  }
  return { left, top, right, bottom };
}

function boxBounds(b) { return polygonBounds(boxToPolygon(b)); }

function rectUnion(a, b) {
  if (!a) return b; if (!b) return a;
  return { left: Math.min(a.left, b.left), top: Math.min(a.top, b.top), right: Math.max(a.right, b.right), bottom: Math.max(a.bottom, b.bottom) };
}

function rectIntersect(a, b) {
  const r = { left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) };
  return r.right > r.left && r.bottom > r.top ? r : null;
}

function rectArea(r) { return r ? Math.max(0, r.right - r.left) * Math.max(0, r.bottom - r.top) : 0; }

function iou(a, b) {
  const i = rectArea(rectIntersect(a, b));
  return i / (rectArea(a) + rectArea(b) - i || 1);
}

function rectInflate(r, d, limit) {
  const o = { left: Math.floor(r.left - d), top: Math.floor(r.top - d), right: Math.ceil(r.right + d), bottom: Math.ceil(r.bottom + d) };
  if (limit) {
    o.left = Math.max(limit.left, o.left); o.top = Math.max(limit.top, o.top);
    o.right = Math.min(limit.right, o.right); o.bottom = Math.min(limit.bottom, o.bottom);
  }
  return o;
}

function rectRound(r) { return { left: Math.floor(r.left), top: Math.floor(r.top), right: Math.ceil(r.right), bottom: Math.ceil(r.bottom) }; }

// ---------- Maske (tek kanallı Uint8Array) ----------
/** Poligonu maske tamponuna doldurur (çift-tek kuralı, tarama çizgisi). Maske, `area` sol-üstünden başlar. */
function fillPolygon(mask, w, h, poly, area, value) {
  const pts = poly.map(([x, y]) => [x - area.left, y - area.top]);
  let minY = Infinity, maxY = -Infinity;
  for (const p of pts) { minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); }
  const y0 = Math.max(0, Math.floor(minY)), y1 = Math.min(h - 1, Math.ceil(maxY));
  const v = value == null ? 255 : value;
  for (let y = y0; y <= y1; y++) {
    const sy = y + 0.5, xs = [];
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i], [xj, yj] = pts[j];
      if ((yi > sy) !== (yj > sy)) xs.push(xi + ((sy - yi) * (xj - xi)) / (yj - yi));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xa = Math.max(0, Math.round(xs[k])), xb = Math.min(w, Math.round(xs[k + 1]));
      for (let x = xa; x < xb; x++) mask[y * w + x] = v;
    }
  }
}

/** Kare yapı elemanı ile genişletme (ayrılabilir, O(n·r)). */
function dilate(mask, w, h, r) {
  r = Math.round(r);
  if (r <= 0) return mask;
  const tmp = new Uint8Array(mask.length), out = new Uint8Array(mask.length);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let last = -1e9;
    for (let x = 0; x < w; x++) { if (mask[row + x]) last = x; if (x - last <= r) tmp[row + x] = 255; }
    last = 1e9;
    for (let x = w - 1; x >= 0; x--) { if (mask[row + x]) last = x; if (last - x <= r) tmp[row + x] = 255; }
  }
  for (let x = 0; x < w; x++) {
    let last = -1e9;
    for (let y = 0; y < h; y++) { if (tmp[y * w + x]) last = y; if (y - last <= r) out[y * w + x] = 255; }
    last = 1e9;
    for (let y = h - 1; y >= 0; y--) { if (tmp[y * w + x]) last = y; if (last - y <= r) out[y * w + x] = 255; }
  }
  return out;
}

function maskBounds(mask, w, h) {
  let l = w, t = h, r = -1, b = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) {
    if (x < l) l = x; if (x > r) r = x; if (y < t) t = y; if (y > b) b = y;
  }
  return r < 0 ? null : { left: l, top: t, right: r + 1, bottom: b + 1 };
}

function maskCount(mask) { let n = 0; for (let i = 0; i < mask.length; i++) if (mask[i]) n++; return n; }

// ---------- Okuma sırası ----------
/** items: {bounds}. dir: 'rtl' (manga) | 'ltr' (webtoon/manhwa). Satırları dikey örtüşmeye göre gruplar. */
function readingOrder(items, dir) {
  const arr = items.slice().sort((a, b) => a.bounds.top - b.bounds.top);
  const rows = [];
  for (const it of arr) {
    const h = it.bounds.bottom - it.bounds.top;
    const row = rows.find((r) => {
      const ov = Math.min(r.bottom, it.bounds.bottom) - Math.max(r.top, it.bounds.top);
      return ov > 0.5 * Math.min(h, r.bottom - r.top);
    });
    if (row) { row.items.push(it); row.top = Math.min(row.top, it.bounds.top); row.bottom = Math.max(row.bottom, it.bounds.bottom); }
    else rows.push({ top: it.bounds.top, bottom: it.bounds.bottom, items: [it] });
  }
  rows.sort((a, b) => a.top - b.top);
  const out = [];
  for (const r of rows) {
    r.items.sort((a, b) => (dir === "rtl" ? b.bounds.right - a.bounds.right : a.bounds.left - b.bounds.left));
    out.push(...r.items);
  }
  return out;
}

// ---------- Ekran ↔ belge ----------
/**
 * Panel üzerindeki işaretçi hareketini (CSS pikseli) belge pikseline çevirir.
 * view = { zoom (1 = %100), devicePixelRatio, panelScale }
 * Photoshop ekranında 1 belge pikseli = zoom × ekran pikseli. CSS pikseli = devicePixelRatio ekran pikseli.
 */
function screenDeltaToDoc(dx, dy, view) {
  const zoom = view && view.zoom > 0 ? view.zoom : 1;
  const dpr = (view && view.devicePixelRatio) || 1;
  const ps = (view && view.panelScale) || 1;
  const k = (dpr * ps) / zoom;
  return [dx * k, dy * k];
}

module.exports = {
  cropToDoc, polygonCropToDoc, toriiBoxToDoc, boxToPolygon, polygonToBox, polygonBounds, boxBounds,
  rectUnion, rectIntersect, rectArea, iou, rectInflate, rectRound,
  fillPolygon, dilate, maskBounds, maskCount, readingOrder, screenDeltaToDoc,
};
