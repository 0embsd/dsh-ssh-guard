#!/usr/bin/env node
// 安装冒烟测试：验证「本仓库的 dist 能不能真的被 DSH 装起来并加载」
// ─────────────────────────────────────────────────────────────────────────────
// 为什么需要它（真实教训）：我们长期只验证了"装配能跑"，却从没验证过"**安装能不能成**"——
//   这正是"机制依赖一个从未创建的文件""验收脚本从未跑过"那一类风险的同型：
//   装配产物再漂亮，若挂载路径/包名/宿主链接有一处不对，用户装上去就是加载失败。
//
// 本脚本做的事（全程在一个**临时档**里，不碰生产档）：
//   ① 检查 dist/ 已装配
//   ② 建一个临时 profile：base + web-app + 本插件（link: 指向本仓库 dist/）
//   ③ `dsh plugin --profile <临时档> install`（= 让 link 真正落进该档的 node_modules）
//   ④ 核对 node_modules 里的链接与包身份
//   ⑤ 真启动一次：`dsh --profile <临时档> --port 0 --no-open`，等到监听行出现才算通过
//   ⑥ 杀掉进程树并删除临时档（--keep 可保留，便于排查）
//
// 用法：
//   node our/checks/install-smoke.mjs                 # 默认临时档名 dsh-ssh-guard-smoke
//   node our/checks/install-smoke.mjs --keep          # 保留临时档（排查用）
//   node our/checks/install-smoke.mjs --repo <path>   # 指定仓库根（默认本文件所在仓库）
// 退出码：0 = 安装并加载成功；1 = 任一步失败
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync, lstatSync, realpathSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { repoRoot, readText, tryRun, run, parseArgs, step, ok, warn, info, die } from '../lib/util.mjs'

const args = parseArgs()
const REPO = resolve(args.repo ?? repoRoot())
const PROFILE = String(args.profile ?? 'dsh-ssh-guard-smoke')
const KEEP = args.keep === true
// --tgz <路径>：按「下载一个打包好的 tgz 直接安装」来测（对应 README 的路线 C）。
// 与 link: 的关键差别：tgz 会被 pnpm 解到 profile 自己的 .pnpm 存储里，**真实路径仍在 profile 内**，
// 因此 ESM 向上解析能找到 profiles/node_modules/@deepseek-ai/dsh-tools —— **不需要宿主链接**。
const TGZ = args.tgz ? resolve(String(args.tgz)) : null
const WAIT_MS = Number(args['wait-ms'] ?? 90000)
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const DIST = join(REPO, 'dist')
const PROFILE_DIR = join(DSH_HOME, 'profiles', PROFILE)

// ── ① 待安装的产物是否就位 ──────────────────────────────────────────────────
step(1, TGZ ? '检查 tgz 是否就位' : '检查 dist/ 是否已装配')
let distPkg
if (TGZ) {
  if (!existsSync(TGZ)) die(`未找到 tgz：${TGZ}`)
  distPkg = JSON.parse(run('tar', ['-xzOf', TGZ, 'package/package.json']))
  ok(`tgz 就位：${TGZ.split(/[\\/]/).pop()} → ${distPkg.name}@${distPkg.version}`)
} else {
  if (!existsSync(join(DIST, 'package.json'))) die(`未找到 ${DIST}/package.json —— 先在本仓库跑：npm run assemble`)
  distPkg = JSON.parse(readText(join(DIST, 'package.json')))
  ok(`dist 就位：${distPkg.name}@${distPkg.version}`)
}

// ── ② 建临时 profile（只有官方 base + web-app，插件用下面的 add 命令装）──────
step(2, `建临时 profile：${PROFILE}`)
mkdirSync(PROFILE_DIR, { recursive: true })
const profileJson = {
  name: `dsh-profile-${PROFILE}`,
  private: true,
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
}
writeFileSync(join(PROFILE_DIR, 'package.json'), JSON.stringify(profileJson, null, 2) + '\n', 'utf8')
// 真实档需要这一条：npm/tgz 安装会**真的去装运行期依赖**（ssh2 / cpu-features 带构建脚本），
// pnpm 默认不信任构建脚本 → 报 ERR_PNPM_IGNORED_BUILDS。官方 profile 的 pnpm-workspace.yaml
// 里同样有 allowBuilds（这也是「从 npm 装」与「link: 装」的一个真实差别）。
writeFileSync(
  join(PROFILE_DIR, 'pnpm-workspace.yaml'),
  ['packages:', '  - .', 'autoInstallPeers: false', 'allowBuilds:', '  cpu-features: true', '  ssh2: true', ''].join('\n'),
  'utf8',
)
ok(`已写 ${join(PROFILE_DIR, 'package.json')} 与 pnpm-workspace.yaml（allowBuilds: cpu-features / ssh2）`)

let failed = false
function cleanup() {
  if (KEEP) {
    warn(`按要求保留临时档：${PROFILE_DIR}`)
    return
  }
  try {
    rmSync(PROFILE_DIR, { recursive: true, force: true })
    info(`已清理临时档：${PROFILE_DIR}`)
  } catch (e) {
    warn(`清理失败（可手动删除）：${PROFILE_DIR} —— ${e.message}`)
  }
}

