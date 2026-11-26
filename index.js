/**
 * dsh-plugin-reverse-proxy — 把 nginx 的 dsh 反向代理搬进 DSH 插件。
 *
 * 背景：dsh web 只监听 127.0.0.1:3080，且 /api 的 Host/Origin 校验只认
 * “看起来像本机”的请求。原先由 nginx 监听 8080 并改写请求头把手；
 * 这个插件用纯 Node 做同样的事：
 *
 *   浏览器(LAN) ──▶ 本插件 :8080 ──(改写 Host/Origin/Sec-Fetch-Site)──▶ 127.0.0.1:3080
 *
 * 行为对齐原 nginx 配置（/etc/nginx/sites-available/dsh）：
 *   - Host: 127.0.0.1:3080、Origin: http://127.0.0.1:3080、Sec-Fetch-Site: same-origin
 *   - 透传 Cookie，清空 Referer，补 X-Real-IP / X-Forwarded-For / X-Forwarded-Proto
 *   - WebSocket / SSE 不缓冲、不掐超时（3600s 对齐）
 *   - 请求体上限 200m
 *
 * 端口被占用（例如 nginx 还没停）时每 5 秒重试，不抛异常拖垮宿主。
 */

import crypto from 'node:crypto'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import zlib from 'node:zlib'
import { apply as applyTrustedConnection } from './vendor/skip/host.js'
import {
  blockIp,
  DEFAULT_PORT,
  describeLanState,
  effectiveListenHost,
  effectivePort,
  getLanState,
  IPV6_WARNING_TEXT,
  LAN_WARNING_TEXT,
  MIN_KEY_LENGTH,
  PUBLIC_WARNING_TEXT,
  isBlocked,
  isScanBlocked,
  normalizeIp,
  resetConfig,
  setScanGuard,
  onLanChange,
  addForward,
  removeForward,
  setAccessKey,
  setBlacklistEnabled,
  setForwardsEnabled,
  setIpv6,
  setLanAccess,
  setPublicAccess,
  setPort,
  STATE_FILE,
  unblockIp,
  validateKey,
  validatePort,
} from './lan-access.js'

const HOP_BY_HOP = new Set([
  'connection', 'proxy-connection', 'keep-alive', 'te', 'trailer',
  'transfer-encoding', 'upgrade',
])

const DEFAULTS = {
  // 监听地址/端口都不再听配置：地址由「局域网访问开关」决定，
  // 端口由设置页/命令行改完存进状态文件（默认 8080），重启保留。
  listenPort: DEFAULT_PORT,
  listenIpv6: true,
  upstreamHost: '127.0.0.1',
  upstreamPort: 3080,
  upstreamHostHeader: '127.0.0.1:3080',
  upstreamOrigin: 'http://127.0.0.1:3080',
  maxBodyBytes: 200 * 1024 * 1024,
  retryMs: 5000,
}

const normalize = (config) => {
  const c = { ...DEFAULTS, ...(config || {}) }
  c.listenHost = effectiveListenHost()
  c.listenPort = effectivePort()
  c.upstreamPort = Number(c.upstreamPort) || DEFAULTS.upstreamPort
  c.maxBodyBytes = Number(c.maxBodyBytes) || DEFAULTS.maxBodyBytes
  if (!c.upstreamHostHeader) c.upstreamHostHeader = '127.0.0.1:' + c.upstreamPort
  if (!c.upstreamOrigin) c.upstreamOrigin = 'http://' + c.upstreamHostHeader
  return c
}

/** 把客户端请求头改写成「本机访问」的样子，与 nginx 那套 proxy_set_header 等价 */
function upstreamHeaders(req, cfg, extra = {}) {
  const out = {}
  for (const [k, v] of Object.entries(req.headers)) {
    if (HOP_BY_HOP.has(k)) continue
    out[k] = v
  }
  out.host = cfg.upstreamHostHeader
  out.origin = cfg.upstreamOrigin
  out['sec-fetch-site'] = 'same-origin'
  out.referer = ''
  const remote = req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : ''
  if (remote) out['x-real-ip'] = remote
  const prior = req.headers['x-forwarded-for']
  out['x-forwarded-for'] = prior ? prior + ', ' + remote : remote
  out['x-forwarded-proto'] = 'http'
  return { ...out, ...extra }
}

/** 反向代理响应头：去掉逐跳字段，其余原样 */
function downHeaders(headers) {
  const out = {}
  for (const [k, v] of Object.entries(headers)) {
    if (k === 'connection' || k === 'keep-alive' || k === 'proxy-connection' || k === 'upgrade') continue
    if (k === 'transfer-encoding') continue // 由 Node 重新分块
    out[k] = v
  }
  return out
}

/** 只有未被上游压缩的文本类响应才值得 gzip；SSE/二进制/已压缩的直通。 */
const COMPRESSIBLE_TYPE = /^(?:text\/|application\/(?:javascript|ecmascript|json|xml|xhtml\+xml|manifest\+json)|image\/svg\+xml)/i

function wantsGzip(req, up) {
  if (req.method === 'HEAD') return false
  if (up.statusCode !== 200) return false
  if (up.headers['content-encoding']) return false
  const type = String(up.headers['content-type'] || '')
  if (/event-stream/i.test(type)) return false
  if (!COMPRESSIBLE_TYPE.test(type)) return false
  return /\bgzip\b/i.test(String(req.headers['accept-encoding'] || ''))
}

/** 构建产物带内容指纹（/assets 文件 hash、/plugins 组合包 rev），可长期缓存。 */
function isImmutableAsset(url) {
  const raw = String(url || '')
  const path = raw.split('?')[0]
  if (path.startsWith('/assets/')) return true
  if (path.startsWith('/plugins/') && /[?&]rev=[0-9a-z]{6,}/i.test(raw)) return true
  return false
}

/**
 * 局域网开关的两个入口（设置页走 HTTP，命令行走 /lan 斜杠命令）。
 * 两边都改同一份 lan-access 状态文件，所以永远同步；改完立刻重建监听。
 */
/** 内网/本机地址判定：总开关开着但没开公网时，只放行这些来源。 */
/** 虚拟网卡 / 容器的名字：这些地址对「别人怎么访问这台机器」没有意义，直接跳过。 */
const VIRTUAL_IFACE = /^(lo|docker|veth|br-|virbr|vmnet|vboxnet|tun|tap|wg|tailscale|zt|utun|ip6tnl|sit|dummy|cni|flannel|kube|lxc|podman|ham)/i

/** 读 `ip -6 addr` 的 valid_lft，用来挑「活得最久」的那条 IPv6。失败就返回空表。 */
function ipv6Lifetimes() {
  const map = new Map()
  try {
    const out = execFileSync('ip', ['-6', 'addr', 'show', 'scope', 'global'], {
      encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'],
    })
    let current = ''
    for (const line of out.split('\n')) {
      const a = line.match(/inet6\s+([0-9a-fA-F:]+)\/\d+/)
      if (a) { current = a[1].toLowerCase(); continue }
      const v = line.match(/valid_lft\s+(\d+)sec/)
      if (v && current) { map.set(current, Number(v[1])); current = '' }
    }
  } catch { /* 没有 ip 命令就退化为主序 */ }
  return map
}

/** 收集「这台机器真正的」访问地址：跳过回环、虚拟网卡、链路本地。 */
export function collectAddresses() {
  const lifetimes = ipv6Lifetimes()
  const lan4 = []
  const lan6 = []
  const wan6 = []
  const ifaces = os.networkInterfaces()
  for (const [name, list] of Object.entries(ifaces)) {
    if (!list || VIRTUAL_IFACE.test(name)) continue
    for (const item of list) {
      if (item.internal) continue
      const addr = normalizeIp(item.address)
      if (addr === '') continue
      if (net.isIPv4(addr)) {
        if (!isPrivateIp(addr)) continue // 只认内网 IPv4，公网 IPv4 由出口探测拿
        lan4.push({ address: addr, iface: name, lifetime: 0 })
        continue
      }
      const lower = addr.toLowerCase()
      if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) continue // 链路本地
      if (lower === '::1') continue
      const lifetime = lifetimes.get(lower) ?? 0
      if (lower.startsWith('fc') || lower.startsWith('fd')) {
        lan6.push({ address: addr, iface: name, lifetime })
      } else {
        wan6.push({ address: addr, iface: name, lifetime }) // 2000::/3 全局
      }
    }
  }
  const byLife = (a, b) => b.lifetime - a.lifetime
  return { lan4: lan4.sort(byLife), lan6: lan6.sort(byLife), wan6: wan6.sort(byLife) }
}

export function isPrivateIp(value) {
  const ip = normalizeIp(value)
  if (ip === '') return false
  if (ip === '::1') return true
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase()
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true // fc00::/7
    if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true // fe80::/10
    return false
  }
  const parts = ip.split('.').map((item) => Number(item))
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n))) return false
  const [a, b] = parts
  if (a === 127) return true // 回环
  if (a === 10) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 169 && b === 254) return true // 链路本地
  return false
}

/** 探测出口公网 IPv4（拿不到就返回 null）。结果缓存 10 分钟，别每次开设置页都去求一次。 */
let wan4Cache = { at: 0, value: null }
const PORT_ALIVE_CACHE = new Map()

