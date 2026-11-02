/* Dedicated Worker. No handles, tokens or extension capabilities are passed in. */
importScripts(new URL('vendor/pyodide/pyodide.js', self.PSY_BASE).href);
let py;
onmessage = async ({
  data
}) => {
  let stdout = '',
    stderr = '',
    stdoutTruncated = false,
    stderrTruncated = false;
  try {
    py = await loadPyodide({
      indexURL: new URL('vendor/pyodide/', self.PSY_BASE).href,
      stdout: s => {
        const v = stdout + s + '\n';
        stdoutTruncated ||= v.length > 50000;
        stdout = v.slice(0, 50000);
      },
      stderr: s => {
        const v = stderr + s + '\n';
        stderrTruncated ||= v.length > 50000;
        stderr = v.slice(0, 50000);
      }
    });
    await py.loadPackage(['numpy', 'pandas', 'matplotlib']);
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
    py.globals.set('user_code', data.code);
    postMessage({
      type: 'python-progress',
      phase: 'running'
    });
    const result = await py.runPythonAsync(`
import json, os, sys, traceback
import matplotlib
matplotlib.use('Agg')
# A fresh worker per command: no prior task data or native filesystem mount.
os.mkdir('/results')
os.chdir('/results')
data = json.loads(input_json)
inputs = json.loads(input_paths)
result = None
exec(compile(user_code, '<agent>', 'exec'), globals())
json.dumps(result, ensure_ascii=False, allow_nan=False)
`);
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
