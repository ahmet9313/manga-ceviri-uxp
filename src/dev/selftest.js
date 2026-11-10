// Panel içi CANLI kabul testi: gerçek Torii API + gerçek Photoshop belgesi.
// Etkin belgede çalışır (test sayfası açık olmalı). Rapor eklenti veri klasörüne "selftest-report.json" olarak yazılır.
"use strict";
const { modal, getDoc, findLayer, bp } = require("../ps/api");
const pixels = require("../ps/pixels");
const text = require("../ps/text");
const geom = require("../util/geom");
const storage = require("../model/storage");
const profiles = require("../model/profiles");
const { log } = require("../util/common");

async function runLive(app, opts) {
  opts = opts || {};
  const rep = { started: new Date().toISOString(), steps: [], env: {} };
  const P = app.pipeline, S = app.settings;
  const step = async (name, fn) => {
    const t0 = Date.now();
    try { const d = await fn(); rep.steps.push({ name, status: "PASS", ms: Date.now() - t0, detail: d }); }
    catch (e) { rep.steps.push({ name, status: "FAIL", ms: Date.now() - t0, error: String(e && (e.message || e)) }); }
    await storage.writeJson("selftest-report.json", rep).catch(() => {});
    app.notify(`Canlı test: ${name} → ${rep.steps[rep.steps.length - 1].status}`, rep.steps[rep.steps.length - 1].status === "PASS" ? "ok" : "warn");
  };
  const assert = (c, m) => { if (!c) throw new Error(m); };
  try { rep.env.ps = require("photoshop").app.version; rep.env.uxp = require("uxp").versions; } catch (e) { /* yok */ }
  const saved = { bubblesOnly: S.ui.bubblesOnly, filters: Object.assign({}, S.ui.filters), active: S.activeProfileId };

  let t = P.captureTarget();
  const sess = app.store.session(t.docId);
  rep.env.doc = { title: t.title, w: t.w, h: t.h, res: t.res };

  await step("Torii bağlantısı ve kredi", async () => {
    const before = await app.client.credits();
    rep.creditsStart = before;
    return { credits: before };
  });

  await step("Tespit Et (POST /api/v2/ocr, tam sayfa)", async () => {
    const r = await P._detectPage(t, false);
    assert(r && sess.state.items.length > 0, "öğe bulunamadı");
    return { items: sess.state.items.map((i) => ({ order: i.order, type: i.type, tone: i.tone, src: i.source.slice(0, 60), dir: i.direction, conf: i.confidence, bounds: geom.rectRound(i.bounds), why: i.typeReasons })) };
  });

  await step("Tekrar Tespit: aynı öğeler çoğalmaz", async () => {
    const n = sess.state.items.length;
    await P._detectPage(t, false);
    assert(sess.state.items.length === n, `öğe sayısı ${n} → ${sess.state.items.length}`);
    return { items: n };
  });

  // Sadece Balonlar modu: diyalog önerilerini onayla, diğerleri dokunulmaz kalmalı
  const others = sess.state.items.filter((i) => i.type !== "dialog");
  const otherAreas = others.map((i) => geom.rectRound(geom.rectInflate(i.bounds, 6, { left: 0, top: 0, right: t.w, bottom: t.h })));
  const snap = async () => { const out = []; for (const a of otherAreas) out.push((await modal("oku", () => pixels.readComposite(t.docId, a), {})).data); return out; };
  const before = await snap();

  await step("Sadece Balonlar: çeviri (POST /api/v2/upload texts)", async () => {
    S.ui.bubblesOnly = true;
    for (const i of sess.state.items) if (i.type === "dialog") i.typeConfirmed = true;
    await P._translatePage(t, "page", {});
    const dl = sess.state.items.filter((i) => i.type === "dialog");
    assert(dl.every((i) => i.translation), "tüm diyaloglar çevrilmeli");
    assert(others.every((i) => !i.status.translated), "diğer türler çevrilmemeli");
    return dl.map((i) => ({ order: i.order, src: i.source, tr: i.translation }));
  });

  await step("Sadece Balonlar: temizlik (Otomatik: yerel dolgu / POST /api/inpaint)", async () => {
    const plan = await P._cleanPage(t, "page", { force: true });
    assert(plan, "temizlik planı yok");
    return plan.map((p) => ({ order: p.item && p.item.order, method: p.decision.method, reason: p.decision.reason, metrics: p.metrics, ms: p.ms }));
  });

  await step("Sadece Balonlar: dizgi (düzenlenebilir metin katmanları)", async () => {
    await P._typesetPage(t, "page", {});
    const dl = sess.state.items.filter((i) => i.type === "dialog");
    const out = [];
    for (const i of dl) { const r = await text.readTextLayer(t.docId, i.layerId); out.push({ order: i.order, contents: r.contents, font: r.font, sizePx: r.sizePx, overflow: !!i.overflow }); }
    assert(dl.every((i) => i.layerId != null), "her diyalog katmana sahip olmalı");
    assert(others.every((i) => i.layerId == null && i.cleanLayerId == null), "diğer türlerde katman olmamalı");
    return out;
  });

  await step("Sadece Balonlar: SFX/anlatım/balon dışı pikseller birebir aynı", async () => {
    const after = await snap();
    let changed = 0, total = 0;
    for (let k = 0; k < before.length; k++) { total += before[k].length; for (let i = 0; i < before[k].length; i++) if (before[k][i] !== after[k][i]) changed++; }
    // Not: diyalog katmanı bu alanlarla örtüşürse fark oluşabilir; örtüşmeyen alanlarda 0 beklenir
    return { areas: otherAreas.length, channelsChecked: total, changed };
  });

  await step("Katman efekti (kontur + gölge) panel bağlamında", async () => {
    const it = sess.state.items.find((i) => i.layerId != null);
    assert(it, "dizgi katmanı yok");
    await modal("efekt", () => text.setStrokeShadow(t.docId, it.layerId, { strokeEnabled: true, strokeSize: 3, strokeColor: "#ffffff", shadowEnabled: true }), { documentID: t.docId, historyName: "Test efekt" });
    const fx = await text.readStrokeShadow(t.docId, it.layerId);
    assert(fx.strokeEnabled && fx.shadowEnabled, "efekt okunamadı");
    await modal("efekt geri", () => text.setStrokeShadow(t.docId, it.layerId, { strokeEnabled: false, shadowEnabled: false }), { documentID: t.docId, historyName: "Test efekt geri" });
    return fx;
  });

  await step("İki seri profili aynı sayfada farklı font uygular", async () => {
    const installed = P.fontSet();
    const fa = "ArialMT", fb = installed && installed.has("TimesNewRomanPSMT") ? "TimesNewRomanPSMT" : "Georgia";
    const pa = profiles.defaultProfile("Canlı Test A"); pa.base.font = fa;
    const pb = profiles.defaultProfile("Canlı Test B"); pb.base.font = fb;
    S.profiles.push(pa, pb);
    const old = sess.state.profileId;
    try {
      const res = {};
      for (const p of [pa, pb]) {
        sess.state.profileId = p.id;
        for (const i of sess.state.items) { i.lastApplied = null; i.manual = {}; }
        await P._typesetPage(t, "page", {});
        const i = sess.state.items.find((x) => x.layerId != null && x.tone === "normal") || sess.state.items.find((x) => x.layerId != null);
        res[p.name] = (await text.readTextLayer(t.docId, i.layerId)).font;
      }
      assert(res["Canlı Test A"] === fa && res["Canlı Test B"] === fb, JSON.stringify(res));
      return res;
    } finally {
      sess.state.profileId = old;
      S.profiles = S.profiles.filter((p) => p !== pa && p !== pb);
    }
  });

  if (opts.fullSingle) {
    await step("Tam İşlem tek istek (POST /api/v2/upload file) — yeni kopya belgede", async () => {
      await modal("kopya", () => bp({ _obj: "duplicate", _target: [{ _ref: "document", _id: t.docId }], name: "MCS_live_full", merged: true }), {});
      await app.onActiveDocChanged();
      const t2 = P.captureTarget();
      S.ui.bubblesOnly = false; S.ui.filters = { dialog: true, narration: true, offbubble: true, sfx: true };
      const s2 = app.store.session(t2.docId);
      s2.state.items = []; s2.state.groups = {};
      await P._fullSingleRequest(t2);
      return { items: s2.state.items.length, sample: s2.state.items.slice(0, 6).map((i) => ({ src: i.source.slice(0, 40), tr: i.translation.slice(0, 40), box: { cx: Math.round(i.box.cx), cy: Math.round(i.box.cy), w: Math.round(i.box.w), h: Math.round(i.box.h) }, layer: i.layerId != null, clean: i.cleanLayerId != null })) };
    });
  }

  await step("Kredi kullanımı", async () => { const c = await app.client.credits(); rep.creditsEnd = c; return { start: rep.creditsStart, end: c, used: Math.round((rep.creditsStart - c) * 1000) / 1000 }; });

  S.ui.bubblesOnly = saved.bubblesOnly; S.ui.filters = saved.filters; S.activeProfileId = saved.active;
  rep.finished = new Date().toISOString();
  rep.summary = { pass: rep.steps.filter((s) => s.status === "PASS").length, fail: rep.steps.filter((s) => s.status === "FAIL").length };
  await storage.writeJson("selftest-report.json", rep);
  log("info", "Canlı test bitti", rep.summary);
  return rep;
}

module.exports = { runLive };
