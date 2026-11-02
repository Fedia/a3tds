import {
  assert,
  pathParts
} from './util.js';
/** Only code and explicit JSON data cross the MessageChannel into the opaque sandbox. */
export class PythonRuntime {
  async run(code, data, timeMs = 60000, files = []) {
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
      const frame = document.createElement('iframe');
      frame.hidden = true;
      frame.sandbox = 'allow-scripts';
      frame.src = new URL('../python-sandbox.html', import.meta.url).href;
      const channel = new MessageChannel();
      this.worker = frame;
      let timer, settled = false;
      const finish = (err, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        channel.port1.postMessage({
          type: 'cancel'
        });
        channel.port1.close();
        frame.remove();
        this.worker = null;
        this.reject = null;
        err ? reject(err) : resolve(value);
      };
      this.reject = reason => finish(new Error(reason));
      timer = setTimeout(() => finish(new Error('Python: таймаут, Worker завершён')), timeMs);
      channel.port1.onmessage = e => {
        if (e.data.type === 'python-progress') {
          this.onProgress?.(e.data.phase);
          return;
        }
        if (!e.data.ok) { finish(new Error(e.data.error + '\n' + (e.data.stderr || ''))); return; }
        try {
          assert(Array.isArray(e.data.files) && e.data.files.length <= 30, 'Некорректный список результатов Python');
          let total = 0;
          for (const file of e.data.files) {
            pathParts(file.path);
            assert((file.bytes instanceof Uint8Array || Array.isArray(file.bytes)) && file.bytes.length <= 5000000,
              'Некорректный выходной файл Python');
            total += file.bytes.length;
          }
          assert(total <= 20000000, 'Выходные файлы Python больше 20 МБ');
          assert(typeof e.data.stdout === 'string' && typeof e.data.stderr === 'string', 'Некорректный вывод Python');
          finish(null,e.data);
        } catch (err) { finish(err); }
      };
      frame.onload = () => frame.contentWindow.postMessage({
        type: 'python-start',
        code,
        data,
        files
      }, '*', [channel.port2]);
      document.body.append(frame);
    });
  }
  cancel() {
    this.reject?.('Python прерван пользователем');
  }
}