// ── ③ 安装：**用 README 里给用户的那条命令** `dsh plugin --profile <档> add link:<dist>` ──
// Windows 上 dsh 是 .cmd，必须经 shell；此时**把整条命令作为一个字符串**传（不要同时给 args 数组），
// 否则 Node 会报 DEP0190 弃用警告（shell + args 只做拼接、不转义）。
const IS_WIN = process.platform === 'win32'
const linkSpec = TGZ ? `file:${TGZ.replace(/\\/g, '/')}` : `link:${DIST.replace(/\\/g, '/')}`
step(3, `安装：dsh plugin --profile ${PROFILE} add ${linkSpec}`)
const addArgs = ['plugin', '--profile', PROFILE, 'add', linkSpec]
const inst = IS_WIN
  ? tryRun(`dsh ${addArgs.join(' ')}`, [], { cwd: PROFILE_DIR, shell: true })
  : tryRun('dsh', addArgs, { cwd: PROFILE_DIR })
if (inst.code !== 0) {
  console.log(inst.out)
  cleanup()
  die(`安装失败（rc=${inst.code}）`)
}
ok('add 成功')
const declared = JSON.parse(readText(join(PROFILE_DIR, 'package.json')))
if (declared.dependencies?.[distPkg.name] === undefined) {
  cleanup()
  die(`add 之后 profile 的 package.json 里没有 ${distPkg.name}（声明未写入）`)
}
ok(`profile 声明已写入：${distPkg.name}`)

// ── ④ 核对链接与包身份 ──────────────────────────────────────────────────────
step(4, '核对 node_modules 里的链接与包身份')
const linked = join(PROFILE_DIR, 'node_modules', ...distPkg.name.split('/'))
if (!existsSync(linked)) {
  cleanup()
  die(`安装后 node_modules 里没有 ${distPkg.name}（link 未落位）`)
}
const linkedPkg = JSON.parse(readText(join(linked, 'package.json')))
if (linkedPkg.name !== distPkg.name || linkedPkg.version !== distPkg.version) {
  cleanup()
  die(`链接指向的包身份不符：期望 ${distPkg.name}@${distPkg.version}，实际 ${linkedPkg.name}@${linkedPkg.version}`)
}
ok(`链接就位：${linkedPkg.name}@${linkedPkg.version}`)

// 关键结构差异（这决定了"要不要自带宿主包链接"）：
//   · link: 的真实路径在 profile **之外** → ESM 向上解析永远到不了 profiles/node_modules → 必须自带 @deepseek-ai/* 链接
//   · tgz/npm 装进 profile 自己的 .pnpm 存储 → 真实路径仍在 profile **之内** → 能向上解析到 profiles/node_modules
const real = realpathSync(linked)
const insideProfile = real.toLowerCase().startsWith(PROFILE_DIR.toLowerCase())
info(`真实路径：${real}`)
info(`是否在 profile 内：${insideProfile}  →  ${insideProfile ? '不需要自带宿主链接' : '必须自带宿主链接（link: 场景）'}`)

// ── ⑤ 真启动一次，等到监听行 ────────────────────────────────────────────────
step(5, `真启动探针：dsh --profile ${PROFILE} --port 0 --no-open（最多等 ${Math.round(WAIT_MS / 1000)} 秒）`)
const probeArgs = ['--profile', PROFILE, '--port', '0', '--no-open']
const child = IS_WIN
  ? spawn(`dsh ${probeArgs.join(' ')}`, { cwd: PROFILE_DIR, shell: true, stdio: ['ignore', 'pipe', 'pipe'] })
  : spawn('dsh', probeArgs, { cwd: PROFILE_DIR, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
let out = ''
let listening = null
const onData = (buf) => {
  const s = String(buf)
  out += s
  const m = out.match(/dsh web:\s*(http:\/\/\S+)/)
  if (m && !listening) listening = m[1]
}
child.stdout.on('data', onData)
child.stderr.on('data', onData)

function killTree() {
  try {
    if (process.platform === 'win32') tryRun('taskkill', ['/F', '/T', '/PID', String(child.pid)])
    else { try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') } }
  } catch { /* 已经退出 */ }
}

const t0 = Date.now()
await new Promise((res) => {
  const timer = setInterval(() => {
    if (listening || Date.now() - t0 > WAIT_MS || child.exitCode !== null) {
      clearInterval(timer)
      res()
    }
  }, 500)
})

if (listening) {
  ok(`真启动成功并已监听：${listening}`)
  // **强断言**：只验"服务器起来了"会假绿 —— 插件没被加载时服务器照样监听。
  // 因此再打一个**插件自身的路由**：/api/dsh-ssh/hosts 由本插件的宿主半边注册，
  // 只要不是 404 就说明它真的加载并注册成功了。
  try {
    const u = new URL(listening)
    const probeUrl = `${u.origin}/api/dsh-ssh/hosts?token=${u.searchParams.get('token') ?? ''}`
    const res = await fetch(probeUrl, { signal: AbortSignal.timeout(10000) })
    if (res.status === 404) {
      failed = true
      warn(`插件路由未注册（HTTP 404）：GET /api/dsh-ssh/hosts —— 服务器起来了，但**插件没有被加载**`)
    } else {
      ok(`插件已加载：GET /api/dsh-ssh/hosts -> HTTP ${res.status}（非 404 即证明宿主半边注册成功）`)
    }
  } catch (e) {
    failed = true
    warn(`插件路由探测失败：${e.message}`)
  }
} else {
  failed = true
  console.log('----- dsh 输出（尾部 40 行）-----')
  console.log(out.split('\n').slice(-40).join('\n'))
  console.log('--------------------------------')
  warn('未在超时内看到监听行')
}
killTree()

// ── ⑥ 清理 + 结论 ───────────────────────────────────────────────────────────
step(6, '清理')
cleanup()
if (failed) die('安装冒烟测试失败')
console.log('\n安装冒烟测试通过：本仓库的 dist 能被 DSH 安装并加载')
