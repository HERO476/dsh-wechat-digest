# Capture the WeChat main window region from the screen into PNG.
# ASCII-only: PowerShell 5.1 reads .ps1 as ANSI.
# Read-only: no memory access, no input injection, no window manipulation.
# Requires the window to be visible and not covered (it copies real screen pixels,
# because PrintWindow returns a blank frame for WeChat 4.x).
param(
    [Parameter(Mandatory = $true)][string]$OutPath,
    [string]$ProcName = 'Weixin'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public class WinCap {
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }
}
'@

$proc = Get-Process -Name $ProcName -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } |
    Select-Object -First 1

if (-not $proc) {
    Write-Output 'ERR code=NO_PROCESS'
    exit 3
}

$hwnd = $proc.MainWindowHandle
if ([WinCap]::IsIconic($hwnd)) {
    Write-Output 'ERR code=MINIMIZED hint=RESTORE_WINDOW'
    exit 5
}

$rect = New-Object WinCap+RECT
if (-not [WinCap]::GetWindowRect($hwnd, [ref]$rect)) {
    Write-Output 'ERR code=NO_RECT'
    exit 6
}

$w = $rect.Right - $rect.Left
$h = $rect.Bottom - $rect.Top
if ($w -lt 200 -or $h -lt 200) {
    Write-Output ('ERR code=WINDOW_TOO_SMALL size=' + $w + 'x' + $h)
    exit 7
}

$dir = [System.IO.Path]::GetDirectoryName($OutPath)
if (-not [string]::IsNullOrWhiteSpace($dir) -and -not (Test-Path -LiteralPath $dir)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
}

$bmp = New-Object System.Drawing.Bitmap($w, $h)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($rect.Left, $rect.Top, 0, 0, (New-Object System.Drawing.Size($w, $h)))
$g.Dispose()
$bmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

# Only geometry is printed; never any window content.
Write-Output ('OK size=' + $w + 'x' + $h + ' left=' + $rect.Left + ' top=' + $rect.Top)
