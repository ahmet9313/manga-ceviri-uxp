# Manga Çeviri Stüdyosu — Photoshop UXP eklentisi

Manga, manhwa ve webtoon sayfaları için **Torii API** tabanlı OCR, çeviri, temizlik ve düzenlenebilir dizgi paneli.
Arayüz Türkçe, varsayılan hedef dil `tr`. Manifest v5, Adobe UXP.

| | |
|---|---|
| Doğrulanan Photoshop | **27.11 (Photoshop 2026), Windows 11** — gerçek kabul testleri bu sürümde koşuldu |
| Manifestte beyan edilen en düşük sürüm | 25.0 (Imaging API, `putLayerMask`, `getSelection` gerektirir; 25.x–26.x **test edilmedi**) |
| Ana motor | Torii resmi API (`https://api.toriitranslate.com`) — OCR, çeviri, varsayılan temizlik |
| İsteğe bağlı | Adobe İçerik Duyarlı Dolgu (yerel), Üretken Dolgu (Photoshop arayüzüne devir), Firefly Services (sunucu vekili) |

---

## 1. Kurulum (UXP Developer Tool ile — önerilen)

1. Photoshop 2026'yı açın.
2. **Adobe UXP Developer Tools**'u açın (Creative Cloud › Tüm uygulamalar › UXP Developer Tools).
3. Photoshop'ta *Tercihler › Eklentiler › "Geliştirici Modunu Etkinleştir"* açık olmalı (UDT ilk açılışta da sorar).
4. UDT'de **Add Plugin** → bu klasördeki `manifest.json` dosyasını seçin.
5. Listede "Manga Çeviri Stüdyosu" satırında **••• › Load** (veya **Load**). Panel Photoshop'ta *Eklentiler › Manga Çeviri* altında açılır.
6. Kod değiştirdiyseniz **Reload**; hata ayıklama için **Debug** (konsolda `MCS` nesnesi erişilebilir).

### İmzalı .ccx paketi

- `tools\package-ccx.ps1` çalıştırınca `dist\manga-ceviri-studio-1.0.0.ccx` üretilir (kökte `manifest.json` olan geçerli ZIP).
- **Bu paket imzasızdır.** Adobe kurulum aracı (UPIA) bu makinede `status = -267` ile reddetti; çift tıklayarak kurulabilir bir paket için
  UDT'de **••• › Package** kullanın (UDT paketi imzalar). Dağıtım için Adobe Developer Distribution gerekir.

## 2. API yapılandırması

### Torii (zorunlu)
1. https://toriitranslate.com/api sayfasından anahtar oluşturun (`sk_torii_…`). Anahtar yalnızca oluşturulduğunda tam gösterilir;
   panelde maskeli görünen `sk_torii_80n3F…BUfA` biçimi **çalışmaz**.
2. Panel › **Ayarlar** › *Torii API Anahtarı* → **Kaydet** → **Bağlantıyı Test Et** (kalan kredi ve anahtar adı görünür).
3. Anahtar **UXP Secure Storage**'da saklanır; ayar dosyasına, profil dışa aktarımına ve loglara yazılmaz (loglarda `sk_torii_****`).

Kullanılan uç noktalar (Kasım 2026 dokümanına göre):

| İşlem | Uç nokta | Not |
|---|---|---|
| Tespit / seçimi okut | `POST /api/v2/ocr` (`file`) | 1 kredi. Poligon, yön, güven, renkler (BGR → RGB çevrilir). Kırpma ofseti belgeye geri eşlenir. |
| Yalnızca çeviri | `POST /api/v2/upload` (`texts`) | Gönderim sırası = yanıt sırası; öğelerin sabit kimlikleriyle eşlenir. `custom_prompt` ≤1000, `context` son 10000 karakter. |
| Tam işlem (tek istek) | `POST /api/v2/upload` (`file`) | `text[].x/y` **merkez** olarak yorumlanır; `inpainted` yalnızca öğe bölgelerindeki farkla Temizlik katmanına yazılır. |
| Temizlik | `POST /api/inpaint` (`image`, `mask`) | 0,02 kredi. Aynı boyutta PNG + siyah-beyaz maske; sonuç yalnızca maske içine, ayrı katmana. |
| Kredi | `GET /api/credits` | Ücretsiz; bağlantı testi ve bakiye. |

