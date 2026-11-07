// Eklenti veri klasöründe JSON saklama + Secure Storage (API anahtarları).
"use strict";
const { utf8Decode, utf8Encode } = require("../util/bytes");
const { log } = require("../util/common");

let uxp = null;
try { uxp = require("uxp"); } catch (e) { uxp = null; }

async function dataFolder() { return uxp.storage.localFileSystem.getDataFolder(); }

async function readJson(name, fallback) {
  try {
    const folder = await dataFolder();
    const f = await folder.getEntry(name);
    const txt = await f.read({ format: uxp.storage.formats.utf8 });
    return JSON.parse(txt);
  } catch (e) { return fallback; }
}

async function writeJson(name, obj) {
  const folder = await dataFolder();
  const f = await folder.createFile(name, { overwrite: true });
  await f.write(JSON.stringify(obj, null, 1), { format: uxp.storage.formats.utf8 });
}

// ---- Secure Storage: anahtarlar yalnızca burada; profillere/loglara asla yazılmaz ----
async function setSecret(key, value) {
  const ss = uxp.storage.secureStorage;
  if (!value) { try { await ss.removeItem(key); } catch (e) { /* yok */ } return; }
  await ss.setItem(key, value);
}

async function getSecret(key) {
  try {
    const v = await uxp.storage.secureStorage.getItem(key);
    if (v == null) return "";
    if (typeof v === "string") return v;
    return utf8Decode(v instanceof Uint8Array ? v : new Uint8Array(v));
  } catch (e) { log("warn", "Secure Storage okunamadı", String(e.message)); return ""; }
}

async function pickSaveFile(suggestedName, types) {
  return uxp.storage.localFileSystem.getFileForSaving(suggestedName, { types });
}
async function pickOpenFile(types) {
  return uxp.storage.localFileSystem.getFileForOpening({ types, allowMultiple: false });
}
async function pickFolder() { return uxp.storage.localFileSystem.getFolder(); }

module.exports = { readJson, writeJson, setSecret, getSecret, pickSaveFile, pickOpenFile, pickFolder, utf8Encode };