// 额外端口探活：看 127.0.0.1:port 有没有服务在听（3 秒缓存，卡片 8 秒轮询一次够用）
export async function probePortAlive(port) {
  const now = Date.now()
  const hit = PORT_ALIVE_CACHE.get(port)
  if (hit && now - hit.at < 3000) return hit.alive
  const alive = await new Promise((resolve) => {
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      try { sock.destroy() } catch { /* 已关 */ }
      resolve(value)
    }
    const sock = net.connect({ port: Number(port), host: '127.0.0.1' })
    sock.setTimeout(400, () => done(false))
    sock.on('connect', () => done(true))
    sock.on('error', () => done(false))
  })
  PORT_ALIVE_CACHE.set(port, { at: now, alive })
  return alive
}

export async function probeWan4({ force = false } = {}) {
  const now = Date.now()
  if (!force && now - wan4Cache.at < 600000) return wan4Cache.value
  const value = await new Promise((resolve) => {
    let settled = false
    const done = (v) => { if (!settled) { settled = true; resolve(v) } }
    try {
      const req = https.get('https://api.ipify.org?format=text', (res) => {
        if (res.statusCode !== 200) { res.resume(); return done(null) }
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => { if (body.length < 64) body += chunk })
        res.on('end', () => {
          const ip = normalizeIp(body.trim())
          done(net.isIPv4(ip) ? ip : null)
        })
      })
      req.setTimeout(2500, () => { req.destroy(); done(null) })
      req.on('error', () => done(null))
    } catch { done(null) }
  })
  wan4Cache = { at: now, value }
  return value
}

function registerLanControl(ctx, cfg, log, extra = {}) {
  const sendJson = (res, status, body) => {
    const raw = JSON.stringify(body)
    try {
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(raw),
      })
      res.end(raw)
    } catch { /* 连接已断 */ }
  }

  const readBody = (req) => new Promise((resolve, reject) => {
    let raw = ''
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 4096) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      raw += chunk
    })
    req.on('end', () => {
      if (raw === '') return resolve({})
      try { resolve(JSON.parse(raw)) } catch (e) { reject(new Error('请求体不是合法 JSON')) }
    })
    req.on('error', reject)
  })

  const routeStatus = {
    kind: 'exact',
    path: '/reproxy-lan/status',
    handler: (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { ok: false, error: '只支持 GET' })
        return
      }
      sendJson(res, 200, { ...describeLanState(), warning: LAN_WARNING_TEXT })
    },
  }

  const routeSet = {
    kind: 'exact',
    path: '/reproxy-lan/set',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: '只支持 POST' })
        return
      }
      let body
      try {
        body = await readBody(req)
      } catch (e) {
        sendJson(res, 400, { ok: false, error: e.message })
        return
      }
      // 必须由用户在弹窗里点过「确定」——前端会把它写成 confirm:true
      if (body.confirm !== true) {
        sendJson(res, 400, { ok: false, error: '缺少用户确认（confirm:true）', warning: LAN_WARNING_TEXT })
        return
      }
      if (typeof body.enabled !== 'boolean') {
        sendJson(res, 400, { ok: false, error: 'enabled 必须是布尔值' })
        return
      }
      try {
        setLanAccess(body.enabled, 'settings')
        log('warn', '设置页切换局域网访问 → ' + (body.enabled ? '开启' : '关闭'))
        sendJson(res, 200, describeLanState())
      } catch (e) {
        sendJson(res, 500, { ok: false, error: e.message })
      }
    },
  }


  /**
   * 改端口：先试着 bind 一下确认没被占，再写状态文件并重建监听。
   * 不先探测的话，端口被占会掉进 retryMs 重试循环，用户在界面上只看到「保存成功但不通」。
   */
  const checkPortFree = (port, host) => new Promise((resolve) => {
    const probe = net.createServer()
    probe.once('error', (err) => resolve({ ok: false, error: err && err.code === 'EADDRINUSE' ? ('端口 ' + port + ' 已被占用') : ('端口检查失败：' + (err && err.message)) }))
    probe.once('listening', () => probe.close(() => resolve({ ok: true })))
    try {
      probe.listen({ port, host: host === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1' })
    } catch (e) {
      resolve({ ok: false, error: '端口检查失败：' + (e && e.message) })
    }
  })

  const routePort = {
    kind: 'exact',
    path: '/reproxy-lan/port',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: '只支持 POST' })
        return
      }
      let body
      try {
        body = await readBody(req)
      } catch (e) {
        sendJson(res, 400, { ok: false, error: e.message })
        return
      }
      const parsed = validatePort(body.port)
      if (!parsed.ok) {
        sendJson(res, 400, { ok: false, error: parsed.error })
        return
      }
      if (parsed.port === cfg.listenPort) {
        sendJson(res, 200, describeLanState())
        return
      }
      const free = await checkPortFree(parsed.port, effectiveListenHost())
      if (!free.ok) {
        sendJson(res, 409, { ok: false, error: free.error })
        return
      }
      try {
        setPort(parsed.port, 'settings')
        log('info', '设置页把监听端口改为 ' + parsed.port)
        sendJson(res, 200, describeLanState())
      } catch (e) {
        sendJson(res, 500, { ok: false, error: e.message })
      }
    },
  }

  const listClients = typeof extra.listClients === 'function' ? extra.listClients : () => []
  const withClients = (body) => ({ ...body, clients: listClients() })

  const routeClients = {
    kind: 'exact',
    path: '/reproxy-lan/clients',
    handler: (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { ok: false, error: '只支持 GET' })
        return
      }
      sendJson(res, 200, withClients(describeLanState()))
    },
  }

  /** 黑名单总开关：关掉只是不拦，名单留着。 */
  const routeBlacklist = {
    kind: 'exact',
    path: '/reproxy-lan/blacklist',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: '只支持 POST' })
        return
      }
      let body
      try {
        body = await readBody(req)
      } catch (e) {
        sendJson(res, 400, { ok: false, error: e.message })
        return
      }
      if (typeof body.enabled !== 'boolean') {
        sendJson(res, 400, { ok: false, error: 'enabled 必须是布尔值' })
        return
      }
      try {
        setBlacklistEnabled(body.enabled, 'settings')
        log(body.enabled ? 'warn' : 'info', '设置页把黑名单' + (body.enabled ? '打开' : '关掉'))
        sendJson(res, 200, withClients(describeLanState()))
      } catch (e) {
        sendJson(res, 500, { ok: false, error: e.message })
      }
    },
  }

  /** 拉黑：同一个 IP 重复点不会重复写（added:false）。 */
  const routeBlock = {
    kind: 'exact',
    path: '/reproxy-lan/block',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: '只支持 POST' })
        return
      }
      let body
      try {
        body = await readBody(req)
      } catch (e) {
        sendJson(res, 400, { ok: false, error: e.message })
        return
      }
      // 别把自己锁在门外：当前请求来自哪个 IP，就不许封哪个
      const selfIp = normalizeIp(req.socket ? req.socket.remoteAddress : '')
      const targetIp = normalizeIp(body.ip)
      if (selfIp !== '' && targetIp === selfIp) {
        sendJson(res, 400, { ok: false, error: '不能封禁当前正在使用的这台设备，换一台设备来操作' })
        return
      }
      try {
        const result = blockIp(body.ip, 'settings')
        if (result.added) log('warn', '设置页拉黑 IP：' + result.ip)
        sendJson(res, 200, withClients({ ...describeLanState(), added: result.added, ip: result.ip }))
      } catch (e) {
        sendJson(res, 400, { ok: false, error: e.message })
      }
    },
  }

  const routeUnblock = {
    kind: 'exact',
    path: '/reproxy-lan/unblock',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: '只支持 POST' })
        return
      }
      let body
      try {
        body = await readBody(req)
      } catch (e) {
        sendJson(res, 400, { ok: false, error: e.message })
        return
      }
      try {
        const result = unblockIp(body.ip, 'settings')
        if (result.removed) log('info', '设置页解除拉黑：' + result.ip)
        sendJson(res, 200, withClients({ ...describeLanState(), removed: result.removed, ip: result.ip }))
      } catch (e) {
        sendJson(res, 400, { ok: false, error: e.message })
      }
    },
  }


  /** 防扫描攻击开关（开启时顺带打开黑名单总开关）。 */
  const routeScan = {
    kind: 'exact',
    path: '/reproxy-lan/scan',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: '只支持 POST' })
        return
      }
      let body
      try {
        body = await readBody(req)
      } catch (e) {
        sendJson(res, 400, { ok: false, error: e.message })
        return
      }
      if (typeof body.enabled !== 'boolean') {
        sendJson(res, 400, { ok: false, error: '需要 enabled: true/false' })
        return
      }
      try {
        const result = setScanGuard(body.enabled, 'settings')
        log(result.scanGuard ? 'warn' : 'info', '防扫描攻击：' + (result.scanGuard ? '已开启（黑名单总开关一并打开）' : '已关闭'))
        sendJson(res, 200, withClients(describeLanState()))
      } catch (e) {
        sendJson(res, 400, { ok: false, error: e.message })
      }
    },
  }

  /** 一键清除：清空「最近访问」列表，已加入黑名单的 IP 保留（它们存在状态文件里）。 */
  const routeClear = {
    kind: 'exact',
    path: '/reproxy-lan/clear',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: '只支持 POST' })
        return
      }
      const before = seenClients.size
      seenClients.clear()
      scanStats.clear()
      log('info', '设置页一键清除访问记录：' + before + ' 条')
      sendJson(res, 200, withClients({ ...describeLanState(), cleared: before }))
    },
  }

  /** IPv6 监听开关：同样要带 confirm，且总开关必须先开。 */
  const routeIpv6 = {
    kind: 'exact',
    path: '/reproxy-lan/ipv6',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: '只支持 POST' })
        return
      }
      let body
      try {
        body = await readBody(req)
      } catch (e) {
        sendJson(res, 400, { ok: false, error: e.message })
        return
      }
      if (body.confirm !== true) {
        sendJson(res, 400, { ok: false, error: '缺少用户确认（confirm:true）', warning: IPV6_WARNING_TEXT })
        return
      }
      if (typeof body.enabled !== 'boolean') {
        sendJson(res, 400, { ok: false, error: 'enabled 必须是布尔值' })
        return
      }
      try {
        const next = setIpv6(body.enabled, 'settings')
        log(body.enabled ? 'warn' : 'info', '设置页把 IPv6 监听' + (body.enabled ? '打开' : '关掉'))
        sendJson(res, 200, { ...describeLanState(), warning: IPV6_WARNING_TEXT })
      } catch (e) {
        sendJson(res, 400, { ok: false, error: e.message })
      }
    },
  }

