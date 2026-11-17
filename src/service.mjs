import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { Store } from './store.mjs';
import { acquire } from './transport.mjs';
import { inspect } from './reader.mjs';
import { DeliveryService } from './delivery.mjs';

async function readBody(request) {
  const chunks = []; let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 16384) throw new Error('request_too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function startService({ source, directory, port = 0 }) {
  const store = await new Store(directory).initialize();
  const courier = new DeliveryService({ source, store });
  const server = http.createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/health') return response.end(JSON.stringify({ ready: true }));
      if (url.pathname === '/records' && request.method === 'GET') return response.end(JSON.stringify(await store.list()));
      if (url.pathname.startsWith('/objects/') && request.method === 'GET') {
        response.setHeader('Content-Type', 'application/octet-stream');
        return response.end(await store.object(url.pathname.slice(9)));
      }
      if (url.pathname.startsWith('/delivery-objects/') && request.method === 'GET') {
        response.setHeader('Content-Type', 'application/octet-stream');
        return response.end(await store.deliveryObject(url.pathname.slice('/delivery-objects/'.length)));
      }
      if (url.pathname === '/intakes' && request.method === 'POST') {
        const payload = JSON.parse((await readBody(request)).toString());
        if (typeof payload.path !== 'string') throw new Error('path_required');
        const result = await acquire(source, payload.path);
        const parsed = inspect(result.bytes);
        const record = await store.accept(result.bytes, new URL(payload.path, source).href, parsed);
        response.statusCode = 201;
        return response.end(JSON.stringify(record));
      }
      // 基于视图领取一份客户交付；碰撞时持久化可核对状态并返回 409，不挑赢家。
      if (url.pathname === '/deliveries' && request.method === 'POST') {
        const payload = JSON.parse((await readBody(request)).toString() || '{}');
        if (payload.name !== undefined && typeof payload.name !== 'string') throw new Error('invalid_name');
        const delivery = await courier.intake({ name: payload.name });
        response.statusCode = delivery.status === 'blocked' ? 409 : 201;
        return response.end(JSON.stringify(delivery));
      }
      if (url.pathname === '/deliveries' && request.method === 'GET') {
        return response.end(JSON.stringify(await store.listDeliveries()));
      }
      const deliveryMatch = /^\/deliveries\/([^/]+)(\/(changes|refresh))?$/.exec(url.pathname);
      if (deliveryMatch && request.method === 'POST') {
        const [, id, , action] = deliveryMatch;
        if (action === 'refresh') {
          const outcome = await courier.refreshView(id);
          response.statusCode = outcome.delivery.status === 'blocked' ? 409 : 200;
          return response.end(JSON.stringify(outcome));
        }
        const payload = JSON.parse((await readBody(request)).toString());
        if (typeof payload.route !== 'string') throw new Error('change_route_required');
        const delivery = await courier.followChange(id, payload.route);
        response.statusCode = delivery.status === 'blocked' ? 409 : 200;
        return response.end(JSON.stringify(delivery));
      }
      if (deliveryMatch && request.method === 'GET' && !deliveryMatch[3]) {
        return response.end(JSON.stringify(await store.getDelivery(deliveryMatch[1])));
      }
      response.writeHead(404); response.end(JSON.stringify({ error: 'not_found' }));
    } catch (error) {
      response.statusCode = error.code === 'ENOENT' ? 404 : 422;
      response.end(JSON.stringify({ error: error.message }));
    }
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return { server, store, courier, url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => server.close(resolve)) };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.env.SOURCE_URL) throw new Error('SOURCE_URL_required');
  const service = await startService({ source: process.env.SOURCE_URL,
    directory: process.env.DATA_DIR ?? './data', port: Number(process.env.PORT ?? 4102) });
  console.log(JSON.stringify({ product: service.url }));
}
