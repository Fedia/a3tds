import {
  hash,
  pathParts
} from './util.js';

/** Content versions protect independent cached Python filesystems from lost updates. */
export async function directoryManifest(root, prefix = '', out = new Map()) {
  for await (const [name, entry] of root.entries()) {
    const path = prefix + name;
    if (entry.kind === 'directory') {
      out.set(path, 'directory');
      await directoryManifest(entry, path + '/', out);
    } else out.set(path, 'file:' + await hash(new Uint8Array(await (await entry.getFile()).arrayBuffer())));
  }
  return out;
}
export async function versionAt(manifest, path) {
  const value = manifest.get(path) || null;
  if (value !== 'directory') return value;
  return 'directory:' + await hash(JSON.stringify([...manifest].filter(([p]) => p === path || p.startsWith(path + '/')).sort(([a], [b]) => a.localeCompare(b))));
}
export async function diskVersion(root, path) {
  const parts = pathParts(path);
  let dir = root;
  try {
    for (const name of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(name);
    let file;
    try {
      file = await dir.getFileHandle(parts.at(-1));
    } catch (error) {
      if (error.name !== 'TypeMismatchError') throw error;
      const child = await dir.getDirectoryHandle(parts.at(-1));
      const manifest = await directoryManifest(child, path + '/', new Map([
        [path, 'directory']
      ]));
      return versionAt(manifest, path);
    }
    return 'file:' + await hash(new Uint8Array(await (await file.getFile()).arrayBuffer()));
  } catch (error) {
    if (error.name === 'NotFoundError') return null;
    throw error;
  }
}
export function updateManifest(manifest, op, after) {
  if (op.type === 'remove') {
    for (const path of manifest.keys())
      if (path === op.path || path.startsWith(op.path + '/')) manifest.delete(path);
  } else if (op.type === 'write') manifest.set(op.path, after);
  else if (!manifest.has(op.path)) manifest.set(op.path, 'directory');
}
