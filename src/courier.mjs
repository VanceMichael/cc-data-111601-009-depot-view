import { randomUUID } from 'node:crypto';
import { acquire } from './transport.mjs';
import { inspect, inspectView, inspectChange } from './reader.mjs';
import { compileView, projectPath, projectRevisions } from './view.mjs';

async function fetchParsed(source, path, parse) {
  const result = await acquire(source, path);
  return parse(result.bytes);
}

async function fetchJson(source, path) {
  return fetchParsed(source, path, bytes => JSON.parse(bytes.toString('utf8')));
}

// 把投影落成交付条目：同一交付路径的不同内容属于碰撞，停在可核对状态，不挑赢家。
async function materialize(source, store, contentsPath, placements) {
  const contents = placements.length ? await fetchJson(source, contentsPath) : {};
  const byPath = new Map();
  for (const placement of placements) {
    const key = `${placement.depotFile}#${placement.revision}`;
    if (!Object.hasOwn(contents, key)) throw new Error(`content_missing:${key}`);
    const digest = await store.storeObject(Buffer.from(contents[key], 'utf8'));
    const candidate = { ...placement, digest };
    if (!byPath.has(placement.deliveryPath)) byPath.set(placement.deliveryPath, []);
    byPath.get(placement.deliveryPath).push(candidate);
  }
  const entries = [];
  const collisions = [];
  for (const [deliveryPath, candidates] of [...byPath.entries()].sort()) {
    if (new Set(candidates.map(candidate => candidate.digest)).size > 1) {
      collisions.push({ deliveryPath, candidates: candidates
        .map(({ depotFile, revision, digest }) => ({ depotFile, revision, digest })) });
      continue;
    }
    // 内容一致时不存在冲突；按 depot 路径字典序取确定性的代表，来源全部保留可查。
    const chosen = [...candidates].sort((a, b) => a.depotFile.localeCompare(b.depotFile))[0];
    entries.push({ deliveryPath, depotFile: chosen.depotFile, revision: chosen.revision,
      digest: chosen.digest,
      ...(candidates.length > 1 ? { sources: candidates.map(c => c.depotFile).sort() } : {}) });
  }
  return { entries, collisions };
}

// 应用 changelist 到 depot 修订表；move/delete 与 move/add 配成移动关系，而不是删除再新建。
export function applyChangelist(revisions, files) {
  const next = { ...revisions };
  const moves = [];
  const byPath = new Map(files.map(file => [file.depotFile, file]));
  const consumed = new Set();
  for (const file of files) {
    if (consumed.has(file.depotFile)) continue;
    consumed.add(file.depotFile);
    if (file.action === 'move/delete') {
      const pair = file.movedFile ? byPath.get(file.movedFile) : null;
      if (pair && !consumed.has(pair.depotFile) && pair.action === 'move/add' &&
        pair.movedFile === file.depotFile) {
        consumed.add(pair.depotFile);
        delete next[file.depotFile];
        next[pair.depotFile] = { rev: pair.revision, change: pair.change, sourceDigest: pair.digest };
        moves.push({ from: file.depotFile, to: pair.depotFile, change: pair.change });
      } else {
        delete next[file.depotFile];
      }
    } else if (file.action === 'delete') {
      delete next[file.depotFile];
    } else {
      next[file.depotFile] = { rev: file.revision, change: file.change, sourceDigest: file.digest };
    }
  }
  return { revisions: next, moves };
}

function diffEntries(oldEntries, newEntries, moves, cause) {
  const oldByPath = new Map(oldEntries.map(entry => [entry.deliveryPath, entry]));
  const newByPath = new Map(newEntries.map(entry => [entry.deliveryPath, entry]));
  const removed = [...oldByPath.entries()].filter(([path]) => !newByPath.has(path));
  const added = [...newByPath.entries()].filter(([path]) => !oldByPath.has(path));
  const effects = [];
  const pairedRemoved = new Set();
  const pairedAdded = new Set();
  for (const move of moves) {
    const from = removed.find(([path, entry]) => !pairedRemoved.has(path) && entry.depotFile === move.from);
    const to = added.find(([path, entry]) => !pairedAdded.has(path) && entry.depotFile === move.to);
    if (!from || !to) continue;
    pairedRemoved.add(from[0]);
    pairedAdded.add(to[0]);
    effects.push({ cause, type: 'move',
      from: { deliveryPath: from[0], depotFile: move.from },
      to: { deliveryPath: to[0], depotFile: move.to } });
  }
  for (const [path, entry] of removed) {
    if (!pairedRemoved.has(path)) effects.push({ cause, type: 'remove', deliveryPath: path,
      depotFile: entry.depotFile, revision: entry.revision });
  }
  for (const [path, entry] of added) {
    if (!pairedAdded.has(path)) effects.push({ cause, type: 'add', deliveryPath: path,
      depotFile: entry.depotFile, revision: entry.revision });
  }
  for (const [path, entry] of newByPath) {
    const old = oldByPath.get(path);
    if (old && old.digest !== entry.digest) effects.push({ cause, type: 'content',
      deliveryPath: path, depotFile: entry.depotFile,
      fromRevision: old.revision, toRevision: entry.revision });
  }
  return effects;
}

function collisionEffects(oldCollisions, newCollisions, cause) {
  const oldPaths = new Set(oldCollisions.map(collision => collision.deliveryPath));
  const newPaths = new Set(newCollisions.map(collision => collision.deliveryPath));
  const effects = [];
  for (const collision of newCollisions) {
    if (!oldPaths.has(collision.deliveryPath)) effects.push({ cause, type: 'collision',
      deliveryPath: collision.deliveryPath, candidates: collision.candidates });
  }
  for (const collision of oldCollisions) {
    if (!newPaths.has(collision.deliveryPath)) effects.push({ cause, type: 'collision_resolved',
      deliveryPath: collision.deliveryPath });
  }
  return effects;
}

