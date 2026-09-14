// conn-budget 单元测试（纯逻辑、无网络、无 DSH）：验证三道闸门 + 新建连接间隔 + 超时 + off 逃生口。
// 退出码 0 = 全绿。
import { readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createBudget, readBudgetOptions, BUDGET_DEFAULTS } from './conn-budget.js'

let pass = 0
let fail = 0
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`  ${ok ? '✓' : '✗'} ${name}（got=${JSON.stringify(got)} want=${JSON.stringify(want)}）`)
}
const checkTrue = (name, cond, extra = '') => {
  cond ? pass++ : fail++
  console.log(`  ${cond ? '✓' : '✗'} ${name}${extra ? '（' + extra + '）' : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const quiet = () => {}

// ── [1] 每主机并发闸门：5 个并发任务、上限 2 → 峰值并发 ≤2，且至少 3 个发生等待 ──
{
  console.log('\n[1] 每主机并发闸门（perHost=2，5 个并发）')
  const b = createBudget({ maxConcurrentGlobal: 8, maxConcurrentPerHost: 2, maxCallsPerMinutePerHost: 1000, maxWaitMs: 10000 }, quiet)
  let active = 0
  let peak = 0
  const task = async () => {
    const release = await b.acquire('host-a')
    active += 1
    peak = Math.max(peak, active)
    await sleep(60)
    active -= 1
    release()
  }
  await Promise.all(Array.from({ length: 5 }, task))
  const snap = b.snapshot()
  checkTrue('峰值并发 ≤2', peak <= 2, `peak=${peak}`)
  check('总等待次数', snap.hosts['host-a'].waited, 5)
  checkTrue('确实排队（waited 且 lastWaitMs>0）', snap.hosts['host-a'].lastWaitMs > 0, `lastWaitMs=${snap.hosts['host-a'].lastWaitMs}`)
}

// ── [2] 全局并发闸门：3 个不同主机、全局上限 2 → 峰值 ≤2 ──
{
  console.log('\n[2] 全局并发闸门（global=2，3 主机各 1 任务）')
  const b = createBudget({ maxConcurrentGlobal: 2, maxConcurrentPerHost: 5, maxCallsPerMinutePerHost: 1000, maxWaitMs: 10000 }, quiet)
  let active = 0
  let peak = 0
  const task = (alias) => (async () => {
    const release = await b.acquire(alias)
    active += 1
    peak = Math.max(peak, active)
    await sleep(60)
    active -= 1
    release()
  })()
  await Promise.all([task('h1'), task('h2'), task('h3')])
  checkTrue('峰值并发 ≤2', peak <= 2, `peak=${peak}`)
  check('全局等待计数 ≥1', b.snapshot().totals.waited >= 1, true)
}

// ── [3] 速率闸门：窗口 300ms、上限 2 → 第 3 次必须等待 ──
{
  console.log('\n[3] 速率闸门（rpm=2，窗口压到 300ms）')
  const b = createBudget({ maxConcurrentGlobal: 8, maxConcurrentPerHost: 8, maxCallsPerMinutePerHost: 2, windowMs: 300, maxWaitMs: 10000 }, quiet)
  const t0 = Date.now()
  for (let i = 0; i < 3; i++) { const r = await b.acquire('h'); r() }
  const elapsed = Date.now() - t0
  const snap = b.snapshot()
  checkTrue('第 3 次被速率闸门拦下（耗时 ≥200ms）', elapsed >= 200, `elapsed=${elapsed}ms`)
  checkTrue('rateLimited 计数 ≥1', snap.hosts.h.rateLimited >= 1, `rateLimited=${snap.hosts.h.rateLimited}`)
  checkTrue('调用数已进窗口', snap.hosts.h.callsLastMinute >= 1, `calls=${snap.hosts.h.callsLastMinute}（窗口 300ms，早期条目已滑出属正常）`)
}

// ── [4] 新建连接最小间隔 ──
{
  console.log('\n[4] 新建连接间隔（minConnectIntervalMs=250）')
  const b = createBudget({ minConnectIntervalMs: 250 }, quiet)
  const t0 = Date.now()
  await b.beforeConnect('h')
  await b.beforeConnect('h')
  const gap = Date.now() - t0
  checkTrue('两次握手间隔 ≥250ms', gap >= 240, `gap=${gap}ms`)
  check('新建连接计数', b.snapshot().hosts.h.connects, 2)
}

// ── [5] 排队超时 → 抛错 + timeouts 计数 ──
{
  console.log('\n[5] 排队超时（perHost=1，占用中，maxWaitMs=200）')
  const b = createBudget({ maxConcurrentGlobal: 4, maxConcurrentPerHost: 1, maxCallsPerMinutePerHost: 1000, maxWaitMs: 200 }, quiet)
  const hold = await b.acquire('h')
  let err = null
  try { await b.acquire('h') } catch (e) { err = e.message }
  hold()
  checkTrue('第二次抛错且信息含“排队超过”', typeof err === 'string' && err.includes('排队超过'), String(err).slice(0, 60))
  check('timeouts 计数', b.snapshot().hosts.h.timeouts, 1)
}

// ── [6] off 逃生口 → 直通不排队 ──
{
  console.log('\n[6] DSH_SSH_BUDGET=off 逃生口')
  const opts = readBudgetOptions({}, { DSH_SSH_BUDGET: 'off' })
  check('enabled=false', opts.enabled, false)
  const b = createBudget({ ...opts, maxConcurrentPerHost: 1, maxWaitMs: 100 }, quiet)
  const hold = await b.acquire('h')
  const t0 = Date.now()
  const r2 = await b.acquire('h')
  const dt = Date.now() - t0
  r2(); hold()
  checkTrue('off 时第二次不再等待（<50ms）', dt < 50, `dt=${dt}ms`)
}

// ── [7] 环境变量覆盖 + 计数落盘 ──
{
  console.log('\n[7] 环境覆盖 + 计数落盘')
  const opts = readBudgetOptions({}, {
    DSH_SSH_BUDGET_GLOBAL: '7', DSH_SSH_BUDGET_PER_HOST: '3', DSH_SSH_BUDGET_RPM: '11',
    DSH_SSH_BUDGET_MIN_CONNECT_MS: '1234', DSH_SSH_BUDGET_WAIT_MS: '4321', DSH_SSH_BUDGET_WINDOW_MS: '999',
  })
  check('env 覆盖 global/perHost/rpm', [opts.maxConcurrentGlobal, opts.maxConcurrentPerHost, opts.maxCallsPerMinutePerHost], [7, 3, 11])
  check('env 覆盖 minConnect/wait/window', [opts.minConnectIntervalMs, opts.maxWaitMs, opts.windowMs], [1234, 4321, 999])

  const file = join(tmpdir(), `dsh-ssh-budget-test-${process.pid}.json`)
  if (existsSync(file)) rmSync(file)
  const b = createBudget({ ...BUDGET_DEFAULTS, counterFile: file, persistIntervalMs: 200 }, quiet)
  const r = await b.acquire('h1')
  await b.beforeConnect('h1')
  r()
  b.persist()
  checkTrue('计数文件已生成', existsSync(file), file)
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  check('落盘含该主机', Object.keys(saved.hosts), ['h1'])
  check('落盘 connects=1', saved.hosts.h1.connects, 1)
  check('落盘含 limits', typeof saved.limits.maxConcurrentPerHost, 'number')
  rmSync(file, { force: true })
}

console.log(`\n== 结果：pass=${pass} fail=${fail} ==`)
process.exit(fail === 0 ? 0 : 1)
