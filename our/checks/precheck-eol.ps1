# ⓪ 前置检查：装配的"字节级复现"前提（行尾 + 仓库配置）
# ─────────────────────────────────────────────────────────────────────────────
# 为什么有这个脚本（真实事故 · 2026-09-13）：
#   派生仓库时用 `git clone` 复制，**系统级 core.autocrlf=true**（Git for Windows 默认）
#   在检出时把 vendored 上游由 LF 转成 CRLF → 装配产物"内容一字不差、哈希却不同"，
#   直接触发 apply.ps1 的 ④ 结果哈希断言。排查花了整整一轮，且一度被误判为"补丁改了内容"。
#
#   教训：字节级复现依赖三件事，全部必须**显式**存在，不能靠环境恰好干净：
#     ① `.gitattributes` 里有 `* -text`（禁止 git 做任何行尾转换）
#     ② 仓库本地 `core.autocrlf=false`（覆盖系统级 true）
#     ③ 工作树里所有**跟踪文件**都是 LF（没有 CRLF 残留）
#   本脚本把这三件事前置成门禁：不满足就 fail-closed，并直接打印修复命令。
#
# 用法：
#   pwsh -NoProfile -File .\our\checks\precheck-eol.ps1            # 只检查（只读）
#   pwsh -NoProfile -File .\our\checks\precheck-eol.ps1 -Fix       # 修复：本地 autocrlf=false + CRLF→LF
#   pwsh -NoProfile -File .\our\checks\precheck-eol.ps1 -Quiet     # 只在失败时输出
# 退出码：0 = 全部通过；1 = 有未通过项（装配须停止）
param(
  [string]$Repo = (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)),
  [switch]$Fix,
  [switch]$Quiet
)
$ErrorActionPreference = 'Stop'
$fail = 0
function Say($m, $c = 'Gray') { if (-not $Quiet -or $c -eq 'Red') { Write-Host $m -ForegroundColor $c } }
function Fail($m) { $script:fail += 1; Write-Host "  ✗ $m" -ForegroundColor Red }

if (-not (Test-Path (Join-Path $Repo '.git'))) { throw "⓪ 不是 git 仓库：$Repo" }
$git = 'git'

# ── ① .gitattributes 必须声明 * -text ────────────────────────────────────────
$gaPath = Join-Path $Repo '.gitattributes'
$gaOk = $false
if (-not (Test-Path $gaPath)) {
  Fail "缺少 .gitattributes（需要一行 `* -text` 禁止行尾转换）"
} else {
  $ga = [IO.File]::ReadAllText($gaPath)
  if ($ga -match '(?m)^\s*\*\s+-text\s*$') { Say '  ✓ .gitattributes 已声明 * -text' 'DarkGray'; $gaOk = $true }
  else { Fail ".gitattributes 存在但没有 `* -text` 这一行（当前内容无法阻止行尾转换）" }
}

# ── ② 本地 core.autocrlf=false（**提示级**，因为真正承重的是 ①③③b）──────────
# 修正（2026-09-14）：本地配置**不会随 clone 带走**，所以全新克隆必然命中这里 →
# 若把它当失败，等于"每个新克隆都被拦一次"，属于自造摩擦。
# 而 `.gitattributes` 的 `* -text` 已经保证 git 不做任何行尾转换（①）+ 工作树全 LF（③）
# 才是真正的不变量。因此：① 通过时本项只提示；① 不通过时 ① 自己已经拦下了。
$localAc = (& $git -C $Repo config --local core.autocrlf 2>$null)
$sysAc = (& $git config --system core.autocrlf 2>$null)
if ($localAc -eq 'false') {
  Say "  ✓ 本地 core.autocrlf=false（系统级为 '$sysAc'，已被覆盖）" 'DarkGray'
} elseif ($gaOk) {
  if ($Fix) {
    & $git -C $Repo config --local core.autocrlf false
    Say "  ✓ 已修复：本地 core.autocrlf=false（系统级 '$sysAc'）" 'Yellow'
  } else {
    Say "  ! 本地 core.autocrlf 未设为 false（实为 '$localAc'；系统级 '$sysAc'）—— 因 .gitattributes 已声明 * -text，跟踪文件不会被转换，故仅提示；消除提示：git -C `"$Repo`" config --local core.autocrlf false" 'Yellow'
  }
} else {
  if ($Fix) {
    & $git -C $Repo config --local core.autocrlf false
    Say "  ✓ 已修复：本地 core.autocrlf=false（系统级 '$sysAc'）" 'Yellow'
  } else {
    Fail "本地 core.autocrlf 不是 false（实为 '$localAc'；系统级 '$sysAc'）且 .gitattributes 不达标 → 修复：git -C `"$Repo`" config --local core.autocrlf false"
  }
}

