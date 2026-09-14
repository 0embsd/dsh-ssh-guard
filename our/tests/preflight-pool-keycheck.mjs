// 重启前预检：确认池里**每一台**主机在加固生效后都能通过身份校验（避免重启后 SSH 全断）。
// 判据：known_hosts 或指纹库中取到期望公钥 → verifier 必须放行；给一个伪造公钥 → 必须拒。
//
// 被测对象由 our/checks/live-target.mjs **自描述定位**（找 link:<本仓库>/dist 的依赖键）。
// 定位失败 → **失败退出**；只有"本机没有池清单"这种**真的无事可做**才 SKIP。
// 这条区分是硬要求：验收脚本"跑不起来却被当成通过"是 2026-09-13 记录在案的真实事故。
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { requireLiveGuard, locateMounted, dshHome, profileName } from '../checks/live-target.mjs'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

// 池主机清单取自本机自己的 SSH 配置；没有清单就没有可预检的目标 → 明确 SKIP（不算失败）
const poolFile = join(dshHome(), 'dsh-ssh.json')
if (!existsSync(poolFile)) {
  const info = locateMounted(repo)
  console.log(`SKIP：未找到本机 SSH 池配置 ${poolFile}，没有可预检的目标主机（跳过，不算失败）。`)
  console.log('  这是"重启前确认每台池主机身份校验仍能通过"的预检，需要一份池主机清单。')
  console.log(`  被测对象定位：${info.name === null ? '✗ ' + info.reason : '✓ 已挂载 ' + info.name}`)
  process.exit(0)
}

let target
try {
  target = requireLiveGuard(repo)
} catch (e) {
  console.error(`✗ 预检中止：${e.message}`)
  process.exit(1)
}

const profileDir = join(dshHome(), 'profiles', profileName())
const require = createRequire(join(profileDir, 'package.json'))
const { makeHostVerifier, parseKnownHosts, parsePins, entryKey } = await import(pathToFileURL(target.guard).href)

const hosts = JSON.parse(readFileSync(poolFile, 'utf8')).hosts
const { map } = parseKnownHosts()
const pins = parsePins()
const log = { info: () => {}, warn: () => {}, error: () => {} }
let pass = 0
let fail = 0

console.log(`== 池内主机身份校验预检（${hosts.length} 台）==`)
console.log(`   被测对象：${target.name}  ←  ${target.guard}`)
for (const h of hosts) {
  const key = entryKey(h.host, h.port)
  const fromKh = map.get(key) ?? []
  const fromPins = pins.get(key)?.keys ?? []
  const src = fromKh.length > 0 ? `known_hosts×${fromKh.length}` : fromPins.length > 0 ? '指纹库(pin)' : '**无来源**'
  const expected = fromKh[0]?.b64 ?? fromPins[0]?.b64
  const v = makeHostVerifier({ host: h.host, port: h.port, alias: h.alias, log })
  const acceptOk = expected !== undefined && v(Buffer.from(expected, 'base64')) === true
  const rejectOk = v(Buffer.alloc(48, 0xab)) === false
  const ok = acceptOk && rejectOk
  if (ok) pass += 1
  else fail += 1
  console.log(`  ${ok ? '✓' : '✗'} ${h.alias.padEnd(14)} ${key.padEnd(24)} 来源=${src.padEnd(18)} 放行=${acceptOk} 伪造拒连=${rejectOk}`)
}
console.log(`\n== 预检：${pass} 通过 / ${fail} 失败（共 ${hosts.length} 台池主机）==`)
process.exit(fail === 0 ? 0 : 1)
