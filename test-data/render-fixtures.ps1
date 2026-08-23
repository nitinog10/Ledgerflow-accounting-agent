Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$outputDirectory = Join-Path $PSScriptRoot 'invoices'
$cases = (Get-Content -LiteralPath (Join-Path $PSScriptRoot 'expected-results.json') -Raw | ConvertFrom-Json).cases
New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null

function New-Brush([int]$red, [int]$green, [int]$blue) {
  [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb($red, $green, $blue))
}

function Draw-Text($graphics, [string]$text, [float]$x, [float]$y, [float]$size, [System.Drawing.FontStyle]$style, $brush) {
  $font = [System.Drawing.Font]::new('Arial', $size, $style)
  $graphics.DrawString($text, $font, $brush, $x, $y)
  $font.Dispose()
}

function Format-Amount($amount) {
  if ($null -eq $amount) { return '-' }
  return ('{0:N2}' -f [double]$amount)
}

foreach ($case in $cases) {
  $fields = $case.expectedFields
  $isLowQuality = $case.id -eq 'low-quality-missing-quantity'
  $scale = if ($isLowQuality) { 0.55 } else { 1.0 }
  $width = [int](1040 * $scale)
  $height = [int](1420 * $scale)
  $bitmap = [System.Drawing.Bitmap]::new($width, $height)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.Clear([System.Drawing.Color]::White)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit

  $blue = New-Brush 24 75 155
  $dark = New-Brush 23 32 51
  $gray = New-Brush 79 89 109
  $white = New-Brush 255 255 255
  $linePen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(208, 213, 221), [float](1 * $scale))
  $bluePen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(24, 75, 155), [float](4 * $scale))
  $left = 64 * $scale
  $right = $width - (64 * $scale)
  $y = 56 * $scale
  $invoiceDate = [datetime]::Parse($fields.invoiceDate).ToString('dd MMM yyyy')
  $supplierGstin = if ($null -eq $fields.gstin) { 'GSTIN:' } else { "GSTIN: $($fields.gstin)" }
  $displayTotal = if ($fields.PSObject.Properties.Name -contains 'displayedTotal') { $fields.displayedTotal } else { $fields.total }

  Draw-Text $graphics $fields.vendorName $left $y (30 * $scale) ([System.Drawing.FontStyle]::Bold) $blue
  Draw-Text $graphics 'Tax Invoice' ($right - (170 * $scale)) $y (24 * $scale) ([System.Drawing.FontStyle]::Bold) $blue
  $y += 45 * $scale
  Draw-Text $graphics 'Synthetic LedgerFlow test fixture' $left $y (13 * $scale) ([System.Drawing.FontStyle]::Regular) $gray
  Draw-Text $graphics "Invoice No: $($fields.invoiceNumber)" ($right - (240 * $scale)) $y (14 * $scale) ([System.Drawing.FontStyle]::Regular) $dark
  $y += 27 * $scale
  Draw-Text $graphics 'Govindpura Industrial Area, Bhopal, MP' $left $y (13 * $scale) ([System.Drawing.FontStyle]::Regular) $gray
  Draw-Text $graphics "Invoice Date: $invoiceDate" ($right - (240 * $scale)) $y (14 * $scale) ([System.Drawing.FontStyle]::Regular) $dark
  $y += 35 * $scale
  $graphics.DrawLine($bluePen, $left, $y, $right, $y)
  $y += 42 * $scale

  Draw-Text $graphics 'Supplier Details' $left $y (13 * $scale) ([System.Drawing.FontStyle]::Bold) $gray
  Draw-Text $graphics 'Bill To' (560 * $scale) $y (13 * $scale) ([System.Drawing.FontStyle]::Bold) $gray
  $y += 28 * $scale
  Draw-Text $graphics $fields.vendorName $left $y (18 * $scale) ([System.Drawing.FontStyle]::Bold) $dark
  Draw-Text $graphics 'Demo Buyer Pvt Ltd' (560 * $scale) $y (18 * $scale) ([System.Drawing.FontStyle]::Bold) $dark
  $y += 29 * $scale
  Draw-Text $graphics $supplierGstin $left $y (15 * $scale) ([System.Drawing.FontStyle]::Regular) $dark
  Draw-Text $graphics 'GSTIN: 23FAKEP5678L1Z3' (560 * $scale) $y (15 * $scale) ([System.Drawing.FontStyle]::Regular) $dark
  $y += 62 * $scale

  $columns = @(64, 120, 465, 600, 760, 976) | ForEach-Object { $_ * $scale }
  $headerHeight = 38 * $scale
  $graphics.FillRectangle($blue, $left, $y, ($right - $left), $headerHeight)
  $headers = @('Sr.', 'Description', 'Qty', 'Rate', 'Amount')
  for ($index = 0; $index -lt $headers.Count; $index++) {
    Draw-Text $graphics $headers[$index] ($columns[$index] + (8 * $scale)) ($y + (9 * $scale)) (13 * $scale) ([System.Drawing.FontStyle]::Bold) $white
  }
  $y += $headerHeight
  $rowHeight = 44 * $scale
  $lineNumber = 1
  foreach ($item in $fields.lineItems) {
    $graphics.DrawRectangle($linePen, $left, $y, ($right - $left), $rowHeight)
    foreach ($column in $columns[1..4]) { $graphics.DrawLine($linePen, $column, $y, $column, ($y + $rowHeight)) }
    Draw-Text $graphics "$lineNumber" ($columns[0] + (8 * $scale)) ($y + (10 * $scale)) (14 * $scale) ([System.Drawing.FontStyle]::Regular) $dark
    Draw-Text $graphics $item.name ($columns[1] + (8 * $scale)) ($y + (10 * $scale)) (14 * $scale) ([System.Drawing.FontStyle]::Regular) $dark
    Draw-Text $graphics (Format-Amount $item.quantity) ($columns[2] + (8 * $scale)) ($y + (10 * $scale)) (14 * $scale) ([System.Drawing.FontStyle]::Regular) $dark
    Draw-Text $graphics "Rs. $(Format-Amount $item.rate)" ($columns[3] + (8 * $scale)) ($y + (10 * $scale)) (14 * $scale) ([System.Drawing.FontStyle]::Regular) $dark
    Draw-Text $graphics "Rs. $(Format-Amount $item.amount)" ($columns[4] + (8 * $scale)) ($y + (10 * $scale)) (14 * $scale) ([System.Drawing.FontStyle]::Regular) $dark
    $y += $rowHeight
    $lineNumber++
  }

  $y += 55 * $scale
  $totalsX = 620 * $scale
  $totalRows = @(@('Subtotal', $fields.subtotal), @('CGST', $fields.cgst), @('SGST', $fields.sgst), @('IGST', $fields.igst))
  foreach ($row in $totalRows) {
    Draw-Text $graphics $row[0] $totalsX $y (15 * $scale) ([System.Drawing.FontStyle]::Regular) $dark
    Draw-Text $graphics "Rs. $(Format-Amount $row[1])" (820 * $scale) $y (15 * $scale) ([System.Drawing.FontStyle]::Regular) $dark
    $y += 30 * $scale
  }
  $graphics.DrawLine($bluePen, $totalsX, $y, $right, $y)
  $y += 10 * $scale
  Draw-Text $graphics 'Invoice Total' $totalsX $y (20 * $scale) ([System.Drawing.FontStyle]::Bold) $blue
  Draw-Text $graphics "Rs. $(Format-Amount $displayTotal)" (825 * $scale) $y (19 * $scale) ([System.Drawing.FontStyle]::Bold) $blue

  $footerY = $height - (105 * $scale)
  $graphics.DrawLine($linePen, $left, $footerY, $right, $footerY)
  Draw-Text $graphics 'Computer generated invoice for software testing only.' $left ($footerY + (20 * $scale)) (12 * $scale) ([System.Drawing.FontStyle]::Regular) $gray
  Draw-Text $graphics 'Authorized Signatory' ($right - (170 * $scale)) ($footerY + (20 * $scale)) (12 * $scale) ([System.Drawing.FontStyle]::Regular) $gray

  $outputPath = Join-Path $outputDirectory $case.fileName
  if ($isLowQuality) {
    $upscaled = [System.Drawing.Bitmap]::new(1040, 1420)
    $upscaledGraphics = [System.Drawing.Graphics]::FromImage($upscaled)
    $upscaledGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::Low
    $upscaledGraphics.DrawImage($bitmap, 0, 0, 1040, 1420)
    $upscaled.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $upscaledGraphics.Dispose()
    $upscaled.Dispose()
  } else {
    $bitmap.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png)
  }

  $graphics.Dispose()
  $bitmap.Dispose()
  $blue.Dispose()
  $dark.Dispose()
  $gray.Dispose()
  $white.Dispose()
  $linePen.Dispose()
  $bluePen.Dispose()
}
