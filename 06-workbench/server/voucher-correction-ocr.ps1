# Windows inbox OCR, operating only on the specified fields of the in-memory original.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Foundation, ContentType=WindowsRuntime]
$null = [Windows.Media.Ocr.OcrResult, Windows.Foundation, ContentType=WindowsRuntime]
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.IsGenericMethod -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation' + [char]96 + '1'
} | Select-Object -First 1
function Await-Result($op, $type) {
    $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
    $task.Wait()
    return $task.Result
}
$inputData = [Console]::In.ReadToEnd() | ConvertFrom-Json
$stream = [IO.MemoryStream]::new([Convert]::FromBase64String($inputData.image))
$bitmap = [Drawing.Bitmap]::new($stream)
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if (!$engine -or $bitmap.Width * [long]$bitmap.Height -gt 40000000) {throw 'OCR unavailable'}
function Read-Area($r, [bool]$layout) {
    if ($r[0]+$r[2] -gt $bitmap.Width -or $r[1]+$r[3] -gt $bitmap.Height -or $r[2]*[long]$r[3] -gt 4000000) {throw 'Invalid crop'}
    $area = [Drawing.Rectangle]::new($r[0],$r[1],$r[2],$r[3])
    $crop = $bitmap.Clone($area,[Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $scale = [Math]::Min(4,[Math]::Max(1,[Math]::Round(40/$r[3])))
    $resized = [Drawing.Bitmap]::new($crop,[int]($crop.Width*$scale),[int]($crop.Height*$scale))
    $png = [IO.MemoryStream]::new()
    $resized.Save($png,[Drawing.Imaging.ImageFormat]::Png)
    $png.Position = 0
    $random = [System.IO.WindowsRuntimeStreamExtensions]::AsRandomAccessStream($png)
    $decoder = Await-Result ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($random)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $pixels = Await-Result ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $result = Await-Result ($engine.RecognizeAsync($pixels)) ([Windows.Media.Ocr.OcrResult])
    if ($layout) {
        foreach ($line in $result.Lines) {
            if ($line.Words.Count -eq 0) {continue}
            $box = $line.Words[0].BoundingRect
            [PSCustomObject]@{text=([string]$line.Text).Trim(); y=($box.Y+$box.Height/2)/$scale}
        }
    } else { ([string]$result.Text).Trim() }
    $pixels.Dispose()
    $random.Dispose()
    $png.Dispose()
    $resized.Dispose()
    $crop.Dispose()
}
$scans = @{}
$rows = foreach ($line in $inputData.lines) {
    $row = @{}
    foreach ($cell in $line.PSObject.Properties) {
        $r = $cell.Value
        $row[$cell.Name] = Read-Area $r $false
    }
    foreach ($column in @('date','party','amount')) {
        $r = $line.$column
        $key = "$($r[0])/$($r[2])"
        if (!$scans.ContainsKey($key)) {
            $scans[$key] = @(Read-Area @($r[0],0,$r[2],$bitmap.Height) $true)
        }
        $row[$column+'Column'] = $scans[$key]
    }
    $row
}
$bitmap.Dispose()
$stream.Dispose()
[Console]::WriteLine((ConvertTo-Json -InputObject @($rows) -Depth 3 -Compress))
