# Testi Photoshop UXP betiği (.psjs) olarak hazırlar: src/ klasörü betiğin yanına kopyalanır,
# test girişi gerçek modülleri require("./src/...") ile yükler (eklentideki kodun aynısı).
param(
  [Parameter(Mandatory=$true)][string]$Entry,
  [Parameter(Mandatory=$true)][string]$Out,
  [Parameter(Mandatory=$true)][string]$ResultPath,
  [string]$AssetPath = ""
)
$root = Split-Path -Parent $PSScriptRoot
$work = Split-Path -Parent $Out
if (Test-Path (Join-Path $work "src")) { Remove-Item -Recurse -Force (Join-Path $work "src") }
Copy-Item -Recurse (Join-Path $root "src") (Join-Path $work "src")
$entryCode = [IO.File]::ReadAllText((Resolve-Path $Entry))
$resultJs = $ResultPath.Replace('\','/')
$assetJs = $AssetPath.Replace('\','/')
$head = @"
const RESULT_PATH = "$resultJs"; const ASSET_PATH = "$assetJs";
const R = (n) => require(n.replace(/^\.\.\//, "./"));
try {
"@
$tail = @"

} catch (e) {
  require("fs").writeFileSync(RESULT_PATH, JSON.stringify({ fatal: "YUKLEME HATASI: " + String(e && (e.stack || e.message || e)) }));
}
"@
[IO.File]::WriteAllText($Out, $head + $entryCode + $tail, (New-Object Text.UTF8Encoding $true))
Write-Output "Hazir: $Out"
