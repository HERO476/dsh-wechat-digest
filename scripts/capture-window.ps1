# Capture the largest visible window of a process from the screen into PNG.
# ASCII-only: PowerShell 5.1 reads .ps1 as ANSI.
# Read-only: copies real screen pixels (PrintWindow returns blank frames for WeChat 4.x).
# Reports whether the captured window is the foreground window, so the caller can warn
# that other windows may be covering it (privacy: covered pixels would be captured).
param(
    [Parameter(Mandatory = $true)][string]$OutPath,
    [string]$ProcName = 'Weixin',
    [int]$MinWidth = 400,
    [int]$MinHeight = 400
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public class WinCap {
    public delegate bool EnumProc(IntPtr h, IntPtr l);

    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    public static IntPtr PickLargest(uint pid, out RECT rect, out bool iconic, out bool anyVisible) {
        IntPtr best = IntPtr.Zero;
        int bestArea = 0;
        RECT bestRect = new RECT();
        bool bestIconic = false;
        bool sawVisible = false;

        EnumWindows(delegate(IntPtr h, IntPtr l) {
            uint wp;
            GetWindowThreadProcessId(h, out wp);
            if (wp != pid) return true;
            if (!IsWindowVisible(h)) return true;
            RECT r;
            if (!GetWindowRect(h, out r)) return true;
            int w = r.Right - r.Left;
            int ht = r.Bottom - r.Top;
            if (w <= 0 || ht <= 0) return true;
            sawVisible = true;
            int area = w * ht;
            bool ic = IsIconic(h);
            if (area > bestArea) {
                bestArea = area;
                best = h;
                bestRect = r;
                bestIconic = ic;
            }
            return true;
        }, IntPtr.Zero);

        rect = bestRect;
        iconic = bestIconic;
        anyVisible = sawVisible;
        return best;
    }
}
'@

$proc = Get-Process -Name $ProcName -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } |
    Select-Object -First 1

if (-not $proc) {
    Write-Output 'ERR code=NO_PROCESS'
    exit 3
}

$rect = New-Object WinCap+RECT
$iconic = $false
$anyVisible = $false
$hwnd = [WinCap]::PickLargest([uint32]$proc.Id, [ref]$rect, [ref]$iconic, [ref]$anyVisible)

if ($hwnd -eq [IntPtr]::Zero) {
    Write-Output 'ERR code=NO_WINDOW'
    exit 4
}
if ($iconic) {
    Write-Output 'ERR code=MINIMIZED hint=RESTORE_WINDOW'
    exit 5
}

$w = $rect.Right - $rect.Left
$h = $rect.Bottom - $rect.Top
if ($w -lt $MinWidth -or $h -lt $MinHeight) {
    Write-Output ('ERR code=WINDOW_TOO_SMALL size=' + $w + 'x' + $h + ' hint=OPEN_CHAT_WINDOW')
    exit 7
}

$fgHwnd = [WinCap]::GetForegroundWindow()
$isForeground = ($fgHwnd -eq $hwnd)

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

# Only geometry/flags are printed; never any window content.
Write-Output ('OK size=' + $w + 'x' + $h + ' fg=' + [int]$isForeground)