- Hız sınırı: istekler arası ≥1 sn (kuyruk). 429/503 → üstel geri çekilme ile yeniden deneme (reddedilen istek ücretsizdir).
- **Belirsiz zaman aşımı** (bağlantı koptu/yanıt gelmedi): ücretli istek otomatik tekrar gönderilmez; panel kredi bakiyesini yeniden okuyup
  "kredi düştü → büyük olasılıkla işlendi" bilgisini gösterir ve sizden onay ister.
- Model: Torii'nin desteklediği listeden (Gemini 3.1 Flash Lite varsayılan, Gemini 3 / 3.8 Flash, GPT, Claude, DeepSeek, Grok, Kimi).
  **BYOK** (ör. kendi Gemini anahtarınız) Ayarlar'dan; anahtar Secure Storage'da, istek Torii üzerinden `x-byok-google` ile gider.

### Firefly Services (isteğe bağlı, sunucu tarafı)
Adobe kimlik bilgileri eklentiye girmez. `server/firefly-proxy.mjs` (Node 18+, bağımlılıksız):
```
set FIREFLY_CLIENT_ID=...
set FIREFLY_CLIENT_SECRET=...
node server\firefly-proxy.mjs        → http://127.0.0.1:8787
```
Panel › Ayarlar › *Vekil URL* → **Kaydet ve test et**. Farklı bir alan adı kullanacaksanız `manifest.json › requiredPermissions.network.domains`
listesine ekleyin. Vekil doğrulanmadıkça Firefly seçenekleri panelde "kurulum ister" olarak kapalı kalır.

## 3. Kullanım

**Üst bölüm:** geçerli belge · seri profili · işlem kapsamı (*Seçili bölge / Seçili öğeler / Sayfa / Bölüm*) · nesne filtresi
(*Diyalog, Anlatım, Balon dışı, SFX*) · **Sadece Balonlar**.
**Orta:** öğe listesi + seçili öğe editörü (dar panelde *Liste / Editör* geçişi). **Alt:** *Tespit Et, Yalnızca Temizle, Yalnızca Çevir, Yalnızca Dizgi, Tam İşlem*.

Tek sayfa akışı:
1. Sayfayı açın → **Tespit Et**. Öğeler okuma sırasıyla listelenir; tür önerisi gerekçesiyle gösterilir (kesik çerçeve = onaylanmamış).
2. Türleri düzeltin/onaylayın, kaynak metni düzeltin. Eksik balon: Photoshop'ta seçin → listede **Seçimi okut**.
3. **Yalnızca Çevir** → **Yalnızca Temizle** → **Yalnızca Dizgi** (veya **Tam İşlem**).
4. PSD'de üç grup oluşur: **Çeviri** (metin katmanları) › **Temizlik** (öğe başına maskeli yama) › **Orijinal** (dokunulmaz).

