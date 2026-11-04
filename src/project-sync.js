import {
  assert,
  pathParts
} from './util.js';

/** Durable, ordered filesystem deltas. Never mirror/delete untouched on-disk entries. */
export class ProjectSync {
  constructor(store) {
    this.store = store;
  }
  async submit(root, operations) {
    assert(root?.kind === 'directory' && Array.isArray(operations), 'Папка Python недоступна');
    for (const op of operations) {
      pathParts(op.path);
      assert(['write', 'mkdir', 'remove'].includes(op.type), 'Неизвестная файловая операция');
      if (op.type === 'write') assert(op.bytes instanceof Uint8Array, 'Некорректное содержимое файла');
    }
    await this.store.enqueueProjectChange({
      id: crypto.randomUUID(),
      root,
      operations
    });
    try {
      await this.flush();
    } catch (error) {
      error.staged = true;
      throw error;
    }
  }
  async flush() {
    if (this.flushing) return this.flushing;
    this.flushing = this.drain().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }
  async drain() {
    for (;;) {
      const queue = await this.store.get('project-write-queue') || [];
      if (!queue.length) return;
      const record = await this.store.get('project-change:' + queue[0]);
      assert(record, 'Повреждена очередь сохранения файлов');
      const {
        root,
        operations
      } = record;
      assert(await root.queryPermission({
        mode: 'readwrite'
      }) === 'granted', 'Нажмите «Доступ к папке»: записи Python сохранены в браузере и ожидают выгрузки');
      for (const op of operations) {
        const parts = pathParts(op.path);
        let dir = root;
        try {
          for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, {
            create: op.type !== 'remove'
          });
          const name = parts.at(-1);
          if (op.type === 'remove') await dir.removeEntry(name, {
            recursive: true
          });
          else if (op.type === 'mkdir') await dir.getDirectoryHandle(name, {
            create: true
          });
          else {
            const file = await dir.getFileHandle(name, {
              create: true
            });
            const stream = await file.createWritable();
            try {
              await stream.write(op.bytes);
              await stream.close();
            } catch (error) {
              await stream.abort().catch(() => {});
              throw error;
            }
          }
        } catch (error) {
          if (!(op.type === 'remove' && error.name === 'NotFoundError')) throw error;
        }
      }
      await this.store.completeProjectChange(record.id);
    }
  }
}
