import {
  assert,
  pathParts,
  hash
} from './util.js';
import {
  directoryManifest,
  versionAt,
  diskVersion,
  updateManifest
} from './project-versions.js';

/** Per-chat durable queue, short per-project locks, optimistic content versions. */
export class ProjectSync {
  constructor(store) {
    this.store = store;
    this.conflictPaths = new Map();
  }
  async projectId(root) {
    return navigator.locks.request('deepseek-agent-project-registry', async () => {
      const shared = this.store.global();
      const projects = await shared.get('project-roots') || [];
      for (const project of projects)
        if (await project.root.isSameEntry(root)) return project.id;
      const id = crypto.randomUUID();
      projects.push({
        id,
        root
      });
      await shared.put('project-roots', projects);
      return id;
    });
  }
  async prepare(root) {
    const projectId = await this.projectId(root);
    return navigator.locks.request('project-files:' + projectId, async () => ({
      projectId,
      manifest: await directoryManifest(root)
    }));
  }
  async submit(root, operations, baseline = null) {
    assert(root?.kind === 'directory' && Array.isArray(operations), 'Папка Python недоступна');
    for (const op of operations) {
      pathParts(op.path);
      assert(['write', 'mkdir', 'remove'].includes(op.type), 'Неизвестная файловая операция');
      if (op.type === 'write') assert(op.bytes instanceof Uint8Array, 'Некорректное содержимое файла');
    }
    const projectId = baseline?.projectId || await this.projectId(root);
    const checked = [];
    for (const op of operations) {
      const after = op.type === 'write' ? 'file:' + await hash(op.bytes) : op.type === 'remove' ? null : 'directory';
      checked.push({
        ...op,
        after,
        ...(baseline ? {
          expected: await versionAt(baseline.manifest, op.path)
        } : {})
      });
      if (baseline) updateManifest(baseline.manifest, op, after);
    }
    await this.store.enqueueProjectChange({
      id: crypto.randomUUID(),
      root,
      projectId,
      operations: checked
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
    // Also serialize separate executor instances reopening the same chat queue.
    this.flushing = navigator.locks.request('project-queue:' + this.store.name + ':' + this.store.chatId,
      () => this.drain()).finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }
  async write(root, path, bytes) {
    let dir = root;
    const parts = pathParts(path);
    for (const name of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(name, {
      create: true
    });
    const stream = await (await dir.getFileHandle(parts.at(-1), {
      create: true
    })).createWritable();
    try {
      await stream.write(bytes);
      await stream.close();
    } catch (error) {
      await stream.abort().catch(() => {});
      throw error;
    }
  }
  async preserveConflict(record, path) {
    for (const op of record.operations.filter(op => op.type === 'write')) {
      let copy = this.conflictPaths.get(op.path);
      if (!copy) {
        copy = 'conflict-' + crypto.randomUUID() + '-' + pathParts(op.path).at(-1).slice(-150);
        this.conflictPaths.set(op.path, copy);
      }
      await this.write(record.root, copy, op.bytes);
    }
    await this.store.put('project-conflict:' + record.id, {
      ...record,
      conflictPath: path,
      copies: [...this.conflictPaths.values()]
    });
    await this.store.completeProjectChange(record.id);
    this.conflict = Object.assign(new Error('Файл изменён другим чатом или извне: ' + path + '. Ваша версия сохранена: ' + [...this.conflictPaths.values()].join(', ') + '. В следующем блоке перечитай актуальные файлы и объедини данные; не перезаписывай их вслепую.'), {
      code: 'PROJECT_CONFLICT',
      conflictFiles: [...this.conflictPaths.values()]
    });
    throw this.conflict;
  }
  resetConflict() {
    this.conflict = null;
    this.conflictPaths.clear();
  }
  async drain() {
    let conflict;
    for (;;) {
      const queue = await this.store.get('project-write-queue') || [];
      if (!queue.length) {
        if (conflict) throw conflict;
        return;
      }
      const record = await this.store.get('project-change:' + queue[0]);
      assert(record, 'Повреждена очередь сохранения файлов');
      try {
        await navigator.locks.request('project-files:' + record.projectId, async () => {
          const {
            root,
            operations
          } = record;
          assert(await root.queryPermission({
            mode: 'readwrite'
          }) === 'granted', 'Нажмите «Доступ к папке»: записи Python сохранены и ожидают выгрузки');
          if (this.conflict) return this.preserveConflict(record, record.operations[0].path);
          // Preflight the batch before applying any of its effects. During replay,
          // an already-applied after version is accepted without repeating the write.
          const apply = [];
          for (const op of operations) {
            const actual = await diskVersion(root, op.path);
            if (op.type === 'mkdir' && (actual === null || actual?.startsWith('directory:'))) {
              apply.push(op);
              continue;
            }
            if (actual === op.after) continue;
            if (Object.hasOwn(op, 'expected') && actual !== op.expected) return this.preserveConflict(record, op.path);
            apply.push(op);
          }
          for (const op of apply) {
            if (op.type === 'write') await this.write(root, op.path, op.bytes);
            else {
              let dir = root;
              const parts = pathParts(op.path);
              try {
                for (const name of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(name, {
                  create: op.type === 'mkdir'
                });
                if (op.type === 'mkdir') await dir.getDirectoryHandle(parts.at(-1), {
                  create: true
                });
                else await dir.removeEntry(parts.at(-1), {
                  recursive: true
                });
              } catch (error) {
                if (!(op.type === 'remove' && error.name === 'NotFoundError')) throw error;
              }
            }
          }
          await this.store.completeProjectChange(record.id);
        });
      } catch (error) {
        if (error.code !== 'PROJECT_CONFLICT') throw error;
        conflict = error; // Drain/stage later writes of this script without blocking other chats.
      }
    }
  }
}
