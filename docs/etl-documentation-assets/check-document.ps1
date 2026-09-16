$ErrorActionPreference = 'Stop'
$docPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\I-and-C-Laundry-ETL-Technical-Metadata.docx'))
$pdfPath = Join-Path $PSScriptRoot 'layout-preview.pdf'
$docApp = $null
$docFile = $null
try {
    $docApp = New-Object -ComObject Word.Application
    $docApp.Visible = $false
    $docApp.DisplayAlerts = 0
    $docFile = $docApp.Documents.Open($docPath, $false, $true, $false)
    $docFile.Repaginate()
    $pageCount = $docFile.ComputeStatistics(2)
    Write-Output "Pages: $pageCount; Tables: $($docFile.Tables.Count); Inline figures: $($docFile.InlineShapes.Count)"
    for ($pageIndex = 1; $pageIndex -le $pageCount; $pageIndex++) {
        $pageStart = $docFile.GoTo(1, 1, $pageIndex).Start
        $pageEnd = if ($pageIndex -lt $pageCount) { $docFile.GoTo(1, 1, ($pageIndex + 1)).Start } else { $docFile.Content.End }
        $pageRange = $docFile.Range($pageStart, $pageEnd)
        $pageText = $pageRange.Text -replace '[\r\a\v\f]+', ' | '
        Write-Output ("Page {0}: {1}" -f $pageIndex, $pageText.Substring(0, [Math]::Min(230, $pageText.Length)))
        Write-Output ("Page {0} ending: {1}" -f $pageIndex, $pageText.Substring([Math]::Max(0, $pageText.Length - 200)))
    }
    for ($tableIndex = 1; $tableIndex -le $docFile.Tables.Count; $tableIndex++) {
        $table = $docFile.Tables.Item($tableIndex)
        $start = $docFile.Range($table.Range.Start, $table.Range.Start)
        $end = $docFile.Range($table.Range.End - 1, $table.Range.End - 1)
        Write-Output ("Table {0}: {1} rows; pages {2}-{3}" -f $tableIndex, $table.Rows.Count, $start.Information(3), $end.Information(3))
    }
    $docFile.ExportAsFixedFormat($pdfPath, 17)
    Write-Output "PDF preview: $pdfPath"
} finally {
    if ($null -ne $docFile) { $docFile.Close(0); [void][Runtime.InteropServices.Marshal]::ReleaseComObject($docFile) }
    if ($null -ne $docApp) {
        try { $docApp.Quit() } catch [Runtime.InteropServices.COMException] {
            if ($_.Exception.HResult -ne -2147023174) { throw }
        }
        [void][Runtime.InteropServices.Marshal]::ReleaseComObject($docApp)
    }
}