/** 列出这台机器对外的可访问地址（内网/公网、IPv4/IPv6），端口用实时值。 */
  const routeAddresses = {
    kind: 'exact',
    path: '/reproxy-lan/addresses',
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: '只支持 GET' })
        return
      }
      const st = getLanState()
      const port = effectivePort()
      const key = st.publicAccess === true && typeof st.accessKey === 'string' ? st.accessKey : ''
      const base = (host, isV6) => 'http://' + (isV6 ? '[' + host + ']' : host) + ':' + port
      const picked = collectAddresses()
      const lan4 = picked.lan4[0]
      const lan6 = picked.lan6[0]
      const wan6 = picked.wan6[0]
      const rows = []

      rows.push(lan4
        ? { id: 'lan4', label: '内网 IPv4', url: base(lan4.address, false) + '/' }
        : { id: 'lan4', label: '内网 IPv4', url: '', hint: '没检测到内网 IPv4（网线/Wi-Fi 断了吗？）' })

      if (st.ipv6 === true) {
        rows.push(lan6
          ? { id: 'lan6', label: '内网 IPv6', url: base(lan6.address, true) + '/', lifetime: lan6.lifetime }
          : { id: 'lan6', label: '内网 IPv6', url: '', hint: '没检测到内网 IPv6 地址' })
      } else {
        rows.push({ id: 'lan6', label: '内网 IPv6', url: '', hint: 'IPv6 监听没开——打开上面的「IPv6 监听」后这里才会列出来。' })
      }

      if (st.publicAccess === true) {
        const wan4 = await probeWan4()
        rows.push(wan4
          ? { id: 'wan4', label: '公网 IPv4', url: base(wan4, false) + '/' + encodeURIComponent(key) }
          : { id: 'wan4', label: '公网 IPv4', url: '', hint: '没取到公网 IPv4（多半在运营商 NAT / CGNAT 后面）。先在路由器做端口映射，或者改用 IPv6。' })
        rows.push(wan6
          ? { id: 'wan6', label: '公网 IPv6', url: base(wan6.address, true) + '/' + encodeURIComponent(key), lifetime: wan6.lifetime }
          : { id: 'wan6', label: '公网 IPv6', url: '', hint: '这台机器没有公网 IPv6（只有内网 IPv6）。' })
      } else {
        rows.push({ id: 'wan4', label: '公网 IPv4', url: '', hint: '公网访问没开。打开「公网访问」并设好密钥后，这里会出现带密钥的完整地址。' })
        rows.push({ id: 'wan6', label: '公网 IPv6', url: '', hint: '公网访问没开。' })
      }

      const fwdList = Array.isArray(st.forwards) ? st.forwards : []
      const fwdOn = st.forwardsEnabled === true && st.lanAccess === true
      for (const fwdPort of fwdList) {
        const alive = await probePortAlive(fwdPort)
        let hint = ''
        if (!fwdOn) hint = '额外端口转发的开关没开（或「局域网访问」关着）——打开后这一行才会真正放出去。'
        else if (!lan4) hint = '没检测到内网 IPv4，转发没有可以绑的地址。'
        else if (!alive) hint = '这个端口现在没有服务在听——把对应的插件/服务起来就有了。'
        rows.push({
          id: 'fwd-' + fwdPort,
          label: '插件端口 ' + fwdPort,
          url: fwdOn && lan4 ? 'http://' + lan4.address + ':' + fwdPort + '/' : '',
          hint,
          forward: true,
          port: fwdPort,
        })
      }
      if (fwdList.length === 0) {
        rows.push({ id: 'fwd-none', label: '插件端口', url: '', hint: '还没添加额外端口。在上面的「额外端口转发」里填端口并「添加」，这里就会跟着多出一行（最多 12 行）。' })
      }

      sendJson(res, 200, { ok: true, port, ipv6: st.ipv6 === true, publicAccess: st.publicAccess === true, forwards: fwdList, forwardsEnabled: st.forwardsEnabled === true, rows })
    },
  }

  /** 公网开关：必须同时给合法密钥；缺密钥直接 400。 */
  const routePublic = {
    kind: 'exact',
    path: '/reproxy-lan/public',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: '只支持 POST' })
        return
      }
      let body
      try {
        body = await readBody(req)
      } catch (e) {
        sendJson(res, 400, { ok: false, error: e.message })
        return
      }
      if (body.confirm !== true) {
        sendJson(res, 400, { ok: false, error: '缺少用户确认（confirm:true）', warning: PUBLIC_WARNING_TEXT })
        return
      }
      if (typeof body.enabled !== 'boolean') {
        sendJson(res, 400, { ok: false, error: 'enabled 必须是布尔值' })
        return
      }
      try {
        const next = setPublicAccess(body.enabled, body.key, 'settings')
        log(body.enabled ? 'warn' : 'info', '设置页把公网访问' + (body.enabled ? '打开' : '关掉'))
        sendJson(res, 200, { ...describeLanState(), warning: PUBLIC_WARNING_TEXT })
      } catch (e) {
        sendJson(res, 400, { ok: false, error: e.message })
      }
    },
  }

  /** 只改密钥：不允许在公网已开时改成空。 */
  const routeForwards = {
    kind: 'exact',
    path: '/reproxy-lan/forwards',
    handler: async (req, res) => {
      if (req.method === 'GET') {
        sendJson(res, 200, describeLanState())
        return
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: '只支持 GET / POST' })
        return
      }
      let body
      try {
        body = await readBody(req)
      } catch (e) {
        sendJson(res, 400, { ok: false, error: e.message })
        return
      }
      try {
        if (body.remove === true) {
          const removed = removeForward(body.port, 'settings')
          log('info', '设置页移除了额外端口 ' + removed)
          sendJson(res, 200, describeLanState())
          return
        }
        const result = addForward(body.port, 'settings')
        log('warn', '设置页把端口 ' + body.port + ' 放出去了' + (result.added ? '' : '（本来就在列表里）'))
        sendJson(res, 200, describeLanState())
      } catch (e) {
        sendJson(res, 400, { ok: false, error: e.message })
      }
    },
  }

  const routeForwardsEnabled = {
    kind: 'exact',
    path: '/reproxy-lan/forwards/enabled',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: '只支持 POST' })
        return
      }
      let body
      try {
        body = await readBody(req)
      } catch (e) {
        sendJson(res, 400, { ok: false, error: e.message })
        return
      }
      if (body.confirm !== true) {
        sendJson(res, 400, { ok: false, error: '缺少用户确认（confirm:true）' })
        return
      }
      if (typeof body.enabled !== 'boolean') {
        sendJson(res, 400, { ok: false, error: 'enabled 必须是布尔值' })
        return
      }
      try {
        setForwardsEnabled(body.enabled, 'settings')
        log(body.enabled ? 'warn' : 'info', '设置页把额外端口转发' + (body.enabled ? '打开' : '关掉'))
        sendJson(res, 200, describeLanState())
      } catch (e) {
        sendJson(res, 400, { ok: false, error: e.message })
      }
    },
  }

  const routeKey = {
    kind: 'exact',
    path: '/reproxy-lan/key',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: '只支持 POST' })
        return
      }
      let body
      try {
        body = await readBody(req)
      } catch (e) {
        sendJson(res, 400, { ok: false, error: e.message })
        return
      }
      try {
        setAccessKey(body.key, 'settings')
        log('warn', '设置页更新了公网访问密钥')
        sendJson(res, 200, describeLanState())
      } catch (e) {
        sendJson(res, 400, { ok: false, error: e.message })
      }
    },
  }

  const webServer = ctx && typeof ctx.get === 'function' ? ctx.get('webServer') : null
  if (webServer && typeof webServer.register === 'function' && typeof ctx.effect === 'function') {
    ctx.effect(() => webServer.register(routeStatus))
    ctx.effect(() => webServer.register(routeSet))
    ctx.effect(() => webServer.register(routePort))
    ctx.effect(() => webServer.register(routeClients))
    ctx.effect(() => webServer.register(routeBlacklist))
    ctx.effect(() => webServer.register(routeBlock))
    ctx.effect(() => webServer.register(routeUnblock))
    ctx.effect(() => webServer.register(routePublic))
    ctx.effect(() => webServer.register(routeIpv6))
    ctx.effect(() => webServer.register(routeScan))
    ctx.effect(() => webServer.register(routeClear))
    ctx.effect(() => webServer.register(routeKey))
    ctx.effect(() => webServer.register(routeForwards))
    ctx.effect(() => webServer.register(routeForwardsEnabled))
    ctx.effect(() => webServer.register(routeAddresses))
  } else {
    log('warn', 'webServer 不可用，设置页开关接口未注册')
  }

  // 命令行开关：/lan 查看，/lan yes 开启，/lan no 关闭
  const commands = ctx && typeof ctx.get === 'function' ? ctx.get('commands') : null
  if (!commands || typeof commands.register !== 'function') {
    // 用 console 打：这个结论必须能在 journalctl 里看到
    console.log('[reproxy-lan] commands 服务不可用，/lan 命令未注册')
    return
  }

  const v6LineOf = (s) => (s.ipv6 === true
    ? 'IPv6 监听：已开启（[::]:' + effectivePort() + '，走 IPv6 的设备也能进）'
    : 'IPv6 监听：已关闭（只绑 IPv4）')

  const statusText = () => {
    const s = getLanState()
    const port = effectivePort()
    const head = s.lanAccess
      ? '局域网访问：已开启（监听 0.0.0.0:' + port + '，同网段设备可直接进入后台）'
      : '局域网访问：已关闭（只监听 127.0.0.1:' + port + '，只有本机能访问）'
  const v6Line = s.ipv6
      ? 'IPv6 监听：已开启（[::]:' + port + '，走 IPv6 的设备也能进）'
      : 'IPv6 监听：已关闭（只绑 IPv4）'
    const when = s.updatedAt ? '上次修改：' + s.updatedAt + '（' + (s.updatedBy || 'unknown') + '）' : '还没有改过，当前是默认值'
    const pub = s.publicAccess
      ? '公网访问：已开启（访问地址 http://<公网IP>:' + port + '/' + (s.accessKey || '') + '）'
      : '公网访问：已关闭（只有局域网内设备能访问）'
    return [head, v6Line, pub, when].join('\n')
  }

  ctx.effect(() => commands.register({
    name: 'lan',
    description: '查看或切换局域网/公网访问开关、端口与访问密钥',
    input: { hint: 'yes | no | status | port <n> | ipv6 on|off | public on <key> | public off | key <key> | forward list | forward add <n> | forward del <n> | forward on|off | scan on|off | clear' },
    recordInput: true,
    handler: ({ rawInput }) => {
      const arg = String(rawInput || '').trim().toLowerCase()
      if (arg === '' || arg === 'status') {
        return {
          kind: 'success',
          text: [statusText(), '', '要改变：/lan yes 开启（会先给出安全提示）、/lan no 关闭、/lan port 9000 改端口', '', LAN_WARNING_TEXT].join('\n'),
        }
      }
      if (arg === 'yes' || arg === 'on' || arg === 'true') {
        if (getLanState().lanAccess) return { kind: 'success', text: '已经是开启状态了。\n' + statusText() }
        try {
          setLanAccess(true, 'command')
        } catch (e) {
          return { kind: 'error', text: '保存失败：' + e.message }
        }
        log('warn', '命令行切换局域网访问 → 开启')
        return { kind: 'success', text: LAN_WARNING_TEXT + '\n\n已开启。\n' + statusText() }
      }
      if (arg === 'no' || arg === 'off' || arg === 'false') {
        if (!getLanState().lanAccess) return { kind: 'success', text: '已经是关闭状态了。\n' + statusText() }
        try {
          setLanAccess(false, 'command')
        } catch (e) {
          return { kind: 'error', text: '保存失败：' + e.message }
        }
        log('info', '命令行切换局域网访问 → 关闭')
        return { kind: 'success', text: '已关闭，其他设备会立刻断开。\n' + statusText() }
      }
      if (arg === 'public' || arg === 'public status') {
        const s = getLanState()
        return {
          kind: 'success',
          text: [
            statusText(),
            '',
            '开启公网：/lan public on <访问密钥>（至少 ' + MIN_KEY_LENGTH + ' 位，只能字母数字）',
            '关闭公网：/lan public off',
            '只改密钥：/lan key <访问密钥>',
            '',
            PUBLIC_WARNING_TEXT,
          ].join('\n'),
        }
      }
      if (arg.indexOf('public on') === 0) {
        const key = arg.slice('public on'.length).trim()
        try {
          // 一条命令把两个开关都打开：总开关（端口朝外听）+ 公网开关（校验密钥）
          const wasLan = getLanState().lanAccess
          if (!wasLan) setLanAccess(true, 'command')
          setPublicAccess(true, key, 'command')
          log('warn', '命令行开启公网访问' + (wasLan ? '' : '（同时打开局域网访问）'))
        } catch (e) {
          return { kind: 'error', text: '开启失败：' + e.message }
        }
        return { kind: 'success', text: PUBLIC_WARNING_TEXT + '\n\n已开启：局域网访问 + 公网访问都打开了。\n' + statusText() }
      }
      if (arg === 'public off') {
        try {
          setPublicAccess(false, undefined, 'command')
        } catch (e) {
          return { kind: 'error', text: '关闭失败：' + e.message }
        }
        log('info', '命令行关闭公网访问')
        return { kind: 'success', text: '公网访问已关闭。\n' + statusText() }
      }
      if (arg.indexOf('key') === 0) {
        const key = arg.slice(3).trim()
        if (key === '') return { kind: 'error', text: '用法：/lan key <访问密钥>（至少 ' + MIN_KEY_LENGTH + ' 位）' }
        const parsed = validateKey(key)
        if (!parsed.ok) return { kind: 'error', text: parsed.error }
        try {
          setAccessKey(parsed.key, 'command')
        } catch (e) {
          return { kind: 'error', text: '保存失败：' + e.message }
        }
        log('warn', '命令行更新了公网访问密钥')
        return { kind: 'success', text: '密钥已更新。\n' + statusText() }
      }
      if (arg.indexOf('ipv6') === 0) {
        const value = arg.slice(4).trim().toLowerCase()
        const state = getLanState()
        if (value === '') {
          return { kind: 'success', text: v6LineOf(state) + '\n\n用法：/lan ipv6 on 开启、/lan ipv6 off 关闭' }
        }
        if (value !== 'on' && value !== 'off') {
          return { kind: 'error', text: '用法：/lan ipv6 on | off' }
        }
        const want = value === 'on'
        if (want === (state.ipv6 === true)) {
          return { kind: 'success', text: '已经是' + (want ? '开启' : '关闭') + '状态了。\n' + statusText() }
        }
        try {
          setIpv6(want, 'command')
        } catch (e) {
          return { kind: 'error', text: e.message }
        }
        log(want ? 'warn' : 'info', '命令行把 IPv6 监听' + (want ? '打开' : '关掉'))
        return { kind: 'success', text: (want ? IPV6_WARNING_TEXT + '\n\n已开启 IPv6 监听，正在重建监听。' : 'IPv6 监听已关闭。') + '\n' + statusText() }
      }
      if (arg === 'forward' || arg === 'forward list' || arg === 'fwd') {
        const st = getLanState()
        const lines = [
          '额外端口转发：' + (st.forwardsEnabled ? '已开启' : '已关闭') + '（依赖「局域网访问」总开关）',
          st.forwards.length === 0 ? '· 还没有转发任何端口' : '· 正在放出的端口：' + st.forwards.map((p) => p + ' → 127.0.0.1:' + p).join('、'),
          '',
          '添加：/lan forward add 18787',
          '删除：/lan forward del 18787',
          '开关：/lan forward on | /lan forward off',
        ]
        return { kind: 'success', text: lines.join('\n') }
      }
      if (arg.indexOf('forward add') === 0) {
        const port = arg.slice('forward add'.length).trim()
        try {
          const result = addForward(port, 'command')
          log('warn', '命令行把端口 ' + port + ' 放出去了')
          const st = result.state
          return {
            kind: 'success',
            text: '已加入转发列表：' + port + ' → 127.0.0.1:' + port
              + (st.forwardsEnabled ? '' : '\n（转发总开关还关着，/lan forward on 打开后才会真正监听）')
              + '\n' + statusText(),
          }
        } catch (e) {
          return { kind: 'error', text: e.message }
        }
      }
      if (arg.indexOf('forward del') === 0 || arg.indexOf('forward remove') === 0) {
        const port = arg.replace('forward del', '').replace('forward remove', '').trim()
        try {
          const result = removeForward(port, 'command')
          return { kind: 'success', text: (result.removed ? '已移除转发：' : '列表里本来就没有：') + port + '\n' + statusText() }
        } catch (e) {
          return { kind: 'error', text: e.message }
        }
      }
      if (arg === 'forward on' || arg === 'forward off') {
        const want = arg === 'forward on'
        try {
          setForwardsEnabled(want, 'command')
        } catch (e) {
          return { kind: 'error', text: e.message }
        }
        log(want ? 'warn' : 'info', '命令行把额外端口转发' + (want ? '打开' : '关掉'))
        return { kind: 'success', text: (want ? '额外端口转发已开启，列表里的端口会跟着 8080 一起放出去。' : '额外端口转发已关闭（端口列表保留）。') + '\n' + statusText() }
      }
      if (arg === 'scan on' || arg === 'scan off') {
        const want = arg === 'scan on'
        try {
          const result = setScanGuard(want, 'command')
          return {
            kind: 'success',
            text: (want
              ? '防扫描攻击已开启（黑名单总开关已一并打开）：识别到扫描器指纹、Kali、敏感路径探测或短时间大量路径，会自动把来源 IP 拉黑。'
              : '防扫描攻击已关闭（已经拉黑的 IP 仍留在名单里）。') + '\n' + statusText(),
          }
        } catch (e) {
          return { kind: 'error', text: e.message }
        }
      }
      if (arg === 'clear' || arg === 'clear seen') {
        const before = typeof extra.clearSeen === 'function' ? extra.clearSeen() : 0
        return { kind: 'success', text: '已清除 ' + before + ' 条访问记录（黑名单里的 IP 保持不变）。' }
      }
      if (arg === 'reset') {
        return {
          kind: 'success',
          text: [
            '重置会把配置恢复到默认值：局域网访问关闭、端口 8080、黑名单关闭并清空名单。',
            '注意：关掉局域网访问后，正从 8080 访问的设备会立刻断开，只有本机能打开后台。',
            '确认要重置，请输入：/lan reset yes',
          ].join('\n'),
        }
      }
      if (arg === 'reset yes' || arg === 'reset y') {
        const before = statusText()
        try {
          resetConfig('command')
        } catch (e) {
          return { kind: 'error', text: '重置失败：' + e.message }
        }
        log('warn', '命令行重置配置 → 默认值')
        return {
          kind: 'success',
          text: '已重置为默认配置。\n重置前：\n' + before + '\n重置后：\n' + statusText(),
        }
      }
      if (arg.indexOf('port') === 0) {
        const rest = arg.slice(4).trim()
        if (rest === '') {
          return {
            kind: 'success',
            text: '当前端口：' + effectivePort() + '（默认 ' + DEFAULT_PORT + '）\n改端口：/lan port 9000',
          }
        }
        const parsed = validatePort(rest)
        if (!parsed.ok) return { kind: 'error', text: parsed.error }
        if (parsed.port === effectivePort()) return { kind: 'success', text: '端口本来就是 ' + parsed.port + '。' }
        try {
          setPort(parsed.port, 'command')
        } catch (e) {
          return { kind: 'error', text: '保存失败：' + e.message }
        }
        log('info', '命令行把监听端口改为 ' + parsed.port)
        return { kind: 'success', text: '端口已改为 ' + parsed.port + '，正在重建监听（端口被占用的话会每 5 秒重试）。\n' + statusText() }
      }
      return { kind: 'error', text: '看不懂「' + arg + '」。用法：/lan（看状态）、/lan yes（开局域网）、/lan no（关局域网）、/lan port 9000（改端口）、/lan public on <密钥>（开公网）、/lan public off、/lan key <密钥>' }
    },
  }))
  console.log('[reproxy-lan] /lan 命令已注册')
}

