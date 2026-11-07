# Test Raporu — Manga Çeviri Stüdyosu 1.0.0

**Ortam:** Windows 11 Home 10.0.26200 · Photoshop 2026 **27.11** (20260929.r.26) · UXP Developer Tools kurulu · Node.js yok
**Test sayfası:** *turning-into-a-tentacle-monster-made-me-crazier* bölümünden 800×10000 px, 72 ppi RGB webtoon sayfası (`tests/assets/`)
**Tarih:** 7 Kasım 2026

## Nasıl test edildi
Eklentinin **gerçek modülleri** (`src/`) Photoshop UXP betiği (`.psjs`) içinden `require` edilerek gerçek Photoshop'ta, gerçek belge üzerinde
çalıştırıldı (`tests/run-ps-test.ps1`). Ham sonuçlar: `tests/results/*.json`.
Kısıt: Photoshop betiklerinde **ağ erişimi yok** ve panel açılamıyor; bu yüzden Torii çağrıları ve panel arayüzü bu yöntemle test edilemedi
(aşağıda "doğrulanamadı" bölümü).

---

## ✅ Başarıyla doğrulananlar (gerçek Photoshop 27.11)

### Kabul testleri — 17/17 geçti (`tests/results/acceptance.json`)
| # | Senaryo | Ölçülen sonuç |
|---|---|---|
| 1 | Orijinal / Temizlik / Çeviri grupları, doğru sıra; tekrar çalıştırmada yeni grup yok | Arka plan katmana çevrilip Orijinal'e taşındı |
| 2 | Otomatik yöntem: beyaz balon, renkli (gri) balon, tramlı zemin, çizim üstü SFX | 4 beyaz balon → **yerel dolgu**; gri gölgeli balon → Torii; sentetik tram → **tram (periyot 6 px)** → Torii; "SNAP" (çizim üstü) → Torii |
| 3 | **Sadece Balonlar** modunda SFX'in piksel olarak korunması | SFX bölgesinde değişen kanal değeri: **0**; SFX için katman oluşmadı; 4 diyalog dizildi |
| 4 | Temizlik maske dışını değiştirmez | Maske dışında değişen piksel **0**; maske içinde 18.835 / 31.523 piksel değişti (yazı silindi) |
| 5 | Tekrar çalıştırmada aynı öğeden ikinci katman oluşmaz | Çeviri 5→5, Temizlik 5→5 katman |
| 6 | Düzenlenebilir metin katmanları, kutu merkezi, sığdırma, Türkçe karakter | Hepsi paragraf metin katmanı; balon merkezine sapma 0 px (döndürülmüş SFX 44 px); taşma yok; "Xiaofei, ben önden çıkıyorum…" |
| 7 | Koşullu kural + uygulanan kuralın gösterimi | Bağırma → Impact, kaynak "Seri: Seri A · Bağırma A" |
| 8 | **Aynı sayfaya iki seri profili → doğru fontlar** | A: Arial / Impact; B: Times New Roman / Georgia Bold / Comic Sans Bold; A'ya dönüş doğru |
| 9 | Photoshop'ta elle değiştirilen metin+font toplu dizgide korunur | Metin ve font korundu, kaynak "Manuel" |
| 10 | Karakter bazlı biçim, başka alan değişirken korunur | Kırmızı aralık korundu (2 aralık) |
| 11 | **Kutu boyutlandırma ≠ katman ölçekleme** | Kutu 117→177 px, punto 40 sabit; ölçek %120 → görünür punto 48 |
| 12 | Sürükleme: canlı önizleme, **tek geçmiş adımı**, iptal → başlangıç | 12 hareket → 1 adım ("#5 taşı"); %8,33 zoom'da 36 CSS px → 432 belge px; iptal sonrası konum ve geçmiş aynı |
| 13 | Undo/Redo sonrası elle düzenlenen metin | Korundu, panel eşitlendi |
| 14 | **PSD kaydet → kapat → aç** | Öğe-katman eşleşmeleri, kilitler, manuel değerler geri geldi; yeniden açılmış belgede toplu dizgi elle düzenlemeyi ezmedi |
| 15 | **İş sürerken belge değişirse sonuç yanlış belgeye yazılmaz** | Sonuç bekletildi, diğer belgeye dokunulmadı, hedefe dönünce uygulandı; kapalı belgede bekletildi |
| 16 | Türkçe glif testi | Arial: eksik yok; Webdings: Ğ İ Ş ğ ı ş eksik tespit edildi |
| 17 | `â/Â → a/A` diğer Türkçe harfleri korur | "Hâlâ kâğıt ÂLEM ğüşıöç İ..." → "Hala kağıt ALEM ğüşıöç İ…" |

### Birim testleri — 11/11 geçti (`tests/results/unit.json`)
Torii `v2/upload` multipart alanları ve Bearer; `custom_prompt` 1000 / `context` son 10000 sınırı; BYOK başlığı; kredi başlığı;
429 → geri çekilme ile tekrar; **belirsiz zaman aşımında ücretli istek tekrar gönderilmiyor**; istekler arası ≥1 sn;
`text[].x/y` **merkez** → belge kutusu (kırpma ofsetiyle); OCR BGR→RGB, `removed` eleme, kırpma ofseti; aynı öğenin ikinci kez eklenmemesi;
stil önceliği manuel → bölüm → seri → genel → varsayılan ve en yüksek öncelikli kural; PNG gidiş-dönüş; loglarda anahtar maskeleme; zoom/DPI dönüşümü.

