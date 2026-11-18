/**
 * 多窗口共存：每个标签页自己的身份 ⇒ 每个标签页自己的 Peer。
 *
 * 官方 ConnectionService 的身份模型是「一个浏览器 cookie = 一个 Peer」：同一
 * 浏览器的所有标签共享 cookie，于是第二块窗口和第一块抢同一个 Peer；而官方一个
 * Peer 只认一条事件流（能回答 waterfall 的那条），第二块窗口的首屏请求等不到
 * 回答，就一直转圈。
 *
 * 免 Token 模式更麻烦一层：官方 `admit()` 里 `isAuthenticated()` 恒真，于是所有
 * 普通请求都直接落到共享的 `browserPeer`；事件流（waterfall）要求「回答来自持有
 * 该流的同一份 Peer」，browserPeer 手上没有 socket，请求就永远没人应答。
 *
 * 所以这里同时接管两处：
 *   · `admit(request)`      —— 带标签身份的请求发给该标签的 Peer（普通请求与事件流同一份）；
 *   · `admitConnection(req)`—— mux 建立时把 socket 挂到该标签的 Peer 上，引用计数归零才回收。
 * 认不到标签 id 时完全退回官方行为。
 */

const TAB_HEADER = 'x-dsh-tab'
const TAB_QUERY = 'tab'
const TAB_PATTERN = /^[A-Za-z0-9._-]{8,64}$/

/** 从请求里认领标签 id：优先请求头，其次 mux URL 的 ?tab=。 */
function tabIdOf(request) {
    try {
        const header = request?.headers?.[TAB_HEADER]
        const value = Array.isArray(header) ? header[0] : header
        if (typeof value === 'string' && TAB_PATTERN.test(value)) return value
        const url = new URL(request?.url ?? '/', 'http://dsh.invalid')
        const query = url.searchParams.get(TAB_QUERY)
        if (typeof query === 'string' && TAB_PATTERN.test(query)) return query
    }
    catch {
        // 请求形态异常一律当作「没有标签身份」，走官方路径
    }
    return undefined
}

function pathOf(request) {
    try { return new URL(request?.url ?? '/', 'http://dsh.invalid').pathname }
    catch { return '?' }
}

/**
 * 在 ConnectionService 实例上安装 per-tab Peer 行为。
 * @param connection - 官方 HostConnectionService 实例（已由适配器创建）
 * @returns 是否安装成功
 */
export function installPerSocketPeers(connection) {
    const peers = connection.peers
    const publishPeer = connection.publishPeer
    if (!(peers instanceof Map) || typeof publishPeer !== 'function') return false
    if (typeof connection.admit !== 'function' || typeof connection.admitConnection !== 'function') return false

    const originalAdmit = connection.admit.bind(connection)
    const originalAdmitConnection = connection.admitConnection.bind(connection)

    /** tab → { record, sockets } ；sockets 是该标签当前挂着的 mux 数。 */
    const tabs = new Map()
    const seen = new Map()
    const logOnce = (key, line) => {
        const bucket = Math.floor(Date.now() / 60000)
        const k = `${key}:${bucket}`
        if (seen.has(k)) return
        seen.set(k, true)
        if (seen.size > 400) seen.clear()
        console.log(line)
    }

    function mint(key, interactions) {
        const id = publishPeer.call(connection, interactions ?? 'answer')
        const record = peers.get(id)
        if (record === undefined) return undefined
        if (key !== id) {
            peers.delete(id)
            peers.set(key, record)
        }
        // 让 record 自己知道它挂在哪个 key 下，回收时才能找到自己
        record.__reproxyKey = key
        return record
    }

    function ensure(tab) {
        let entry = tabs.get(tab)
        if (entry !== undefined && entry.record?.peer !== undefined) return entry
        const record = mint(tab, 'answer')
        if (record === undefined) return undefined
        entry = { record, sockets: 0 }
        tabs.set(tab, entry)
        return entry
    }

    // ① 普通请求：官方在免 Token 模式下把所有人都塞给 browserPeer，
    //    这里先把标签认出来，再交给该标签自己的 Peer。
    connection.admit = function admitPerTab(request) {
        const base = originalAdmit(request)
        if (base !== undefined && base !== null && 'rejection' in base) return base
        const tab = tabIdOf(request)
        if (tab === undefined) return base
        const entry = ensure(tab)
        if (entry === undefined) return base
        logOnce(`http:${tab}`, `[reproxy-lan] http tab ${tab.slice(0, 8)} ${pathOf(request)}`)
        return { peer: entry.record.peer }
    }

    // ② mux：socket 挂到同一份 Peer 上，引用计数归零才 dispose。
    connection.admitConnection = function admitConnectionPerTab(request) {
        const tab = tabIdOf(request)
        if (tab === undefined) return originalAdmitConnection(request)
        const base = originalAdmit(request)
        if (base !== undefined && base !== null && 'rejection' in base) {
            logOnce(`muxrej:${tab}`, `[reproxy-lan] mux 被拒 ${tab.slice(0, 8)} → ${base.rejection}`)
            return base
        }
        const entry = ensure(tab)
        if (entry === undefined) return originalAdmitConnection(request)
        entry.sockets += 1
        entry.record.ownsSocket = true
        let released
        console.log('[reproxy-lan] mux admit', tab.slice(0, 8), '| 该标签 socket 数:', entry.sockets, '| 活跃 Peer:', peers.size)
        return {
            peer: entry.record.peer,
            release: () => {
                if (released !== undefined) return released
                entry.sockets = Math.max(0, entry.sockets - 1)
                let disposed
                if (entry.sockets === 0) {
                    if (peers.get(tab) === entry.record) peers.delete(tab)
                    else if (entry.record.peer !== undefined && peers.get(entry.record.peer.id) === entry.record) peers.delete(entry.record.peer.id)
                    tabs.delete(tab)
                    disposed = entry.record.peer.dispose()
                }
                else disposed = Promise.resolve()
                console.log('[reproxy-lan] mux release', tab.slice(0, 8), '| 该标签 socket 数:', entry.sockets, '| 剩余 Peer:', peers.size)
                released = disposed
                return released
            },
        }
    }
    return true
}