# ── ③ 所有跟踪文件必须为 LF ──────────────────────────────────────────────────
$files = & $git -C $Repo ls-files
$crlf = @()
foreach ($f in $files) {
  $p = Join-Path $Repo ($f -replace '/', '\')
  if (-not (Test-Path $p)) { continue }
  $t = [IO.File]::ReadAllText($p)
  if ($t -match "`r`n") { $crlf += $f }
}
if ($crlf.Count -eq 0) {
  Say "  ✓ $($files.Count) 个跟踪文件全部为 LF" 'DarkGray'
} elseif ($Fix) {
  $enc = New-Object System.Text.UTF8Encoding($false)
  foreach ($f in $crlf) {
    $p = Join-Path $Repo ($f -replace '/', '\')
    $t = [IO.File]::ReadAllText($p)
    [IO.File]::WriteAllText($p, ($t -replace "`r`n", "`n"), $enc)
  }
  Say "  ✓ 已修复：$($crlf.Count) 个文件 CRLF → LF" 'Yellow'
} else {
  Fail "$($crlf.Count)/$($files.Count) 个跟踪文件是 CRLF（前几个：$((($crlf | Select-Object -First 3) -join ', '))）→ 修复：pwsh -File `"$PSCommandPath`" -Fix"
}

# ── ③b 未跟踪但已存在的 upstream/patch 文件（真实缺口 · 2026-09-14）────────────
# 新 vendored 一版上游时，文件常常**还没 commit 就装配** → `git ls-files` 看不到它 → 本门禁会漏。
# 实测漏过一次：LICENSE 由 Copy-Item 落盘（当时未跟踪）且为 CRLF，逃过了两轮规范化，
# 直到它被 commit 之后才被本门禁拦下。所以这里**直接扫盘**，不依赖 git 索引。
$extraDirs = @('upstream', 'patch')
$extraBad = @()
$extraCount = 0
foreach ($dname in $extraDirs) {
  $dp = Join-Path $Repo $dname
  if (-not (Test-Path $dp)) { continue }
  foreach ($f in (Get-ChildItem $dp -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $_.FullName -notmatch '\\node_modules\\' })) {
    $extraCount++
    if ([IO.File]::ReadAllText($f.FullName) -match "`r`n") { $extraBad += $f.FullName.Substring($Repo.Length + 1) }
  }
}
if ($extraBad.Count -eq 0) {
  Say "  ✓ upstream/ + patch/ 上盘文件 $extraCount 个全部为 LF（含未跟踪）" 'DarkGray'
} elseif ($Fix) {
  $enc2 = New-Object System.Text.UTF8Encoding($false)
  foreach ($f in $extraBad) {
    $p = Join-Path $Repo $f
    [IO.File]::WriteAllText($p, ([IO.File]::ReadAllText($p) -replace "`r`n", "`n"), $enc2)
  }
  Say "  ✓ 已修复：$($extraBad.Count) 个未跟踪文件 CRLF → LF" 'Yellow'
} else {
  Fail "$($extraBad.Count) 个**未跟踪**的 upstream/patch 文件是 CRLF（前几个：$((($extraBad | Select-Object -First 3) -join ', '))）→ 修复：pwsh -File `"$PSCommandPath`" -Fix"
}
# ── 结论 ────────────────────────────────────────────────────────────────────
if ($fail -gt 0) {
  Write-Host "`n⓪ 前置检查未通过（$fail 项）——**装配必须停止**（fail-closed）" -ForegroundColor Red
  Write-Host "   一键修复：pwsh -NoProfile -File `"$PSCommandPath`" -Fix   （修完请重新提交，避免索引与工作树再度分叉）" -ForegroundColor Yellow
  exit 1
}
Say "`n⓪ 前置检查通过：行尾与仓库配置满足『字节级复现』前提" 'Green'
exit 0
