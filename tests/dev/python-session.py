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
  page=await browser.new_page();requests=[];page.on('request',lambda r:requests.append(r.url));page.on('console',lambda m: print(m.type,m.text[:500]) if m.type=='error' else None)
  await page.goto(BASE+'fixtures/article.html')
  await page.evaluate('''async()=>{
    const {PythonRuntime}=await import('/src/python-runtime.js');
    const {ProjectSync}=await import('/src/project-sync.js');
    const {StateStore}=await import('/src/state-store.js');
    window.store=await new StateStore('python-session-test').init();
    window.root=await(await navigator.storage.getDirectory()).getDirectoryHandle('project',{create:true});
    window.runtime=new PythonRuntime(new ProjectSync(store));
    await runtime.bindScope('https://chat.deepseek.com/a/chat/one',root);
    window.events=[];runtime.onProgress=(phase,detail)=>events.push({phase,detail});
    window.run=code=>runtime.run(code);
    window.read=async path=>(await(await root.getFileHandle(path)).getFile()).text();
  }''')
  first=await page.evaluate('''run('import os, pandas as pd\\nfrom pathlib import Path\\nassert os.getcwd()=="/project"\\ndf=pd.DataFrame({"x":[1,2,3]})\\nPath("saved.txt").write_text("one")\\nresult=int(df.x.sum())')''')
  assert first['result']==6 and not first['sessionReused'],first
  assert await page.evaluate('read("saved.txt")')=='one'
  count=len(requests)
  second=await page.evaluate('''run('result={"sum":int(df.x.sum()),"text":open("saved.txt").read()}')''')
  assert second['result']=={'sum':6,'text':'one'} and second['sessionId']==first['sessionId'] and second['sessionReused'],second
  assert not any('.whl' in u or '.wasm' in u or 'pyodide.js' in u for u in requests[count:]),requests[count:]
  print('PASS: cwd /project; actual file save; same interpreter, pandas and variables; no warm package downloads',flush=True)
  await page.evaluate('''async()=>{const stream=await(await root.getFileHandle('user.csv',{create:true})).createWritable();await stream.write('x\\n7\\n');await stream.close()}''')
  third=await page.evaluate('''run('assert Path("user.csv").read_text().splitlines()==["x","7"]\\nPath("saved.txt").write_text("two")\\nos.makedirs("nested",exist_ok=True)\\nPath("nested/a.txt").write_text("nested")\\nPath("nested/a.txt").rename("nested/b.txt")\\nPath("user.csv").unlink()\\nresult=1')''')
  assert third['result']==1 and await page.evaluate('read("saved.txt")')=='two'
  assert await page.evaluate('''async()=>{const d=await root.getDirectoryHandle('nested');return(await(await d.getFileHandle('b.txt')).getFile()).text()}''')=='nested'
  assert await page.evaluate('''async()=>{try{await root.getFileHandle('user.csv');return false}catch{return true}}''')
  await page.evaluate('code=>run(code)', 'with open("truncate.txt","w+") as f:\n    f.write("abcdef")\n    f.flush()\n    f.truncate(3)')
  assert await page.evaluate('read("truncate.txt")')=='abc'
  assert await page.evaluate('async()=>{try{const d=await root.getDirectoryHandle("nested");await d.getFileHandle("a.txt");return false}catch{return true}}')
  print('PASS: refresh external file; stdlib read, overwrite, nested directory, rename and delete reach OPFS',flush=True)
  await page.evaluate('''()=>{runtime.callBrowser=async(method,args)=>{if(await read('checkpoint.txt')!=='saved')throw Error('barrier failed');return {method,url:args.url}}}''')
  rpc=await page.evaluate('''run('from agent import browser\\nPath("checkpoint.txt").write_text("saved")\\npage=await browser.open("https://example.com")\\nresult=page')''')
  assert rpc['result']=={'method':'open','url':'https://example.com'},rpc
  print('PASS: awaited browser RPC returns native Python dict; file persistence barrier precedes browser action',flush=True)
  error=await page.evaluate('''async()=>{try{await run('kept=42\\nPath("error-save.txt").write_text("durable")\\nprint("before error")\\nraise ValueError("test")')}catch(e){return {message:e.message,stdout:e.stdout}}}''')
  assert 'ValueError' in error['message'] and 'before error' in error['stdout'],error
  assert await page.evaluate('read("error-save.txt")')=='durable'
  assert (await page.evaluate("run('result=kept')"))['result']==42
  assert not await page.evaluate('''async()=>{try{await run('Path("must-not-exist").write_text("bad")\\nif :')}catch{}try{await root.getFileHandle('must-not-exist');return true}catch{return false}}''')
  print('PASS: exception preserves earlier files/variables; syntax checked before any user statement',flush=True)
  await page.evaluate("run('os.chdir(\"nested\")')")
  assert (await page.evaluate("run('result=os.getcwd()')"))['result']=='/project'
  await page.evaluate("()=>{window.stopCheckpointCommitted=false;runtime.onFiles=ops=>{if(ops.some(op=>op.type==='write' && op.path==='stop-save.txt' && new TextDecoder().decode(op.bytes)==='survives'))window.stopCheckpointCommitted=true}}")
  await page.evaluate('''()=>{window.pending=run('Path("stop-save.txt").write_text("survives")\\nwhile True: pass').then(()=>false,e=>e.message.includes('прерван'))}''')
  await page.wait_for_function('()=>window.stopCheckpointCommitted===true',timeout=15000)
  await page.evaluate('runtime.cancel()');assert await page.evaluate('pending');await page.evaluate('runtime.flush()')
  assert await page.evaluate('read("stop-save.txt")')=='survives'
  assert not await page.evaluate('runtime.worker')
  reset=await page.evaluate("run('from pathlib import Path\\nresult={\"kept\":\"kept\" in globals(),\"file\":Path(\"stop-save.txt\").read_text()}')")
  assert reset['result']=={'kept':False,'file':'survives'},reset
  print('PASS: cwd reset per block; close checkpoint survives terminating infinite Python; new session reloads disk files',flush=True)
  parsed=await page.evaluate('''run('from bs4 import BeautifulSoup\\nresult=BeautifulSoup("<article><h1>Текст</h1></article>","html.parser").h1.text')''')
  assert parsed['result']=='Текст';assert not any('cdn.jsdelivr' in u for u in requests)
  await page.evaluate('runtime.reset()')
  bad=await page.evaluate("""async()=>{const wrong=await root.getFileHandle('saved.txt'), Original=Worker;window.Worker=class extends Original{postMessage(message,...args){if(message.type==='run')message.project=wrong;return super.postMessage(message,...args)}};try{await run('pass')}catch(e){return {error:e.message,worker:!!runtime.worker}}finally{window.Worker=Original}}""")
  assert not bad['worker'] and 'FileSystemDirectoryHandle' in bad['error'],bad
  await page.evaluate('runtime.project=root')
  assert (await page.evaluate("run('result=__import__(\"os\").getcwd()')"))['result']=='/project'
  print('PASS: failed native mount resets the Worker; retry mounts the chosen directory cleanly',flush=True)
  await page.evaluate('runtime.reset()');await page.reload()
  assert await page.evaluate('''async()=>{const root=await(await navigator.storage.getDirectory()).getDirectoryHandle('project');return(await(await root.getFileHandle('stop-save.txt')).getFile()).text()}''')=='survives'
  print('PASS: bundled BeautifulSoup works offline; page reload preserves saved files',flush=True)
  print('TIMINGS '+json.dumps({'coldMs':first['elapsedMs'],'warmMs':second['elapsedMs']},ensure_ascii=False),flush=True)
  await browser.close()
asyncio.run(main());server.shutdown()
