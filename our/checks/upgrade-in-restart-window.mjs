#!/usr/bin/env node
// 在「重启窗口」里完成升级：停宿主 → 装配 → 起宿主 → 自检
// ─────────────────────────────────────────────────────────────────────────────
// 为什么需要它（R7 记录的真实限制）：
//   `dist/` 正被运行中的 DSH 以 `link:` 挂载时，Windows 会锁住已加载的 native 模块
//   （典型：`dist/node_modules/cpu-features/build/Release/cpufeatures.node`）→ 装配第 ① 步删不掉 dist。
//   所以"跟完上游 → 上生产"的正确顺序**必须**是：先让托管它的 DSH 退出，再装配，再把它拉起来。
//   本脚本把这个顺序固化，并把"起没起来"用 liveness 自检说清楚。
//
// ⚠️ 本脚本会**结束正在运行的 dsh web 宿主**（也就是调用它的那个进程的上游）。因此：
//   · 先跑 `--dry-run` 看它会动谁（不杀不启）
//   · 真要执行时，**必须把本脚本以独立进程方式启动**（例如 Start-Process 隐藏窗口），
//     否则它杀掉宿主的同时自己也随之结束。
//
// 用法：
//   node our/checks/upgrade-in-restart-window.mjs --dry-run          # 预演：只报告会停哪些进程
//   node our/checks/upgrade-in-restart-window.mjs --yes              # 真执行（请用独立进程启动）
//   可选：--repo <路径>  --launcher "<启动命令，默认 dsh web>"  --health <URL>  --wait-ms <毫秒>
// 退出码：0 = 装配成功且自检通过；1 = 失败（日志已说明卡在哪一步）
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join, resolve } from 'node:path'
import { repoRoot, tryRun, parseArgs, step, ok, warn, info, die } from '../lib/util.mjs'

const args = parseArgs()
const REPO = resolve(args.repo ?? repoRoot())
const DRY = args['dry-run'] === true
const YES = args.yes === true
const LAUNCHER = String(args.launcher ?? 'dsh web')
const HEALTH = String(args.health ?? 'http://127.0.0.1:3080/dsh-health')
const WAIT_MS = Number(args['wait-ms'] ?? 180000)
const IS_WIN = process.platform === 'win32'

// --log <路径>：把输出同时以 **UTF-8** 写入文件。
// 为什么不靠 shell 重定向：Node 写 UTF-8，而 PowerShell 重定向会按控制台代码页（如 GBK）解码，
// 中文会变成乱码（2026-09-14 实测）。自己写文件则编码可控。
const LOG = args.log ? resolve(String(args.log)) : null
if (LOG) {
  const { writeFileSync, appendFileSync, mkdirSync } = await import('node:fs')
  const { dirname } = await import('node:path')
  mkdirSync(dirname(LOG), { recursive: true })
  writeFileSync(LOG, '', 'utf8')
  const tee = (orig) => (...a) => {
    const s = a.map((x) => (typeof x === 'string' ? x : String(x))).join(' ')
    orig(s)
    try { appendFileSync(LOG, s + '\n', 'utf8') } catch { /* 忽略写日志失败 */ }
  }
  console.log = tee(console.log.bind(console))
  console.error = tee(console.error.bind(console))
  console.log(`[log] UTF-8 日志：${LOG}`)
}

if (!DRY && !YES) die('真要执行请显式加 --yes（并请以独立进程启动本脚本）；只预演请加 --dry-run')

/** 找出正在跑的 dsh web 宿主（按命令行匹配，不误杀别的 node 进程）。 */
function findHosts() {
  if (IS_WIN) {
    const r = tryRun('powershell', ['-NoProfile', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'bin\\.js\\s+web(\\s|$)' } | ForEach-Object { \"$($_.ProcessId)|$($_.CommandLine)\" }"])
    return r.out.split('\n').map((s) => s.trim()).filter(Boolean).map((line) => {
      const [pid, ...rest] = line.split('|')
      return { pid: Number(pid), cmd: rest.join('|') }
    })
  }
  const r = tryRun('bash', ['-lc', "ps -eo pid=,args= | grep -E 'bin\\.js +web( |$)' | grep -v grep"])
  return r.out.split('\n').map((s) => s.trim()).filter(Boolean).map((line) => {
    const m = line.match(/^(\d+)\s+(.*)$/)
    return m ? { pid: Number(m[1]), cmd: m[2] } : null
  }).filter(Boolean)
}

