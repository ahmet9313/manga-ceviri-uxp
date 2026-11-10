# Manga Çeviri Stüdyosu — Photoshop UXP eklentisi

Manga, manhwa ve webtoon sayfaları için **Torii API** tabanlı OCR, çeviri, temizlik ve düzenlenebilir dizgi paneli.
Arayüz Türkçe, varsayılan hedef dil `tr`. Manifest v5, Adobe UXP.

| | |
|---|---|
| Doğrulanan Photoshop | **27.11 (Photoshop 2026), Windows 11** — gerçek kabul testleri bu sürümde koşuldu |
| Manifestte beyan edilen en düşük sürüm | 25.0 (Imaging API, `putLayerMask`, `getSelection` gerektirir; 25.x–26.x **test edilmedi**) |
| Ana motor | Torii resmi API (`https://api.toriitranslate.com`) — OCR, çeviri, varsayılan temizlik |
| İsteğe bağlı | Adobe Üretken Dolgu (panelden otomatik), İçerik Duyarlı Dolgu (yerel), Firefly Services (sunucu vekili) |

---

## 1. Kurulum (UXP Developer Tool ile — önerilen)

1. Photoshop 2026'yı açın.
2. **Adobe UXP Developer Tools**'u açın (Creative Cloud › Tüm uygulamalar › UXP Developer Tools).
3. Photoshop'ta *Tercihler › Eklentiler › "Geliştirici Modunu Etkinleştir"* açık olmalı (UDT ilk açılışta da sorar).
4. UDT'de **Add Plugin** → bu klasördeki `manifest.json` dosyasını seçin.
5. Listede "Manga Çeviri Stüdyosu" satırında **••• › Load** (veya **Load**). Panel Photoshop'ta *Eklentiler › Manga Çeviri* altında açılır.
6. Kod değiştirdiyseniz **Reload**. UDT açık iken `powershell -File toolsDt.ps1 -Action load|reload` da yükler (tıklamasız).

### İmzalı .ccx paketi

- `tools\package-ccx.ps1` çalıştırınca `dist\manga-ceviri-studio-1.0.0.ccx` üretilir (kökte `manifest.json` olan geçerli ZIP).
- **Bu paket imzasızdır.** Adobe kurulum aracı (UPIA) bu makinede `status = -267` ile reddetti; çift tıklayarak kurulabilir bir paket için
  UDT'de **••• › Package** kullanın (UDT paketi imzalar). Dağıtım için Adobe Developer Distribution gerekir.

## 2. API yapılandırması

### Torii (zorunlu)
1. https://toriitranslate.com/api sayfasından anahtar oluşturun (`sk_torii_…`). Anahtar yalnızca oluşturulduğunda tam gösterilir;
   panelde maskeli görünen `sk_torii_abcde…wxyz` biçimi **çalışmaz**.
2. Panel › **Ayarlar** › *Torii API* → anahtarı yapıştırıp **Kaydet** (otomatik doğrulanır, kalan kredi görünür).
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

**Üst şerit:** belge adı ve durum özeti · kalan kredi (tıklayınca yenilenir) · seri profili · kapsam (*Seçili / Bölge / Sayfa / Bölüm*).
**Sekmeler:** Öğeler · Bölüm · Profil · Temizlik · Ayarlar (Log, Eylemler, BYOK, Firefly → *Ayarlar › Gelişmiş*).
**Alt şerit:** çalışırken adım adı + geçen süre + ilerleme + **■ Durdur** (Esc); sonuç satırı (süre, harcanan kredi, kullanılan yöntem);
adımlar **1 Tespit › 2 Temizle › 3 Çevir › 4 Dizgi**; tam genişlik **▶ Tam İşlem**; Tam İşlem modu ve son çalıştırmanın maliyeti.
Bir işlem sürerken diğer düğmeler kilitlidir (sekmeler ve görünüm değişebilir).

Tek sayfa akışı: sayfayı açın → **▶ Tam İşlem**. Sayfa her seferinde baştan işlenir (kilitli öğeler korunur; Ctrl+Z ile tek adımda geri alınır).
Adımları tek tek de çalıştırabilirsiniz. PSD'de üç grup: **Çeviri** (düzenlenebilir metin) › **Temizlik** (öğe başına maskeli katman) › **Orijinal** (dokunulmaz).

**Tam İşlem modu (Ayarlar):**
- *Modüler* (varsayılan): OCR 1 + çeviri ≥1 + çizim üstü inpaint 0,02 kredi. Düz zeminli kapalı balonlar balon rengiyle **kredisiz** yerel
  dolguyla temizlenir; balon içindeki her parça (kopuk nokta, taşan satır) dahil.
- *Tek istek*: Torii sayfayı kendisi çevirir ve temizler; gerçek ölçüm 800×10000 sayfada **6–8,4 kredi**.
- Ücretli her yanıt gelir gelmez önbelleğe yazılır; aynı istek tekrarlanırsa (ör. sonraki adım hata verdiyse) yeniden kredi harcanmaz.

