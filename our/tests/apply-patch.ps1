#requires -Version 7
<#
  应用 dsh-ssh 加固补丁（纪律：结构锚点 + 命中数断言 == 1 + LF 写盘 + 改完即语法快检）。
  目标文件：<Root>/lib/index.js（已安装包 与 pnpm patch 工作区 各应用一次，内容必须一致）
  用法：pwsh -File apply-patch.ps1 -Root <包目录>
#>
param([Parameter(Mandatory = $true)][string]$Root)
$ErrorActionPreference = 'Stop'
$idx = Join-Path $Root 'lib\index.js'
$guard = Join-Path $Root 'lib\hostkey-guard.js'
if (-not (Test-Path $idx)) { Write-Error "找不到 $idx"; exit 2 }

$T = "`t"
$text = [System.IO.File]::ReadAllText($idx)
$orig = $text
$applied = @()

function Replace-Once([string]$src, [string]$old, [string]$new, [string]$label) {
  $n = ([regex]::Matches($src, [regex]::Escape($old))).Count
  if ($n -ne 1) { Write-Error "锚点命中数 $n ≠ 1（$label）——中止，不写盘"; exit 3 }
  $script:applied += $label
  return $src.Replace($old, $new)
}

# ① import
$oldImport = 'import { randomBytes } from "node:crypto";'
$newImport = $oldImport + "`n" + 'import { makeHostVerifier } from "./hostkey-guard.js";'
$text = Replace-Once $text $oldImport $newImport 'import-hostkey-guard'

# ② hostVerifier（buildConnectConfig 内，锚点含 passphrase 行保证唯一）
$oldCfg = $T + $T + 'if (entry.auth.passphrase !== void 0 && entry.auth.passphrase !== "") config.passphrase = entry.auth.passphrase;' + "`n" + $T + '}' + "`n" + $T + 'return config;'
$newCfg = $T + $T + 'if (entry.auth.passphrase !== void 0 && entry.auth.passphrase !== "") config.passphrase = entry.auth.passphrase;' + "`n" +
  $T + '}' + "`n" +
  $T + '// ── 主机身份校验（2026-09-13 下游加固补丁）─────────────────────────────' + "`n" +
  $T + '// 原实现不设 hostVerifier/hostHash/known_hosts → 不校验服务器身份：任何能在网络路径上' + "`n" +
  $T + '// 冒充目标主机的一方都会被照单全收（命令/输出被窃、返回可被伪造 → 假绿凭证）。' + "`n" +
  $T + '// 现在接上 ~/.ssh/known_hosts 清单；有记录必须一致、无记录 fail-closed 拒连' + "`n" +
  $T + '// （DSH_SSH_HOSTKEY_ALLOW_NEW=1 时 TOFU 落库；DSH_SSH_HOSTKEY_MODE=off 为排障逃生口）。' + "`n" +
  $T + 'config.hostVerifier = makeHostVerifier({ host: entry.host, port: entry.port, alias: entry.alias });' + "`n" +
  $T + 'return config;'
$text = Replace-Once $text $oldCfg $newCfg 'hostVerifier-in-buildConnectConfig'

# ③ 连接重试上限可配（默认 3 → 2）+ 重连可审计
$oldWith = 'async function withClient(engine, alias, fn, attempts = 3) {'
$newWith = $T + '// 2026-09-13 加固：重试上限改为可配（默认 2）。原默认 3 意味着连接反复断开时' + "`n" +
  $T + '// **每次调用最多 3 次握手**——这正是 fail2ban 最容易抓的形态（连续失败连接）。' + "`n" +
  'async function withClient(engine, alias, fn, attempts = engine.opts.maxConnectAttempts ?? 2) {'
$text = Replace-Once $text $oldWith $newWith 'withClient-attempts-configurable'

$oldAcq = $T + $T + 'if (record === void 0 || record.broken) {' + "`n" +
  $T + $T + $T + 'if (record !== void 0) disposeRecord(engine, alias, record);' + "`n" +
  $T + $T + $T + 'record = await acquire(engine, alias);' + "`n" +
  $T + $T + '}'
$newAcq = $T + $T + 'if (record === void 0 || record.broken) {' + "`n" +
  $T + $T + $T + 'if (record !== void 0) disposeRecord(engine, alias, record);' + "`n" +
  $T + $T + $T + 'if (attempt > 1) console.warn("[dsh-ssh pool] 重连 " + alias + "（第 " + attempt + "/" + attempts + " 次）——连接预算：每次重连都是一次真实握手");' + "`n" +
  $T + $T + $T + 'record = await acquire(engine, alias);' + "`n" +
  $T + $T + '}'
$text = Replace-Once $text $oldAcq $newAcq 'withClient-reconnect-log'

# ④ DEFAULTS 增加 maxConnectAttempts
$oldDef = $T + 'defaultMaxWorkers: 8,'
$newDef = $oldDef + "`n" + $T + 'maxConnectAttempts: 2,'
$text = Replace-Once $text $oldDef $newDef 'DEFAULTS-maxConnectAttempts'

if ($text -eq $orig) { Write-Error '没有任何改动——异常'; exit 4 }
[System.IO.File]::WriteAllText($idx, $text, (New-Object System.Text.UTF8Encoding($false)))

# 写盘后快检：ESM 语法 + guard 文件存在
$check = & node --check $idx 2>&1
$rc = $LASTEXITCODE
Write-Output ("applied = " + ($applied -join ' , '))
Write-Output ("node --check rc = " + $rc + " " + (($check | Out-String).Trim()))
if ($rc -ne 0) { exit 5 }
if (-not (Test-Path $guard)) { Write-Error "缺少 $guard（hostkey-guard.js 未就位）"; exit 6 }
Write-Output "OK: $Root 已加固（LF 写盘，无 BOM）"
exit 0
