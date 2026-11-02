import {
  hash
} from './util.js';

/** Durable per-page staging followed by immutable export to the selected directory. */
export class Captures {
  constructor(store, files, state, save) {
    Object.assign(this, {
      store,
      files,
      state,
      save
    });
    this.inflight = new Map();
  }
  async capture(command, payload) {
    const key = 'capture:' + this.state.id + ':' + command.id;
    let record = await this.store.get(key);
    if (!record) {
      const content = payload.records ? payload.records.map(r => r.fields) : payload.data ?? payload.text ?? payload;
      const contentHash = await hash(typeof content === 'string' ? content : JSON.stringify(content));
      const document = {
        schemaVersion: 1,
        ...payload,
        collectedAt: payload.collectedAt || new Date().toISOString(),
        method: payload.method || 'dom-snapshot-v1',
        capture: {
          id: command.id,
          taskId: this.state.id,
          contentHash
        }
      };
      record = {
        key,
        path: `tasks/${this.state.id}/pages/step-${command.id}.json`,
        text: JSON.stringify(document, null, 2),
        status: 'staged'
      };
      const indexKey = 'capture-index:' + this.state.id;
      const index = await this.store.get(indexKey) || [];
      const queue = await this.store.get('capture-export-queue') || [];
      await this.store.putMany([
        [key, record], [indexKey, [...new Set([...index,key])]],
        ['capture-export-queue', [...new Set([...queue,key])]]
      ]);
    }
    return this.export(record);
  }
  async export (record) {
    if (record.status === 'saved' && this.state.files.includes(record.savedPath) && this.state.captures?.some(c => c.path === record.savedPath)) {
      return {
        savedPath: record.savedPath,
        captureId: record.key
      };
    }
    let path = record.savedPath;
    if (record.status !== 'saved') {
      const operationId = 'capture:' + record.key;
      const write = await this.store.get('write:' + operationId);
      if (write) {
        try {
          const file = await this.files.file(write.path);
          if (await hash(new Uint8Array(await file.arrayBuffer())) === write.hash) path = write.path;
        } catch {}
      }
      if (!path) path = (await this.files.write(record.path, record.text, {
        operationId
      })).path;
      record = {
        ...record,
        savedPath: path,
        status: 'saved'
      };
      const queue = await this.store.get('capture-export-queue') || [];
      await this.store.putMany([[record.key,record], ['capture-export-queue',queue.filter(key=>key!==record.key)]]);
    }
    if (!this.state.files.includes(path)) this.state.files.push(path);
    this.state.captures ??= [];
    if (!this.state.captures.some(c => c.path === path)) this.state.captures.push({
      path,
      id: record.key.split(':').at(-1)
    });
    await this.save();
    return {
      savedPath: path,
      captureId: record.key
    };
  }
  flush() {
    if (!this.flushing) this.flushing = this.flushPending().finally(()=>{this.flushing=null;});
    return this.flushing;
  }
  async flushPending() {
    for (const key of await this.store.get('capture-index:' + this.state.id) || []) {
      const record = await this.store.get(key);
      if (record) await this.export(record);
    }
    // A new task must also finish exports left by an archived task.
    for (const key of await this.store.get('capture-export-queue') || []) {
      const record = await this.store.get(key);
      if (!record) continue;
      const id = key.split(':')[1];
      if (id === this.state.id) { await this.export(record); continue; }
      const archiveKey = 'archive-' + id;
      const archive = await this.store.get(archiveKey) || { id, files: [], captures: [] };
      const exporter = new Captures(this.store,this.files,archive,()=>this.store.put(archiveKey,archive));
      await exporter.export(record);
    }
  }
}
