import test from 'node:test';
import assert from 'node:assert/strict';
import { compileView, resolveFile, projectView, pairMoves, explainViewChange } from '../src/view.mjs';

const id = (depotFile, revision, extra = {}) => ({ depotFile, revision, digest: null, ...extra });

test('通配映射依序替换，... 跨片段而 * 仅限单层', () => {
  const rules = compileView(['//design/... //delivery/...']);
  assert.equal(resolveFile(rules, '//design/core/a.txt').candidates[0].deliveryPath,
    '//delivery/core/a.txt');
  const star = compileView(['//design/*/a.txt //delivery/*/a.txt']);
  assert.equal(resolveFile(star, '//design/core/a.txt').included, true);
  assert.equal(resolveFile(star, '//design/nested/core/a.txt').included, false);
});

test('排除行清空先前命中，后续包含行可重新纳入（映射顺序优先）', () => {
  const rules = compileView([
    '//design/... //delivery/...',
    '-//design/private/... //delivery/private/...',
    '//design/private/open/... //delivery/opened/...',
  ]);
  assert.equal(resolveFile(rules, '//design/private/b.txt').included, false);
  const reopened = resolveFile(rules, '//design/private/open/c.txt');
  assert.equal(reopened.included, true);
  assert.equal(reopened.candidates[0].deliveryPath, '//delivery/opened/c.txt');
});

test('普通后续命中替换先前目标，覆盖行叠加多来源', () => {
  const rules = compileView([
    '//design/core/... //delivery/core/...',
    '//design/core/... //delivery/renamed/...',
    '+//design/other/... //delivery/renamed/...',
  ]);
  const replaced = resolveFile(rules, '//design/core/a.txt');
  assert.deepEqual(replaced.candidates.map(c => c.deliveryPath), ['//delivery/renamed/a.txt']);
  const overlay = resolveFile(rules, '//design/other/a.txt');
  assert.deepEqual(overlay.candidates.map(c => c.deliveryPath), ['//delivery/renamed/a.txt']);
});

test('同交付路径不同内容报告碰撞，不挑选赢家', () => {
  const rules = compileView([
    '//design/core/... //delivery/...',
    '+//design/other/... //delivery/...',
  ]);
  const result = projectView({
    rules,
    identities: [id('//design/core/renamed.txt', 1), id('//design/other/renamed.txt', 1)],
    contentOf: (file) => file === '//design/core/renamed.txt' ? 'A' : 'DIFFERENT',
  });
  assert.equal(result.entries.length, 0);
  assert.equal(result.collisions.length, 1);
  assert.equal(result.collisions[0].reason, 'mapping_collision');
  assert.deepEqual(result.collisions[0].candidates.map(c => c.fingerprint).sort(),
    ['A', 'DIFFERENT'].sort());
});

test('同交付路径同内容的多来源作为别名保留，不构成碰撞', () => {
  const rules = compileView([
    '//design/core/... //delivery/...',
    '+//design/other/... //delivery/...',
  ]);
  const result = projectView({
    rules,
    identities: [id('//design/core/a.txt', 1), id('//design/other/a.txt', 1)],
    contentOf: () => 'A',
  });
  assert.equal(result.collisions.length, 0);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].sources.length, 2);
});

test('被排除身份单列并保留命中行证据，视图排除不等于 depot 删除', () => {
  const rules = compileView([
    '//design/... //delivery/...',
    '-//design/private/... //delivery/private/...',
  ]);
  const result = projectView({ rules, identities: [id('//design/private/b.txt', 1)], contentOf: () => 'B' });
  assert.equal(result.entries.length, 0);
  assert.equal(result.excluded[0].reason, 'excluded_by_view');
  assert.ok(result.excluded[0].hits.some(hit => hit.mode === 'exclude'));
});

test('移动对按双向 movedFile 配对，无法配对的保持可见', () => {
  const ok = pairMoves([
    { depotFile: '//d/a.txt', rev: 2, action: 'move/delete', movedFile: '//d/b.txt' },
    { depotFile: '//d/b.txt', rev: 1, action: 'move/add', movedFile: '//d/a.txt' },
  ]);
  assert.equal(ok.pairs.length, 1);
  assert.equal(ok.unpaired.length, 0);
  const broken = pairMoves([
    { depotFile: '//d/a.txt', rev: 2, action: 'move/delete', movedFile: '//d/b.txt' },
  ]);
  assert.equal(broken.pairs.length, 0);
  assert.equal(broken.unpaired[0].endpoint, 'move/delete');
});

test('视图解释区分路径移动、重新纳入/排除与源修订变化', () => {
  const explanation = explainViewChange({
    before: [
      { depotFile: '//d/a.txt', revision: 1, included: true, deliveryPath: '//delivery/old/a.txt' },
      { depotFile: '//d/gone.txt', revision: 1, included: true, deliveryPath: '//delivery/gone.txt' },
      { depotFile: '//d/keep-out.txt', revision: 1, included: false, deliveryPath: null },
      { depotFile: '//d/same.txt', revision: 1, included: true, deliveryPath: '//delivery/same.txt' },
    ],
    after: [
      { depotFile: '//d/a.txt', revision: 1, included: true, deliveryPath: '//delivery/new/a.txt' },
      { depotFile: '//d/new.txt', revision: 1, included: true, deliveryPath: '//delivery/new.txt' },
      { depotFile: '//d/keep-out.txt', revision: 1, included: false, deliveryPath: null },
      { depotFile: '//d/same.txt', revision: 1, included: true, deliveryPath: '//delivery/same.txt' },
    ],
    sourceDriven: { changes: [{ depotFile: '//d/source.txt', kind: 'revision_changed' }] },
  });
  assert.deepEqual(explanation.viewDriven.pathMoved.map(item => item.fromPath), ['//delivery/old/a.txt']);
  assert.deepEqual(explanation.viewDriven.viewExcluded.map(item => item.depotFile), ['//d/gone.txt']);
  assert.deepEqual(explanation.viewDriven.viewIncluded.map(item => item.depotFile), ['//d/new.txt']);
  assert.deepEqual(explanation.viewDriven.unchangedExcluded.map(item => item.depotFile), ['//d/keep-out.txt']);
  assert.equal(explanation.sourceDriven.changes[0].kind, 'revision_changed');
});

test('非法视图行被拒绝：跨域映射、通配数不一致、空视图', () => {
  assert.throws(() => compileView(['/local/path //delivery/x']), /view_mapping_scope/);
  assert.throws(() => compileView(['//design/... //delivery/releases']), /view_wildcard_count/);
  assert.throws(() => compileView([]), /view_empty/);
});
