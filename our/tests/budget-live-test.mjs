// 池内连接预算**实时并发**验证（激活后运行；需已重启 dsh web）
// 判据：
//   ① 6 个并发调用 → 服务器侧 ESTABLISHED 计数恒 1（不因并发新增连接）
//   ② 完成时序呈"每主机并发上限=2"的排队波形（不是 6 个同时完成）
//   ③ dsh-ssh-budget.json 出现 waited>0，且 connects 不随调用数增长
// 用法：node budget-live-test.mjs <被测主机> [N]
//   或：GUARD_TEST_HOST=<被测主机> [GUARD_TEST_PORT=<端口>] node budget-live-test.mjs
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const TARGET = process.argv[2] ?? process.env.GUARD_TEST_HOST
if (!TARGET) {
  console.log('SKIP：这是连接预算的活体并发测试，需要一台可达的被测主机（不提供则跳过，不算失败）。')
  console.log('  用法：node budget-live-test.mjs <被测主机> [N]')
  console.log('    或：GUARD_TEST_HOST=<被测主机> [GUARD_TEST_PORT=<端口>] node budget-live-test.mjs')
  process.exit(0)
}
const N = Number(process.argv[3] ?? 6)
const URL = 'http://127.0.0.1:3080/api/dsh-ssh/exec'
const PORT = Number(process.env.GUARD_TEST_PORT ?? 22)
const CMD = `ss -Htn state established sport = :${PORT} | wc -l`

const budgetPath = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'dsh-ssh-budget.json')
const readBudget = () => { try { return JSON.parse(readFileSync(budgetPath, 'utf8')) } catch { return null } }
const before = readBudget()
if (before === null) {
  console.log(`（计数文件 ${budgetPath} 尚未生成——插件在首次调用时创建；本次跑完核对）`)
}

async function once(i) {
  const t0 = Date.now()
  const res = await fetch(URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ alias: TARGET, command: CMD, timeoutMs: 40000 }),
  })
  const json = await res.json().catch(() => ({}))
  const t1 = Date.now()
  const out = (json?.result?.stdout ?? '').trim().split('\n').pop() ?? ''
  return { i, ms: t1 - t0, start: t0, end: t1, rc: json?.result?.exitCode, count: out, err: json?.error }
}

console.log(`== 实时并发验证：目标主机=${TARGET} 并发数=${N} 命令=[${CMD}] ==`)
const t0 = Date.now()
const results = await Promise.all(Array.from({ length: N }, (_, i) => once(i)))
const wall = Date.now() - t0

results.sort((a, b) => a.start - b.start)
console.log('\n各调用结果（按发起顺序）：')
for (const r of results) {
  console.log(`  #${r.i}  起=${r.start - t0}ms  止=${r.end - t0}ms  耗时=${r.ms}ms  远端连接数=${r.count}  rc=${r.rc}${r.err ? ' ERR=' + r.err : ''}`)
}
const counts = [...new Set(results.map((r) => r.count))]
const maxOverlap = (() => {
  const ev = []
  for (const r of results) { ev.push([r.start, 1], [r.end, -1]) }
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  let cur = 0
  let peak = 0
  for (const [, d] of ev) { cur += d; peak = Math.max(peak, cur) }
  return peak
})()

const after = readBudget()
const h = after?.hosts?.[TARGET] ?? {}
console.log(`\n总墙钟=${wall}ms  实测峰值并发=${maxOverlap}`)
console.log(`远端连接数取值集合=${JSON.stringify(counts)}（应恒为 ["1"]）`)
console.log(`预算计数（${TARGET}）：调用=${h.callsTotal} 新建连接=${h.connects} 排队=${h.waited} 速率拦下=${h.rateLimited} 超时=${h.timeouts}`)

const checks = [
  ['远端连接数恒为 1', counts.length === 1 && counts[0] === '1'],
  ['出现排队（waited>0）', (h.waited ?? 0) > 0],
  ['峰值并发不超过每主机上限', maxOverlap <= (after?.limits?.maxConcurrentPerHost ?? 2)],
  ['新建连接未随调用数增长（≤1 次）', (h.connects ?? 0) <= 1],
]
let fail = 0
console.log('')
for (const [name, ok] of checks) { if (!ok) fail += 1; console.log(`  ${ok ? '✓' : '✗'} ${name}`) }
console.log(`\n== 结果：${fail === 0 ? 'PASS' : `FAIL(${fail})`} ==`)
process.exit(fail === 0 ? 0 : 1)
