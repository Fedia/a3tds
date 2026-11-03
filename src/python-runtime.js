import {
  assert,
  pathParts
} from './util.js';

/** One lazily created, reusable extension Worker. Python shares this extension's origin. */
export class PythonRuntime {
  constructor() {
    this.startupMs = Infinity;
    this.workerMs = Infinity;
    this.sessionId = null;
    this.running = false;
  }
  async bindScope(chatURL, project) {
    const epoch = this.scopeEpoch = (this.scopeEpoch || 0) + 1;
    const sameChat = !this.chatURL || this.chatURL === chatURL || ['/', '/a/chat', '/a/chat/'].includes(new URL(this.chatURL).pathname);
    const sameProject = !this.project || this.project === project ||
      !!(project && this.project.isSameEntry && await this.project.isSameEntry(project));
    if (epoch !== this.scopeEpoch) return;
    if (!sameChat || !sameProject) this.reset('Изменён чат или папка');
    this.chatURL = chatURL;
    this.project = project;
  }
  async run(code, data = {}, timeMs = null, files = []) {
    assert(!this.running, 'Python уже выполняется');
    assert(Array.isArray(files) && files.length <= 20, 'Слишком много входных файлов');
    let total = 0;
    const names = [];
    for (const file of files) {
      pathParts(file.name);
      assert(file.bytes instanceof Uint8Array && file.bytes.length <= 10000000, 'Недопустимый входной файл');
      assert(!names.some(name => name === file.name || name.startsWith(file.name + '/') || file.name.startsWith(name + '/')), 'Конфликт имён входных файлов');
      names.push(file.name);
      total += file.bytes.length;
    }
    assert(total <= 20000000, 'Входные файлы больше 20 МБ');
    const reused = !!this.ready;
    if (!this.worker) {
      this.sessionId = crypto.randomUUID();
      try {
        this.worker = new Worker(new URL('./python-worker.js', import.meta.url));
      } catch (error) {
        this.sessionId = null;
        error.pythonPhase = 'worker';
        error.definite = true;
        throw error;
      }
      this.worker.onmessage = event => {
        if (event.data?.fatal && !this.running) this.reset('Python Worker завершился');
        else this.receive?.(event.data);
      };
      this.worker.onerror = event => {
        const error = new Error('Python Worker: ' + event.message);
        this.fail ? this.fail(error, true) : this.reset(error.message);
      };
      this.worker.onmessageerror = () => {
        const error = new Error('Python: повреждён ответ Worker');
        this.fail ? this.fail(error, true) : this.reset(error.message);
      };
    }
    this.running = true;
    const sessionId = this.sessionId,
      requestId = crypto.randomUUID(),
      started = performance.now();
    return new Promise((resolve, reject) => {
      let phase = 'worker',
        timer, settled = false,
        codeStarted = null;
      const finish = (error, value, fatal = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.running = false;
        this.receive = null;
        this.fail = null;
        if (fatal) {
          this.worker?.terminate();
          this.worker = null;
          this.ready = false;
          this.sessionId = null;
        }
        if (error) {
          error.pythonPhase = phase;
          error.sessionId = sessionId;
          error.sessionReused = reused;
          error.definite = codeStarted === null;
          reject(error);
        } else resolve({
          ...value,
          sessionId,
          sessionReused: reused,
          elapsedMs: performance.now() - started
        });
      };
      const progress = (next, detail) => {
        phase = next;
        if (next === 'running' && codeStarted === null) codeStarted = performance.now();
        clearTimeout(timer);
        const remaining = codeStarted === null ? Math.min(this.startupMs - (performance.now() - started), next === 'worker' ? this.workerMs : Infinity) :
          timeMs === null ? Infinity : timeMs - (performance.now() - codeStarted);
        if (Number.isFinite(remaining)) timer = setTimeout(() => {
          const error = new Error('Python: истекло заданное диагностическое время (' + phase + ')');
          error.code = codeStarted === null ? 'PYTHON_STARTUP_TIMEOUT' : 'PYTHON_EXECUTION_TIMEOUT';
          finish(error, null, true);
        }, Math.max(0, remaining));
        try {
          Promise.resolve(this.onProgress?.(next, detail)).catch(() => {});
        } catch {}
      };
      this.fail = (error, fatal = true) => finish(error, null, fatal);
      this.receive = message => {
        if (message.fatal && !message.requestId) {
          finish(new Error(message.error), null, true);
          return;
        }
        if (message.requestId !== requestId) return;
        if (message.type === 'python-progress') {
          progress(message.phase, message.detail);
          return;
        }
        if (message.type === 'python-output') {
          try {
            Promise.resolve(this.onOutput?.({
              stream: message.stream,
              text: String(message.text).slice(-4000)
            })).catch(() => {});
          } catch {}
          return;
        }
        if (!message.ok) {
          const error = new Error(message.error || 'Python не вернул результат');
          error.timings = message.timings;
          error.stdout = message.stdout;
          error.stderr = message.stderr;
          this.ready = !message.fatal;
          finish(error, null, message.fatal);
          return;
        }
        try {
          assert(Array.isArray(message.files) && message.files.length <= 30, 'Некорректный список результатов Python');
          let bytes = 0;
          for (const file of message.files) {
            pathParts(file.path);
            assert(file.bytes instanceof Uint8Array && file.bytes.length <= 5000000, 'Некорректный выходной файл Python');
            bytes += file.bytes.length;
          }
          assert(bytes <= 20000000 && typeof message.stdout === 'string' && typeof message.stderr === 'string', 'Некорректный вывод Python');
          this.ready = true;
          finish(null, message);
        } catch (error) {
          finish(error, null, true);
        }
      };
      progress('worker');
      if (settled) return;
      try {
        this.worker.postMessage({
          type: 'run',
          requestId,
          code,
          data,
          files
        }, [...new Set(files.map(file => file.bytes.buffer))]);
      } catch (error) {
        finish(error, null, true);
      }
    });
  }
  acknowledge(requestId) {
    this.worker?.postMessage({
      type: 'ack',
      requestId
    });
  }
  reset(reason = 'Python-сессия сброшена') {
    const previousSessionId = this.sessionId;
    this.fail?.(new Error(reason), true);
    this.worker?.terminate();
    this.worker = null;
    this.ready = false;
    this.sessionId = null;
    return {
      status: 'reset',
      previousSessionId
    };
  }
  cancel() {
    return this.reset('Python прерван пользователем');
  }
}
