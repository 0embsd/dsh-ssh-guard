// 连接预算"波形"硬判据：每主机并发上限=2 时，N 个 sleep(S) 调用应呈 ceil(N/2) 波，
// 总墙钟 ≈ ceil(N/2)*S；若闸门失效（不限并发）则 ≈ S。这一条不依赖客户端计时推断并发度。
// 用法：node budget-wave-test.mjs <被测主机> [N] [sleepSec]
//   或：GUARD_TEST_HOST=<被测主机> node budget-wave-test.mjs
const TARGET = process.argv[2] ?? process.env.GUARD_TEST_HOST
if (!TARGET) {
  console.log('SKIP：这是连接预算的活体波形测试，需要一台可达的被测主机（不提供则跳过，不算失败）。')
  console.log('  用法：node budget-wave-test.mjs <被测主机> [N] [sleepSec]')
  console.log('    或：GUARD_TEST_HOST=<被测主机> node budget-wave-test.mjs')
  process.exit(0)
}
const N = Number(process.argv[3] ?? 6)
const S = Number(process.argv[4] ?? 2)
const URL = 'http://127.0.0.1:3080/api/dsh-ssh/exec'
const CMD = `sleep ${S}; echo done`

const t0 = Date.now()
const runs = await Promise.all(Array.from({ length: N }, async (_, i) => {
  const a = Date.now()
  const res = await fetch(URL, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ alias: TARGET, command: CMD, timeoutMs: 60000 }),
  })
  const j = await res.json().catch(() => ({}))
  return { i, start: a - t0, end: Date.now() - t0, rc: j?.result?.exitCode, err: j?.error ?? null }
}))
const wall = Date.now() - t0

// 把结束时刻聚类成"波"（间隔 > S/2 视为新波）
const ends = runs.map((r) => r.end).sort((a, b) => a - b)
const waves = []
for (const e of ends) {
  const cur = waves[waves.length - 1]
  if (cur === undefined || e - cur[cur.length - 1] > (S * 1000) / 2) waves.push([e])
  else cur.push(e)
}
const expectWaves = Math.ceil(N / 2)
console.log(`== 波形验证：目标主机=${TARGET} N=${N} 每次 sleep=${S}s ==`)
for (const r of runs.sort((a, b) => a.start - b.start)) {
  console.log(`  #${r.i} 起=${r.start}ms 止=${r.end}ms rc=${r.rc}${r.err ? ' ERR=' + r.err : ''}`)
}
console.log(`\n总墙钟=${wall}ms（${(wall / 1000).toFixed(1)}s）`)
console.log(`观测到 ${waves.length} 波，每波条数=${JSON.stringify(waves.map((w) => w.length))}（期望 ${expectWaves} 波、每波 ≤2）`)

const checks = [
  ['波数 == ceil(N/每主机并发2)', waves.length === expectWaves],
  ['每波条数 ≤2', waves.every((w) => w.length <= 2)],
  ['总墙钟 ≈ 波数×sleep（排队真实发生）', wall >= expectWaves * S * 1000 * 0.75],
  ['总墙钟远大于单波（不是无限并发）', wall > S * 1000 * 1.8],
  ['全部调用成功', runs.every((r) => r.rc === 0)],
]
let fail = 0
for (const [n, ok] of checks) { if (!ok) fail++; console.log(`  ${ok ? '✓' : '✗'} ${n}`) }
console.log(`\n== 结果：${fail === 0 ? 'PASS' : `FAIL(${fail})`} ==`)
process.exit(fail === 0 ? 0 : 1)
