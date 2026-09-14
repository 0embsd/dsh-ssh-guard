// 真实链路验证（无需重启 DSH）：把**当前 profile 里已挂载的** hostkey-guard.js 挂到真 ssh2 连接上，
//   ① accept：known_hosts 命中 → 握手通过（KEX 后立即断开，不认证、不产生认证失败日志）
//   ② reject：清单里的记录被篡改 → ssh2 拒绝握手并报错
//
// 用法：node live-verifier-test.mjs <被测主机> [port]
//   或：GUARD_TEST_HOST=<被测主机> [GUARD_TEST_PORT=<port>] node live-verifier-test.mjs
//
// 被测对象由 our/checks/live-target.mjs **自描述定位**（读 profile 的 package.json，
// 找 link:<本仓库>/dist 那个依赖键）。定位失败 → **失败退出**，绝不静默跳过：
// 验收脚本"跑不起来却被当成通过"是 2026-09-13 记录在案的真实事故。
import { createRequire } from 'node:module'
import { writeFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'
import { requireLiveGuard, locateMounted, dshHome, profileName } from '../checks/live-target.mjs'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const host = process.argv[2] ?? process.env.GUARD_TEST_HOST

if (!host) {
  // 活体验证是**可选**的：没有目标主机时无事可做。但仍要把"被测对象是否能定位"报出来，
  // 以便尽早发现"验收基础设施本来就是坏的"。
  const info = locateMounted(repo)
  console.log('SKIP：这是真实链路验证（活体），需要一台可达的被测主机（不提供则跳过，不算失败）。')
  console.log('  用法：node live-verifier-test.mjs <被测主机> [port]')
  console.log('    或：GUARD_TEST_HOST=<被测主机> [GUARD_TEST_PORT=<port>] node live-verifier-test.mjs')
  console.log(`  被测对象定位：${info.name === null ? '✗ ' + info.reason : '✓ 已挂载 ' + info.name}`)
  process.exit(0)
}

let target
try {
  target = requireLiveGuard(repo)
} catch (e) {
  console.error(`✗ 活体验收中止：${e.message}`)
  process.exit(1)
}

const port = Number(process.argv[3] ?? process.env.GUARD_TEST_PORT ?? 22)
const profileDir = join(dshHome(), 'profiles', profileName())
const require = createRequire(join(profileDir, 'package.json'))
const { Client } = require('ssh2')
const { makeHostVerifier, parseKnownHosts, entryKey } = await import(pathToFileURL(target.guard).href)

function attempt(opts) {
  return new Promise((resolve) => {
    const conn = new Client()
    let outcome = null
    const timer = setTimeout(() => { try { conn.end() } catch {} resolve({ ok: false, why: 'timeout' }) }, 15000)
    conn.on('handshake' in conn ? 'handshake' : 'ready', () => {})
    conn.on('error', (err) => { clearTimeout(timer); if (outcome === null) resolve({ ok: false, why: err.message }) })
    conn.on('close', () => { clearTimeout(timer); if (outcome === null) resolve({ ok: false, why: 'closed-without-verdict' }) })
    conn.connect({
      host, port, username: 'hostkey-probe', readyTimeout: 15000, tryKeyboard: false,
      ...opts,
      hostVerifier: (key) => {
        const verdict = opts.verifier(key)
        if (verdict) { outcome = 'accepted'; clearTimeout(timer); setImmediate(() => { try { conn.end() } catch {} resolve({ ok: true, why: 'accepted' }) }) }
        return verdict
      },
    })
  })
}

console.log(`== 真实链路验证 ${host}:${port}（不认证：verifier 后立即断开）==`)
console.log(`   被测对象：${target.name}  ←  ${target.guard}`)

// ① accept：用真实 known_hosts
const v1 = makeHostVerifier({ host, port, alias: 'live-accept', log: { info: () => {}, warn: () => {}, error: () => {} } })
const r1 = await attempt({ verifier: v1 })
console.log(`  [1] known_hosts 命中 → ${r1.ok ? 'PASS（握手通过）' : 'FAIL（' + r1.why + '）'}`)

// ② reject：把该主机的记录篡改 1 字节，写临时清单
const { map } = parseKnownHosts()
const recs = map.get(entryKey(host, port)) ?? []
let r2 = { ok: false, why: 'skip（清单无该主机记录）' }
if (recs.length > 0) {
  const bad = Buffer.from(recs[0].b64, 'base64')
  bad[bad.length - 1] = bad[bad.length - 1] ^ 0x01
  const tmpKh = join(tmpdir(), `kh-tampered-${process.pid}`)
  writeFileSync(tmpKh, `${entryKey(host, port)} ${recs[0].type} ${bad.toString('base64')}\n`)
  const v2 = makeHostVerifier({ host, port, alias: 'live-reject', knownHosts: tmpKh, log: { info: () => {}, warn: () => {}, error: () => {} } })
  r2 = await attempt({ verifier: v2 })
  rmSync(tmpKh, { force: true })
}
console.log(`  [2] 篡改记录 → ${r2.ok ? 'FAIL（竟然放行！）' : 'PASS（已拒连：' + r2.why + '）'}`)

const pass = r1.ok && !r2.ok
console.log(`\n== 结果：${pass ? 'PASS' : 'FAIL'} ==`)
process.exit(pass ? 0 : 1)
