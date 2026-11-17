import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startProvider } from '../src/provider.mjs';
import { startService } from '../src/service.mjs';
const directory = await mkdtemp(join(tmpdir(), 'intake-demo-'));
const provider = await startProvider();
const service = await startService({ source: provider.url, directory });
const post = async (url, body) => {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const payload = await response.json();
  if (response.status >= 400) throw new Error(JSON.stringify(payload));
  return payload;
};
try {
  console.log(JSON.stringify({ source: provider.url, product: service.url }));
  const delivery = await post(`${service.url}/deliveries`);
  console.log('视图领取', JSON.stringify({ status: delivery.status,
    entries: delivery.entries, excluded: delivery.history[0].excluded }));
  const moved = await post(`${service.url}/deliveries/${delivery.id}/changes`, { path: '/changes/11' });
  console.log('跟进移动', JSON.stringify(moved.effects));
  const added = await post(`${service.url}/deliveries/${delivery.id}/changes`, { path: '/changes/12' });
  console.log('跟进新增', JSON.stringify(added.effects));
  const skipped = await post(`${service.url}/deliveries/${delivery.id}/changes`, { path: '/changes/13' });
  console.log('交付外内容跳过', JSON.stringify(skipped.skipped));
  await post(`${provider.url}/_phase`, { phase: 1 });
  const refreshed = await post(`${service.url}/deliveries/${delivery.id}/refresh`);
  console.log('视图切换归因', JSON.stringify(refreshed.effects));
  console.log('碰撞停点', JSON.stringify(refreshed.delivery.collisions));
  const record = await (await fetch(`${service.url}/deliveries/${delivery.id}`)).json();
  console.log('交付档案', JSON.stringify({ status: record.status, moves: record.moves,
    history: record.history.map(event => event.type) }));
} finally { await service.close(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