export async function collectDelivery(source, store, { catalogPath = '/catalog' } = {}) {
  const catalog = await fetchJson(source, catalogPath);
  const paths = { catalog: catalogPath, view: catalog.view ?? '/view',
    entry: catalog.entry ?? '/primary', contents: catalog.contents ?? '/contents' };
  const view = await fetchParsed(source, paths.view, inspectView);
  const table = await fetchParsed(source, paths.entry, inspect);
  const mappings = compileView(view.lines);
  const revisions = {};
  const excluded = [];
  for (const file of table.files) {
    if (projectPath(mappings, file.depotFile).length > 0) {
      revisions[file.depotFile] = { rev: file.revision, change: file.change, sourceDigest: file.digest ?? null };
    } else {
      excluded.push(file.depotFile);
    }
  }
  const { entries, collisions } = await materialize(source, store, paths.contents,
    projectRevisions(mappings, revisions));
  const now = new Date().toISOString();
  const delivery = {
    id: randomUUID(),
    status: collisions.length ? 'collision' : 'complete',
    source,
    createdAt: now,
    updatedAt: now,
    view: { version: view.version, client: view.client, lines: view.lines, path: paths.view },
    paths,
    change: table.change,
    revisions,
    entries,
    moves: [],
    collisions,
    history: [{ seq: 1, type: 'collect', at: now, change: table.change, excluded,
      effects: entries.map(entry => ({ cause: 'baseline', type: 'add',
        deliveryPath: entry.deliveryPath, depotFile: entry.depotFile, revision: entry.revision })) }],
  };
  await store.putDelivery(delivery);
  return delivery;
}

export async function followChangelist(source, store, id, changePath) {
  const delivery = await store.getDelivery(id);
  if (!delivery) return null;
  const change = await fetchParsed(source, changePath, inspectChange);
  const liveView = await fetchParsed(source, delivery.paths.view, inspectView);
  const viewStale = JSON.stringify(liveView.lines) !== JSON.stringify(delivery.view.lines);
  const mappings = compileView(delivery.view.lines);
  // 只处理这份交付相关的内容：两端点任一落入当前视图的移动、或自身落入视图的文件。
  const relevant = file => projectPath(mappings, file.depotFile).length > 0 ||
    (file.movedFile !== null && projectPath(mappings, file.movedFile).length > 0);
  const skipped = change.files.filter(file => !relevant(file)).map(file => file.depotFile);
  const { revisions, moves } = applyChangelist(delivery.revisions, change.files.filter(relevant));
  const { entries, collisions } = await materialize(source, store, delivery.paths.contents,
    projectRevisions(mappings, revisions));
  const effects = diffEntries(delivery.entries, entries, moves, 'depot');
  effects.push(...collisionEffects(delivery.collisions, collisions, 'depot'));
  const recordedMoves = moves.map(move => ({
    ...move,
    deliveryFrom: delivery.entries.find(entry => entry.depotFile === move.from)?.deliveryPath ?? null,
    deliveryTo: entries.find(entry => entry.depotFile === move.to)?.deliveryPath ?? null,
  }));
  const now = new Date().toISOString();
  const updated = { ...delivery,
    status: collisions.length ? 'collision' : 'complete',
    updatedAt: now,
    change: Math.max(delivery.change, change.change),
    revisions,
    entries,
    collisions,
    moves: [...delivery.moves, ...recordedMoves],
    history: [...delivery.history, { seq: delivery.history.length + 1, type: 'changelist',
      at: now, change: change.change, path: changePath, effects, skipped }] };
  await store.putDelivery(updated);
  return { delivery: updated, effects, skipped, viewStale };
}

export async function refreshDelivery(source, store, id) {
  const delivery = await store.getDelivery(id);
  if (!delivery) return null;
  const liveView = await fetchParsed(source, delivery.paths.view, inspectView);
  if (JSON.stringify(liveView.lines) === JSON.stringify(delivery.view.lines)) {
    return { delivery, viewChanged: false, effects: [] };
  }
  // 同一份 depot 修订表重新投影：条目的增减与换路径全部归因于视图，而非供应商改了源文件。
  const mappings = compileView(liveView.lines);
  const { entries, collisions } = await materialize(source, store, delivery.paths.contents,
    projectRevisions(mappings, delivery.revisions));
  const added = entries.filter(entry =>
    !delivery.entries.some(old => old.deliveryPath === entry.deliveryPath));
  const viewMoves = [];
  for (const old of delivery.entries) {
    if (entries.some(entry => entry.deliveryPath === old.deliveryPath)) continue;
    const moved = added.find(entry => entry.depotFile === old.depotFile &&
      entry.revision === old.revision);
    if (moved) viewMoves.push({ from: old.depotFile, to: moved.depotFile, change: delivery.change });
  }
  const effects = diffEntries(delivery.entries, entries, viewMoves, 'view');
  effects.push(...collisionEffects(delivery.collisions, collisions, 'view'));
  const now = new Date().toISOString();
  const updated = { ...delivery,
    status: collisions.length ? 'collision' : 'complete',
    updatedAt: now,
    view: { version: liveView.version, client: liveView.client, lines: liveView.lines,
      path: delivery.paths.view },
    entries,
    collisions,
    history: [...delivery.history, { seq: delivery.history.length + 1, type: 'view',
      at: now, version: liveView.version, effects }] };
  await store.putDelivery(updated);
  return { delivery: updated, viewChanged: true, effects };
}
