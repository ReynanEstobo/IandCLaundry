param(
    [string]$OutputDirectory = $PSScriptRoot
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

function New-Canvas([int]$Width, [int]$Height) {
    $script:Bitmap = [System.Drawing.Bitmap]::new($Width, $Height)
    $script:Bitmap.SetResolution(300, 300)
    $script:Graphics = [System.Drawing.Graphics]::FromImage($script:Bitmap)
    $script:Graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $script:Graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $script:Graphics.Clear([System.Drawing.Color]::White)
}

function Draw-Text {
    param(
        [string]$Text,
        [float]$X, [float]$Y, [float]$Width, [float]$Height,
        [float]$Size = 38,
        [switch]$Bold,
        [ValidateSet('Near', 'Center', 'Far')][string]$Align = 'Center'
    )
    $style = [System.Drawing.FontStyle]::Regular
    if ($Bold) { $style = [System.Drawing.FontStyle]::Bold }
    $font = [System.Drawing.Font]::new('Arial', $Size, $style, [System.Drawing.GraphicsUnit]::Pixel)
    $format = [System.Drawing.StringFormat]::new()
    $format.Alignment = [System.Drawing.StringAlignment]::$Align
    $format.LineAlignment = [System.Drawing.StringAlignment]::Center
    $format.Trimming = [System.Drawing.StringTrimming]::None
    try {
        $measured = $script:Graphics.MeasureString($Text, $font, [System.Drawing.SizeF]::new($Width, 10000), $format)
        if ($measured.Height -gt $Height -or $measured.Width -gt $Width) {
            throw "Text exceeds its allocated box ($($measured.Width) x $($measured.Height) measured; $Width x $Height available): $Text"
        }
        $rectangle = [System.Drawing.RectangleF]::new($X, $Y, $Width, $Height)
        $script:Graphics.DrawString($Text, $font, [System.Drawing.Brushes]::Black, $rectangle, $format)
    } finally {
        $format.Dispose()
        $font.Dispose()
    }
}

function Draw-Box([float]$X, [float]$Y, [float]$Width, [float]$Height) {
    $pen = [System.Drawing.Pen]::new([System.Drawing.Color]::Black, 3)
    try {
        $script:Graphics.FillRectangle([System.Drawing.Brushes]::White, $X, $Y, $Width, $Height)
        $script:Graphics.DrawRectangle($pen, $X, $Y, $Width, $Height)
    } finally { $pen.Dispose() }
}

function Draw-Cylinder([float]$X, [float]$Y, [float]$Width, [float]$Height) {
    $ovalHeight = [float]62
    $halfOval = $ovalHeight / 2
    $pen = [System.Drawing.Pen]::new([System.Drawing.Color]::Black, 3)
    try {
        $script:Graphics.FillRectangle([System.Drawing.Brushes]::White, $X, ($Y + $halfOval), $Width, ($Height - $ovalHeight))
        $script:Graphics.FillEllipse([System.Drawing.Brushes]::White, $X, ($Y + $Height - $ovalHeight), $Width, $ovalHeight)
        $script:Graphics.DrawArc($pen, $X, ($Y + $Height - $ovalHeight), $Width, $ovalHeight, 0, 180)
        $script:Graphics.DrawLine($pen, $X, ($Y + $halfOval), $X, ($Y + $Height - $halfOval))
        $script:Graphics.DrawLine($pen, ($X + $Width), ($Y + $halfOval), ($X + $Width), ($Y + $Height - $halfOval))
        $script:Graphics.FillEllipse([System.Drawing.Brushes]::White, $X, $Y, $Width, $ovalHeight)
        $script:Graphics.DrawEllipse($pen, $X, $Y, $Width, $ovalHeight)
    } finally { $pen.Dispose() }
}

function Draw-Arrow {
    param([float[]]$Path, [switch]$Dashed, [switch]$NoHead)
    $points = [System.Collections.Generic.List[System.Drawing.PointF]]::new()
    for ($i = 0; $i -lt $Path.Count; $i += 2) {
        $points.Add([System.Drawing.PointF]::new($Path[$i], $Path[$i + 1]))
    }
    $pen = [System.Drawing.Pen]::new([System.Drawing.Color]::Black, 3.5)
    try {
        if ($Dashed) { $pen.DashPattern = [float[]]@(4, 3) }
        $script:Graphics.DrawLines($pen, $points.ToArray())
        if (-not $NoHead) {
            $tip = $points[$points.Count - 1]
            $previous = $points[$points.Count - 2]
            $angle = [Math]::Atan2($tip.Y - $previous.Y, $tip.X - $previous.X)
            $baseX = $tip.X - 19 * [Math]::Cos($angle)
            $baseY = $tip.Y - 19 * [Math]::Sin($angle)
            $triangle = [System.Drawing.PointF[]]@(
                $tip,
                [System.Drawing.PointF]::new($baseX - 10 * [Math]::Sin($angle), $baseY + 10 * [Math]::Cos($angle)),
                [System.Drawing.PointF]::new($baseX + 10 * [Math]::Sin($angle), $baseY - 10 * [Math]::Cos($angle))
            )
            $script:Graphics.FillPolygon([System.Drawing.Brushes]::Black, $triangle)
        }
    } finally { $pen.Dispose() }
}

function Save-Canvas([string]$Name) {
    $target = Join-Path $OutputDirectory $Name
    $width = $script:Bitmap.Width
    $height = $script:Bitmap.Height
    try { $script:Bitmap.Save($target, [System.Drawing.Imaging.ImageFormat]::Png) }
    finally {
        $script:Graphics.Dispose()
        $script:Bitmap.Dispose()
    }
    Write-Output "$Name : $width x $height pixels"
}

if (-not (Test-Path -LiteralPath $OutputDirectory -PathType Container)) {
    New-Item -ItemType Directory -Path $OutputDirectory | Out-Null
}

# Architectural components are logical stages inside one shared database.
New-Canvas 2200 850
Draw-Text 'ETL PIPELINE ARCHITECTURE' 40 18 2120 70 46 -Bold
Draw-Box 30 125 2140 435
Draw-Text 'ONE SHARED SUPABASE / POSTGRESQL DATABASE' 55 139 2090 59 37 -Bold

Draw-Cylinder 55 216 350 286
Draw-Text "Supabase /`nPostgreSQL" 75 279 310 95 39 -Bold
Draw-Text "Operational Data`nOrders, Payments,`nExpenses" 70 365 320 128 35

Draw-Box 465 241 300 244
Draw-Text "SQL`nExtraction" 480 273 270 175 42 -Bold
Draw-Box 825 241 360 244
Draw-Text "SQL`nValidation`n& Cleaning" 840 257 330 206 41 -Bold
Draw-Box 1245 241 345 244
Draw-Text "SQL`nTransformation" 1260 273 315 175 39 -Bold

Draw-Cylinder 1650 216 490 286
Draw-Text "Daily Branch`nSummary Table" 1670 282 450 105 41 -Bold
Draw-Text "in Supabase /`nPostgreSQL" 1670 388 450 95 37

Draw-Arrow -Path @(405, 365, 465, 365)
Draw-Arrow -Path @(765, 365, 825, 365)
Draw-Arrow -Path @(1185, 365, 1245, 365)
Draw-Arrow -Path @(1590, 365, 1650, 365)

# Dashed branches indicate execution control, not additional data stores.
Draw-Arrow -Path @(287, 675, 287, 610, 1895, 610) -Dashed -NoHead
Draw-Arrow -Path @(615, 610, 615, 485) -Dashed
Draw-Arrow -Path @(1005, 610, 1005, 485) -Dashed
Draw-Arrow -Path @(1418, 610, 1418, 485) -Dashed
Draw-Arrow -Path @(1895, 610, 1895, 502) -Dashed
Draw-Box 50 675 475 128
Draw-Text "Supabase Cron /`npg_cron" 65 688 445 101 40 -Bold
Draw-Text "Solid arrows: data flow`nDashed arrows: scheduled SQL execution" 665 690 1450 104 37 -Align Near
Save-Canvas 'branch-reporting-architecture.png'

# The sequence runs left-to-right on top, down, and right-to-left below.
New-Canvas 2200 1180
Draw-Text 'DATA LINEAGE TIMELINE' 40 16 2120 72 46 -Bold

$lineageSteps = @(
    @{ X = 40; Y = 130; Title = '1. Source'; Body = "I&C Laundry saves`nbranch orders,`npayments and`nexpenses." },
    @{ X = 840; Y = 130; Title = '2. Ingestion'; Body = "SQL under Supabase`nCron stages source`nhistory for`nvalidation." },
    @{ X = 1640; Y = 130; Title = '3. Validation'; Body = "SQL checks IDs,`nreferences,`ntimestamps and`namounts." },
    @{ X = 1640; Y = 750; Title = '4. Cleaning'; Body = "SQL standardizes`ndates and joins`nrelated rows.`nOriginals are kept." },
    @{ X = 840; Y = 750; Title = '5. Transformation'; Body = "SQL groups orders,`ncash and expenses`nindependently by`ndate / branch." },
    @{ X = 40; Y = 750; Title = "6. Loading &`nStorage"; Body = "Supabase PostgreSQL`nstores one proposed`nbranch summary table`nin one transaction." }
)
foreach ($step in $lineageSteps) {
    Draw-Box $step.X $step.Y 520 370
    Draw-Text $step.Title ($step.X + 15) ($step.Y + 14) 490 109 42 -Bold
    Draw-Text $step.Body ($step.X + 20) ($step.Y + 135) 480 210 38
}

Draw-Arrow -Path @(560, 315, 840, 315)
Draw-Text "Operational`nrecords" 567 205 266 96 37
Draw-Arrow -Path @(1360, 315, 1640, 315)
Draw-Text "Raw`nsnapshots" 1367 205 266 96 37
Draw-Arrow -Path @(1900, 500, 1900, 750)
Draw-Text "Validated`nrows" 1920 564 253 106 37
Draw-Arrow -Path @(1640, 935, 1360, 935)
Draw-Text "Clean`ndatasets" 1367 825 266 96 37
Draw-Arrow -Path @(840, 935, 560, 935)
Draw-Text "Summary`nmetrics" 567 825 266 96 37
Save-Canvas 'branch-reporting-lineage.png'
