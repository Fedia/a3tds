/* Dedicated Worker. No handles, tokens or extension capabilities are passed in. */
self.addEventListener('unhandledrejection', event => {
  // Emscripten startup can reject an internal promise without rejecting loadPyodide.
  postMessage({
    ok: false,
    stdout: '',
    stderr: '',
    error: 'Python: ' + String(event.reason || 'ошибка загрузки среды')
  });
  event.preventDefault();
});
if (typeof WebAssembly !== 'object') throw new Error('Браузер не поддерживает WebAssembly для Python');
// Pyodide 0.27.7's streaming loader logs instantiation errors without rejecting
// its startup promise. Some extension hosts omit streaming or serve a wrong MIME.
// Instantiate the same packaged bytes with the standard WASM API in that case.
const instantiateBytes = WebAssembly.instantiate.bind(WebAssembly);
const instantiateStream = WebAssembly.instantiateStreaming?.bind(WebAssembly);
WebAssembly.instantiateStreaming = async (source, imports, options) => {
  try {
    const response = await source;
    if (!response.ok && response.status !== 0) throw new Error('Не удалось прочитать локальный WASM-файл: ' + response.status);
    if (instantiateStream && /^application\/wasm(?:;|$)/i.test(response.headers.get('Content-Type') || '')) {
      const backup = response.clone();
      try {
        return await instantiateStream(response, imports, options);
      } catch {
        return await instantiateBytes(await backup.arrayBuffer(), imports, options);
      }
    }
    return await instantiateBytes(await response.arrayBuffer(), imports, options);
  } catch (error) {
    postMessage({
      ok: false,
      stdout: '',
      stderr: '',
      error: 'Python: не удалось запустить WebAssembly: ' + error.message
    });
    throw error;
  }
};
const nativeFetch = self.fetch.bind(self);
const packageReplies = new Map(),
  remoteWheels = new Map();
let packageRequestId = 0,
  started = false;
