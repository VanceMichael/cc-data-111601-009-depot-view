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
