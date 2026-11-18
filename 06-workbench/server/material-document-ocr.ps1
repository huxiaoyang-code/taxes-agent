# Windows 自带 OCR 的本机内存入口；不写原件、不访问网络、不启动外部模型。
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
    [Windows.Globalization.Language, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
    $languages = @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object { $_.LanguageTag })
    $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
    if ($request.operation -eq 'capabilities') {
        @{ status = $(if ($languages.Count) { 'available' } else { 'needs_runtime' }); id = 'windows-media-ocr'; version = [Environment]::OSVersion.Version.ToString(); languages = $languages } | ConvertTo-Json -Compress -Depth 5
        exit 0
    }
    if (-not $languages.Count) { throw 'ocr_language_unavailable' }
    $asyncMethod = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetGenericArguments().Length -eq 1 -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1
    function Await-Operation($operation, $resultType) {
        $task = $asyncMethod.MakeGenericMethod($resultType).Invoke($null, @($operation))
        $task.GetAwaiter().GetResult()
    }
    [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
    [Windows.Storage.Streams.DataWriter, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
    [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
    [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
    [Windows.Media.Ocr.OcrResult, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
    $bytes = [Convert]::FromBase64String($request.data)
    if ($bytes.Length -gt 8388608) { throw 'ocr_image_limit' }
    $stream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
    $writer = New-Object Windows.Storage.Streams.DataWriter($stream)
    $writer.WriteBytes($bytes)
    $stored = Await-Operation $writer.StoreAsync() ([UInt32])
    $writer.DetachStream() | Out-Null
    $stream.Seek(0)
    $decoder = Await-Operation ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    if ($decoder.PixelWidth -gt [Windows.Media.Ocr.OcrEngine]::MaxImageDimension -or $decoder.PixelHeight -gt [Windows.Media.Ocr.OcrEngine]::MaxImageDimension) { throw 'ocr_image_limit' }
    $bitmap = Await-Operation ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $language = if ($languages -contains 'zh-Hans-CN') { 'zh-Hans-CN' } else { $languages[0] }
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage((New-Object Windows.Globalization.Language($language)))
    $result = Await-Operation ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
    $lines = @($result.Lines | ForEach-Object {
        $words = @($_.Words)
        $left = ($words | ForEach-Object { $_.BoundingRect.X } | Measure-Object -Minimum).Minimum
        $top = ($words | ForEach-Object { $_.BoundingRect.Y } | Measure-Object -Minimum).Minimum
        $right = ($words | ForEach-Object { $_.BoundingRect.X + $_.BoundingRect.Width } | Measure-Object -Maximum).Maximum
        $bottom = ($words | ForEach-Object { $_.BoundingRect.Y + $_.BoundingRect.Height } | Measure-Object -Maximum).Maximum
        @{ text = $_.Text; bbox = @($left, $top, $right, $bottom) }
    })
    @{ status = 'read'; id = 'windows-media-ocr'; version = [Environment]::OSVersion.Version.ToString(); language = $language; lines = $lines } | ConvertTo-Json -Compress -Depth 7
    $bitmap.Dispose()
    $stream.Dispose()
} catch {
    @{ status = 'needs_runtime'; error = 'ocr_runtime_unavailable'; id = 'windows-media-ocr' } | ConvertTo-Json -Compress
}
