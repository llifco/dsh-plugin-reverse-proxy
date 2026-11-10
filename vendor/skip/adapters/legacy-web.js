import { createHostRuntime } from './types.js';
/** Host implementation for the 0.1.2-rc.1 web-carrier contract. */
export const HOST_ADAPTER_ID = 'legacy-web';
export function createLegacyWebRuntime(input) {
    return createHostRuntime(input, HOST_ADAPTER_ID);
}