**Sadece Balonlar:** OCR tüm metinleri listeler; yalnızca **onaylanan diyalog balonları** çevrilir, temizlenir ve dizilir.
Kapsam eklentinin kendi filtresiyle uygulanır (Torii'nin `bubbles_only` alanına güvenilmez); SFX/anlatım/balon dışı pikseller değişmez.

**Düzenleme:** editörde çeviri, tür, ton, okuma sırası, kilitler (*Metin / Biçim / Konum*), tüm stil alanları (her alanın yanında
uygulanan kaynak: *Manuel · Bölüm · Seri · Genel · Varsayılan* ve kural adı), konum, **kutuyu boyutlandır** (yazı ölçeklenmez) ve
**katmanı ölçekle** (dönüşüm) ayrı ayrı. Sürükleme pedleri (✥ Taşı, ⟳ Döndür, ▭ Kutu) canlı önizler, bırakınca **tek** geçmiş adımı yazar,
`Esc`/odak kaybında başlangıca döner. Tuvalde asıl düzenleme için *PS dönüştür (Ctrl+T)* ve *Metin aracı* düğmeleri yerel araçlara geçer.

**Photoshop'ta elle değişiklik:** Metin aracıyla değiştirdiğiniz yazı ve biçim panele döner; toplu dizgi bunları **manuel değer** olarak
korur (kilit/manuel değer kaldırılana kadar). Karakter bazlı biçimler, başka bir alan değiştirilirken korunur.

**Liste sırası ≠ tuvalde taşıma ≠ katman sırası:** liste yalnızca ⋮⋮ tutamacından sürüklenir (kenarda otomatik kaydırma, bırakma çizgisi,
`Alt+↑/↓` klavye); katman sırası editördeki *Katman ↑/↓* ile değişir.

**Profiller ve kurallar (Profil sekmesi):** seri başına font, min/maks punto, satır/harf aralığı, hizalama, kontur, gölge, çeviri talimatı,
sözlük, karakter adları, hitap biçimi, temizlik tercihi. Kurallar kod yazmadan: *öğe türü + ton + koşullar → stil*, öncelik değeri en yüksek
eşleşme kazanır. "Örnek kural seti ekle" normal/bağırma/fısıltı/düşünce/SFX kurallarını oluşturur. Kopyala / içe aktar / dışa aktar.
**Glif testi** fontta `ÇĞİÖŞÜ çğıöşü` eksiklerini bulur; eksikse dizgide yedek font uygulanır. `â/Â → a/A` ayrı seçenektir.

**Bölüm sekmesi:** açık belgelerden veya klasörden bölüm; bölüm kuralları (serinin üstünde); bağlam sayfadan sayfaya taşınır;
**bul-değiştir** önizlemeli (kilitli öğeler atlanır). Bölüm kapsamında işlem öncesi sayfa listesi ve tahmini kredi gösterilir.

**Temizlik sekmesi:** *Otomatik* (düz balon → yerel dolgu; tram → Torii; çizim üstü SFX → Torii, Adobe önerisi yalnızca onayla),
*Torii Inpaint*, *Yerel düz dolgu*, *Adobe İçerik Duyarlı Dolgu*, *Üretken Dolgu (Photoshop arayüzü)*, *Firefly (sunucu)*.
Önizleme: Orijinal / Maske / Sonuç + yazı izi, çizgi kırılması, maske dışı değişen piksel, süre, kredi. **Nesne Kaldır** ve **Görsel Üret** ayrı.

**Araçlar sekmesi:** Photoshop Eylemleri (Actions) listeleme/çalıştırma, yerel araçlara geçiş, mevcut metin katmanından öğe, eşitleme,
**Canlı kabul testi** (gerçek Torii çağrılarıyla; rapor eklenti veri klasöründe `selftest-report.json`).

## 4. Kalıcılık
Öğe-katman eşleşmeleri, kilitler, manuel değerler, bağlam zinciri PSD'nin XMP'sine (`mct:state`) yazılır; **geçmiş adımı oluşturmaz**.
PSD kapatılıp açıldığında geri gelir. Katman kimlikleri PSD'de saklanır; tekrar çalıştırma var olan katmanı günceller.

## 5. Proje yapısı
```
manifest.json, index.html, index.js, styles.css, icons/
src/torii/client.js     Torii istemcisi (multipart, hız sınırı, geri çekilme, belirsiz zaman aşımı)
src/pipeline.js         Tespit/Temizle/Çevir/Dizgi/Tam işlem × kapsam × filtre, belge güvenliği, bölüm
src/ops.js              Editör işlemleri, PS↔panel eşitleme, tek adımlı sürükleme oturumu, Actions
src/ps/*                batchPlay/DOM sarmalayıcıları (PS 27.11'de doğrulanan tanımlayıcılar), metin, piksel, XMP
src/model/*             kurallar ve öncelik, profiller, sınıflandırma, temizlik analizi, durum deposu
src/ui/*                liste (tutamaçlı sıralama), editör, sekmeler, diyaloglar
server/firefly-proxy.mjs  Firefly Services vekili
tests/                  Photoshop içinde koşan testler (+ sonuçlar)
tools/package-ccx.ps1   .ccx paketleme
```

## 6. Testleri çalıştırma
Photoshop açıkken:
```
powershell -File tests\run-ps-test.ps1 -Name load         # tüm modüller yükleniyor mu
powershell -File tests\run-ps-test.ps1 -Name unit         # Torii istemcisi, eşleme, öncelik, PNG, maskeleme
powershell -File tests\run-ps-test.ps1 -Name acceptance   # gerçek belge üzerinde kabul testleri
```
Photoshop betik onayı sorabilir ("JavaScript dosyası yüklemek üzeresiniz" → Evet). Ayrıntılar: `TEST-RAPORU.md`.
