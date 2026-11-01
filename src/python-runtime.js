import {
  assert
} from './util.js';
/** Only code and explicit JSON data cross the MessageChannel into the opaque sandbox. */
export class PythonRuntime {
  async run(code, data, timeMs = 60000) {
    assert(!this.worker, 'Python уже выполняется');
    return new Promise((resolve, reject) => {
      const frame = document.createElement('iframe');
      frame.hidden = true;
      frame.sandbox = 'allow-scripts';
      frame.src = new URL('../python-sandbox.html', import.meta.url).href;
      const channel = new MessageChannel();
      this.worker = frame;
      let timer;
      const finish = (err, value) => {
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
        e.data.ok ? finish(null, e.data) : finish(new Error(e.data.error + '\n' + (e.data.stderr ||
          '')));
      };
      frame.onload = () => frame.contentWindow.postMessage({
        type: 'python-start',
        code,
        data
      }, '*', [channel.port2]);
      document.body.append(frame);
    });
  }
  cancel() {
    this.reject?.('Python прерван пользователем');
  }
}
