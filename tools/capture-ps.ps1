# Yalnızca Photoshop penceresinin görüntüsünü alır (masaüstünün geri kalanını değil).
# -Panel: yüzen eklenti paneli (Photoshop sürecinin OWL.Dock penceresi)
param([Parameter(Mandatory=$true)][string]$Out, [switch]$Panel)
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System; using System.Runtime.InteropServices;
public class PW {
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint f);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  public struct RECT { public int L, T, R, B; }
}
"@
[void][PW]::SetProcessDPIAware()
$p = Get-Process -Name Photoshop -ErrorAction Stop | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
$hwnd = $p.MainWindowHandle
if ($Panel) {
  Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public class EW { public delegate bool EP(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EP f, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  public static IntPtr Find(uint pid) { IntPtr found = IntPtr.Zero; EnumWindows((h, l) => { uint q; GetWindowThreadProcessId(h, out q); var c = new StringBuilder(64); GetClassName(h, c, 64); if (q == pid && IsWindowVisible(h) && c.ToString() == "OWL.Dock") { found = h; return false; } return true; }, IntPtr.Zero); return found; } }
"@
  $hwnd = [EW]::Find([uint32]$p.Id)
  if ($hwnd -eq [IntPtr]::Zero) { throw "Yüzen panel penceresi yok" }
}
$r = New-Object PW+RECT
[void][PW]::GetWindowRect($hwnd, [ref]$r)
$w = $r.R - $r.L; $h = $r.B - $r.T
$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
[void][PW]::PrintWindow($hwnd, $hdc, 2)
$g.ReleaseHdc($hdc); $g.Dispose()
$bmp.Save($Out); $bmp.Dispose()
"$w x $h"
