// hostkey-guard 单元测试（不连网、不重启 DSH、**不依赖本机 ~/.ssh/known_hosts**）
// ─────────────────────────────────────────────────────────────────────────────
// 夹具是测试**自己写的临时 known_hosts**（指纹由确定性 blob 生成，含一个非 22 端口），
// 因此任何机器上跑都是同一结果：21 例全绿、退出码 0 = 通过。
//
// 覆盖六组判据：
//   [1] 夹具记录命中 → accept        [4] ALLOW_NEW=1 → accept 且落库（TOFU）
//   [2] 篡改 1 字节 → reject          [5] MODE=off → 逃生口放行
//   [3] 无记录 → reject（fail-closed）[6] 非 22 端口的查表键格式（OpenSSH 规则）
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parseKnownHosts, entryKey, fingerprint, makeHostVerifier } from './hostkey-guard.js'

const log = { info: () => {}, warn: () => {}, error: () => {} }
let pass = 0
let fail = 0
function check(name, got, want) {
  const ok = got === want
  if (ok) pass += 1
  else fail += 1
  console.log(`  ${ok ? '✓' : '✗'} ${name}（got=${got} want=${want}）`)
}

// ── 自建夹具：5 台主机（含一个非 22 端口）；地址用 RFC 5737 文档专用网段 ─────────
const FIXTURES = [
  ['host-a', '192.0.2.10', 22],
  ['host-b', '192.0.2.11', 22],
  ['host-c', '192.0.2.12', 22],
  ['host-d', '192.0.2.13', 22],
  ['host-e', '192.0.2.14', 62222],
]
const blobs = FIXTURES.map((_, i) => Buffer.alloc(32, i + 1))
const khFixture = join(tmpdir(), `dsh-ssh-kh-fixture-${process.pid}`)
writeFileSync(
  khFixture,
  FIXTURES.map(([, host, port], i) => `${entryKey(host, port)} ssh-ed25519 ${blobs[i].toString('base64')}`).join('\n') + '\n',
)

// 绝不写用户的真实钉扎库：所有用例显式传临时 pins 路径
const neverPins = join(tmpdir(), `dsh-ssh-pins-never-${process.pid}.json`)
if (existsSync(neverPins)) rmSync(neverPins)

console.log(`known_hosts 夹具 = ${khFixture}`)
const { map, skippedHashed } = parseKnownHosts(khFixture)
console.log(`  解析条目 = ${map.size} 个查表键，哈希跳过 = ${skippedHashed}`)

console.log('\n[1] 夹具记录命中 → accept')
for (const [alias, host, port] of FIXTURES) {
  const k = entryKey(host, port)
  const recs = map.get(k)
  if (!recs || recs.length === 0) {
    check(`${alias} ${k} 夹具存在`, false, true)
    continue
  }
  const v = makeHostVerifier({ host, port, alias, log, knownHosts: khFixture, pins: neverPins })
  check(`${alias} ${k} ${recs[0].type} 命中`, v(Buffer.from(recs[0].b64, 'base64')), true)
}

console.log('\n[2] 篡改 1 字节 → reject（有记录但不匹配）')
for (const [alias, host, port] of FIXTURES) {
  const recs = map.get(entryKey(host, port))
  if (!recs || recs.length === 0) {
    check(`${alias} 夹具存在`, false, true)
    continue
  }
  const bad = Buffer.from(recs[0].b64, 'base64')
  bad[bad.length - 1] = bad[bad.length - 1] ^ 0x01
  const v = makeHostVerifier({ host, port, alias, log, knownHosts: khFixture, pins: neverPins })
  check(`${alias} 篡改后拒连`, v(bad), false)
}

console.log('\n[3] 无记录 → reject（fail-closed；ALLOW_NEW 未开）')
{
  const host = '192.0.2.200'
  const port = 2222
  const v = makeHostVerifier({ host, port, alias: 'ghost', log, knownHosts: khFixture, pins: neverPins })
  check('未知主机拒连', v(Buffer.alloc(32, 7)), false)
  check('未落库（拒绝路径不写盘）', existsSync(neverPins), false)
}

console.log('\n[4] ALLOW_NEW=1 → accept 且落库（TOFU），二次连接起走钉扎')
{
  const host = '192.0.2.201'
  const port = 22
  const pins = join(tmpdir(), `dsh-ssh-hostkeys-test-${process.pid}.json`)
  if (existsSync(pins)) rmSync(pins)
  const blob = Buffer.alloc(48, 3)
  const v1 = makeHostVerifier({ host, port, alias: 'newbie', log, knownHosts: khFixture, pins, allowNew: () => true })
  check('首次 TOFU 放行', v1(blob), true)
  check('落库文件已生成', existsSync(pins), true)
  const saved = JSON.parse(readFileSync(pins, 'utf8'))
  check('落库键名正确（22 端口不带括号）', Object.keys(saved.hosts)[0], host)
  check('落库指纹正确', saved.hosts[host].keys[0].fp, fingerprint(blob))
  // 二次：换一个 key → 必须拒（已钉扎）
  const v2 = makeHostVerifier({ host, port, alias: 'newbie', log, knownHosts: khFixture, pins, allowNew: () => true })
  check('钉扎后换钥拒连', v2(Buffer.alloc(48, 9)), false)
  // 同钥 → 放行
  const v3 = makeHostVerifier({ host, port, alias: 'newbie', log, knownHosts: khFixture, pins, allowNew: () => true })
  check('钉扎后同钥放行', v3(blob), true)
  rmSync(pins, { force: true })
}

console.log('\n[5] MODE=off → 逃生口放行（排障用，必须可用）')
{
  const v = makeHostVerifier({
    host: '192.0.2.202', port: 22, alias: 'any', log, knownHosts: khFixture, pins: neverPins, mode: () => 'off',
  })
  check('off 档放行', v(Buffer.alloc(16, 1)), true)
}

console.log('\n[6] 非 22 端口的查表键格式（OpenSSH 规则）')
check('22 端口', entryKey('h', 22), 'h')
check('62222 端口', entryKey('h', 62222), '[h]:62222')

rmSync(khFixture, { force: true })
rmSync(neverPins, { force: true })
console.log(`\n== 结果：pass=${pass} fail=${fail} ==`)
process.exit(fail === 0 ? 0 : 1)
