// Piksel okuma/yazma, seçim ve maske işlemleri (Imaging API — PS 27.11'de doğrulandı).
"use strict";
const { ps, bp, getDocProp, unitValue } = require("./api");
const { imaging } = ps;
const { convertChannels } = require("../util/png");

/** Belgenin (görünür) bileşiminden RGB piksel okur. → {data(RGB), width, height, bounds} */
async function readComposite(docId, bounds) {
  const r = await imaging.getPixels({ documentID: docId, sourceBounds: bounds, componentSize: 8, colorSpace: "RGB", applyAlpha: true });
  try {
    const raw = await r.imageData.getData({ chunky: true });
    const w = r.imageData.width, h = r.imageData.height, c = r.imageData.components;
    let data = raw;
    if (c === 4) {
      // Saydam alanları beyaza karıştır (manga sayfaları için güvenli varsayılan)
      data = new Uint8Array(w * h * 3);
      for (let i = 0, n = w * h; i < n; i++) {
        const a = raw[i * 4 + 3] / 255;
        data[i * 3] = Math.round(raw[i * 4] * a + 255 * (1 - a));
        data[i * 3 + 1] = Math.round(raw[i * 4 + 1] * a + 255 * (1 - a));
        data[i * 3 + 2] = Math.round(raw[i * 4 + 2] * a + 255 * (1 - a));
      }
    } else if (c !== 3) data = convertChannels(raw, w, h, c, 3);
    return { data, width: w, height: h, bounds: r.sourceBounds || bounds };
  } finally { r.imageData.dispose(); }
}

/**
 * Yalnızca "Orijinal" katmanların görüntüsünü okur: eklentinin Temizlik/Çeviri gruplarını geçici gizler.
 * Çağıran modal + suspendHistory içinde olmalı; görünürlük eski haline döner.
 */
async function readOriginal(docId, bounds, hideLayerIds) {
  const restore = [];
  for (const id of hideLayerIds || []) {
    try {
      const v = (await bp({ _obj: "get", _target: [{ _property: "visible" }, { _ref: "layer", _id: id }, { _ref: "document", _id: docId }] }))[0].visible;
      if (v) { await bp({ _obj: "hide", null: [{ _ref: "layer", _id: id }] }); restore.push(id); }
    } catch (e) { /* katman yoksa geç */ }
  }
  try { return await readComposite(docId, bounds); }
  finally {
    for (const id of restore) { try { await bp({ _obj: "show", null: [{ _ref: "layer", _id: id }] }); } catch (e) { /* yok say */ } }
  }
}

/** Belge renk modu "grayscaleMode" ise gri kanal yazmamız gerekir. */
async function docColorInfo(docId) {
  const mode = await getDocProp(docId, "mode");
  const m = mode && mode._value ? mode._value : String(mode);
  return { gray: /gray/i.test(m), mode: m };
}

/** Katmana piksel yazar. rgba: Uint8Array (4 kanal). left/top: belge pikseli. */
async function writeLayerPixels(docId, layerId, rgba, width, height, left, top) {
  const info = await docColorInfo(docId);
  let buf = rgba, comps = 4, space = "RGB";
  if (info.gray) {
    // Gri belgede: gri + alfa
    buf = new Uint8Array(width * height * 2);
    for (let i = 0, n = width * height; i < n; i++) {
      buf[i * 2] = Math.round(0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2]);
      buf[i * 2 + 1] = rgba[i * 4 + 3];
    }
    comps = 2; space = "Grayscale";
  }
  const im = await imaging.createImageDataFromBuffer(buf, { width, height, components: comps, colorSpace: space, chunky: true });
  try {
    await imaging.putPixels({ documentID: docId, layerID: layerId, imageData: im, targetBounds: { left, top }, replace: true });
  } finally { im.dispose(); }
}