// Python keeps its restrictive CSP. Only the parent package downloader has network access.
self.fetch = async (input, options = {}) => {
  const url = new URL(input?.url || String(input), self.PSY_BASE);
  const vendor = new URL('vendor/pyodide/', self.PSY_BASE).href;
  let remote = null;
  if (url.href.startsWith(vendor)) remote = remoteWheels.get(decodeURIComponent(url.pathname.split('/').at(-1)));
  else if (!url.href.startsWith(self.PSY_BASE)) remote = url.href;
  if (!remote) return nativeFetch(input, options);
  const method = String(options.method || input?.method || 'GET').toUpperCase();
  if (method !== 'GET' || options.body || input?.body) throw new Error('Загрузчик Python разрешает только скачивание пакетов');
  const id = ++packageRequestId;
  const reply = new Promise((resolve, reject) => packageReplies.set(id, {
    resolve,
    reject
  }));
  postMessage({
    type: 'python-package-request',
    id,
    url: remote
  });
  const message = await reply;
  const response = new Response(message.bytes, {
    status: 200,
    headers: {
      'Content-Type': message.contentType
    }
  });
  Object.defineProperty(response, 'url', {
    value: remote
  });
  return response;
};
postMessage({
  type: 'python-progress',
  phase: 'bootstrap'
});
importScripts(new URL('vendor/pyodide/pyodide.js', self.PSY_BASE).href);
let py;
onmessage = async ({
  data
}) => {
  if (data.type === 'python-package-response') {
    const waiting = packageReplies.get(data.id);
    if (waiting) {
      packageReplies.delete(data.id);
      data.ok ? waiting.resolve(data) : waiting.reject(new Error(data.error));
    }
    return;
  }
  if (started) return;
  started = true;
  let stdout = '',
    stderr = '',
    stdoutTruncated = false,
    stderrTruncated = false,
    lastOutput = 0,
    lastProgress = 0;
  try {
    postMessage({
      type: 'python-progress',
      phase: 'runtime'
    });
    const vendor = new URL('vendor/pyodide/', self.PSY_BASE);
    const [lock, bundled] = await Promise.all([nativeFetch(new URL('pyodide-lock.json', vendor)).then(r => r.json()), nativeFetch(new URL('PACKAGES.json', vendor)).then(r => r.json())]);
    const local = new Set(Object.values(bundled).map(p => p.file_name));
    for (const p of Object.values(lock.packages))
      if ((p.file_name.endsWith('.whl') || p.package_type === 'shared_library') && !local.has(p.file_name)) remoteWheels.set(p.file_name, 'https://cdn.jsdelivr.net/pyodide/v0.27.7/full/' + p.file_name);
    py = await loadPyodide({
      indexURL: new URL('vendor/pyodide/', self.PSY_BASE).href,
      stdout: s => {
        const v = stdout + s + '\n';
        stdoutTruncated ||= v.length > 50000;
        stdout = v.slice(0, 50000);
        if (Date.now() - lastOutput > 250) {
          postMessage({
            type: 'python-output',
            stream: 'stdout',
            text: stdout.slice(-4000)
          });
          lastOutput = Date.now();
        }
      },
      stderr: s => {
        const v = stderr + s + '\n';
        stderrTruncated ||= v.length > 50000;
        stderr = v.slice(0, 50000);
        if (Date.now() - lastOutput > 250) {
          postMessage({
            type: 'python-output',
            stream: 'stderr',
            text: stderr.slice(-4000)
          });
          lastOutput = Date.now();
        }
      }
    });
    postMessage({
      type: 'python-progress',
      phase: 'packages'
    });
    await py.loadPackagesFromImports(data.code);
    postMessage({
      type: 'python-progress',
      phase: 'inputs'
    });
    const inputs = Object.create(null);
    let inputBytes = 0;
    if ((data.files || []).length > 20) throw new Error('Лимит входных файлов');
    py.FS.mkdirTree('/inputs');
    for (const file of data.files || []) {
      if (!file.name || file.name.split('/').some(p => !p || p === '.' || p === '..') || file.name.includes('\\')) throw new Error('Недопустимое имя входного файла');
      inputBytes += file.bytes.length;
      if (file.bytes.length > 10000000 || inputBytes > 20000000) throw new Error('Лимит входных данных');
      const path = '/inputs/' + file.name;
      py.FS.mkdirTree(path.slice(0, path.lastIndexOf('/')));
      py.FS.writeFile(path, file.bytes);
      inputs[file.name] = path;
    }
    py.globals.set('input_paths', JSON.stringify(inputs));
    py.globals.set('input_json', JSON.stringify(data.data));
    py.globals.set('__agent_progress', text => {
      if (Date.now() - lastProgress >= 250) {
        postMessage({
          type: 'python-progress',
          phase: 'running',
          detail: String(text).slice(0, 2000)
        });
        lastProgress = Date.now();
      }
    });
    postMessage({
      type: 'python-progress',
      phase: 'running'
    });
    await py.runPythonAsync(`
import json, os, sys, traceback
os.environ['MPLBACKEND'] = 'Agg'
# A fresh worker per command: no prior task data or native filesystem mount.
os.mkdir('/results')
os.chdir('/results')
data = json.loads(input_json)
inputs = json.loads(input_paths)
result = None
def progress(value):
    __agent_progress(json.dumps(value, ensure_ascii=False, default=str))
`);
    await py.runPythonAsync(data.code);
    const result = await py.runPythonAsync('json.dumps(result, ensure_ascii=False, allow_nan=False)');
    postMessage({
      type: 'python-progress',
      phase: 'exporting'
    });
    const files = [];
    let outputBytes = 0;
    const walk = (path) => {
      for (const name of py.FS.readdir(path)) {
        if (name === '.' || name === '..') continue;
        const p = path + '/' + name;
        const st = py.FS.lstat(p);
        if (py.FS.isLink(st.mode)) throw new Error('Ссылки в результатах Python не поддерживаются');
        if (py.FS.isDir(st.mode)) walk(p);
        else {
          outputBytes += st.size;
          if (files.length >= 30 || st.size > 5000000 || outputBytes > 20000000) throw new Error('Лимит файлов Python');
          files.push({
            path: p.slice(9),
            bytes: py.FS.readFile(p)
          });
        }
      }
    };
    walk('/results');
    postMessage({
      ok: true,
      stdout,
      stderr,
      stdoutTruncated,
      stderrTruncated,
      result: JSON.parse(result),
      files
    });
  } catch (e) {
    postMessage({
      ok: false,
      stdout,
      stderr,
      error: String(e)
    });
  }
};
