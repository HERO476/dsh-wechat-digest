# OCR a chat screenshot and emit JSON lines with bounding boxes.
# ASCII-only on purpose: PowerShell 5.1 reads .ps1 as ANSI, so non-ASCII literals here
# would be mojibake. All Chinese lives in the caller's data files.
param(
    [Parameter(Mandatory = $true)][string]$ImagePath,
    [string]$OutPath = '',
    [string]$LangTag = 'zh-Hans-CN'
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $ImagePath)) {
    Write-Output ('ERR image not found: ' + $ImagePath)
    exit 2
}
if ([string]::IsNullOrWhiteSpace($OutPath)) {
    $OutPath = [System.IO.Path]::ChangeExtension($ImagePath, '.ocr.json')
}

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

$full = (Resolve-Path -LiteralPath $ImagePath).Path
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($full)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

$lang = New-Object Windows.Globalization.Language $LangTag
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
if ($null -eq $engine) {
    Write-Output ('ERR ocr engine unavailable for ' + $LangTag)
    exit 3
}

$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])

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
        x    = [int]$x1
        y    = [int]$y1
        w    = [int]($x2 - $x1)
        h    = [int]($y2 - $y1)
    }
}

$payload = [pscustomobject]@{
    image      = $full
    pageWidth  = [int]$decoder.PixelWidth
    pageHeight = [int]$decoder.PixelHeight
    lang       = $LangTag
    lines      = $lines
}

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($OutPath, ($payload | ConvertTo-Json -Depth 6), $utf8NoBom)
Write-Output ('OK lines=' + $lines.Count + ' out=' + $OutPath)
