import {
  assert
} from './util.js';

/** One lazily created, reusable extension Worker. Python shares this extension's origin. */
export class PythonRuntime {
  constructor(sync) {
    this.sync = sync;
    this.writes = Promise.resolve();
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
  async flush() {
    const previousError = await this.writes.then(() => null, error => error);
    await this.sync?.flush();
    if (previousError && !previousError.staged) throw previousError;
  }
  queueChanges(root, operations, onFiles) {
    // Keep staging later records even if an earlier export needs renewed permission.
    this.writes = this.writes.catch(() => {}).then(async () => {
      assert(this.sync, 'Не подключена очередь сохранения проекта');
      await this.sync.submit(root, operations);
      await onFiles?.(operations);
    });
    this.writes.catch(() => {});
  }
  async run(code, timeMs = null) {
    assert(!this.running, 'Python уже выполняется');
    assert(this.project?.kind === 'directory', 'Выберите папку проекта');
    assert(typeof code === 'string' && code.trim(), 'Пустой Python-код');
    const generation = this.generation || 0;
    await this.flush();
    assert(generation === (this.generation || 0), 'Запуск Python отменён');
    assert(!this.running, 'Python уже выполняется');
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
      let browserBusy = false;
      this.receive = async message => {
        if (message.fatal && !message.requestId) {
          finish(new Error(message.error), null, true);
          return;
        }
        if (message.requestId !== requestId) return;
        if (message.type === 'project-change') {
          this.queueChanges(this.project, message.operations, this.onFiles);
          return;
        }
        if (message.type === 'python-browser') {
          const worker = this.worker;
          let reply;
          if (browserBusy) {
            worker.postMessage({
              type: 'browser-result',
              callId: message.callId,
              reply: {
                ok: false,
                error: 'Параллельные браузерные вызовы не поддерживаются'
              }
            });
            return;
          }
          try {
            browserBusy = true;
            await this.flush();
            assert(!settled && this.worker === worker, 'Сценарий остановлен');
            assert(this.callBrowser, 'Браузер не подключён');
            reply = {
              ok: true,
              data: await this.callBrowser(message.method, message.args, message.callId)
            };
          } catch (error) {
            reply = {
              ok: false,
              error: error.message
            };
          } finally {
            browserBusy = false;
          }
          if (!settled && this.worker === worker) worker.postMessage({
            type: 'browser-result',
            callId: message.callId,
            reply
          });
          return;
        }
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
        try {
          await this.flush();
          if (settled) return;
          if (!message.ok) {
            const error = new Error(message.error || 'Python не вернул результат');
            error.timings = message.timings;
            error.stdout = message.stdout;
            error.stderr = message.stderr;
            this.ready = !message.fatal;
            finish(error, null, message.fatal);
          } else {
            assert(typeof message.stdout === 'string' && typeof message.stderr === 'string', 'Некорректный вывод Python');
            this.ready = true;
            finish(null, message);
          }
        } catch (error) {
          error.code = 'PROJECT_SYNC_FAILED';
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
          project: this.project
        });
      } catch (error) {
        finish(error, null, true);
      }
    });
  }
  reset(reason = 'Python-сессия сброшена') {
    this.generation = (this.generation || 0) + 1;
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
