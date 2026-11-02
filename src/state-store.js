import {
  projectTask
} from './ui-state.js';
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
    return this.putMany([
      [key, value]
    ]);
  }
  async putMany(entries) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('kv', 'readwrite');
      for (const [key, value] of entries) tx.objectStore('kv').put(value, key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
  async putPythonJob(key, record) {
    const snapshot = structuredClone(record);
    await new Promise((resolve, reject) => {
      const tx = this.db.transaction('kv', 'readwrite'),
        kv = tx.objectStore('kv'),
        q = kv.get('python-export-queue');
      q.onsuccess = () => {
        const queue = q.result || [];
        kv.put(snapshot, key);
        kv.put(snapshot.outcome ? [...new Set([...queue, key])] : queue.filter(item => item !== key), 'python-export-queue');
      };
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
  async recordOwnedFile(path, digest) {
    await new Promise((resolve, reject) => {
      const tx = this.db.transaction('kv', 'readwrite'),
        kv = tx.objectStore('kv'),
        q = kv.get('owned-files');
      q.onsuccess = () => {
        const owners = q.result || {};
        owners[path] = digest;
        kv.put(owners, 'owned-files');
      };
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
  /** Patch only job metadata/files; a background result must never overwrite a newer task. */
  async patchPythonJob(taskId, jobId, view, paths = []) {
    await new Promise((resolve, reject) => {
      const tx = this.db.transaction('kv', 'readwrite'),
        kv = tx.objectStore('kv');
      const patch = (key, state) => {
        if (state?.id === taskId) {
          state.pythonJobs ??= {};
          state.pythonJobs[jobId] = view;
          state.files = [...new Set([...state.files, ...paths])];
          kv.put(state, key);
        }
      };
      const request = kv.get('task');
      request.onsuccess = () => {
        if (request.result?.id === taskId) patch('task', request.result);
        else {
          const archived = kv.get('archive-' + taskId);
          archived.onsuccess = () => patch('archive-' + taskId, archived.result);
        }
      };
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
  async save(s) {
    await this.put('task', structuredClone(s));
    if (this.name === 'psy-agent') {
      const summary = projectTask(s),
        final = summary.final;
      const values = {
        summary
      };
      const historySignature = JSON.stringify([s.id, s.modelChatURL, summary.history]);
      if (summary.history.length && historySignature !== this.historySignature) {
        const previous = (await chrome.storage.local.get('ui-history'))['ui-history'] || [];
        values['ui-history'] = [...previous.filter(item => item.taskId !== s.id), {
          taskId: s.id,
          chatURL: s.modelChatURL,
          entries: summary.history
        }].slice(-50);
      }
      if (final) {
        const previous = (await chrome.storage.local.get('ui-finals'))['ui-finals'] || [];
        values['ui-finals'] = [...previous.filter(item => item.taskId !== s.id), final].slice(-50);
      }
      await chrome.storage.local.set(values);
      this.historySignature = historySignature;
    }
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
        'Проверю результат прерванного шага при продолжении.' :
        'Задача сохранена. Для продолжения напишите «продолжай» в исходном чате.';
    }
    return s;
  }
}
