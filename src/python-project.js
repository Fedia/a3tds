import {
  pathParts
} from './util.js';

/** Track actual Emscripten writes, not a destructive full-directory sync back to disk. */
export class PythonProject {
  constructor(py, emit) {
    this.py = py;
    this.fs = py.FS;
    this.emit = emit;
    this.dirty = new Set();
    this.muted = 0;
    this.installHooks();
  }
  async refresh(handle) {
    this.muted++;
    try {
      if (!this.mounted) {
        await this.py.mountNativeFS('/project', handle);
        this.mounted = true;
      } else {
        // NativeFS normally compares mtimes. Always pull authoritative disk bytes:
        // another interpreter may write in the same millisecond, or Python may
        // have set a future mtime in its cached filesystem.
        const invalidate = path => {
          for (const name of this.fs.readdir(path)) {
            if (name === '.' || name === '..') continue;
            const child = path + '/' + name;
            if (this.fs.isDir(this.fs.lstat(child).mode)) invalidate(child);
            this.fs.utime(child, -1, -1);
          }
        };
        invalidate('/project');
        await new Promise((resolve, reject) => this.fs.syncfs(true, error => error ? reject(error) : resolve()));
      }
      this.dirty.clear();
    } finally {
      this.muted--;
    }
  }
  relative(path) {
    if (!path.startsWith('/project/')) return null;
    const relative = path.slice(9);
    pathParts(relative);
    return relative;
  }
  quiet(work) {
    this.muted++;
    try {
      return work();
    } finally {
      this.muted--;
    }
  }
  snapshot(path, operations = []) {
    const relative = this.relative(path);
    if (!relative) return operations;
    const stat = this.fs.lstat(path);
    if (this.fs.isLink(stat.mode)) throw new Error('Символические ссылки в папке проекта не поддерживаются');
    if (this.fs.isDir(stat.mode)) {
      operations.push({
        type: 'mkdir',
        path: relative
      });
      for (const name of this.fs.readdir(path))
        if (name !== '.' && name !== '..') this.snapshot(path + '/' + name, operations);
    } else operations.push({
      type: 'write',
      path: relative,
      bytes: this.fs.readFile(path)
    });
    return operations;
  }
  publish(path) {
    const operations = this.quiet(() => this.snapshot(path));
    if (operations.length) this.emit(operations);
  }
  flush() {
    for (const node of [...this.dirty]) {
      this.dirty.delete(node);
      const path = this.fs.getPath(node);
      if (this.relative(path) && this.fs.analyzePath(path).exists) this.publish(path);
    }
  }
  installHooks() {
    const fs = this.fs,
      self = this;
    const wrap = (name, after) => {
      const original = fs[name];
      fs[name] = function(...args) {
        const result = original.apply(this, args);
        if (!self.muted) after(args, result);
        return result;
      };
    };
    wrap('open', (_, stream) => {
      if ((stream.flags & 3) !== 0 && self.relative(fs.getPath(stream.node))) self.dirty.add(stream.node);
    });
    wrap('write', ([stream]) => {
      if (self.relative(fs.getPath(stream.node))) {
        self.dirty.add(stream.node);
        // Python flush(), os.write() and binary libraries reach this boundary.
        self.publish(fs.getPath(stream.node));
        self.dirty.delete(stream.node);
      }
    });
    wrap('close', ([stream]) => {
      if (self.dirty.delete(stream.node) && self.relative(fs.getPath(stream.node))) self.publish(fs.getPath(stream.node));
    });
    wrap('mkdir', ([path]) => {
      if (self.relative(path)) self.emit([{
        type: 'mkdir',
        path: self.relative(path)
      }]);
    });
    for (const method of ['unlink', 'rmdir']) wrap(method, ([path]) => {
      if (self.relative(path)) self.emit([{
        type: 'remove',
        path: self.relative(path)
      }]);
    });
    wrap('rename', ([from, to]) => {
      if (from === to) return;
      const operations = self.quiet(() => self.snapshot(to));
      if (self.relative(from)) operations.push({
        type: 'remove',
        path: self.relative(from)
      });
      if (operations.length) self.emit(operations);
    });
    wrap('truncate', ([node]) => {
      const path = typeof node === 'string' ? node : fs.getPath(node);
      if (self.relative(path)) self.publish(path);
    });
  }
}
