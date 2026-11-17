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

import http from 'node:http'
import net from 'node:net'
import zlib from 'node:zlib'
import { apply as applyTrustedConnection } from './vendor/skip/host.js'
import {
  DEFAULT_PORT,
  describeLanState,
  effectiveListenHost,
  effectivePort,
  getLanState,
  LAN_WARNING_TEXT,
  onLanChange,
  setLanAccess,
  setPort,
  STATE_FILE,
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
function registerLanControl(ctx, cfg, log) {
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

  const webServer = ctx && typeof ctx.get === 'function' ? ctx.get('webServer') : null
  if (webServer && typeof webServer.register === 'function' && typeof ctx.effect === 'function') {
    ctx.effect(() => webServer.register(routeStatus))
    ctx.effect(() => webServer.register(routeSet))
    ctx.effect(() => webServer.register(routePort))
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

  const statusText = () => {
    const s = getLanState()
    const port = effectivePort()
    const head = s.lanAccess
      ? '局域网访问：已开启（监听 0.0.0.0:' + port + '，同网段设备可直接进入后台）'
      : '局域网访问：已关闭（只监听 127.0.0.1:' + port + '，只有本机能访问）'
    const when = s.updatedAt ? '上次修改：' + s.updatedAt + '（' + (s.updatedBy || 'unknown') + '）' : '还没有改过，当前是默认值'
    return [head, when].join('\n')
  }

  ctx.effect(() => commands.register({
    name: 'lan',
    description: '查看或切换局域网访问开关与端口（/lan yes / /lan no / /lan port 9000）',
    input: { hint: 'yes | no | status | port <n>' },
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
      return { kind: 'error', text: '看不懂「' + arg + '」。用法：/lan（看状态）、/lan yes（开启）、/lan no（关闭）、/lan port 9000（改端口）' }
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

  const onRequest = (req, res) => {
    let received = 0
    let aborted = false
    const upstream = http.request({
      host: cfg.upstreamHost,
      port: cfg.upstreamPort,
      method: req.method,
      path: req.url,
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
    const upstream = net.connect(cfg.upstreamPort, cfg.upstreamHost, () => {
      const headers = upstreamHeaders(req, cfg, {
        connection: 'Upgrade',
        upgrade: req.headers.upgrade || 'websocket',
      })
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
    upstream.on('error', () => {
      try { clientSocket.destroy() } catch { /* 已关 */ }
    })
    clientSocket.on('error', () => {
      try { upstream.destroy() } catch { /* 已关 */ }
    })
    upstream.setTimeout(0)
    upstream.setNoDelay(true)
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

  const startHosts = () => {
    // 端口可能在运行期被改过：每次重建监听都从状态文件取一次
    cfg.listenPort = effectivePort()
    const host = cfg.listenHost = effectiveListenHost()
    start(host)
    // IPv6 用 ipv6Only，否则 Linux 双栈会把 0.0.0.0 占的端口算作冲突
    if (cfg.listenIpv6 && host === '0.0.0.0') {
      try { start('::') } catch (e) { log('info', 'IPv6 监听跳过: ' + (e && e.message)) }
    }
    if (getLanState().lanAccess) {
      log('warn', '监听 ' + host + ':' + cfg.listenPort + ' —— 局域网访问已开启，同一网络里的任何设备都能进入 DSH 后台')
    }
  }

  try {
    startHosts()
  } catch (e) {
    // 插件加载期绝不抛异常：宿主崩了连修都没法修
    log('error', '反代启动失败: ' + (e && e.message))
  }

  let unsubscribeLan = () => {}
  try {
    unsubscribeLan = onLanChange(() => rebind())
  } catch { /* 订阅失败不连坐 */ }

  try {
    registerLanControl(ctx, cfg, log)
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

export const name = 'dsh-plugin-reverse-proxy'

/** host.js 的免登录半区要用 ctx.webServer.register 注册路由 */
export const inject = ['webServer']
