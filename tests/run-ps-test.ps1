# Testi paketler, Photoshop'ta çalıştırır, "JavaScript dosyası yüklemek üzeresiniz" onayını kabul eder, sonucu bekler.
param(
  [Parameter(Mandatory=$true)][string]$Name,
  [int]$TimeoutSec = 240
)
$root = Split-Path -Parent $PSScriptRoot
$work = Join-Path $env:TEMP "mcs-tests"
New-Item -ItemType Directory -Force $work | Out-Null
$out = Join-Path $work "$Name.psjs"
$res = Join-Path $work "$Name.json"
Remove-Item $res -ErrorAction SilentlyContinue
& powershell -NoProfile -File (Join-Path $PSScriptRoot "build-psjs.ps1") -Entry (Join-Path $PSScriptRoot "ps\$Name.test.js") -Out $out -ResultPath $res -AssetPath (Join-Path $root "tests\assets\turning-into-a-tentacle-monster-p1.jpg") | Out-Null
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
