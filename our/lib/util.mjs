// 公共工具：外部命令调用 / 文本读写（LF、无 BOM）/ 哈希 / 遍历 / 参数解析 / 日志
// ─────────────────────────────────────────────────────────────────────────────
// 为什么存在：装配线从 PowerShell 迁到 Node 后，三个脚本需要同一套基础能力。
// 设计约束（对齐 docs/QUALITY-GATES.md）：
//   R1 外部命令**必查退出码并保留输出** → 统一走 run() / tryRun()，不允许散落的裸调用
//   R3 文本一律以 LF 写盘、不写 BOM（Node 的 writeFileSync('utf8') 天然不写 BOM）
//   跨平台：不依赖任何 shell 专有语法；符号链接类型按平台选择（win32 用 junction）
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, cpSync, readdirSync, statSync, symlinkSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 跑外部命令并返回 stdout（失败即抛）。R1：调用方必须处理失败，不允许静默。 */
export function run(cmd, args = [], opts = {}) {
  return String(execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }) ?? '')
}

/** 跑外部命令，**连退出码和输出一起返回**（不抛），用于"预期可能失败"的探测。 */
export function tryRun(cmd, args = [], opts = {}) {
  try {
    return { code: 0, out: run(cmd, args, opts) }
  } catch (e) {
    const out = `${e.stdout ?? ''}${e.stderr ?? ''}`
    return { code: typeof e.status === 'number' ? e.status : 1, out: String(out) }
  }
}

export const readText = (p) => readFileSync(p, 'utf8')
export const writeText = (p, s) => writeFileSync(p, s, 'utf8') // 无 BOM
export const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')
export const exists = (p) => existsSync(p)
export const ensureDir = (p) => mkdirSync(p, { recursive: true })
export const removeDir = (p) => rmSync(p, { recursive: true, force: true })
export const copyTree = (from, to) => cpSync(from, to, { recursive: true, force: true })

/** 本文件所在仓库根（用于 our/lib/util.mjs → 仓库根）。 */
export function repoRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
}

/** 递归列出文件（跳过 node_modules 与 .git）。 */
export function walk(dir, { skipDirs = ['node_modules', '.git'] } = {}) {
  const out = []
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    if (skipDirs.includes(name)) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p, { skipDirs }))
    else out.push(p)
  }
  return out
}

/** 建符号链接：Windows 用 junction（无需管理员权限），类 Unix 用目录符号链接。 */
export function linkDir(target, linkPath) {
  ensureDir(dirname(linkPath))
  if (existsSync(linkPath)) return false
  symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
  return true
}

/**
 * 跨平台跑 npm。
 * 为什么单独一个函数：Windows 上 npm 是 `npm.cmd`，**CreateProcess 不能直接执行 .cmd**，
 * execFile 会失败（现象：rc=1 且没有任何输出）。必须经 shell 执行；而 shell:true 时 Node 不会
 * 自动为含空格的参数加引号，所以这里自己加。POSIX 平台直接 execFile，无需 shell。
 */
export function npmRun(args, opts = {}) {
  const isWin = process.platform === 'win32'
  const argv = isWin ? args.map((a) => (/\s/.test(a) ? `"${a}"` : a)) : args
  return tryRun('npm', argv, { ...opts, shell: isWin })
}

/** 本地时间戳 `YYYY-MM-DD HH:mm:ss`（与仓库其余文档口径一致；**不要用 toISOString，那是 UTC**）。 */
export function localStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  const time = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  return `${date} ${time}`
}

/** 极简参数解析：`--key value` → 字符串；`--flag` → true；`--k=v` → 字符串；非 `--` 项进 `_`。 */
export function parseArgs(argv = process.argv.slice(2)) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) {
      out._.push(a)
      continue
    }
    const body = a.slice(2)
    const eq = body.indexOf('=')
    if (eq >= 0) {
      out[body.slice(0, eq)] = body.slice(eq + 1)
      continue
    }
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) out[body] = true
    else {
      out[body] = next
      i++
    }
  }
  return out
}

// ── 日志（纯 ASCII 前缀，避免不同终端的编码问题）─────────────────────────────
export function step(n, msg) {
  console.log(`\n[${n}] ${msg}`)
}
export function ok(msg) {
  console.log(`    OK  ${msg}`)
}
export function warn(msg) {
  console.log(`    !   ${msg}`)
}
export function info(msg) {
  console.log(`        ${msg}`)
}
export function die(msg) {
  console.error(`    ERR ${msg}`)
  process.exit(1)
}
