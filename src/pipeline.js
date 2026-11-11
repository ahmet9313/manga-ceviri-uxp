// İş akışı: Tespit Et / Yalnızca Temizle / Yalnızca Çevir / Yalnızca Dizgi / Tam İşlem
// Kapsam: region (seçili bölge) | selected (seçili öğeler) | page (sayfa) | chapter (bölüm)
// Güvenlik: her iş başlatıldığı belgenin kimliğini (docUid) taşır; sonuç yalnızca o belgeye, doğrulandıktan sonra yazılır.
"use strict";
const { app, modal, getDoc, findLayer, activeDoc, bp } = require("./ps/api");
const pixels = require("./ps/pixels");
const docs = require("./ps/document");
const text = require("./ps/text");
const geom = require("./util/geom");
const png = require("./util/png");
const { parseDataUrl } = require("./util/bytes");
const { log, clone } = require("./util/common");
const classify = require("./model/classify");
const cleanup = require("./model/cleanup");
const { resolveStyle, STYLE_FIELDS } = require("./model/rules");
const conf = require("./model/config");
const { pushHistory } = require("./model/store");
const { AmbiguousRequestError, estimateCredits } = require("./torii/client");

class TargetChangedError extends Error { constructor(m) { super(m); this.name = "TargetChangedError"; } }

/** Ücretli yanıt önbelleği anahtarı: baytların FNV-1a özeti + uzunluk (aynı görsel → aynı anahtar). */
function bytesKey(b) {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < b.length; i++) { h1 = Math.imul(h1 ^ b[i], 16777619); h2 = Math.imul(h2 ^ b[(b.length - 1 - i)], 2246822519) ^ (h2 >>> 13); }
  return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36) + "_" + b.length;
}

class Pipeline {
  /** hooks: { confirm(title, html, buttons) → index, notify(msg, kind), progress(label, frac), preview(data) → bool, ambiguous(info) → bool } */
  constructor(store, client, hooks) {
    this.store = store; this.client = client; this.hooks = hooks;
    this.busy = false;
    this.cancelRequested = false;
  }

  get settings() { return this.store.settings; }
  /** Tek çeviri/stil yapılandırması (Ayarlar). Seri profili sistemi yoktur. */
  cfg() { return this.settings.config; }
  chapter(state) { return state && state.chapterId ? this.settings.chapters.find((c) => c.id === state.chapterId) || null : null; }

  // ------------------------------------------------------------------ yardımcılar
  captureTarget() {
    const d = activeDoc();
    if (!d) throw new Error("Açık belge yok.");
    const s = this.store.session(d.id);
    if (!s) throw new Error("Belge panele yüklenemedi. Belge sekmesine bir kez tıklayıp tekrar deneyin.");
    return { docId: d.id, docUid: s.state.docUid, title: d.title, w: d.width, h: d.height, res: d.resolution, startedAt: Date.now() };
  }

  /** Sonucu yazmadan önce: belge hâlâ açık mı, aynı belge mi, etkin mi, boyutu aynı mı? */
  verifyTarget(t) {
    const d = getDoc(t.docId);
    const s = this.store.session(t.docId);
    if (!d || !s || s.state.docUid !== t.docUid) return { ok: false, reason: "closed" };
    if (d.width !== t.w || d.height !== t.h) return { ok: false, reason: "resized" };
    const a = activeDoc();
    if (!a || a.id !== t.docId) return { ok: false, reason: "inactive" };
    return { ok: true, doc: d, session: s };
  }

  /** Yazma adımını hedef belge doğrulanınca çalıştırır; değilse bekleyen sonuçlara alır. */
  async applyOrDefer(t, label, fn) {
    const v = this.verifyTarget(t);
    if (v.ok) return fn(v.session);
    if (v.reason === "resized") throw new TargetChangedError(`"${t.title}" belgesinin boyutu iş sırasında değişti; sonuç yazılmadı.`);
    this.store.addPending({ docUid: t.docUid, title: t.title, label, apply: async () => {
      const again = this.verifyTargetByUid(t);
      if (!again.ok) throw new TargetChangedError("Hedef belge uygun değil.");
      t.docId = again.session.docId; // belge kapatılıp yeniden açıldıysa Photoshop kimliği değişmiştir; yazma adımı güncel kimliği kullanmalı
      return fn(again.session);
    } });
    this.hooks.notify(`"${t.title}" etkin değil veya kapalı. "${label}" sonucu bekletiliyor; belgeye dönünce uygulanacak.`, "warn");
    return null;
  }

  verifyTargetByUid(t) {
    const s = this.store.findByUid(t.docUid);
    if (!s) return { ok: false, reason: "closed" };
    const nt = Object.assign({}, t, { docId: s.docId });
    return this.verifyTarget(nt);
  }

  filtersAllow(item) {
    const ui = this.settings.ui;
    if (item.hidden) return false;
    if (ui.bubblesOnly) return item.type === "dialog" && item.typeConfirmed;
    return !!ui.filters[item.type];
  }

  /** Kapsama göre öğeler. */
  async scopeItems(scope, t) {
    const s = this.store.session(t.docId);
    let items = s.state.items;
    if (scope === "selected") items = this.store.selectedItems(t.docId);
    else if (scope === "region") {
      const sb = await pixels.selectionBounds(t.docId);
      if (!sb) throw new Error("Photoshop'ta seçili bölge yok. Önce bir seçim yapın.");
      items = items.filter((i) => geom.rectIntersect(i.bounds, sb));
    }
    return items;
  }

  hideIds(s) { return [s.state.groups.clean, s.state.groups.trans].filter((x) => x != null); }

  async readOriginalArea(t, area) {
    const s = this.store.session(t.docId);
    return modal("Orijinal görüntüyü oku", () => pixels.readOriginal(t.docId, area, this.hideIds(s)), { documentID: t.docId, historyName: "Okuma", discard: true });
  }

  async ensureStructure(t) {
    const s = this.store.session(t.docId);
    const g = await docs.ensureStructure(t.docId, s.state.groups);
    s.state.groups = g;
    return g;
  }

  async persistInModal(s) {
    // Çağıran modal içinde: aynı geçmiş adımına yazılır
    await docs.writeState(s.docId, s.state);
    s.dirty = false;
    this.store.mirrorPage(s);
  }

  /**
   * Ücretli Torii isteği. cacheKey verilirse yanıt GELİR GELMEZ önbelleğe yazılır; aynı istek (aynı görsel baytları +
   * aynı seçenekler) tekrarlanırsa — ör. sonraki adım hata verdiyse veya sayfa yeniden işleniyorsa — kredi harcanmaz.
   */
  async withPaidRequest(label, fn, cacheKey) {
    this.checkCancel(); // Durdur'a basıldıysa yeni ücretli istek başlatılmaz
    this.paidCache = this.paidCache || new Map();
    if (cacheKey && this.paidCache.has(cacheKey)) {
      log("info", `${label}: önbellekteki ücretli yanıt yeniden kullanıldı (kredi harcanmadı)`);
      this.reusedPaid = (this.reusedPaid || 0) + 1;
      return this.paidCache.get(cacheKey);
    }
    for (;;) {
      try {
        const r = await fn();
        if (cacheKey) {
          this.paidCache.set(cacheKey, r);
          while (this.paidCache.size > 12) this.paidCache.delete(this.paidCache.keys().next().value); // bellek sınırı
        }
        return r;
      }
      catch (e) {
        if (!(e instanceof AmbiguousRequestError)) throw e;
        let after = null;
        try { after = await this.client.credits(); } catch (e2) { /* yok say */ }
        const retry = await this.hooks.ambiguous({ label, info: e.info, creditsAfter: after, message: e.message });
        if (!retry) throw new Error(label + ": kullanıcı yeniden göndermeyi iptal etti.");
      }
    }
  }

  progress(label, f) { try { this.hooks.progress(label, f); } catch (e) { /* yok say */ } }

  /**
   * Torii'den gelen görseli çözer. Biçim Data URL'deki türe değil, dosyanın imza baytlarına göre belirlenir:
   * PNG → yerleşik çözücü; JPEG / WebP / diğerleri → Photoshop'a geçici belge olarak açtırılır.
   * → {data, width, height, channels}
   */
  async decodeImage(dataUrlOrBytes, label) {
    const bytes = typeof dataUrlOrBytes === "string" ? parseDataUrl(dataUrlOrBytes).bytes : dataUrlOrBytes;
    const b = bytes;
    const isPng = b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
    const isJpg = b[0] === 0xff && b[1] === 0xd8;
    const isWebp = b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50;
    const kind = isPng ? "png" : isJpg ? "jpg" : isWebp ? "webp" : "bilinmiyor";
    log("info", `${label || "Görsel"} biçimi: ${kind} (${bytes.length} bayt)`);
    if (isPng) {
      try { return png.decodePng(bytes); } catch (e) { log("warn", "PNG çözücü başarısız, Photoshop ile denenecek", e.message); }
    }
    if (kind === "bilinmiyor" && !isPng) {
      const head = Array.from(b.subarray(0, 12)).map((x) => x.toString(16).padStart(2, "0")).join(" ");
      throw new Error(`${label || "Görsel"} tanınmayan biçimde geldi (ilk baytlar: ${head}).`);
    }
    return modal("Görseli çöz", () => pixels.decodeViaPhotoshop(bytes, isPng ? "png" : kind), {});
  }

  async run(name, fn) {
    if (this.busy) { this.hooks.notify(`"${this.busyName}" sürüyor — bitmesini bekleyin.`, "warn"); return null; }
    this.busy = true; this.busyName = name; this.cancelRequested = false; this.runMode = null; this.reusedPaid = 0;
    const t0 = Date.now();
    const c0 = this.client && this.client.lastCredits;
    if (this.hooks.busy) this.hooks.busy(true, name);
    let ok = false, cancelled = false;
    try {
      // İşlem öncesi doğrulama: etkin belgenin oturumu yoksa/eskiyse önce yükle
      if (this.hooks.ensureDoc) await this.hooks.ensureDoc();
      const r = await fn(); ok = true; return r;
    }
    catch (e) {
      if (e && e.cancelled) { cancelled = true; this.hooks.notify(`■ ${name} durduruldu. Tamamlanan adımlar yerinde kaldı; ${e.message}`, "warn"); return null; }
      log("error", name + " başarısız", String(e && e.message));
      this.hooks.notify("✕ " + name + ": " + (e && e.message ? e.message : e), "error");
      return null;
    } finally {
      this.busy = false; this.busyName = null;
      // Harcanan kredi: Torii her ücretli yanıtta kalan krediyi "credits" başlığında bildirir (önce − sonra)
      const c1 = this.client && this.client.lastCredits;
      const credits = c0 != null && c1 != null ? Math.max(0, Math.round((c0 - c1) * 1000) / 1000) : null;
      if (this.hooks.busy) this.hooks.busy(false, name, { ok, cancelled, ms: Date.now() - t0, credits, mode: this.runMode, reused: this.reusedPaid });
    }
  }

  // ------------------------------------------------------------------ TESPİT ET
  async detect(scope) {
    return this.run("Tespit Et", async () => {
      if (scope === "chapter") return this.forChapter("detect");
      const t = this.captureTarget();
      return this._detectPage(t, scope === "region");
    });
  }

