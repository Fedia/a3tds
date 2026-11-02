import {
  assert,
  pathParts,
  hash
} from './util.js';
export class ProjectFiles {
  constructor(store) {
    this.store = store;
  }
  async restore() {
    const mode = (await chrome.storage.local.get('file-mode'))['file-mode'];
    this.mode = mode;
    if (mode === 'browser') {
      assert(navigator.storage?.getDirectory, 'Браузер не поддерживает внутреннее файловое хранилище');
      this.root = await (await navigator.storage.getDirectory()).getDirectoryHandle('agent-results', {
        create: true
      });
    } else this.root = await this.store.get('directory');
  }
  async useBrowserStorage() {
    if ((await chrome.storage.local.get('file-mode'))['file-mode'] !== 'browser') await this.store.put(
      'owned-files', {});
    await chrome.storage.local.set({
      'file-mode': 'browser'
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
    try {
      const f = await (await candidate.getFileHandle('manifest.json')).getFile();
      const m = JSON.parse(await f.text());
      assert(!m.manifest_version, 'Выберите отдельную папку результатов, не папку расширения');
    } catch (e) {
      if (e.name !== 'NotFoundError' && e.name !== 'SyntaxError') throw e;
    }
    const previous = await this.store.get('directory');
    if (this.mode !== 'directory' || !previous || !await previous.isSameEntry(candidate)) await this.store
      .put('owned-files', {});
    this.mode = 'directory';
    await chrome.storage.local.set({
      'file-mode': 'directory'
    });
    this.root = candidate;
    await this.store.put('directory', this.root);
    await this.authorize();
  }
  async authorize() {
    assert(this.root, 'Выберите папку или внутреннее хранилище');
    if (this.mode === 'browser') return;
    assert(await this.root.requestPermission({
      mode: 'readwrite'
    }) === 'granted', 'Нет разрешения на папку');
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
    owners[actual] = await hash(text);
    await this.store.put('owned-files', owners);
    return {
      path: actual,
      characters: text.length
    };
  }
}
