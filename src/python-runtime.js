import {
  assert,
  pathParts
} from './util.js';
/** Only code and explicit data cross the channel into the opaque sandbox. */
export class PythonRuntime {
  constructor() {
    // No automatic deadline: the agent monitors the job and can cancel explicitly.
    // Finite values remain available for diagnostic tests, never imposed on tasks.
    this.frameMs = Infinity;
    this.workerMs = Infinity;
    this.startupMs = Infinity;
  }
  async run(code, data, timeMs = null, files = []) {
    assert(!this.worker, 'Python уже выполняется');
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
    return new Promise((resolve, reject) => {
      const frame = document.createElement('iframe'),
        channel = new MessageChannel();
      const nonce = crypto.randomUUID(),
        url = new URL('../python-sandbox.html', import.meta.url);
      url.hash = nonce;
      frame.hidden = true;
      frame.sandbox = 'allow-scripts';
      frame.src = url.href;
      this.worker = frame;
      const startupDeadline = Date.now() + this.startupMs;
      let timer, settled = false,
        connected = false,
        phase = 'sandbox',
        executionDeadline = null;
      const finish = (err, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        window.removeEventListener('message', ready);
        try {
          channel.port1.postMessage({
            type: 'cancel'
          });
        } catch {}
        channel.port1.close();
        channel.port2.close();
        frame.remove();
        this.worker = null;
        this.reject = null;
        if (err) {
          err.pythonPhase = phase;
          if (executionDeadline === null) err.definite = true;
        }
        err ? reject(err) : resolve(value);
      };
      const arm = (ms, message) => {
        clearTimeout(timer);
        if (!Number.isFinite(ms)) return;
        timer = setTimeout(() => {
          const error = new Error(message);
          error.code = executionDeadline === null ? 'PYTHON_STARTUP_TIMEOUT' : 'PYTHON_EXECUTION_TIMEOUT';
          finish(error);
        }, Math.max(0, ms));
      };
      const progress = (next, detail) => {
        if (settled) return;
        phase = next;
        if (next === 'running' && executionDeadline === null) executionDeadline = timeMs === null ? Infinity : Date.now() + timeMs;
        if (executionDeadline !== null) {
          if (Number.isFinite(executionDeadline)) arm(executionDeadline - Date.now(), 'Python: истекло заданное время выполнения кода, Worker завершён');
          else clearTimeout(timer);
        } else {
          const remaining = startupDeadline - Date.now();
          const budget = next === 'sandbox' ? this.frameMs : next === 'worker' ? this.workerMs : remaining;
          const detail = {
            sandbox: 'не ответила изолированная среда',
            worker: 'не запустился Worker',
            bootstrap: 'не загрузились файлы среды',
            runtime: 'не загрузился интерпретатор',
            packages: 'не загрузились библиотеки',
            inputs: 'не подготовлены данные'
          } [next] || 'не завершилась подготовка';
          arm(Math.min(budget, remaining), 'Python: ' + detail + '. Выполнение кода не начиналось.');
        }
        try {
          Promise.resolve(this.onProgress?.(next, detail)).catch(() => {});
        } catch {}
      };
      const ready = event => {
        if (settled || connected || event.source !== frame.contentWindow || event.data?.type !== 'python-ready' || event.data.nonce !== nonce) return;
        connected = true;
        progress('worker');
        try {
          frame.contentWindow.postMessage({
            type: 'python-start',
            nonce,
            code,
            data,
            files
          }, '*', [channel.port2]);
        } catch (error) {
          finish(error);
        }
      };
      this.reject = reason => finish(new Error(reason));
      window.addEventListener('message', ready);
      channel.port1.onmessage = event => {
        if (settled) return;
        const message = event.data;
        if (message?.type === 'python-progress') {
          if (['bootstrap', 'runtime', 'packages', 'inputs', 'running', 'exporting'].includes(message.phase)) progress(message.phase, message.detail);
          return;
        }
        if (message?.type === 'python-output') {
          try {
            Promise.resolve(this.onOutput?.({
              stream: message.stream === 'stderr' ? 'stderr' : 'stdout',
              text: String(message.text).slice(-4000)
            })).catch(() => {});
          } catch {}
          return;
        }
        if (!message?.ok) {
          finish(new Error((message?.error || 'Python не вернул результат') + '\n' + (message?.stderr || '')));
          return;
        }
        try {
          assert(Array.isArray(message.files) && message.files.length <= 30, 'Некорректный список результатов Python');
          let bytes = 0;
          for (const file of message.files) {
            pathParts(file.path);
            assert((file.bytes instanceof Uint8Array || Array.isArray(file.bytes)) && file.bytes.length <= 5000000, 'Некорректный выходной файл Python');
            bytes += file.bytes.length;
          }
          assert(bytes <= 20000000, 'Выходные файлы Python больше 20 МБ');
          assert(typeof message.stdout === 'string' && typeof message.stderr === 'string', 'Некорректный вывод Python');
          finish(null, message);
        } catch (error) {
          finish(error);
        }
      };
      frame.onerror = () => finish(new Error('Не удалось открыть изолированную среду Python'));
      progress('sandbox');
      if (!settled) document.body.append(frame);
    });
  }
  cancel() {
    this.reject?.('Python прерван пользователем');
  }
}
