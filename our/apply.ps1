<#
.SYNOPSIS
  A′ 装配线：把「vendored 上游产物」+「本仓库的补丁」+「下游 fork 改造」装成 dist\（可直接 link: 挂载）

.DESCRIPTION
  为什么要这条线：
    现状是"对 profile 里那份 npm 包**手工打补丁**"——补丁散落在 profile 的 `patches\` 目录里，
    没有自己的版本、没有断言、没有和测试放在一起。上游持续发版，手工方式每升一版就要重做一遍，
    且**已知会静默失败**（`git apply` 可能返回 rc=0 却一处都没应用）。

  五道断言（每一道都是踩过坑才加的）：
    ② `git apply --check` rc=0 且 `git apply` rc=0（且**显式 autocrlf=false**，否则产物行尾变 CRLF、
       与已验收产物"内容相同哈希不同"）
    ③ **命中数断言**：补丁落点标记出现次数 ≥ 登记值（专治"rc=0 却零效果"型静默失败）
    ④ **结果哈希断言**：打完补丁后与登记值逐文件同哈希（= 与已验收的产物逐字节一致）
    ⑤ **fork 改造断言**：可执行代码里**旧包名必须为 0**、**遥测域名必须为 0**、**心跳调用必须为 0**

  ⑤ 的改造（都是"显式记录的有意偏离"）：
    · 改名 `dsh-ssh-guard`（与上游区分；profile 里一眼看出挂的是哪一份）+ 版本后缀 `-guard.1`
    · 移除每日心跳上报：上游把遥测模块打包进 `lib/client.js`，端点为第三方域名，
      **没有配置开关可关** → 只能改包。内容为 `{kind, visitor, items:[{name,version}]}`，
      不含 SSH 数据，但属于第三方出网。
    · 归属字段改写（5.6）与 Apache-2.0 §4(b) 修改声明（5.7）
    改名范围 = `lib\**` 全部 + `package.json`/`cordis.patch.yml`/`README*.md`；
    **故意不改** = `src\**`（上游源码，留作升级对照）、`LICENSE`、`FORK.json` 的 `basedOn`（归属声明）。

  用法：
    pwsh -NoProfile -File .\our\apply.ps1                        # 全断言 + 默认 fork 改造
    pwsh -NoProfile -File .\our\apply.ps1 -NoFork                # 只做"纯净复现"（不改名/不摘心跳）
    pwsh -NoProfile -File .\our\apply.ps1 -KeepHeartbeat         # 保留上游心跳
    pwsh -NoProfile -File .\our\apply.ps1 -Version 0.3.21 -NoAssert   # 升级：先跳过 ④，人工核对后登记

.EXAMPLE
  # 装配后做真服务式探针验收（在非生产档上，不碰生产）
  dsh --profile <staging-profile> --port 0 --no-open
#>
param(
  [string]$Version = '0.3.21',
  [switch]$NoAssert,
  [string]$ForkName = 'dsh-ssh-guard',
  [string]$ForkVersionSuffix = '-guard.1',
  # 开源发布用：写入 dist\package.json 的归属字段。
  # 留空 = 删除上游遗留的 repository 指向（否则使用者会以为本包由上游发布）。
  [string]$RepoUrl = '',
  [string]$Author = '',
  [switch]$NoFork,
  [switch]$KeepHeartbeat,
  # 依赖自包含：link: 挂载的包必须自带 node_modules；宿主 peer 从 DSH 安装树链入
  [string]$DshInstall = "$env:APPDATA\npm\node_modules\@deepseek-ai\dsh",
  [switch]$RefreshDeps,
  [switch]$Quiet
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$up = Join-Path $repo "upstream\$Version"
$patchFile = Join-Path $repo "patch\@linxin666__dsh-ssh@$Version.patch"
$dist = Join-Path $repo 'dist'
$manifestPath = Join-Path $repo 'manifest.json'

if (-not (Test-Path $up)) { throw "未找到 vendored 上游：$up（先把 npm 包解开到 upstream\$Version）" }
if (-not (Test-Path $patchFile)) { throw "未找到补丁：$patchFile" }
$man = Get-Content $manifestPath -Raw | ConvertFrom-Json
$expect = $man.versions.$Version
if (-not $expect) { throw "manifest.json 里没有 $Version 的期望值（升级时需先登记）" }

# ── ⓪ 前置检查：装配的「字节级复现」前提（行尾 + 仓库配置）────────────────────
# 不通过就 fail-closed：宁可装不出来，也不要装出"看着对、指纹不对"的产物。
# （事故来源：派生仓库时 git clone 因系统级 core.autocrlf=true 把 vendored 上游变 CRLF，
#   产物哈希漂移、④ 断言拦下，排查花了一整轮 —— 详见 docs/QUALITY-GATES.md）
$precheck = Join-Path $PSScriptRoot 'checks\precheck-eol.ps1'
if (-not (Test-Path $precheck)) { throw "⓪ 缺少前置检查脚本：$precheck" }
& pwsh -NoProfile -File $precheck -Repo $repo
if ($LASTEXITCODE -ne 0) { throw "⓪ 前置检查未通过（exit=$LASTEXITCODE）——装配已停止；见上方逐项说明与修复命令" }
if (-not $Quiet) { Write-Host '⓪ 前置检查通过（.gitattributes / 本地 autocrlf / 全仓 LF）' }

# ── ① 复制 vendored 上游 → dist ─────────────────────────────────────────────
# 已知失败形态（2026-09-14 实测）：dist 正被**运行中的 DSH** 加载 → Windows 锁定已加载的 native 模块
# （典型：dist\node_modules\cpu-features\build\Release\cpufeatures.node）→ Remove-Item 报 Access denied。
# 这不是脚本 bug，而是"未停机不能重建"的固有限制；在此把它变成可操作提示（R7）。
if (Test-Path $dist) {
  try { Remove-Item $dist -Recurse -Force -ErrorAction Stop }
  catch {
    throw "① 无法重建 dist：$($_.Exception.Message)`n   **最可能原因**：该 dist 正被运行中的 DSH 加载（native 模块被锁）。`n   **处理**：先停掉加载该档的 dsh web，或先把 profile 切到别的档，再重新装配。"
  }
}
New-Item -ItemType Directory -Force -Path $dist | Out-Null
Copy-Item (Join-Path $up '*') $dist -Recurse -Force
if (-not $Quiet) { Write-Host "① 已复制 vendored 上游 $Version → dist\" }

# ── ② 打补丁（--check + apply；显式关 autocrlf）──────────────────────────────
Push-Location $dist
try {
  & git init -q 2>&1 | Out-Null
  # 必须显式关掉 autocrlf：本机 `core.autocrlf=true`（实测），会让 `git apply` 把补丁新增行写成 CRLF，
  # 而 vendored 上游与部署产物都是 LF → 结果"内容一字不差、哈希却不同"，导致 ④ 断言误报。
  $gitArgs = @('-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'apply')
  $chk = & git @gitArgs --check $patchFile 2>&1
  if ($LASTEXITCODE -ne 0) { throw "② 补丁 --check 失败（rc=$LASTEXITCODE）：`n$($chk -join "`n")" }
  $ap = & git @gitArgs $patchFile 2>&1
  if ($LASTEXITCODE -ne 0) { throw "② 补丁应用失败：`n$($ap -join "`n")" }
  if (-not $Quiet) { Write-Host '② 补丁已应用（--check rc=0 + apply rc=0；autocrlf 已显式关闭 → 产物为 LF）' }
} finally {
  if (Test-Path (Join-Path $dist '.git')) { Remove-Item (Join-Path $dist '.git') -Recurse -Force }
  Pop-Location
}

# ── ③ 命中数断言（防"rc=0 却零效果"）───────────────────────────────────
foreach ($m in $expect.markers) {
  $p = Join-Path $dist ($m.file -replace '/', '\')
  if (-not (Test-Path $p)) { throw "③ 命中数断言失败：期望文件不存在 $($m.file)" }
  $n = ([regex]::Matches([System.IO.File]::ReadAllText($p), [regex]::Escape($m.pattern))).Count
  if ($n -lt $m.min) {
    throw "③ 命中数断言失败：$($m.file) 里 '$($m.pattern)' 出现 $n 次 < 期望 $($m.min) 次 → **装配静默失败，已停止**（这正是此类静默失败的形态）"
  }
  if (-not $Quiet) { Write-Host ("③ 命中数 OK：{0} 里 '{1}' × {2}（≥ {3}）" -f $m.file, $m.pattern, $n, $m.min) }
}

# ── ④ 结果哈希断言（打完补丁即验：与"在跑的补丁版"逐文件同哈希）─────────────
if (-not $NoAssert) {
  foreach ($h in $expect.files.PSObject.Properties) {
    $p = Join-Path $dist ($h.Name -replace '/', '\')
    if (-not (Test-Path $p)) { throw "④ 结果哈希断言失败：$($h.Name) 不存在" }
    $sha = (Get-FileHash $p -Algorithm SHA256).Hash.ToLower()
    if ($sha -ne $h.Value) {
      throw ("④ 结果哈希断言失败：{0}`n   实际 {1}`n   期望 {2}`n → 补丁在新版本上的落点变了；人工核对后重新登记 manifest.json（升级流程见 UPGRADE.md）" -f $h.Name, $sha, $h.Value)
    }
  }
  if (-not $Quiet) { Write-Host ("④ 结果哈希 OK：{0} 个文件与登记值逐一同哈希（= 与在跑的补丁版逐字节一致）" -f @($expect.files.PSObject.Properties).Count) }
} else {
  Write-Host '④ 结果哈希断言：已按 -NoAssert 跳过（升级专用；核对完请更新 manifest.json）' -ForegroundColor Yellow
}

