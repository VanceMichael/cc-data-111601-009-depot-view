import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startProvider } from '../src/provider.mjs';
import { startService } from '../src/service.mjs';
import { Store } from '../src/store.mjs';

async function setPhase(provider, phase) {
  const response = await fetch(`${provider.url}/_phase`, { method: 'POST', body: JSON.stringify({ phase }) });
  assert.equal(response.status, 200);
}

async function withHarness(run) {
  const directory = await mkdtemp(join(tmpdir(), 'delivery-test-'));
  const provider = await startProvider();
  const service = await startService({ source: provider.url, directory });
  try { await run({ provider, service, directory }); }
  finally { await service.close(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
}

test('阶段0：按视图领取交付，身份/路径/排除分开记录', async () => {
  await withHarness(async ({ service }) => {
    const response = await fetch(`${service.url}/deliveries`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
    assert.equal(response.status, 201);
    const delivery = await response.json();
    assert.equal(delivery.status, 'ready');
    assert.equal(delivery.view.version, 1);
    assert.deepEqual(delivery.entries.map(entry => entry.deliveryPath), ['//delivery/core/a.txt']);
    const entry = delivery.entries[0];
    // depot 修订身份与交付路径是两个独立字段
    assert.equal(entry.depotFile, '//design/core/a.txt');
    assert.equal(entry.revision, 1);
    assert.match(entry.contentDigest, /^[a-f0-9]{64}$/);
    assert.ok(entry.sources.some(source => source.ruleIndex === 0 && source.mode === 'include'));
    // 被视图排除的文件保留为可核对的排除证据，不进交付条目
    assert.equal(delivery.excluded.length, 1);
    assert.equal(delivery.excluded[0].depotFile, '//design/private/b.txt');
    // 台账保留全部 depot 修订身份（含被排除者）
    assert.deepEqual(delivery.ledger.map(item => item.depotFile).sort(),
      ['//design/core/a.txt', '//design/private/b.txt']);
    // 交付字节可按内容摘要取回
    const bytes = await (await fetch(`${service.url}/delivery-objects/${entry.contentDigest}`)).arrayBuffer();
    assert.equal(Buffer.from(bytes).toString(), 'A');
  });
});

test('跟进 changelist 11：移动配对记录、旧路径退役、只处理本交付相关文件', async () => {
  await withHarness(async ({ service }) => {
    const created = await (await fetch(`${service.url}/deliveries`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: '{}' })).json();
    const response = await fetch(`${service.url}/deliveries/${created.id}/changes`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ route: '/changes/11' }) });
    assert.equal(response.status, 200);
    const delivery = await response.json();
    assert.equal(delivery.moves.length, 1);
    const move = delivery.moves[0];
    assert.equal(move.from.depotFile, '//design/core/a.txt');
    assert.equal(move.from.deliveryPath, '//delivery/core/a.txt');
    assert.equal(move.to.depotFile, '//design/core/renamed.txt');
    assert.equal(move.to.deliveryPath, '//delivery/core/renamed.txt');
    assert.deepEqual(delivery.entries.map(entry => entry.deliveryPath), ['//delivery/core/renamed.txt']);
    // 旧身份退役并保留替换关系，而非删除+新建丢失链路
    const retired = delivery.ledger.find(item => item.depotFile === '//design/core/a.txt');
    assert.equal(retired.alive, false);
    assert.equal(retired.replacedBy, '//design/core/renamed.txt#1');
    const renamed = delivery.ledger.find(item => item.depotFile === '//design/core/renamed.txt');
    assert.equal(renamed.alive, true);
    // 历史只出现本交付的事件
    assert.deepEqual(delivery.history.map(event => event.event), ['intake', 'follow_change']);
  });
});

