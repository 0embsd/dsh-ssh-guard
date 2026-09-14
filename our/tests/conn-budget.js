// dsh-ssh 连接预算（并发 / 速率 / 新建连接间隔）——**池内强制**，任何调用方都绕不过
// ─────────────────────────────────────────────────────────────────────────────
// 为什么放在插件里、而不是外层脚本：这类规矩过去只写在外层包装脚本里，
//   任何绕过它的路径（直接调 ssh_exec / ssh_cluster / GUI / 未来的 MCP）都不受约束。
//   多子代理同时冲同一台机器时，唯一的正确行为是**排队复用同一条连接**，而不是
//   "再开一条"（触发 fail2ban）或"直接失败"（触发调用方重试风暴）。
//
// 三道闸门：
//   · 全局并发 maxConcurrentGlobal（默认 4）      —— 整个进程同时进行的远程操作数
//   · 每主机并发 maxConcurrentPerHost（默认 2）   —— 同一 alias 同时在跑的通道数
//   · 每主机速率 maxCallsPerMinutePerHost（默认 60）—— 滑动窗口，超出则等待窗口滑动
//   另有新建连接闸门 beforeConnect()：同一 alias 两次**真握手**最小间隔（默认 5s）
//
// 环境变量：DSH_SSH_BUDGET=off | DSH_SSH_BUDGET_GLOBAL | DSH_SSH_BUDGET_PER_HOST |
//          DSH_SSH_BUDGET_RPM | DSH_SSH_BUDGET_MIN_CONNECT_MS | DSH_SSH_BUDGET_WAIT_MS
// 计数器（供跨工具统一视图）：writeFileSync 到 counterFile（默认由插件注入
//   $DSH_HOME/dsh-ssh-budget.json），外部工具可读取它做统一视图。
import { writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export const BUDGET_DEFAULTS = Object.freeze({
  enabled: true,
  maxConcurrentGlobal: 4,
  maxConcurrentPerHost: 2,
  maxCallsPerMinutePerHost: 60,
  minConnectIntervalMs: 5000,
  maxWaitMs: 120000,
  windowMs: 60000,
  counterFile: null,
  persistIntervalMs: 1000,
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function asPositiveNumber(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

/** 合并环境变量与引擎默认值（环境变量优先）。 */
export function readBudgetOptions(opts = {}, env = process.env) {
  const off = String(env.DSH_SSH_BUDGET ?? '').toLowerCase() === 'off'
  return {
    enabled: off ? false : (opts.enabled ?? BUDGET_DEFAULTS.enabled),
    maxConcurrentGlobal: asPositiveNumber(env.DSH_SSH_BUDGET_GLOBAL, opts.maxConcurrentGlobal ?? BUDGET_DEFAULTS.maxConcurrentGlobal),
    maxConcurrentPerHost: asPositiveNumber(env.DSH_SSH_BUDGET_PER_HOST, opts.maxConcurrentPerHost ?? BUDGET_DEFAULTS.maxConcurrentPerHost),
    maxCallsPerMinutePerHost: asPositiveNumber(env.DSH_SSH_BUDGET_RPM, opts.maxCallsPerMinutePerHost ?? BUDGET_DEFAULTS.maxCallsPerMinutePerHost),
    minConnectIntervalMs: asPositiveNumber(env.DSH_SSH_BUDGET_MIN_CONNECT_MS, opts.minConnectIntervalMs ?? BUDGET_DEFAULTS.minConnectIntervalMs),
    maxWaitMs: asPositiveNumber(env.DSH_SSH_BUDGET_WAIT_MS, opts.maxWaitMs ?? BUDGET_DEFAULTS.maxWaitMs),
    windowMs: asPositiveNumber(env.DSH_SSH_BUDGET_WINDOW_MS, opts.windowMs ?? BUDGET_DEFAULTS.windowMs),
    counterFile: opts.counterFile ?? BUDGET_DEFAULTS.counterFile,
    persistIntervalMs: opts.persistIntervalMs ?? BUDGET_DEFAULTS.persistIntervalMs,
  }
}

/**
 * 造一个连接预算器。所有计数按 alias 分组；`acquire()` 返回的 release 必须调用。
 * @param {object} options
 * @param {(msg: string) => void} [log] 可选日志（默认 console.warn）
 */
export function createBudget(options = {}, log) {
  const cfg = { ...BUDGET_DEFAULTS, ...options }
  const warn = typeof log === 'function' ? log : (msg) => console.warn(msg)
  /** @type {Map<string, {active:number, queue:Array, calls:number[], connects:number, lastCallAt:number|null, lastConnectAt:number|null, waited:number, waitMsTotal:number, timeouts:number, rateLimited:number, lastWaitMs:number}>} */
  const hosts = new Map()
  const totals = { calls: 0, connects: 0, waited: 0, waitMsTotal: 0, timeouts: 0, rateLimited: 0 }
  let globalActive = 0
  let persistTimer = null
  let dirty = false

  const hostState = (alias) => {
    let s = hosts.get(alias)
    if (s === undefined) {
      s = { active: 0, queue: [], calls: [], callsTotal: 0, connects: 0, lastCallAt: null, lastConnectAt: null, waited: 0, waitMsTotal: 0, timeouts: 0, rateLimited: 0, lastWaitMs: 0 }
      hosts.set(alias, s)
    }
    return s
  }

  const trimWindow = (s, now) => {
    const cutoff = now - cfg.windowMs
    while (s.calls.length > 0 && s.calls[0] < cutoff) s.calls.shift()
  }

  function snapshot() {
    const out = { enabled: cfg.enabled, limits: {
      maxConcurrentGlobal: cfg.maxConcurrentGlobal,
      maxConcurrentPerHost: cfg.maxConcurrentPerHost,
      maxCallsPerMinutePerHost: cfg.maxCallsPerMinutePerHost,
      minConnectIntervalMs: cfg.minConnectIntervalMs,
      maxWaitMs: cfg.maxWaitMs,
      windowMs: cfg.windowMs,
    }, totals: { ...totals, globalActive, globalQueued: globalQueue.length }, hosts: {} }
    for (const [alias, s] of hosts) {
      out.hosts[alias] = {
        active: s.active,
        queued: s.queue.length,
        callsLastMinute: s.calls.length,
        callsTotal: s.callsTotal ?? 0,
        connects: s.connects,
        waited: s.waited,
        lastWaitMs: s.lastWaitMs,
        waitMsTotal: s.waitMsTotal,
        rateLimited: s.rateLimited,
        timeouts: s.timeouts,
        lastCallAt: s.lastCallAt === null ? null : new Date(s.lastCallAt).toISOString(),
        lastConnectAt: s.lastConnectAt === null ? null : new Date(s.lastConnectAt).toISOString(),
      }
    }
    out.updated = new Date().toISOString()
    return out
  }

  function persistNow() {
    if (cfg.counterFile === null || cfg.counterFile === undefined) return
    try {
      const target = cfg.counterFile
      mkdirSync(dirname(target), { recursive: true })
      const tmp = target + '.tmp'
      writeFileSync(tmp, JSON.stringify(snapshot(), null, 2) + '\n', { mode: 0o600 })
      renameSync(tmp, target)
      dirty = false
    } catch {
      /* 计数落盘失败不影响主流程 */
    }
  }

  function schedulePersist() {
    dirty = true
    if (persistTimer !== null) return
    persistTimer = setTimeout(() => {
      persistTimer = null
      if (dirty) persistNow()
    }, Math.max(200, cfg.persistIntervalMs))
    persistTimer.unref?.()
  }

  /** 全局 + 每主机并发闸门（FIFO、按 alias 公平）。 */
  const globalQueue = []

  function pump() {
    for (let i = 0; i < globalQueue.length;) {
      const w = globalQueue[i]
      const s = hostState(w.alias)
      if (globalActive >= cfg.maxConcurrentGlobal || s.active >= cfg.maxConcurrentPerHost) {
        i += 1
        continue
      }
      globalQueue.splice(i, 1)
      globalActive += 1
      s.active += 1
      w.start()
    }
  }

  /**
   * 取得一次远程操作的执行许可（超出并发/速率则排队等待）。
   * @returns {Promise<() => void>} release
   */
  function acquire(alias) {
    const now = Date.now()
    const s = hostState(alias)
    s.callsTotal = (s.callsTotal ?? 0) + 1
    totals.calls += 1
    s.lastCallAt = now
    if (!cfg.enabled) return Promise.resolve(() => {})

    const started = Date.now()

    const enterQueue = () => new Promise((resolve, reject) => {
      const waiter = { alias }
      const timer = setTimeout(() => {
        const idx = globalQueue.indexOf(waiter)
        if (idx >= 0) globalQueue.splice(idx, 1)
        s.timeouts += 1
        totals.timeouts += 1
        schedulePersist()
        reject(new Error(`[dsh-ssh budget] ${alias} 排队超过 ${cfg.maxWaitMs}ms 仍未取得许可（并发上限 global=${cfg.maxConcurrentGlobal}/host=${cfg.maxConcurrentPerHost}）——请降低并发或调大 DSH_SSH_BUDGET_WAIT_MS`))
      }, cfg.maxWaitMs)
      // ⚠ 不得 unref：这个定时器守着**调用方正在 await 的 promise**；unref 会让事件循环
      //   误判"无事可做"而退出（Node 顶层 await 报 "unsettled top-level await"，rc=13）。
      //   （persist 定时器可以 unref——它不 gate 任何 promise。）
      waiter.start = () => {
        clearTimeout(timer)
        const waited = Date.now() - started
        s.waited += 1
        s.waitMsTotal += waited
        s.lastWaitMs = waited
        if (waited > 50) totals.waited += 1
        totals.waitMsTotal += waited
        trimWindow(s, Date.now())
        s.calls.push(Date.now())
        schedulePersist()
        resolve(() => {
          globalActive -= 1
          s.active -= 1
          schedulePersist()
          pump()
        })
      }
      globalQueue.push(waiter)
      pump()
    })

    const rateGate = () => {
      trimWindow(s, Date.now())
      if (s.calls.length < cfg.maxCallsPerMinutePerHost) return Promise.resolve()
      const oldest = s.calls[0]
      const wait = Math.max(50, oldest + cfg.windowMs - Date.now() + 5)
      s.rateLimited += 1
      totals.rateLimited += 1
      warn(`[dsh-ssh budget] ${alias} 速率已达 ${cfg.maxCallsPerMinutePerHost}/分钟 → 等待 ${wait}ms 窗口滑动（连接预算：不新建连接、只排队）`)
      schedulePersist()
      return sleep(Math.min(wait, cfg.maxWaitMs)).then(() => rateGate())
    }

    return rateGate().then(enterQueue)
  }

  /**
   * 新建连接闸门：同一 alias 两次真握手之间至少间隔 minConnectIntervalMs。
   * 只在**确实要建连**的路径上调用（复用不经过这里）。
   */
  async function beforeConnect(alias) {
    const s = hostState(alias)
    if (cfg.enabled && s.lastConnectAt !== null && cfg.minConnectIntervalMs > 0) {
      const elapsed = Date.now() - s.lastConnectAt
      if (elapsed < cfg.minConnectIntervalMs) {
        const wait = cfg.minConnectIntervalMs - elapsed
        warn(`[dsh-ssh budget] ${alias} 距上次新建连接仅 ${elapsed}ms（阈值 ${cfg.minConnectIntervalMs}ms）→ 等待 ${wait}ms 再握手（连接预算）`)
        await sleep(wait)
      }
    }
    s.connects += 1
    s.lastConnectAt = Date.now()
    totals.connects += 1
    schedulePersist()
  }

  return {
    config: cfg,
    acquire,
    beforeConnect,
    snapshot,
    persist: persistNow,
    /** 仅测试用：清空计数 */
    _reset() {
      hosts.clear()
      globalQueue.length = 0
      globalActive = 0
      totals.calls = totals.connects = totals.waited = totals.waitMsTotal = totals.timeouts = totals.rateLimited = 0
    },
  }
}
