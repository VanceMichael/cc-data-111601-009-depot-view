import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startProvider } from '../src/provider.mjs';
import { startService } from '../src/service.mjs';
import { Store } from '../src/store.mjs';

async function post(url, body) {
  const response = await fetch(url, { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

test('基于视图的领取、移动跟进、碰撞停点与视图归因', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'delivery-test-'));
  const provider = await startProvider();
  const service = await startService({ source: provider.url, directory });
  try {
    const created = await post(`${service.url}/deliveries`);
    assert.equal(created.status, 201);
    const delivery = created.body;
    assert.equal(delivery.status, 'complete');
    assert.deepEqual(delivery.entries.map(entry => entry.deliveryPath), ['//delivery/core/a.txt']);
    assert.equal(delivery.entries[0].depotFile, '//design/core/a.txt');
    assert.equal(delivery.entries[0].revision, 1);
    assert.deepEqual(delivery.history[0].excluded, ['//design/private/b.txt']);
    const collected = await fetch(`${service.url}/objects/${delivery.entries[0].digest}`);
    assert.equal(await collected.text(), 'A');

    const moved = await post(`${service.url}/deliveries/${delivery.id}/changes`, { path: '/changes/11' });
    assert.equal(moved.body.delivery.status, 'complete');
    assert.equal(moved.body.viewStale, false);
    const moveEffect = moved.body.effects.find(effect => effect.type === 'move');
    assert.equal(moveEffect.cause, 'depot');
    assert.equal(moveEffect.from.deliveryPath, '//delivery/core/a.txt');
    assert.equal(moveEffect.to.deliveryPath, '//delivery/core/renamed.txt');
    assert.equal(moved.body.effects.filter(effect => effect.type === 'remove').length, 0);
    assert.deepEqual(moved.body.delivery.moves.map(move => [move.from, move.to, move.change]),
      [['//design/core/a.txt', '//design/core/renamed.txt', 11]]);
    assert.deepEqual(moved.body.delivery.entries.map(entry => [entry.deliveryPath, entry.depotFile]),
      [['//delivery/core/renamed.txt', '//design/core/renamed.txt']]);

    const added = await post(`${service.url}/deliveries/${delivery.id}/changes`, { path: '/changes/12' });
    assert.equal(added.body.delivery.entries.length, 2);
    const addEffect = added.body.effects.find(effect => effect.type === 'add');
    assert.equal(addEffect.cause, 'depot');
    assert.equal(addEffect.deliveryPath, '//delivery/other/renamed.txt');

    const irrelevant = await post(`${service.url}/deliveries/${delivery.id}/changes`, { path: '/changes/13' });
    assert.deepEqual(irrelevant.body.skipped, ['//design/private/b.txt']);
    assert.equal(irrelevant.body.effects.length, 0);
    assert.equal(irrelevant.body.delivery.entries.length, 2);
    assert.equal(irrelevant.body.delivery.change, 13);

    // 供应商侧切换视图（阶段 1），产品不自行切换。
    await post(`${provider.url}/_phase`, { phase: 1 });
    const refreshed = await post(`${service.url}/deliveries/${delivery.id}/refresh`);
    assert.equal(refreshed.body.viewChanged, true);
    assert.equal(refreshed.body.delivery.status, 'collision');
    assert.equal(refreshed.body.delivery.entries.length, 0);
    assert.ok(refreshed.body.effects.every(effect => effect.cause === 'view'));
    assert.deepEqual(refreshed.body.effects.filter(effect => effect.type === 'remove')
      .map(effect => effect.deliveryPath).sort(),
      ['//delivery/core/renamed.txt', '//delivery/other/renamed.txt']);
    const collision = refreshed.body.delivery.collisions[0];
    assert.equal(collision.deliveryPath, '//delivery/releases/renamed.txt');
    assert.deepEqual(collision.candidates.map(candidate => candidate.depotFile).sort(),
      ['//design/core/renamed.txt', '//design/other/renamed.txt']);
    const bodies = await Promise.all(collision.candidates.map(async candidate =>
      (await fetch(`${service.url}/objects/${candidate.digest}`)).text()));
    assert.deepEqual(bodies.sort(), ['A', 'DIFFERENT']);

    const reopened = await new Store(directory).initialize();
    const restored = await reopened.getDelivery(delivery.id);
    assert.equal(restored.status, 'collision');
    assert.equal(restored.moves.length, 1);
    assert.deepEqual(restored.history.map(event => event.type),
      ['collect', 'changelist', 'changelist', 'changelist', 'view']);
    assert.equal(restored.view.version, 2);

    const listed = await (await fetch(`${service.url}/deliveries`)).json();
    assert.deepEqual(listed.map(item => item.id), [delivery.id]);
    assert.equal(listed[0].collisions, 1);
  } finally { await service.close(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
});

test('交付边界：未知交付 404、缺路径 422、视图未变 refresh 为空操作', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'delivery-test-'));
  const provider = await startProvider();
  const service = await startService({ source: provider.url, directory });
  try {
    assert.equal((await fetch(`${service.url}/deliveries/nope`)).status, 404);
    assert.equal((await post(`${service.url}/deliveries/nope/changes`, { path: '/changes/11' })).status, 404);
    assert.equal((await post(`${service.url}/deliveries/nope/refresh`)).status, 404);
    const created = await post(`${service.url}/deliveries`);
    assert.equal((await post(`${service.url}/deliveries/${created.body.id}/changes`, {})).status, 422);
    assert.equal((await post(`${service.url}/deliveries/${created.body.id}/changes`,
      { path: 'https://example.invalid/foreign' })).status, 422);
    assert.equal((await post(`${service.url}/deliveries/${created.body.id}/changes`,
      { path: '/missing' })).status, 422);
    const unchanged = await post(`${service.url}/deliveries/${created.body.id}/refresh`);
    assert.equal(unchanged.body.viewChanged, false);
    assert.equal(unchanged.body.effects.length, 0);
    assert.equal((await new Store(directory).getDelivery(created.body.id)).history.length, 1);
    await post(`${provider.url}/_phase`, { phase: 1 });
    const stale = await post(`${service.url}/deliveries/${created.body.id}/changes`, { path: '/changes/11' });
    assert.equal(stale.body.viewStale, true);
    assert.equal(stale.body.delivery.view.version, 1);
    const caught = await post(`${service.url}/deliveries/${created.body.id}/refresh`);
    assert.equal(caught.body.viewChanged, true);
    assert.equal(caught.body.delivery.view.version, 2);
  } finally { await service.close(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
});
