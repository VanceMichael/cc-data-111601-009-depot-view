import { parseViewLine } from './reader.mjs';

const WILDCARD = /\.\.\.|\*/g;
const IDENTITY = depotFile => `${depotFile.depotFile}#${depotFile.revision}`;

function countWildcards(text) {
  return text.match(WILDCARD)?.length ?? 0;
}

function buildMatcher(source) {
  let pattern = '';
  for (const character of source) {
    if (character === '*') pattern += '([^/]*)';
    else if (character === '.') pattern += '\\.';
    else if ('\\^$+?()[]{}|'.includes(character)) pattern += `\\${character}`;
    else pattern += character;
  }
  pattern = pattern.replace(/\\\.\\\.\\\./g, '(.*)');
  return new RegExp(`^${pattern}$`);
}

function mapPath(rule, depotPath) {
  const matched = rule.matcher.exec(depotPath);
  if (!matched) return null;
  const captures = matched.slice(1);
  let cursor = 0;
  return rule.target.replace(WILDCARD, () => captures[cursor++]);
}

// 依序编译视图行：模式（include）、排除（-）、覆盖（+），顺序即裁决顺序。
export function compileView(lines) {
  if (!Array.isArray(lines) || lines.length === 0) throw new Error('view_empty');
  return lines.map((line, index) => {
    const parsed = parseViewLine(line);
    const mode = parsed.mode;
    const source = mode === 'include' ? parsed.source : parsed.source.slice(1);
    if (!source.startsWith('//') || !parsed.target.startsWith('//')) throw new Error('view_mapping_scope');
    if (countWildcards(source) !== countWildcards(parsed.target)) throw new Error('view_wildcard_count');
    return { index, line, mode, source, target: parsed.target, matcher: buildMatcher(source) };
  });
}

// 按映射顺序裁决单个 depot 身份；返回全部命中行以便核对，排除会清空此前裁决。
export function resolveFile(rules, depotPath) {
  const hits = [];
  let includeHit = null;
  let overlayHits = [];
  for (const rule of rules) {
    const deliveryPath = mapPath(rule, depotPath);
    if (deliveryPath === null) continue;
    hits.push({ index: rule.index, mode: rule.mode, deliveryPath });
    if (rule.mode === 'exclude') {
      includeHit = null;
      overlayHits = [];
    } else if (rule.mode === 'overlay') {
      overlayHits.push({ index: rule.index, deliveryPath });
    } else {
      includeHit = { index: rule.index, deliveryPath };
    }
  }
  const candidates = [...(includeHit ? [includeHit] : []), ...overlayHits];
  return { included: candidates.length > 0, candidates, hits };
}

// 视图投影：depot 修订身份 -> 交付路径，碰撞原样返回，不由引擎挑选赢家。
export function projectView({ rules, identities, contentOf }) {
  const groups = new Map();
  const excluded = [];
  for (const identity of identities) {
    const resolution = resolveFile(rules, identity.depotFile);
    if (!resolution.included) {
      excluded.push({ identity: IDENTITY(identity), depotFile: identity.depotFile,
        revision: identity.revision, reason: 'excluded_by_view', hits: resolution.hits });
      continue;
    }
    for (const candidate of resolution.candidates) {
      const list = groups.get(candidate.deliveryPath) ?? [];
      list.push({ identity: IDENTITY(identity), depotFile: identity.depotFile,
        revision: identity.revision, ruleIndex: candidate.index,
        mode: rules[candidate.index].mode, supplierDigest: identity.digest ?? null });
      groups.set(candidate.deliveryPath, list);
    }
  }
  const entries = [];
  const collisions = [];
  for (const [deliveryPath, candidates] of groups) {
    const fingerprints = candidates.map(candidate => {
      const bytes = contentOf?.(candidate.depotFile, candidate.revision);
      return bytes === null || bytes === undefined ? null : bytes;
    });
    const distinct = new Set(fingerprints.map(value => (value ? String(value) : '__unavailable__')));
    if (candidates.length > 1 && fingerprints.some(value => value === null)) {
      collisions.push({ reason: 'content_undetermined', deliveryPath, candidates });
      continue;
    }
    if (distinct.size > 1) {
      collisions.push({ reason: 'mapping_collision', deliveryPath,
        candidates: candidates.map((candidate, i) => ({ ...candidate, fingerprint: fingerprints[i] })) });
      continue;
    }
    const primary = candidates.reduce((left, right) => (left.ruleIndex <= right.ruleIndex ? left : right));
    entries.push({ deliveryPath, depotFile: primary.depotFile, revision: primary.revision,
      contentDigest: fingerprints[0] ?? null, supplierDigest: primary.supplierDigest,
      sources: candidates.map(({ ruleIndex, mode, depotFile, revision }) =>
        ({ ruleIndex, mode, depotFile, revision })) });
  }
  entries.sort((left, right) => left.deliveryPath.localeCompare(right.deliveryPath));
  return { entries, excluded, collisions };
}