  async _detectPage(t, regionOnly) {
    const s = this.store.session(t.docId);
    let area = { left: 0, top: 0, right: t.w, bottom: t.h };
    let selMask = null;
    if (regionOnly) {
      const sb = await pixels.selectionBounds(t.docId);
      if (!sb) throw new Error("Seçili bölge yok. Eksik balonu Photoshop'ta seçip tekrar deneyin.");
      area = geom.rectInflate(sb, 4, area);
      // OCR en az 50×50 ister
      // (sayfanın sağ/alt kenarındaki küçük seçimde de 50 px korunur: pencere içeri kaydırılır)
      if (area.right - area.left < 50) { const c = (area.left + area.right) / 2; area.left = Math.max(0, Math.min(t.w - 50, Math.floor(c - 25))); area.right = Math.min(t.w, area.left + 50); }
      if (area.bottom - area.top < 50) { const c = (area.top + area.bottom) / 2; area.top = Math.max(0, Math.min(t.h - 50, Math.floor(c - 25))); area.bottom = Math.min(t.h, area.top + 50); }
      selMask = await modal("Seçimi oku", () => pixels.selectionMask(t.docId, area), {});
    }
    this.progress("Görüntü okunuyor…", 0.1);
    const img = await this.readOriginalArea(t, area);
    const rgb = img.data;
    if (selMask && selMask.data) {
      // Seçim dışını beyazla (serbest biçimli seçimlerde yalnızca seçilen alan okunur)
      const sm = selMask, ox = sm.bounds.left - img.bounds.left, oy = sm.bounds.top - img.bounds.top;
      for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
        const sx = x - ox, sy = y - oy;
        const inside = sx >= 0 && sy >= 0 && sx < sm.width && sy < sm.height && sm.data[sy * sm.width + sx] > 127;
        if (!inside) { const i = (y * img.width + x) * 3; rgb[i] = rgb[i + 1] = rgb[i + 2] = 255; }
      }
    }
    const pngBytes = png.encodePng(rgb, img.width, img.height, 3, 4);
    this.progress("Torii OCR…", 0.3);
    const paras = await this.withPaidRequest("OCR", () => this.client.ocr({ bytes: pngBytes, mime: "image/png", width: img.width, height: img.height }), `ocr|${bytesKey(pngBytes)}`);
    const crop = { left: img.bounds.left, top: img.bounds.top, scale: 1 };
    let incoming = classify.itemsFromOcr(paras, crop);
    // Profilde kaynak dil seçiliyse başka dildeki yazılar (ör. arka plandaki Korece) öğe olmaz → çevrilmez, SİLİNMEZ
    const wl = conf.sourceWhitelist(this.cfg());
    if (wl) { const before = incoming.length; incoming = incoming.filter((i) => !i.sourceLang || wl.includes(i.sourceLang.toLowerCase()) || wl.includes(i.sourceLang.toLowerCase().split("-")[0])); if (before !== incoming.length) log("info", `Kaynak dil filtresi: ${before - incoming.length} başka dildeki yazı atlandı`); }
    this.refineTypes(incoming, img, false, { W: t.w, H: t.h }); // tür önerisini zemin piksellerine göre düzelt
    return this.applyOrDefer(t, "Tespit sonuçları", async (sess) => {
      const merged = classify.mergeDetections(sess.state.items, incoming);
      sess.state.items = merged.items;
      this.reorderByReading(sess);
      pushHistory(sess.state, { op: "detect", region: !!regionOnly, added: merged.added.length, updated: merged.updated.length });
      this.store.touch(sess.docId, { reason: "detect" });
      this.hooks.notify(`Tespit: ${merged.added.length} yeni, ${merged.updated.length} güncellendi (${paras.length} paragraf).`, "ok");
      return merged;
    });
  }

  /**
   * Türleri piksellere bakarak yeniden öner (ücretsiz). Kullanıcının onayladığı türlere dokunmaz.
   * img: {data(RGB), width, height, bounds} — öğeleri kapsayan görüntü.
   * textRemoved: true → görüntü temizlenmiş (inpainted); kutunun içi de zemin sayılır.
   */
  refineTypes(items, img, textRemoved, page) {
    const fsList = items.map((i) => i.ocr && i.ocr.fontsize).filter(Boolean);
    const medianFont = classify.median(fsList) || 24;
    const W = img.width, H = img.height, ox = img.bounds.left, oy = img.bounds.top;
    let changed = 0;
    // Önce balonu ara: kapalı bir balonun içindeki yazı SFX değildir (ör. siyah dikenli balon)
    for (const it of items) {
      if (it.typeConfirmed && (it.type === "sfx" || it.type === "offbubble")) { it.bubble = null; continue; }
      try { it.bubble = classify.detectBubble(img, it, page); } catch (e) { it.bubble = null; }
    }
    // Aynı balonu paylaşan öğeler (bir balonda iki paragraf): dizgide balon ortasına TOPLANMAZ, her biri kendi yerinde kalır
    const byRect = new Map();
    for (const it of items) if (it.bubble) { const k = JSON.stringify(it.bubble.rect); byRect.set(k, (byRect.get(k) || 0) + 1); }
    for (const it of items) if (it.bubble) it.bubble.shared = byRect.get(JSON.stringify(it.bubble.rect)) > 1;
    for (const it of items) {
      if (it.typeConfirmed) continue;
      const fs = (it.ocr && it.ocr.fontsize) || medianFont;
      const pad = Math.round(Math.max(6, fs * 0.7));
      const a = geom.rectRound(geom.rectInflate(it.bounds, pad, { left: ox, top: oy, right: ox + W, bottom: oy + H }));
      const w = a.right - a.left, h = a.bottom - a.top;
      if (w < 4 || h < 4) continue;
      const sub = new Uint8Array(w * h * 3);
      for (let y = 0; y < h; y++) { const so = ((a.top - oy + y) * W + (a.left - ox)) * 3; sub.set(img.data.subarray(so, so + w * 3), y * w * 3); }
      const inside = new Uint8Array(w * h);
      const polys = !textRemoved && it.maskPolygons ? it.maskPolygons : !textRemoved && it.lines && it.lines.length ? it.lines : [it.polygon];
      for (const p of polys) if (p && p.length >= 3) geom.fillPolygon(inside, w, h, p, a, 255);
      const ins = textRemoved ? inside : geom.dilate(inside, w, h, 2);
      const st = classify.ringStats(sub, w, h, ins, Math.round(fs * 0.6), textRemoved);
      const r = classify.refineTypeByStats(it, st, medianFont);
      if (r.type !== it.type) changed++;
      it.type = r.type; it.typeSuggested = r.type; it.typeReasons = r.reasons; it.bgStats = st;
    }
    // SFX / balon dışı kalanlarda balon bilgisi kullanılmaz
    for (const it of items) if (it.type === "sfx" || it.type === "offbubble") it.bubble = null;
    return changed;
  }

  /** Mevcut sayfadaki öğelerin türlerini yeniden öner (Torii'ye istek yok). */
  async reclassify() {
    return this.run("Türleri yeniden öner", async () => {
      const t = this.captureTarget();
      const s = this.store.session(t.docId);
      if (!s.state.items.length) throw new Error("Öğe yok.");
      let u = null;
      for (const it of s.state.items) u = geom.rectUnion(u, geom.rectInflate(it.bounds, 60, { left: 0, top: 0, right: t.w, bottom: t.h }));
      const img = await this.readOriginalArea(t, geom.rectRound(u));
      const n = this.refineTypes(s.state.items, img, false, { W: t.w, H: t.h });
      this.store.touch(t.docId, { reason: "reclassify" });
      this.hooks.notify(`Türler piksellere göre yeniden önerildi: ${n} öğe değişti (onaylı türlere dokunulmadı).`, "ok");
      return n;
    });
  }

  reorderByReading(sess) {
    const prof = this.cfg();
    const items = sess.state.items;
    if (sess.state.orderEdited) {
      // Kullanıcı sırayı elle değiştirdiyse mevcut sıra korunur; yeniler okuma sırasıyla sona eklenir.
      const known = items.filter((i) => i.order), fresh = items.filter((i) => !i.order);
      const sortedFresh = geom.readingOrder(fresh, prof.readingDir);
      sess.state.items = known.sort((a, b) => a.order - b.order).concat(sortedFresh);
    } else sess.state.items = geom.readingOrder(items, prof.readingDir);
    sess.state.items.forEach((x, i) => { x.order = i + 1; });
  }

  // ------------------------------------------------------------------ ÇEVİR
  async translate(scope, opts) {
    return this.run("Yalnızca Çevir", async () => {
      if (scope === "chapter") return this.forChapter("translate", opts);
      const t = this.captureTarget();
      return this._translatePage(t, scope, opts);
    });
  }

  async _translatePage(t, scope, opts) {
    opts = opts || {};
    const s = this.store.session(t.docId);
    const items = (await this.scopeItems(scope, t)).filter((i) => this.filtersAllow(i) && (i.source || "").trim());
    const todo = items.filter((i) => {
      if (i.locks.text || i.translationEdited) return !!opts.forceEvenLocked && !i.locks.text;
      return opts.force || !i.status.translated || !i.translation;
    });
    if (!todo.length) { this.hooks.notify("Çevrilecek öğe yok (kilitli, onaylı veya zaten çevrilmiş).", "info"); return null; }
    const prof = this.cfg(), ch = this.chapter(s.state);
    const tset = this.settings.torii;
    const req = {
      target_lang: prof.targetLang || "tr",
      source_langs_whitelist: conf.sourceWhitelist(prof),
      translator: prof.translator || tset.translator,
      reasoning_effort: prof.reasoning || tset.reasoning,
      custom_prompt: conf.buildCustomPrompt(prof, ch, opts.extraInstruction),
      context: conf.buildContext(prof, ch, s.state.chainContext || (ch && ch.chainContext) || ""),
      byok: await this.byok(),
    };
    this.progress(`Çeviri (${todo.length} metin)…`, 0.4);
    const cacheKey = "tr|" + JSON.stringify([todo.map((i) => i.source), Object.assign({}, req, { byok: req.byok ? req.byok.provider : null })]);
    // "Yeniden çevir": kullanıcı YENİ bir çeviri istiyor → önbellekteki aynı yanıt geri verilmez
    if (opts.forceEvenLocked && this.paidCache) this.paidCache.delete(cacheKey);
    const j = await this.withPaidRequest("Çeviri", () => this.client.translateTexts(todo.map((i) => i.source), req), cacheKey);
    return this.applyOrDefer(t, "Çeviri sonuçları", async (sess) => {
      // Sabit kimliklerle eşle: gönderim sırası = yanıt sırası
      todo.forEach((it, k) => {
        const live = sess.state.items.find((x) => x.id === it.id);
        if (!live || live.locks.text) return;
        live.translation = conf.applyTurkishFixes(j.text[k], prof.turkish);
        live.translationEdited = false; // yeni çeviri geldi: "elle düzenlendi" işareti kalkar (yoksa öğe toplu çeviriden kalıcı dışlanırdı)
        live.status.translated = true;
        live.translatedAt = Date.now();
      });
      if (j.context) { sess.state.chainContext = j.context; if (ch) ch.chainContext = j.context; }
      pushHistory(sess.state, { op: "translate", n: todo.length, credits: j.metadata && j.metadata.credits_used });
      this.store.touch(sess.docId, { reason: "translate" });
      this.hooks.notify(`${todo.length} metin çevrildi${j.metadata && j.metadata.credits_used != null ? " (" + j.metadata.credits_used + " kredi)" : ""}.`, "ok");
      return todo.length;
    });
  }

  async byok() {
    const p = this.settings.torii.byokProvider;
    if (!p) return null;
    const key = await require("./model/storage").getSecret("byok_" + p);
    return key ? { provider: p, key, fallback: this.settings.torii.byokFallback !== false } : null;
  }

  // ------------------------------------------------------------------ TEMİZLE
  async clean(scope, opts) {
    return this.run("Yalnızca Temizle", async () => {
      if (scope === "chapter") return this.forChapter("clean", opts);
      const t = this.captureTarget();
      return this._cleanPage(t, scope, opts || {});
    });
  }

  async _cleanPage(t, scope, opts) {
    const s = this.store.session(t.docId);
    const prof = this.cfg();
    const docRect = { left: 0, top: 0, right: t.w, bottom: t.h };
    let items = opts.objectRemoval ? [] : (await this.scopeItems(scope, t)).filter((i) => this.filtersAllow(i));
    if (opts.itemIds) items = s.state.items.filter((i) => opts.itemIds.includes(i.id));
    if (!opts.force) items = items.filter((i) => !i.status.cleaned);
    // Elle düzeltilmiş maske: YALNIZCA açıkça istenince ("Seçimle düzelt", "Nesne kaldır") Photoshop seçimi maske olur.
    // "Bölge" kapsamı tek başına yalnızca seçimle kesişen öğeleri süzer; yoksa balonu çevreleyen kaba bir seçim
    // tümüyle maskeye girip balon konturunu ve çizimi de silerdi.
    let manualSel = null;
    if (opts.useSelectionMask) {
      const sb = await pixels.selectionBounds(t.docId);
      if (!sb) throw new Error("Photoshop'ta seçim yok. Önce temizlenecek alanı seçin.");
      manualSel = await modal("Seçimi oku", () => pixels.selectionMask(t.docId, geom.rectInflate(sb, 0, docRect)), {});
    }
    if (!items.length && !manualSel) { this.hooks.notify("Temizlenecek öğe yok.", "info"); return null; }
    const plan = [];
    // Analiz için tüm öğelerin birleşik alanını tek seferde oku
    let union = null;
    this._maskOverrides = this._maskOverrides || {};
    const prepared = items.map((it) => {
      const ov = this._maskOverrides[it.id];
      let area = ov ? ov.area : cleanup.itemArea(it, docRect, 24);
      // Balonlu öğe: alan balonun tamamını kapsar (balon içindeki tüm yazı parçaları temizlensin)
      if (!ov && it.bubble && it.bubble.rect && (it.type === "dialog" || it.type === "narration")) area = geom.rectRound(geom.rectUnion(area, geom.rectInflate(it.bubble.rect, 4, docRect)));
      union = geom.rectUnion(union, area); return { it, area, ov };
    });
    if (manualSel) union = geom.rectUnion(union, manualSel.bounds);
    union = geom.rectRound(union);
    this.progress("Görüntü okunuyor…", 0.1);
    const img = await this.readOriginalArea(t, union);
    const sub = (area) => {
      const w = area.right - area.left, h = area.bottom - area.top, out = new Uint8Array(w * h * 3);
      for (let y = 0; y < h; y++) {
        const so = ((area.top - img.bounds.top + y) * img.width + (area.left - img.bounds.left)) * 3;
        out.set(img.data.subarray(so, so + w * 3), y * w * 3);
      }
      return out;
    };
    const methodSetting = opts.method || prof.cleanup.method || "auto";
    for (const p of prepared) {
      // Tam İşlem'den gelen kesin harf maskesi (orijinal ↔ temizlenmiş farkı) varsa o kullanılır
      // SFX'te harflerin etrafındaki kontur da silinsin: kontur kalınlığı kadar genişlet
      const ovR = p.ov ? Math.max(4, Math.round(((p.it.ocr && p.it.ocr.fontsize) || 40) * 0.09), Math.round(((p.it.ocr && p.it.ocr.strokeWidth) || 0) * 0.7)) : 0;
      const mk = p.ov ? { mask: geom.dilate(p.ov.mask, p.ov.width, p.ov.height, ovR), width: p.ov.width, height: p.ov.height, area: p.area, radius: ovR } : cleanup.itemMask(p.it, p.area, prof.cleanup.dilatePx);
      // Balon içindeki TÜM mürekkep (OCR poligonu dışında kalan kopuk nokta / taşan satır / ünlem dahil) maskeye eklenir
      if (!p.ov && p.it.bubble && p.it.bubble.rect && (p.it.type === "dialog" || p.it.type === "narration")) {
        const raw = cleanup.bubbleInkMask(sub(p.area), mk.width, mk.height, p.area, p.it.bubble, p.it.box);
        p.bubbleFlat = raw.regionPx > 50 && raw.bgStd < 7; // balon zemini düz mü (tram/gradyan yok)
        const ink = geom.dilate(raw, mk.width, mk.height, 2);
        for (let i = 0; i < ink.length; i++) if (ink[i]) mk.mask[i] = 255;
      }
      // Elle düzeltilmiş maske varsa öğe maskesiyle kesiştir/birleştir
      if (manualSel && geom.rectIntersect(p.area, manualSel.bounds)) {
        const w = mk.width, sm = manualSel;
        for (let y = 0; y < mk.height; y++) for (let x = 0; x < w; x++) {
          const sx = p.area.left + x - sm.bounds.left, sy = p.area.top + y - sm.bounds.top;
          const sel = sx >= 0 && sy >= 0 && sx < sm.width && sy < sm.height ? sm.data[sy * sm.width + sx] : 0;
          mk.mask[y * w + x] = sel > 127 ? 255 : (opts.selectionOnly ? 0 : mk.mask[y * w + x]);
        }
      }
      const rgb = sub(p.area);
      const stats = cleanup.analyzeRegion(rgb, mk.width, mk.height, mk.mask, mk.radius);
      let decision;
      if (methodSetting === "auto") {
        decision = cleanup.chooseMethod(stats, p.it, { contentAware: true });
        // Kapalı balon + düz zemin: balon rengiyle yerel düz dolgu (kredisiz, balon içindeki tüm parçalar dahil)
        if (p.bubbleFlat && (p.it.type === "dialog" || p.it.type === "narration")) { decision = { method: "flat", reason: "Kapalı balon, düz zemin → balon rengiyle yerel düz dolgu (kredisiz)." }; stats.medianHex = p.it.bubble.bg || stats.medianHex; }
        // Çizim üstü SFX: Torii dokuyu bulanıklaştırıyor → SFX yöntemi (Adobe öğretildiyse Adobe, yoksa İçerik Duyarlı Dolgu)
        if (p.it && p.it.type === "sfx" && stats.kind !== "flat") {
          const m = this.sfxMethod();
          if (m !== "torii") decision = { method: m, reason: `Çizim üstü SFX → ${cleanup.METHODS[m].label} (Torii çizimde bulanık iz bırakıyor).` };
        }
      } else decision = { method: methodSetting, reason: "Elle seçilen yöntem: " + cleanup.METHODS[methodSetting].label };
      plan.push({ item: p.it, area: p.area, mask: mk, rgb, stats, decision });
    }
    if (manualSel && !items.length) {
      // Öğesiz, yalnızca seçim maskesi ile temizlik (ör. elle seçilen leke/yazı)
      const area = geom.rectRound(manualSel.bounds);
      const m = { mask: manualSel.data.map((v) => (v > 127 ? 255 : 0)), width: manualSel.width, height: manualSel.height, area, radius: 3 };
      const rgb = sub(area);
      const stats = cleanup.analyzeRegion(rgb, m.width, m.height, m.mask, 3);
      const decision = methodSetting === "auto" ? cleanup.chooseMethod(stats, null, {}) : { method: methodSetting, reason: "Elle seçilen yöntem" };
      plan.push({ item: null, area, mask: m, rgb, stats, decision });
    }
    // TAMAMEN OTOMATİK: Üretken Dolgu bu oturumda çalışmadıysa doğrudan otomatik yedek (kullanıcıya hiçbir şey devredilmez)
    for (const p of plan) {
      if (p.decision.method === "adobeGenerative" && this._adobeFail) {
        p.decision = { method: "contentAware", reason: `Adobe Üretken Dolgu bu oturumda çalışmadı (${String(this._adobeFail).slice(0, 60)}) → otomatik İçerik Duyarlı Dolgu.` };
      }
      if (p.decision.method === "firefly" && !this.firefly) p.decision = Object.assign(cleanup.chooseMethod(p.stats, p.item, { contentAware: true }), { reason: "Firefly Services kurulu değil → otomatik yöntem." });
    }
    if (opts.decideOnly) return plan; // yalnızca yöntem kararları (API çağrısı yok)
    // Torii inpaint: tek istekte birleşik maske
    const toriiPlans = plan.filter((p) => p.decision.method === "torii");
    if (toriiPlans.length) await this.toriiPatches(toriiPlans);
    // Firefly Services (sunucu vekili): öğe başına maskeli dolgu
    for (const p of plan.filter((q) => q.decision.method === "firefly")) {
      const t0 = Date.now();
      try {
        const r = await this.firefly.fill(png.encodePng(p.rgb, p.mask.width, p.mask.height, 3, 4), png.encodePng(p.mask.mask, p.mask.width, p.mask.height, 1, 6), opts.prompt || "");
        const dec = r.mime === "image/png" ? png.decodePng(r.bytes) : await modal("Firefly sonucunu çöz", () => pixels.decodeViaPhotoshop(r.bytes, "jpg"), {});
        if (dec.width !== p.mask.width || dec.height !== p.mask.height) throw new Error("Firefly sonucu boyutu farklı");
        p.patch = cleanup.patchFromResult(dec.data, dec.channels, dec.width, dec.height, p.mask.mask);
        p.ms = Date.now() - t0; p.cost = null;
      } catch (e) {
        // Otomatik yedek: aynı öğe yerel yöntemle (düz zemin → düz dolgu, değilse İçerik Duyarlı)
        const alt = p.stats.kind === "flat" ? "flat" : "contentAware";
        p.decision = { method: alt, reason: `Firefly Services çalışmadı (${String(e.message).slice(0, 60)}) → otomatik ${cleanup.METHODS[alt].label}.` };
      }
    }
    for (const p of plan.filter((q) => q.decision.method === "flat")) {
      const t0 = Date.now();
      p.patch = cleanup.flatFillPatch(p.mask.width, p.mask.height, p.mask.mask, p.stats.medianHex || "#ffffff");
      p.ms = Date.now() - t0; p.cost = 0;
    }
    for (const p of plan) if (p.patch) p.metrics = cleanup.qualityMetrics(p.rgb, p.patch, p.mask.width, p.mask.height, p.mask.mask, p.stats);
    if (opts.dryRun) return plan; // karşılaştırma: katmana yazmadan sonuçları döndür
    // Önizleme ve onay (tek öğe veya istenirse)
    if (opts.previewForced && plan.some((p) => p.patch)) { // yalnızca açıkça istenirse (varsayılan: önizleme yok, tam otomatik)
      const ok = await this.hooks.preview(plan.filter((p) => p.patch));
      if (!ok) { this.hooks.notify("Temizlik onaylanmadı; hiçbir piksel değişmedi.", "info"); return null; }
    }
    return this.applyOrDefer(t, "Temizlik", async (sess) => {
      await modal("Temizlik", async () => {
        const g = await this.ensureStructure(t);
        for (const p of plan) {
          const m = p.decision.method;
          if (m === "flat" || m === "torii" || m === "firefly") await this.writeCleanPatch(sess, t, g, p);
          else if (m === "contentAware") await this.contentAwareClean(sess, t, g, p);
        }
        await this.persistInModal(sess);
      }, { documentID: t.docId, historyName: `Temizlik (${plan.length} öğe)` });
      // Çizim üstü SFX: Üretken Dolgu → (olmazsa) İçerik Duyarlı → (olmazsa) Torii; öğe öğe, otomatik
      const gen = plan.filter((p) => p.decision.method === "adobeGenerative");
      if (gen.length) await this.generativeClean(sess, t, gen, opts.prompt);
      pushHistory(sess.state, { op: "clean", n: plan.length, methods: plan.map((p) => p.decision.method) });
      this.store.touch(sess.docId, { reason: "clean", noPersist: true });
      // Sonuç mesajı yalnızca GERÇEKTEN temizlenenleri sayar; yöntem ve nedeni yazılır
      const label = (p) => (cleanup.METHODS[(p.item && p.item.cleanMethod) || p.decision.method] || {}).label || p.decision.method;
      const items = plan.filter((p) => p.item);
      const done = items.filter((p) => p.item.status.cleaned);
      const counts = {};
      for (const p of done) counts[label(p)] = (counts[label(p)] || 0) + 1;
      const how = Object.keys(counts).map((k) => `${counts[k]} × ${k}`).join(", ");
      const fallbacks = plan.filter((p) => /→ otomatik|→ Torii/.test(p.decision.reason || "")).map((p) => `${p.item ? "#" + p.item.order : "Seçim"}: ${p.decision.reason}`);
      if (done.length === items.length) this.hooks.notify(`Temizlik: ${done.length} öğe temizlendi (${how || "seçim"}).${fallbacks.length ? " Yedek yöntem: " + fallbacks.slice(0, 2).join(" | ") : ""}`, fallbacks.length ? "warn" : "ok");
      else this.hooks.notify(`Temizlik eksik: ${done.length}/${items.length} öğe temizlendi. Kalanlar listede "T" işaretsiz.`, "warn");
      return plan;
    });
  }

  /** Öğenin temizlik katmanını oluşturur/günceller (aynı öğeden ikinci katman oluşmaz). Maske dışı alfa=0 + katman maskesi. */
  async writeCleanPatch(sess, t, g, p) {
    const doc = getDoc(t.docId);
    const name = p.item ? `Temizlik #${p.item.order} · ${p.item.id.slice(-4)}` : "Temizlik · seçim";
    let layerId = p.item && p.item.cleanLayerId != null && findLayer(doc, p.item.cleanLayerId) ? p.item.cleanLayerId : null;
    if (layerId != null) {
      // Eski pikselleri temizle (yeniden çalıştırma aynı katmanı günceller)
      const L = findLayer(doc, layerId), b = L.bounds;
      const bw = Math.round(b.right - b.left), bh = Math.round(b.bottom - b.top);
      if (bw > 0 && bh > 0) await pixels.writeLayerPixels(t.docId, layerId, new Uint8Array(bw * bh * 4), bw, bh, Math.round(b.left), Math.round(b.top));
    } else layerId = await docs.makePixelLayerIn(t.docId, g.clean, name);
    await pixels.writeLayerPixels(t.docId, layerId, p.patch, p.mask.width, p.mask.height, p.area.left, p.area.top);
    await pixels.writeLayerMask(t.docId, layerId, p.mask.mask, p.mask.width, p.mask.height, p.area.left, p.area.top);
    if (p.item) {
      p.item.cleanLayerId = layerId;
      p.item.status.cleaned = true;
      p.item.cleanMethod = p.decision.method; p.item.cleanReason = p.decision.reason; p.item.cleanMetrics = p.metrics;
    }
  }

  /** Adobe İçerik Duyarlı Dolgu (yerel Photoshop). Sonuç ayrı katmanda, maskeli. */
  async contentAwareClean(sess, t, g, p) {
    const doc = getDoc(t.docId);
    let layerId = p.item && p.item.cleanLayerId != null && findLayer(doc, p.item.cleanLayerId) ? p.item.cleanLayerId : null;
    if (layerId == null) layerId = await docs.makePixelLayerIn(t.docId, g.clean, p.item ? `Temizlik #${p.item.order} · ${p.item.id.slice(-4)}` : "Temizlik · seçim");
    // Katmana orijinal alanı koy, maskeyi seçime aktar, içerik duyarlı dolgu, katman maskesi
    const w = p.mask.width, h = p.mask.height, rgba = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) { rgba[i * 4] = p.rgb[i * 3]; rgba[i * 4 + 1] = p.rgb[i * 3 + 1]; rgba[i * 4 + 2] = p.rgb[i * 3 + 2]; rgba[i * 4 + 3] = 255; }
    await pixels.writeLayerPixels(t.docId, layerId, rgba, w, h, p.area.left, p.area.top);
    await bp({ _obj: "select", _target: [{ _ref: "layer", _id: layerId }], makeVisible: false });
    await pixels.maskToSelection(t.docId, p.mask.mask, w, h, p.area.left, p.area.top);
    await bp({ _obj: "fill", using: { _enum: "fillContents", _value: "contentAware" }, contentAwareColorAdaptationFill: true, opacity: { _unit: "percentUnit", _value: 100 }, mode: { _enum: "blendMode", _value: "normal" } });
    await pixels.deselect();
    await pixels.writeLayerMask(t.docId, layerId, p.mask.mask, w, h, p.area.left, p.area.top);
    if (p.item) { p.item.cleanLayerId = layerId; p.item.status.cleaned = true; p.item.cleanMethod = "contentAware"; p.item.cleanReason = p.decision.reason; }
  }

  /**
   * Çizim üstü SFX temizlik yöntemi. "auto" (varsayılan): Adobe Üretken Dolgu (panelden doğrudan çağrı) →
   * çalışmazsa İçerik Duyarlı Dolgu → o da çalışmazsa Torii Inpaint. Hiçbir adımda kullanıcıdan işlem istenmez.
   * Üretken Dolgu bu panel oturumunda bir kez başarısız olursa oturum boyunca tekrar denenmez (her deneme zaman kaybı).
   */
  sfxMethod() {
    const prof = this.cfg();
    const pref = (prof.cleanup && prof.cleanup.sfxMethod) || "auto";
    if (pref === "auto" || pref === "adobeGenerative") return this._adobeFail ? "contentAware" : "adobeGenerative";
    return pref;
  }

  saveHook() { try { if (this.hooks.saveSettings) this.hooks.saveSettings(); } catch (e) { /* yok */ } }

  /** Üretken Dolgu'nun son sonucu (panelde bilgi olarak gösterilir). */
  _adobeStatus(ok, reason) {
    const A = this.settings.adobe || (this.settings.adobe = {});
    A.last = { ok: !!ok, reason: reason ? String(reason).slice(0, 200) : "", at: new Date().toISOString() };
    if (!ok) this._adobeFail = A.last.reason || "bilinmiyor";
    this.saveHook();
  }

  /**
   * Üretken Dolgu ile öğe öğe temizlik. Başarısız öğe otomatik İçerik Duyarlı Dolgu'ya, o da olmazsa Torii Inpaint'e düşer.
   * Her öğe ayrı geçmiş adımıdır; sonuç katmanına KENDİ maskemiz uygulanır (maske dışı piksel değişmez).
   */
  async generativeClean(sess, t, plans, prompt) {
    const adobe = require("./ps/adobe");
    const toTorii = [];
    for (let k = 0; k < plans.length; k++) {
      const p = plans[k];
      this.checkCancel();
      if (!this._adobeFail) {
        this.progress(`Adobe Üretken Dolgu ${k + 1}/${plans.length}`, k / plans.length);
        try {
          await this.generativeOne(sess, t, p, prompt, adobe);
          const A = this.settings.adobe || {};
          if (!(A.last && A.last.ok)) this._adobeStatus(true);
          continue;
        } catch (e) {
          log("warn", `Üretken Dolgu başarısız (#${p.item ? p.item.order : "-"}): ${e.message} → İçerik Duyarlı Dolgu`);
          this._adobeStatus(false, e.message);
          await pixels.deselect().catch(() => {});
        }
      }
      const why = `Adobe Üretken Dolgu kullanılamadı (${String(this._adobeFail).slice(0, 80)}) → otomatik İçerik Duyarlı Dolgu.`;
      p.decision = { method: "contentAware", reason: why };
      this.progress(`İçerik Duyarlı Dolgu ${k + 1}/${plans.length}`, k / plans.length);
      try {
        await modal("İçerik Duyarlı Dolgu", async () => { const g = await this.ensureStructure(t); await this.contentAwareClean(sess, t, g, p); await this.persistInModal(sess); }, { documentID: t.docId, historyName: `Temizlik #${p.item ? p.item.order : "seçim"}` });
      } catch (e2) {
        log("warn", `İçerik Duyarlı Dolgu başarısız (#${p.item ? p.item.order : "-"}): ${e2.message} → Torii Inpaint`);
        await pixels.deselect().catch(() => {});
        p.decision = { method: "torii", reason: `${why.replace(/\.$/, "")}; İçerik Duyarlı da çalışmadı (${String(e2.message).slice(0, 60)}) → Torii Inpaint.` };
        toTorii.push(p);
      }
    }
    if (toTorii.length) {
      await this.toriiPatches(toTorii);
      await modal("Temizlik (Torii)", async () => {
        const g = await this.ensureStructure(t);
        for (const p of toTorii) await this.writeCleanPatch(sess, t, g, p);
        await this.persistInModal(sess);
      }, { documentID: t.docId, historyName: `Temizlik (${toTorii.length} öğe, Torii)` });
    }
  }

  /** Tek öğe: maske → seçim → syntheticFill → Photoshop'un oluşturduğu katman Temizlik grubuna taşınır, maskemiz uygulanır. */
  async generativeOne(sess, t, p, prompt, adobe) {
    const api = require("./ps/api");
    const doc = getDoc(t.docId);
    await modal("Adobe Üretken Dolgu", async () => {
      const g = await this.ensureStructure(t);
      const w = p.mask.width, h = p.mask.height;
      const before = new Set(api.allLayers(doc).map((l) => l.id));
      const top = findLayer(doc, g.clean);
      const anchor = top && top.layers && top.layers.length ? top.layers[0].id : g.clean;
      await bp({ _obj: "select", _target: [{ _ref: "layer", _id: anchor }], makeVisible: false });
      await pixels.maskToSelection(t.docId, p.mask.mask, w, h, p.area.left, p.area.top);
      try {
        await adobe.generativeFill({ docId: t.docId, layerId: anchor, prompt: prompt != null ? prompt : (this.settings.adobe && this.settings.adobe.prompt) || "" });
      } finally { await pixels.deselect().catch(() => {}); }
      const created = api.allLayers(doc).find((l) => !before.has(l.id));
      if (!created) throw new Error("Üretken Dolgu yeni katman oluşturmadı (Adobe oturumu veya üretken kredi?).");
      const grp = findLayer(doc, g.clean);
      if (!created.parent || created.parent.id !== g.clean) await created.move(grp, api.constants.ElementPlacement.PLACEINSIDE);
      created.name = p.item ? `Üretken #${p.item.order} · ${p.item.id.slice(-4)}` : "Üretken · seçim";
      // Kendi maskemiz: Adobe sonucu yalnızca maske içinde görünür (maske dışı pikseller değişmez)
      // putLayerMask yazılmayan bölgeyi BEYAZ (görünür) bırakır → maske katmanın TÜM sınırını kapsar, öğe maskesi dışı siyah
      try {
        const lb = created.bounds, dr = { left: 0, top: 0, right: t.w, bottom: t.h };
        const mr = geom.rectRound(geom.rectIntersect(geom.rectUnion({ left: lb.left, top: lb.top, right: lb.right, bottom: lb.bottom }, p.area), dr) || p.area);
        const MW = mr.right - mr.left, MH = mr.bottom - mr.top, full = new Uint8Array(MW * MH);
        for (let y = 0; y < h; y++) {
          const ty = p.area.top - mr.top + y;
          if (ty < 0 || ty >= MH) continue;
          for (let x = 0; x < w; x++) { const tx = p.area.left - mr.left + x; if (tx >= 0 && tx < MW && p.mask.mask[y * w + x]) full[ty * MW + tx] = 255; }
        }
        await pixels.writeLayerMask(t.docId, created.id, full, MW, MH, mr.left, mr.top);
      }
      catch (e) { log("warn", "Üretken katmana maske yazılamadı; Photoshop'un seçimden oluşturduğu maske geçerli", e.message); }
      if (p.item) {
        if (p.item.cleanLayerId != null && findLayer(doc, p.item.cleanLayerId)) await docs.deleteLayer(t.docId, p.item.cleanLayerId);
        p.item.cleanLayerId = created.id; p.item.status.cleaned = true;
        p.item.cleanMethod = "adobeGenerative"; p.item.cleanReason = "Çizim üstü SFX → Adobe Üretken Dolgu (Firefly), otomatik.";
      }
      await this.persistInModal(sess);
    }, { documentID: t.docId, historyName: `Üretken Dolgu #${p.item ? p.item.order : "seçim"}` });
  }

  /** Torii Inpaint: planların maskeleri tek istekte (birleşik alan) gönderilir; her plana p.patch yazılır. */
  async toriiPatches(plans) {
    let ua = null;
    for (const p of plans) ua = geom.rectUnion(ua, p.area);
    ua = geom.rectRound(ua);
    const W = ua.right - ua.left, H = ua.bottom - ua.top;
    const um = new Uint8Array(W * H), urgb = new Uint8Array(W * H * 3);
    for (const p of plans) {
      const pw = p.mask.width;
      for (let y = 0; y < p.mask.height; y++) {
        const ro = (p.area.top - ua.top + y) * W + (p.area.left - ua.left);
        urgb.set(p.rgb.subarray(y * pw * 3, (y + 1) * pw * 3), ro * 3);
        for (let x = 0; x < pw; x++) if (p.mask.mask[y * pw + x]) um[ro + x] = 255;
      }
    }
    const imgBytes = png.encodePng(urgb, W, H, 3, 4);
    const maskBytes = png.encodePng(um, W, H, 1, 6);
    this.progress(`Torii Inpaint (${plans.length} öğe)…`, 0.5);
    const t0 = Date.now();
    const dataUrl = await this.withPaidRequest("Inpaint", () => this.client.inpaint({ bytes: imgBytes, mime: "image/png", width: W, height: H }, { bytes: maskBytes, width: W, height: H }), `inp|${bytesKey(imgBytes)}|${bytesKey(maskBytes)}`);
    const dec = await this.decodeImage(dataUrl, "Inpaint sonucu");
    if (dec.width !== W || dec.height !== H) throw new Error(`Inpaint sonucu boyutu farklı (${dec.width}×${dec.height}, beklenen ${W}×${H}).`);
    for (const p of plans) {
      const w = p.mask.width, h = p.mask.height, res = new Uint8Array(w * h * 3);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const si = ((p.area.top - ua.top + y) * W + (p.area.left - ua.left + x)) * dec.channels, di = (y * w + x) * 3;
        res[di] = dec.data[si]; res[di + 1] = dec.data[si + 1]; res[di + 2] = dec.data[si + 2];
      }
      p.patch = cleanup.patchFromResult(res, 3, w, h, p.mask.mask);
      p.ms = Math.round((Date.now() - t0) / plans.length); p.cost = 0.02 / plans.length;
    }
  }

  /** Durdur düğmesi: adımlar arasında kontrol edilir; yarım kalan adım tamamlanır, sonraki başlamaz. */
  checkCancel() {
    if (!this.cancelRequested) return;
    const e = new Error("Kullanıcı durdurdu — sonraki adımlar çalıştırılmadı.");
    e.cancelled = true;
    throw e;
  }

  // ------------------------------------------------------------------ DİZGİ
  async typeset(scope, opts) {
    return this.run("Yalnızca Dizgi", async () => {
      if (scope === "chapter") return this.forChapter("typeset", opts);
      const t = this.captureTarget();
      return this._typesetPage(t, scope, opts || {});
    });
  }

  styleLevels(state) {
    const prof = this.cfg(), ch = this.chapter(state);
    return [
      ch ? { level: "chapter", label: "Bölüm: " + ch.name, rules: ch.rules || [], base: ch.base || {} } : null,
      { level: "settings", label: "Ayarlar", rules: prof.rules || [], base: prof.base || {} },
    ];
  }

  pageStats(state) {
    const fs = state.items.map((i) => i.ocr && i.ocr.fontsize).filter(Boolean);
    return { medianFont: classify.median(fs) || 20 };
  }

  resolveFor(state, item) {
    const r = resolveStyle(item, this.styleLevels(state), this.pageStats(state));
    this.applyOriginalLook(item, r);
    r.style.uppercaseSource = item.source; // büyük harfte çevrilmemiş isimler Türkçe i→İ kuralına girmesin
    // Eksik font / glif → yedek font
    const fc = this.settings.fontChecks || {};
    const installed = this.fontSet();
    const want = r.style.font;
    const missingFont = installed && want && !installed.has(want);
    const missingGlyph = fc[want] && fc[want].missing && fc[want].missing.length;
    if ((missingFont || missingGlyph) && r.style.fallbackFont && r.style.fallbackFont !== want) {
      r.warnings = [(missingFont ? `"${want}" fontu kurulu değil` : `"${want}" fontunda eksik glif: ${fc[want].missing.join(" ")}`) + ` → yedek "${r.style.fallbackFont}"`];
      r.style.font = r.style.fallbackFont;
      r.sources.font = { level: "fallback", label: "Yedek font" };
    }
    return r;
  }

  /**
   * Hiçbir kural/manuel değer yoksa ("Varsayılan" kaynaklı alanlar), orijinal yazının görünümünü taklit et:
   * Torii/OCR'ın verdiği yazı rengi, kontur rengi ve kalınlığı; SFX için büyük, kalın, büyük harf;
   * türe uygun kurulu çizgi roman fontu.
   */
  applyOriginalLook(item, r) {
    const st = r.style, src = r.sources;
    const isDef = (k) => !src[k] || src[k].level === "default";
    const orig = { level: "ocr", label: "Orijinal görünüm" };
    const o = item.ocr || {};
    const art = item.type === "sfx" || item.type === "offbubble";
    if (art && isDef("strokeEnabled") && o.strokeColor && (o.strokeWidth > 0 || o.strokeColor)) {
      st.strokeEnabled = true; src.strokeEnabled = orig;
      if (isDef("strokeColor")) { st.strokeColor = o.strokeColor; src.strokeColor = orig; }
      if (isDef("strokeSize")) { st.strokeSize = Math.max(2, Math.round((o.strokeWidth || 6) / 2)); src.strokeSize = orig; }
    }
    // SFX / balon dışı: çeviri orijinal yazının boyunun %60'ından küçük dizilmez (elle değer hariç) — "Ah!" minicik kalmasın
    if (art && o.fontsize && !(src.minSizePx && src.minSizePx.level === "manual")) {
      const floor = Math.round(o.fontsize * 0.6);
      if (!st.minSizePx || st.minSizePx < floor) { st.minSizePx = floor; src.minSizePx = orig; }
      if (st.maxSizePx && st.maxSizePx < st.minSizePx) st.maxSizePx = Math.round(st.minSizePx * 1.6);
    }
    if (item.type === "sfx") {
      const boxH = (item.box && Math.min(item.box.w, item.box.h)) || 60;
      if (isDef("maxSizePx")) { st.maxSizePx = Math.max(64, Math.round(boxH * 0.9)); src.maxSizePx = orig; }
      if (isDef("minSizePx")) { st.minSizePx = Math.max(18, Math.round(((o.fontsize) || 30) * 0.7)); src.minSizePx = orig; } // orijinal SFX boyunun %70'i altına inmez
      if (isDef("fauxBold")) { st.fauxBold = true; src.fauxBold = orig; }
      if (isDef("uppercase")) { st.uppercase = true; src.uppercase = orig; }
      if (isDef("paddingPct")) { st.paddingPct = 2; src.paddingPct = orig; }
    }
    if (isDef("font")) {
      const fs = this.fontSet();
      const cands = item.type === "sfx"
        ? ["CCWildWords-BoldItalic", "BadaBoomBB", "BadaBoomPro-BB", "Bangers-Regular", "KomikaAxis", "Komika-Axis", "LeagueGothic-Regular", "Impact", "Arial-BlackMT", "Arial-BoldMT"]
        : ["CCWildWords-Roman", "CCWildWords-Regular", "WildWordsRoman", "WildWords", "AnimeAce2.0BB", "AnimeAceBB", "CCMeanwhile-Regular", "KomikaText", "Komika-Text", "ComicNeue-Regular", "ComicSansMS", "ArialMT"];
      const pick = fs ? cands.find((c) => fs.has(c)) : null;
      if (pick) { st.font = pick; src.font = { level: "default", label: "Varsayılan (türe göre kurulu font)" }; }
    }
  }

  fontSet() {
    if (this._fonts) return this._fonts;
    try { this._fonts = new Set(app.fonts.map((f) => f.postScriptName)); } catch (e) { this._fonts = null; }
    return this._fonts;
  }

  /** Dizgi kutusu: kaynak kutudan türetilir. Dikey (JA/ZH/KO) kaynaklarda yatay Türkçe için genişletilir. */
  typesetBox(item) {
    const b = item.box || geom.polygonToBox(item.polygon);
    const box = { cx: b.cx, cy: b.cy, w: b.w, h: b.h, angle: item.type === "sfx" ? b.angle || 0 : 0 };
    if (item.direction === "top_to_bottom") { box.w = Math.max(b.w, b.h * 0.6); box.h = Math.max(b.h, box.w * 0.6); box.angle = 0; }
    // Balon bulunduysa: yazı balonun ORTASINA, balonun içine sığan (elips için ~%70) kutuya yerleşir
    const bub = item.bubble;
    if (bub && !bub.shared && (item.type === "dialog" || item.type === "narration")) {
      box.cx = bub.cx; box.cy = bub.cy;
      const k = bub.rectangular ? 0.86 : 0.70; // dikdörtgen kutu daha fazla alan verir
      box.w = Math.max(b.w * 0.9, bub.w * k);
      box.h = Math.max(b.h * 0.9, bub.h * k);
      box.w = Math.min(box.w, bub.w * 0.86); box.h = Math.min(box.h, bub.h * 0.86);
      box.angle = 0;
    }
    if (item.manualBox) Object.assign(box, item.manualBox);
    box.w = Math.max(box.w, 24); box.h = Math.max(box.h, 16);
    return box;
  }

  async _typesetPage(t, scope, opts) {
    const s = this.store.session(t.docId);
    let items = (await this.scopeItems(scope, t)).filter((i) => this.filtersAllow(i) && (i.translation || "").trim());
    if (!items.length) { this.hooks.notify("Dizgi yapılacak çevrilmiş öğe yok.", "info"); return null; }
    const warnings = [];
    // Kurulu çizgi roman fontu yoksa (yalnız Arial / Comic Sans) bir kez öneri ver
    const fset = this.fontSet();
    if (fset && !["CCWildWords-Roman", "CCWildWords-Regular", "WildWordsRoman", "WildWords", "AnimeAce2.0BB", "AnimeAceBB", "CCMeanwhile-Regular", "KomikaText", "Komika-Text", "ComicNeue-Regular", "Bangers-Regular", "BadaBoomBB"].some((f) => fset.has(f))) {
      warnings.push("Kurulu çizgi roman fontu yok → Arial kullanıldı. Öneri: ücretsiz \"Comic Neue\" veya \"Bangers\" (Google Fonts) ya da \"Anime Ace\" (Blambot) kurup Photoshop'u yeniden başlatın");
    }
    return this.applyOrDefer(t, "Dizgi", async (sess) => {
      let okCount = 0;
      await modal("Dizgi", async () => {
        const g = await this.ensureStructure(t);
        for (let k = 0; k < items.length; k++) {
          const it = items[k];
          this.progress(`Dizgi ${k + 1}/${items.length}`, k / items.length);
          try { await this.typesetItem(sess, t, g, it, opts, warnings); okCount++; }
          catch (e) { warnings.push(`#${it.order}: ${e.message}`); log("error", "Dizgi öğe hatası", String(e.message)); }
        }
        await this.persistInModal(sess);
      }, { documentID: t.docId, historyName: `Dizgi (${items.length} öğe)` });
      this.store.touch(sess.docId, { reason: "typeset", noPersist: true });
      const over = items.filter((i) => i.overflow).length;
      this.hooks.notify(`${okCount === items.length ? "Dizgi" : "Dizgi EKSİK"}: ${okCount}/${items.length} katman.${over ? ` ${over} öğe minimum puntoda bile taşıyor (⚠ işaretli).` : ""}${warnings.length ? " Uyarılar: " + warnings.slice(0, 4).join(" | ") : ""}`, over || warnings.length || okCount < items.length ? "warn" : "ok");
      return items.length;
    });
  }

  /** Tek öğe: katman yoksa oluştur, varsa güncelle. Photoshop'taki elle değişiklikler manuel değer olarak korunur. */
  async typesetItem(sess, t, g, it, opts, warnings) {
    const doc = getDoc(t.docId);
    const P = this.debug ? (this._prof = this._prof || {}) : null; // geliştirici: adım süreleri
    const tm = async (k, f) => { if (!P) return f(); const t0 = Date.now(); try { return await f(); } finally { P[k] = (P[k] || 0) + Date.now() - t0; } };
    // Önce Photoshop'ta yapılmış elle değişiklikleri yakala (manuel değer olur), SONRA stili çözümle
    let curBefore = null;
    if (it.layerId != null && findLayer(doc, it.layerId)) {
      curBefore = await text.readTextLayer(t.docId, it.layerId);
      // Rasterleştirilmiş SFX (metin olmayan katman): dokunulmaz — metin işlemleri hata verirdi
      if (curBefore && curBefore.notText) { it.status.typeset = true; return; }
      if (curBefore) this.captureManualEdits(it, curBefore);
    }
    const r = this.resolveFor(sess.state, it);
    if (r.warnings) warnings.push(...r.warnings.map((w) => `#${it.order}: ${w}`));
    const st = r.style;
    it.appliedSources = r.sources;
    const box = this.typesetBox(it);
    const exists = it.layerId != null && findLayer(doc, it.layerId);
    if (!exists) {
      const lid = await tm("create", () => text.createTextLayer(t.docId, g.trans, it.translation, box, st, `#${it.order} ${it.translation.slice(0, 30)}`));
      it.layerId = lid;
      await tm("effects", () => this.applyEffects(t, lid, st, warnings, it, true));
      if (st.warpStyle && st.warpStyle !== "warpNone") await text.setWarp(t.docId, lid, st.warpStyle, st.warpBend);
      // Elle punto verilmişse sığdırma onu ezmez (var olan katmandaki davranışla aynı); yazı kutunun ortasına alınır
      if (st.fit && !it.manual.sizePx) await tm("fit", () => this.fitItem(t, it, st, box));
      else if (it.manual.sizePx) await text.moveCenterTo(t.docId, lid, box.cx, box.cy);
    } else {
      const cur = curBefore || (await text.readTextLayer(t.docId, it.layerId));
      const desired = st.uppercase ? text.trUpper(it.translation, it.source) : it.translation;
      if (!it.locks.text && cur.contents !== desired) await text.setContents(t.docId, it.layerId, it.translation, st.uppercase, it.source);
      if (!it.locks.style) {
        const diff = {};
        for (const f of ["font", "color", "tracking", "align", "fauxBold", "fauxItalic"]) if (st[f] != null && cur[f] !== st[f]) diff[f] = st[f];
        if (!st.fit && st.sizePx && Math.abs((cur.sizePx || 0) - st.sizePx) > 0.4) diff.sizePx = st.sizePx;
        if (st.leadingPct != null && cur.leadingPct !== st.leadingPct) diff.leadingPct = st.leadingPct;
        if (Object.keys(diff).length) await text.applyStyle(t.docId, it.layerId, diff);
        await this.applyEffects(t, it.layerId, st, warnings, it);
      }
      if (!it.locks.position && st.fit && !it.manual.sizePx) await this.fitItem(t, it, st, box);
    }
    it.lastApplied = await tm("snapshot", () => this.snapshotLayer(t, it.layerId));
    it.status.typeset = true;
  }

  async fitItem(t, it, st, box) {
    const res = await text.fitToBox(t.docId, it.layerId, box, { minPx: st.minSizePx, maxPx: st.maxSizePx, paddingPct: st.paddingPct, leadingPct: st.leadingPct, prof: this.debug ? (this._prof = this._prof || {}) : null });
    it.overflow = res.overflow;
    it.fitSizePx = res.sizePx;
  }

  async applyEffects(t, layerId, st, warnings, it, fresh) {
    // Yeni katmanda efekt yoktur: istenmiyorsa okumaya gerek yok (öğe başına bir Photoshop çağrısı az)
    if (fresh && !st.strokeEnabled && !st.shadowEnabled) return;
    const cur = await text.readStrokeShadow(t.docId, layerId);
    const want = { strokeEnabled: !!st.strokeEnabled, shadowEnabled: !!st.shadowEnabled };
    if (cur.strokeEnabled === want.strokeEnabled && cur.shadowEnabled === want.shadowEnabled && (!want.strokeEnabled || (cur.strokeSize === st.strokeSize && cur.strokeColor === st.strokeColor))) return;
    try {
      await text.setStrokeShadow(t.docId, layerId, { strokeEnabled: want.strokeEnabled, strokeSize: st.strokeSize, strokeColor: st.strokeColor, shadowEnabled: want.shadowEnabled, shadowColor: st.shadowColor, shadowDistance: st.shadowDistance, shadowSize: st.shadowSize });
    } catch (e) { warnings.push(`#${it.order}: kontur/gölge uygulanamadı (${e.message})`); }
  }

  async snapshotLayer(t, layerId) {
    const cur = await text.readTextLayer(t.docId, layerId);
    const fx = await text.readStrokeShadow(t.docId, layerId);
    return Object.assign({ font: cur.font, sizePx: cur.sizePx, color: cur.color, tracking: cur.tracking, align: cur.align, leadingPct: cur.leadingPct, fauxBold: cur.fauxBold, fauxItalic: cur.fauxItalic, contents: cur.contents, angle: cur.angle, bounds: cur.bounds }, { strokeEnabled: fx.strokeEnabled, shadowEnabled: fx.shadowEnabled });
  }

  captureManualEdits(it, cur) {
    const la = it.lastApplied;
    if (!la || !cur) return;
    let styleChanged = false;
    for (const f of ["font", "color", "tracking", "align", "fauxBold", "fauxItalic", "leadingPct"]) {
      if (la[f] !== undefined && cur[f] !== la[f]) { it.manual[f] = cur[f]; styleChanged = true; }
    }
    if (la.sizePx && Math.abs((cur.sizePx || 0) - la.sizePx) > 0.6) { it.manual.sizePx = cur.sizePx; styleChanged = true; }
    const textChanged = la.contents !== undefined && cur.contents !== la.contents;
    // Katmandaki metin panelin zaten yazacağı metinse (ör. BÜYÜK HARF kuralıyla çevrilmiş hali) elle düzenleme sayılmaz
    if (textChanged && !it.locks.text && !text.matchesTranslation(cur.contents, it.translation, it.source)) {
      it.translation = cur.contents; it.translationEdited = true;
    }
    // Konum kilidi yalnızca yazı ve biçim AYNIYKEN sınır kaydıysa: metin/punto/font değişince mürekkep sınırı kendiliğinden
    // değişir; bu "kullanıcı taşıdı" demek değildir (yoksa öğe gereksiz kilitlenir ve yeni metin balona sığdırılmaz).
    if (!textChanged && !styleChanged && la.bounds && cur.bounds && (Math.abs(la.bounds.left - cur.bounds.left) > 1 || Math.abs(la.bounds.top - cur.bounds.top) > 1)) {
      it.locks.position = true; // kullanıcı tuvalde taşıdı → konum korunur
    }
  }

  // ------------------------------------------------------------------ TAM İŞLEM
  async full(scope, opts) {
    return this.run("Tam İşlem", async () => {
      if (scope === "chapter") return this.forChapter("full", opts);
      const t = this.captureTarget();
      return this._fullPage(t, scope, opts || {});
    });
  }

  /** Sayfayı sıfırla: öğeler + eklentinin oluşturduğu çeviri/temizlik katmanları silinir, önbellekteki Torii yanıtı unutulur. */
  async resetPage(t, keepLocked) {
    const s = this.store.session(t.docId);
    const doc = getDoc(t.docId);
    const isLocked = (i) => i.locks && (i.locks.text || i.locks.style || i.locks.position);
    const victims = s.state.items.filter((i) => !(keepLocked && isLocked(i)));
    await modal("Baştan başla", async () => {
      const ids = new Set();
      for (const it of victims) for (const id of [it.layerId, it.cleanLayerId, it.sourceTextLayerId]) if (id != null) ids.add(id);
      for (const id of ids) if (findLayer(doc, id)) await docs.deleteLayer(t.docId, id);
      s.state.items = s.state.items.filter((i) => !victims.includes(i));
      s.state.items.forEach((x, i) => { x.order = i + 1; });
      s.state.orderEdited = false;
      await this.persistInModal(s);
    }, { documentID: t.docId, historyName: "Tam İşlem: sayfa sıfırlandı" });
    if (this.lastInpainted && this.lastInpainted.docUid === t.docUid) this.lastInpainted = null;
    this.store.selected = new Set();
    this.store.touch(t.docId, { noPersist: true });
    return victims.length;
  }

  async _fullPage(t, scope, opts) {
    const s = this.store.session(t.docId);
    const ui = this.settings.ui;
    let needDetect = !s.state.items.length || scope === "region";
    // Tam İşlem = HER ŞEY BAŞTAN. Sayfa kapsamında eski öğeler ve eklenti katmanları silinir.
    if (scope === "page" && s.state.items.length) {
      needDetect = true; // kilitli öğeler kalsa da sayfa yeniden okunur (birleştirmede kilitliler korunur)
      // Onay sorulmaz (tam otomatik). Kilitli öğeler korunur; Ctrl+Z ile tek adımda geri alınabilir.
      const locked = s.state.items.filter((i) => i.locks && (i.locks.text || i.locks.style || i.locks.position)).length;
      const n = await this.resetPage(t, locked > 0);
      this.hooks.notify(`${n} öğe ve katmanları silindi${locked ? ` (kilitli ${locked} öğe korundu)` : ""}; baştan başlanıyor…`, "info");
      this.progress("Sayfa sıfırlandı, baştan başlanıyor…", 0);
    } else if ((scope === "selected" || scope === "region") && !opts.noForce) {
      // Seçili öğeler / bölge: tüm adımlar zorla yeniden
      if (scope === "region") await this._detectPage(t, true);
      await this._translatePage(t, scope, { force: true });
      await this._cleanPage(t, scope, { force: true });
      await this._typesetPage(t, scope, {});
      return true;
    }
    const allTypes = ui.filters.dialog && ui.filters.narration && ui.filters.offbubble && ui.filters.sfx;
    // Varsayılan: Modüler (OCR 1 + çeviri ≥1 + inpaint 0,02 kredi). Tek istek (v2/upload) ölçümde sayfa başına 6–8,4 kredi.
    const single = scope === "page" && !s.state.items.length && allTypes && !ui.bubblesOnly && ui.fullMode === "single";
    this.runMode = single ? "tek istek" : "modüler";
    if (single) return this._fullSingleRequest(t);
    if (needDetect) await this._detectPage(t, scope === "region");
    this.checkCancel();
    if (ui.bubblesOnly) {
      const unconfirmed = s.state.items.filter((i) => i.type === "dialog" && !i.typeConfirmed);
      if (unconfirmed.length) {
        // Tam otomatik: önerilen diyaloglar kendiliğinden onaylanır (listeden sonradan düzeltilebilir)
        unconfirmed.forEach((i) => { i.typeConfirmed = true; });
        this.hooks.notify(`${unconfirmed.length} diyalog önerisi otomatik onaylandı.`, "info");
      }
    }
    await this._translatePage(t, scope === "region" ? "region" : scope, {});
    this.checkCancel();
    await this._cleanPage(t, scope, {});
    this.checkCancel();
    await this._typesetPage(t, scope, {});
    return true;
  }

  /** Tek istek: v2/upload (dosya) → inpainted + text[]; temizlik, yalnızca öğe bölgelerindeki farkla uygulanır. */
  async _fullSingleRequest(t) {
    const s = this.store.session(t.docId);
    const prof = this.cfg(), ch = this.chapter(s.state);
    const area = { left: 0, top: 0, right: t.w, bottom: t.h };
    this.progress("Görüntü okunuyor…", 0.05);
    const img = await this.readOriginalArea(t, area);
    const bytes = png.encodePng(img.data, img.width, img.height, 3, 4);
    this.progress("Torii görsel çeviri…", 0.25);
    const byok = await this.byok();
    const opts = {
      target_lang: prof.targetLang || "tr", source_langs_whitelist: conf.sourceWhitelist(prof), translator: prof.translator, reasoning_effort: prof.reasoning,
      custom_prompt: conf.buildCustomPrompt(prof, ch), context: conf.buildContext(prof, ch, s.state.chainContext || (ch && ch.chainContext) || ""),
      min_font_size: 10,
    };
    // Ücretli yanıt önbelleği: aynı görsel + aynı seçenekler → önceki yanıt (kredi harcanmaz)
    const j = await this.withPaidRequest("Görsel çeviri", () => this.client.translateImage({ bytes, mime: "image/png", width: img.width, height: img.height }, Object.assign({ byok }, opts)),
      `img|${bytesKey(bytes)}|${JSON.stringify(opts)}|${byok ? byok.provider : ""}`);
    if (!j || !Array.isArray(j.text)) throw new Error("Torii görsel çeviri yanıtında metin listesi yok (kredi harcanmış olabilir; yanıt önbellekte, tekrar denemek ücretsiz).");
    const incoming = classify.itemsFromUpload(j.text, { left: 0, top: 0, scale: 1 });
    incoming.forEach((i) => { i.translation = conf.applyTurkishFixes(i.translation, prof.turkish); });
    this.progress("Temizlenmiş görsel çözülüyor…", 0.5);
    const inp = j.inpainted ? await this.decodeImage(j.inpainted, "Temizlenmiş görsel (inpainted)") : null;
    if (inp && (inp.width !== t.w || inp.height !== t.h)) throw new Error("Temizlenmiş görsel boyutu belgeyle uyuşmuyor.");
    // Türler: temizlenmiş görselde zemine bakarak (yazı silinmiş olduğundan balon içi net görünür)
    if (inp) this.refineTypes(incoming, { data: inp.channels === 3 ? inp.data : png.convertChannels(inp.data, inp.width, inp.height, inp.channels, 3), width: inp.width, height: inp.height, bounds: { left: 0, top: 0 } }, true, { W: t.w, H: t.h });
    this.lastInpainted = { docUid: t.docUid, img, inp }; // "Temizliği yeniden uygula" için (kredisiz)
    const result = await this.applyOrDefer(t, "Tam işlem sonuçları", async (sess) => {
      const merged = classify.mergeDetections(sess.state.items, incoming);
      sess.state.items = merged.items;
      this.reorderByReading(sess);
      if (j.context) { sess.state.chainContext = j.context; if (ch) ch.chainContext = j.context; }
      this._lastTranslatedImage = j.image || null;
      if (inp) await this.applyInpaintedDiff(sess, t, img, inp, sess.state.items);
      pushHistory(sess.state, { op: "full-single", n: incoming.length, credits: j.metadata && j.metadata.credits_used });
      this.store.touch(sess.docId, { reason: "full", noPersist: true });
      return merged;
    });
    if (result) await this._typesetPage(t, "page", {}); // aynı hedef: o an etkin olan başka bir belgeye dizilmez
    const sNow = this.store.session(t.docId), elig = sNow ? sNow.state.items.filter((i) => this.filtersAllow(i)) : [];
    const notClean = elig.filter((i) => !i.status.cleaned).length, notSet = elig.filter((i) => !i.status.typeset).length;
    const cr = j.metadata && j.metadata.credits_used != null ? ", " + j.metadata.credits_used + " kredi" : "";
    if (notClean || notSet) this.hooks.notify(`Tam işlem EKSİK: ${elig.length} öğe${cr}. ${notClean ? notClean + " öğe temizlenemedi (Torii silmedi, yazı maskesi bulunamadı) — listede T işaretsiz; seçip 2 · Temizle ile tekrar deneyin. " : ""}${notSet ? notSet + " öğe dizilemedi." : ""}`, "warn");
    else this.hooks.notify(`Tam işlem: ${elig.length} öğe temizlendi ve dizildi${cr}.`, "ok");
    return result;
  }

  /**
   * Torii'nin temizlenmiş (inpainted) görselini öğe öğe uygular.
   * Torii'nin x/y/w/h kutusu ÇEVİRİNİN kutusudur; orijinal yazı daha geniş olabilir. Bu yüzden:
   *  1) öğe çevresindeki geniş bölgede orijinal↔temizlenmiş farkı bulunur,
   *  2) harfler satır/kelime halinde birleştirilir (genişletme),
   *  3) yalnızca öğenin çekirdeğine BAĞLI fark parçaları maskeye alınır,
   *  4) filtre dışı öğelerin (ör. Sadece Balonlar'da SFX) çekirdekleri hiçbir maskeye girmez.
   */
  async applyInpaintedDiff(sess, t, img, inp, items) {
    const docRect = { left: 0, top: 0, right: t.w, bottom: t.h };
    const eligible = items.filter((i) => this.filtersAllow(i));
    // Çizim üstü SFX'ler Torii yamasıyla DEĞİL, SFX yöntemiyle (Adobe / İçerik Duyarlı) temizlenir; harf maskesi buradan çıkarılır
    const sfxM = this.sfxMethod();
    const sfxOnArt = (it) => it.type === "sfx" && sfxM !== "torii" && !(it.bgStats && it.bgStats.uniform >= 0.75);
    const deferred = [];
    this._maskOverrides = this._maskOverrides || {};
    const blocked = items.filter((i) => !this.filtersAllow(i)).map((i) => geom.rectRound(geom.rectInflate(i.textBounds || i.bounds, 4, docRect)));
    await modal("Temizlik", async () => {
      const g = await this.ensureStructure(t);
      for (const it of eligible) {
        const fs = (it.ocr && it.ocr.fontsize) || 20;
        // Çekirdek: yazı kutusu (kopuk nokta/ünlem için fs*0.8 genişletilmiş) + varsa balonun iç alanı (balon içindeki HER yazı parçası temizlenir)
        const textCore = geom.rectRound(geom.rectInflate(it.textBounds || it.bounds, Math.max(4, fs * 0.8), docRect));
        let core = textCore;
        const bub = it.bubble && it.bubble.rect ? geom.rectRound(geom.rectInflate(it.bubble.rect, -Math.max(3, Math.min(it.bubble.w, it.bubble.h) * 0.04), docRect)) : null;
        if (bub && bub.right > bub.left && bub.bottom > bub.top) core = geom.rectUnion(core, bub);
        const reach = Math.max(fs * 2.2, Math.max(it.box.w, it.box.h) * 0.45);
        const a = geom.rectRound(geom.rectUnion(geom.rectInflate(it.textBounds || it.bounds, reach, docRect), bub ? geom.rectInflate(bub, 6, docRect) : null));
        const w = a.right - a.left, h = a.bottom - a.top;
        const o = new Uint8Array(w * h * 3), r = new Uint8Array(w * h * 3), d = new Uint8Array(w * h), ds = new Uint16Array(w * h);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          const si = (a.top + y) * t.w + a.left + x, di = (y * w + x) * 3;
          o[di] = img.data[si * 3]; o[di + 1] = img.data[si * 3 + 1]; o[di + 2] = img.data[si * 3 + 2];
          r[di] = inp.data[si * inp.channels]; r[di + 1] = inp.data[si * inp.channels + 1]; r[di + 2] = inp.data[si * inp.channels + 2];
          ds[y * w + x] = Math.abs(o[di] - r[di]) + Math.abs(o[di + 1] - r[di + 1]) + Math.abs(o[di + 2] - r[di + 2]);
        }
        // Uyarlanır eşik: çekirdek DIŞINDAKİ farkın %95 değeri ≈ JPEG gürültüsü. Eşik gürültünün üstünde; en az 20
        // (siyah zeminde koyu kırmızı yazı da yakalanır), en çok 60.
        const noise = [];
        for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) {
          const X = a.left + x, Y = a.top + y;
          if (X >= core.left && X < core.right && Y >= core.top && Y < core.bottom) continue;
          noise.push(ds[y * w + x]);
        }
        noise.sort((p, q) => p - q);
        const thr = Math.min(60, Math.max(20, (noise.length ? noise[Math.floor(noise.length * 0.95)] : 0) + 10));
        for (let i = 0; i < w * h; i++) if (ds[i] > thr) d[i] = 255;
        for (const b of blocked) { const k = geom.rectIntersect(b, a); if (!k) continue; for (let y = k.top; y < k.bottom; y++) for (let x = k.left; x < k.right; x++) d[(y - a.top) * w + (x - a.left)] = 0; }
        // Harfleri kelime/satır halinde birleştir; büyük SFX'te harf aralığı geniş olduğundan kutu boyutu da hesaba katılır
        const joinR = Math.max(2, Math.round(Math.max(fs * 0.32, Math.sqrt(it.box.w * it.box.h) * 0.07)));
        const joined = geom.dilate(d, w, h, joinR);
        // Çekirdekten taşma (flood fill) — öğeye bağlı parçalar
        const seen = new Uint8Array(w * h), q = new Int32Array(w * h);
        let qh = 0, qt = 0;
        for (let y = core.top - a.top; y < core.bottom - a.top; y++) for (let x = core.left - a.left; x < core.right - a.left; x++) {
          const i = y * w + x; if (joined[i] && !seen[i]) { seen[i] = 1; q[qt++] = i; }
        }
        while (qh < qt) {
          const i = q[qh++], x = i % w, y = (i / w) | 0;
          if (x > 0 && joined[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; q[qt++] = i - 1; }
          if (x < w - 1 && joined[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; q[qt++] = i + 1; }
          if (y > 0 && joined[i - w] && !seen[i - w]) { seen[i - w] = 1; q[qt++] = i - w; }
          if (y < h - 1 && joined[i + w] && !seen[i + w]) { seen[i + w] = 1; q[qt++] = i + w; }
        }
        let m = new Uint8Array(w * h);
        for (let i = 0; i < w * h; i++) if (d[i] && seen[i]) m[i] = 255;
        m = geom.dilate(m, w, h, 2);
        for (const b of blocked) { const k = geom.rectIntersect(b, a); if (!k) continue; for (let y = k.top; y < k.bottom; y++) for (let x = k.left; x < k.right; x++) m[(y - a.top) * w + (x - a.left)] = 0; }
        // Torii bu yazıyı SİLMEDİYSE (ör. çizim üstü SFX'e dokunmuyor): maskeyi yazının renginden çıkar, kendi yöntemimizle temizle
        // Karar YAZI çekirdeğine göre (balonun tamamına göre değil): yazı kutusunda neredeyse hiç fark yoksa Torii silmemiştir
        const coreLocal = { left: textCore.left - a.left, top: textCore.top - a.top, right: textCore.right - a.left, bottom: textCore.bottom - a.top };
        const coreArea = Math.max(1, (coreLocal.right - coreLocal.left) * (coreLocal.bottom - coreLocal.top));
        let inCore = 0;
        for (let y = coreLocal.top; y < coreLocal.bottom; y++) for (let x = coreLocal.left; x < coreLocal.right; x++) if (m[y * w + x]) inCore++;
        if (inCore < coreArea * 0.01) {
          // Balonda: renkten bağımsız balon içi mürekkep maskesi; balon dışında: yazı rengine göre maske
          const inBubble = it.bubble && it.bubble.rect && (it.type === "dialog" || it.type === "narration");
          const cm = inBubble ? geom.dilate(cleanup.bubbleInkMask(o, w, h, a, it.bubble, it.box), w, h, 2) : cleanup.colorTextMask(o, w, h, coreLocal, it.ocr && it.ocr.textColor, {
            joinR: Math.min(joinR, Math.max(3, Math.round(fs * 0.2))),
            strokeR: Math.max(3, Math.round(((it.ocr && it.ocr.strokeWidth) || 6) * 0.7)),
            // SFX harfleri kalın: ince çizim çizgilerini maskeden at
            openR: it.type === "sfx" ? Math.max(2, Math.round(fs * 0.06)) : 0,
          });
          for (const b of blocked) { const k = geom.rectIntersect(b, a); if (!k) continue; for (let y = k.top; y < k.bottom; y++) for (let x = k.left; x < k.right; x++) cm[(y - a.top) * w + (x - a.left)] = 0; }
          if (geom.maskCount(cm)) {
            log("info", `#${it.order}: Torii yazıyı silmemiş → renk maskesi (${geom.maskCount(cm)} px), kendi yöntemimizle temizlenecek`);
            this._maskOverrides[it.id] = { area: a, mask: cm, width: w, height: h };
            deferred.push(it.id);
          }
          continue;
        }
        if (this.debug) { this._lastMasks = this._lastMasks || {}; this._lastMasks[it.id] = { area: a, mask: m, width: w, height: h, thr }; } // yalnız geliştirici/test
        if (sfxOnArt(it)) { this._maskOverrides[it.id] = { area: a, mask: m, width: w, height: h }; deferred.push(it.id); continue; }
        const p = { item: it, area: a, mask: { mask: m, width: w, height: h }, patch: cleanup.patchFromResult(r, 3, w, h, m), decision: { method: "torii", reason: "Torii görsel çeviri temizliği; orijinal yazının tamamı (çeviri kutusu dışına taşan kısımlar dahil) maskelendi." } };
        await this.writeCleanPatch(sess, t, g, p);
      }
      await this.persistInModal(sess);
    }, { documentID: t.docId, historyName: "Temizlik (görsel çeviri)" });
    // SFX'ler: kesin harf maskesiyle SFX yöntemi (Adobe'ye geçişte onay sorulur)
    if (deferred.length) {
      this.progress(`SFX temizliği (${deferred.length}) — ${cleanup.METHODS[sfxM].label}`, 0);
      await this._cleanPage(t, "page", { itemIds: deferred, force: true });
    }
  }

  /** Son Tam İşlem'in temizlenmiş görselini KREDİSİZ yeniden uygula (aynı oturum, aynı belge). */
  async reapplyLastInpaint() {
    return this.run("Temizliği yeniden uygula", async () => {
      const t = this.captureTarget();
      const L = this.lastInpainted;
      if (!L || L.docUid !== t.docUid) throw new Error("Bu belge için bellekte temizlenmiş görsel yok (yalnızca bu oturumdaki son Tam İşlem). Seçili öğeleri 'Temizle' ile yeniden temizleyebilirsiniz.");
      const s = this.store.session(t.docId);
      await this.applyInpaintedDiff(s, t, L.img, L.inp, s.state.items);
      this.store.touch(t.docId, { noPersist: true });
      this.hooks.notify("Temizlik yeniden uygulandı (kredi harcanmadı).", "ok");
    });
  }

  // ------------------------------------------------------------------ BÖLÜM
  /** Bölümdeki sayfaları sırayla işler; bağlam (context) sayfadan sayfaya taşınır. */
  async forChapter(op, opts) {
    const a = activeDoc();
    const s = a && this.store.session(a.id);
    const ch = this.chapter(s && s.state);
    if (!ch) throw new Error("Kapsam 'Bölüm' seçili ama bu sayfa bir bölüme ait değil. Tek sayfa için üstten Kapsam › 'Sayfa' seçin ya da Bölüm sekmesinden bölüm oluşturun.");
    const pages = ch.pages.slice().sort((x, y) => x.index - y.index);
    const plan = [];
    for (const p of pages) {
      const sess = this.store.findByUid(p.docUid);
      const n = sess ? sess.state.items.filter((i) => this.filtersAllow(i)).length : "?";
      const single = op === "full" && this.settings.ui.fullMode === "single";
      const steps = op === "detect" ? [{ kind: "ocr" }] : op === "translate" ? [{ kind: "translate-texts" }] : op === "clean" ? [{ kind: "inpaint" }] : op === "full" ? (single ? [{ kind: "upload-image" }] : [{ kind: "ocr" }, { kind: "translate-texts" }, { kind: "inpaint" }]) : [];
      plan.push({ page: p, open: !!sess, n, est: estimateCredits(steps).min });
    }
    const total = plan.reduce((x, p) => x + p.est, 0);
    const rows = plan.map((p) => `${p.page.index}. ${p.page.title} — ${p.open ? p.n + " öğe" : "kapalı (açılacak)"} — ~${p.est} kredi`).join("<br>");
    const resetNote = op === "full" ? "<br><b>Tam İşlem her sayfayı baştan yapar:</b> mevcut öğeler ve eklenti katmanları silinir." : "";
    // Tam otomatik: onay yok, bilgi mesajı
    log("info", `Bölüm işlemi: ${pages.length} sayfa, tahmini en az ~${Math.round(total * 100) / 100} kredi${resetNote ? " (her sayfa baştan)" : ""}`, rows);
    this.hooks.notify(`Bölüm: ${pages.length} sayfa işleniyor (tahmini en az ~${Math.round(total * 100) / 100} kredi).`, "info");
    for (let k = 0; k < pages.length; k++) {
      this.checkCancel();
      const p = pages[k];
      let sess = this.store.findByUid(p.docUid);
      if (!sess) { await this.hooks.openPage(p); sess = this.store.findByUid(p.docUid); }
      if (!sess) { this.hooks.notify(`Sayfa açılamadı: ${p.title}`, "error"); continue; }
      await modal("Sayfaya geç", async () => { app.activeDocument = getDoc(sess.docId); }, {});
      // Bağlamı önceki sayfadan taşı
      if (ch.chainContext && !sess.state.chainContext) sess.state.chainContext = ch.chainContext;
      const t = this.captureTarget();
      this.progress(`Sayfa ${k + 1}/${pages.length}: ${p.title}`, k / pages.length);
      if (op === "detect") await this._detectPage(t, false);
      else if (op === "translate") await this._translatePage(t, "page", opts);
      else if (op === "clean") await this._cleanPage(t, "page", opts || {});
      else if (op === "typeset") await this._typesetPage(t, "page", opts || {});
      else if (op === "full") await this._fullPage(t, "page", Object.assign({}, opts, { resetConfirmed: true }));
    }
    return true;
  }

  // ------------------------------------------------------------------ Bul-değiştir
  /** Bölüm genelinde arama. Açık sayfalar canlı, kapalılar önbellekten. → [{docUid, title, itemId, order, before, after, locked}] */
  async findAll(query, replacement, opts) {
    opts = opts || {};
    const a = activeDoc();
    const s = a && this.store.session(a.id);
    const ch = this.chapter(s && s.state);
    const pages = ch ? ch.pages : s ? [{ docUid: s.state.docUid, title: s.title }] : [];
    const re = opts.regex ? new RegExp(query, opts.caseSensitive ? "g" : "gi") : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), opts.caseSensitive ? "g" : "gi");
    const out = [];
    for (const p of pages) {
      const sess = this.store.findByUid(p.docUid);
      const items = sess ? sess.state.items : ((await this.store.readMirror(p.docUid)) || { items: [] }).items;
      for (const it of items) {
        const field = opts.field === "source" ? it.source : it.translation;
        if (!field || !re.test(field)) continue;
        re.lastIndex = 0;
        // Düz metin aramasında "Değiştir" alanındaki $ işaretleri ($&, $1…) özel anlam taşımaz
        out.push({ docUid: p.docUid, title: p.title, open: !!sess, itemId: it.id, order: it.order, before: field, after: opts.regex ? field.replace(re, replacement) : field.replace(re, () => replacement), locked: !!(it.locks && it.locks.text) });
        re.lastIndex = 0;
      }
    }
    return out;
  }

  /** Önizlenen değişiklikleri uygular (kilitliler atlanır). Açık sayfalarda katman metni de güncellenir. */
  async applyReplacements(matches, field) {
    const byDoc = new Map();
    for (const m of matches) { if (m.locked) continue; if (!byDoc.has(m.docUid)) byDoc.set(m.docUid, []); byDoc.get(m.docUid).push(m); }
    let n = 0, skippedClosed = 0;
    for (const [docUid, ms] of byDoc) {
      const sess = this.store.findByUid(docUid);
      if (!sess) { skippedClosed += ms.length; continue; }
      const docId = sess.docId;
      await modal("Bul-değiştir", async () => {
        for (const m of ms) {
          const it = sess.state.items.find((i) => i.id === m.itemId);
          if (!it || it.locks.text) continue;
          if (field === "source") it.source = m.after;
          else {
            it.translation = m.after; it.translationEdited = true;
            if (it.layerId != null && findLayer(getDoc(docId), it.layerId)) {
              const st = this.resolveFor(sess.state, it).style;
              await text.setContents(docId, it.layerId, it.translation, st.uppercase, it.source);
              it.lastApplied = Object.assign({}, it.lastApplied, { contents: st.uppercase ? text.trUpper(it.translation, it.source) : it.translation }, text.layerBounds(docId, it.layerId));
            }
          }
          n++;
        }
        await this.persistInModal(sess);
      }, { documentID: docId, historyName: `Bul-değiştir (${ms.length})` });
      this.store.touch(docId, { noPersist: true });
    }
    return { n, skippedClosed };
  }
}

module.exports = { Pipeline, TargetChangedError };
