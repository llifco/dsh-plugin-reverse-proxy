import { bridge } from '../bridge.js';
/** Construct the common trusted /api carrier route for one compatibility adapter. */
export function createHostRuntime(input, adapterId) {
    const connection = new input.module.HostConnectionService(input.ctx, input.trustedHosts, input.auth);
    const fetchHandler = connection.createSharedFetchHandler(input.module.API_PATH);
    const route = {
        kind: 'prefix',
        path: input.module.API_PATH,
        handler: async (req, res) => {
            const rejection = connection.requestRejection(req);
            if (rejection !== undefined) {
                res.writeHead(rejection);
                res.end(rejection === 401 ? 'unauthorized' : 'forbidden');
                return;
            }
            await bridge(req, res, fetchHandler, input.maxRequestBodyBytes);
        },
    };
    return { connection, route, fetchHandler, adapterId };
}
