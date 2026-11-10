# Denetim — Manga Çeviri Stüdyosu (10.11.2026)

Kapsam: tüm kod (index.js, src/, tests/, tools/, server/). Kaynaklar: elle kod okuma, 2 otomatik inceleme iş akışı
(çekişmeli doğrulamalı hata incelemesi + alt sistem denetimi; kullanım sınırı nedeniyle kısmen tamamlandı), Photoshop 27.11'de
test paketleri, gerçek panel günlükleri (`UXPLogs_*.log`).

**Doğrulama sütunu:** `panel` = gerçek Photoshop panelinde çalıştırıldı · `betik` = Photoshop'ta .psjs testiyle (sahte Torii/Adobe) ·
`mantık` = Photoshop'suz Bun testi · `yok` = doğrulanamadı.

## 1. Özellikler ve kararlar

### Torii API
| Özellik | Amaç | Çalışıyor mu | Doğrulama | Karar | Gerekçe / yapılan |
|---|---|---|---|---|---|
| `POST /api/v2/upload` dosya (Tam İşlem tek istek) | OCR+çeviri+temizlik tek istekte | evet | panel (6,18–8,4 kr/sayfa) | İYİLEŞTİR | Varsayılan değil artık (pahalı). Yanıt doğrulaması + önbellek eklendi. |
| `POST /api/v2/ocr` | Tespit | evet | panel | İYİLEŞTİR | Yanıt önbelleğe yazılıyor; profil kaynak dili OCR sonucunu da filtreliyor. |
| `POST /api/v2/upload` texts | Yalnızca çevir | evet | betik | İYİLEŞTİR | Önbellek; sayım uyuşmazlığında kredi uyarısı. |
| `POST /api/inpaint` | Temizlik | evet (PNG döner) | panel | İYİLEŞTİR | Önbellek; yedek zincirde son halka. |
| `GET /api/credits`, `/api/keys` | Bakiye, bağlantı testi | evet | panel | KORU | Kredi rozeti tıklanınca, panel gösterilince ve her ücretli yanıtta (başlık) güncellenir. |
| Hız sınırı kuyruğu | 1 istek/sn | evet | betik | KORU | `minIntervalMs: 0` yok sayılıyordu → düzeltildi. |
| 429/503 geri çekilme | Ücretsiz ret tekrar | evet | betik+mantık | İYİLEŞTİR | `Retry-After` dikkate alınıyor, bekleme süresi gösteriliyor. |
| Belirsiz zaman aşımı | Ücretli isteği otomatik tekrar etmeme | evet | betik+mantık | İYİLEŞTİR | 502/504/52x ağ geçidi hataları da "belirsiz"; yanıt gövdesi de zaman sınırı içinde okunuyor (eskiden takılabiliyordu). |
| Hata mesajları | Kullanıcıya açıklama | kısmen | mantık | İYİLEŞTİR | Türkçe ve eyleme dönük (401 → anahtarı kontrol et, 402 → kredi yükle); HTML/ham metin ve anahtar sızmıyor. |
| `font`, `text_align`, `stroke_disabled`, `bubbles_only` alanları, `TORII_FONTS` | — | hiç çağrılmıyor | — | KALDIR | Ölü kod. |
| Ayar "Min. punto (Torii)" | Torii'nin kendi çizimi | etkisiz | — | KALDIR | Torii'nin çizdiği görsel kullanılmıyor; sabit 10. |
| Ayar "Varsayılan çeviri modeli" | — | etkisiz (profil her zaman kendi modelini taşır) | — | KALDIR | Model yalnızca Profil'de. |
| `source_langs_whitelist` | Yalnız seçili dil | gönderiliyor | yok (gerçek istekle) | İYİLEŞTİR | OCR yanıtı da yerelde filtreleniyor (başka dildeki yazı silinmez). Gerçek istek doğrulaması kullanıcı kredisi gerektirir. |
| BYOK | Kendi model anahtarı | bilinmiyor | yok | BİRLEŞTİR | Gelişmiş'e taşındı; boş anahtarla "kaydedildi" hatası giderildi. |

### Tespit ve tür
| Özellik | Karar | Gerekçe / yapılan |
|---|---|---|
| Balon tespiti (`detectBubble`) | İYİLEŞTİR | Doğrulanan hatalar düzeltildi: paneller arası tam genişlik boşluk balon sanılıyordu (iki karşı sayfa kenarına değen bölge reddediliyor); düz renkli SFX harfi kendi "balonu" sayılıyordu (bölge yazıyı çevrelemeli); kırpılmış görüntü kenarı sayfa kenarı sayılıyordu; oval balonda kutu köşesi dışarıda kalınca bulunamıyordu (iki geçişli tohum). Dikdörtgen kutu → Anlatım. |
| Aynı balonda iki paragraf | İYİLEŞTİR | Üst üste diziliyordu → paylaşılan balonda her öğe kendi yerinde. |
| Kontur bilgisi tek başına "balon dışı" değil; kara dikenli balon SFX değil; onaylı tür korunur | KORU | betik testleri. |

