#!/usr/bin/env node
// 集成上游最新版（一条命令）
// ─────────────────────────────────────────────────────────────────────────────
// 为什么有这个脚本：手工跟版是 7 步操作（npm pack → 解包 → vendored → 复制补丁 → 试装配 →
// 核对差异 → 登记期望值 → 再装配）。手工做容易漏、容易忘登记，而"期望值登记"必须与实测逐字节
// 一致 —— 这件事机器做比人做可靠。
//
// 本脚本把 7 步固化成一条命令，每一步都 fail-closed：
//   · 上游补丁落点变了 -> 在试打补丁那一步就报警并停
//   · 期望值登记 -> 由脚本按**实测值**写入 manifest.json（人不参与，杜绝抄错）
//   · 装配与回归 -> 复用 our/apply.mjs 的五道断言与 our/tests/
//
// 用法：
//   node our/bump-upstream.mjs --version 0.3.22
//   node our/bump-upstream.mjs --version 0.3.22 --skip-assemble   # 只做到登记
//   node our/bump-upstream.mjs --version 0.3.21                   # 已集成 -> 只复验
//
// 设计原则（对齐 docs/QUALITY-GATES.md）：
//   R1 每个外部命令都查退出码并保留输出，绝不吞错
//   R3 全程显式 core.autocrlf=false；入口先跑 ⓪ 门禁
//   R4 期望值登记与实测值同源（同一棵补丁后的树）
//   R6 关键事实交叉验证（哈希 + 命中数 + 上游干净版对照）
import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import {
  run, tryRun, npmRun, readText, writeText, sha256, repoRoot, ensureDir, removeDir, copyTree, walk, parseArgs,
  step, ok, warn, info, die,
} from './lib/util.mjs'

const args = parseArgs()
const REPO = repoRoot()
if (!args.version) die('必须给 --version（例：--version 0.3.22）')
const VERSION = String(args.version)
const UPSTREAM_PACKAGE = String(args['upstream-package'] ?? '@linxin666/dsh-ssh')
const WORK_DIR = resolve(String(args['work-dir'] ?? join(tmpdir(), 'dsh-ssh-guard-bump')))
const SKIP_ASSEMBLE = args['skip-assemble'] === true
const SKIP_TESTS = args['skip-tests'] === true
const FORCE = args.force === true

const upDir = join(REPO, 'upstream', VERSION)
const patchNew = join(REPO, 'patch', `@linxin666__dsh-ssh@${VERSION}.patch`)
const manifestPath = join(REPO, 'manifest.json')
const applyMjs = join(REPO, 'our', 'apply.mjs')
const patchName = (v) => `@linxin666__dsh-ssh@${v}.patch`

// ── ⓪ 前置门禁 ─────────────────────────────────────────────────────────────
step(1, '前置门禁 ⓪（行尾与仓库配置）')
const pre = tryRun(process.execPath, [join(REPO, 'our', 'checks', 'precheck-eol.mjs'), '--repo', REPO])
if (pre.code !== 0) {
  console.log(pre.out)
  die('前置门禁未通过 —— 先按提示修复（node our/checks/precheck-eol.mjs --fix），再集成上游')
}
ok('行尾与仓库配置满足字节级复现前提')

const manifest = JSON.parse(readText(manifestPath))
const already = Object.prototype.hasOwnProperty.call(manifest.versions ?? {}, VERSION) && existsSync(upDir)

// ── 已集成？-> 只复验（幂等）────────────────────────────────────────────────
if (already && !FORCE) {
  warn(`manifest.json 已有 ${VERSION} 且 upstream/${VERSION} 存在 -> 判定为【已集成】，本次只做复验`)
  if (!SKIP_ASSEMBLE) {
    step(2, '复验装配（五道断言）')
    const r = tryRun(process.execPath, [applyMjs, '--version', VERSION])
    process.stdout.write(r.out)
    if (r.code !== 0) die('复验装配失败 —— 见上方断言输出')
    ok('五道断言全过')
  }
  console.log('\n已完成（幂等复验）')
  process.exit(0)
}

// ── ① 取上游官方包并 vendored ────────────────────────────────────────────────
step(2, `取上游 ${UPSTREAM_PACKAGE}@${VERSION} 并 vendored 进 upstream/${VERSION}`)
ensureDir(WORK_DIR)
const pack = npmRun(['pack', `${UPSTREAM_PACKAGE}@${VERSION}`, '--pack-destination', WORK_DIR])
if (pack.code !== 0) die(`npm pack 失败（rc=${pack.code}）：\n${pack.out}`)
const tgzs = readdirSync(WORK_DIR).filter((f) => f.endsWith('.tgz')).map((f) => join(WORK_DIR, f))
if (tgzs.length === 0) die(`npm pack 没有产出 tgz：\n${pack.out}`)
const tgz = tgzs.sort().reverse()[0]
ok(`取到 ${tgz.split(/[\\/]/).pop()}`)

