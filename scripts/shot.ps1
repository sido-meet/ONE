param(
  [Parameter(Mandatory = $true)][string]$Out = "E:\Projects\ONE\shot.png",
  [int]$Left = 0,
  [int]$Top = 0,
  [int]$Width = 0,
  [int]$Height = 0,
  [string]$Process = ""
)

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
$sig = @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class Cap {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
'@
if (-not ("Cap" -as [type])) { Add-Type -TypeDefinition $sig }

$found = New-Object System.Collections.ArrayList
$cb = [Cap+EnumProc]{
  param($h, $p)
  $procId = 0
  [Cap]::GetWindowThreadProcessId($h, [ref]$procId) | Out-Null
  $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
  if ($proc -and ($Process -eq "" -or $proc.ProcessName -eq $Process)) {
    $cn = New-Object System.Text.StringBuilder 256
    [Cap]::GetClassName($h, $cn, 256) | Out-Null
    if ($cn.ToString() -like "*Tauri Window*") {
      $r = New-Object Cap+RECT
      [Cap]::GetWindowRect($h, [ref]$r) | Out-Null
      [void]$found.Add([pscustomobject]@{ H = $h; Vis = [Cap]::IsWindowVisible($h); L = $r.L; T = $r.T; R = $r.R; B = $r.B })
    }
  }
  return $true
}
[Cap]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
$found | ForEach-Object { "hwnd=$($_.H) vis=$($_.Vis) rect=$($_.L),$($_.T),$($_.R),$($_.B)" }

if ($Width -le 0) {
  $screens = [System.Windows.Forms.Screen]::AllScreens
  $b = $screens[0].Bounds
  $Left = $b.Left; $Top = $b.Top; $Width = $b.Width; $Height = $b.Height
}
$bitmap = New-Object System.Drawing.Bitmap $Width, $Height
$g = [System.Drawing.Graphics]::FromImage($bitmap)
$g.CopyFromScreen($Left, $Top, 0, 0, $bitmap.Size)
$bitmap.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bitmap.Dispose()
"saved $Out ($Width x $Height from $Left,$Top)"
