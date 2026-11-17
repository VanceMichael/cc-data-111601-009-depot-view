import { parseViewLine } from './reader.mjs';

const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g;

function wildcards(pattern) {
  const found = pattern.match(/\.\.\.|\*/g);
  return found ? found.length : 0;
}

function compilePattern(source) {
  let regex = '';
  for (let index = 0; index < source.length;) {
    if (source.startsWith('...', index)) { regex += '(.*)'; index += 3; }
    else if (source[index] === '*') { regex += '([^/]*)'; index += 1; }
    else { regex += source[index].replace(REGEX_SPECIALS, '\\$&'); index += 1; }
  }
  return new RegExp(`^${regex}$`);
}

export function compileView(lines) {
  if (!Array.isArray(lines) || lines.length === 0) throw new Error('view_lines');
  return lines.map(line => {
    const parsed = parseViewLine(line);
    const source = parsed.source.replace(/^[-+]/, '');
    if (!source.startsWith('//') || !parsed.target.startsWith('//')) throw new Error('view_pair');
    if (wildcards(source) !== wildcards(parsed.target)) throw new Error('view_wildcard_mismatch');
    return { mode: parsed.mode, source, target: parsed.target, regex: compilePattern(source) };
  });
}

export function projectPath(mappings, depotFile) {
  const targets = [];
  for (const mapping of mappings) {
    const match = mapping.regex.exec(depotFile);
    if (!match) continue;
    const captures = match.slice(1);
    let index = 0;
    const mapped = mapping.target.replace(/\.\.\.|\*/g, () => captures[index++] ?? '');
    if (mapping.mode === 'exclude') targets.length = 0;
    else if (mapping.mode === 'overlay') { if (!targets.includes(mapped)) targets.push(mapped); }
    else { targets.length = 0; targets.push(mapped); }
  }
  return targets;
}

export function projectRevisions(mappings, revisions) {
  const placements = [];
  for (const [depotFile, info] of Object.entries(revisions)) {
    for (const deliveryPath of projectPath(mappings, depotFile)) {
      placements.push({ deliveryPath, depotFile, revision: info.rev });
    }
  }
  placements.sort((a, b) => a.deliveryPath.localeCompare(b.deliveryPath) ||
    a.depotFile.localeCompare(b.depotFile));
  return placements;
}
