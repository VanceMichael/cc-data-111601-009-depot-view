import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inspect, inspectView, inspectChange, parseViewLine } from '../src/reader.mjs';
import { compileView, projectPath, projectRevisions } from '../src/view.mjs';
import { applyChangelist } from '../src/courier.mjs';
const primary=await readFile(new URL('../fixtures/primary.bin',import.meta.url));
const manifest=JSON.parse(await readFile(new URL('../fixtures/upstream.json',import.meta.url),'utf8'));
async function resource(path) {
  const item=manifest.resources[path];
  return item.file ? readFile(new URL(`../fixtures/${item.file}`,import.meta.url)) : Buffer.from(item.body);
}

test('原修订身份不等于交付工作区路径',()=>{
  const result=inspect(primary);assert.equal(result.files[0].depotFile,'//design/core/a.txt');assert.equal(result.files[0].revision,1);
});
test('排除和覆盖语法可读，移动对有两个端点',async()=>{
  assert.equal(parseViewLine('-//design/private/... //delivery/private/...').mode,'exclude');
  assert.equal(parseViewLine('+//design/... //delivery/...').mode,'overlay');
  const change=JSON.parse(await resource('/changes/11'));assert.equal(change.files.length,2);
  assert.equal(change.files[0].action,'move/delete');assert.equal(change.files[1].action,'move/add');
});
test('非法 depot 身份和视图对拒绝',()=>{
  assert.throws(()=>inspect(Buffer.from('{"files":[{"depotFile":"local","rev":1}]}')));
  assert.throws(()=>parseViewLine('missing-target'));
});
test('视图映射遵守顺序：普通命中替换先前目标，排除清空，覆盖保留多个来源',()=>{
  const mappings=compileView(['//design/... //delivery/...','-//design/private/... //delivery/private/...']);
  assert.deepEqual(projectPath(mappings,'//design/core/a.txt'),['//delivery/core/a.txt']);
  assert.deepEqual(projectPath(mappings,'//design/private/b.txt'),[]);
  const overlay=compileView(['//design/core/... //delivery/releases/...','+//design/other/... //delivery/releases/...']);
  assert.deepEqual(projectPath(overlay,'//design/other/renamed.txt'),['//delivery/releases/renamed.txt']);
  const doubled=compileView(['//design/... //delivery/a/...','+//design/... //delivery/b/...']);
  assert.deepEqual(projectPath(doubled,'//design/x.txt'),['//delivery/a/x.txt','//delivery/b/x.txt']);
  const replaced=compileView(['+//design/... //delivery/a/...','//design/... //delivery/b/...']);
  assert.deepEqual(projectPath(replaced,'//design/x.txt'),['//delivery/b/x.txt']);
});
test('通配捕获依序替换目标，单层星号不跨段，通配数不一致拒绝',()=>{
  const mappings=compileView(['//design/*/... //delivery/*/...']);
  assert.deepEqual(projectPath(mappings,'//design/core/a/b.txt'),['//delivery/core/a/b.txt']);
  const single=compileView(['//design/* //delivery/*']);
  assert.deepEqual(projectPath(single,'//design/a/b'),[]);
  assert.throws(()=>compileView(['//design/... //delivery/.../...']),/view_wildcard_mismatch/);
  const quoted=compileView(['"//design/my dir/..." //delivery/...']);
  assert.deepEqual(projectPath(quoted,'//design/my dir/f.txt'),['//delivery/f.txt']);
});
test('视图与 changelist 解析校验，未知动作不静默丢弃',async()=>{
  const view=inspectView(await resource('/view'));
  assert.equal(view.version,1);assert.equal(view.client,'delivery');
  assert.throws(()=>inspectView(Buffer.from('{"version":1}')));
  const change=inspectChange(await resource('/changes/11'));
  assert.equal(change.change,11);
  assert.equal(change.files[0].movedFile,'//design/core/renamed.txt');
  assert.equal(change.files[0].change,11);
  assert.throws(()=>inspectChange(Buffer.from('{"change":1,"files":[{"depotFile":"//a/b","rev":1,"action":"obliterate"}]}')));
});
test('changelist 应用把移动配成关系而非删除再新建',async()=>{
  const change=inspectChange(await resource('/changes/11'));
  const {revisions,moves}=applyChangelist({'//design/core/a.txt':{rev:1,change:10}},change.files);
  assert.deepEqual(Object.keys(revisions),['//design/core/renamed.txt']);
  assert.equal(revisions['//design/core/renamed.txt'].rev,1);
  assert.deepEqual(moves,[{from:'//design/core/a.txt',to:'//design/core/renamed.txt',change:11}]);
});
test('投影把 depot 修订身份映射到交付路径，未命中不投递',()=>{
  const mappings=compileView(['//design/... //delivery/...','-//design/private/... //delivery/private/...']);
  const placements=projectRevisions(mappings,{'//design/core/a.txt':{rev:1},'//design/private/b.txt':{rev:1}});
  assert.deepEqual(placements,[{deliveryPath:'//delivery/core/a.txt',depotFile:'//design/core/a.txt',revision:1}]);
});