function applyProxy(ctx, config) {
  const cfg = normalize(config)
  const log = (level, msg) => {
    try {
      if (ctx && typeof ctx.logger === 'function') ctx.logger('dsh-proxy')[level](msg)
      else if (ctx && ctx.logger && typeof ctx.logger[level] === 'function') ctx.logger[level](msg)
      else console[level === 'error' ? 'error' : 'log']('[dsh-proxy] ' + msg)
    } catch { /* 日志失败不连坐 */ }
  }

  const servers = []
  let retryTimer = null
  let disposed = false

  /**
   * 访问过本反代的设备（只留内存，重启清空）：ip → { ip, firstSeen, lastSeen, hits }。
   * 设置页把这份列表显示出来，点「添加」就把那条 IP 丢进黑名单。
   */
  // 局域网内能用邻居表（ARP）看到 MAC；跨路由/公网看不到，IPv6 也多半没有。
  const macCache = new Map()
  const MAC_TTL = 60 * 1000
  const lookupMac = (ip) => {
    if (typeof ip !== 'string' || ip === '' || /:/.test(ip) || !isPrivateIp(ip)) return ''
    const hit = macCache.get(ip)
    const now = Date.now()
    if (hit && now - hit.at < MAC_TTL) return hit.mac
    let mac = ''
    try {
      const out = execFileSync('ip', ['neigh', 'show', ip], { encoding: 'utf8', timeout: 800, stdio: ['ignore', 'pipe', 'ignore'] })
      const m = out.match(/lladdr\s+([0-9a-f:]{17})/i)
      if (m) mac = m[1].toLowerCase()
    } catch (e) { mac = '' }
    macCache.set(ip, { at: now, mac })
    return mac
  }

  const seenClients = new Map()
  const MAX_SEEN = 50
  let nextClientId = 1

  /**
   * 同一台设备的判定顺序：MAC > IP > 系统+型号 > 型号（浏览器不参与判定）。
   * 换了网络/换了浏览器都只更新原来那条，不再另起一行。
   */
  const findClient = (cand) => {
    if (cand.mac) {
      for (const e of seenClients.values()) if (e.mac && e.mac === cand.mac) return e
    }
    for (const e of seenClients.values()) if (e.ip === cand.ip) return e
    if (cand.system !== '未知' && cand.device !== '未知') {
      for (const e of seenClients.values()) if (e.system === cand.system && e.model === cand.device) return e
    }
    if (cand.device !== '未知') {
      for (const e of seenClients.values()) if (e.model === cand.device) return e
    }
    return null
  }

  const noteClient = (req) => {
    const ip = normalizeIp(req && req.socket ? req.socket.remoteAddress : '')
    if (ip === '') return ''
    const now = Date.now()
    const ua = String((req.headers && (req.headers['user-agent'] || req.headers['User-Agent'])) || '').slice(0, 300)
    const parts = describeParts(ua)
    const mac = lookupMac(ip)
    const hit = findClient({ ip, mac, device: parts.device, system: parts.system })
    if (hit) {
      hit.ip = ip
      hit.lastSeen = now
      hit.hits += 1
      if (!(hit.ips instanceof Map)) hit.ips = new Map()
      hit.ips.set(ip, now)
      for (const [key, at] of hit.ips) if (now - at > 10 * 60 * 1000) hit.ips.delete(key)
      if (hit.ips.size > 6) hit.ips.delete([...hit.ips.keys()][0])
      if (mac !== '') hit.mac = mac
      if (ua !== '') {
        hit.ua = ua
        hit.device = parts.line
        hit.model = parts.device
        hit.system = parts.system
      }
      return ip
    }
    const entry = {
      id: 'd' + (nextClientId++),
      ip,
      mac,
      firstSeen: now,
      lastSeen: now,
      hits: 1,
      ua,
      device: parts.line,
      model: parts.device,
      system: parts.system,
      ips: new Map([[ip, now]]),
    }
    seenClients.set(entry.id, entry)
    if (seenClients.size > MAX_SEEN) {
      let oldestKey = ''
      let oldest = Infinity
      for (const [key, value] of seenClients) {
        if (value.lastSeen < oldest) { oldest = value.lastSeen; oldestKey = key }
      }
      if (oldestKey !== '') seenClients.delete(oldestKey)
    }
    return ip
  }

  /** 给设置页看的快照（带 blocked 标记，前端据此决定按钮是「添加」还是「已在黑名单」）。 */
  const MULTI_WINDOW = 5 * 60 * 1000
  const listClients = () => {
    const st = getLanState()
    const seen = new Set()
    const rows = [...seenClients.values()]
      .sort((a, b) => b.lastSeen - a.lastSeen)
      .map((entry) => {
        seen.add(entry.ip)
        const now = Date.now()
        const multiIps = entry.ips instanceof Map
          ? [...entry.ips.entries()].filter(([, at]) => now - at <= MULTI_WINDOW).map(([key]) => key)
          : []
        return {
          ...entry,
          ips: undefined,
          multiIps: multiIps.length > 1 ? multiIps : [],
          blocked: isBlocked(entry.ip),
          scan: isScanBlocked(entry.ip),
          private: isPrivateIp(entry.ip),
          device: entry.device || describeUa(entry.ua || ''),
          mac: entry.mac || lookupMac(entry.ip),
        }
      })
    // 黑名单里但这次还没访问过的 IP 也列出来，否则「一键清除」后它们会从界面上消失
    for (const ip of st.blockedIps) {
      if (seen.has(ip)) continue
      rows.push({
        id: 'blocked-' + ip,
        ip,
        mac: lookupMac(ip),
        firstSeen: 0,
        lastSeen: 0,
        hits: 0,
        ua: '',
        device: '（已加入黑名单，本次还没访问）',
        model: '未知',
        system: '未知',
        multiIps: [],
        blocked: true,
        scan: isScanBlocked(ip),
        private: isPrivateIp(ip),
      })
    }
    return rows
  }

  /**
   * 防扫描攻击：靠 UA 指纹 + 敏感路径探测 + 短时间内的路径/请求量判断。
   * 只在「防扫描攻击」开关打开时生效；命中就直接写进黑名单（带「攻击行为」标记）。
   */
  const SCAN_UA = /(nmap|nikto|sqlmap|masscan|zgrab|nuclei|dirbuster|gobuster|wpscan|acunetix|nessus|openvas|netsparker|burpsuite|hydra|w3af|whatweb|curl\/7\.(?:[0-8]))/i
  const KALI_UA = /kali/i
  const SENSITIVE_PATH = /^\/(?:\.env|\.git|\.svn|\.aws|\.ssh|\.ds_store|wp-login\.php|wp-admin|wp-content|phpmyadmin|pma|xmlrpc\.php|actuator|server-status|cgi-bin|manager\/html|solr|admin\.php|setup\.php|config\.json|backup|db\.sql|shell\.php)/i
  const scanStats = new Map()
  const SCAN_WINDOW = 30 * 1000
  const SCAN_MAX_UNIQUE = 25
  const SCAN_MAX_REQ = 150

  const scanTrip = (ip, why) => {
    try {
      const result = blockIp(ip, 'scan-guard', 'scan')
      if (result.added) log('warn', '防扫描命中（' + why + '），已自动拉黑：' + ip)
      scanStats.delete(ip)
    } catch (e) { log('warn', '自动拉黑失败：' + e.message) }
  }

  const scanCheck = (req, ip) => {
    if (ip === '' || ip === '::1' || /^127\./.test(ip)) return
    const st = getLanState()
    if (st.scanGuard !== true) return
    const ua = String((req.headers && req.headers['user-agent']) || '')
    if (KALI_UA.test(ua)) {
      if (!isBlocked(ip)) scanTrip(ip, 'Kali 系统指纹')
      return
    }
    if (SCAN_UA.test(ua)) {
      if (!isBlocked(ip)) scanTrip(ip, '扫描器指纹')
      return
    }
    let path = '/'
    try {
      const u = new URL(req.url || '/', 'http://localhost')
      path = u.pathname || '/'
    } catch { path = '/' }
    const now = Date.now()
    let rec = scanStats.get(ip)
    if (!rec || now - rec.first > SCAN_WINDOW) {
      rec = { first: now, total: 0, uniq: new Set(), sens: 0 }
      scanStats.set(ip, rec)
    }
    rec.total += 1
    rec.uniq.add(path)
    if (SENSITIVE_PATH.test(path)) rec.sens += 1
    let why = ''
    if (rec.sens >= 2) why = '探测敏感路径'
    else if (rec.uniq.size >= SCAN_MAX_UNIQUE) why = '短时间内遍历大量路径'
    else if (rec.total >= SCAN_MAX_REQ) why = '短时间请求量异常'
    if (why !== '' && !isBlocked(ip)) scanTrip(ip, why)
  }

  const BLOCKED_HTML = '<!doctype html><html lang="zh-CN"><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>403 · 已被拉黑</title>'
    + '<body style="margin:0;font:15px/1.8 -apple-system,system-ui,sans-serif;background:#12141a;color:#e6e8ee;padding:56px 24px">'
    + '<h2 style="margin:0 0 12px;font-size:20px">403 · 这台设备已被拉黑</h2>'
    + '<p style="margin:0;color:#9aa0ad;max-width:560px">'
    + '管理员在 DSH 设置里把当前 IP 加进了黑名单，所以这台设备无法访问后台。'
    + '如果认为这是误会，请联系管理员在「设置 → 局域网访问 → 访问 IP」里移除。'
    + '</p></body></html>'

  const LAN_ONLY_HTML = '<!doctype html><html lang="zh-CN"><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>403 · 只允许局域网访问</title>'
    + '<body style="margin:0;font:15px/1.8 -apple-system,system-ui,sans-serif;background:#12141a;color:#e6e8ee;padding:56px 24px">'
    + '<h2 style="margin:0 0 12px;font-size:20px">403 · 只允许局域网访问</h2>'
    + '<p style="margin:0;color:#9aa0ad;max-width:560px">'
    + '这台设备不在同一个局域网里。管理员如果想允许公网访问，需要在「设置 → 局域网访问 → 公网访问」里打开开关并设置访问密钥。'
    + '</p></body></html>'

  const NOT_FOUND_HTML = '<!doctype html><html lang="zh-CN"><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>404</title>'
    + '<body style="margin:0;font:15px/1.8 -apple-system,system-ui,sans-serif;background:#12141a;color:#e6e8ee;padding:56px 24px">'
    + '<h2 style="margin:0 0 12px;font-size:20px">404</h2>'
    + '<p style="margin:0;color:#9aa0ad;max-width:560px">页面不存在。</p></body></html>'

  const sendHtml = (res, status, html, extraHeaders = {}) => {
    try {
      const body = Buffer.from(html, 'utf8')
      res.writeHead(status, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': body.length,
        'cache-control': 'no-store',
        ...extraHeaders,
      })
      res.end(body)
    } catch { /* 连接已断 */ }
  }

  const COOKIE_NAME = 'reproxy_access'
  const tokenOf = (key) => crypto.createHash('sha256').update('reproxy:' + key).digest('hex')

  const readCookie = (req, name) => {
    const raw = req && req.headers ? req.headers.cookie : ''
    if (typeof raw !== 'string' || raw === '') return ''
    for (const part of raw.split(';')) {
      const index = part.indexOf('=')
      if (index === -1) continue
      if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim()
    }
    return ''
  }

  /**
   * 访问闸门：
   * - 总开关关着 → 只听回环，非回环一律当「不在局域网」（理论上不该出现）
   * - 总开关开、公网关 → 只放行内网地址，公网 IP 返回 403「只允许局域网访问」
   * - 公网开 → 必须带密钥：地址里带 `/<密钥>`（访问一次换 cookie）或已持有有效 cookie，否则 404
   * 返回 'ok' | 'grant-key' | 'lan-only' | 'need-key' | 'key-broken'
   */
  const accessGate = (req) => {
    const state = getLanState()
    const ip = normalizeIp(req && req.socket ? req.socket.remoteAddress : '')
    const local = ip === '' || ip === '::1' || /^127\./.test(ip)
    // 本机永远放行：要不就没有「安全阀」了——公网模式开着、密钥忘了，本机也进不来
    if (local) return 'ok'
    if (state.lanAccess !== true) return 'lan-only'
    // 内网地址永远直连（是否允许内网由总开关管），公网模式只约束公网来源
    if (isPrivateIp(ip)) return 'ok'
    if (state.publicAccess !== true) return 'lan-only'
    const key = typeof state.accessKey === 'string' ? state.accessKey : ''
    if (key === '') return 'key-broken'
    const pathOnly = String(req.url || '/').split('?')[0]
    if (pathOnly === '/' + key || pathOnly === '/' + key + '/') return 'grant-key'
    const token = readCookie(req, COOKIE_NAME)
    if (token !== '' && token === tokenOf(key)) return 'ok'
    return 'need-key'
  }

  const grantKeyCookie = (res) => {
    const key = (getLanState().accessKey || '')
    const maxAge = 30 * 24 * 3600
    return {
      'set-cookie': COOKIE_NAME + '=' + tokenOf(key) + '; Max-Age=' + maxAge + '; Path=/; HttpOnly; SameSite=Lax',
      location: '/',
    }
  }

  const sendBlocked = (res) => {
    try {
      const body = Buffer.from(BLOCKED_HTML, 'utf8')
      res.writeHead(403, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': body.length,
        'cache-control': 'no-store',
      })
      res.end(body)
    } catch { /* 连接已断 */ }
  }

  /** 关掉现有监听（换地址前必须先让出端口）。 */
  const stopListening = () => {
    clearTimeout(retryTimer)
    for (const s of servers) {
      try { s.close() } catch { /* 已关 */ }
    }
    servers.length = 0
  }

  /**
   * 开关变化后重建监听：先关、稍等端口释放、再按新地址监听。
   * 不同步 close 再 listen 的话，Linux 上会拿到 EADDRINUSE 然后进重试循环。
   */
  let rebindTimer = null
  const rebind = () => {
    stopListening()
    clearTimeout(rebindTimer)
    rebindTimer = setTimeout(() => {
      if (disposed) return
      log('info', '开关/端口变化 → 重新监听 ' + effectiveListenHost() + ':' + effectivePort())
      startHosts()
    }, 400)
  }

  // 额外端口转发走「同端口路径」：/@18787/xxx → 127.0.0.1:18787/xxx
  // 为什么不另开一个监听：上游已经占着 127.0.0.1:18787，再 bind 0.0.0.0:18787 必然 EADDRINUSE。
  const forwardTarget = (req) => {
    const url = req.url || '/'
    const m = /^\/@(\d{2,5})(.*)$/.exec(url)
    if (!m) return null
    const port = Number(m[1])
    if (!Number.isInteger(port) || port < 1024 || port > 65535) return null
    if (port === cfg.listenPort || port === cfg.upstreamPort) return null
    let st
    try { st = getLanState() } catch { return null }
    if (st.lanAccess !== true || st.forwardsEnabled !== true) return null
    if (!Array.isArray(st.forwards) || !st.forwards.includes(port)) return null
    let rest = m[2] || ''
    if (rest === '') rest = '/'
    else if (rest[0] !== '/' && rest[0] !== '?') rest = '/' + rest
    return { port, path: rest }
  }

  const onRequest = (req, res) => {
    const clientIp = noteClient(req)
    if (clientIp !== '') scanCheck(req, clientIp)
    if (clientIp !== '' && isBlocked(clientIp)) {
      sendBlocked(res)
      return
    }
    const verdict = accessGate(req)
    if (verdict === 'lan-only') { sendHtml(res, 403, LAN_ONLY_HTML); return }
    if (verdict === 'need-key' || verdict === 'key-broken') { sendHtml(res, 404, NOT_FOUND_HTML); return }
    if (verdict === 'grant-key') {
      const headers = grantKeyCookie(res)
      sendHtml(res, 302, '<!doctype html><meta charset="utf-8"><title>ok</title>', headers)
      return
    }
    let received = 0
    let aborted = false
    const tgt = forwardTarget(req)
    const upstream = http.request({
      host: tgt ? '127.0.0.1' : cfg.upstreamHost,
      port: tgt ? tgt.port : cfg.upstreamPort,
      method: req.method,
      path: tgt ? tgt.path : req.url,
      headers: upstreamHeaders(req, cfg),
    }, (up) => {
      if (res.headersSent) return
      const headers = downHeaders(up.headers)
      if (isImmutableAsset(req.url)) {
        // 内容指纹已变则 URL 变，旧缓存不会命中错误版本
        headers['cache-control'] = 'public, max-age=31536000, immutable'
      }
      const gzip = wantsGzip(req, up)
      if (gzip) {
        delete headers['content-length']
        headers['content-encoding'] = 'gzip'
        if (!headers.vary) headers.vary = 'Accept-Encoding'
      }
      res.writeHead(up.statusCode || 502, up.statusMessage, headers)
      if (gzip) {
        const gz = zlib.createGzip({ level: 6 })
        gz.on('error', () => {
          try { up.destroy() } catch { /* 已关 */ }
          try { res.destroy() } catch { /* 已关 */ }
        })
        res.on('close', () => { try { gz.destroy() } catch { /* 已关 */ } })
        up.pipe(gz).pipe(res)
      } else {
        up.pipe(res)
      }
    })
    upstream.on('error', (err) => {
      if (aborted || res.writableEnded) return
      aborted = true
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      }
      res.end('反代上游不可用: ' + err.message)
    })
    req.on('data', (chunk) => {
      received += chunk.length
      if (received > cfg.maxBodyBytes) {
        aborted = true
        upstream.destroy()
        try { res.writeHead(413, { 'content-type': 'text/plain; charset=utf-8' }) } catch { /* 已发头 */ }
        res.end('请求体超过上限 ' + cfg.maxBodyBytes + ' 字节')
        req.destroy()
      }
    })
    req.on('aborted', () => { if (!aborted) { aborted = true; upstream.destroy() } })
    res.on('close', () => { if (!res.writableFinished) upstream.destroy() })
    // 不缓冲，边收边转
    req.pipe(upstream, { end: true })
    upstream.setTimeout(0)
  }

  const onUpgrade = (req, clientSocket, head) => {
    const upgradeIp = noteClient(req)
    if (upgradeIp !== '') scanCheck(req, upgradeIp)
    if (upgradeIp !== '' && isBlocked(upgradeIp)) {
      try { clientSocket.end('HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\nconnection: close\r\n\r\n') } catch { /* 已关 */ }
      return
    }
    const upgradeVerdict = accessGate(req)
    if (upgradeVerdict !== 'ok' && upgradeVerdict !== 'grant-key') {
      const status = upgradeVerdict === 'lan-only' ? '403 Forbidden' : '404 Not Found'
      try { clientSocket.end('HTTP/1.1 ' + status + '\r\ncontent-length: 0\r\nconnection: close\r\n\r\n') } catch { /* 已关 */ }
      return
    }
    const upTgt = forwardTarget(req)
    const upstream = net.connect(upTgt ? upTgt.port : cfg.upstreamPort, upTgt ? '127.0.0.1' : cfg.upstreamHost, () => {
      const headers = upstreamHeaders(req, cfg, {
        connection: 'Upgrade',
        upgrade: req.headers.upgrade || 'websocket',
      })
      let raw = req.method + ' ' + (upTgt ? upTgt.path : (req.url || '/')) + ' HTTP/1.1\r\n'
      for (const [k, v] of Object.entries(headers)) {
        if (Array.isArray(v)) for (const item of v) raw += k + ': ' + item + '\r\n'
        else if (v !== undefined) raw += k + ': ' + v + '\r\n'
      }
      raw += '\r\n'
      upstream.write(raw)
      if (head && head.length) upstream.write(head)
      upstream.pipe(clientSocket)
      clientSocket.pipe(upstream)
    })
    upstream.on('error', () => {
      try { clientSocket.destroy() } catch { /* 已关 */ }
    })
    clientSocket.on('error', () => {
      try { upstream.destroy() } catch { /* 已关 */ }
    })
    upstream.setTimeout(0)
    upstream.setNoDelay(true)
  }

  // ---- 额外端口转发：把只监听 127.0.0.1 的插件端口顺着同一套开关放出去 ----
  const forwardServers = new Map()

  const closeForward = (port) => {
    const entry = forwardServers.get(port)
    if (!entry) return
    forwardServers.delete(port)
    clearTimeout(entry.retryTimer)
    for (const server of entry.list) {
      try { server.close() } catch { /* 已关 */ }
    }
  }

  const forwardGate = (req) => {
    const ip = noteClient(req)
    if (ip !== '' && isBlocked(ip)) return 'blocked'
    // 额外端口不认 /<key> 路径（那会跟插件自己的路由打架）：
    // 先在 8080 用密钥进一次，cookie 是按主机共享的，这里就认了
    return accessGate(req) === 'ok' ? 'ok' : 'need-cookie'
  }

  const startForward = (host, port) => {
    if (forwardServers.has(port)) return
    const entry = { list: [], retryTimer: null }
    forwardServers.set(port, entry)
    const target = { upstreamHost: '127.0.0.1', upstreamPort: port, maxBodyBytes: cfg.maxBodyBytes, upstreamHostHeader: '127.0.0.1:' + port, upstreamOrigin: 'http://127.0.0.1:' + port }

    const handleRequest = (req, res) => {
      const verdict = forwardGate(req)
      if (verdict === 'blocked') { sendBlocked(res); return }
      if (verdict !== 'ok') {
        sendHtml(res, 403, '<!doctype html><meta charset="utf-8"><title>需要先登录</title><body style="font-family:system-ui;background:#14161c;color:#dfe3ea;padding:48px"><h1 style="font-size:20px">403 · 需要先通过密钥验证</h1><p style="color:#9aa0ad">这个端口是用访问密钥放出来的：先在 <code>:' + cfg.listenPort + '</code> 打开一次并输入密钥，再回到这个地址即可。</p>')
        return
      }
      const headers = upstreamHeaders(req, target, {})
      const up = http.request({ host: target.upstreamHost, port: target.upstreamPort, method: req.method, path: req.url || '/', headers }, (upRes) => {
        if (res.writableEnded) { upRes.destroy(); return }
        res.writeHead(upRes.statusCode || 502, upRes.statusMessage, downHeaders(upRes.headers))
        upRes.pipe(res)
      })
      up.on('error', (err) => {
        if (res.writableEnded) return
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('这个端口没有服务在听：' + err.message)
      })
      req.on('aborted', () => { try { up.destroy() } catch { /* 已关 */ } })
      res.on('close', () => { if (!res.writableFinished) { try { up.destroy() } catch { /* 已关 */ } } })
      req.pipe(up, { end: true })
      up.setTimeout(0)
    }

    const handleUpgrade = (req, clientSocket, head) => {
      const verdict = forwardGate(req)
      if (verdict !== 'ok') {
        try { clientSocket.end('HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\nconnection: close\r\n\r\n') } catch { /* 已关 */ }
        return
      }
      const upstream = net.connect(target.upstreamPort, target.upstreamHost, () => {
        const headers = upstreamHeaders(req, target, { connection: 'Upgrade', upgrade: req.headers.upgrade || 'websocket' })
        let raw = req.method + ' ' + (req.url || '/') + ' HTTP/1.1\r\n'
        for (const [k, v] of Object.entries(headers)) {
          if (Array.isArray(v)) for (const item of v) raw += k + ': ' + item + '\r\n'
          else if (v !== undefined) raw += k + ': ' + v + '\r\n'
        }
        raw += '\r\n'
        upstream.write(raw)
        if (head && head.length) upstream.write(head)
        upstream.pipe(clientSocket)
        clientSocket.pipe(upstream)
      })
      upstream.on('error', () => { try { clientSocket.destroy() } catch { /* 已关 */ } })
      clientSocket.on('error', () => { try { upstream.destroy() } catch { /* 已关 */ } })
      upstream.setTimeout(0)
      upstream.setNoDelay(true)
    }

    // 上游占着 127.0.0.1:port，绑 0.0.0.0:port 必然 EADDRINUSE；
    // 只绑局域网那几张 IPv4 网卡（10.0.0.115:18787 这种），互不冲突，外部仍能直达。
    const hosts = (Array.isArray(host) ? host : [host]).filter((h) => typeof h === 'string' && h !== '' && h !== '0.0.0.0')
    if (hosts.length === 0) {
      log('error', '额外端口 ' + port + ' 没有可用的局域网地址，先不放出')
      forwardServers.delete(port)
      return
    }
    for (const h of hosts) {
      const server = http.createServer({ requestTimeout: 0, headersTimeout: 0, keepAliveTimeout: 65000 }, handleRequest)
      server.timeout = 0
      server.setTimeout(0)
      server.on('upgrade', handleUpgrade)
      server.on('clientError', (_err, socket) => { try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n') } catch { /* 已关 */ } })
      server.on('error', (err) => {
        if (err && err.code === 'EADDRINUSE') {
          log('error', '额外端口 ' + h + ':' + port + ' 已被占用，' + cfg.retryMs + 'ms 后重试')
          clearTimeout(entry.retryTimer)
          entry.retryTimer = setTimeout(() => { closeForward(port); syncForwards() }, cfg.retryMs)
          try { server.close() } catch { /* 未监听 */ }
          return
        }
        log('error', '额外端口监听失败 ' + h + ':' + port + ' — ' + (err && err.message))
      })
      server.listen(port, h, () => {
        log('info', '额外端口已放出 ' + h + ':' + port + ' → 127.0.0.1:' + port)
      })
      entry.list.push(server)
    }
  }

  const syncForwards = () => {
    let current
    try { current = getLanState() } catch { return }
    const want = current.lanAccess === true && current.forwardsEnabled === true
      ? current.forwards.filter((p) => p !== cfg.listenPort && p !== cfg.upstreamPort)
      : []
    for (const port of [...forwardServers.keys()]) {
      if (!want.includes(port)) closeForward(port)
    }
    if (want.length === 0) return
    let lanHosts = []
    try { lanHosts = collectAddresses().lan4.map((row) => row.address) } catch { lanHosts = [] }
    if (lanHosts.length === 0) return
    for (const port of want) {
      if (forwardServers.has(port)) continue
      startForward(lanHosts, port)
    }
  }

  const start = (host) => {
    const server = http.createServer({
      requestTimeout: 0,
      headersTimeout: 0,
      keepAliveTimeout: 65000,
    }, onRequest)
    server.timeout = 0
    server.setTimeout(0)
    server.on('upgrade', onUpgrade)
    server.on('clientError', (_err, socket) => {
      try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n') } catch { /* 已关 */ }
    })
    server.on('error', (err) => {
      if (err && err.code === 'EADDRINUSE') {
        log('error', '端口 ' + host + ':' + cfg.listenPort + ' 被占用，' + cfg.retryMs + 'ms 后重试')
        if (!disposed) {
          clearTimeout(retryTimer)
          retryTimer = setTimeout(() => { if (!disposed) start(host) }, cfg.retryMs)
        }
        try { server.close() } catch { /* 未监听 */ }
        return
      }
      log('error', '监听失败 ' + host + ':' + cfg.listenPort + ' — ' + (err && err.message))
    })
    // IPv6 用 ipv6Only，否则 Linux 双栈会把 0.0.0.0 占的端口算作冲突
    const listenArgs = host === '::'
      ? [{ port: cfg.listenPort, host, ipv6Only: true }]
      : [cfg.listenPort, host]
    server.listen(...listenArgs, () => {
      log('info', '反代已监听 ' + host + ':' + cfg.listenPort + ' → ' + cfg.upstreamHost + ':' + cfg.upstreamPort)
    })
    servers.push(server)
    return server
  }

  // 记住「当前真正在监听」的地址：公网开关/密钥变化不该触发重建监听
  let appliedHost = ''
  let appliedPort = 0
  let appliedV6 = null

  const startHosts = () => {
    // 端口可能在运行期被改过：每次重建监听都从状态文件取一次
    cfg.listenPort = effectivePort()
    const host = cfg.listenHost = effectiveListenHost()
    const wantV6 = getLanState().ipv6 === true
    appliedHost = host
    appliedPort = cfg.listenPort
    appliedV6 = wantV6
    start(host)
    // IPv6 用 ipv6Only，否则 Linux 双栈会把 0.0.0.0 占的端口算作冲突
    if (wantV6 && host === '0.0.0.0') {
      try { start('::') } catch (e) { log('info', 'IPv6 监听跳过: ' + (e && e.message)) }
    }
    if (getLanState().lanAccess) {
      log('warn', '监听 ' + host + ':' + cfg.listenPort + ' —— 局域网访问已开启，同一网络里的任何设备都能进入 DSH 后台')
    }
    syncForwards()
  }

  try {
    startHosts()
  } catch (e) {
    // 插件加载期绝不抛异常：宿主崩了连修都没法修
    log('error', '反代启动失败: ' + (e && e.message))
  }

  let unsubscribeLan = () => {}
  try {
    unsubscribeLan = onLanChange(() => {
      // 只有「监听地址 / 端口」变了才需要重建监听；
      // 公网开关、访问密钥、黑名单这些只影响请求判定，重建反而会让正在用的连接断掉
      const host = effectiveListenHost()
      const port = effectivePort()
      const v6 = getLanState().ipv6 === true
      if (host !== appliedHost || port !== appliedPort || v6 !== appliedV6) rebind()
      // 额外端口列表/开关变了：只调整那几个转发监听，不动主监听
      syncForwards()
    })
  } catch { /* 订阅失败不连坐 */ }

  try {
    registerLanControl(ctx, cfg, log, {
      listClients,
      clearSeen: () => {
        const before = seenClients.size
        seenClients.clear()
        scanStats.clear()
        return before
      },
    })
  } catch (e) {
    log('error', '局域网开关接口注册失败: ' + (e && e.message))
  }

  const dispose = () => {
    disposed = true
    clearTimeout(retryTimer)
    clearTimeout(rebindTimer)
    try { unsubscribeLan() } catch { /* 已解除 */ }
    for (const s of servers) {
      try { s.close() } catch { /* 已关 */ }
    }
    for (const port of [...forwardServers.keys()]) closeForward(port)
    log('info', '反代已停止')
  }

  if (ctx && typeof ctx.effect === 'function') {
    try { ctx.effect(() => dispose) } catch { /* effect 缺席不连坐 */ }
  }
  return dispose
}


/**
 * 一个包承载多种 Cordis 行：
 *   - id 含 trusted-connection → 免 Token 登录（替换官方 Connection 提供方）
 *   - 其余（反代本体）→ 起 8080 反向代理
 */
export async function apply(ctx, config) {
  const entryId = ctx && ctx.fiber && ctx.fiber.entry && ctx.fiber.entry.options
    ? ctx.fiber.entry.options.id
    : undefined
  if (typeof entryId === 'string' && entryId.includes('trusted-connection')) {
    return applyTrustedConnection(ctx, config)
  }
  return applyProxy(ctx, config)
}

export function describeParts(value) {
  const ua = typeof value === 'string' ? value : ''
  let device = '未知'
  let browser = '未知'
  let system = '未知'
  let m = null
  if (ua === '') return { device, browser, system, line: '设备 未知 · 浏览器 未知 · 系统 未知' }
  if (/^curl\//i.test(ua)) return { device: '命令行', browser: 'curl ' + (ua.match(/curl\/([\d.]+)/i) || ['', ''])[1], system: '未知', line: '设备 命令行 · 浏览器 curl · 系统 未知' }
  if (/python-requests|python\//i.test(ua)) return { device: '命令行', browser: 'Python 脚本', system: '未知', line: '设备 命令行 · 浏览器 Python 脚本 · 系统 未知' }
  if (/Windows NT 10\.0/.test(ua)) system = 'Windows 10/11'
  else if ((m = ua.match(/Windows NT ([\d.]+)/))) system = 'Windows ' + m[1]
  else if ((m = ua.match(/Android[\s/]([\d.]+)/))) system = 'Android ' + m[1]
  else if ((m = ua.match(/iPhone OS ([\d_]+)/))) system = 'iOS ' + m[1].replace(/_/g, '.')
  else if (/iPad/.test(ua) && (m = ua.match(/OS ([\d_]+)/))) system = 'iPadOS ' + m[1].replace(/_/g, '.')
  else if ((m = ua.match(/Mac OS X ([\d_.]+)/))) system = 'macOS ' + m[1].replace(/_/g, '.')
  else if (/CrOS/.test(ua)) system = 'ChromeOS'
  else if (/Linux/.test(ua)) system = 'Linux'
  if (/iPad/i.test(ua)) device = 'iPad'
  else if (/iPhone|iPod/i.test(ua)) device = 'iPhone'
  else if (/Android/i.test(ua)) {
    const model = ua.match(/Android[^;)]*;\s*([^;()]+?)(?:\s+Build|\s*\))/i)
    device = model && model[1] && model[1].trim().length < 30 ? model[1].trim() : 'Android 手机'
  } else if (/Windows/i.test(ua)) device = '电脑'
  else if (/Macintosh|Mac OS X/i.test(ua)) device = 'Mac'
  else if (/CrOS/i.test(ua)) device = 'Chromebook'
  else if (/Linux/i.test(ua)) device = 'Linux 设备'
  if (/MicroMessenger/i.test(ua)) browser = '微信' + ((m = ua.match(/MicroMessenger\/([\d.]+)/)) ? ' ' + m[1] : '')
  else if (/QQBrowser|\bQQ\//i.test(ua)) browser = 'QQ 浏览器'
  else if (/Edg\//i.test(ua)) browser = 'Edge' + ((m = ua.match(/Edg\/(\d+)/)) ? ' ' + m[1] : '')
  else if (/OPR\//i.test(ua)) browser = 'Opera'
  else if (/Firefox\//i.test(ua)) browser = 'Firefox' + ((m = ua.match(/Firefox\/(\d+)/)) ? ' ' + m[1] : '')
  else if (/Chrome\//i.test(ua)) browser = 'Chrome' + ((m = ua.match(/Chrome\/(\d+)/)) ? ' ' + m[1] : '')
  else if (/Safari/i.test(ua)) browser = 'Safari' + ((m = ua.match(/Version\/([\d.]+)/)) ? ' ' + m[1].split('.')[0] : '')
  return { device, browser, system, line: '设备 ' + device + ' · 浏览器 ' + browser + ' · 系统 ' + system }
}

export function describeUa(value) {
  return describeParts(value).line
}

export const name = 'dsh-plugin-reverse-proxy'

/** host.js 的免登录半区要用 ctx.webServer.register 注册路由 */
export const inject = ['webServer']
