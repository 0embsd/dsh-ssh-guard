// 活体验收的「被测对象定位器」——只做一件事：找到**当前 profile 里真正挂载的那个插件包**。
// ─────────────────────────────────────────────────────────────────────────────
// 为什么需要它（真实事故 · 2026-09-13）：
//   原先活体脚本把路径硬编码成
//     profiles/<档>/node_modules/@linxin666/dsh-ssh/lib/hostkey-guard.js
//   而上游包后来已被自建包取代（挂载名是自建包名），该路径不存在 →
//   脚本以 ERR_MODULE_NOT_FOUND 崩掉；更危险的是有人可能把它当成"跳过" →
//   **验收形同虚设：以为在验，其实一次都没验过**（假凭证，与主机身份守卫要防的是同一类风险）。
//
// 设计原则（三条，写进 docs/QUALITY-GATES.md）：
//   1. **自描述定位**：不看硬编码包名，而是读 profile 的 package.json，
//      找"值等于 link:<本仓库>/dist"的那个依赖键 —— 那才是真正挂载的名字。
//   2. **无法定位 = 失败退出**，绝不静默跳过（跳过会被误读成"验收通过"）。
//   3. **报告身份**：把挂载名与文件路径打印出来，验收结果才可被当凭证采信。
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

/** $DSH_HOME（默认 ~/.dsh）。 */
export function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** 当前档名（默认 web）。 */
export function profileName() {
  return process.env.DSH_PROFILE ?? 'web'
}

/** 本仓库根目录（从本文件位置反推：<repo>/our/checks/live-target.mjs → <repo>）。 */
export function repoRoot() {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..')
}

const norm = (s) => String(s).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

/**
 * 在 profile 的 dependencies 里找出"指向本仓库 dist 的 link:"。
 * @returns {{pkgPath:string, name:string|null, reason:string}}
 */
export function locateMounted(repo = repoRoot(), profile = profileName()) {
  const pkgPath = join(dshHome(), 'profiles', profile, 'package.json')
  if (!existsSync(pkgPath)) return { pkgPath, name: null, reason: `profile 的 package.json 不存在：${pkgPath}` }
  let pkg
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  } catch (e) {
    return { pkgPath, name: null, reason: `package.json 解析失败：${e.message}` }
  }
  const deps = pkg.dependencies ?? {}
  const want = norm(repo) + '/dist'
  // **只认权威判据**：依赖值 = link:<本仓库>/dist。
  // 刻意**不做"按候选包名猜"的退化匹配** —— 那会让验收脚本去验**别人的产物**却报成功
  // （2026-09-13 实测踩到：profile 挂的是另一个仓库的 dist，退化匹配仍返回命中 → 假阳性）。
  for (const [name, spec] of Object.entries(deps)) {
    const v = norm(spec).replace(/^link:/, '')
    if (v === want) return { pkgPath, name, reason: '命中 link:<本仓库>/dist' }
  }
  // 未命中：把"本 profile 里挂着的同类插件"作为**诊断信息**返回（绝不用于解析）
  const others = Object.entries(deps)
    .filter(([n, s]) => /dsh-ssh|dsh-ssh-guard|@linxin666\/dsh-ssh/.test(`${n} ${s}`))
    .map(([n, s]) => `${n} → ${s}`)
  return {
    pkgPath,
    name: null,
    reason: others.length > 0
      ? `profile 挂的是别的插件（${others.join('；')}），不是本仓库的 dist/`
      : 'profile 里没有任何依赖指向本仓库的 dist/',
  }
}

/**
 * 解析**已挂载**的 hostkey-guard.js 路径。
 * 定位失败直接抛错（fail-closed）——调用方应捕获后 exit 非 0。
 * @returns {{name:string, guard:string, pkgPath:string, reason:string}}
 */
export function requireLiveGuard(repo = repoRoot()) {
  const { pkgPath, name, reason } = locateMounted(repo)
  if (name === null) {
    throw new Error(
      `无法定位被测插件（活体验收不可信，已中止）\n  原因：${reason}\n  profile：${pkgPath}\n` +
        `  期望：某个依赖的值为 "link:<本仓库>/dist"（先用 npm run assemble 装配，再把 dist 挂进该 profile）`,
    )
  }
  const guard = join(dshHome(), 'profiles', profileName(), 'node_modules', ...name.split('/'), 'lib', 'hostkey-guard.js')
  if (!existsSync(guard)) {
    throw new Error(
      `被测插件已挂载（${name}）但守卫文件不存在（活体验收不可信，已中止）\n  缺失：${guard}\n` +
        `  可能原因：link: 指向的不是本仓库的 dist/，或 dist/ 尚未装配（跑 npm run assemble）`,
    )
  }
  return { name, guard, pkgPath, reason }
}
