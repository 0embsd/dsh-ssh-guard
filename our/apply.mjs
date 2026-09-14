#!/usr/bin/env node
// A' 装配线（Node 版）：把「vendored 上游产物」+「本仓库的补丁」+「下游 fork 改造」装成 dist/（可直接 link: 挂载）
// ─────────────────────────────────────────────────────────────────────────────
// 为什么要这条线：
//   过去是"对 profile 里那份 npm 包**手工打补丁**"——补丁散落在 profile 的 patches/ 目录里，
//   没有自己的版本、没有断言、没有和测试放在一起。上游持续发版，手工方式每升一版就要重做一遍，
//   且**已知会静默失败**（`git apply` 可能返回 rc=0 却一处都没应用）。
//
// 五道断言（每一道都是踩过坑才加的）：
//   ⓪ **行尾前置门禁**：.gitattributes 声明 * -text、工作树与 upstream/patch 全为 LF
//   ② `git apply --check` rc=0 且 `git apply` rc=0（且**显式 core.autocrlf=false**，否则产物行尾变 CRLF、
//      与已验收产物"内容相同哈希不同"）
//   ③ **命中数断言**：补丁落点标记出现次数 ≥ 登记值（专治"rc=0 却零效果"型静默失败）
//   ④ **结果哈希断言**：打完补丁后与登记值逐文件同哈希（= 与已验收的产物逐字节一致）
//   ⑤ **fork 改造断言**：可执行代码里**旧包名必须为 0**、**遥测域名必须为 0**、**心跳调用必须为 0**
//
// ⑤ 的改造（都是"显式记录的有意偏离"）：
//   · 改名（默认 dsh-ssh-guard，与上游区分）+ 版本后缀（默认 -guard.1）
//   · 移除每日心跳上报：上游把遥测模块打包进 lib/client.js，端点为第三方域名，**没有配置开关可关**
//     → 只能改包。内容为 {kind, visitor, items:[{name,version}]}，不含 SSH 数据，但属于第三方出网。
//   · 归属字段改写（5.6）与 Apache-2.0 §4(b) 修改声明（5.7）
//   改名范围 = lib/** 全部 + package.json/cordis.patch.yml/README*.md；
//   **故意不改** = src/**（上游源码，留作升级对照）、LICENSE、FORK.json 的 basedOn（归属声明）。
//
// 用法：
//   node our/apply.mjs                       # 全断言 + 默认 fork 改造
//   node our/apply.mjs --no-fork             # 只做"纯净复现"（不改名/不摘心跳）
//   node our/apply.mjs --keep-heartbeat      # 保留上游心跳
//   node our/apply.mjs --version 0.3.21 --no-assert   # 升级：先跳过 ④，人工核对后登记
//
// 验收（在非生产 profile 上，不碰生产）：
//   dsh --profile <staging-profile> --port 0 --no-open
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, relative } from 'node:path'
import {
  run, tryRun, npmRun, readText, writeText, sha256, repoRoot, ensureDir, removeDir, copyTree, linkDir, parseArgs, localStamp,
  step, ok, warn, info, die,
} from './lib/util.mjs'

const args = parseArgs()
const REPO = repoRoot()
const VERSION = String(args.version ?? '0.3.21')
const NO_ASSERT = args['no-assert'] === true
const FORK_NAME = String(args['fork-name'] ?? 'dsh-ssh-guard')
const FORK_SUFFIX = String(args['version-suffix'] ?? '-guard.1')
const REPO_URL = String(args['repo-url'] ?? '')
const AUTHOR = String(args.author ?? '')
const NO_FORK = args['no-fork'] === true
const KEEP_HEARTBEAT = args['keep-heartbeat'] === true
const REFRESH_DEPS = args['refresh-deps'] === true
const QUIET = args.quiet === true

