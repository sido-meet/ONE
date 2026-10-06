param(
  [Parameter(Mandatory = $true)][string]$In,
  [Parameter(Mandatory = $true)][string]$Out,
  [Parameter(Mandatory = $true)][int]$X,
  [Parameter(Mandatory = $true)][int]$Y,
  [Parameter(Mandatory = $true)][int]$W,
  [Parameter(Mandatory = $true)][int]$H,
  [double]$Scale = 2.0
)

Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile($In)
$target = New-Object System.Drawing.Bitmap ([int]($W * $Scale)), ([int]($H * $Scale))
$g = [System.Drawing.Graphics]::FromImage($target)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
$g.DrawImage($src, (New-Object System.Drawing.Rectangle 0, 0, ([int]($W * $Scale)), ([int]($H * $Scale))), (New-Object System.Drawing.Rectangle $X, $Y, $W, $H), [System.Drawing.GraphicsUnit]::Pixel)
$target.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $target.Dispose(); $src.Dispose()
"saved $Out"
