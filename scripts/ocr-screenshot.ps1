# OCR an image. Default: 2x upscale + auto-invert for dark themes.
# Coordinates in the JSON are mapped back to ORIGINAL image pixels.
# ASCII-only: PowerShell 5.1 reads .ps1 as ANSI. No Chinese literals here.
param(
    [Parameter(Mandatory = $true)][string]$ImagePath,
    [string]$OutPath = '',
    [string]$LangTag = 'zh-Hans-CN',
    [int]$Scale = 2,
    [string]$Invert = '0'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

if (-not (Test-Path -LiteralPath $ImagePath)) {
    Write-Output 'ERR code=IMAGE_NOT_FOUND'
    exit 2
}
if ([string]::IsNullOrWhiteSpace($OutPath)) {
    $OutPath = [System.IO.Path]::ChangeExtension($ImagePath, '.ocr.json')
}
if ($Scale -lt 1) { $Scale = 1 }
if ($Scale -gt 3) { $Scale = 3 }

$src = [System.Drawing.Image]::FromFile((Resolve-Path -LiteralPath $ImagePath).Path)
$origW = $src.Width
$origH = $src.Height

# --- decide inversion (dark theme) ---
function Get-MeanBrightness($bmp) {
    $stepX = [Math]::Max(1, [int]($bmp.Width / 24))
    $stepY = [Math]::Max(1, [int]($bmp.Height / 24))
    $sum = 0.0
    $n = 0
    for ($y = 0; $y -lt $bmp.Height; $y += $stepY) {
        for ($x = 0; $x -lt $bmp.Width; $x += $stepX) {
            $c = $bmp.GetPixel($x, $y)
            $sum += (0.299 * $c.R + 0.587 * $c.G + 0.114 * $c.B)
            $n++
        }
    }
    if ($n -eq 0) { return 255.0 }
    return $sum / $n
}

$probe = New-Object System.Drawing.Bitmap($src)
$brightness = Get-MeanBrightness $probe
$probe.Dispose()

$doInvert = $false
if ($Invert -eq '1') { $doInvert = $true }
elseif ($Invert -eq '0') { $doInvert = $false }
else { $doInvert = ($brightness -lt 110) }

$workPath = [System.IO.Path]::GetFullPath($ImagePath + '.work.png').Replace('/', '\')

$bmp = New-Object System.Drawing.Bitmap(($origW * $Scale), ($origH * $Scale))
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.Clear([System.Drawing.Color]::White)

if ($doInvert) {
    $cm = New-Object System.Drawing.Imaging.ColorMatrix
    $cm.Matrix00 = -1; $cm.Matrix11 = -1; $cm.Matrix22 = -1; $cm.Matrix33 = 1; $cm.Matrix44 = 1
    $cm.Matrix40 = 1; $cm.Matrix41 = 1; $cm.Matrix42 = 1
    $ia = New-Object System.Drawing.Imaging.ImageAttributes
    $ia.SetColorMatrix($cm)
    $destRect = New-Object System.Drawing.Rectangle(0, 0, $bmp.Width, $bmp.Height)
    $g.DrawImage($src, $destRect, 0, 0, $src.Width, $src.Height, [System.Drawing.GraphicsUnit]::Pixel, $ia)
    $ia.Dispose()
} else {
    $g.DrawImage($src, 0, 0, $bmp.Width, $bmp.Height)
}
$g.Dispose()
$bmp.Save($workPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
$src.Dispose()

[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime] | Out-Null
[Windows.Globalization.Language, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
Add-Type -AssemblyName System.Runtime.WindowsRuntime

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

function Await($op, $type) {
    $task = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op))
    $task.Wait(-1) | Out-Null
    $task.Result
}

$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($workPath.Replace('/', '\'))) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$software = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

$lang = New-Object Windows.Globalization.Language $LangTag
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
if ($null -eq $engine) {
    Write-Output 'ERR code=OCR_ENGINE_UNAVAILABLE'
    exit 3
}

$result = Await ($engine.RecognizeAsync($software)) ([Windows.Media.Ocr.OcrResult])

$lines = @()
foreach ($line in $result.Lines) {
    $x1 = [double]::MaxValue; $y1 = [double]::MaxValue; $x2 = 0.0; $y2 = 0.0
    foreach ($w in $line.Words) {
        $b = $w.BoundingRect
        if ($b.X -lt $x1) { $x1 = $b.X }
        if ($b.Y -lt $y1) { $y1 = $b.Y }
        if (($b.X + $b.Width) -gt $x2) { $x2 = $b.X + $b.Width }
        if (($b.Y + $b.Height) -gt $y2) { $y2 = $b.Y + $b.Height }
    }
    $lines += [pscustomobject]@{
        text = $line.Text
        x    = [int][math]::Round($x1 / $Scale)
        y    = [int][math]::Round($y1 / $Scale)
        w    = [int][math]::Round(($x2 - $x1) / $Scale)
        h    = [int][math]::Round(($y2 - $y1) / $Scale)
    }
}

$payload = [pscustomobject]@{
    image      = $ImagePath
    pageWidth  = [int]$origW
    pageHeight = [int]$origH
    scale      = $Scale
    invert     = $doInvert
    brightness = [int][math]::Round($brightness)
    lang       = $LangTag
    lines      = $lines
}

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$dir = [System.IO.Path]::GetDirectoryName($OutPath)
if (-not [string]::IsNullOrWhiteSpace($dir) -and -not (Test-Path -LiteralPath $dir)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
}
[System.IO.File]::WriteAllText($OutPath, ($payload | ConvertTo-Json -Depth 6), $utf8NoBom)

if (Test-Path -LiteralPath $workPath) {
    Remove-Item -LiteralPath $workPath -Force -ErrorAction SilentlyContinue
}

Write-Output ('OK lines=' + $lines.Count + ' scale=' + $Scale + ' invert=' + [int]$doInvert + ' bright=' + [int][math]::Round($brightness))
