// Photoshop erişim katmanı: executeAsModal + geçmiş (history) yönetimi + batchPlay yardımcıları.
"use strict";
const ps = require("photoshop");
const { app, core, action, constants } = ps;
const { log } = require("../util/common");

/** batchPlay: Photoshop hataları dizi içinde {_obj:"error"} olarak döner; bunları istisnaya çeviririz. */
async function bp(descs, opts) {
  const list = Array.isArray(descs) ? descs : [descs];
  const res = await action.batchPlay(list, Object.assign({ modalBehavior: "execute" }, opts || {}));
  for (let i = 0; i < res.length; i++) {
    if (res[i] && res[i]._obj === "error") {
      const e = new Error(`${list[i]._obj}: ${res[i].message} (${res[i].result})`);
      e.psCode = res[i].result;
      throw e;
    }
  }
  return res;
}

let modalDepth = 0;
let currentCtx = null;
let suspendedDocs = new Set();

/** Geçmiş askıya alma ile çalıştır (iç içe askıya almada dıştaki adım geçerli kalır). */
async function runInCtx(ctx, fn, opts) {
  let sid = null;
  if (ctx && opts.historyName && opts.documentID && !suspendedDocs.has(opts.documentID)) {
    try { sid = await ctx.hostControl.suspendHistory({ documentID: opts.documentID, name: opts.historyName }); suspendedDocs.add(opts.documentID); }
    catch (e) { sid = null; }
  }
  try {
    const r = await fn(ctx);
    if (sid != null) { suspendedDocs.delete(opts.documentID); await ctx.hostControl.resumeHistory(sid, !opts.discard); }
    sid = null;
    return r;
  } catch (e) {
    if (sid != null) { suspendedDocs.delete(opts.documentID); try { await ctx.hostControl.resumeHistory(sid, false); } catch (e2) { /* yok say */ } }
    throw e;
  }
}

/**
 * Photoshop belge değişikliklerini modal kapsamda çalıştırır.
 * historyName verilirse tüm değişiklikler TEK geçmiş adımı olur; hata olursa geri alınır.
 * Zaten modal içindeysek (iç içe çağrı) aynı bağlam kullanılır.
 * opts: { documentID, historyName, discard (true → değişiklikleri geçmişe yazmadan geri al) }
 */
async function modal(commandName, fn, opts) {
  opts = opts || {};
  if (modalDepth > 0) return runInCtx(currentCtx, fn, opts);
  return core.executeAsModal(async (ctx) => {
    modalDepth++;
    const prev = currentCtx;
    currentCtx = ctx;
    try { return await runInCtx(ctx, fn, opts); }
    finally { modalDepth--; currentCtx = prev; }
  }, { commandName: commandName || "Manga Çeviri" });
}

function isModalBusyError(e) { return e && /modal|busy|meşgul/i.test(String(e.message || e)); }

function getDoc(docId) { return app.documents.find((d) => d.id === docId) || null; }
function activeDoc() { try { return app.activeDocument || null; } catch (e) { return null; } }

function findLayer(doc, layerId) {
  if (!doc || layerId == null) return null;
  const stack = [...doc.layers];
  while (stack.length) {
    const l = stack.shift();
    if (l.id === layerId) return l;
    if (l.layers && l.layers.length) stack.unshift(...l.layers);
  }
  return null;
}

function allLayers(doc) {
  const out = [];
  const walk = (ls) => { for (const l of ls) { out.push(l); if (l.layers) walk(l.layers); } };
  walk(doc.layers);
  return out;
}

async function selectLayer(layerId, makeVisible) {
  await bp({ _obj: "select", _target: [{ _ref: "layer", _id: layerId }], makeVisible: !!makeVisible });
}

async function getLayerProps(docId, layerId, props) {
  const out = {};
  for (const p of props) {
    try {
      const r = await bp({ _obj: "get", _target: [{ _property: p }, { _ref: "layer", _id: layerId }, { _ref: "document", _id: docId }] });
      out[p] = r[0][p];
    } catch (e) { out[p] = undefined; }
  }
  return out;
}

async function getDocProp(docId, prop) {
  const r = await bp({ _obj: "get", _target: [{ _property: prop }, { _ref: "document", _id: docId }] });
  return r[0] ? r[0][prop] : undefined;
}

function rgbDesc(hex) {
  const n = parseInt(String(hex || "#000000").replace("#", ""), 16);
  return { _obj: "RGBColor", red: (n >> 16) & 255, grain: (n >> 8) & 255, blue: n & 255 };
}
function descToHex(c) {
  if (!c) return null;
  const r = Math.round(c.red || 0), g = Math.round(c.grain != null ? c.grain : c.green || 0), b = Math.round(c.blue || 0);
  return "#" + [r, g, b].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0")).join("");
}

function unitValue(v) { return v && typeof v === "object" && "_value" in v ? v._value : v; }

/** Photoshop araç seçimi (yerel araca geçiş). Başarısızsa false döner. */
async function selectTool(toolClass) {
  try { await modal("Araç seç", () => bp({ _obj: "select", _target: [{ _ref: toolClass }] })); return true; }
  catch (e) { log("warn", "Araç seçilemedi: " + toolClass, String(e.message)); return false; }
}

module.exports = { ps, app, core, action, constants, bp, modal, isModalBusyError, getDoc, activeDoc, findLayer, allLayers, selectLayer, getLayerProps, getDocProp, rgbDesc, descToHex, unitValue, selectTool };
