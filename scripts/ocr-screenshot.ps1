# OCR an image (default: 2x upscale first, which markedly improves small/grey text),
# then emit JSON lines with bounding boxes mapped back to ORIGINAL image coordinates.
# ASCII-only: PowerShell 5.1 reads .ps1 as ANSI. No Chinese literals here.
param(
    [Parameter(Mandatory = $true)][string]$ImagePath,
    [string]$OutPath = '',
    [string]$LangTag = 'zh-Hans-CN',
    [int]$Scale = 2
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
$workPath = [System.IO.Path]::GetFullPath($ImagePath + '.upscaled.png').Replace('/', '\')

if ($Scale -gt 1) {
    $bmp = New-Object System.Drawing.Bitmap(($origW * $Scale), ($origH * $Scale))
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.DrawImage($src, 0, 0, $bmp.Width, $bmp.Height)
    $g.Dispose()
    $bmp.Save($workPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
} else {
    $workPath = (Resolve-Path -LiteralPath $ImagePath).Path
}
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

$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($workPath)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

$lang = New-Object Windows.Globalization.Language $LangTag
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
if ($null -eq $engine) {
    Write-Output 'ERR code=OCR_ENGINE_UNAVAILABLE'
    exit 3
}

$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])

# 坐标换算回原图尺寸（调用方按原始像素判断左右与排序）
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
    lang       = $LangTag
    lines      = $lines
}

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$dir = [System.IO.Path]::GetDirectoryName($OutPath)
if (-not [string]::IsNullOrWhiteSpace($dir) -and -not (Test-Path -LiteralPath $dir)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
}
[System.IO.File]::WriteAllText($OutPath, ($payload | ConvertTo-Json -Depth 6), $utf8NoBom)

if ($Scale -gt 1 -and (Test-Path -LiteralPath $workPath)) {
    Remove-Item -LiteralPath $workPath -Force -ErrorAction SilentlyContinue
}

Write-Output ('OK lines=' + $lines.Count + ' scale=' + $Scale)
