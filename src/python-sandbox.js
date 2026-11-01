// Opaque-origin sandbox: no extension APIs, IndexedDB or directory handles.
let initialized = false;
window.addEventListener('message', e => {
  if (e.source !== parent || e.data?.type !== 'python-start' || initialized || e.ports.length !== 1)
    return;
  initialized = true;
  const port = e.ports[0];
  const base = new URL('.', location.href).href;
  // Bootstrap contains only packaged URLs, never model-provided executable JS.
  const bootstrap = 'self.PSY_BASE=' + JSON.stringify(base) + ';importScripts(' + JSON.stringify(new URL(
    'src/python-worker.js', base).href) + ');';
  const url = URL.createObjectURL(new Blob([bootstrap], {
    type: 'text/javascript'
  }));
  const worker = new Worker(url);
  worker.onmessage = event => {
    port.postMessage(event.data);
    if (event.data.type === 'python-progress') return;
    worker.terminate();
    URL.revokeObjectURL(url);
  };
  worker.onerror = event => {
    port.postMessage({
      ok: false,
      error: event.message
    });
    worker.terminate();
    URL.revokeObjectURL(url);
  };
  port.onmessage = event => {
    if (event.data?.type === 'cancel') {
      worker.terminate();
      URL.revokeObjectURL(url);
    }
  };
  port.start();
  worker.postMessage({
    code: e.data.code,
    data: e.data.data
  });
});
