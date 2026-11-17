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
  if (!Array.isArray(payload.lines) || payload.lines.length === 0) throw new Error('view_lines');
  if (typeof payload.client !== 'string' || !payload.client) throw new Error('view_client');
  return { version: payload.version, client: payload.client, lines: payload.lines };
}
export function inspectChange(bytes) {
  const payload = JSON.parse(bytes.toString('utf8'));
  if (!Number.isInteger(payload.change) || !Array.isArray(payload.files)) throw new Error('change_payload');
  return { change: payload.change,
    files: payload.files.map(file => {
      if (!/^\/\//.test(file.depotFile) || !Number.isInteger(file.rev) || file.rev < 1) throw new Error('depot_identity');
      return { depotFile: file.depotFile, revision: file.rev, action: file.action,
        change: file.change, digest: file.digest, movedFile: file.movedFile ?? null };
    }) };
}
export function inspectContentIndex(bytes) {
  const payload = JSON.parse(bytes.toString('utf8'));
  const index = {};
  for (const [key, value] of Object.entries(payload)) {
    if (!/^\/\/.+#\d+$/.test(key)) throw new Error('content_identity');
    if (typeof value !== 'string') throw new Error('content_payload');
    index[key] = value;
  }
  return index;
}
export function parseContentIdentity(key) {
  const match = /^(.+)#(\d+)$/.exec(key);
  if (!match) throw new Error('content_identity');
  return { depotFile: match[1], revision: Number(match[2]) };
}
