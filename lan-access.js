/**
 * 局域网访问开关（0.3.2）+ 自定义端口（0.3.5）+ 访问 IP / 黑名单（0.5.0）
 * + 公网访问与访问密钥（0.6.0）。
 *
 * 默认关闭：反代只监听 127.0.0.1，同一台机器上的浏览器才能打开。
 * 用户必须在设置页点开关（弹安全提示、点「确定」）或者在命令行里确认，
 * 才把监听地址切到 0.0.0.0 / ::，对同一网络里的所有设备开放。
 *
 * 状态落在 `<DSH_HOME>/plugin-reverse-proxy/lan-access.json`：
 * 开关切换后马上写盘，重启 dsh 不需要重新打开。
 */
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

const DSH_HOME = (() => {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv
  return path.join(os.homedir(), '.dsh')
})()

export const STATE_FILE = path.join(DSH_HOME, 'plugin-reverse-proxy', 'lan-access.json')

/** 默认监听端口：0.3.5 起端口也进状态文件，可在设置页改，重启保留。 */
export const DEFAULT_PORT = 8080

/** 黑名单最多记这么多条，防止状态文件无限长。 */
export const MAX_BLOCKED = 200

/** 访问密钥：5–64 位，只允许英文字母和数字（拼音就是字母，不能有符号）。 */
export const MIN_KEY_LENGTH = 5
export const MAX_KEY_LENGTH = 64

export const PUBLIC_WARNING_TITLE = '对公网开放访问？'
export const PUBLIC_WARNING_LINES = [
  '开启后，任何设备只要拿到 公网IP:端口/访问密钥 这条地址，就能直接进入 DSH 后台。',
  '密钥至少 5 位、只用字母和数字；它等于后台的钥匙，请勿外传，也不要贴在公开的地方。',
  '公网访问还取决于路由器/防火墙有没有把该端口映射出去——插件只管放行，不管打洞。',
]
export const PUBLIC_WARNING_TEXT = [PUBLIC_WARNING_TITLE, ...PUBLIC_WARNING_LINES].join('\n')

/** 安全提示文案：设置页弹窗与命令行共用同一份，避免两处说法不一致。 */
export const LAN_WARNING_TITLE = '对局域网开放访问？'
export const LAN_WARNING_LINES = [
  '开启后，同一网络里的任何设备打开这台机器的 8080 端口，都能直接进入 DSH 后台，',
  '不需要 Token、不需要登录，等于把整台机器的控制权交给同一网段的所有人。',
  '只在你信任当前 Wi-Fi / 局域网（比如家里、自己手机的热点）时才开启。',
]
export const LAN_WARNING_TEXT = [
  LAN_WARNING_TITLE,
  ...LAN_WARNING_LINES,
  '恢复为只允许本机访问后，其他设备会立刻断开。',
].join('\n')

/**
 * 端口合法性：1024–65535，且不能是上游的 3080（自己转发给自己会成环）。
 * 返回 { ok, port } 或 { ok:false, error }——HTTP 接口、命令行、前端共用同一套规则。
 */
export const validatePort = (value) => {
  const n = typeof value === 'string' ? Number(value.trim()) : Number(value)
  if (!Number.isInteger(n)) return { ok: false, error: '端口必须是整数' }
  if (n < 1024) return { ok: false, error: '端口要在 1024–65535 之间（1024 以下需要 root，且更容易撞系统服务）' }
  if (n > 65535) return { ok: false, error: '端口不能超过 65535' }
  if (n === 3080) return { ok: false, error: '3080 是 DSH 自己的端口，反代不能占它' }
  return { ok: true, port: n }
}

/**
 * 访问密钥校验：5–64 位，只允许 A-Z a-z 0-9（拼音是字母，符号一律不收）。
 * 返回 { ok, key } 或 { ok:false, error }。
 */
export const validateKey = (value) => {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (raw.length < MIN_KEY_LENGTH) return { ok: false, error: `访问密钥至少 ${MIN_KEY_LENGTH} 位` }
  if (raw.length > MAX_KEY_LENGTH) return { ok: false, error: `访问密钥不能超过 ${MAX_KEY_LENGTH} 位` }
  if (!/^[A-Za-z0-9]+$/.test(raw)) return { ok: false, error: '访问密钥只能包含英文字母和数字（拼音可以，符号不行）' }
  return { ok: true, key: raw }
}

/**
 * 归一化 IP：双栈 socket 会给 `::ffff:192.168.1.7`，去掉前缀才好比较、好显示。
 * 非法字符串返回空串（调用方据此跳过）。
 */