function killHost(p) {
  // **不要加 /T**（真实事故 · 2026-09-14）：本脚本通常是从 DSH 进程树里派生出来的
  // （DSH → pwsh → 分离的 powershell → 本脚本），`taskkill /F /T` 会把整棵树一起杀掉，
  // 于是"刚杀完宿主，脚本自己也死了"——升级半途而废、宿主一直停着。只结束宿主本身即可。
  if (IS_WIN) tryRun('taskkill', ['/F', '/PID', String(p.pid)])
  else try { process.kill(p.pid, 'SIGKILL') } catch { /* 已退出 */ }
}

// ── ① 找到宿主 ─────────────────────────────────────────────────────────────
step(1, '查找正在运行的 dsh web 宿主')
const hosts = findHosts()
if (hosts.length === 0) warn('没找到正在运行的 dsh web 宿主（若你确定它在跑，请手动停掉后再装配）')
for (const h of hosts) info(`PID=${h.pid}  ${h.cmd.slice(0, 110)}`)

if (DRY) {
  step(2, '预演结束（--dry-run：不杀任何进程、不装配、不启动）')
  console.log(`\n若真执行，将对上面 ${hosts.length} 个进程：结束 → 在 ${REPO} 跑 npm run assemble → 启动 "${LAUNCHER}" → 轮询 ${HEALTH}`)
  process.exit(0)
}

// ── ② 停宿主（否则 dist 被锁）──────────────────────────────────────────────
step(2, '结束宿主进程（释放 dist 上的 native 模块锁）')
for (const h of hosts) {
  killHost(h)
  info(`已请求结束 PID=${h.pid}`)
}
await new Promise((r) => setTimeout(r, 3000))

// ── ③ 装配（此时 dist 应已解锁）────────────────────────────────────────────
step(3, `装配：${REPO} 下 npm run assemble`)
const asm = tryRun(IS_WIN ? 'npm run assemble' : 'npm', IS_WIN ? [] : ['run', 'assemble'], {
  cwd: REPO, shell: IS_WIN, stdio: IS_WIN ? 'pipe' : 'pipe',
})
process.stdout.write(asm.out.endsWith('\n') ? asm.out : asm.out + '\n')
if (asm.code !== 0) {
  warn('装配失败 —— 宿主已被结束，请先手动起回来：' + LAUNCHER)
  die(`装配退出码 ${asm.code}`)
}
ok('装配完成（含宿主链接）')

// ── ④ 起宿主（独立进程，脱离本脚本）────────────────────────────────────────
step(4, `启动宿主：${LAUNCHER}`)
if (IS_WIN) {
  spawn('powershell', ['-NoProfile', '-Command', `Start-Process cmd -ArgumentList '/c','${LAUNCHER}' -WindowStyle Hidden`], {
    detached: true, stdio: 'ignore', shell: false,
  }).unref()
} else {
  spawn('bash', ['-lc', LAUNCHER], { detached: true, stdio: 'ignore' }).unref()
}
info('已以独立进程启动（隐藏窗口）')

// ── ⑤ 自检：轮询 liveness ──────────────────────────────────────────────────
step(5, `自检：轮询 ${HEALTH}（最多等 ${Math.round(WAIT_MS / 1000)} 秒）`)
const t0 = Date.now()
let healthy = false
while (Date.now() - t0 < WAIT_MS) {
  await new Promise((r) => setTimeout(r, 3000))
  try {
    const res = await fetch(HEALTH, { signal: AbortSignal.timeout(4000) })
    if (res.status === 200) {
      healthy = true
      ok(`第 ${Math.round((Date.now() - t0) / 1000)} 秒自检通过（HTTP 200）`)
      break
    }
  } catch { /* 还没起来 */ }
}
if (!healthy) {
  warn('自检未通过。手动恢复：' + LAUNCHER)
  die('升级已装配完成但宿主未按时就绪')
}

console.log('\n重启窗口升级完成：宿主已用新产物起回来')