test('切换到阶段1视图：解释为视图驱动变化，源文件未被供应商修改', async () => {
  await withHarness(async ({ provider, service }) => {
    const created = await (await fetch(`${service.url}/deliveries`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: '{}' })).json();
    await setPhase(provider, 1);
    const response = await fetch(`${service.url}/deliveries/${created.id}/refresh`, { method: 'POST' });
    assert.equal(response.status, 409);
    const outcome = await response.json();
    assert.equal(outcome.changed, true);
    assert.equal(outcome.explanation.previousViewVersion, 1);
    assert.equal(outcome.explanation.viewVersion, 2);
    const { pathMoved, viewExcluded, viewIncluded, unchangedExcluded } = outcome.explanation.viewDriven;
    assert.deepEqual(pathMoved.map(item => [item.fromPath, item.toPath]),
      [['//delivery/core/a.txt', '//delivery/releases/a.txt']]);
    assert.deepEqual(viewExcluded, []);
    // b.txt 在两个视图中都被排除：属于持续排除，而非本次视图新排除
    assert.deepEqual(unchangedExcluded.map(item => item.depotFile), ['//design/private/b.txt']);
    // 内容索引中被新视图纳入的身份（含碰撞双方）都登记为视图纳入
    assert.deepEqual(viewIncluded.map(item => item.depotFile).sort(),
      ['//design/core/renamed.txt', '//design/other/renamed.txt']);
    // 源修订没有变化：供应商没有修改源文件，变化全部来自视图
    assert.equal(outcome.explanation.sourceDriven.changes.length, 0);
    const delivery = outcome.delivery;
    assert.equal(delivery.status, 'blocked');
    assert.equal(delivery.collisions.length, 1);
    const collision = delivery.collisions[0];
    assert.equal(collision.reason, 'mapping_collision');
    assert.equal(collision.deliveryPath, '//delivery/releases/renamed.txt');
    assert.deepEqual(collision.candidates.map(candidate => candidate.depotFile).sort(),
      ['//design/core/renamed.txt', '//design/other/renamed.txt']);
    // 碰撞路径没有任何一个候选被写成赢家；无碰撞条目仍正常落盘
    assert.deepEqual(delivery.entries.map(entry => entry.deliveryPath),
      ['//delivery/releases/a.txt']);
  });
});

test('碰撞状态下的交付持久可查，且拒绝继续跟进直到可核对', async () => {
  await withHarness(async ({ provider, service }) => {
    const created = await (await fetch(`${service.url}/deliveries`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: '{}' })).json();
    await setPhase(provider, 1);
    const refreshed = await (await fetch(`${service.url}/deliveries/${created.id}/refresh`,
      { method: 'POST' })).json();
    assert.equal(refreshed.delivery.status, 'blocked');
    const listed = await (await fetch(`${service.url}/deliveries`)).json();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].collisions.length, 1);
    const follow = await fetch(`${service.url}/deliveries/${created.id}/changes`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ route: '/changes/11' }) });
    assert.equal(follow.status, 422);
    assert.match((await follow.json()).error, /delivery_blocked/);
    // 切回阶段0视图后碰撞解除，恢复可跟进
    await setPhase(provider, 0);
    const restored = await (await fetch(`${service.url}/deliveries/${created.id}/refresh`,
      { method: 'POST' })).json();
    assert.equal(restored.delivery.status, 'ready');
    assert.equal(restored.delivery.collisions.length, 0);
  });
});

test('持久重开与边界：未知交付 404、未知 change 路由拒绝、GET 不产生写入', async () => {
  await withHarness(async ({ service, directory }) => {
    const created = await (await fetch(`${service.url}/deliveries`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: '{}' })).json();
    // 重新打开存储目录，交付记录仍可完整查询
    const freshStore = new Store(directory);
    await freshStore.initialize();
    const persisted = await freshStore.getDelivery(created.id);
    assert.equal(persisted.id, created.id);
    assert.equal((await freshStore.listDeliveries()).length, 1);
    const missing = await fetch(`${service.url}/deliveries/nope`);
    assert.equal(missing.status, 404);
    const badRoute = await fetch(`${service.url}/deliveries/${created.id}/changes`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ route: '/changes/999' }) });
    assert.equal(badRoute.status, 422);
    assert.match((await badRoute.json()).error, /change_route_unknown/);
    const before = await (await fetch(`${service.url}/deliveries`)).json();
    await fetch(`${service.url}/deliveries/${created.id}`);
    const after = await (await fetch(`${service.url}/deliveries`)).json();
    assert.equal(after[0].updatedAt, before[0].updatedAt);
  });
});

test('原始 raw 收件接口保持兼容，与交付存储互相独立', async () => {
  await withHarness(async ({ service, directory }) => {
    const intake = await fetch(`${service.url}/intakes`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: '/primary' }) });
    assert.equal(intake.status, 201);
    const raw = await intake.json();
    const record = await (await fetch(`${service.url}/records`)).json();
    assert.equal(record.length, 1);
    assert.deepEqual(Buffer.from(await (await fetch(`${service.url}/objects/${raw.digest}`)).arrayBuffer()),
      await readFile(new URL('../fixtures/primary.bin', import.meta.url)));
    const store = new Store(directory);
    await store.initialize();
    assert.equal((await store.listDeliveries()).length, 0);
  });
});