/** Katman maskesi yazar (tek kanal). Maske yoksa oluşturulur. */
async function writeLayerMask(docId, layerId, mask, width, height, left, top) {
  const im = await imaging.createImageDataFromBuffer(mask, { width, height, components: 1, colorSpace: "Grayscale", chunky: true });
  try { await imaging.putLayerMask({ documentID: docId, layerID: layerId, imageData: im, targetBounds: { left, top } }); }
  finally { im.dispose(); }
}

async function readLayerMask(docId, layerId, bounds) {
  const r = await imaging.getLayerMask({ documentID: docId, layerID: layerId, sourceBounds: bounds });
  try {
    const d = await r.imageData.getData({ chunky: true });
    return { data: d, width: r.imageData.width, height: r.imageData.height, bounds: r.sourceBounds || bounds };
  } finally { r.imageData.dispose(); }
}

/** Tek kanallı maskeyi Photoshop seçimine aktarır. */
async function maskToSelection(docId, mask, width, height, left, top) {
  const im = await imaging.createImageDataFromBuffer(mask, { width, height, components: 1, colorSpace: "Grayscale", chunky: true });
  try { await imaging.putSelection({ documentID: docId, imageData: im, targetBounds: { left, top }, replace: true }); }
  finally { im.dispose(); }
}

/** Mevcut seçimin sınırları (yoksa null). */
async function selectionBounds(docId) {
  try {
    const r = (await bp({ _obj: "get", _target: [{ _property: "selection" }, { _ref: "document", _id: docId }] }))[0];
    const s = r && r.selection;
    if (!s || s.top === undefined) return null;
    const b = { left: unitValue(s.left), top: unitValue(s.top), right: unitValue(s.right), bottom: unitValue(s.bottom) };
    return b.right > b.left && b.bottom > b.top ? b : null;
  } catch (e) { return null; }
}

/** Seçimi tek kanallı maske olarak okur. */
async function selectionMask(docId, bounds) {
  const r = await imaging.getSelection({ documentID: docId, sourceBounds: bounds });
  try {
    const d = await r.imageData.getData({ chunky: true });
    return { data: d, width: r.imageData.width, height: r.imageData.height, bounds: r.sourceBounds || bounds };
  } finally { r.imageData.dispose(); }
}

async function deselect() {
  await bp({ _obj: "set", _target: [{ _ref: "channel", _property: "selection" }], to: { _enum: "ordinal", _value: "none" } });
}

/**
 * PNG dışı görselleri (ör. Firefly JPEG) çözmek için: geçici dosyaya yaz, geçici belge olarak aç, pikselleri oku, kapat.
 * Yalnızca kendi açtığımız geçici belge kapatılır. → {data(RGB), width, height, channels:3}
 */
async function decodeViaPhotoshop(bytes, ext) {
  const uxp = require("uxp");
  const { app } = ps;
  const tmp = await uxp.storage.localFileSystem.getTemporaryFolder();
  const name = "mcs_decode_" + Date.now() + "." + (ext || "jpg");
  const f = await tmp.createFile(name, { overwrite: true });
  await f.write(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), { format: uxp.storage.formats.binary });
  const before = app.activeDocument;
  await app.open(f);
  const d = app.activeDocument;
  if (!d || (before && d.id === before.id) || String(d.title).indexOf("mcs_decode_") !== 0) throw new Error("Geçici görsel açılamadı.");
  try {
    const r = await readComposite(d.id, { left: 0, top: 0, right: d.width, bottom: d.height });
    return { data: r.data, width: r.width, height: r.height, channels: 3 };
  } finally {
    await d.closeWithoutSaving();
    if (before) try { app.activeDocument = before; } catch (e) { /* yok */ }
    try { await f.delete(); } catch (e) { /* yok */ }
  }
}

module.exports = { decodeViaPhotoshop, readComposite, readOriginal, writeLayerPixels, writeLayerMask, readLayerMask, maskToSelection, selectionBounds, selectionMask, deselect, docColorInfo };
