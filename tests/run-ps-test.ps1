# Testi paketler, Photoshop'ta çalıştırır, "JavaScript dosyası yüklemek üzeresiniz" onayını kabul eder, sonucu bekler.
param(
  [Parameter(Mandatory=$true)][string]$Name,
  [int]$TimeoutSec = 240,
  [string]$SrcRoot = ""
)
$root = Split-Path -Parent $PSScriptRoot
$work = Join-Path $env:TEMP "mcs-tests"
New-Item -ItemType Directory -Force $work | Out-Null
$out = Join-Path $work "$Name.psjs"
$res = Join-Path $work "$Name.json"
Remove-Item $res -ErrorAction SilentlyContinue
# Test sayfası, kullanıcının belgeleriyle karışmasın diye AYRI adla kopyalanır.
# Testler yalnızca adı "MCS_" ile başlayan kendi belgelerini açar/kapatır; kullanıcının belgelerine dokunmaz.
$asset = Join-Path $work "MCS_TEST_page.jpg"
$srcPage = Join-Path (Join-Path $root "tests") (Join-Path "assets" "turning-into-a-tentacle-monster-p1.jpg")
Copy-Item $srcPage $asset -Force
# Torii'nin "inpainted" çıktısı gibi JPEG bir sahte temizlenmiş sayfa (kıyaslama/test için; Windows JPEG kodlayıcısıyla)
$inpJpg = Join-Path $work "MCS_TEST_inpainted.jpg"
if (-not (Test-Path $inpJpg)) {
  Add-Type -AssemblyName System.Drawing
  $img = [System.Drawing.Image]::FromFile($srcPage)
  $bmp = New-Object System.Drawing.Bitmap $img
  $img.Dispose()
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(250, 250, 250))
  foreach ($r in @(@(462,860,250,172), @(140,1490,100,40), @(38,3698,389,86), @(296,4203,444,164), @(578,9503,134,114))) { $g.FillRectangle($white, $r[0], $r[1], $r[2], $r[3]) }
  $g.Dispose()
  $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq "image/jpeg" }
  $ep = New-Object System.Drawing.Imaging.EncoderParameters 1
  $ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), 90L
  $bmp.Save($inpJpg, $codec, $ep)
  $bmp.Dispose()
}
$buildArgs = @("-NoProfile", "-File", (Join-Path $PSScriptRoot "build-psjs.ps1"), "-Entry", (Join-Path (Join-Path $PSScriptRoot "ps") "$Name.test.js"), "-Out", $out, "-ResultPath", $res, "-AssetPath", $asset, "-TimeoutSec", $TimeoutSec)
if ($SrcRoot) { $buildArgs += @("-SrcRoot", $SrcRoot) }
& powershell @buildArgs | Out-Null
if (-not (Test-Path $out) -or (Get-Item $out).LastWriteTime -lt (Get-Date).AddMinutes(-1)) { Write-Output "PAKETLEME HATASI: $out üretilmedi"; exit 2 }
Start-Process "C:\Program Files\Adobe\Adobe Photoshop 2026\Photoshop.exe" -ArgumentList "`"$out`""

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$rootEl = [System.Windows.Automation.AutomationElement]::RootElement
$btnCond = New-Object System.Windows.Automation.AndCondition(
  (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, "Evet")),
  (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)))
$deadline = (Get-Date).AddSeconds(20)
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 700
  $b = $rootEl.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $btnCond)
  $psPid = (Get-Process -Name Photoshop -ErrorAction SilentlyContinue | Select-Object -First 1).Id
  # Güvenlik: yalnızca Photoshop sürecine ait "Evet" düğmesi; başka uygulamalara asla dokunma
  if ($b -and $psPid -and $b.Current.ProcessId -eq $psPid) {
    try { $b.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); Write-Output "onay verildi"; break }
    catch { try { $b.GetCurrentPattern([System.Windows.Automation.LegacyIAccessiblePattern]::Pattern).DoDefaultAction(); Write-Output "onay verildi (legacy)"; break } catch { } }
  }
}
$deadline = (Get-Date).AddSeconds($TimeoutSec)
while ((Get-Date) -lt $deadline) {
  Start-Sleep 3
  if (Test-Path $res) {
    $j = Get-Content $res -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($j.fatal -or $j.finished) { break }
  }
}
if (Test-Path $res) { Get-Content $res -Raw -Encoding UTF8 } else { "SONUÇ YOK" }
