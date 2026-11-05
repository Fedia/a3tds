import {
  assert,
  pathParts
} from './util.js';
export class ProjectFiles {
  constructor(store, preferences = chrome.storage.local) {
    this.store = store;
    this.preferences = preferences;
    this.configKey = store.chatId ? "project:" + store.chatId : null;
  }
  async restore() {
    let preferences = await this.preferences.get(['file-mode', 'file-revision', ...(this.configKey ? [this.configKey] : [])]);
    if (this.configKey && !preferences[this.configKey]) {
      await navigator.locks.request('project-config:' + this.store.chatId, async () => {
        preferences = await this.preferences.get(['file-mode', 'file-revision', this.configKey]);
        if (preferences[this.configKey]) return;
        const directory = await this.store.global().get('directory');
        if (directory) await this.store.put('directory', directory);
        await this.preferences.set({
          [this.configKey]: {
            mode: preferences['file-mode'],
            revision: crypto.randomUUID()
          }
        });
        preferences = await this.preferences.get([this.configKey]);
      });
    }
    const config = this.configKey ? preferences[this.configKey] : null;
    const mode = config ? config.mode : preferences['file-mode'];
    const revision = config ? config.revision : preferences['file-revision'];
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
  async saveConfig(mode, revision = crypto.randomUUID(), defaults = false) {
    const values = this.configKey ? {
      [this.configKey]: {
        mode,
        revision
      }
    } : {};
    if (!this.configKey || defaults) Object.assign(values, {
      'file-mode': mode,
      'file-revision': revision
    });
    await this.preferences.set(values);
  }
  async useBrowserStorage() {
    await this.saveConfig('browser', crypto.randomUUID(), true);
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
      id: 'deepseek-agent-project'
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
    if (this.store.chatId) await this.store.global().put('directory', candidate);
    this.mode = 'directory';
    this.root = candidate;
    this.revision = crypto.randomUUID();
    await this.saveConfig('directory', this.revision, true);
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
    await this.saveConfig(this.mode, this.revision);
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