### Diğer doğrulamalar
- 26/26 modül Photoshop UXP çalışma ortamında yükleniyor (`load.json`).
- XMP'ye durum yazmak **geçmiş adımı oluşturmuyor** ve geri okunuyor (`xmphistory.json`).
- PS 27.11'de yoklanan tanımlayıcılar: `textClickPoint` her zaman yüzde; `textShape.bounds` punto (px×72/ppi, 72 ve 300 ppi'de);
  `textStyle` + `typeStyleOperationType:3` yalnız hedef özelliği değiştiriyor; DOM `characterStyle` ayarlayıcıları aralıkları koruyor;
  `imaging.putLayerMask/getLayerMask/putSelection/getSelection/getPixels/putPixels` çalışıyor; `removeTool` dahil yerel araç seçimi çalışıyor;
  Photoshop Eylemleri listeleniyor (7 set).

### Testlerde bulunan ve düzeltilen hatalar
- `typesetItem` stili, Photoshop'taki elle değişiklikleri yakalamadan önce çözümlüyordu → elle font eziliyordu (düzeltildi, test 9).
- Döndürme/ölçek `textShape[0].transform`'dan okunuyordu (her zaman birim) → `textKey.transform` (düzeltildi, test 11).
- Tram tespiti 3 px'lik noktalarda başarısızdı → otokorelasyon tabanlı periyot tespiti (düzeltildi, test 2).
- Async olmayan ok fonksiyonunda `await` (yükleme hatası), PS 27.11'de DOM `createLayer/createLayerGroup/createTextLayer/documents.add`'in
  `null` döndürmesi (batchPlay ile değiştirildi), batchPlay hatalarının sessizce dönmesi (artık istisna).

---

## ❌ Başarısız olanlar
| Özellik | Sonuç |
|---|---|
| `.ccx` kurulumu (UPIA) | Paket üretildi (`dist/manga-ceviri-studio-1.0.0.ccx`, kökte manifest), ancak Adobe kurulum aracı **`status = -267`** ile reddetti — büyük olasılıkla imzasız paket. İmzalı paket için UDT › Package gerekir. |
| Kontur/gölge (`set layerEffects`) **betik bağlamında** | Photoshop `-25920 "komut şu an kullanılabilir değil"` döndürdü. Panel bağlamında ayrıca doğrulanmalı (Canlı test bunu ölçer). Aynı hata katman maskesi için `make mask`'te de görüldü; maskeler bu yüzden `imaging.putLayerMask` ile yazılıyor (doğrulandı). |

## ⚠ Ortam eksikliği nedeniyle doğrulanamayanlar
| Özellik | Neden |
|---|---|
| **Gerçek Torii API çağrıları** (OCR, metin/görsel çeviri, inpaint, kredi) ve tam akış | Verilen anahtar maskeli (`sk_torii_80n3F…BUfA`), tam anahtar yok; ayrıca Photoshop betiklerinde ağ erişimi yok. İstek/yanıt biçimi dokümandaki örneklerle birim testlerinde doğrulandı. |
| Panel arayüzü: UDT ile yükleme, kenetli/yüzen, dar/geniş, fare/trackpad, Windows ölçekleri, liste tutamacıyla sürükleme, diyaloglar, uzun webtoon listesinde kaydırma | Panel betikten açılamıyor; GUI etkileşimi gerekiyor (bilgisayar kullanımdayken ekran otomasyonu yapılmadı). |
| Sürükleme pedinin panel içinden kullanımı | Mantık (tek adım, iptal, zoom dönüşümü) betikte doğrulandı; panel olayları doğrulanmadı. |
| Adobe İçerik Duyarlı Dolgu | Tanımlayıcı erken bir yoklamada hata kontrolü olmadan çalıştı; sonucu doğrulanmadı. |
| Üretken Dolgu / Kaldırma aracına devir | Adobe oturumu ve üretken kredi + kullanıcı etkileşimi gerekiyor. |
| Firefly Services vekili | Adobe sunucu kimlik bilgileri ve Node.js yok. |
| Bölüm işlemleri (çok dosya, sayfa açma), bölüm geneli bul-değiştir | Çok sayfalı bölüm senaryosu çalıştırılmadı. |
| Eylem (Action) **oynatma** | Listeleme doğrulandı, oynatma test edilmedi. |
| Gri tonlamalı belgeler, 16 bit, CMYK; Photoshop 25.x–26.x | Test edilmedi. |

## Sıradaki adım (canlı doğrulama)
1. UDT ile eklentiyi yükleyin (README §1), Ayarlar'a **tam** Torii anahtarını girip *Bağlantıyı Test Et*.
2. Test sayfasını açın → **Araçlar › Canlı kabul testi › Canlı testi başlat** (≈3–4 kredi; isteğe bağlı tam istek testi +≥1).
3. Rapor: `%APPDATA%\Adobe\UXP\PluginsStorage\PHSP\27\Developer\com.mangaceviri.studio\PluginData\selftest-report.json`
   (Torii OCR/çeviri/inpaint, Sadece Balonlar piksel koruması, panel bağlamında kontur/gölge, iki profil).
