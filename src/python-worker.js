/* Persistent extension Worker: shared Python namespace, no native directory handle passed in. */
self.PSY_BASE = new URL('../', self.location.href).href;
const nativeFetch = self.fetch.bind(self),
  remoteWheels = new Map(),
  exported = new Map(),
  pendingExports = new Map();
let py, initialization, client, current, packageCount = 0,
  packagePhase;
const send = message => postMessage({
  ...message,
  requestId: current?.id
});
const phase = (next, detail) => {
  if (!current) return;
  const now = performance.now();
  current.timings[current.phase + 'Ms'] = (current.timings[current.phase + 'Ms'] || 0) + now - current.phaseAt;
  current.phase = next;
  current.phaseAt = now;
  send({
    type: 'python-progress',
    phase: next,
    ...(detail === undefined ? {} : {
      detail: JSON.stringify(detail)
    })
  });
};
self.addEventListener('unhandledrejection', event => {
  send({
    ok: false,
    fatal: true,
    error: 'Python: ' + String(event.reason),
    stdout: current?.stdout || '',
    stderr: current?.stderr || ''
  });
  event.preventDefault();
});
const instantiateBytes = WebAssembly.instantiate.bind(WebAssembly),
  instantiateStream = WebAssembly.instantiateStreaming?.bind(WebAssembly);
WebAssembly.instantiateStreaming = async (source, imports, options) => {
  try {
    const response = await source;
    if (!response.ok && response.status !== 0) throw new Error('Не удалось прочитать WASM: ' + response.status);
    if (instantiateStream && /^application\/wasm(?:;|$)/i.test(response.headers.get('Content-Type') || '')) {
      const backup = response.clone();
      try {
        return await instantiateStream(response, imports, options);
      } catch {
        return instantiateBytes(await backup.arrayBuffer(), imports, options);
      }
    }
    return await instantiateBytes(await response.arrayBuffer(), imports, options);
  } catch (error) {
    send({
      ok: false,
      fatal: true,
      error: 'Python: не удалось запустить WebAssembly: ' + error.message,
      stdout: '',
      stderr: ''
    });
    throw error;
  }
};
self.fetch = async (input, options = {}) => {
  const url = new URL(input?.url || String(input), self.PSY_BASE),
    vendor = new URL('vendor/pyodide/', self.PSY_BASE).href;
  const remote = url.href.startsWith(vendor) ? remoteWheels.get(decodeURIComponent(url.pathname.split('/').at(-1))) :
    !url.href.startsWith(self.PSY_BASE) ? url.href : null;
  if (!remote) return nativeFetch(input, options);
  if (String(options.method || input?.method || 'GET').toUpperCase() !== 'GET' || options.body || input?.body) throw new Error('Загрузчик разрешает только GET пакетов');
  if (packageCount++ === 0) packagePhase = current?.phase || 'packages';
  phase('packages', 'Запрашиваю ' + new URL(remote).pathname.split('/').filter(Boolean).at(-1));
  try {
    const result = await client.download(remote);
    const response = new Response(result.bytes, {
      headers: {
        'Content-Type': result.contentType
      }
    });
    Object.defineProperty(response, 'url', {
      value: remote
    });
    return response;
  } finally {
    if (--packageCount === 0) phase(packagePhase);
  }
};

