# 打包上线内容为 dist/excavator.tar.gz
#
# 只收集真正要上线的文件：index.html + assets/**。
# tests / tools / deploy / .verify 一律不进包。
# 打包前会做三项体检：文件是否存在、编码是否为无 BOM 的 UTF-8、是否含本地调试残留。

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root 'dist'
$stage = Join-Path $dist 'stage'

Write-Host "项目根目录：$root"

# ---------- 1. 收集文件 ----------
$files = @('index.html')
$assets = Join-Path $root 'assets'
if (-not (Test-Path $assets)) { throw "找不到 assets 目录：$assets" }
$files += Get-ChildItem -Path $assets -Recurse -File |
  ForEach-Object { $_.FullName.Substring($root.Length + 1).Replace('\', '/') }

foreach ($f in $files) {
  $full = Join-Path $root $f
  if (-not (Test-Path $full)) { throw "缺少上线文件：$f" }
}
Write-Host "`n待打包 $($files.Count) 个文件："
$files | ForEach-Object { Write-Host "  $_" }

# ---------- 2. 体检：编码与调试残留 ----------
$problems = @()
foreach ($f in $files) {
  $full = Join-Path $root $f
  $bytes = [System.IO.File]::ReadAllBytes($full)

  # UTF-8 BOM 会让浏览器把中文变乱码
  if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
    $problems += "$f 带 UTF-8 BOM，浏览器可能显示乱码"
  }
  # 必须能按 UTF-8 严格解码
  try {
    $strict = New-Object System.Text.UTF8Encoding($false, $true)
    $text = $strict.GetString($bytes)
  } catch {
    $problems += "$f 不是合法 UTF-8"
    continue
  }
  if ($text -match '127\.0\.0\.1|localhost:\d+') {
    $problems += "$f 含本地调试地址"
  }
  if ($text -match '\uFFFD') {
    $problems += "$f 含替换字符（乱码）"
  }
}

if ($problems.Count -gt 0) {
  Write-Host "`n体检未通过：" -ForegroundColor Red
  $problems | ForEach-Object { Write-Host "  ✗ $_" -ForegroundColor Red }
  throw '打包中止'
}
Write-Host "`n体检通过：UTF-8 无 BOM、无本地地址残留、无乱码" -ForegroundColor Green

# ---------- 3. 暂存并打包 ----------
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage -Force | Out-Null
foreach ($f in $files) {
  $dest = Join-Path $stage $f
  New-Item -ItemType Directory -Path (Split-Path $dest -Parent) -Force | Out-Null
  Copy-Item (Join-Path $root $f) $dest
}

$tarPath = Join-Path $dist 'excavator.tar.gz'
if (Test-Path $tarPath) { Remove-Item $tarPath -Force }
Push-Location $stage
try {
  & tar -czf $tarPath .
  if ($LASTEXITCODE -ne 0) { throw "tar 打包失败（exit $LASTEXITCODE）" }
} finally {
  Pop-Location
}
Remove-Item $stage -Recurse -Force

$size = (Get-Item $tarPath).Length
Write-Host "`n打包完成：$tarPath  ($([math]::Round($size / 1KB, 1)) KB)" -ForegroundColor Green
Write-Host "`n包内清单："
& tar -tzf $tarPath | ForEach-Object { Write-Host "  $_" }