**Temizlik yöntemleri (tamamen otomatik, sizden işlem istenmez):** düz balon → yerel dolgu; tramlı/renkli zemin → Torii Inpaint;
çizim üstü SFX → **Adobe Üretken Dolgu → (olmazsa) İçerik Duyarlı Dolgu → (olmazsa) Torii**. Hangi yöntemin neden kullanıldığı sonuç
satırında ve öğenin editöründe yazar. Her yöntemde sonuç ayrı katmanda ve yalnızca maske içinde görünür; maske dışı piksel değişmez.

**Sadece Balonlar:** yalnızca onaylanan diyalog balonları çevrilir, temizlenir ve dizilir; diğer türlerin pikselleri değişmez.

**Öğeler sekmesi:** tür çipleri (Diyalog yeşil · Anlatım sarı · Balon dışı mavi · SFX pembe) neyin işleneceğini seçer. Liste ↔ editör
arasındaki ayırıcı sürüklenir (bırakınca uygulanır; çift tık = varsayılan; ← →). Dar panelde *Liste / Editör* geçişi.
Klavye: ↑↓ gez · Alt+↑↓ sırala · Delete sil · Enter editör · Esc seçimi bırak. Sıralama yalnızca ⋮⋮ tutamacından sürüklenir.
Editör: çeviri/kaynak, tür, ton, sıra, kilitler; Biçim (her alanın kaynağı: Manuel · Bölüm · Seri · Genel · Varsayılan); Tuval (taşı/döndür/kutu
pedleri — bırakınca tek geçmiş adımı, Esc iptal); Katman ve temizlik (kullanılan yöntem ve nedeni).

**Photoshop'ta elle değişiklik:** metin aracıyla yaptığınız yazı/biçim değişiklikleri panele döner ve toplu dizgide **manuel değer** olarak korunur.

**Profil:** dil (kaynak dil seçilirse başka dildeki yazılar ne çevrilir ne silinir), okuma yönü, çeviri modeli, talimat, sözlük, karakterler,
taban stil, kurallar (*tür + ton + koşul → stil*), Türkçe düzeltme ve glif testi. Dışa aktarılan profil anahtar içermez.
**Bölüm:** açık belgelerden / klasörden bölüm, bölüm kuralları, sayfadan sayfaya bağlam, önizlemeli bul-değiştir.

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
tests/ps/               Photoshop içinde koşan testler · tests/logic/ Photoshop'suz mantık testleri
src/dev/                Geliştirici araçları (canlı test) — .ccx paketine girmez
tools/package-ccx.ps1   .ccx paketleme (yalnız çalışma zamanı dosyaları) · tools/udt.ps1 tıklamasız yükleme · tools/capture-ps.ps1 yalnız Photoshop penceresi görüntüsü
```

## 6. Testleri çalıştırma
Torii ve Adobe Üretken Dolgu çağrıları testlerde **her zaman sahtedir** (test düzeneği gerçek ağ isteğini ve gerçek Üretken Dolgu'yu engeller).
Testler yalnızca `MCS_` ile başlayan kendi kopyalarını açar ve bitince kapatır; sizin belgelerinize dokunmaz.

Photoshop gerektirmeyen mantık testleri (Bun):
```
bun tests/logic/bubble.test.js    # balon tespiti, balon içi mürekkep, tür
bun tests/logic/client.test.js    # Torii hata/zaman aşımı/geri çekilme davranışı
bun tests/logic/upper.test.js     # Türkçe büyük harf
```
Photoshop açıkken:
```
powershell -File tests\run-ps-test.ps1 -Name load         # tüm modüller yükleniyor mu
powershell -File tests\run-ps-test.ps1 -Name unit         # Torii istemcisi, eşleme, öncelik, PNG, maskeleme
powershell -File tests\run-ps-test.ps1 -Name refine       # tür, balon, temizlik izi, maske dışı piksel
powershell -File tests\run-ps-test.ps1 -Name chain        # SFX yedek zinciri (Üretken → İçerik Duyarlı → Torii), maske dışı korunuyor mu
powershell -File tests\run-ps-test.ps1 -Name acceptance   # kabul senaryoları
powershell -File tests\run-ps-test.ps1 -Name bench        # 800×10000 sayfada süre ölçümü (sahte Torii)
```
Diğerleri: `decode`, `reset`, `sfxclean`, `sfxnoerase`. Photoshop betik onayı ("JavaScript dosyası yüklemek üzeresiniz") yalnızca Photoshop'a
ait "Evet" düğmesine otomatik basılarak geçilir. Ayrıntılar ve sonuçlar: `TEST-RAPORU.md`, denetim: `DENETIM.md`.

> Not (Claude Code / VS Code terminali): ortamda `ELECTRON_RUN_AS_NODE=1` varsa UXP Developer Tools açılıp hemen kapanır;
> UDT'yi bu değişken olmadan başlatın.
