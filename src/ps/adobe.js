// Photoshop Üretken Dolgu (Firefly) — panelden doğrudan çağrı.
// Adobe bu komut için belgelenmiş bir UXP API'si sunmuyor; "syntheticFill" Photoshop'un dahili komutudur.
// Çağrı başarısız olursa çağıran taraf otomatik olarak İçerik Duyarlı Dolgu'ya geçer (bkz. pipeline.adobeReplayClean).
// Partner modelleri (FLUX, Gemini) için komut anahtarları bilinmediğinden ve doğrulanamadığından desteklenmez.
"use strict";
const { action } = require("photoshop");

/** Üretken Dolgu (Firefly, in-painting) tanımlayıcısı. Etkin belgede, mevcut seçim üzerinde çalışır. */
function syntheticFillDescriptor(docId, layerId, prompt) {
  const clio = {
    _obj: "clio", dualCrop: true, gi_ADVANCED: '{"enable_mts":true}', gi_CONTENT_PRESERVE: 0, gi_CROP: false, gi_DILATE: false,
    gi_ENABLE_PROMPT_FILTER: true, gi_GUIDANCE: 6, gi_MODE: "ginp", gi_NUM_STEPS: -1, gi_PROMPT: prompt || "", gi_SEED: -1, gi_SIMILARITY: 0,
  };
  return {
    _obj: "syntheticFill", _target: [{ _ref: "document", _enum: "ordinal", _value: "targetEnum" }],
    documentID: docId, layerID: layerId, prompt: prompt || "", serviceID: "clio", serviceOptionsList: { clio },
    workflow: "in_painting", workflowType: { _enum: "genWorkflow", _value: "in_painting" },
  };
}

/**
 * Seçili alanda Üretken Dolgu çalıştırır (Adobe üretken kredisi harcar). Hata → istisna.
 * Testlerde bu fonksiyon test düzeneği tarafından HER ZAMAN sahtesiyle değiştirilir (kredi koruması).
 */
async function generativeFill({ docId, layerId, prompt }) {
  const res = await action.batchPlay([syntheticFillDescriptor(docId, layerId, prompt)], { modalBehavior: "execute" });
  if (res[0] && res[0]._obj === "error") throw new Error(`Üretken Dolgu başarısız: ${res[0].message} (${res[0].result})`);
  return res;
}

module.exports = { syntheticFillDescriptor, generativeFill };
