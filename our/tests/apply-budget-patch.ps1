#requires -Version 7
<#
  应用 dsh-ssh 连接预算补丁（结构锚点 + 命中数断言 == 1 + LF 写盘 + 改完 node --check）。
  依赖：同目录已有 hostkey 加固（本脚本只加预算，不动主机密钥部分）。
  用法：pwsh -File apply-budget-patch.ps1 -Root <包目录>
#>
param([Parameter(Mandatory = $true)][string]$Root)
$ErrorActionPreference = 'Stop'
$idx = Join-Path $Root 'lib\index.js'
$budget = Join-Path $Root 'lib\conn-budget.js'
if (-not (Test-Path $idx)) { Write-Error "找不到 $idx"; exit 2 }
if (-not (Test-Path $budget)) { Write-Error "缺少 $budget（conn-budget.js 未就位）"; exit 6 }

$T = "`t"
$text = [System.IO.File]::ReadAllText($idx)
$applied = @()

function Replace-Once([string]$src, [string]$old, [string]$new, [string]$label) {
  $n = ([regex]::Matches($src, [regex]::Escape($old))).Count
  if ($n -ne 1) { Write-Error "锚点命中数 $n ≠ 1（$label）——中止，不写盘"; exit 3 }
  $script:applied += $label
  return $src.Replace($old, $new)
}

# ① import
$oldImport = 'import { makeHostVerifier } from "./hostkey-guard.js";'
$newImport = $oldImport + "`n" + 'import { createBudget, readBudgetOptions } from "./conn-budget.js";'
$text = Replace-Once $text $oldImport $newImport 'import-conn-budget'

# ② DEFAULTS
$oldDef = $T + 'maxConnectAttempts: 2,'
$newDef = $oldDef + "`n" +
  $T + '// 连接预算（2026-09-13）：让"排队复用同一条连接"成为池内强制，任何调用方都绕不过' + "`n" +
  $T + 'maxConcurrentGlobal: 4,' + "`n" +
  $T + 'maxConcurrentPerHost: 2,' + "`n" +
  $T + 'maxCallsPerMinutePerHost: 60,' + "`n" +
  $T + 'minConnectIntervalMs: 5e3,' + "`n" +
  $T + 'budgetMaxWaitMs: 12e4,'
$text = Replace-Once $text $oldDef $newDef 'DEFAULTS-budget'

# ③ 构造：建预算器
$oldCtor = $T + $T + 'this.sweepTimer = setInterval(() => sweepPool(this), Math.max(1e4, this.opts.idleTimeoutMs / 4));'
$newCtor = $T + $T + '// 连接预算（2026-09-13 加固）：并发/速率/新建连接间隔闸门 + 计数落盘' + "`n" +
  $T + $T + '// （$DSH_HOME/dsh-ssh-budget.json，供外部工具跨工具统一展示）' + "`n" +
  $T + $T + 'this.budget = createBudget({ ...readBudgetOptions(this.opts), counterFile: join(dshHome(), "dsh-ssh-budget.json") });' + "`n" +
  $oldCtor
$text = Replace-Once $text $oldCtor $newCtor 'engine-ctor-budget'

# ④ withClient：包一层预算闸门（原函数体改名 withClientInner，避免大面积重排缩进）
$oldWith = 'async function withClient(engine, alias, fn, attempts = engine.opts.maxConnectAttempts ?? 2) {'
$newWith = '/** 连接预算闸门包装：超限**排队**（不是新建连接、也不是立刻失败）。 */' + "`n" +
  'async function withClient(engine, alias, fn, attempts = engine.opts.maxConnectAttempts ?? 2) {' + "`n" +
  $T + 'const budget = engine.budget ?? (engine.budget = createBudget({ ...readBudgetOptions(engine.opts), counterFile: join(dshHome(), "dsh-ssh-budget.json") }));' + "`n" +
  $T + 'const release = await budget.acquire(alias);' + "`n" +
  $T + 'try {' + "`n" +
  $T + $T + 'return await withClientInner(engine, alias, fn, attempts);' + "`n" +
  $T + '} finally {' + "`n" +
  $T + $T + 'release();' + "`n" +
  $T + '}' + "`n" +
  '}' + "`n" +
  'async function withClientInner(engine, alias, fn, attempts) {'
$text = Replace-Once $text $oldWith $newWith 'withClient-budget-wrapper'

# ⑤ doAcquire：新建连接闸门
$oldAcq = $T + 'if (entry === void 0) throw new Error("alias ''" + alias + "'' not found — add it first");' + "`n" +
  $T + 'const { client, hops } = await connectChain(engine, entry);'
$newAcq = $T + 'if (entry === void 0) throw new Error("alias ''" + alias + "'' not found — add it first");' + "`n" +
  $T + '// 新建连接闸门（同一 alias 两次真握手最小间隔）；复用路径不经过这里' + "`n" +
  $T + 'if (engine.budget !== void 0) await engine.budget.beforeConnect(alias);' + "`n" +
  $T + 'const { client, hops } = await connectChain(engine, entry);'
$text = Replace-Once $text $oldAcq $newAcq 'doAcquire-beforeConnect'

[System.IO.File]::WriteAllText($idx, $text, (New-Object System.Text.UTF8Encoding($false)))
$check = & node --check $idx 2>&1
$rc = $LASTEXITCODE
Write-Output ("applied = " + ($applied -join ' , '))
Write-Output ("node --check rc = " + $rc + " " + (($check | Out-String).Trim()))
if ($rc -ne 0) { exit 5 }
Write-Output "OK: $Root 已加连接预算"
exit 0
