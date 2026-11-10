# UXP Developer Tool servisine (ws://localhost:14001/socket/cli) bağlanıp eklentiyi Photoshop'a yükler / yeniden yükler.
# UDT uygulaması açık olmalı (servisi o çalıştırır). Elle "Load" tıklamaya gerek kalmaz.
#   powershell -File tools\udt.ps1 -Action load|reload|unload
param(
  [ValidateSet("load", "reload", "unload")][string]$Action = "load",
  [int]$Port = 14001,
  [int]$TimeoutSec = 30,
  [string]$Path = ""   # başka bir eklenti klasörü (ör. önce/sonra kıyası için eski sürüm)
)
$ErrorActionPreference = "Stop"
$root = if ($Path) { $Path } else { Split-Path -Parent $PSScriptRoot }
$stateFile = Join-Path $env:TEMP "mcs-udt-session.txt"
$ws = New-Object System.Net.WebSockets.ClientWebSocket
$cts = New-Object System.Threading.CancellationTokenSource
$ws.ConnectAsync([Uri]"ws://localhost:$Port/socket/cli", $cts.Token).Wait()

function Receive-Msg([int]$ms) {
  $buf = New-Object byte[] 262144
  $sb = New-Object System.Text.StringBuilder
  do {
    $seg = New-Object System.ArraySegment[byte] -ArgumentList @(, $buf)
    $t = $ws.ReceiveAsync($seg, $cts.Token)
    if (-not $t.Wait($ms)) { return $null }
    $r = $t.Result
    [void]$sb.Append([Text.Encoding]::UTF8.GetString($buf, 0, $r.Count))
  } while (-not $r.EndOfMessage)
  return $sb.ToString()
}
function Send-Msg($obj) {
  $json = $obj | ConvertTo-Json -Depth 12 -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($json)
  $seg = New-Object System.ArraySegment[byte] -ArgumentList @(, $bytes)
  $ws.SendAsync($seg, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, $cts.Token).Wait()
}

# Bağlı uygulamaları bekle
$appId = $null
$deadline = (Get-Date).AddSeconds(8)
while ((Get-Date) -lt $deadline -and -not $appId) {
  $m = Receive-Msg 3000
  if (-not $m) { continue }
  $o = $m | ConvertFrom-Json
  if ($o.command -eq "didAddRuntimeClient" -and $o.app -and $o.app.appId -eq "PS") { $appId = $o.id }
}
if (-not $appId) { Write-Output "HATA: UDT servisine bagli Photoshop yok"; exit 2 }

if ($Action -eq "load") {
  $msg = @{ command = "Plugin"; action = "load"; params = @{ provider = @{ type = "disk"; path = $root } }; breakOnStart = $false }
} else {
  if (-not (Test-Path $stateFile)) { Write-Output "HATA: kayitli oturum yok (once load)"; exit 3 }
  $sid = (Get-Content $stateFile -Raw).Trim()
  $msg = @{ command = "Plugin"; action = $Action; pluginSessionId = $sid }
}
Send-Msg @{ command = "proxy"; clientId = $appId; requestId = 1; message = $msg }
$deadline = (Get-Date).AddSeconds($TimeoutSec)
while ((Get-Date) -lt $deadline) {
  $m = Receive-Msg 5000
  if (-not $m) { continue }
  $o = $m | ConvertFrom-Json
  if ($o.requestId -eq 1) {
    if ($Action -eq "load" -and $o.pluginSessionId) { Set-Content -Path $stateFile -Value $o.pluginSessionId -Encoding ASCII }
    Write-Output $m
    break
  }
}
try { $ws.CloseAsync([System.Net.WebSockets.WebSocketCloseStatus]::NormalClosure, "bitti", $cts.Token).Wait(2000) | Out-Null } catch { }
