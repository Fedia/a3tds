/* Persistent, sequential Python interpreter with a mounted project and browser RPC. */
self.AGENT_BASE = new URL('../', self.location.href).href;
const nativeFetch = self.fetch.bind(self),
  remoteWheels = new Map(),
  browserReplies = new Map();
let py, initialization, client, current, initialized = false, packageCount = 0,
  packagePhase, project, sequence = 0;
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
  const url = new URL(input?.url || String(input), self.AGENT_BASE),
    vendor = new URL('vendor/pyodide/', self.AGENT_BASE).href;
  const remote = url.href.startsWith(vendor) ? remoteWheels.get(decodeURIComponent(url.pathname.split('/').at(-1))) :
    !url.href.startsWith(self.AGENT_BASE) ? url.href : null;
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
  const vendor = new URL('vendor/pyodide/', self.AGENT_BASE);
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
  const {
    PythonProject
  } = await import('./python-project.js');
  project = new PythonProject(py, operations => {
    send({
      type: 'project-change',
      operations
    });
  });
  const api = await nativeFetch(new URL('src/agent-api.py', self.AGENT_BASE)).then(r => r.text());
  py.globals.set('__agent_api_source', api);
  py.globals.set('__agent_rpc', async (method, argsJSON) => {
    project.flush();
    const callId = ++sequence;
    return await new Promise(resolve => {
      browserReplies.set(callId, resolve);
      send({
        type: 'python-browser',
        callId,
        method,
        args: JSON.parse(argsJSON)
      });
    });
  });
  py.globals.set('__agent_progress', text => {
    if (current && performance.now() - current.lastProgress >= 250) {
      phase('running', JSON.parse(String(text)));
      current.lastProgress = performance.now();
    }
  });
  py.runPython("exec(compile(__agent_api_source, '<agent-api>', 'exec'), {'_agent_rpc': __agent_rpc, '_agent_progress': __agent_progress})");
  py.globals.delete('__agent_api_source');
  initialized = true;
}
onmessage = async ({
  data
}) => {
  if (data.type === 'browser-result') {
    browserReplies.get(data.callId)?.(JSON.stringify(data.reply));
    browserReplies.delete(data.callId);
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
    // Compile BEFORE imports, mount or user side effects; keep top-level await.
    py.globals.set('__agent_code', data.code);
    py.runPython("import ast as __agent_ast; compile(__agent_code, '<agent-script>', 'exec', flags=__agent_ast.PyCF_ALLOW_TOP_LEVEL_AWAIT)");
    phase('packages');
    await py.loadPackagesFromImports(data.code);
    phase('inputs');
    if (!data.project) throw new Error('Выберите папку проекта');
    await project.refresh(data.project);
    phase('running');
    await py.runPythonAsync(`
import json as __agent_json, os as __agent_os
__agent_os.environ['MPLBACKEND'] = 'Agg'
__agent_os.chdir('/project')
result = None
from agent import browser, progress
`);
    await py.runPythonAsync(data.code, {
      filename: '<agent-script>'
    });
    let result;
    try {
      result = JSON.parse(py.runPython('__agent_json.dumps(result, ensure_ascii=False, allow_nan=False)'));
    } catch (error) {
      throw new Error('Переменная result должна быть JSON-совместимой: ' + error);
    }
    phase('exporting');
    project.flush();
    current.timings[current.phase + 'Ms'] = (current.timings[current.phase + 'Ms'] || 0) + performance.now() - current.phaseAt;
    send({
      ok: true,
      stdout: current.stdout,
      stderr: current.stderr,
      stdoutTruncated: !!current.stdoutTruncated,
      stderrTruncated: !!current.stderrTruncated,
      result,
      timings: current.timings
    });
  } catch (error) {
    try {
      project?.flush();
    } catch (syncError) {
      error = new Error(String(error) + '\nСохранение: ' + syncError);
    }
    current.timings[current.phase + 'Ms'] = (current.timings[current.phase + 'Ms'] || 0) + performance.now() - current.phaseAt;
    send({
      ok: false,
      fatal: !initialized || current.phase === 'inputs',
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
