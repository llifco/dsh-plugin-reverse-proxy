/**
 * 局域网访问开关（0.3.2）。
 *
 * 默认关闭：反代只监听 127.0.0.1，同一台机器上的浏览器才能打开。
 * 用户必须在设置页点开关（弹安全提示、点「确定」）或者在命令行里确认，
 * 才把监听地址切到 0.0.0.0 / ::，对同一网络里的所有设备开放。
 *
 * 状态落在 `<DSH_HOME>/plugin-reverse-proxy/lan-access.json`：
 * 开关切换后马上写盘，重启 dsh 不需要重新打开。
 */
import fs from 'node:fs'
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

const readState = () => {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
    const parsed = validatePort(raw?.port)
    return {
      lanAccess: raw?.lanAccess === true,
      port: parsed.ok ? parsed.port : DEFAULT_PORT,
      updatedAt: typeof raw?.updatedAt === 'string' ? raw.updatedAt : null,
      updatedBy: typeof raw?.updatedBy === 'string' ? raw.updatedBy : null,
    }
  } catch {
    // 文件不存在 / 读坏了都当「关闭」——安全默认值
    return { lanAccess: false, port: DEFAULT_PORT, updatedAt: null, updatedBy: null }
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

export const getLanState = () => ({ ...state })

/** 默认监听地址：没开就是本机回环。 */
export const effectiveListenHost = () => (state.lanAccess ? '0.0.0.0' : '127.0.0.1')

/** 当前生效端口（状态文件优先，没有就用默认 8080）。 */
export const effectivePort = () => state.port || DEFAULT_PORT

/** 订阅开关变化（反代用它重建监听）。返回取消订阅函数。 */
export const onLanChange = (listener) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** 改开关：写盘 → 通知监听者。`by` 只用于记录是谁动的（settings / command）。 */
export const setLanAccess = (enabled, by = 'unknown') => {
  const next = {
    lanAccess: enabled === true,
    port: effectivePort(),
    updatedAt: new Date().toISOString(),
    updatedBy: by,
  }
  writeState(next)
  state = next
  for (const listener of listeners) {
    try { listener(getLanState()) } catch { /* 单个监听者失败不连坐 */ }
  }
  return getLanState()
}

/** 改端口：校验 → 写盘 → 通知监听者（调用方负责确认端口没被占用）。 */
export const setPort = (value, by = 'unknown') => {
  const parsed = validatePort(value)
  if (!parsed.ok) throw new Error(parsed.error)
  const next = {
    lanAccess: state.lanAccess === true,
    port: parsed.port,
    updatedAt: new Date().toISOString(),
    updatedBy: by,
  }
  writeState(next)
  state = next
  for (const listener of listeners) {
    try { listener(getLanState()) } catch { /* 单个监听者失败不连坐 */ }
  }
  return getLanState()
}

/** 给 UI / 命令用的统一状态描述。 */
/**
 * 盯住状态文件：命令行脚本 / 手动改 json 也能触发重建监听。
 * 目录不存在时先建出来，否则 fs.watch 会直接抛。
 */
const startWatch = () => {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true })
    fs.watch(path.dirname(STATE_FILE), { persistent: false }, (_event, filename) => {
      if (filename && filename !== path.basename(STATE_FILE)) return
      const next = readState()
      if (next.lanAccess === state.lanAccess && next.port === state.port) return
      state = next
      for (const listener of listeners) {
        try { listener(getLanState()) } catch { /* 单个监听者失败不连坐 */ }
      }
    })
  } catch { /* 盯不住就算了，开关本身还能用 */ }
}
startWatch()

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
    stateFile: STATE_FILE,
  }
}