// 配对 changelist 中的 move/delete 与 move/add，配对不上的保持可见而不是静默丢弃。
export function pairMoves(files) {
  const deletions = files.filter(file => file.action === 'move/delete');
  const additions = files.filter(file => file.action === 'move/add');
  const claimed = new Set();
  const pairs = deletions.map(from => {
    const index = additions.findIndex((to, position) => !claimed.has(position)
      && to.depotFile === from.movedFile && to.movedFile === from.depotFile);
    if (index < 0) return { paired: false, from, to: null };
    claimed.add(index);
    return { paired: true, from, to: additions[index] };
  });
  const unpaired = [
    ...pairs.filter(pair => !pair.paired).map(pair => ({ endpoint: 'move/delete', file: pair.from })),
    ...additions.filter((_, position) => !claimed.has(position))
      .map(file => ({ endpoint: 'move/add', file })),
  ];
  return { pairs: pairs.filter(pair => pair.paired), unpaired };
}

function entryKey(entry) {
  return `${entry.depotFile}#${entry.revision}`;
}

// 解释视图切换：基于含排除项的完整身份快照，区分视图驱动与供应商源修订变化。
// snapshot 元素：{ depotFile, revision, included, deliveryPath }
export function explainViewChange({ before, after, sourceDriven = [] }) {
  const previous = new Map(before.map(entry => [entryKey(entry), entry]));
  const current = new Map(after.map(entry => [entryKey(entry), entry]));
  const pathMoved = [];
  const viewExcluded = [];
  const viewIncluded = [];
  const unchangedIncluded = [];
  const unchangedExcluded = [];
  for (const [key, oldEntry] of previous) {
    const newEntry = current.get(key);
    if (!newEntry) {
      if (oldEntry.included) {
        viewExcluded.push({ depotFile: oldEntry.depotFile, revision: oldEntry.revision,
          previousPath: oldEntry.deliveryPath });
      } else {
        unchangedExcluded.push({ depotFile: oldEntry.depotFile, revision: oldEntry.revision });
      }
      continue;
    }
    if (oldEntry.included && newEntry.included) {
      if (newEntry.deliveryPath !== oldEntry.deliveryPath) {
        pathMoved.push({ depotFile: oldEntry.depotFile, revision: oldEntry.revision,
          fromPath: oldEntry.deliveryPath, toPath: newEntry.deliveryPath });
      } else {
        unchangedIncluded.push({ depotFile: oldEntry.depotFile, revision: oldEntry.revision,
          path: oldEntry.deliveryPath });
      }
    } else if (oldEntry.included && !newEntry.included) {
      viewExcluded.push({ depotFile: oldEntry.depotFile, revision: oldEntry.revision,
        previousPath: oldEntry.deliveryPath });
    } else if (!oldEntry.included && newEntry.included) {
      viewIncluded.push({ depotFile: newEntry.depotFile, revision: newEntry.revision,
        path: newEntry.deliveryPath });
    } else {
      unchangedExcluded.push({ depotFile: oldEntry.depotFile, revision: oldEntry.revision });
    }
  }
  for (const [key, newEntry] of current) {
    if (!previous.has(key)) {
      if (newEntry.included) {
        viewIncluded.push({ depotFile: newEntry.depotFile, revision: newEntry.revision,
          path: newEntry.deliveryPath });
      }
    }
  }
  return { viewDriven: { pathMoved, viewExcluded, viewIncluded,
    unchangedIncluded, unchangedExcluded }, sourceDriven };
}
