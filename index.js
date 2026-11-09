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

const HOP_BY_HOP = new Set([
  'connection', 'proxy-connection', 'keep-alive', 'te', 'trailer',
  'transfer-encoding', 'upgrade',
])

const DEFAULTS = {
  listenHost: '0.0.0.0',
  listenPort: 8080,
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
  c.listenPort = Number(c.listenPort) || DEFAULTS.listenPort
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

export function apply(ctx, config) {
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
      res.writeHead(up.statusCode || 502, up.statusMessage, downHeaders(up.headers))
      up.pipe(res)
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

  try {
    start(cfg.listenHost)
    if (cfg.listenIpv6 && cfg.listenHost === '0.0.0.0') {
      try { start('::') } catch (e) { log('info', 'IPv6 监听跳过: ' + e.message) }
    }
  } catch (e) {
    // 插件加载期绝不抛异常：宿主崩了连修都没法修
    log('error', '反代启动失败: ' + (e && e.message))
  }

  const dispose = () => {
    disposed = true
    clearTimeout(retryTimer)
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

export const name = 'dsh-plugin-reverse-proxy'
