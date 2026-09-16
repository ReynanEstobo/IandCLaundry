param(
    [string]$OutputDirectory = $PSScriptRoot
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$script:Palette = @{
    Navy = '#17324D'
    Teal = '#087E8B'
    Ink = '#223D52'
    Muted = '#506A7C'
    Border = '#C5D8E3'
    Pale = '#F2F7FA'
    White = '#FFFFFF'
    TealPale = '#E4F4F3'
}

function Get-Color([string]$Value) {
    return [System.Drawing.ColorTranslator]::FromHtml($Value)
}

function New-Canvas([int]$Width, [int]$Height) {
    $script:Bitmap = [System.Drawing.Bitmap]::new($Width, $Height)
    $script:Bitmap.SetResolution(160, 160)
    $script:Graphics = [System.Drawing.Graphics]::FromImage($script:Bitmap)
    $script:Graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $script:Graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $script:Graphics.Clear([System.Drawing.Color]::White)
}

function Draw-Box {
    param(
        [float]$X, [float]$Y, [float]$Width, [float]$Height,
        [string]$Fill = $script:Palette.White,
        [string]$Stroke = $script:Palette.Border,
        [float]$Radius = 18,
        [float]$StrokeWidth = 2
    )
    $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
    $diameter = $Radius * 2
    $path.AddArc($X, $Y, $diameter, $diameter, 180, 90)
    $path.AddArc($X + $Width - $diameter, $Y, $diameter, $diameter, 270, 90)
    $path.AddArc($X + $Width - $diameter, $Y + $Height - $diameter, $diameter, $diameter, 0, 90)
    $path.AddArc($X, $Y + $Height - $diameter, $diameter, $diameter, 90, 90)
    $path.CloseFigure()
    $brush = [System.Drawing.SolidBrush]::new((Get-Color $Fill))
    $pen = [System.Drawing.Pen]::new((Get-Color $Stroke), $StrokeWidth)
    try {
        $script:Graphics.FillPath($brush, $path)
        $script:Graphics.DrawPath($pen, $path)
    } finally {
        $brush.Dispose()
        $pen.Dispose()
        $path.Dispose()
    }
}

function Draw-Text {
    param(
        [string]$Text,
        [float]$X, [float]$Y, [float]$Width, [float]$Height,
        [float]$Size = 34,
        [string]$Color = $script:Palette.Ink,
        [switch]$Bold,
        [ValidateSet('Near', 'Center', 'Far')][string]$Align = 'Near'
    )
    $style = [System.Drawing.FontStyle]::Regular
    if ($Bold) { $style = [System.Drawing.FontStyle]::Bold }
    $font = [System.Drawing.Font]::new('Segoe UI', $Size, $style, [System.Drawing.GraphicsUnit]::Pixel)
    $brush = [System.Drawing.SolidBrush]::new((Get-Color $Color))
    $format = [System.Drawing.StringFormat]::new()
    $format.Alignment = [System.Drawing.StringAlignment]::$Align
    $format.LineAlignment = [System.Drawing.StringAlignment]::Near
    $format.Trimming = [System.Drawing.StringTrimming]::None
    try {
        $measured = $script:Graphics.MeasureString($Text, $font, [System.Drawing.SizeF]::new($Width, 10000), $format)
        # Keep all text inside its actual measured box across installed font versions.
        while ($measured.Height -gt $Height -or $measured.Width -gt $Width) {
            $Size -= 0.5
            if ($Size -lt 22) { throw "Text does not fit its allocated box: $Text" }
            $font.Dispose()
            $font = [System.Drawing.Font]::new('Segoe UI', $Size, $style, [System.Drawing.GraphicsUnit]::Pixel)
            $measured = $script:Graphics.MeasureString($Text, $font, [System.Drawing.SizeF]::new($Width, 10000), $format)
        }
        $rectangle = [System.Drawing.RectangleF]::new($X, $Y, $Width, $Height)
        $script:Graphics.DrawString($Text, $font, $brush, $rectangle, $format)
    } finally {
        $format.Dispose()
        $brush.Dispose()
        $font.Dispose()
    }
}

function Draw-Arrow {
    param(
        [float[]]$Path,
        [string]$Color = $script:Palette.Teal,
        [switch]$Dashed,
        [switch]$NoHead,
        [float]$Width = 4
    )
    $points = [System.Collections.Generic.List[System.Drawing.PointF]]::new()
    for ($i = 0; $i -lt $Path.Count; $i += 2) {
        $points.Add([System.Drawing.PointF]::new($Path[$i], $Path[$i + 1]))
    }
    $pen = [System.Drawing.Pen]::new((Get-Color $Color), $Width)
    $brush = [System.Drawing.SolidBrush]::new((Get-Color $Color))
    try {
        if ($Dashed) { $pen.DashPattern = [float[]]@(3, 2) }
        $script:Graphics.DrawLines($pen, $points.ToArray())
        if (-not $NoHead) {
            $tip = $points[$points.Count - 1]
            $previous = $points[$points.Count - 2]
            $angle = [Math]::Atan2($tip.Y - $previous.Y, $tip.X - $previous.X)
            $length = 16
            $halfWidth = 8
            $baseX = $tip.X - $length * [Math]::Cos($angle)
            $baseY = $tip.Y - $length * [Math]::Sin($angle)
            $triangle = [System.Drawing.PointF[]]@(
                $tip,
                [System.Drawing.PointF]::new($baseX - $halfWidth * [Math]::Sin($angle), $baseY + $halfWidth * [Math]::Cos($angle)),
                [System.Drawing.PointF]::new($baseX + $halfWidth * [Math]::Sin($angle), $baseY - $halfWidth * [Math]::Cos($angle))
            )
            $script:Graphics.FillPolygon($brush, $triangle)
        }
    } finally {
        $pen.Dispose()
        $brush.Dispose()
    }
}

function Save-Canvas([string]$Name) {
    $target = Join-Path $OutputDirectory $Name
    try {
        $script:Bitmap.Save($target, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally {
        $script:Graphics.Dispose()
        $script:Bitmap.Dispose()
    }
    Get-Item -LiteralPath $target | Select-Object Name, Length, FullName
}

if (-not (Test-Path -LiteralPath $OutputDirectory -PathType Container)) {
    New-Item -ItemType Directory -Path $OutputDirectory | Out-Null
}

# Diagram 1: operational data and both proposed ETL components share one database.
New-Canvas 1800 1230
Draw-Text 'PROPOSED ETL ARCHITECTURE' 60 32 1680 68 48 -Bold -Color $script:Palette.Navy
Draw-Text 'I&C Laundry | SQL batch processing inside the existing database' 60 104 1680 50 32 -Color $script:Palette.Muted

Draw-Text 'EXISTING BRANCH OPERATIONS' 70 173 1050 45 30 -Bold -Color $script:Palette.Muted
$branches = @('Main', 'Calzada', 'Nasugbu')
for ($i = 0; $i -lt 3; $i++) {
    $x = 70 + $i * 335
    Draw-Box $x 226 290 92 -Fill $script:Palette.White
    Draw-Text $branches[$i] ($x + 12) 244 266 56 38 -Bold -Align Center
    Draw-Arrow -Path @(($x + 145), 318, ($x + 145), 349) -NoHead
}
Draw-Arrow -Path @(215, 349, 885, 349) -NoHead

Draw-Box 1244 171 490 178 -Fill $script:Palette.TealPale -Stroke $script:Palette.Teal
Draw-Text 'Supabase Cron / pg_cron' 1263 186 452 85 35 -Bold -Align Center -Color $script:Palette.Navy
Draw-Text "Proposed daily schedule`n01:00 Asia/Manila" 1263 272 452 68 28 -Align Center

Draw-Box 55 397 1690 559 -Fill $script:Palette.Pale -Stroke $script:Palette.Border -Radius 24
Draw-Text 'ONE EXISTING SUPABASE / POSTGRESQL DATABASE' 83 416 1450 50 34 -Bold -Color $script:Palette.Navy
Draw-Text 'Operational source + proposed SQL ETL + reporting destinations' 83 463 1190 43 28 -Color $script:Palette.Muted

Draw-Arrow -Path @(215, 349, 30, 349, 30, 725, 90, 725)
Draw-Arrow -Path @(1490, 349, 1490, 517, 890, 517, 890, 545) -Dashed -Color $script:Palette.Navy
Draw-Box 1041 492 280 48 -Fill $script:Palette.Pale -Stroke $script:Palette.Pale -Radius 4
Draw-Text 'starts SQL function' 1047 496 268 43 27 -Align Center -Color $script:Palette.Navy

Draw-Box 90 548 420 342
Draw-Text 'EXISTING' 115 568 368 40 27 -Bold -Color $script:Palette.Muted
Draw-Text 'Operational tables' 115 618 368 88 37 -Bold -Color $script:Palette.Navy
Draw-Text "orders`nbranches`nservice_types" 115 715 368 145 36

Draw-Box 680 548 420 342 -Fill $script:Palette.TealPale -Stroke $script:Palette.Teal
Draw-Text 'PROPOSED' 705 568 370 40 27 -Bold -Color $script:Palette.Teal
Draw-Text 'SQL ETL function' 705 618 370 88 37 -Bold -Color $script:Palette.Navy
Draw-Text "Extract one snapshot`nClean + validate`nAggregate totals" 705 715 370 150 34

Draw-Box 1265 548 440 342 -Stroke $script:Palette.Teal
Draw-Text 'PROPOSED' 1290 568 390 40 27 -Bold -Color $script:Palette.Teal
Draw-Text "Reporting`nSummary Tables" 1290 618 390 98 37 -Bold -Color $script:Palette.Navy
Draw-Text "Daily branch totals`nBranch/service totals" 1290 752 390 103 34

Draw-Arrow -Path @(510, 725, 680, 725)
Draw-Text 'read' 527 673 135 43 29 -Align Center -Color $script:Palette.Teal
Draw-Arrow -Path @(1100, 725, 1265, 725)
Draw-Text 'refresh' 1113 673 136 43 29 -Align Center -Color $script:Palette.Teal

Draw-Arrow -Path @(1485, 890, 1485, 1040)
Draw-Text 'proposed connection' 1145 981 326 46 28 -Align Far -Color $script:Palette.Teal
Draw-Box 1125 1042 580 133 -Fill $script:Palette.White
Draw-Text 'Existing dashboards / APIs' 1144 1055 542 55 34 -Bold -Align Center -Color $script:Palette.Navy
Draw-Text 'Read refreshed summaries' 1144 1112 542 50 32 -Align Center

Draw-Arrow -Path @(82, 1025, 194, 1025)
Draw-Text 'Data flow' 215 1002 360 50 32
Draw-Arrow -Path @(82, 1090, 194, 1090) -Dashed -Color $script:Palette.Navy
Draw-Text 'Job control' 215 1067 360 50 32
Draw-Text 'The ETL function and summary tables are proposed additions to the existing database.' 74 1175 1640 45 27 -Color $script:Palette.Muted
Save-Canvas 'architecture.png'

# Diagram 2: a chronological lineage timeline, not an elapsed-time chart.
New-Canvas 1800 1010
Draw-Text 'DATA LINEAGE TIMELINE' 60 32 1680 68 48 -Bold -Color $script:Palette.Navy
Draw-Text 'Proposed daily run | Follow the numbered stages from left to right.' 60 107 1680 50 32 -Color $script:Palette.Muted

$steps = @(
    @{ Title = 'Source'; Time = "Before`nscheduled run"; Body = "Saved orders`nfrom each`nbranch"; Detail = 'Operational tables' },
    @{ Title = 'Extract'; Time = "01:00`nAsia/Manila"; Body = "Read one`nconsistent`nsnapshot"; Detail = 'SQL ETL begins' },
    @{ Title = "Validate /`nclean"; Time = 'Then'; Body = "Check dates,`nkeys and`ndecimal values"; Detail = 'SQL validation' },
    @{ Title = 'Transform'; Time = 'Then'; Body = "Group by date`nand branch /`nservice"; Detail = 'SQL aggregation' },
    @{ Title = 'Load'; Time = 'Then'; Body = "Atomically`nrefresh the`nsummary tables"; Detail = 'Reporting summaries' },
    @{ Title = 'Use'; Time = 'Then'; Body = "Dashboards`nand reports`nread summaries"; Detail = 'Proposed connection' }
)

for ($i = 0; $i -lt 5; $i++) {
    $center = 180 + $i * 288
    Draw-Arrow -Path @(($center + 43), 233, ($center + 239), 233) -Width 5
}
for ($i = 0; $i -lt 6; $i++) {
    $x = 44 + $i * 288
    $center = $x + 136
    $circle = [System.Drawing.SolidBrush]::new((Get-Color $script:Palette.Teal))
    try { $script:Graphics.FillEllipse($circle, [float]($center - 41), [float]192, [float]82, [float]82) }
    finally { $circle.Dispose() }
    Draw-Text ([string]($i + 1)) ($center - 37) 204 74 60 39 -Bold -Align Center -Color $script:Palette.White
    Draw-Text $steps[$i].Time ($x + 8) 293 256 88 29 -Align Center -Color $script:Palette.Muted

    $fill = $script:Palette.White
    if ($i -ge 1 -and $i -le 4) { $fill = $script:Palette.TealPale }
    Draw-Box $x 397 272 369 -Fill $fill
    Draw-Text $steps[$i].Title ($x + 13) 423 246 98 35 -Bold -Align Center -Color $script:Palette.Navy
    Draw-Text $steps[$i].Body ($x + 13) 550 246 150 32 -Align Center
    Draw-Text $steps[$i].Detail ($x + 12) 709 248 51 22 -Align Center -Color $script:Palette.Muted
}

Draw-Box 60 819 1680 92 -Fill $script:Palette.Pale -Stroke $script:Palette.Border
Draw-Text 'If validation fails: stop the job and retain the previous summary tables.' 86 842 1628 49 32 -Bold -Color $script:Palette.Navy
Draw-Text 'This timeline shows the order of operations, not measured runtime. No stage durations are assumed.' 64 945 1672 44 27 -Color $script:Palette.Muted
Save-Canvas 'lineage-timeline.png'
