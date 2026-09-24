param(
    [string]$PdfPath = (Join-Path $PSScriptRoot 'layout-preview.pdf'),
    [string]$OutputDirectory = $PSScriptRoot
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
Add-Type -AssemblyName System.Drawing
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType = WindowsRuntime]
$null = [Windows.Data.Pdf.PdfPageRenderOptions, Windows.Data.Pdf, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and $_.GetGenericArguments().Count -eq 1 -and
    $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
} | Select-Object -First 1
$asActionTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and -not $_.IsGenericMethod -and
    $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction'
} | Select-Object -First 1
function Complete-WinRT($operation, [Type]$resultType) {
    $task = $asTask.MakeGenericMethod($resultType).Invoke($null, @($operation))
    $task.GetAwaiter().GetResult()
}
$pdfPath = [IO.Path]::GetFullPath($PdfPath)
[void][IO.Directory]::CreateDirectory($OutputDirectory)
$file = Complete-WinRT ([Windows.Storage.StorageFile]::GetFileFromPathAsync($pdfPath)) ([Windows.Storage.StorageFile])
$pdf = Complete-WinRT ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])
for ($i = 0; $i -lt $pdf.PageCount; $i++) {
    $page = $pdf.GetPage($i)
    $memory = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
    $options = New-Object Windows.Data.Pdf.PdfPageRenderOptions
    $options.DestinationWidth = 1200
    $action = $page.RenderToStreamAsync($memory, $options)
    $actionTask = $asActionTask.Invoke($null, @($action))
    [void]$actionTask.GetAwaiter().GetResult()
    $memory.Seek(0)
    $readStream = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($memory)
    $pngPath = Join-Path $OutputDirectory ('page-{0}.png' -f ($i + 1))
    $writeStream = [IO.File]::Create($pngPath)
    $readStream.CopyTo($writeStream)
    $writeStream.Dispose()
    $readStream.Dispose()
    $page.Dispose()
    Write-Output $pngPath
}
