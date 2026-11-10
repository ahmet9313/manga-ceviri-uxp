# Test Raporu — Manga Çeviri Stüdyosu 1.1.0

**Ortam:** Windows 11 Home 10.0.26200 · Photoshop 2026 **27.11** · UXP Developer Tools · ekran ölçeği %125 · Bun (Photoshop'suz testler)
**Test sayfası:** *turning-into-a-tentacle-monster-made-me-crazier* bölümünden 800×10000 px webtoon sayfası (`tests/assets/`), testlerde `MCS_TEST_page.jpg` kopyası
**Tarih:** 10 Kasım 2026

## Nasıl test edildi
- **Photoshop testleri** (`tests/ps/*.test.js`): eklentinin gerçek modülleri `.psjs` betiğinden gerçek Photoshop'ta çalışır.
  Torii ve Adobe Üretken Dolgu **her zaman sahte**: düzenek gerçek ağ isteğini (global `fetch`) ve gerçek `syntheticFill`'i engeller.
  Yalnızca `MCS_` ile başlayan kopyalar açılıp kapatılır.
- **Photoshop'suz mantık testleri** (`tests/logic/*.test.js`, Bun): balon tespiti, mürekkep maskesi, Torii hata davranışı, Türkçe büyük harf.
- **Gerçek panel**: eklenti UDT servisi üzerinden tıklamasız yüklendi (`tools/udt.ps1`); görüntüler yalnızca Photoshop penceresinden (`tools/capture-ps.ps1 -Panel`).

## Sonuçlar (10.11.2026, son çalıştırma)
| Paket | Sonuç | Kapsam |
|---|---|---|
| load | **27/27** | tüm modüller UXP'de yükleniyor |
| unit | **13/13** | Torii multipart, 429 geri çekilme, belirsiz zaman aşımı, hız sınırı, eşleme, öncelik, PNG, maskeleme, Türkçe büyük harf, balon tespiti (boşluk/SFX/kesik/kırpma) |
| decode | **3/3** | JPEG (png etiketli), PNG, bilinmeyen biçim → anlaşılır hata |
| refine | **16/16** | tür önerisi, balon bulma, dizgi kutusu balon ortasında, temizlik izi (balon içi %0, SNAP %2,8), kopuk nokta, maske dışı değişen piksel **0** |
| sfxclean / sfxnoerase | **7/7 · 7/7** | çizim üstü SFX: Üretken başarısız → aynı öğe otomatik İçerik Duyarlı; mürekkep silindi; maske dışı 0 |
| chain (yeni) | **8/8** | Üretken Dolgu katmanı tüm sayfayı boyasa bile maske dışı **0**; Üretken + İçerik Duyarlı başarısız → **Torii** otomatik; gerekçe kaydı |
| reset | **11/11** | sıfırlama (kilitliler korunur), ücretli yanıt sıfırlamadan sonra önbellekten (ikinci kez ödeme yok) |
| acceptance | **17/17** | grup yapısı, Sadece Balonlar'da SFX pikselleri değişmez, maske dışı 0, tekrar çalıştırmada çift katman yok, iki seri profili doğru fontlar, elle düzenleme korunur, Undo/Redo, PSD kaydet-kapat-aç, sonuç yanlış belgeye yazılmaz |
| tests/logic (Bun) | **16/16** | gutter/SFX/kesik balon/dikdörtgen kutu → Anlatım, mürekkep maskesi (nokta dahil, kontur hariç), 524 → belirsiz, takılan gövde zaman aşımı, 401/402 Türkçe mesaj, Retry-After, Türkçe büyük harf |

## Performans (800×10000 sayfa, 10 öğe, sahte Torii — ağ süresi hariç; `tests/ps/bench.test.js`)
| Ölçüm | Önce (commit 47fbfe1) | Sonra |
|---|---|---|
| Tam İşlem — modüler | 28,3 sn | **11,8 sn** (−%58) |
| Tam İşlem — tek istek | 24,5 sn | **10,8 sn** (−%56) |
| Dizgi (10 öğe) | ~24,7 sn | 8,2 sn — sığdırmada metin içeriği değiştirme (öğe başına ~1,5 sn) kaldırıldı, ölçüm tek batchPlay |
| Sayfa okuma / PNG kodlama | 62 / 737 ms | 50 / 676 ms |
| Panel açılışı (gerçek panel, UDT yeniden yükleme) | 110–210 ms | 210–256 ms (açık belge + 8 öğe ile; ilk soğuk açılış 343 ms) |
| Belge yoklaması | saniyede bir | yok (olay + tıklamada kimlik karşılaştırması) |

Gerçek Torii ile ölçülen maliyet (kullanıcının panel çalıştırması, günlük): tek istek **6,18 kredi** (5.jpg, 8 öğe), önceki ölçümler 6,96–8,4 kredi/sayfa.
Modüler modun gerçek maliyeti bu oturumda ölçülmedi (kredi harcamamak için); doküman fiyatlarıyla ~2,02 kredi/sayfa. Panel her çalıştırmadan sonra harcanan krediyi yazar.

## Gerçek panel görüntüleri
`docs/img/once-panel.png` (eski arayüz) · `docs/img/sonra-panel.png` (yeni, aynı pencere boyutu) · `docs/img/sonra-panel-genis.png` (790 px, %125 ölçek).

## Testlerde bulunan ve düzeltilen hatalar (bu tur)
- Üretken Dolgu sonucu tüm katmanı kaplarsa maske alanı dışı görünür kalıyordu (`putLayerMask` yazılmayan bölgeyi beyaz bırakır) → maske katmanın tüm sınırını kapsıyor (chain).
- Balon tespiti: tam genişlik panel boşluğu, düz SFX harfi, kırpma kenarı, oval köşe (inceleme + logic testleri).
- Modüler temizlikte balon alanı genişleyince düz balonlar Torii'ye gidiyordu → balon zemini düzse kredisiz yerel dolgu (bench: 5 yerel / 2 İçerik Duyarlı / 3 Torii).
- `cleanup.js`'de çift tanım yükleme hatası (Bun derleme kontrolü yakalamadı, Photoshop yüklemesi yakaladı) → düzeltildi; mantık testleri artık modülü gerçekten yüklüyor.
- Test düzeneği: boş `-SrcRoot` argümanı eski .psjs'nin çalışmasına yol açıyordu → yeni paket üretilmezse test durur.

## ✅ Gerçek Photoshop'ta doğrulanan
Yukarıdaki tüm paketler; yeni panelin UDT ile yüklenmesi ve çizimi (sekmeler, üst şerit, çipler, liste, boş editör, alt şerit, mod satırı, kredi rozeti);
Torii `GET /api/credits` (panel açılışında, günlük: "Kredi: tamam"); kullanıcının gerçek tek istek Tam İşlem'i (6,18 kr, JPEG temizlenmiş görsel, 8 katman dizgi).

## ❌ Başarısız
| Özellik | Sonuç |
|---|---|
| Kontur/gölge (`set layerEffects`) betik bağlamında | `-25920 komut şu an kullanılabilir değil` (bench uyarıları). Dizgi sürer, uyarı yazılır. Panel bağlamında doğrulanmadı. |
| İmzasız `.ccx` kurulumu (UPIA) | `-267`. Çift tıklanabilir paket için UDT › ••• › Package. |

## ⚠ Ortam nedeniyle doğrulanamayan
| Özellik | Neden / yapılması gereken |
|---|---|
| Gerçek Adobe Üretken Dolgu (`syntheticFill`) | Adobe üretken kredisi harcar; testlerde sahte. Photoshop'ta "Faturalama sorunu" uyarısı görünüyor — Üretken Dolgu reddedilirse panel otomatik İçerik Duyarlı'ya geçer ve nedenini yazar. Bir çizim üstü SFX'te ▶ Tam İşlem çalıştırıp Temizlik sekmesindeki satırı kontrol edin. |
| Modüler Tam İşlem'in gerçek kredi maliyeti, `source_langs_whitelist` | Gerçek Torii isteği gerekir (kredi). Çalıştırma sonunda panel "· X kredi" yazar. |
| Dar panel (~340 px), yüzen↔kenetli, %100/%150 ölçek | Dock penceresi dışarıdan boyutlandırılınca panel yeniden yerleşmiyor; elle sürükleyerek daraltıp bakılmalı (dar görünümde Liste/Editör geçişi çıkar). |
| Panelde tıklama/sürükleme etkileşimleri (öğe seçme, ayırıcı, tutamaçla sıralama, klavye, Durdur, diyaloglar) | Fare/klavye otomasyonu sizin bilgisayarınızda yapılmadı. Mantıkları betik testlerinde doğrulandı. |
| Bölüm işlemleri, Eylem oynatma, bul-değiştir (panelden) | Çok sayfalı senaryo çalıştırılmadı. |
| Firefly Services vekili, BYOK | Adobe sunucu kimlik bilgisi / sağlayıcı anahtarı yok. |
