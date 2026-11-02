import {
  assert,
  pathParts,
  hash
} from './util.js';
export class ProjectFiles {
  constructor(store, preferences = chrome.storage.local) {
    this.store = store;
    this.preferences = preferences;
  }
  async restore() {
    const preferences = await this.preferences.get(['file-mode', 'file-revision']);
    const mode = preferences['file-mode'],
      revision = preferences['file-revision'];
    // Keep the live, authorized handle. Rehydrate only when the selection or grant changes.
    if (this.root && this.mode === mode && this.revision === revision) return;
    this.mode = mode;
    if (mode === 'browser') {
      assert(navigator.storage?.getDirectory, 'Браузер не поддерживает внутреннее файловое хранилище');
      this.root = await (await navigator.storage.getDirectory()).getDirectoryHandle('agent-results', {
        create: true
      });
    } else this.root = await this.store.get('directory');
    this.revision = revision;
  }
  async useBrowserStorage() {
    if ((await this.preferences.get('file-mode'))['file-mode'] !== 'browser') await this.store.put(
      'owned-files', {});
    await this.preferences.set({
      'file-mode': 'browser',
      'file-revision': crypto.randomUUID()
    });
    await this.restore();
  }
  async file(path) {
    const [dir, name] = await this.parent(path);
    return (await dir.getFileHandle(name)).getFile();
  }
  async choose() {
    assert(typeof showDirectoryPicker === 'function',
      'Этот браузер не поддерживает выбор папки (File System Access API). Требуется другой способ сохранения файлов.'
    );
    const candidate = await showDirectoryPicker({
      mode: 'readwrite',
      id: 'psy-agent-project'
    });
    await this.requestAccess(candidate);
    try {
      const f = await (await candidate.getFileHandle('manifest.json')).getFile();
      const m = JSON.parse(await f.text());
      assert(!m.manifest_version, 'Выберите отдельную папку результатов, не папку расширения');
    } catch (e) {
      if (e.name !== 'NotFoundError' && e.name !== 'SyntaxError') throw e;
    }
    const previous = await this.store.get('directory');
    const changed = this.mode !== 'directory' || !previous || !await previous.isSameEntry(candidate);
    await this.store.putMany([
      ['directory', candidate], ...(changed ? [
        ['owned-files', {}]
      ] : [])
    ]);
    this.mode = 'directory';
    this.root = candidate;
    this.revision = crypto.randomUUID();
    await this.preferences.set({
      'file-mode': 'directory',
      'file-revision': this.revision
    });
  }
  async requestAccess(root) {
    if (await root.queryPermission({
        mode: 'readwrite'
      }) === 'granted') return false;
    assert(await root.requestPermission({
      mode: 'readwrite'
    }) === 'granted', 'Нет разрешения на папку');
    return true;
  }
  authorize() {
    if (!this.authorizing) this.authorizing = this.authorizeSelected().finally(() => {
      this.authorizing = null;
    });
    return this.authorizing;
  }
  async authorizeSelected() {
    assert(this.root, 'Выберите папку или внутреннее хранилище');
    if (this.mode === 'browser') return;
    if (!await this.requestAccess(this.root)) return;
    // Other extension contexts must refresh their handle after an explicit grant.
    await this.store.put('directory', this.root);
    this.revision = crypto.randomUUID();
    await this.preferences.set({
      'file-revision': this.revision
    });
  }
  async permission() {
    if (this.mode === 'browser') {
      assert(this.root, 'Внутреннее хранилище недоступно');
      return;
    }
    assert(this.root && await this.root.queryPermission({
      mode: 'readwrite'
    }) === 'granted', 'Нажмите «Доступ к папке», чтобы восстановить разрешение');
  }
  async parent(path, create = false) {
    await this.permission();
    const p = pathParts(path);
    let d = this.root;
    for (const segment of p.slice(0, -1)) d = await d.getDirectoryHandle(segment, {
      create
    });
    return [d, p.at(-1)];
  }
  async list(path = '') {
    await this.permission();
    let directory = this.root;
    if (path)
      for (const part of pathParts(path)) directory = await directory.getDirectoryHandle(part);
    const out = [];
    for await (const [name, h] of directory.entries()) {
      out.push({
        name,
        kind: h.kind,
        path: path ? path + '/' + name : name
      });
      if (out.length >= 300) break;
    }
    return {
      entries: out,
      truncated: out.length >= 300
    };
  }
  async read(path, offset = 0, limit = 12000) {
    const [d, n] = await this.parent(path);
    const f = await (await d.getFileHandle(n)).getFile();
    assert(f.size <= 10000000, 'Файл больше 10 МБ');
    const text = await f.text();
    return {
      path,
      totalCharacters: text.length,
      offset,
      text: text.slice(offset, offset + limit),
      truncated: offset + limit < text.length
    };
  }
  /** Never overwrite an unowned or externally modified file. Ownership is content-hash based. */
  async write(path, text, {
    owned = false,
    operationId
  } = {}) {
    assert((typeof text === 'string' || text instanceof Uint8Array) && text.length <= 10000000,
      'Слишком большой файл');
    const [d, n] = await this.parent(path, true);
    let name = n;
    const owners = await this.store.get('owned-files') || {};
    let existing;
    try {
      existing = await (await d.getFileHandle(name)).getFile();
    } catch (e) {
      if (e.name !== 'NotFoundError') throw e;
    }
    if (existing) {
      const current = await hash(new Uint8Array(await existing.arrayBuffer()));
      if (!(owned && owners[path] === current)) name = n.replace(/(\.[^.]+)?$/,
        `-${crypto.randomUUID().slice(0,8)}$1`);
    }
    const h = await d.getFileHandle(name, {
      create: true
    });
    const actual = [...pathParts(path).slice(0, -1), name].join('/');
    if (operationId) await this.store.put('write:' + operationId, {
      path: actual,
      hash: await hash(text)
    });
    const stream = await h.createWritable();
    try {
      await stream.write(text);
      await stream.close();
    } catch (e) {
      await stream.abort().catch(() => {});
      throw e;
    }
    await this.store.recordOwnedFile(actual, await hash(text));
    return {
      path: actual,
      characters: text.length
    };
  }
}
