/** Runtime connection module loader used by compatibility adapters. */
import { CONNECTION_PACKAGE } from './gate.js';
function isRuntimeConnectionModule(value) {
    if (typeof value !== 'object' || value === null)
        return false;
    const candidate = value;
    return typeof candidate.HostConnectionService === 'function'
        && typeof candidate.API_PATH === 'string';
}
function describeError(error) {
    return error instanceof Error ? error.message : String(error);
}
/**
 * Resolve the connection module from the active product loader.
 *
 * 产品组合必须消费宿主自己的 connection module 实例：有 loader 服务时
 * internal.import 缺失或调用失败都 fail loud——绝不静默回退到插件自带的
 * pinned dev 副本（那会重演 2026-09-05「探针自我满足」一类代际错配）。
 * pinned 副本只允许出现在完全没有 loader 服务的直接单元测试上下文。
 */
export async function loadRuntimeConnectionModule(ctx) {
    const loader = ctx.get('loader');
    if (loader !== undefined) {
        const importer = loader.internal?.import;
        if (typeof importer !== 'function') {
            throw new Error('dsh-plugin-reverse-proxy: product loader is present but loader.internal.import is unavailable; refusing to fall back to the pinned dev copy');
        }
        const baseUrl = ctx.baseUrl;
        if (typeof baseUrl !== 'string' || baseUrl === '') {
            throw new Error('dsh-plugin-reverse-proxy: loader.internal.import requires the plugin context baseUrl (profile directory URL); refusing to import without it');
        }
        let loaded;
        try {
            // 必须以 loader.internal 为接收者调用（bound call）。把方法摘下来
            // detached 调用会丢失 this，Node 内部 ESM loader 在 getOrCreateModuleJob
            // 前即抛 "Cannot read properties of undefined"（2026-09-10 崩溃循环根因）。
            loaded = await importer.call(loader.internal, CONNECTION_PACKAGE, baseUrl, {});
        }
        catch (error) {
            throw new Error(`dsh-plugin-reverse-proxy: failed to import runtime module ${CONNECTION_PACKAGE} via loader.internal.import(name, baseUrl, options): ${describeError(error)}`);
        }
        if (!isRuntimeConnectionModule(loaded)) {
            throw new Error(`dsh-plugin-reverse-proxy: runtime module ${CONNECTION_PACKAGE} has an incompatible export shape`);
        }
        return loaded;
    }
    return importPinnedConnectionModule();
}
/**
 * Pinned dev 副本惰性加载（审计修复 2026-09-28）：只允许在完全没有 loader
 * 服务的直接单元测试上下文执行。禁止顶层静态 import——那会让 0.1.2 旧模块
 * 图在产品环境随插件加载被求值，且 bare specifier 绑定随安装布局漂移（dev
 * 树内嵌时遮蔽命中 pinned 副本，净装则经 pnpm hoist 命中宿主副本）。动态
 * import() 把模块解析推迟到实际调用点，产品路径（loader 恒在）永不触碰该
 * 副本。不变量由 tests/manifest.test.mjs 的 lazy-load 断言锁定。
 */
async function importPinnedConnectionModule() {
    const pinned = (await import('@deepseek-ai/dsh-client-connection'));
    if (typeof pinned?.HostConnectionService !== 'function' || typeof pinned?.API_PATH !== 'string') {
        throw new Error(`dsh-plugin-reverse-proxy: pinned dev module ${CONNECTION_PACKAGE} has an incompatible export shape`);
    }
    return pinned;
}
