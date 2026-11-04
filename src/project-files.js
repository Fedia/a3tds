import {
  assert,
  pathParts
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
    await this.store.put('directory', candidate);
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
}
