# .ccx paketi üretir (UXP eklenti paketi = kökte manifest.json bulunan ZIP).
# Kullanım: powershell -File tools\package-ccx.ps1   → dist\manga-ceviri-studio-<sürüm>.ccx
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$manifest = Get-Content (Join-Path $root "manifest.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$dist = Join-Path $root "dist"
New-Item -ItemType Directory -Force $dist | Out-Null
$out = Join-Path $dist ("manga-ceviri-studio-" + $manifest.version + ".ccx")
if (Test-Path $out) { Remove-Item $out -Force }
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$include = @("manifest.json", "index.html", "index.js", "styles.css", "icons", "src")
$zip = [System.IO.Compression.ZipFile]::Open($out, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($inc in $include) {
    $p = Join-Path $root $inc
    $files = if (Test-Path $p -PathType Container) { Get-ChildItem $p -Recurse -File } else { Get-Item $p }
    foreach ($f in $files) {
      $rel = $f.FullName.Substring($root.Length + 1).Replace('\', '/')   # ZIP girişleri '/' ile
      [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $f.FullName, $rel, [System.IO.Compression.CompressionLevel]::Optimal)
    }
  }
} finally { $zip.Dispose() }
$z = [System.IO.Compression.ZipFile]::OpenRead($out)
$count = $z.Entries.Count; $hasManifest = [bool]($z.Entries | Where-Object { $_.FullName -eq "manifest.json" }); $z.Dispose()
Write-Output ("Paket: {0} ({1} dosya, {2:N0} bayt, kökte manifest: {3})" -f $out, $count, (Get-Item $out).Length, $hasManifest)
