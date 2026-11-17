import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inspect, parseViewLine, inspectView, inspectChange, inspectContentIndex, parseContentIdentity } from '../src/reader.mjs';
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
test('视图、changelist 与内容索引解释器保留身份字段',async()=>{
  const view=inspectView(await resource('/view'));
  assert.equal(view.client,'delivery');
  assert.equal(view.lines.length,2);
  const change=inspectChange(await resource('/changes/11'));
  assert.equal(change.change,11);
  assert.equal(change.files[0].movedFile,'//design/core/renamed.txt');
  const index=inspectContentIndex(await resource('/contents'));
  assert.deepEqual(parseContentIdentity('//design/core/a.txt#1'),
    {depotFile:'//design/core/a.txt',revision:1});
  assert.equal(index['//design/core/a.txt#1'],'A');
  assert.throws(()=>inspectContentIndex(Buffer.from('{"bad-key":"x"}')));
});