/** 宿主 DSH 安装树：Windows 走 %APPDATA%，其他平台走 npm 全局根。 */
function defaultDshInstall() {
  if (args['dsh-install']) return resolve(String(args['dsh-install']))
  if (process.platform === 'win32' && process.env.APPDATA) {
    return join(process.env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh')
  }
  const root = tryRun('npm', ['root', '-g']).out.trim()
  return root ? join(root, '@deepseek-ai', 'dsh') : ''
}
const DSH_INSTALL = defaultDshInstall()

const up = join(REPO, 'upstream', VERSION)
const patchFile = join(REPO, 'patch', `@linxin666__dsh-ssh@${VERSION}.patch`)
const dist = join(REPO, 'dist')
const manifestPath = join(REPO, 'manifest.json')
const OLD_NAME = '@linxin666/dsh-ssh'
const log = (...a) => { if (!QUIET) console.log(...a) }

if (!existsSync(up)) die(`未找到 vendored 上游：${up}（先把 npm 包解开到 upstream/${VERSION}）`)
if (!existsSync(patchFile)) die(`未找到补丁：${patchFile}`)
const manifest = JSON.parse(readText(manifestPath))
const expect = manifest.versions?.[VERSION]
if (!expect) die(`manifest.json 里没有 ${VERSION} 的期望值（升级时需先登记；可用 our/bump-upstream.mjs）`)

// ── ⓪ 前置门禁：行尾与仓库配置 ───────────────────────────────────────────────
step(0, '前置门禁（行尾与仓库配置）')
const pre = tryRun(process.execPath, [join(REPO, 'our', 'checks', 'precheck-eol.mjs'), '--repo', REPO])
if (pre.code !== 0) {
  console.log(pre.out)
  die('前置门禁未通过 —— 先按提示修复（node our/checks/precheck-eol.mjs --fix），再装配')
}
if (!QUIET) console.log('    OK  行尾与仓库配置满足「字节级复现」前提')

// ── ① 复制 vendored 上游 → dist ──────────────────────────────────────────────
step(1, '复制 vendored 上游 -> dist')
// 已知失败形态：dist 正被**运行中的进程**加载 → 系统锁定已加载的 native 模块
// （典型：dist/node_modules/cpu-features/build/Release/cpufeatures.node）→ 删除报 Access denied。
// 这不是脚本 bug，而是"未停机不能重建"的固有限制；在此把它变成可操作提示（R7）。
try {
  removeDir(dist)
} catch (e) {
  die(`无法重建 dist：${e.message}\n    **最可能原因**：该 dist 正被运行中的 DSH 加载（native 模块被锁）。\n    **处理**：先停掉加载该档的 dsh web，或先把 profile 切到别的档，再重新装配。`)
}
ensureDir(dist)
for (const name of readdirSync(up)) copyTree(join(up, name), join(dist, name))
log(`① 已复制 vendored 上游 ${VERSION} -> dist/`)

// ── ② 打补丁（--check + apply；显式关 autocrlf）──────────────────────────────
step(2, '打补丁（--check + apply）')
run('git', ['-C', dist, 'init', '-q'])
// 必须显式关掉 autocrlf：本机 core.autocrlf=true 时，git apply 会把新增行写成 CRLF，
// 而 vendored 上游与已验收产物都是 LF → "内容一字不差、哈希却不同"，导致 ④ 断言误报。
const GIT_APPLY = ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'apply']
const chk = tryRun('git', ['-C', dist, ...GIT_APPLY, '--check', patchFile])
if (chk.code !== 0) die(`补丁 --check 失败（rc=${chk.code}）：\n${chk.out}`)
const ap = tryRun('git', ['-C', dist, ...GIT_APPLY, patchFile])
if (ap.code !== 0) die(`补丁应用失败（rc=${ap.code}）：\n${ap.out}`)
removeDir(join(dist, '.git'))
log('② 补丁已应用（--check rc=0 + apply rc=0；autocrlf 已显式关闭 -> 产物为 LF）')

// ── ③ 命中数断言（防"rc=0 却零效果"）─────────────────────────────────────────
step(3, '命中数断言')
for (const m of expect.markers) {
  const p = join(dist, m.file)
  if (!existsSync(p)) die(`命中数断言失败：期望文件不存在 ${m.file}`)
  const n = readText(p).split(m.pattern).length - 1
  if (n < m.min) {
    die(`命中数断言失败：${m.file} 里 '${m.pattern}' 出现 ${n} 次 < 期望 ${m.min} 次 -> **装配静默失败，已停止**`)
  }
  info(`命中数 OK：${m.file} 里 '${m.pattern}' x ${n}（>= ${m.min}）`)
}

