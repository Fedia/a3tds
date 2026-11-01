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
result = None
exec(compile(user_code, '<agent>', 'exec'), globals())
json.dumps(result, ensure_ascii=False, allow_nan=False)
`);
    const files = [];
    const walk = (path) => {
      for (const name of py.FS.readdir(path)) {
        if (name === '.' || name === '..') continue;
        const p = path + '/' + name;
        const st = py.FS.stat(p);
        if (py.FS.isDir(st.mode)) walk(p);
        else {
          if (files.length >= 30 || st.size > 5000000) throw new Error('Лимит файлов Python');
          files.push({
            path: p.slice(9),
            bytes: Array.from(py.FS.readFile(p))
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
