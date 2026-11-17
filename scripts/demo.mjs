import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startProvider } from '../src/provider.mjs';
import { startService } from '../src/service.mjs';

const post = (url, body) => fetch(url, { method: 'POST',
  headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });

const directory = await mkdtemp(join(tmpdir(), 'intake-demo-'));
const provider = await startProvider();
const service = await startService({ source: provider.url, directory });
try {
  console.log(JSON.stringify({ source: provider.url, product: service.url }));
  console.log('来源目录', await (await fetch(`${provider.url}/catalog`)).json());

  const intake = await post(`${service.url}/deliveries`, {});
  if (intake.status !== 201) throw new Error(await intake.text());
  const delivery = await intake.json();
  console.log('视图领取', {
    id: delivery.id, status: delivery.status,
    entries: delivery.entries.map(entry => ({ path: entry.deliveryPath, identity: `${entry.depotFile}#${entry.revision}` })),
    excluded: delivery.excluded.map(item => item.depotFile),
  });

  const followed = await post(`${service.url}/deliveries/${delivery.id}/changes`, { route: '/changes/11' });
  if (followed.status !== 200) throw new Error(await followed.text());
  const afterChange = await followed.json();
  console.log('跟进 changelist 11', {
    moves: afterChange.moves.map(move => ({ from: move.from.deliveryPath, to: move.to.deliveryPath })),
    retired: afterChange.ledger.filter(item => !item.alive)
      .map(item => ({ identity: `${item.depotFile}#${item.revision}`, replacedBy: item.replacedBy })),
    entries: afterChange.entries.map(entry => entry.deliveryPath),
  });

  await post(`${provider.url}/_phase`, { phase: 1 });
  const blocked = await post(`${service.url}/deliveries/${delivery.id}/refresh`);
  const blockedOutcome = await blocked.json();
  console.log('切换视图（阶段1）', {
    httpStatus: blocked.status,
    status: blockedOutcome.delivery.status,
    viewDriven: blockedOutcome.explanation.viewDriven,
    sourceDrivenChanges: blockedOutcome.explanation.sourceDriven.changes,
    collisions: blockedOutcome.delivery.collisions.map(collision => ({
      path: collision.deliveryPath,
      candidates: collision.candidates.map(candidate => candidate.depotFile),
    })),
  });

  const followWhileBlocked = await post(`${service.url}/deliveries/${delivery.id}/changes`, { route: '/changes/11' });
  console.log('碰撞态拒绝继续跟进', { httpStatus: followWhileBlocked.status, error: (await followWhileBlocked.json()).error });

  await post(`${provider.url}/_phase`, { phase: 0 });
  const restored = await post(`${service.url}/deliveries/${delivery.id}/refresh`);
  const restoredOutcome = await restored.json();
  console.log('切回原视图', {
    httpStatus: restored.status,
    status: restoredOutcome.delivery.status,
    collisions: restoredOutcome.delivery.collisions.length,
  });
} finally {
  await service.close(); await provider.close(); await rm(directory, { recursive: true, force: true });
}
