#!/usr/bin/env node
// 前置门禁：装配的「字节级复现」前提（行尾 + 仓库配置）
// ─────────────────────────────────────────────────────────────────────────────
// 为什么有这个检查（真实事故 · 2026-09-13）：
//   派生仓库时用 git clone 复制，**系统级 core.autocrlf=true**（Git for Windows 默认）
//   在检出时把 vendored 上游由 LF 转成 CRLF → 装配产物"内容一字不差、哈希却不同"，
//   直接触发 apply 的结果哈希断言。排查花了整整一轮，且一度被误判为"补丁改了内容"。
//
//   教训：字节级复现依赖三件事，全部必须**显式**存在，不能靠环境恰好干净：
//     ① `.gitattributes` 里有 `* -text`（禁止 git 做任何行尾转换）—— 真正承重
//     ② 工作树里所有**跟踪文件**都是 LF —— 真正承重
//     ③ upstream/ 与 patch/ 目录里**上盘的文件**（含未跟踪）也是 LF —— 真实缺口：
//        新 vendored 一版上游常常还没 commit 就装配，此时 git ls-files 看不到它
//   本地 `core.autocrlf=false` 只是提示级：它**不随 clone 带走**，若当失败会让每个新克隆都被误拦。
//
// 用法：
//   node our/checks/precheck-eol.mjs [--repo <dir>] [--fix] [--quiet]
// 退出码：0 = 通过；1 = 有未通过项（装配必须停止）
import { existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { run, tryRun, readText, writeText, repoRoot, walk, parseArgs, ok, warn, die } from '../lib/util.mjs'

const args = parseArgs()
const REPO = resolve(args.repo ?? repoRoot())
const FIX = args.fix === true
const QUIET = args.quiet === true

let failures = 0
function pass(msg) {
  if (!QUIET) console.log(`  OK  ${msg}`)
}
function fail(msg) {
  failures++
  console.log(`  ERR ${msg}`)
}

if (!existsSync(join(REPO, '.git'))) die(`不是 git 仓库：${REPO}`)
const git = (...a) => run('git', ['-C', REPO, ...a])

// ── ① .gitattributes 必须声明 * -text ────────────────────────────────────────
const gaPath = join(REPO, '.gitattributes')
let gaOk = false
if (!existsSync(gaPath)) {
  fail('缺少 .gitattributes（需要一行 `* -text` 禁止行尾转换）')
} else {
  const ga = readText(gaPath)
  if (/(?:^|\n)\s*\*\s+-text\s*(?:\n|$)/.test(ga)) {
    pass('.gitattributes 已声明 * -text')
    gaOk = true
  } else {
    fail('.gitattributes 存在但没有 `* -text` 这一行（当前内容无法阻止行尾转换）')
  }
}

// ── ② 本地 core.autocrlf=false（提示级；见文件头说明）────────────────────────
const localAc = tryRun('git', ['-C', REPO, 'config', '--local', 'core.autocrlf']).out.trim()
const sysAc = tryRun('git', ['config', '--system', 'core.autocrlf']).out.trim()
if (localAc === 'false') {
  pass(`本地 core.autocrlf=false（系统级为 '${sysAc}'，已被覆盖）`)
} else if (FIX) {
  run('git', ['-C', REPO, 'config', '--local', 'core.autocrlf', 'false'])
  pass(`已修复：本地 core.autocrlf=false（系统级 '${sysAc}'）`)
} else if (gaOk) {
  warn(`本地 core.autocrlf 未设为 false（实为 '${localAc}'；系统级 '${sysAc}'）—— 因 .gitattributes 已声明 * -text，跟踪文件不会被转换，故仅提示；消除提示：git -C "${REPO}" config --local core.autocrlf false`)
} else {
  fail(`本地 core.autocrlf 不是 false（实为 '${localAc}'；系统级 '${sysAc}'）且 .gitattributes 不达标 → 修复：git -C "${REPO}" config --local core.autocrlf false`)
}

// ── ③ 所有跟踪文件必须为 LF ──────────────────────────────────────────────────
const tracked = git('ls-files').split('\n').map((s) => s.trim()).filter(Boolean)
const hasCrlf = (p) => readText(p).includes('\r\n')
const toLf = (p) => writeText(p, readText(p).replace(/\r\n/g, '\n'))

let crlf = tracked.filter((f) => existsSync(join(REPO, f)) && hasCrlf(join(REPO, f)))
if (crlf.length === 0) {
  pass(`${tracked.length} 个跟踪文件全部为 LF`)
} else if (FIX) {
  crlf.forEach((f) => toLf(join(REPO, f)))
  pass(`已修复：${crlf.length} 个文件 CRLF -> LF`)
  crlf = []
} else {
  fail(`${crlf.length}/${tracked.length} 个跟踪文件是 CRLF（前几个：${crlf.slice(0, 3).join(', ')}）→ 修复：node our/checks/precheck-eol.mjs --fix`)
}

// ── ③b upstream/ 与 patch/ 上盘文件（含未跟踪）───────────────────────────────
let extraCount = 0
let extraBad = []
for (const dname of ['upstream', 'patch']) {
  for (const p of walk(join(REPO, dname))) {
    extraCount++
    if (hasCrlf(p)) extraBad.push(p.slice(REPO.length + 1))
  }
}
if (extraBad.length === 0) {
  pass(`upstream/ + patch/ 上盘文件 ${extraCount} 个全部为 LF（含未跟踪）`)
} else if (FIX) {
  extraBad.forEach((f) => toLf(join(REPO, f)))
  pass(`已修复：${extraBad.length} 个未跟踪文件 CRLF -> LF`)
  extraBad = []
} else {
  fail(`${extraBad.length} 个**未跟踪**的 upstream/patch 文件是 CRLF（前几个：${extraBad.slice(0, 3).join(', ')}）→ 修复：node our/checks/precheck-eol.mjs --fix`)
}

// ── 结论 ────────────────────────────────────────────────────────────────────
if (failures > 0) {
  console.log(`\n前置检查未通过（${failures} 项）——**装配必须停止**（fail-closed）`)
  console.log('   一键修复：node our/checks/precheck-eol.mjs --fix   （修完请重新提交，避免索引与工作树再度分叉）')
  process.exit(1)
}
if (!QUIET) console.log('\n前置检查通过：行尾与仓库配置满足\'字节级复现\'前提')
process.exit(0)