function output(stream, text) {
  if (!current) return;
  const value = current[stream] + text + '\n';
  current[stream + 'Truncated'] ||= value.length > 50000;
  current[stream] = value.slice(0, 50000);
  if (performance.now() - current.lastOutput > 250) {
    send({
      type: 'python-output',
      stream,
      text: current[stream].slice(-4000)
    });
    current.lastOutput = performance.now();
  }
}
async function initialize() {
  phase('bootstrap');
  const {
    PythonPackages
  } = await import('./python-packages.js');
  client = new PythonPackages({
    fetcher: nativeFetch,
    onProgress: detail => phase('packages', detail)
  });
  await client.init();
  const vendor = new URL('vendor/pyodide/', self.PSY_BASE);
  const [lock, bundled] = await Promise.all([nativeFetch(new URL('pyodide-lock.json', vendor)).then(r => r.json()), nativeFetch(new URL('PACKAGES.json', vendor)).then(r => r.json())]);
  const local = new Set(Object.values(bundled).map(p => p.file_name));
  for (const p of Object.values(lock.packages))
    if ((p.file_name.endsWith('.whl') || p.package_type === 'shared_library') && !local.has(p.file_name)) remoteWheels.set(p.file_name, 'https://cdn.jsdelivr.net/pyodide/v0.27.7/full/' + p.file_name);
  phase('runtime');
  importScripts(new URL('pyodide.js', vendor).href);
  py = await loadPyodide({
    indexURL: vendor.href,
    stdout: s => output('stdout', s),
    stderr: s => output('stderr', s)
  });
  py.FS.mkdirTree('/results');
  py.FS.mkdirTree('/inputs');
}
async function collectFiles() {
  const files = [],
    pending = [];
  let bytes = 0;
  const walk = async path => {
    for (const name of py.FS.readdir(path)) {
      if (name === '.' || name === '..') continue;
      const p = path + '/' + name,
        st = py.FS.lstat(p);
      if (py.FS.isLink(st.mode)) throw new Error('Ссылки в результатах Python не поддерживаются');
      if (py.FS.isDir(st.mode)) {
        await walk(p);
        continue;
      }
      const content = py.FS.readFile(p),
        digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', content)), b => b.toString(16).padStart(2, '0')).join('');
      if (exported.get(p) === digest) continue;
      bytes += content.length;
      if (files.length >= 30 || content.length > 5000000 || bytes > 20000000) throw new Error('Лимит файлов Python');
      files.push({
        path: p.slice(9),
        bytes: content
      });
      pending.push([p, digest]);
    }
  };
  await walk('/results');
  return {
    files,
    pending
  };
}
onmessage = async ({
  data
}) => {
  if (data.type === 'ack') {
    for (const [path, digest] of pendingExports.get(data.requestId) || []) exported.set(path, digest);
    pendingExports.delete(data.requestId);
    return;
  }
  if (data.type !== 'run' || current) return;
  current = {
    id: data.requestId,
    phase: 'worker',
    phaseAt: performance.now(),
    timings: {},
    stdout: '',
    stderr: '',
    lastOutput: 0,
    lastProgress: 0
  };
  try {
    await (initialization ||= initialize());
    phase('packages');
    await py.loadPackagesFromImports(data.code);
    phase('inputs');
    const inputs = Object.create(null);
    let inputBytes = 0;
    if ((data.files || []).length > 20) throw new Error('Лимит входных файлов');
    for (const file of data.files || []) {
      if (!file.name || file.name.split('/').some(p => !p || p === '.' || p === '..') || file.name.includes('\\')) throw new Error('Недопустимое имя входного файла');
      inputBytes += file.bytes.length;
      if (file.bytes.length > 10000000 || inputBytes > 20000000) throw new Error('Лимит входных данных');
      const path = '/inputs/' + data.requestId + '/' + file.name;
      py.FS.mkdirTree(path.slice(0, path.lastIndexOf('/')));
      py.FS.writeFile(path, file.bytes);
      inputs[file.name] = path;
    }
    // Infrastructure lives outside the user's persistent namespace.
    py.globals.set('__agent_input_json', JSON.stringify(data.data || {}));
    py.globals.set('__agent_input_paths', JSON.stringify(inputs));
    py.globals.set('__agent_progress', text => {
      if (!current) return;
      if (performance.now() - current.lastProgress >= 250) {
        phase('running', JSON.parse(String(text)));
        current.lastProgress = performance.now();
      }
    });
    phase('running');
    await py.runPythonAsync(`
import json as __agent_json, os as __agent_os
__agent_os.environ['MPLBACKEND'] = 'Agg'
__agent_os.chdir('/results')
data = __agent_json.loads(__agent_input_json)
inputs = __agent_json.loads(__agent_input_paths)
result = None
def progress(value):
    __agent_progress(__agent_json.dumps(value, ensure_ascii=False, default=str))
`);
    await py.runPythonAsync(data.code);
    const result = JSON.parse(await py.runPythonAsync('__agent_json.dumps(result, ensure_ascii=False, allow_nan=False)'));
    phase('exporting');
    const {
      files,
      pending
    } = await collectFiles();
    current.timings[current.phase + 'Ms'] = (current.timings[current.phase + 'Ms'] || 0) + performance.now() - current.phaseAt;
    postMessage({
      requestId: current.id,
      ok: true,
      stdout: current.stdout,
      stderr: current.stderr,
      stdoutTruncated: !!current.stdoutTruncated,
      stderrTruncated: !!current.stderrTruncated,
      result,
      files,
      timings: current.timings
    }, files.map(file => file.bytes.buffer));
    pendingExports.set(data.requestId, pending);
  } catch (error) {
    current.timings[current.phase + 'Ms'] = (current.timings[current.phase + 'Ms'] || 0) + performance.now() - current.phaseAt;
    send({
      ok: false,
      fatal: !py,
      error: String(error),
      stdout: current.stdout,
      stderr: current.stderr,
      timings: current.timings
    });
  } finally {
    // No user namespace cleanup: this is intentionally a Jupyter-like session.
    current = null;
  }
};
