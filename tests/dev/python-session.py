"""Actual persistent Worker/Pyodide under manifest CSP; HTTP origin, not an installed extension."""
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
  page=await browser.new_page();requests=[];page.on('request',lambda r:requests.append(r.url))
  await page.goto(BASE+'fixtures/article.html')
  await page.evaluate('''async()=>{const {PythonRuntime}=await import('/src/python-runtime.js');window.runtime=new PythonRuntime();window.events=[];runtime.onProgress=(phase,detail)=>events.push({phase,detail});window.run=async code=>{const r=await runtime.run(code,{});runtime.acknowledge(r.requestId);return r}}''')
  first=await page.evaluate('''run('import pandas as pd\\ndf=pd.DataFrame({"x":[1,2,3]})\\nopen("saved.txt","w").write("one")\\nresult=int(df.x.sum())')''')
  assert first['result']==6 and not first['sessionReused'] and len(first['files'])==1,first
  count=len(requests)
  second=await page.evaluate('''run('result={"sum":int(df.x.sum()),"text":open("saved.txt").read()}')''')
  assert second['result']=={'sum':6,'text':'one'} and second['sessionId']==first['sessionId'] and second['sessionReused'] and not second['files'],second
  assert not any('.whl' in u or '.wasm' in u or 'pyodide.js' in u for u in requests[count:]),requests[count:]
  assert await page.evaluate('runtime.worker && !runtime.running && !document.querySelector("iframe")')
  print('PASS: same Worker/session preserves pandas, variables and files; warm run performs no interpreter/package requests and no unchanged export',flush=True)
  third=await page.evaluate('''run('open("saved.txt","w").write("two")\\nresult=1')''');assert len(third['files'])==1
  error=await page.evaluate('''async()=>{try{await run('kept=42\\nprint("before error")\\nraise ValueError("test")')}catch(e){return {message:e.message,sessionId:e.sessionId,stdout:e.stdout}}}''')
  assert 'ValueError' in error['message'] and 'before error' in error['stdout'] and error['sessionId']==first['sessionId'],error
  assert (await page.evaluate("run('result=kept')"))['result']==42
  print('PASS: modified files exported; ordinary Python exception preserves session, earlier assignments and stdout',flush=True)
  await page.evaluate('''async()=>{const a={isSameEntry:async b=>b?.same===true},b={same:true};await runtime.bindScope('https://chat.deepseek.com/a/chat/one',a);await runtime.bindScope('https://chat.deepseek.com/a/chat/one',b)}''')
  assert await page.evaluate('runtime.sessionId')==first['sessionId']
  await page.evaluate("runtime.bindScope('https://chat.deepseek.com/a/chat/two',runtime.project)")
  assert not await page.evaluate('runtime.worker')
  fresh=await page.evaluate("run('result=\"df\" in globals()')");assert fresh['result'] is False
  await page.evaluate("runtime.bindScope('https://chat.deepseek.com/a/chat/two',{})")
  assert not await page.evaluate('runtime.worker')
  print('PASS: same folder identity preserves environment; different chat or project destroys it without leaking variables',flush=True)
  await page.evaluate('''()=>{window.pending=runtime.run('while True: pass',{}).then(()=>false,e=>e.message.includes('прерван'))}''')
  await page.wait_for_function("()=>events.at(-1)?.phase==='running'")
  await page.evaluate('runtime.cancel()');assert await page.evaluate('pending')
  assert not await page.evaluate('runtime.worker')
  reset=await page.evaluate("run('result=\"kept\" in globals()')");assert reset['result'] is False
  await page.evaluate('runtime.reset()');assert not await page.evaluate('runtime.worker')
  print('PASS: cancellation terminates active Worker; explicit reset removes idle session; later run starts clean',flush=True)
  print('TIMINGS '+json.dumps({'coldMs':first['elapsedMs'],'warmMs':second['elapsedMs'],'coldPhases':first['timings'],'warmPhases':second['timings']},ensure_ascii=False),flush=True)
  await browser.close()
asyncio.run(main());server.shutdown()