const extract = join(WORK_DIR, `x-${VERSION}`)
removeDir(extract)
ensureDir(extract)
const tar = tryRun('tar', ['-xzf', tgz, '-C', extract])
if (tar.code !== 0) die(`解包失败（rc=${tar.code}）：\n${tar.out}`)
const pkgDir = join(extract, 'package')
if (!existsSync(pkgDir)) die('解包后没有 package/ 目录')

// 只 vendored 产物 + 源码 + 许可，绝不带 node_modules
removeDir(upDir)
ensureDir(upDir)
for (const name of readdirSync(pkgDir)) {
  if (name === 'node_modules') continue
  copyTree(join(pkgDir, name), join(upDir, name))
}
ok(`vendored ${walk(upDir).length} 个文件（已排除 node_modules）`)

// ── ② 复制补丁为新版命名（内容不改）─────────────────────────────────────────
step(3, '复制补丁为新版命名（内容不改）')
const prevPatches = readdirSync(join(REPO, 'patch')).filter((f) => f.endsWith('.patch') && f !== patchName(VERSION)).sort()
if (prevPatches.length === 0) die('找不到上一版的补丁作为模板')
const prev = prevPatches[prevPatches.length - 1]
copyTree(join(REPO, 'patch', prev), patchNew)
ok(`${prev} -> ${patchName(VERSION)}`)

