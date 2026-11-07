// Belge yapısı (Orijinal / Temizlik / Çeviri grupları) ve PSD içinde kalıcı durum (XMP).
"use strict";
const { bp, constants, findLayer, getDoc } = require("./api");
const { utf8Encode, utf8Decode, base64Encode, base64Decode } = require("../util/bytes");

const GROUP_NAMES = { original: "Orijinal", clean: "Temizlik", trans: "Çeviri", sfxSrc: "SFX Kaynak" };
const XMP_NS = "http://ns.mangaceviri.local/1.0/";

/** Yeni katman grubu oluşturur (DOM createLayerGroup PS 27.11'de null döndürdüğü için batchPlay). */
async function makeGroup(doc, name) {
  // Etkin katman bir grubun içindeyse yeni grup iç içe oluşur; önce üst düzey katmanı seç.
  if (doc.layers.length) await bp({ _obj: "select", _target: [{ _ref: "layer", _id: doc.layers[0].id }], makeVisible: false });
  await bp({ _obj: "make", _target: [{ _ref: "layerSection" }], using: { _obj: "layerSection", name } });
  return doc.activeLayers[0];
}

/**
 * Grupları bulur/oluşturur. İlk çalıştırmada eklentiye ait olmayan üst düzey katmanları "Orijinal" içine taşır.
 * known: önceki durumdaki grup kimlikleri. → {original, clean, trans}
 */
async function ensureStructure(docId, known) {
  const doc = getDoc(docId);
  if (!doc) throw new Error("Belge bulunamadı");
  known = known || {};
  const byIdOrName = (id, name) => (id != null && findLayer(doc, id)) || doc.layers.find((l) => l.name === name && String(l.kind) === "group") || null;
  let gOrig = byIdOrName(known.original, GROUP_NAMES.original);
  let gClean = byIdOrName(known.clean, GROUP_NAMES.clean);
  let gTrans = byIdOrName(known.trans, GROUP_NAMES.trans);

  if (!gOrig) {
    // Arka planı normal katmana çevir (gruba taşınabilmesi için)
    const bg = doc.layers.find((l) => l.isBackgroundLayer);
    if (bg) {
      await bp({ _obj: "set", _target: [{ _ref: "layer", _property: "background" }], to: { _obj: "layer", opacity: { _unit: "percentUnit", _value: 100 }, mode: { _enum: "blendMode", _value: "normal" } } });
    }
    const toMove = doc.layers.filter((l) => l !== gClean && l !== gTrans);
    gOrig = await makeGroup(doc, GROUP_NAMES.original);
    // Sıralamayı korumak için en alttan başlayarak içeri taşı
    for (let i = toMove.length - 1; i >= 0; i--) {
      try { toMove[i].move(gOrig, constants.ElementPlacement.PLACEINSIDE); } catch (e) { /* kilitli katman */ }
    }
  }
  if (!gClean) {
    gClean = await makeGroup(doc, GROUP_NAMES.clean);
  }
  if (!gTrans) {
    gTrans = await makeGroup(doc, GROUP_NAMES.trans);
  }
  // Sıra: Çeviri (üst) > Temizlik > Orijinal (alt)
  const P = constants.ElementPlacement;
  try { if (doc.layers[0].id !== gTrans.id) gTrans.move(doc.layers[0], P.PLACEBEFORE); } catch (e) { /* yok say */ }
  try { gClean.move(gTrans, P.PLACEAFTER); } catch (e) { /* yok say */ }
  try { gOrig.move(gClean, P.PLACEAFTER); } catch (e) { /* yok say */ }
  return { original: gOrig.id, clean: gClean.id, trans: gTrans.id };
}

/** Belirli grubun içinde (en üstte) boş piksel katmanı oluşturur. */
async function makePixelLayerIn(docId, groupId, name) {
  const doc = getDoc(docId);
  await bp({ _obj: "select", _target: [{ _ref: "layer", _id: groupId }], makeVisible: false });
  await bp({ _obj: "make", _target: [{ _ref: "layer" }], using: { _obj: "layer", name } });
  const l = doc.activeLayers[0];
  const g = findLayer(doc, groupId);
  if (g && (!l.parent || l.parent.id !== groupId)) l.move(g, constants.ElementPlacement.PLACEINSIDE);
  return l.id;
}

async function deleteLayer(docId, layerId) {
  try { await bp({ _obj: "delete", _target: [{ _ref: "layer", _id: layerId }] }); return true; } catch (e) { return false; }
}

async function renameLayer(docId, layerId, name) {
  await bp({ _obj: "set", _target: [{ _ref: "layer", _id: layerId }], to: { _obj: "layer", name } });
}

// ---------------- XMP kalıcılığı ----------------
async function readXmp(docId) {
  const r = await bp({ _obj: "get", _target: [{ _property: "XMPMetadataAsUTF8" }, { _ref: "document", _id: docId }] });
  return (r[0] && r[0].XMPMetadataAsUTF8) || "";
}

const STATE_RE = /<rdf:Description[^>]*xmlns:mct="http:\/\/ns\.mangaceviri\.local\/1\.0\/"[^>]*>[\s\S]*?<\/rdf:Description>\s*/g;

/** PSD içine eklenti durumunu yazar (base64 JSON). Doğrulama için geri okur. */
async function writeState(docId, state) {
  const json = JSON.stringify(state);
  const b64 = base64Encode(utf8Encode(json));
  let xmp = await readXmp(docId);
  const block = `<rdf:Description rdf:about="" xmlns:mct="${XMP_NS}"><mct:state>${b64}</mct:state></rdf:Description>`;
  if (!xmp) {
    xmp = `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">${block}</rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
  } else {
    xmp = xmp.replace(STATE_RE, "");
    xmp = xmp.replace("</rdf:RDF>", block + "</rdf:RDF>");
  }
  await bp({ _obj: "set", _target: [{ _ref: "property", _property: "XMPMetadataAsUTF8" }, { _ref: "document", _id: docId }], to: { _obj: "document", XMPMetadataAsUTF8: xmp } });
  return b64.length;
}

async function readState(docId) {
  const xmp = await readXmp(docId);
  const m = /<mct:state>([A-Za-z0-9+/=\s]+)<\/mct:state>/.exec(xmp);
  if (!m) return null;
  try { return JSON.parse(utf8Decode(base64Decode(m[1]))); } catch (e) { return null; }
}

module.exports = { GROUP_NAMES, ensureStructure, makeGroup, makePixelLayerIn, deleteLayer, renameLayer, readState, writeState, readXmp };
