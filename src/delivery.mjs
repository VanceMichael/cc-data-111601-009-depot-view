import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { acquire } from './transport.mjs';
import { inspect, inspectView, inspectChange, inspectContentIndex, parseContentIdentity } from './reader.mjs';
import { compileView, projectView, resolveFile, pairMoves, explainViewChange } from './view.mjs';

const keyOf = (depotFile, revision) => `${depotFile}#${revision}`;
const digestOf = text => createHash('sha256').update(Buffer.from(text)).digest('hex');

// 组装含排除项与碰撞候选的完整身份快照，供视图切换解释。
function buildSnapshot(entries, excluded, collisions) {
  const snapshot = [
    ...entries.map(entry => ({ depotFile: entry.depotFile, revision: entry.revision,
      included: true, deliveryPath: entry.deliveryPath })),
    ...excluded.map(item => ({ depotFile: item.depotFile, revision: item.revision,
      included: false, deliveryPath: null })),
  ];
  for (const collision of collisions) {
    for (const candidate of collision.candidates) {
      snapshot.push({ depotFile: candidate.depotFile, revision: candidate.revision,
        included: true, deliveryPath: collision.deliveryPath });
    }
  }
  return snapshot;
}

async function fetchParsed(source, route, parser) {
  const result = await acquire(source, route);
  return { bytes: result.bytes, parsed: parser(result.bytes), href: new URL(route, source).href };
}

// 内容索引中存在主修订表之外的 depot 身份。
// overlayOnly=true：仅 + 覆盖行带来的额外身份可随领取/跟进进入交付（普通 include 不引入超前修订）；
// overlayOnly=false：视图刷新时把所有可见身份纳入核对，以便发现同交付路径碰撞。
function contentExtras(rules, contentIndex, known, overlayOnly) {
  const extras = [];
  for (const key of Object.keys(contentIndex)) {
    const identity = parseContentIdentity(key);
    if (known.has(keyOf(identity.depotFile, identity.revision))) continue;
    const resolution = resolveFile(rules, identity.depotFile);
    if (!resolution.included) continue;
    const modes = new Set(resolution.candidates.map(candidate => rules[candidate.index].mode));
    if (overlayOnly && !modes.has('overlay')) continue;
    extras.push({ depotFile: identity.depotFile, revision: identity.revision,
      action: null, change: null, digest: null,
      source: 'content-index', matchedBy: [...modes].join('+') });
  }
  return extras;
}

export class DeliveryService {
  constructor({ source, store }) {
    this.source = source;
    this.store = store;
  }

  async loadRoutes() {
    const catalog = JSON.parse((await acquire(this.source, '/catalog')).bytes.toString('utf8'));
    if (!catalog.entry || !catalog.view || !catalog.contents || !Array.isArray(catalog.changes)) {
      throw new Error('catalog_routes');
    }
    return catalog;
  }

  // 基于视图领取一份客户交付：身份、交付路径、移动关系分开记录。
  async intake({ name } = {}) {
    const routes = await this.loadRoutes();
    const [primaryDoc, viewDoc, contentDoc] = await Promise.all([
      fetchParsed(this.source, routes.entry, inspect),
      fetchParsed(this.source, routes.view, inspectView),
      fetchParsed(this.source, routes.contents, inspectContentIndex),
    ]);
    const contentIndex = contentDoc.parsed;
    const rules = compileView(viewDoc.parsed.lines);
    const live = primaryDoc.parsed.files
      .filter(file => file.action !== 'delete' && file.action !== 'move/delete')
      .map(file => ({ ...file, source: 'primary' }));
    const known = new Set(live.map(file => keyOf(file.depotFile, file.revision)));
    const identities = [...live, ...contentExtras(rules, contentIndex, known, true)];
    const projection = projectView({ rules, identities,
      contentOf: (depotFile, revision) => contentIndex[keyOf(depotFile, revision)] ?? null });

    const now = new Date().toISOString();
    const delivery = {
      id: randomUUID(),
      name: name ?? viewDoc.parsed.client,
      source: this.source,
      routes,
      client: viewDoc.parsed.client,
      view: { version: viewDoc.parsed.version, lines: viewDoc.parsed.lines },
      basis: { change: primaryDoc.parsed.change, viewVersion: viewDoc.parsed.version,
        primarySource: primaryDoc.href, viewSource: viewDoc.href, contentSource: contentDoc.href },
      ledger: identities.map(file => ({ depotFile: file.depotFile, revision: file.revision,
        action: file.action, change: file.change, supplierDigest: file.digest ?? null,
        source: file.source, alive: true, replacedBy: null })),
      entries: [],
      excluded: projection.excluded,
      collisions: [],
      moves: [],
      skipped: [],
      history: [],
      status: 'ready',
      createdAt: now,
      updatedAt: now,
    };
    await this.#materialize(delivery, projection, contentIndex, rules);
    delivery.history.push({ at: now, event: 'intake',
      change: primaryDoc.parsed.change, viewVersion: viewDoc.parsed.version,
      status: delivery.status, collisionCount: delivery.collisions.length });
    await this.store.saveDelivery(delivery);
    return delivery;
  }

