// dsh-ssh 主机密钥守卫（host-key guard）
// ─────────────────────────────────────────────────────────────────────────────
// 目的：上游包的 buildConnectConfig 未设 hostVerifier/hostHash，等于**不校验
//   服务器身份**——任何能在网络路径上冒充目标主机的一方都会被照单全收（命令/输出被窃、
//   返回结果可被伪造 → 假绿凭证）。
// 本模块把"查身份证"补上：**权威清单 = 用户已有的 ~/.ssh/known_hosts**（等于继承系统 OpenSSH
//   过去已建立的信任），缺记录时 **fail-closed 拒连**，只有显式 `DSH_SSH_HOSTKEY_ALLOW_NEW=1`
//   才 TOFU 落库到 `$DSH_HOME/dsh-ssh-hostkeys.json`。
//
// 环境变量：
//   DSH_SSH_HOSTKEY_MODE=strict|off   默认 strict；off = 恢复旧行为（显著告警，仅排障）
//   DSH_SSH_HOSTKEY_ALLOW_NEW=1       无记录时允许首次信任并落库（TOFU，一次性）
//   DSH_SSH_KNOWN_HOSTS=<path>        覆盖 known_hosts 路径（测试用）
//
// 判据（与 OpenSSH 一致）：
//   · 命中 → 放行
//   · 有记录但不匹配 → 拒连 + 打印新旧指纹（**绝不自动更新**）
//   · 无记录 → 默认拒连（fail-closed）
// 注意：查表键按 OpenSSH 规则——非 22 端口用 "[host]:port"；一台主机一把身份证，各查各的。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

/** $DSH_HOME（默认 ~/.dsh）。 */
export function dshHome() {
  const raw = process.env.DSH_HOME
  return raw !== undefined && raw !== '' ? raw : join(homedir(), '.dsh')
}

/** 用户标准 OpenSSH known_hosts 路径。 */
export function knownHostsPath() {
  return process.env.DSH_SSH_KNOWN_HOSTS ?? join(homedir(), '.ssh', 'known_hosts')
}

/** 本模块自己的指纹库（TOFU 落库 / 额外钉扎）。 */
export function pinPath() {
  return join(dshHome(), 'dsh-ssh-hostkeys.json')
}

/** OpenSSH 查表键：非 22 端口带方括号。 */
export function entryKey(host, port = 22) {
  return port === 22 ? host : `[${host}]:${port}`
}

/** SHA256 指纹（OpenSSH 展示格式，去 padding）。 */
export function fingerprint(blob) {
  return 'SHA256:' + createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')
}

/**
 * 解析 known_hosts → Map<查表键, [{type,b64,fp}]>。
 * 跳过注释/空行；`|1|` 哈希主机名条目**不支持**（本机实测 0 条），跳过由调用方告警。
 */
export function parseKnownHosts(path = knownHostsPath()) {
  const map = new Map()
  let skippedHashed = 0
  let text = ''
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return { map, skippedHashed }
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const parts = line.split(/\s+/)
    if (parts.length < 3) continue
    const [hostField, type, b64] = parts
    if (hostField.startsWith('|1|')) {
      skippedHashed += 1
      continue
    }
    let blob
    try {
      blob = Buffer.from(b64, 'base64')
    } catch {
      continue
    }
    for (const h of hostField.split(',')) {
      const list = map.get(h) ?? []
      list.push({ type, b64, fp: fingerprint(blob) })
      map.set(h, list)
    }
  }
  return { map, skippedHashed }
}

/** 读本模块指纹库 → Map<查表键, {keys:[{type,b64,fp}], pinnedAt, source}>。 */
export function parsePins(path = pinPath()) {
  const map = new Map()
  try {
    const json = JSON.parse(readFileSync(path, 'utf8'))
    for (const [k, v] of Object.entries(json.hosts ?? {})) map.set(k, v)
  } catch {
    /* 无文件 = 空库 */
  }
  return map
}

