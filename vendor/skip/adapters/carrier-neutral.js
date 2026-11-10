import { createHostRuntime } from './types.js';
/** Host implementation for the 0.1.5 carrier-neutral connection contract. */
export const HOST_ADAPTER_ID = 'carrier-neutral';
export function createCarrierNeutralRuntime(input) {
    const runtime = createHostRuntime(input, HOST_ADAPTER_ID);
    if (typeof runtime.fetchHandler.requestBodyMode !== 'function') {
        throw new Error('dsh-plugin-reverse-proxy: carrier-neutral profile requires a requestBodyMode-aware connection handler');
    }
    // 0.1.5's carrier-neutral service keeps generic rpc.handle() registrations
    // on the reading context, which is often a sibling plugin without webServer.
    // Bind only this replacement instance to the adapter's carrier context. This
    // is the narrow equivalent of the upstream workaround and leaves fetch
    // registry ownership untouched.
    const service = runtime.connection;
    const originalRegister = service.register;
    if (typeof originalRegister !== 'function') {
        throw new Error('dsh-plugin-reverse-proxy: carrier-neutral connection lacks its RPC register seam');
    }
    service.register = function registerWithCarrier(_owner, channel, handler) {
        return originalRegister.call(this, input.ctx, channel, handler);
    };
    return runtime;
}
