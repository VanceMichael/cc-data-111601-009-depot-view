export function inspect(bytes) {
  const payload = JSON.parse(bytes.toString('utf8'));
  if (!Array.isArray(payload.files)) throw new Error('depot_files');
  return { kind: 'depot-revisions', change: payload.change,
    files: payload.files.map(file => {
      if (!/^\/\//.test(file.depotFile) || !Number.isInteger(file.rev) || file.rev < 1) throw new Error('depot_identity');
      return { depotFile: file.depotFile, revision: file.rev, action: file.action, change: file.change, digest: file.digest };
    }) };
}
export function parseViewLine(line) {
  const tokens = line.match(/"[^"\n]*"|\S+/g);
  if (!tokens || tokens.length !== 2) throw new Error('view_pair');
  const [source, target] = tokens.map(token => token.replace(/^"|"$/g, ''));
  return { source, target, mode: source.startsWith('-') ? 'exclude' : source.startsWith('+') ? 'overlay' : 'include' };
}
export function inspectView(bytes) {
  const payload = JSON.parse(bytes.toString('utf8'));
  if (!Number.isInteger(payload.version) || payload.version < 1 ||
    typeof payload.client !== 'string' || !Array.isArray(payload.lines) ||
    payload.lines.length === 0 || payload.lines.some(line => typeof line !== 'string')) {
    throw new Error('view_shape');
  }
  return { kind: 'view', version: payload.version, client: payload.client, lines: payload.lines };
}
const CHANGE_ACTIONS = new Set(['add', 'edit', 'delete', 'move/delete', 'move/add']);
export function inspectChange(bytes) {
  const payload = JSON.parse(bytes.toString('utf8'));
  if (!Number.isInteger(payload.change) || payload.change < 1 || !Array.isArray(payload.files)) {
    throw new Error('changelist_shape');
  }
  const files = payload.files.map(file => {
    if (!/^\/\//.test(file.depotFile) || !Number.isInteger(file.rev) || file.rev < 1 ||
      !CHANGE_ACTIONS.has(file.action) ||
      (file.movedFile !== undefined && !/^\/\//.test(file.movedFile))) throw new Error('changelist_file');
    return { depotFile: file.depotFile, revision: file.rev, action: file.action,
      movedFile: file.movedFile ?? null, change: file.change ?? payload.change, digest: file.digest ?? null };
  });
  return { kind: 'changelist', change: payload.change, files };
}
