// Opaque origin: no extension APIs, IndexedDB, directory handles or page commands.
let initialized = false;
const nonce = location.hash.slice(1);
window.addEventListener('message', event => {
  if (event.source !== parent || event.data?.type !== 'python-start' || event.data.nonce !== nonce || initialized || event.ports.length !== 1) return;
  initialized = true;
  const port = event.ports[0];
  let worker, url, finished = false;
  const cleanup = () => {
    finished = true;
    worker?.terminate();
    if (url) URL.revokeObjectURL(url);
  };
  const fail = error => {
    if (finished) return;
    port.postMessage({
      ok: false,
      error: 'Python: ' + (error?.message || String(error))
    });
    cleanup();
  };
  port.onmessage = e => {
    if (e.data?.type === 'cancel') cleanup();
  };
  port.start();
  window.addEventListener('securitypolicyviolation', e => fail(new Error('загрузка заблокирована политикой браузера (' + e.violatedDirective + ')')));
  try {
    const base = new URL('.', location.href).href;
    // Fixed packaged bootstrap only; no executable JavaScript from the model.
    const bootstrap = 'self.PSY_BASE=' + JSON.stringify(base) + ';importScripts(' + JSON.stringify(new URL('src/python-worker.js', base).href) + ');';
    url = URL.createObjectURL(new Blob([bootstrap], {
      type: 'text/javascript'
    }));
    worker = new Worker(url);
    worker.onmessage = e => {
      if (finished) return;
      port.postMessage(e.data);
      if (e.data.type !== 'python-progress' && e.data.type !== 'python-output') cleanup();
    };
    worker.onerror = e => fail(new Error(e.message || 'Worker не смог загрузить локальные файлы'));
    worker.onmessageerror = () => fail(new Error('не удалось прочитать сообщение Worker'));
    worker.postMessage({
      code: event.data.code,
      data: event.data.data,
      files: event.data.files || []
    });
  } catch (error) {
    fail(error);
  }
});
parent.postMessage({
  type: 'python-ready',
  nonce
}, '*');
