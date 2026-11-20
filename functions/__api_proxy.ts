import { handleApiProxyRequest } from '../cloudflare/worker';

export const onRequest = async (context: { request: Request }): Promise<Response> => {
  return handleApiProxyRequest(context.request);
};