  // 保存无碰撞条目的内容字节；碰撞只登记候选与各自摘要，绝不选一个赢家覆盖。
  async #materialize(delivery, projection, contentIndex, rules) {
    delivery.collisions = projection.collisions.map(collision => ({
      ...collision,
      candidates: collision.candidates.map(candidate => {
        if (candidate.fingerprint !== undefined) {
          return { ...candidate, contentDigest: digestOf(candidate.fingerprint) };
        }
        const content = contentIndex[keyOf(candidate.depotFile, candidate.revision)];
        return { ...candidate, contentDigest: content === undefined ? null : digestOf(content) };
      }),
    }));
    delivery.entries = [];
    for (const entry of projection.entries) {
      const content = contentIndex[keyOf(entry.depotFile, entry.revision)];
      if (content === undefined) {
        delivery.collisions.push({ reason: 'content_undetermined', deliveryPath: entry.deliveryPath,
          candidates: [{ depotFile: entry.depotFile, revision: entry.revision }] });
        continue;
      }
      const contentDigest = await this.store.saveContent(Buffer.from(content));
      delivery.entries.push({ ...entry, contentDigest });
    }
    delivery.excluded = projection.excluded;
    delivery.status = delivery.collisions.length > 0 ? 'blocked' : 'ready';
    delivery.view = { version: delivery.view.version, lines: rules.map(rule => rule.line) };
  }

  // 跟进 changelist：只处理与本交付相关的文件，移动配对关系独立于路径记录。
  async followChange(id, changeRoute) {
    const delivery = await this.store.getDelivery(id);
    if (delivery.status === 'blocked') throw new Error('delivery_blocked');
    if (!delivery.routes.changes.includes(changeRoute)) throw new Error('change_route_unknown');
    const [changeDoc, contentDoc] = await Promise.all([
      fetchParsed(this.source, changeRoute, inspectChange),
      fetchParsed(this.source, delivery.routes.contents, inspectContentIndex),
    ]);
    const change = changeDoc.parsed;
    const contentIndex = contentDoc.parsed;
    const { pairs, unpaired } = pairMoves(change.files);
    if (unpaired.length > 0) throw new Error('change_unpaired_move');

    const rules = compileView(delivery.view.lines);
    const now = new Date().toISOString();
    const moves = [];
    const skipped = [];

    for (const pair of pairs) {
      const fromPath = this.#pathOf(rules, pair.from.depotFile);
      const toPath = this.#pathOf(rules, pair.to.depotFile);
      moves.push({ change: change.change,
        from: { depotFile: pair.from.depotFile, revision: pair.from.revision, deliveryPath: fromPath, included: fromPath !== null },
        to: { depotFile: pair.to.depotFile, revision: pair.to.revision, deliveryPath: toPath, included: toPath !== null } });
      if (fromPath === null && toPath === null) {
        skipped.push({ reason: 'outside_view', change: change.change,
          depotFile: pair.from.depotFile, revision: pair.from.revision, action: pair.from.action });
        continue;
      }
      this.#retire(delivery, pair.from.depotFile, pair.from.revision, keyOf(pair.to.depotFile, pair.to.revision));
      this.#ensureIdentity(delivery, pair.to, 'change');
    }
    for (const file of change.files.filter(item => !item.action.startsWith('move/'))) {
      const included = this.#pathOf(rules, file.depotFile) !== null;
      if (!included) {
        skipped.push({ reason: 'outside_view', change: change.change,
          depotFile: file.depotFile, revision: file.revision, action: file.action });
        continue;
      }
      if (file.action === 'delete') this.#retire(delivery, file.depotFile, file.revision, null);
      else this.#ensureIdentity(delivery, file, 'change');
    }

    const live = delivery.ledger.filter(item => item.alive)
      .map(({ depotFile, revision, action, change: sourceChange, digest, supplierDigest }) =>
        ({ depotFile, revision, action, change: sourceChange, digest: digest ?? supplierDigest }));
    const known = new Set(live.map(file => keyOf(file.depotFile, file.revision)));
    const identities = [...live, ...contentExtras(rules, contentIndex, known, true)];
    const projection = projectView({ rules, identities,
      contentOf: (depotFile, revision) => contentIndex[keyOf(depotFile, revision)] ?? null });
    await this.#materialize(delivery, projection, contentIndex, rules);
    delivery.moves.push(...moves);
    delivery.skipped.push(...skipped);
    delivery.basis.change = change.change;
    delivery.updatedAt = now;
    delivery.history.push({ at: now, event: 'follow_change', route: changeRoute, change: change.change,
      moves: moves.length, skipped: skipped.length, status: delivery.status,
      collisionCount: delivery.collisions.length });
    await this.store.saveDelivery(delivery);
    return delivery;
  }

  // 切换/刷新视图：解释哪些变化来自视图本身，区分供应商源修订变化。
  async refreshView(id) {
    const delivery = await this.store.getDelivery(id);
    const [viewDoc, primaryDoc, contentDoc] = await Promise.all([
      fetchParsed(this.source, delivery.routes.view, inspectView),
      fetchParsed(this.source, delivery.routes.entry, inspect),
      fetchParsed(this.source, delivery.routes.contents, inspectContentIndex),
    ]);
    if (viewDoc.parsed.version === delivery.view.version
      && JSON.stringify(viewDoc.parsed.lines) === JSON.stringify(delivery.view.lines)) {
      return { changed: false, delivery };
    }
    const contentIndex = contentDoc.parsed;
    const rules = compileView(viewDoc.parsed.lines);
    const sourceDriven = this.#sourceDriven(delivery, primaryDoc.parsed);
    const live = delivery.ledger.filter(item => item.alive)
      .map(({ depotFile, revision, action, change, supplierDigest }) =>
        ({ depotFile, revision, action, change, digest: supplierDigest }));
    const known = new Set(live.map(file => keyOf(file.depotFile, file.revision)));
    const identities = [...live, ...contentExtras(rules, contentIndex, known, false)];
    const projection = projectView({ rules, identities,
      contentOf: (depotFile, revision) => contentIndex[keyOf(depotFile, revision)] ?? null });

    const beforeSnapshot = buildSnapshot(delivery.entries, delivery.excluded, delivery.collisions);
    const previousView = { ...delivery.view };
    const now = new Date().toISOString();
    delivery.view = { version: viewDoc.parsed.version, lines: viewDoc.parsed.lines };
    delivery.basis.viewVersion = viewDoc.parsed.version;
    await this.#materialize(delivery, projection, contentIndex, rules);
    const afterSnapshot = buildSnapshot(delivery.entries, delivery.excluded, delivery.collisions);
    const explanation = explainViewChange({ before: beforeSnapshot, after: afterSnapshot, sourceDriven });
    explanation.previousViewVersion = previousView.version;
    explanation.viewVersion = viewDoc.parsed.version;
    delivery.lastExplanation = explanation;
    delivery.updatedAt = now;
    delivery.history.push({ at: now, event: 'refresh_view',
      fromVersion: previousView.version, toVersion: viewDoc.parsed.version,
      status: delivery.status, collisionCount: delivery.collisions.length,
      viewDriven: explanation.viewDriven, sourceDriven });
    await this.store.saveDelivery(delivery);
    return { changed: true, explanation, delivery };
  }

  #pathOf(rules, depotPath) {
    const resolution = resolveFile(rules, depotPath);
    return resolution.included ? resolution.candidates[0].deliveryPath : null;
  }

  #retire(delivery, depotFile, revision, replacedBy) {
    const exact = delivery.ledger.find(entry => entry.depotFile === depotFile && entry.revision === revision);
    if (exact) { exact.alive = false; exact.replacedBy = replacedBy; return; }
    // changelist 可能给出更新修订号；按 depot 路径退役交付中实际存活的身份并保留替换链。
    for (const entry of delivery.ledger) {
      if (entry.depotFile === depotFile && entry.alive) {
        entry.alive = false;
        entry.replacedBy = replacedBy;
      }
    }
  }

  #ensureIdentity(delivery, file, source) {
    const existing = delivery.ledger.find(entry => entry.depotFile === file.depotFile && entry.revision === file.revision);
    if (existing) { existing.alive = true; return; }
    delivery.ledger.push({ depotFile: file.depotFile, revision: file.revision, action: file.action,
      change: file.change, supplierDigest: file.digest ?? null, source, alive: true, replacedBy: null });
  }

  #sourceDriven(delivery, primary) {
    const changes = [];
    for (const file of primary.files) {
      const known = delivery.ledger.find(entry => entry.depotFile === file.depotFile);
      if (!known) {
        changes.push({ depotFile: file.depotFile, kind: 'not_in_delivery', sourceRevision: file.revision });
      } else if (known.revision !== file.revision) {
        changes.push({ depotFile: file.depotFile, kind: 'revision_changed',
          deliveryRevision: known.revision, sourceRevision: file.revision, alive: known.alive });
      }
    }
    return { primaryChange: primary.change, deliveryChange: delivery.basis.change, changes };
  }
}