// ── ④ 结果哈希断言 ──────────────────────────────────────────────────────────
step(4, '结果哈希断言')
if (!NO_ASSERT) {
  for (const [rel, want] of Object.entries(expect.files)) {
    const p = join(dist, rel)
    if (!existsSync(p)) die(`结果哈希断言失败：${rel} 不存在`)
    const got = sha256(p)
    if (got !== want) {
      die(`结果哈希断言失败：${rel}\n   实际 ${got}\n   期望 ${want}\n   -> 补丁在新版本上的落点变了；人工核对后重新登记 manifest.json`)
    }
  }
  info(`结果哈希 OK：${Object.keys(expect.files).length} 个文件与登记值逐一同哈希（= 与已验收产物逐字节一致）`)
} else {
  warn('结果哈希断言：已按 --no-assert 跳过（升级专用；核对完请更新 manifest.json）')
}

// ── ⑤ 下游 fork 改造 + 断言 ─────────────────────────────────────────────────
if (!NO_FORK) {
  const devs = []
  const libDir = join(dist, 'lib')
  const walkLib = (d) => readdirSync(d).flatMap((n) => {
    const p = join(d, n)
    return statSync(p).isDirectory() ? walkLib(p) : [p]
  })
  let renameFiles = walkLib(libDir)
  for (const m of ['package.json', 'cordis.patch.yml', 'README.md', 'README.zh.md']) {
    const p = join(dist, m)
    if (existsSync(p)) renameFiles.push(p)
  }
  renameFiles = [...new Set(renameFiles)]
  const rel = (p) => relative(dist, p).replace(/\\/g, '/')

  // 5.0 摘心跳调用（必须在改名之前：该调用参数里含旧包名）
  step('5.0', '移除每日心跳上报')
  if (!KEEP_HEARTBEAT) {
    const cf = join(libDir, 'client.js')
    const txt = readText(cf)
    const pat = new RegExp(`reportDailyHeartbeat\\(\\[\\{\\s*name:\\s*"${OLD_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*\\}\\]\\);`)
    const n = (txt.match(pat) ?? []).length
    if (n < 1) die('心跳移除失败：lib/client.js 里找不到心跳调用（上游可能改动）——人工核对后再装配')
    writeText(cf, txt.replace(pat, `/* [${FORK_NAME}] 每日心跳上报已移除：调用点已删除、端点字面量已中性化（详见包内 FORK.json） */`))
    devs.push(`lib/client.js：移除每日心跳调用 x${n}（函数定义保留为死代码、无调用点；端点已中性化）`)
    ok(`已移除心跳调用 x${n}`)
  }

  // 5.1 改名（lib/** 全部 + 元数据；src/ 保留上游原样作对照）
  step('5.1', `改名 ${OLD_NAME} -> ${FORK_NAME}`)
  let renamed = 0
  for (const p of renameFiles) {
    const t = readText(p)
    const k = (t.match(new RegExp(OLD_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length
    if (k > 0) {
      writeText(p, t.split(OLD_NAME).join(FORK_NAME))
      renamed += k
      devs.push(`${rel(p)}：包名引用 x${k} -> ${FORK_NAME}`)
    }
  }
  if (renamed < 5) die(`改名覆盖不足：只改了 ${renamed} 处（期望 >=5：client.js 的 module id/CSS tag/dataset + index.js 的 mountOnce + hostkey-guard.js + cordis.patch.yml + package.json）`)
  ok(`改名 ${renamed} 处`)

  // 5.2 版本后缀（运行时一眼识别"挂的是哪一份"）
  step('5.2', '版本后缀')
  const pjPath = join(dist, 'package.json')
  const pjTxt0 = readText(pjPath)
  writeText(pjPath, pjTxt0.replace(new RegExp(`("version"\\s*:\\s*")${VERSION.replace(/\./g, '\\.')}(")`), `$1${VERSION}${FORK_SUFFIX}$2`))
  devs.push(`package.json：version -> ${VERSION}${FORK_SUFFIX}`)
  ok(`version -> ${VERSION}${FORK_SUFFIX}`)

  // 5.3 遥测端点从**可执行代码**里清零（死代码里的 URL 也不留；src/ 的上游源码不动）
  step('5.3', '遥测端点中性化')
  if (!KEEP_HEARTBEAT) {
    for (const p of renameFiles.filter((p) => p.startsWith(libDir))) {
      const t = readText(p)
      const k = (t.match(/https:\/\/dsh-market\.com/g) ?? []).length
      if (k > 0) {
        writeText(p, t.split('https://dsh-market.com').join('about:blank#telemetry-removed'))
        devs.push(`${rel(p)}：遥测端点字面量 x${k} 已中性化`)
      }
    }
    ok('遥测端点已中性化')
  }

  // 5.4 断言：改名范围内旧包名 = 0；可执行代码里遥测域名 = 0、心跳调用 = 0
  step('5.4', 'fork 改造断言')
  for (const p of renameFiles) {
    if (readText(p).includes(OLD_NAME)) die(`断言失败：${rel(p)} 仍残留旧包名`)
  }
  if (!KEEP_HEARTBEAT) {
    for (const p of renameFiles.filter((x) => x.startsWith(libDir))) {
      const t = readText(p)
      if (t.includes('dsh-market.com')) die(`断言失败：${rel(p)} 仍残留遥测域名`)
      // 只对**可执行 .js** 断言心跳调用；.js.map 里嵌的是上游原始源码文本（调试产物、不执行）
      if (p.endsWith('.js') && t.includes('reportDailyHeartbeat([')) die(`断言失败：${rel(p)} 仍有心跳调用`)
    }
  }
  ok('旧包名 = 0 / 遥测域名 = 0 / 心跳调用 = 0')

  // 5.5 让 dist **自包含依赖**：link: 挂载的包，Node/ESM 按**真实路径**解析（符号链接被展开）
  //     → 从 dist/ 向上找不到 profile/node_modules，所以运行期依赖必须装进 dist/node_modules，
  //       宿主提供的 @deepseek-ai/dsh-* 必须以符号链接链进同一处。
  step('5.5', '依赖自包含')
  const pj = JSON.parse(readText(pjPath))
  const depNames = Object.keys(pj.dependencies ?? {})
  const nm = join(dist, 'node_modules')
  const depInfo = { npmInstalled: [], hostLinked: [] }
  if (depNames.length > 0) {
    const missing = depNames.filter((d) => !existsSync(join(nm, d)))
    if (REFRESH_DEPS || missing.length > 0) {
      log('    安装运行期依赖到 dist/node_modules（npm --omit=dev）...')
      const r = npmRun(['install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: dist })
      if (r.code !== 0) die(`npm install 失败（rc=${r.code}）：\n${r.out}`)
    }
    for (const d of depNames) {
      if (!existsSync(join(nm, d))) die(`依赖缺失：${d} 未落进 dist/node_modules（link: 挂载会 ERR_MODULE_NOT_FOUND）`)
      depInfo.npmInstalled.push(d)
    }
  }
  const hostImports = [...new Set(
    walkLib(libDir).filter((p) => p.endsWith('.js'))
      .flatMap((p) => [...readText(p).matchAll(/from "(@deepseek-ai\/[^"]+)"/g)].map((m) => m[1])),
  )]
  for (const imp of hostImports) {
    const target = join(DSH_INSTALL, 'node_modules', ...imp.split('/'))
    if (!existsSync(target)) die(`宿主包找不到：${imp}（期望在 ${target}）——link: 挂载会解析失败`)
    const link = join(nm, ...imp.split('/'))
    if (linkDir(target, link)) depInfo.hostLinked.push(imp)
    else depInfo.hostLinked.push(imp)
  }
  ok(`npm 依赖 ${depInfo.npmInstalled.length} 个（${depInfo.npmInstalled.join('/')}）+ 宿主 peer ${depInfo.hostLinked.length} 个（${depInfo.hostLinked.join('/')}）`)

  // 5.6 归属字段（开源发布）：上游 package.json 的 repository 指向**上游作者的仓库**，
  //     照原样发布会让使用者误以为本包来自上游 -> 默认删除；给了 --repo-url / --author 就写自己的。
  step('5.6', '归属字段')
  let pjTxt = readText(pjPath)
  const hadRepo = /"repository"/.test(pjTxt)
  if (REPO_URL !== '') {
    pjTxt = pjTxt.replace(/("repository"\s*:\s*\{[^}]*?"url"\s*:\s*")[^"]*(")/, `$1${REPO_URL}$2`)
  } else {
    pjTxt = pjTxt.replace(/,\s*"repository"\s*:\s*\{[^}]*\}/s, '')
    pjTxt = pjTxt.replace(/"repository"\s*:\s*\{[^}]*\}\s*,/s, '')
  }
  if (AUTHOR !== '') {
    if (/"author"\s*:/.test(pjTxt)) pjTxt = pjTxt.replace(/("author"\s*:\s*")[^"]*(")/, `$1${AUTHOR}$2`)
    else pjTxt = pjTxt.replace('"license": "Apache-2.0",', `"license": "Apache-2.0",\n  "author": "${AUTHOR}",`)
  }
  writeText(pjPath, pjTxt)
  try {
    JSON.parse(readText(pjPath))
  } catch (e) {
    die(`package.json 改写后不是合法 JSON：${e.message}`)
  }
  const pjNow = readText(pjPath)
  if (pjNow.includes('zhu1090093659')) die('归属断言失败：package.json 仍指向**上游作者**的仓库')
  if (hadRepo && REPO_URL === '' && /"repository"/.test(pjNow)) die('归属断言失败：repository 未被移除')
  if (AUTHOR !== '') devs.push(`package.json：author -> ${AUTHOR}`)
  devs.push(`package.json：repository ${REPO_URL !== '' ? `-> ${REPO_URL}` : '已移除（原指向上游作者仓库）'}`)
  ok(`repository ${REPO_URL !== '' ? `-> ${REPO_URL}` : '已移除'}${AUTHOR !== '' ? `；author -> ${AUTHOR}` : ''}`)

  // 5.7 修改声明（Apache-2.0 §4(b)）：被我们改动过的上游文件必须自带"已修改"提示。
  //     刻意**不写旧包名**，以免破坏 5.4 的"旧包名 = 0"断言；归属细节写进 FORK.json 的 basedOn。
  step('5.7', 'Apache-2.0 §4(b) 修改声明')
  const notice = `// Derived from the upstream dsh-ssh package (Apache-2.0). Modified for ${FORK_NAME}` +
    ' — see FORK.json for the full change list.\n'
  for (const r of ['lib/index.js', 'lib/client.js']) {
    const p = join(dist, r)
    if (!existsSync(p)) continue
    const t = readText(p)
    if (!t.startsWith('// Derived from the upstream')) {
      writeText(p, notice + t)
      devs.push(`${r}：加入 Apache-2.0 §4(b) 修改声明（文件头）`)
    }
  }
  ok('已为被改动的上游文件加修改声明')

  // 5.8 包内识别标记（写在不参与扫描的路径；basedOn 是**归属声明**，故意保留上游名）
  step('5.8', '包内识别标记 FORK.json')
  const marker = {
    fork: FORK_NAME,
    version: `${VERSION}${FORK_SUFFIX}`,
    basedOn: `${OLD_NAME}@${VERSION}`,
    license: 'Apache-2.0',
    assembledAt: localStamp(),
    heartbeat: KEEP_HEARTBEAT ? 'kept' : 'removed',
    deps: depInfo,
    linkNote: 'link: 挂载的包必须自带 node_modules（运行期依赖 + 宿主 @deepseek-ai/* peer 链接），否则 ERR_MODULE_NOT_FOUND',
    nameScope: 'lib/** + package.json + cordis.patch.yml + README*.md',
    assertionScope: '旧包名：上述范围全部为 0；遥测域名：lib/** 全部为 0；心跳调用：lib/**/*.js（.js.map 为调试产物、不执行，其域名已一并中性化）',
    keptVerbatim: 'src/**（上游源码，作升级对照）、LICENSE',
    deviations: devs,
  }
  writeText(join(dist, 'FORK.json'), JSON.stringify(marker, null, 2) + '\n')
  ok(`FORK.json 已写入（${devs.length} 项偏离）`)

  step('5.9', 'fork 改造汇总')
  info(`包名 -> ${FORK_NAME}，版本 -> ${VERSION}${FORK_SUFFIX}，心跳 = ${KEEP_HEARTBEAT ? '保留' : '已移除'}（${renamed} 处改名 / ${devs.length} 项偏离）`)
}

if (!QUIET) console.log(`\n装配完成：${dist}（上游 ${VERSION} + 本仓库的补丁${NO_FORK ? '' : ' + fork 改造'}）`)