/** 落库一条指纹（合并写入，权限 0600）。 */
export function savePin(key, record, path = pinPath()) {
  let json = { version: 1, hosts: {} }
  try {
    json = JSON.parse(readFileSync(path, 'utf8'))
    json.hosts = json.hosts ?? {}
  } catch {
    json = { version: 1, hosts: {} }
  }
  json.hosts[key] = record
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(json, null, 2) + '\n', { mode: 0o600 })
  return path
}

/**
 * 造一个 ssh2 的 hostVerifier：`(key: Buffer) => boolean`。
 * @param {{host:string, port?:number, alias?:string, log?:object,
 *          knownHosts?:string, pins?:string, allowNew?:()=>boolean, mode?:()=>string}} opts
 * @returns {(key: Buffer) => boolean}
 */
export function makeHostVerifier(opts) {
  const {
    host,
    port = 22,
    alias = '',
    log = console,
    knownHosts = knownHostsPath(),
    pins = pinPath(),
    allowNew = () => process.env.DSH_SSH_HOSTKEY_ALLOW_NEW === '1',
    mode = () => (process.env.DSH_SSH_HOSTKEY_MODE ?? 'strict').toLowerCase(),
  } = opts
  const key = entryKey(host, port)
  const label = alias !== '' ? `${alias} (${key})` : key
  const { map, skippedHashed } = parseKnownHosts(knownHosts)
  const pinsMap = parsePins(pins)
  const want = [...(map.get(key) ?? []), ...(pinsMap.get(key)?.keys ?? [])]
  let warnedHashed = false

  return function hostVerifier(presented) {
    const m = mode()
    if (m === 'off') {
      log.warn?.(`[dsh-ssh hostkey] ⚠ DSH_SSH_HOSTKEY_MODE=off —— **跳过主机身份校验**：${label}（仅排障用，禁用即恢复中间人风险）`)
      return true
    }
    const blob = Buffer.from(presented)
    const b64 = blob.toString('base64')
    const fp = fingerprint(blob)
    if (skippedHashed > 0 && !warnedHashed) {
      warnedHashed = true
      log.warn?.(`[dsh-ssh hostkey] ⚠ ${knownHosts} 含 ${skippedHashed} 条哈希主机名条目（|1|）——本守卫不支持，对这些主机按"无记录"处理`)
    }
    if (want.length > 0) {
      if (want.some((w) => w.b64 === b64)) {
        log.info?.(`[dsh-ssh hostkey] ✓ 身份校验通过：${label} ${fp}`)
        return true
      }
      const expect = want.map((w) => `${w.type} ${w.fp}`).join(' / ')
      log.error?.(
        `[dsh-ssh hostkey] ✗ **主机密钥不匹配** ${label}\n` +
          `    收到：${fp}\n    期望：${expect}\n` +
          `    → 拒绝连接（绝不自动更新；确认服务器确已换钥后，请更新 ~/.ssh/known_hosts 或 ${pins}）`,
      )
      return false
    }
    if (allowNew()) {
      const record = {
        host,
        port,
        keys: [{ type: 'presented', b64, fp }],
        pinnedAt: new Date().toISOString(),
        source: 'tofu-allowed',
      }
      savePin(key, record, pins)
      log.warn?.(`[dsh-ssh hostkey] ⚠ 首次信任（TOFU）已落库：${label} ${fp} → ${pins}`)
      return true
    }
    log.error?.(
      `[dsh-ssh hostkey] ✗ ${label} 无主机密钥记录 → **拒绝连接（fail-closed）**\n` +
        `    收到指纹：${fp}\n` +
        `    → 确认指纹无误后：① 收入 ~/.ssh/known_hosts（或系统 ssh 连一次），或 ② 以 DSH_SSH_HOSTKEY_ALLOW_NEW=1 重试一次落库`,
    )
    return false
  }
}
