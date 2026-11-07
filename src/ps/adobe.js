// Adobe yerel AI araçları (Kaldır / Üretken Dolgu + model seçimi) — "öğret ve tekrarla" yaklaşımı.
// Bu komutların belgelenmiş UXP API'si yok. Kullanıcı aracı bir kez Photoshop'ta elle kullanır; Photoshop'un yayınladığı
// gerçek komut tanımlayıcısı (model kimliği dahil) kaydedilir ve sonra her öğe için kendi maskesiyle yeniden çalıştırılır.
"use strict";
const { action } = require("photoshop");
const { log, clone } = require("../util/common");

const ADOBE_MODELS = [
  { id: "firefly", label: "Adobe Firefly (Üretken dolgu)" },
  { id: "flux2pro", label: "FLUX.2 pro — hassas, gerçekçi" },
  { id: "fluxkontext", label: "FLUX Kontext pro — düzenleme, yüksek çözünürlük" },
  { id: "gemini31", label: "Gemini 3.1 (Nano Banana 2)" },
  { id: "gemini3pro", label: "Gemini 3 (Nano Banana Pro)" },
];

// Kayıt sırasında ilgilenmediğimiz sıradan olaylar
const NOISE = /^(select|set|get|hide|show|move|transform|historyStateChanged|layersFiltered|toolModalStateChanged|modalHTMLDialog|invokeCommand|newDocument|open|close|save|make|delete|duplicate|placeEvent|addTo|subtract|intersectWith|selectNoLayers|undoEvent|redoEvent)$/i;
const AI_HINT = /synth|generat|remove|inpaint|firefly|clio|gen[A-Z_]|contentAware|healing|spotHeal|fill/i;

let recorder = null;

/** Tüm Photoshop olaylarını dinlemeye başla; AI aracı olayı yakalanınca onCapture(event, descriptor) çağrılır. */
function startRecording(onCapture, onAnyEvent) {
  stopRecording();
  const seen = [];
  const fn = (event, desc) => {
    const name = String(event || (desc && desc._obj) || "");
    seen.push(name);
    try { if (onAnyEvent) onAnyEvent(name, desc); } catch (e) { /* yok say */ }
    if (!name) return;
    const json = JSON.stringify(desc || {}).slice(0, 6000);
    const strong = /synth|generat|firefly|clio|removeObj|remove\b|inpaint/i;
    if (NOISE.test(name) && !strong.test(json)) return; // sıradan olay (ör. "make" ama içinde üretken dolgu yoksa)
    if (AI_HINT.test(name) || strong.test(json)) {
      log("info", "Adobe komutu yakalandı: " + name, desc);
      onCapture(name, clone(desc));
    }
  };
  let mode = "all";
  try { action.addNotificationListener(["all"], fn); }
  catch (e) {
    mode = "list";
    action.addNotificationListener(["syntheticFill", "generativeFill", "syntheticGenerativeFill", "removeObject", "remove", "contentAwareFill", "fill", "spotHealingBrush", "inpaint"], fn);
  }
  recorder = { fn, mode, seen };
  log("info", "Adobe komut kaydı başladı (" + mode + ")");
  return recorder;
}

function stopRecording() {
  if (!recorder) return null;
  const r = recorder;
  try { action.removeNotificationListener(r.mode === "all" ? ["all"] : ["syntheticFill", "generativeFill", "syntheticGenerativeFill", "removeObject", "remove", "contentAwareFill", "fill", "spotHealingBrush", "inpaint"], r.fn); } catch (e) { /* yok say */ }
  recorder = null;
  log("info", "Adobe komut kaydı durdu; görülen olaylar: " + r.seen.slice(-30).join(", "));
  return r;
}

function isRecording() { return !!recorder; }

/** Kaydedilmiş tanımlayıcıyı mevcut belge/katman/istem için uyarlar. */
function adaptDescriptor(desc, ctx) {
  const d = clone(desc);
  delete d._isCommand;
  const walk = (o) => {
    if (!o || typeof o !== "object") return;
    if (Array.isArray(o)) { o.forEach(walk); return; }
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (k === "documentID" && typeof v === "number") o[k] = ctx.docId;
      else if (k === "layerID" && typeof v === "number" && ctx.layerId != null) o[k] = ctx.layerId;
      else if ((k === "prompt" || k === "gi_PROMPT") && typeof v === "string" && ctx.prompt != null) o[k] = ctx.prompt;
      else if (v && typeof v === "object") {
        if (v._ref === "document" && typeof v._id === "number") v._id = ctx.docId;
        if (v._ref === "layer" && typeof v._id === "number" && ctx.layerId != null) v._id = ctx.layerId;
        walk(v);
      }
    }
  };
  walk(d);
  if (!d._obj && ctx.event) d._obj = ctx.event;
  return d;
}

/** Tanımlayıcı içinden okunabilir model ipucu (ör. serviceID / model adı). */
function describeTemplate(desc) {
  const s = JSON.stringify(desc || {});
  const m = s.match(/"(serviceID|modelId|model|modelVersion|gi_MODEL|provider)"\s*:\s*"([^"]{1,60})"/i);
  return m ? `${m[1]}=${m[2]}` : "";
}

async function replay(template, ctx) {
  const d = adaptDescriptor(template.descriptor, Object.assign({ event: template.event }, ctx));
  const res = await action.batchPlay([d], { modalBehavior: "execute" });
  if (res[0] && res[0]._obj === "error") throw new Error(`Adobe komutu başarısız: ${res[0].message} (${res[0].result})`);
  return res;
}

/**
 * Photoshop Üretken Dolgu'nun dahili komutu (topluluk kayıtlarından; Firefly varsayılan modeli).
 * Belgelenmemiştir → kullanıcı panelden "doğrudan dene" ile bir kez doğrulamadan otomatik kullanılmaz.
 * Partner modelleri (FLUX, Gemini) için anahtarlar bilinmiyor; onlar Photoshop arayüzünden seçilir.
 */
function syntheticFillDescriptor(docId, layerId, prompt) {
  const clio = { _obj: "clio", dualCrop: true, gi_ADVANCED: '{"enable_mts":true}', gi_CONTENT_PRESERVE: 0, gi_CROP: false, gi_DILATE: false, gi_ENABLE_PROMPT_FILTER: true, gi_GUIDANCE: 6, gi_MODE: "ginp", gi_NUM_STEPS: -1, gi_PROMPT: prompt || "", gi_SEED: -1, gi_SIMILARITY: 0 };
  return { _obj: "syntheticFill", _target: [{ _ref: "document", _enum: "ordinal", _value: "targetEnum" }], documentID: docId, layerID: layerId, prompt: prompt || "", serviceID: "clio", serviceOptionsList: { clio }, workflow: "in_painting", workflowType: { _enum: "genWorkflow", _value: "in_painting" } };
}

/** Yerleşik "öğretilmiş" şablon: doğrudan çağrı doğrulandıysa kullanılır. */
function builtinGenerativeTemplate() {
  return { kind: "generative", model: "firefly", modelLabel: "Adobe Firefly (doğrudan)", event: "syntheticFill", descriptor: syntheticFillDescriptor(0, 0, ""), builtin: true };
}

module.exports = { syntheticFillDescriptor, builtinGenerativeTemplate, ADOBE_MODELS, startRecording, stopRecording, isRecording, adaptDescriptor, describeTemplate, replay };