// ── ③ 试打补丁（落点变了就在这里报警）───────────────────────────────────────
step(4, '在新版上试打补丁（--check --verbose）')
const probe = join(WORK_DIR, `probe-${VERSION}`)
removeDir(probe)
ensureDir(probe)
for (const name of readdirSync(upDir)) copyTree(join(upDir, name), join(probe, name))
run('git', ['-C', probe, 'init', '-q'])
const chk = tryRun('git', ['-C', probe, '-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'apply', '--check', '--verbose', patchNew])
if (chk.code !== 0) {
  console.log(chk.out)
  die(`补丁在新版上打不上（rc=${chk.code}）—— **这就是报警**：上游改了补丁落点，请人工修补丁的上下文后重跑`)
}
// hunk 数从**补丁文件自身**数（^@@ ），不解析 git 的输出格式 —— 输出解析易碎
const patchHunks = (readText(patchNew).match(/^@@ /gm) ?? []).length
ok(`补丁 --check 全部通过（补丁含 ${patchHunks} 个 hunk；rc=${chk.code}）`)
for (const line of chk.out.split('\n').filter((l) => l.includes('Hunk #'))) info(line.trim())

// ── ④ 打进去，按实测值计算期望值 ────────────────────────────────────────────
step(5, '应用补丁并采集期望值（命中数 + 结果哈希，与登记同源）')
const ap = tryRun('git', ['-C', probe, '-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'apply', patchNew])
if (ap.code !== 0) die(`补丁应用失败（rc=${ap.code}）：\n${ap.out}`)

const markerSpec = [
  { file: 'lib/index.js', pattern: 'makeHostVerifier' },
  { file: 'lib/index.js', pattern: 'createBudget' },
  { file: 'lib/index.js', pattern: 'conn-budget.js' },
  { file: 'lib/conn-budget.js', pattern: 'maxConcurrentPerHost' },
  { file: 'lib/hostkey-guard.js', pattern: 'known_hosts' },
]
const hashSpec = ['lib/index.js', 'lib/conn-budget.js', 'lib/hostkey-guard.js']
const markers = []
for (const m of markerSpec) {
  const p = join(probe, m.file)
  if (!existsSync(p)) die(`期望文件不存在：${m.file} —— 补丁未正确应用`)
  const n = readText(p).split(m.pattern).length - 1
  if (n < 1) die(`命中数断言预检失败：${m.file} 里 '${m.pattern}' 为 0 次`)
  markers.push({ file: m.file, pattern: m.pattern, min: n })
  info(`${m.file}  ${m.pattern}  x ${n}`)
}
const hashes = {}
for (const f of hashSpec) {
  hashes[f] = sha256(join(probe, f))
  info(`${f}  ${hashes[f]}`)
}

// 交叉验证：上游干净版必须不含我们的标记、且两个新文件不存在（R6）
let cleanBad = 0
const cleanIdx = join(upDir, 'lib', 'index.js')
if (existsSync(cleanIdx)) {
  const t = readText(cleanIdx)
  cleanBad += t.split('makeHostVerifier').length - 1
  cleanBad += t.split('createBudget').length - 1
}
if (existsSync(join(upDir, 'lib', 'conn-budget.js')) || existsSync(join(upDir, 'lib', 'hostkey-guard.js'))) cleanBad++
if (cleanBad !== 0) die('上游干净版对照失败：干净版里出现了我们的标记/文件 —— vendored 目录可能被污染')
ok('交叉验证：上游干净版标记为 0、两个新文件不存在')

// ── ⑤ 登记期望值（文本插入，保持文件格式与 git diff 干净）───────────────────
step(6, '登记期望值到 manifest.json')
let manText = readText(manifestPath)
if (new RegExp(`"${VERSION.replace(/\./g, '\\.')}"\\s*:`).test(manText)) die(`manifest.json 已存在 ${VERSION} 条目（要用 --force 才覆盖）`)
const markersJson = markers.map((m) => `        { "file": "${m.file}", "pattern": "${m.pattern}", "min": ${m.min} }`).join(',\n')
const filesJson = Object.entries(hashes).map(([k, v]) => `        "${k}": "${v}"`).join(',\n')
const note = `由 our/bump-upstream.mjs 于 ${new Date().toISOString().slice(0, 16).replace('T', ' ')} 自动登记：` +
  `vendored 自 npm ${UPSTREAM_PACKAGE}@${VERSION}；补丁为上一版原样复制后在新版上 --check 通过（补丁含 ${patchHunks} 个 hunk）；` +
  '期望值取自同一棵补丁后的树（命中数 + 逐文件 sha256）。'
const entry = `    "${VERSION}": {
      "basedOn": "npm ${UPSTREAM_PACKAGE}@${VERSION}（产物+源码原样 vendored 于 upstream/${VERSION}）",
      "patch": "patch/${patchName(VERSION)}",
      "registeredAt": "${new Date().toISOString().slice(0, 10)}",
      "upgradeNote": "${note}",
      "markers": [
${markersJson}
      ],
      "files": {
${filesJson}
      },
      "upstreamCleanCheck": {
        "note": "上游干净版里这些标记必须为 0、且两个新文件不存在 —— 用于证明『这两处加固是下游新增』",
        "lib/index.js:makeHostVerifier": 0,
        "lib/index.js:createBudget": 0,
        "lib/conn-budget.js:exists": false,
        "lib/hostkey-guard.js:exists": false
      }
    },`
const anchor = '  "versions": {'
if (!manText.includes(anchor)) die('manifest.json 结构不符合预期（找不到 "versions": { 锚点）')
manText = manText.replace(anchor, `${anchor}\n${entry}`)
writeText(manifestPath, manText)
ok(`已登记 versions.${VERSION}`)

// ── ⑥ 把装配线默认版本指向新版 ──────────────────────────────────────────────
step(7, '更新 apply.mjs 的默认 --version')
const applyTxt = readText(applyMjs)
const applyNew = applyTxt.replace(/(const VERSION = String\(args\.version \?\? ')[^']+('\))/, `$1${VERSION}$2`)
if (applyNew === applyTxt) warn(`apply.mjs 的默认版本未改变（可能已是 ${VERSION}）`)
else {
  writeText(applyMjs, applyNew)
  ok(`默认版本 -> ${VERSION}`)
}

// ── ⑦ 装配 + 回归 ──────────────────────────────────────────────────────────
if (!SKIP_ASSEMBLE) {
  step(8, '跑装配线（⓪ + 五道断言 + 依赖自包含）')
  const r = tryRun(process.execPath, [applyMjs, '--version', VERSION])
  process.stdout.write(r.out)
  if (r.code !== 0) die('装配失败 —— 见上方断言输出（期望值已登记，可据此定位）')
  ok('装配全过')
}
if (!SKIP_TESTS) {
  step(9, '跑回归（两个单测）')
  let bad = false
  for (const t of ['test-hostkey-guard.mjs', 'test-conn-budget.mjs']) {
    const r = tryRun(process.execPath, [join(REPO, 'our', 'tests', t)])
    const line = (r.out.split('\n').find((l) => l.includes('== ')) ?? '').trim()
    info(`${t.replace('test-', '').replace('.mjs', '')}: ${line}`)
    if (r.code !== 0 || !line.includes('fail=0')) bad = true
  }
  if (bad) die('回归未全绿')
  ok('回归全绿')
}

console.log(`\n已集成上游 ${VERSION}`)
console.log(`
下一步（人工，一次）：
  1) 先在非生产 profile 验证：把 dist 挂进该 profile，然后
     dsh --profile <staging-profile> --port 0 --no-open      # 看到 \`dsh web: http://…\` 即通过
  2) 生产切换 + 重启（切换前先做配置快照并写好回滚步骤，流程见 docs/QUALITY-GATES.md）
  3) 提交：git add -A && git commit -m "chore(upstream): 集成 ${VERSION}"
`)
