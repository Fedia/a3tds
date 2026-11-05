import {
  projectTask
} from './ui-state.js';
export class StateStore {
  constructor(name = 'deepseek-agent', chatId = '') {
    this.name = name;
    this.chatId = chatId;
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
  forChat(chatId) {
    const view = new StateStore(this.name, chatId);
    view.db = this.db;
    return view;
  }
  global() {
    return this.forChat('');
  }
  key(key) {
    return this.chatId ? 'chat:' + this.chatId + ':' + key : key;
  }
  get summaryKey() {
    return 'summary:' + this.chatId;
  }
  get historyKey() {
    return 'history:' + this.chatId;
  }
  async get(key) {
    return new Promise((resolve, reject) => {
      const q = this.db.transaction('kv').objectStore('kv').get(this.key(key));
      q.onsuccess = () => resolve(q.result);
      q.onerror = () => reject(q.error);
    });
  }
  async put(key, value) {
    return this.putMany([
      [key, value]
    ]);
  }
  async putMany(entries) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('kv', 'readwrite');
      for (const [key, value] of entries) tx.objectStore('kv').put(value, this.key(key));
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
  async enqueueProjectChange(record) {
    await new Promise((resolve, reject) => {
      const tx = this.db.transaction('kv', 'readwrite'),
        kv = tx.objectStore('kv');
      const q = kv.get(this.key('project-write-queue'));
      q.onsuccess = () => {
        kv.put(record, this.key('project-change:' + record.id));
        kv.put([...(q.result || []), record.id], this.key('project-write-queue'));
      };
      tx.oncomplete = resolve;
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  }
  async completeProjectChange(id) {
    await new Promise((resolve, reject) => {
      const tx = this.db.transaction('kv', 'readwrite'),
        kv = tx.objectStore('kv');
      const q = kv.get(this.key('project-write-queue'));
      q.onsuccess = () => {
        kv.put((q.result || []).filter(item => item !== id), this.key('project-write-queue'));
        kv.delete(this.key('project-change:' + id));
      };
      tx.oncomplete = resolve;
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  }
  async save(s) {
    s.chatId ||= this.chatId;
    await this.put('task', structuredClone(s));
    await this.saveProjection(s);
  }
  async saveProjection(s) {
    if (this.name === 'deepseek-agent') {
      const summary = projectTask(s);
      const values = {
        [this.summaryKey]: summary
      };
      const historySignature = JSON.stringify([s.id, s.modelChatURL, summary.history]);
      if (summary.history.length && historySignature !== this.historySignature) {
        const previous = (await chrome.storage.local.get(this.historyKey))[this.historyKey] || [];
        values[this.historyKey] = [...previous.filter(item => item.taskId !== s.id), {
          taskId: s.id,
          chatURL: s.modelChatURL,
          entries: summary.history
        }].slice(-50);
      }
      await chrome.storage.local.set(values);
      this.historySignature = historySignature;
    }
  }
  static fresh(task) {
    return {
      version: 2,
      id: crypto.randomUUID(),
      task,
      status: 'paused',
      reason: 'Готово к запуску',
      started: Date.now(),
      steps: 0,
      commands: {},
      tabs: [],
      logs: [],
      files: [],
      outbound: null,
      pending: null,
      last: null
    };
  }
  static recover(s) {
    if (!s) return null;
    if (s.version !== 2) return null;
    if (s.status === 'stopped') return s;
    if (s.status === 'running' || s.pending || s.outbound) {
      s.status = 'paused';
      s.reason = s.pending ?
        'Проверю результат прерванного шага при продолжении.' :
        'Задача сохранена. Для продолжения напишите «продолжай» в исходном чате.';
    }
    return s;
  }
}
