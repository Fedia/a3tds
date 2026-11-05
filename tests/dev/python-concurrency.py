"""Actual sequential Worker, Pyodide and OPFS under manifest CSP; no installed extension."""
from pathlib import Path
import asyncio,functools,json,os,shutil,threading
from http.server import ThreadingHTTPServer,SimpleHTTPRequestHandler
from playwright.async_api import async_playwright
ROOT=Path(__file__).resolve().parents[2]
MANIFEST=json.loads((ROOT/'manifest.json').read_text())
class Handler(SimpleHTTPRequestHandler):
 def log_message(self,*args):pass
 def end_headers(self):
  self.send_header('Content-Security-Policy',MANIFEST['content_security_policy']['extension_pages']);super().end_headers()
server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(ROOT)))
threading.Thread(target=server.serve_forever,daemon=True).start();BASE=f'http://127.0.0.1:{server.server_port}/'
async def main():
 async with async_playwright() as p:
  browser=await p.chromium.launch(executable_path=os.environ.get('CHROMIUM_BIN') or shutil.which('chromium'),args=['--no-sandbox'])
  page=await browser.new_page();await page.goto(BASE+'fixtures/article.html')
  await page.evaluate("""async()=>{
   const {PythonRuntime}=await import('/src/python-runtime.js'),{ProjectSync}=await import('/src/project-sync.js'),{StateStore}=await import('/src/state-store.js');
   const store=await new StateStore('concurrent-python-test').init();window.root=await(await navigator.storage.getDirectory()).getDirectoryHandle('shared',{create:true});
   const stream=await(await root.getFileHandle('shared.txt',{create:true})).createWritable();await stream.write('seed');await stream.close();
   window.a=new PythonRuntime(new ProjectSync(store.forChat('A')));window.b=new PythonRuntime(new ProjectSync(store.forChat('B')));
   await a.bindScope('https://chat.deepseek.com/a/chat/A',root);await b.bindScope('https://chat.deepseek.com/a/chat/B',root);
   window.read=async name=>(await(await root.getFileHandle(name)).getFile()).text();
  }""")
  await page.evaluate("Promise.all([a.run('from pathlib import Path\\nimport os\\nowner=\"A\"'),b.run('from pathlib import Path\\nowner=\"B\"')])")
  session_b=await page.evaluate('b.sessionId')
  await page.evaluate("a.run('os.utime(\"shared.txt\",(10000000000,10000000000))')")
  await page.evaluate("b.run('Path(\"shared.txt\").write_text(\"latest\")')")
  assert (await page.evaluate("a.run('result=Path(\"shared.txt\").read_text()')"))['result']=='latest'
  print('PASS: independent persistent Workers; forced NativeFS pull sees other chat updates even after future cached mtime',flush=True)
  await page.evaluate("""()=>{window.entered=false; a.callBrowser=async()=>{window.entered=true;return await new Promise(resolve=>window.release=()=>resolve({ready:true}))};window.changed=[];a.onFiles=ops=>changed.push(...ops.map(op=>op.path));}""")
  code='from agent import browser\nold=Path("shared.txt").read_text()\nawait browser.read()\nPath("shared.txt").write_text(old+"|A")'
  await page.evaluate("code=>{window.pending=a.run(code).then(r=>({ok:true}),e=>({ok:false,code:e.code,error:e.message}))}",code)
  await page.wait_for_function('()=>window.entered===true')
  await page.evaluate("b.run('Path(\"shared.txt\").write_text(\"latest|B\")')")
  await page.evaluate('release()');conflict=await page.evaluate('pending')
  assert not conflict['ok'] and conflict['code']=='PROJECT_CONFLICT',conflict
  assert await page.evaluate('read("shared.txt")')=='latest|B'
  copy=next(path for path in await page.evaluate('changed') if path.startswith('conflict-'))
  assert await page.evaluate('name=>read(name)',copy)=='latest|A'
  assert await page.evaluate('b.sessionId')==session_b
  print('PASS: stale Python write returns PROJECT_CONFLICT, preserves latest disk bytes and own full conflict copy; other Worker stays alive',flush=True)
  code='from pathlib import Path\nactual=Path("shared.txt").read_text()\ncopy=Path('+repr(copy)+').read_text()\nPath("shared.txt").write_text(actual+"|"+copy.split("|")[-1])\nresult=Path("shared.txt").read_text()'
  assert (await page.evaluate('code=>a.run(code)',code))['result']=='latest|B|A'
  assert (await page.evaluate("b.run('result=owner')"))['result']=='B'
  print('PASS: next Python block rereads actual/conflict files with stdlib and merges successfully without user confirmation',flush=True)
  await page.evaluate("Promise.all([a.run('Path(\"same.txt\").write_text(\"identical\")'),b.run('Path(\"same.txt\").write_text(\"identical\")')])")
  assert await page.evaluate('read("same.txt")')=='identical'
  print('PASS: identical concurrent writes are idempotent, distinct chat queues do not deadlock',flush=True)
  await page.evaluate('a.reset();b.reset()');await browser.close()
asyncio.run(main());server.shutdown()