export const normalizeIp = (value) => {
  if (typeof value !== 'string') return ''
  let ip = value.trim()
  if (ip === '') return ''
  const mapped = ip.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i)
  if (mapped) ip = mapped[1]
  const zone = ip.indexOf('%')
  if (zone !== -1) ip = ip.slice(0, zone)
  if (net.isIP(ip) === 0) return ''
  return ip
}

/** 回环地址不允许进黑名单：封了它等于把自己锁在门外。 */
const isLoopback = (ip) => ip === '::1' || /^127\./.test(ip)

const DEFAULT_STATE = {
  lanAccess: false,
  port: DEFAULT_PORT,
  blacklistEnabled: false,
  blockedIps: [],
  publicAccess: false,
  accessKey: '',
  updatedAt: null,
  updatedBy: null,
}

const sanitizeBlocked = (value) => {
  if (!Array.isArray(value)) return []
  const out = []
  for (const item of value) {
    const ip = normalizeIp(item)
    if (ip === '' || isLoopback(ip)) continue
    if (out.includes(ip)) continue
    out.push(ip)
    if (out.length >= MAX_BLOCKED) break
  }
  return out
}

const readState = () => {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
    const parsed = validatePort(raw?.port)
    const key = validateKey(raw?.accessKey)
    return {
      lanAccess: raw?.lanAccess === true,
      port: parsed.ok ? parsed.port : DEFAULT_PORT,
      blacklistEnabled: raw?.blacklistEnabled === true,
      blockedIps: sanitizeBlocked(raw?.blockedIps),
      publicAccess: raw?.publicAccess === true && key.ok,
      accessKey: key.ok ? key.key : '',
      updatedAt: typeof raw?.updatedAt === 'string' ? raw.updatedAt : null,
      updatedBy: typeof raw?.updatedBy === 'string' ? raw.updatedBy : null,
    }
  } catch {
    // 文件不存在 / 读坏了都当「关闭」——安全默认值
    return { ...DEFAULT_STATE, blockedIps: [] }
  }
}

let state = readState()
const listeners = new Set()

const writeState = (next) => {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true })
    const tmp = STATE_FILE + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8')
    fs.renameSync(tmp, STATE_FILE)
  } catch (error) {
    // 写盘失败不能连坐宿主，但必须让调用方看见
    throw new Error('无法保存局域网开关状态: ' + (error && error.message ? error.message : String(error)))
  }
}

const notify = () => {
  for (const listener of listeners) {
    try { listener(getLanState()) } catch { /* 单个监听者失败不连坐 */ }
  }
}

/** 所有写操作走这里：保留未提到的字段、补时间戳、落盘、广播。 */
const commit = (patch, by) => {
  const next = {
    ...state,
    ...patch,
    updatedAt: new Date().toISOString(),
    updatedBy: by,
  }
  next.blockedIps = sanitizeBlocked(next.blockedIps)
  writeState(next)
  state = next
  notify()
  return getLanState()
}

export const getLanState = () => ({ ...state, blockedIps: [...state.blockedIps] })

/** 默认监听地址：没开就是本机回环。 */
export const effectiveListenHost = () => (state.lanAccess ? '0.0.0.0' : '127.0.0.1')

/** 当前生效端口（状态文件优先，没有就用默认 8080）。 */
export const effectivePort = () => state.port || DEFAULT_PORT

/** 订阅开关变化（反代用它重建监听）。返回取消订阅函数。 */
export const onLanChange = (listener) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/**
 * 改总开关：写盘 → 通知监听者。`by` 只用于记录是谁动的（settings / command / cli）。
 * 关掉总开关时顺带把公网访问也关掉——端口都不朝外听了，留着公网开关只会让人误会。
 */
export const setLanAccess = (enabled, by = 'unknown') => (
  enabled === true ? commit({ lanAccess: true }, by) : commit({ lanAccess: false, publicAccess: false }, by)
)

/** 改端口：校验 → 写盘 → 通知监听者（调用方负责确认端口没被占用）。 */
export const setPort = (value, by = 'unknown') => {
  const parsed = validatePort(value)
  if (!parsed.ok) throw new Error(parsed.error)
  return commit({ port: parsed.port }, by)
}

/** 设访问密钥：校验 → 写盘。返回状态。 */
export const setAccessKey = (value, by = 'unknown') => {
  const parsed = validateKey(value)
  if (!parsed.ok) throw new Error(parsed.error)
  return commit({ accessKey: parsed.key }, by)
}

/**
 * 公网开关：打开必须先有合法密钥（可以同一次一起给）。
 * 关掉只表示「不再放行公网」，总开关与局域网访问不受影响。
 */