### Temizlik
| Özellik | Karar | Gerekçe / yapılan |
|---|---|---|
| Torii x/y/w/h = çeviri kutusu; taşan satır/kopuk nokta | İYİLEŞTİR | Modüler yolda da balon içindeki TÜM mürekkep (OCR poligonu dışındakiler dahil) maskeleniyor; düz balon zemini → kredisiz yerel dolgu. |
| Fark eşiği 20 | İYİLEŞTİR | Uyarlanır: çekirdek dışındaki JPEG gürültüsünün %95 değeri +10 (20–60). Koyu zeminde koyu kırmızı yazı yakalanmaya devam eder. |
| "Torii silmedi" yedeği | İYİLEŞTİR | Karar artık yazı çekirdeğine göre (balonun tamamına göre değil); balonda renkten bağımsız mürekkep maskesi. |
| Çizim üstü SFX zinciri | İYİLEŞTİR | Üretken Dolgu → İçerik Duyarlı → Torii, öğe öğe, otomatik; her yöntemde maske dışı piksel değişmiyor (test). Üretken katmana kendi maskemiz tüm katman sınırında uygulanıyor (eski hali: sayfayı boyayan sonuç maske alanı dışında görünür kalıyordu). |
| Öğret / kaydet-tekrarla, elle tamamlama (handoff), "Adobe sonucunu bağla", `awaitingHandoff` | KALDIR | Kaydedici hiçbir şey yakalamadı; kullanıcı tam otomatik istiyor. |
| Partner modeller (FLUX, Gemini) | KALDIR | Panelden çağrılamıyor/doğrulanamadı. |
| Adobe Kaldır | KALDIR | Eklenti komutu yok; Üretken Dolgu boş istemle aynı işi yapar. |
| Firefly Services | İYİLEŞTİR | Kurulu değilse tek satır "kurulum gerekli"; başarısızlıkta otomatik yerel yedek; vekilde CORS kapatıldı, yalnız JSON kabul (başka sitelerin yerel vekili çağırması engellendi). |
| Firefly "Görsel Üret" | KALDIR | Kapsam dışı, doğrulanmamış, webtoon boyutları desteklenmiyor. |
| "Yöntemleri karşılaştır" | KALDIR | Teşhis aracı; Torii kredisi harcayıp sonucu atıyordu. |

### Dizgi
| Özellik | Karar | Gerekçe / yapılan |
|---|---|---|
| Balon ortasına yerleşim, oval sığdırma, kelime bölmeme | KORU | betik (refine). Dikdörtgen kutuda %86 alan. |
| Türkçe büyük harf | İYİLEŞTİR | Kaynakta geçen İngilizce kelimeyle çakışan Türkçe kelimeler ("in", "bin") artık İ alıyor; Latin dışı harfler de büyüyor. |
| Sığdırma (fitToBox) | İYİLEŞTİR | Karekök tahminiyle daha az ölçüm; ölçüm tek batchPlay; kelime yoklaması hata verse de metin geri yazılıyor. |
| Kontur/gölge | ⚠ | Betik bağlamında `-25920`; gerçek panelde doğrulanmalı. Hata durumunda uyarı + dizgi sürer. |
| Kurulu çizgi roman fontu yoksa | İYİLEŞTİR | Dizgi sonunda öneri (Comic Neue / Bangers / Anime Ace). |

### Belge / oturum / arayüz
| Özellik | Karar | Gerekçe / yapılan |
|---|---|---|
| 1 sn belge yoklaması | KALDIR | Olaylar + panele her tıklamada ucuz kimlik karşılaştırması + işlem öncesi doğrulama. |
| Durdur | İYİLEŞTİR | Eskiden yalnız bölüm sayfaları arasında; artık her adım ve her ücretli istekten önce. Esc de durdurur. |
| Kredi takibi | İYİLEŞTİR | Her çalıştırmanın harcadığı kredi ve kullanılan Tam İşlem modu sonuç satırında. |
| Tam İşlem modu | İYİLEŞTİR | Varsayılan Modüler (~2 kr/sayfa); Tek istek seçilebilir. "Otomatik" ile "Tek istek" aynıydı → birleştirildi. |
| Sekmeler (7) | BİRLEŞTİR | 5 sekme: Öğeler, Bölüm, Profil, Temizlik, Ayarlar. Log ve Araçlar → Ayarlar › Gelişmiş. |
| Canlı kabul testi (panelde, kredi harcar) | KALDIR (pakette) | `src/dev/`'e taşındı; .ccx paketine girmez, yalnız geliştirme kopyasında Gelişmiş altında görünür. |
| `window.MCS`, `__MCS_PREVIEW`, tools/preview | KALDIR | Hata ayıklama/önizleme kodu; Edge önizlemesi yanıltıcıydı. |
| `_lastMasks` | İYİLEŞTİR | Yalnız `debug` bayrağıyla (testler); üretimde bellek birikmiyor. |
| Liste yeniden çizimi | İYİLEŞTİR | Artımlı (yalnız değişen satır), tek olay dinleyicisi; editör yazarken yeniden kurulmuyor. |

## 2. Ölü kod / tekrar
- `adobe.js`: kaydedici, `adaptDescriptor`, `describeTemplate`, `ADOBE_MODELS` → silindi (yalnız `syntheticFillDescriptor` + `generativeFill`).
- `pipeline.js`: `adobeTemplate`, `adobeReplayClean`, `adobeHandoff`, `linkHandoffResult`, `respCache` → silindi/yerine `paidCache`.
- Torii inpaint bloğu iki yerde → `toriiPatches()` tek fonksiyon.
- `geom.boxBounds/maskBounds`, `logEmitter` kullanılmıyor (küçük; dokunulmadı).

## 3. Performans
- Darboğaz dizgideki sığdırma: öğe başına ~2 sn, toplamın %85'i (ölçüm: `tests/ps/bench.test.js`, profil `typesetProfile`).
- Sayfa okuma 62 ms, tam sayfa PNG kodlama 737 ms (5,7 MB) — her ücretli istekte bir kez.
- Eski: saniyede bir belge yoklaması, her değişiklikte tüm listenin yeniden kurulması, ayırıcı sürüklemede her harekette yerleşim.
Ölçümler için TEST-RAPORU.md.
