// 主机密钥探针（不认证、拿到 host key 立即断开）：用于给"known_hosts 无记录"的主机取指纹落库。
// 用法：node probe-hostkey.mjs <被测主机> [port]
//   或：GUARD_TEST_HOST=<被测主机> [GUARD_TEST_PORT=<port>] node probe-hostkey.mjs
// 说明：hostVerifier 拿到 key 后立刻 end()，**不发起认证** → 不产生 sshd 的认证失败日志
//   （fail2ban 按"认证失败/连接频率"计数，本探针只做一次 KEX + TCP，代价最小）。
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { homedir } from 'node:os'

const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const profileDir = join(dshHome, 'profiles', process.env.DSH_PROFILE ?? 'web')
const require = createRequire(join(profileDir, 'package.json'))
const { Client } = require('ssh2')

const host = process.argv[2] ?? process.env.GUARD_TEST_HOST
if (!host) {
  console.log('SKIP：这是活体主机密钥探针，需要一台可达的被测主机（不提供则跳过，不算失败）。')
  console.log('  用法：node probe-hostkey.mjs <被测主机> [port]')
  console.log('    或：GUARD_TEST_HOST=<被测主机> [GUARD_TEST_PORT=<port>] node probe-hostkey.mjs')
  process.exit(0)
}
const port = Number(process.argv[3] ?? process.env.GUARD_TEST_PORT ?? 22)

function keyType(blob) {
  // SSH 公钥 blob：uint32 长度 + 类型字符串
  const len = blob.readUInt32BE(0)
  return blob.subarray(4, 4 + len).toString('utf8')
}

const conn = new Client()
let seen = false
const timer = setTimeout(() => {
  console.error('TIMEOUT: 未在 20s 内完成握手')
  conn.end()
  process.exit(3)
}, 20000)

conn.on('ready', () => {
  // 理论上不会到这（我们在 hostVerifier 里就断开），兜底
  conn.end()
})
conn.on('error', (err) => {
  if (!seen) {
    clearTimeout(timer)
    console.error(`ERROR: ${err.message}`)
    process.exit(1)
  }
})
conn.on('close', () => {
  clearTimeout(timer)
  if (seen) process.exit(0)
})

conn.connect({
  host,
  port,
  username: 'hostkey-probe', // 不会真的认证：hostVerifier 后立即断开
  readyTimeout: 15000,
  tryKeyboard: false,
  hostVerifier: (key) => {
    const blob = Buffer.from(key)
    const fp = 'SHA256:' + createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')
    console.log(`HOST=${host}`)
    console.log(`PORT=${port}`)
    console.log(`TYPE=${keyType(blob)}`)
    console.log(`B64=${blob.toString('base64')}`)
    console.log(`FINGERPRINT=${fp}`)
    seen = true
    setImmediate(() => conn.end())
    return true
  },
})
