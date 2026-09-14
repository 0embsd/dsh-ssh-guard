# ── 集成上游最新版（一条命令）────────────────────────────────────────────────
# 为什么有这个脚本：UPGRADE.md 里那套流程是 7 步手工操作（npm pack → 解包 → vendored →
# 复制补丁 → 试装配 → 核对差异 → 登记期望值 → 再装配）。手工做容易漏、容易忘登记，
# 而且"期望值登记"必须与实测逐字节一致 —— 这件事机器做比人做可靠。
#
# 本脚本把这 7 步固化成一条命令，并且**每一步都 fail-closed**：
#   · 上游补丁落点变了 → 在第 ③ 步就报"命中数/上下文对不上"并停（这就是我们要的报警）
#   · 期望值登记 → 由脚本按**实测值**写入 manifest.json（人不参与，杜绝抄错）
#   · 装配与回归 → 复用 apply.ps1 的五道断言与 tests/
#
# 用法：
#   pwsh -NoProfile -File .\our\bump-upstream.ps1 -Version 0.3.22
#   pwsh -NoProfile -File .\our\bump-upstream.ps1 -Version 0.3.22 -SkipAssemble   # 只做到登记
#   pwsh -NoProfile -File .\our\bump-upstream.ps1 -Version 0.3.21                 # 已集成 → 只复验
#
# 设计原则（对齐 docs/QUALITY-GATES.md）：
#   R1 每个外部命令都查 $LASTEXITCODE 并保留输出，绝不吞错
#   R3 全程显式 core.autocrlf=false；入口先跑 ⓪ 门禁
#   R4 期望值登记与实测值同源（同一棵补丁后的树）
#   R6 关键事实交叉验证（哈希 + 命中数 + 上游干净版对照）
param(
  [Parameter(Mandatory = $true)][string]$Version,
  [string]$UpstreamPackage = '@linxin666/dsh-ssh',
  [string]$WorkDir = (Join-Path $env:TEMP 'dsh-ssh-guard-bump'),
  [switch]$SkipAssemble,
  [switch]$SkipTests,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$enc = New-Object System.Text.UTF8Encoding($false)
$repo = Split-Path -Parent $PSScriptRoot
$git = 'git'
$step = 0
function Step([string]$m) { $script:step++; Write-Host ("`n[{0}] {1}" -f $script:step, $m) -ForegroundColor Cyan }
function Ok([string]$m) { Write-Host "    ✓ $m" -ForegroundColor Green }
function Warn([string]$m) { Write-Host "    ! $m" -ForegroundColor Yellow }
function Die([string]$m) { Write-Host "    ✗ $m" -ForegroundColor Red; exit 1 }

# ── ⓪ 前置门禁（行尾 / .gitattributes / autocrlf）────────────────────────────
Step '前置门禁 ⓪（行尾与仓库配置）'
& pwsh -NoProfile -File (Join-Path $PSScriptRoot 'checks\precheck-eol.ps1') -Repo $repo
if ($LASTEXITCODE -ne 0) { Die '前置门禁未通过 —— 先按提示修复（-Fix），再集成上游' }
Ok '行尾与仓库配置满足字节级复现前提'

$upDir = Join-Path $repo "upstream\$Version"
$patchNew = Join-Path $repo "patch\@linxin666__dsh-ssh@$Version.patch"
$manifestPath = Join-Path $repo 'manifest.json'
$applyPs1 = Join-Path $PSScriptRoot 'apply.ps1'

# ── 已集成？→ 只复验（幂等）──────────────────────────────────────────────────
$man = Get-Content $manifestPath -Raw | ConvertFrom-Json
$already = ($man.versions.PSObject.Properties.Name -contains $Version) -and (Test-Path $upDir)
if ($already -and -not $Force) {
  Warn "manifest.json 已有 $Version 且 upstream\$Version 存在 → 判定为【已集成】，本次只做复验"
  if (-not $SkipAssemble) {
    Step '复验装配（五道断言）'
    & pwsh -NoProfile -File $applyPs1 -Version $Version
    if ($LASTEXITCODE -ne 0) { Die '复验装配失败 —— 见上方断言输出' }
    Ok '五道断言全过'
  }
  Write-Host "`n✓ 已完成（幂等复验）" -ForegroundColor Green
  exit 0
}

# ── ① 取上游官方包并 vendored ────────────────────────────────────────────────
Step "取上游 $UpstreamPackage@$Version 并 vendored 进 upstream\$Version"
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
$packOut = & npm pack "$UpstreamPackage@$Version" --pack-destination $WorkDir 2>&1
if ($LASTEXITCODE -ne 0) { Die "npm pack 失败（exit=$LASTEXITCODE）：`n$($packOut -join "`n")" }
$tgz = Get-ChildItem $WorkDir -Filter '*.tgz' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $tgz) { Die "npm pack 没有产出 tgz：`n$($packOut -join "`n")" }
Ok "取到 $($tgz.Name)"

$extract = Join-Path $WorkDir "x-$Version"
if (Test-Path $extract) { Remove-Item $extract -Recurse -Force }
New-Item -ItemType Directory -Force -Path $extract | Out-Null
& tar -xzf $tgz.FullName -C $extract
if ($LASTEXITCODE -ne 0) { Die "解包失败（exit=$LASTEXITCODE）" }
$pkgDir = Join-Path $extract 'package'
if (-not (Test-Path $pkgDir)) { Die "解包后没有 package\ 目录" }

# 只 vendored 产物 + 源码 + 许可，绝不带 node_modules
if (Test-Path $upDir) { Remove-Item $upDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $upDir | Out-Null
Get-ChildItem $pkgDir -Force | Where-Object { $_.Name -ne 'node_modules' } |
  ForEach-Object { Copy-Item $_.FullName $upDir -Recurse -Force }
$upFiles = (Get-ChildItem $upDir -Recurse -File).Count
Ok "vendored $upFiles 个文件（已排除 node_modules）"

# ── ② 复制补丁为新版命名 ────────────────────────────────────────────────────
Step '复制补丁为新版命名（内容不改）'
$prevPatch = Get-ChildItem (Join-Path $repo 'patch') -Filter '*.patch' |
  Where-Object { $_.BaseName -notmatch [regex]::Escape($Version) } |
  Sort-Object Name -Descending | Select-Object -First 1
if (-not $prevPatch) { Die '找不到上一版的补丁作为模板' }
Copy-Item $prevPatch.FullName $patchNew -Force
Ok "$($prevPatch.Name) → $(Split-Path $patchNew -Leaf)"

# ── ③ 试打补丁（落点变了就在这里报警）───────────────────────────────────────
Step '在新版上试打补丁（--check --verbose）'
$probe = Join-Path $WorkDir "probe-$Version"
if (Test-Path $probe) { Remove-Item $probe -Recurse -Force }
New-Item -ItemType Directory -Force -Path $probe | Out-Null
Copy-Item (Join-Path $upDir '*') $probe -Recurse -Force
Push-Location $probe
& $git init -q 2>&1 | Out-Null
$chkOut = & $git -c core.autocrlf=false -c core.eol=lf apply --check --verbose $patchNew 2>&1
$chkRc = $LASTEXITCODE
Pop-Location
if ($chkRc -ne 0) {
  Write-Host ($chkOut -join "`n")
  Die "补丁在新版上打不上（exit=$chkRc）—— **这就是报警**：上游改了补丁落点，请人工修补丁 ③ 的上下文后重跑"
}
# hunk 数从**补丁文件自身**数（`^@@ `），不解析 git 的输出格式 —— 输出解析易碎（R2/R6：别靠猜形状）
$patchHunks = @(Select-String -Path $patchNew -Pattern '^@@ ' -ErrorAction SilentlyContinue).Count
Ok "补丁 --check 全部通过（补丁含 $patchHunks 个 hunk；rc=$chkRc）"
@($chkOut | Where-Object { $_ -match 'Hunk #' }) | ForEach-Object { Write-Host "      $_" -ForegroundColor DarkGray }

# ── ④ 打进去，按实测值计算期望值 ────────────────────────────────────────────
Step '应用补丁并采集期望值（命中数 + 结果哈希，与登记同源）'
Push-Location $probe
& $git -c core.autocrlf=false -c core.eol=lf apply $patchNew 2>&1 | Out-Null
$applyRc = $LASTEXITCODE
Pop-Location
if ($applyRc -ne 0) { Die "补丁应用失败（exit=$applyRc）" }

$markerSpec = @(
  @{ file = 'lib/index.js'; pattern = 'makeHostVerifier' },
  @{ file = 'lib/index.js'; pattern = 'createBudget' },
  @{ file = 'lib/index.js'; pattern = 'conn-budget.js' },
  @{ file = 'lib/conn-budget.js'; pattern = 'maxConcurrentPerHost' },
  @{ file = 'lib/hostkey-guard.js'; pattern = 'known_hosts' }
)
$hashSpec = @('lib/index.js', 'lib/conn-budget.js', 'lib/hostkey-guard.js')

$markers = @()
foreach ($m in $markerSpec) {
  $p = Join-Path $probe ($m.file -replace '/', '\')
  if (-not (Test-Path $p)) { Die "期望文件不存在：$($m.file) —— 补丁未正确应用" }
  $n = ([regex]::Matches([IO.File]::ReadAllText($p), [regex]::Escape($m.pattern))).Count
  if ($n -lt 1) { Die "命中数断言预检失败：$($m.file) 里 '$($m.pattern)' 为 0 次" }
  $markers += [ordered]@{ file = $m.file; pattern = $m.pattern; min = $n }
  Write-Host ("      {0,-24} {1,-22} × {2}" -f $m.file, $m.pattern, $n) -ForegroundColor DarkGray
}
$hashes = [ordered]@{}
foreach ($f in $hashSpec) {
  $p = Join-Path $probe ($f -replace '/', '\')
  $hashes[$f] = (Get-FileHash $p -Algorithm SHA256).Hash.ToLower()
  Write-Host ("      {0,-24} {1}" -f $f, $hashes[$f]) -ForegroundColor DarkGray
}

# 交叉验证：上游干净版必须不含我们的标记、且两个新文件不存在（R6）
$cleanIdx = Join-Path $upDir 'lib\index.js'
$cleanBad = 0
if (Test-Path $cleanIdx) {
  $t = [IO.File]::ReadAllText($cleanIdx)
  $cleanBad += ([regex]::Matches($t, 'makeHostVerifier')).Count + ([regex]::Matches($t, 'createBudget')).Count
}
if ((Test-Path (Join-Path $upDir 'lib\conn-budget.js')) -or (Test-Path (Join-Path $upDir 'lib\hostkey-guard.js'))) { $cleanBad++ }
if ($cleanBad -ne 0) { Die "上游干净版对照失败：干净版里出现了我们的标记/文件 —— vendored 目录可能被污染" }
Ok '交叉验证：上游干净版标记为 0、两个新文件不存在'

# ── ⑤ 登记期望值（文本插入，保持文件格式与 git diff 干净）───────────────────
Step '登记期望值到 manifest.json'
$manText = [IO.File]::ReadAllText($manifestPath)
if ($manText -match ('"' + [regex]::Escape($Version) + '"\s*:')) { Die "manifest.json 已存在 $Version 条目（要用 -Force 才覆盖）" }
# 注意：`-f` 格式串里的**字面花括号要写成 {{ }}**（真实踩过：JSON 的 { 被当成占位符 → 报错）
$markersJson = ($markers | ForEach-Object { '        {{ "file": "{0}", "pattern": "{1}", "min": {2} }}' -f $_.file, $_.pattern, $_.min }) -join ",`n"
$filesJson = ($hashes.Keys | ForEach-Object { '        "{0}": "{1}"' -f $_, $hashes[$_] }) -join ",`n"
$note = "由 our/bump-upstream.ps1 于 $(Get-Date -Format 'yyyy-MM-dd HH:mm') 自动登记：vendored 自 npm $UpstreamPackage@$Version；补丁为上一版原样复制后在新版上 --check 通过（补丁含 $patchHunks 个 hunk）；期望值取自同一棵补丁后的树（命中数 + 逐文件 sha256）。"
$entry = @"
    "$Version": {
      "basedOn": "npm $UpstreamPackage@$Version（产物+源码原样 vendored 于 upstream/$Version）",
      "patch": "patch/@linxin666__dsh-ssh@$Version.patch",
      "registeredAt": "$(Get-Date -Format 'yyyy-MM-dd')",
      "upgradeNote": "$note",
      "markers": [
$markersJson
      ],
      "files": {
$filesJson
      },
      "upstreamCleanCheck": {
        "note": "上游干净版里这些标记必须为 0、且两个新文件不存在 —— 用于证明『这两处加固是下游新增』",
        "lib/index.js:makeHostVerifier": 0,
        "lib/index.js:createBudget": 0,
        "lib/conn-budget.js:exists": false,
        "lib/hostkey-guard.js:exists": false
      }
    },
"@
$anchor = '  "versions": {'
if (-not $manText.Contains($anchor)) { Die 'manifest.json 结构不符合预期（找不到 "versions": { 锚点）' }
[IO.File]::WriteAllText($manifestPath, $manText.Replace($anchor, $anchor + "`n" + $entry.TrimEnd("`n")), $enc)
Ok "已登记 versions.$Version"

# ── ⑥ 把装配线默认版本指向新版 ──────────────────────────────────────────────
Step '更新 apply.ps1 的默认 -Version'
$ap = [IO.File]::ReadAllText($applyPs1)
$ap2 = [regex]::Replace($ap, "(\[string\]\`$Version\s*=\s*')[^']+(')", ('${1}' + $Version + '${2}'))
if ($ap2 -eq $ap) { Warn "apply.ps1 的默认版本未改变（可能已是 $Version）" } else { [IO.File]::WriteAllText($applyPs1, $ap2, $enc); Ok "默认版本 → $Version" }

# ── ⑦ 装配 + 回归 ──────────────────────────────────────────────────────────
if (-not $SkipAssemble) {
  Step '跑装配线（⓪ + 五道断言 + 依赖自包含）'
  & pwsh -NoProfile -File $applyPs1 -Version $Version
  if ($LASTEXITCODE -ne 0) { Die '装配失败 —— 见上方断言输出（期望值已登记，可据此定位）' }
  Ok '装配全过'
}
if (-not $SkipTests) {
  Step '跑回归（两个单测）'
  Push-Location $repo
  $t1 = & node '.\our\tests\test-hostkey-guard.mjs' 2>&1 | Select-String '== 结果'
  $t2 = & node '.\our\tests\test-conn-budget.mjs' 2>&1 | Select-String '== 结果'
  Pop-Location
  Write-Host "      hostkey: $($t1.Line)" -ForegroundColor DarkGray
  Write-Host "      budget : $($t2.Line)" -ForegroundColor DarkGray
  if ($t1.Line -notmatch 'fail=0' -or $t2.Line -notmatch 'fail=0') { Die '回归未全绿' }
  Ok '回归全绿'
}

Write-Host "`n✓ 已集成上游 $Version" -ForegroundColor Green
Write-Host @"
下一步（人工，一次）：
  1) 先在非生产 profile 验证：把 dist 挂进该 profile，然后跑
     dsh --profile <staging-profile> --port 0 --no-open    # 看到 `dsh web: http://…` 即通过
  2) 生产切换 + 重启（切换前先做配置快照并写好回滚步骤，流程见 docs/QUALITY-GATES.md）
  3) 提交：git add -A && git commit -m "chore(upstream): 集成 $Version"
"@