export const setPublicAccess = (enabled, value, by = 'unknown') => {
  if (enabled === true) {
    // 总开关没开时端口只绑 127.0.0.1，公网根本进不来：与其让人以为「开了公网」，不如直接拒绝
    if (state.lanAccess !== true) {
      throw new Error('请先开启「局域网访问」总开关：端口朝外监听由它管，公网开关只决定要不要校验密钥。')
    }
    const parsed = value === undefined ? (state.accessKey !== '' ? { ok: true, key: state.accessKey } : validateKey('')) : validateKey(value)
    if (!parsed.ok) throw new Error(parsed.error)
    return commit({ publicAccess: true, accessKey: parsed.key }, by)
  }
  return commit({ publicAccess: false }, by)
}

/** 黑名单总开关。关掉时不拦任何人，但名单保留，下次打开继续生效。 */
export const setBlacklistEnabled = (enabled, by = 'unknown') => commit({ blacklistEnabled: enabled === true }, by)

/**
 * 拉黑一个 IP。
 * 返回 `{ ok, added, state }`：`added:false` 表示本来就在名单里（同一个 IP 不需要重复添加）。
 */
export const blockIp = (value, by = 'unknown') => {
  const ip = normalizeIp(value)
  if (ip === '') throw new Error('IP 地址不合法：' + String(value))
  if (isLoopback(ip)) throw new Error('不能封禁本机回环地址（会把设置页自己也锁在外面）')
  if (state.blockedIps.includes(ip)) return { ok: true, added: false, ip, state: getLanState() }
  const next = commit({ blockedIps: [...state.blockedIps, ip] }, by)
  return { ok: true, added: true, ip, state: next }
}

/** 解除拉黑。返回 `{ ok, removed, ip, state }`。 */
export const unblockIp = (value, by = 'unknown') => {
  const ip = normalizeIp(value)
  if (ip === '') throw new Error('IP 地址不合法：' + String(value))
  const index = state.blockedIps.indexOf(ip)
  if (index === -1) return { ok: true, removed: false, ip, state: getLanState() }
  const rest = state.blockedIps.filter((item) => item !== ip)
  const next = commit({ blockedIps: rest }, by)
  return { ok: true, removed: true, ip, state: next }
}

/** 当前是否拦这个 IP：黑名单没开就一律放行。 */
export const isBlocked = (value) => {
  if (state.blacklistEnabled !== true) return false
  const ip = normalizeIp(value)
  if (ip === '') return false
  return state.blockedIps.includes(ip)
}

/**
 * 一键恢复默认：局域网访问关闭、端口 8080、黑名单关闭且清空。
 * 存在的意义是「误操作后的安全阀」——比如把自己或整个网段搞进黑名单、端口填成了别人占着的。
 * 注意：关掉局域网访问后，正从 8080 访问的设备会立刻断开，所以命令入口都要求二次确认。
 */
export const resetConfig = (by = 'unknown') => commit({
  lanAccess: false,
  port: DEFAULT_PORT,
  blacklistEnabled: false,
  blockedIps: [],
  publicAccess: false,
  accessKey: '',
}, by)

/** 盯住状态文件：命令行脚本 / 手动改 json 也能触发重建监听。 */
const startWatch = () => {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true })
    fs.watch(path.dirname(STATE_FILE), { persistent: false }, (_event, filename) => {
      if (filename && filename !== path.basename(STATE_FILE)) return
      const next = readState()
      const same = next.lanAccess === state.lanAccess
        && next.port === state.port
        && next.blacklistEnabled === state.blacklistEnabled
        && next.blockedIps.join(',') === state.blockedIps.join(',')
        && next.publicAccess === state.publicAccess
        && next.accessKey === state.accessKey
      if (same) return
      state = next
      notify()
    })
  } catch { /* 盯不住就算了，开关本身还能用 */ }
}
startWatch()

/** 给 UI / 命令用的统一状态描述。 */
export const describeLanState = (port) => {
  const current = getLanState()
  return {
    ok: true,
    lanAccess: current.lanAccess,
    updatedAt: current.updatedAt,
    updatedBy: current.updatedBy,
    listenHost: effectiveListenHost(),
    port: typeof port === 'number' ? port : effectivePort(),
    defaultPort: DEFAULT_PORT,
    blacklistEnabled: current.blacklistEnabled,
    blockedIps: current.blockedIps,
    blockedCount: current.blockedIps.length,
    publicAccess: current.publicAccess,
    hasKey: current.accessKey !== '',
    // 打开公网时把「该用哪条地址」直接给出去，省得用户自己拼
    accessPath: current.publicAccess && current.accessKey !== '' ? '/' + current.accessKey : '',
    keyHint: current.accessKey === '' ? '' : current.accessKey.slice(0, 2) + '***' + current.accessKey.slice(-1),
    minKeyLength: MIN_KEY_LENGTH,
    warningPublic: PUBLIC_WARNING_TEXT,
    stateFile: STATE_FILE,
  }
}
