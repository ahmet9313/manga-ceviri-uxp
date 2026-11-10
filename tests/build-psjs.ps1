# Testi Photoshop UXP betiği (.psjs) olarak hazırlar: src/ klasörü betiğin yanına kopyalanır,
# test girişi gerçek modülleri require("./src/...") ile yükler (eklentideki kodun aynısı).
#
# ZAMAN SINIRI KORUMASI: testin üst düzey api.modal(...) çağrıları süre sınırıyla sarılır. Bir Photoshop çağrısı hiç
# dönmezse (10.11.2026'da imaging.encodeImageData böyle Photoshop'u kilitledi) süre dolunca modal BIRAKILIR,
# sonuç dosyasına hata yazılır ve Photoshop kilitli kalmaz.
param(
  [Parameter(Mandatory=$true)][string]$Entry,
  [Parameter(Mandatory=$true)][string]$Out,
  [Parameter(Mandatory=$true)][string]$ResultPath,
  [string]$AssetPath = "",
  [int]$TimeoutSec = 240,
  [string]$SrcRoot = ""   # başka bir kaynak ağacı (ör. önce/sonra kıyaslaması için eski commit'in src klasörü)
)
$root = Split-Path -Parent $PSScriptRoot
$work = Split-Path -Parent $Out
if (-not $SrcRoot) { $SrcRoot = Join-Path $root "src" }
if (Test-Path (Join-Path $work "src")) { Remove-Item -Recurse -Force (Join-Path $work "src") }
Copy-Item -Recurse $SrcRoot (Join-Path $work "src")
$entryCode = [IO.File]::ReadAllText((Resolve-Path $Entry))
$resultJs = $ResultPath.Replace('\','/')
$assetJs = $AssetPath.Replace('\','/')
$guardMs = [Math]::Max(30, $TimeoutSec - 20) * 1000
$head = @"
const RESULT_PATH = "$resultJs"; const ASSET_PATH = "$assetJs"; const TEST_TIMEOUT_MS = $guardMs;
const R = (n) => require(n.replace(/^\.\.\//, "./"));
try {
  // KREDI KORUMASI (her testte, test kodundan ONCE): gercek Adobe Uretken Dolgu ve gercek ag istegi (Torii) imkansiz.
  // Sahte fetch kullanan testler etkilenmez; yalnizca GERCEK global fetch engellenir.
  R("../src/ps/adobe").generativeFill = async () => { throw new Error("TEST: Adobe Uretken Dolgu sahte (kredi korumasi)"); };
  globalThis.fetch = async (url) => { throw new Error("TEST: gercek ag istegi engellendi (kredi korumasi): " + String(url).slice(0, 60)); };
} catch (e) { /* modul yoksa yukleme testi zaten raporlar */ }
try {
  // Zaman sınırı koruması (yalnızca testin doğrudan çağırdığı api.modal; eklentinin iç modal çağrıları etkilenmez)
  const __api = R("../src/ps/api");
  const __orig = __api.modal;
  __api.modal = (name, fn, opts) => __orig(name, (ctx) => Promise.race([
    Promise.resolve().then(() => fn(ctx)),
    new Promise((_, rej) => setTimeout(() => rej(new Error("TEST ZAMAN ASIMI: '" + name + "' " + Math.round(TEST_TIMEOUT_MS / 1000) + " sn icinde bitmedi; modal birakildi")), TEST_TIMEOUT_MS)),
  ]), opts);
} catch (e) { /* api modülü yüklenemezse test zaten hata yazar */ }
try {
"@
$tail = @"

} catch (e) {
  require("fs").writeFileSync(RESULT_PATH, JSON.stringify({ fatal: "YUKLEME HATASI: " + String(e && (e.stack || e.message || e)) }));
}
"@
[IO.File]::WriteAllText($Out, $head + $entryCode + $tail, (New-Object Text.UTF8Encoding $true))
Write-Output "Hazir: $Out"