# ── ⑤ 下游 fork 改造 + 断言 ─────────────────────────────────────────────────
if (-not $NoFork) {
  $oldName = '@linxin666/dsh-ssh'
  $devs = New-Object System.Collections.Generic.List[string]
  $libDir = Join-Path $dist 'lib'
  $renameFiles = @(Get-ChildItem $libDir -Recurse -File | ForEach-Object { $_.FullName })
  foreach ($m in 'package.json', 'cordis.patch.yml', 'README.md', 'README.zh.md') {
    $p = Join-Path $dist $m; if (Test-Path $p) { $renameFiles += $p }
  }
  $renameFiles = @($renameFiles | Sort-Object -Unique)
  $enc = New-Object System.Text.UTF8Encoding($false)

  # 5.0 摘心跳调用（必须在改名之前：该调用参数里含旧包名）
  if (-not $KeepHeartbeat) {
    $cf = Join-Path $libDir 'client.js'
    $txt = [System.IO.File]::ReadAllText($cf)
    $pat = 'reportDailyHeartbeat\(\[\{\s*name:\s*"' + [regex]::Escape($oldName) + '"\s*\}\]\);'
    $n = ([regex]::Matches($txt, $pat)).Count
    if ($n -lt 1) { throw '⑤ 心跳移除失败：lib/client.js 里找不到心跳调用（上游可能改动）——人工核对后再装配' }
    $txt = [regex]::Replace($txt, $pat, '/* [dsh-ssh-guard] 每日心跳上报已移除：调用点已删除、端点字面量已中性化（详见包内 FORK.json） */')
    [System.IO.File]::WriteAllText($cf, $txt, $enc)
    $devs.Add("lib/client.js：移除每日心跳调用 ×$n（函数定义保留为死代码、无调用点；端点已中性化）")
  }

  # 5.1 改名（lib\** 全部 + 元数据；src\ 保留上游原样作对照）
  $renamed = 0
  foreach ($p in $renameFiles) {
    $t = [System.IO.File]::ReadAllText($p)
    $k = ([regex]::Matches($t, [regex]::Escape($oldName))).Count
    if ($k -gt 0) {
      [System.IO.File]::WriteAllText($p, ($t -replace [regex]::Escape($oldName), $ForkName), $enc)
      $renamed += $k
      $devs.Add(($p.Substring($dist.Length + 1)) + "：包名引用 ×$k → $ForkName")
    }
  }
  if ($renamed -lt 5) { throw "⑤ 改名覆盖不足：只改了 $renamed 处（期望 ≥5：client.js 的 module id/CSS tag/dataset + index.js 的 mountOnce + hostkey-guard.js + cordis.patch.yml + package.json）" }

  # 5.2 版本后缀（运行时一眼识别"挂的是哪一份"）
  $pjPath = Join-Path $dist 'package.json'
  $pjTxt = [System.IO.File]::ReadAllText($pjPath)
  $pjTxt = [regex]::Replace($pjTxt, '("version"\s*:\s*")' + [regex]::Escape($Version) + '(")', ('${1}' + $Version + $ForkVersionSuffix + '${2}'))
  [System.IO.File]::WriteAllText($pjPath, $pjTxt, $enc)
  $devs.Add("package.json：version → $Version$ForkVersionSuffix")

  # 5.3 遥测端点从**可执行代码**里清零（死代码里的 URL 也不留；src\ 的上游源码不动）
  if (-not $KeepHeartbeat) {
    foreach ($p in ($renameFiles | Where-Object { $_ -like "$libDir*" })) {
      $t = [System.IO.File]::ReadAllText($p)
      $k = ([regex]::Matches($t, 'https://dsh-market\.com')).Count
      if ($k -gt 0) {
        [System.IO.File]::WriteAllText($p, ($t -replace 'https://dsh-market\.com', 'about:blank#telemetry-removed'), $enc)
        $devs.Add(($p.Substring($dist.Length + 1)) + "：遥测端点字面量 ×$k 已中性化")
      }
    }
  }

  # 5.4 断言：改名范围内 旧包名 = 0；可执行代码里 遥测域名 = 0、心跳调用 = 0
  foreach ($p in $renameFiles) {
    $t = [System.IO.File]::ReadAllText($p)
    if ($t -match [regex]::Escape($oldName)) { throw "⑤ 断言失败：$($p.Substring($dist.Length + 1)) 仍残留旧包名" }
  }
  if (-not $KeepHeartbeat) {
    foreach ($p in ($renameFiles | Where-Object { $_ -like "$libDir*" })) {
      $t = [System.IO.File]::ReadAllText($p)
      $rel = $p.Substring($dist.Length + 1)
      if ($t -match 'dsh-market\.com') { throw "⑤ 断言失败：$rel 仍残留遥测域名" }
      # 只对**可执行 .js** 断言心跳调用；`.js.map` 里嵌的是上游原始源码文本（调试产物、不执行），
      # 其域名已在 5.3 一并中性化，此处不重复要求（口径写进 FORK.json 的 assertionScope）。
      if ($p -like '*.js' -and $t -match 'reportDailyHeartbeat\(\[') { throw "⑤ 断言失败：$rel 仍有心跳调用" }
    }
  }

  # 5.5 让 dist **自包含依赖**（2026-09-13 血泪规则）：
  #   `link:` 挂载的包，Node/ESM 会按**真实路径**解析（符号链接被展开）→ 从 dist\ 向上找不到
  #   profile\node_modules，所以：① 运行期依赖（ssh2/ws/@xterm/*）必须装进 dist\node_modules；
  #   ② 宿主提供的包（@deepseek-ai/dsh-*）必须以 junction 链进来（版本与宿主天然一致）。
  #   实测症状：`Cannot find package 'ssh2'` → 修完又 `Cannot find package '@deepseek-ai/dsh-tools'`。
  $depInfo = [ordered]@{ npmInstalled = @(); hostLinked = @() }
  $pjObj = Get-Content $pjPath -Raw | ConvertFrom-Json
  $depNames = @(); if ($pjObj.dependencies) { $depNames = @($pjObj.dependencies.PSObject.Properties.Name) }
  $nm = Join-Path $dist 'node_modules'
  if ($depNames.Count -gt 0) {
    $needInstall = $RefreshDeps -or (@($depNames | Where-Object { -not (Test-Path (Join-Path $nm $_)) }).Count -gt 0)
    if ($needInstall) {
      if (-not $Quiet) { Write-Host '⑤.5 安装运行期依赖到 dist\node_modules（npm --omit=dev）…' }
      Push-Location $dist; & npm install --omit=dev --no-audit --no-fund --loglevel=error 2>&1 | Out-Null; Pop-Location
    }
    foreach ($d in $depNames) {
      if (Test-Path (Join-Path $nm $d)) { $depInfo.npmInstalled += $d }
      else { throw "⑤.5 依赖缺失：$d 未落进 dist\node_modules（link: 挂载会 ERR_MODULE_NOT_FOUND）" }
    }
  }
  $hostImports = @(Get-ChildItem (Join-Path $dist 'lib') -Recurse -File -Include *.js |
    Select-String -Pattern 'from "(@deepseek-ai/[^"]+)"' -AllMatches |
    ForEach-Object { $_.Matches } | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique)
  foreach ($imp in $hostImports) {
    $hn = $imp -replace '^@deepseek-ai/', ''
    $target = Join-Path $DshInstall "node_modules\@deepseek-ai\$hn"
    if (-not (Test-Path $target)) { throw "⑤.5 宿主包找不到：$imp（期望在 $target）——link: 挂载会解析失败" }
    $link = Join-Path $nm ("@deepseek-ai\" + $hn)
    New-Item -ItemType Directory -Force -Path (Split-Path $link -Parent) | Out-Null
    if (-not (Test-Path $link)) { New-Item -ItemType Junction -Path $link -Target $target | Out-Null }
    $depInfo.hostLinked += $imp
  }
  if (-not $Quiet) {
    Write-Host ("⑤.5 依赖自包含：npm 依赖 {0} 个（{1}）+ 宿主 peer {2} 个（{3}）" -f
      @($depInfo.npmInstalled).Count, (@($depInfo.npmInstalled) -join '/'), @($depInfo.hostLinked).Count, (@($depInfo.hostLinked) -join '/'))
  }

  # 5.6 归属字段（开源发布）：上游 package.json 的 repository 指向**上游作者的仓库**，
  #     照原样发布会让使用者误以为本包来自上游 → 默认删除；给了 -RepoUrl / -Author 就写自己的。
  $pjTxt = [System.IO.File]::ReadAllText($pjPath)
  $hadRepo = $pjTxt -match '"repository"'
  if ($RepoUrl -ne '') {
    $pjTxt = [regex]::Replace($pjTxt, '("repository"\s*:\s*\{[^}]*?"url"\s*:\s*")[^"]*(")', ('${1}' + $RepoUrl + '${2}'))
  } else {
    $pjTxt = [regex]::Replace($pjTxt, '(?s),\s*"repository"\s*:\s*\{[^}]*\}', '')
    $pjTxt = [regex]::Replace($pjTxt, '(?s)"repository"\s*:\s*\{[^}]*\}\s*,', '')
  }
  if ($Author -ne '') {
    if ($pjTxt -match '"author"\s*:') {
      $pjTxt = [regex]::Replace($pjTxt, '("author"\s*:\s*")[^"]*(")', ('${1}' + $Author + '${2}'))
    } else {
      $ins = '"license": "Apache-2.0",' + "`n" + '  "author": "' + $Author + '",'
      $pjTxt = $pjTxt.Replace('"license": "Apache-2.0",', $ins)
    }
  }
  [System.IO.File]::WriteAllText($pjPath, $pjTxt, $enc)
  try { $null = Get-Content $pjPath -Raw | ConvertFrom-Json } catch { throw "⑤.6 package.json 改写后不是合法 JSON：$_" }
  $pjNow = [System.IO.File]::ReadAllText($pjPath)
  if ($pjNow -match 'zhu1090093659') { throw '⑤.6 归属断言失败：package.json 仍指向**上游作者**的仓库' }
  if ($hadRepo -and $RepoUrl -eq '' -and $pjNow -match '"repository"') { throw '⑤.6 归属断言失败：repository 未被移除' }
  $repoNote = if ($RepoUrl -ne '') { "→ $RepoUrl" } else { '已移除（原指向上游作者仓库）' }
  $authNote = if ($Author -ne '') { "；author → $Author" } else { '' }
  $devs.Add("package.json：repository $repoNote$authNote")

  # 5.7 修改声明（Apache-2.0 §4(b)）：被我们改动过的上游文件必须自带"已修改"提示。
  #     刻意**不写旧包名**，以免破坏 5.4 的"旧包名 = 0"断言；归属细节写进 FORK.json 的 basedOn。
  $notice = "// Derived from the upstream dsh-ssh package (Apache-2.0). Modified for $ForkName" +
            " — see FORK.json for the full change list.`n"
  foreach ($rel in @('lib\index.js', 'lib\client.js')) {
    $np = Join-Path $dist $rel
    if (-not (Test-Path $np)) { continue }
    $nt = [System.IO.File]::ReadAllText($np)
    if (-not $nt.StartsWith('// Derived from the upstream')) {
      [System.IO.File]::WriteAllText($np, $notice + $nt, $enc)
      $devs.Add("$rel：加入 Apache-2.0 §4(b) 修改声明（文件头）")
    }
  }

  # 5.8 包内识别标记（写在不参与扫描的路径；basedOn 是**归属声明**，故意保留上游名）
  $marker = [ordered]@{
    fork = $ForkName; version = "$Version$ForkVersionSuffix"; basedOn = "@linxin666/dsh-ssh@$Version"
    license = 'Apache-2.0'
    assembledAt = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
    heartbeat = $(if ($KeepHeartbeat) { 'kept' } else { 'removed' })
    deps = $depInfo
    linkNote = 'link: 挂载的包必须自带 node_modules（运行期依赖 + 宿主 @deepseek-ai/* peer 链接），否则 ERR_MODULE_NOT_FOUND'
    nameScope = 'lib/** + package.json + cordis.patch.yml + README*.md'
    assertionScope = '旧包名：上述范围全部为 0；遥测域名：lib/** 全部为 0；心跳调用：lib/**/*.js（.js.map 为调试产物、不执行，其域名已一并中性化）'
    keptVerbatim = 'src/**（上游源码，作升级对照）、LICENSE'
    deviations = @($devs)
  } | ConvertTo-Json -Depth 4
  [System.IO.File]::WriteAllText((Join-Path $dist 'FORK.json'), $marker, $enc)

  if (-not $Quiet) {
    Write-Host ("⑤ fork 改造完成：包名 → {0}，版本 → {1}{2}，心跳 = {3}（{4} 处改名 / {5} 项偏离）" -f
      $ForkName, $Version, $ForkVersionSuffix, $(if ($KeepHeartbeat) { '保留' } else { '已移除' }), $renamed, $devs.Count)
    foreach ($d in $devs) { Write-Host ("     · " + $d) -ForegroundColor DarkGray }
  }
}

if (-not $Quiet) { Write-Host "`n✓ 装配完成：$dist（上游 $Version + 本仓库的补丁$(if (-not $NoFork) { ' + fork 改造' })）" -ForegroundColor Green }
