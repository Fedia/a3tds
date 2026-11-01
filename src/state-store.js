import {
  assert
} from './util.js';
export class StateStore {
  constructor(name = 'psy-agent') {
    this.name = name;
  }
  async init() {
    this.db = await new Promise((resolve, reject) => {
      const q = indexedDB.open(this.name, 1);
      q.onupgradeneeded = () => q.result.createObjectStore('kv');
      q.onsuccess = () => resolve(q.result);
      q.onerror = () => reject(q.error);
    });
    return this;
  }
  async get(key) {
    return new Promise((resolve, reject) => {
      const q = this.db.transaction('kv').objectStore('kv').get(key);
      q.onsuccess = () => resolve(q.result);
      q.onerror = () => reject(q.error);
    });
  }
  async put(key, value) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(value, key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
  async save(s) {
    await this.put('task', structuredClone(s));
    if (this.name === 'psy-agent') await chrome.storage.local.set({
      summary: {
        status: s.status,
        message: s.reason || s.current || '',
        updated: Date.now()
      }
    });
  }
  static fresh(task) {
    return {
      version: 1,
      id: crypto.randomUUID(),
      task,
      status: 'paused',
      reason: 'Готово к запуску',
      started: Date.now(),
      steps: 0,
      commands: {},
      tabs: [],
      corpus: [],
      logs: [],
      prompts: [],
      files: [],
      outbound: null,
      pending: null,
      last: null,
      analysis: null
    };
  }
  static recover(s) {
    if (!s) return null;
    assert(s.version === 1, 'Неизвестная версия состояния');
    if (s.status === 'stopped') return s;
    if (s.status === 'running' || s.pending || s.outbound) {
      s.status = 'paused';
      s.reason = s.pending ?
        'Есть незавершённая команда. Проверьте её состояние; автоматический повтор запрещён.' :
        'Рабочая вкладка была закрыта. Проверьте DeepSeek перед продолжением.';
    }
    return s;
  }
}
