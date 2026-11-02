"""Real opaque sandbox/Worker/WASM with controlled failures; not installed-extension testing."""
from pathlib import Path
import asyncio, functools, json, os, shutil, threading, time
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from playwright.async_api import async_playwright
ROOT = Path(__file__).resolve().parents[2]
class Handler(SimpleHTTPRequestHandler):
 def log_message(self,*args): pass
 def end_headers(self):
  self.send_header('Access-Control-Allow-Origin','*')
  policy="script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; object-src 'none'"
  if self.path.split('?')[0]=='/python-sandbox.html':
   policy="sandbox allow-scripts; script-src 'self' http://127.0.0.1:* 'wasm-unsafe-eval'; worker-src blob:; connect-src http://127.0.0.1:*; object-src 'none'"
  self.send_header('Content-Security-Policy',policy);super().end_headers()
server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(ROOT)))
threading.Thread(target=server.serve_forever,daemon=True).start();BASE=f'http://127.0.0.1:{server.server_port}/'
async def prepare(browser):
 page=await browser.new_page();await page.goto(BASE+'fixtures/article.html')
 await page.evaluate("""async()=>{const {PythonRuntime}=await import('/src/python-runtime.js');window.runtime=new PythonRuntime();window.phases=[];runtime.onProgress=p=>phases.push(p)}""")
 return page
async def failed(page, code='result=1'):
 result=await page.evaluate("""async code=>{try{await runtime.run(code,{},1000);return {ok:true}}catch(e){return {ok:false,error:e.message,phase:e.pythonPhase,definite:e.definite,worker:!!runtime.worker}}}""",code)
 assert not result['ok'] and not result['worker'],result
 return result
async def main():
 async with async_playwright() as p:
  browser=await p.chromium.launch(executable_path=os.environ.get('CHROMIUM_BIN') or shutil.which('chromium'),args=['--no-sandbox'])
  # Silent/missing sandbox script must fail before the old universal 60-second timeout.
  page=await prepare(browser);await page.route('**/python-sandbox.html',lambda r:r.fulfill(body='<html></html>',content_type='text/html'))
  await page.evaluate('runtime.frameMs=200');result=await failed(page)
  assert result['phase']=='sandbox' and result['definite'] and 'не ответила' in result['error'],result
  await page.close();print('PASS: missing sandbox ready reports its stage and clears the frame',flush=True)
  # Worker constructor exceptions used to escape the event listener and leave the port unanswered.
  page=await prepare(browser)
  await page.route('**/src/python-sandbox.js',lambda r:r.fulfill(body="globalThis.Worker=class {constructor(){throw new Error('test Worker blocked')}};\n"+(ROOT/'src/python-sandbox.js').read_text(),content_type='text/javascript'))
  result=await failed(page)
  assert result['phase']=='worker' and result['definite'] and 'test Worker blocked' in result['error'],result
  await page.close();print('PASS: synchronous Worker failure is returned immediately',flush=True)
  page=await prepare(browser);await page.route('**/vendor/pyodide/pyodide.asm.wasm',lambda r:r.abort())
  await page.evaluate('runtime.startupMs=4000');started=time.monotonic()
  result=await failed(page)
  assert result['phase']=='runtime' and result['definite'] and time.monotonic()-started<3,result
  await page.close();print('PASS: failed WASM load reports interpreter startup failure',flush=True)
  # A delayed startup must not consume the code's execution budget.
  page=await prepare(browser);wheels=[]
  page.on('request',lambda r:wheels.append(r.url) if '.whl' in r.url else None)
  async def delayed(route):await asyncio.sleep(2);await route.continue_()
  await page.route('**/vendor/pyodide/pyodide.asm.wasm',delayed)
  started=time.monotonic()
  result=await page.evaluate("runtime.run('result=sum(data)',[1,2,3],1000)")
  assert result['result']==6 and time.monotonic()-started>2 and not wheels
  phases=await page.evaluate('phases');assert 'running' in phases and 'runtime' in phases,phases
  await page.unroute('**/vendor/pyodide/pyodide.asm.wasm',delayed)
  result=await page.evaluate("runtime.run('import pandas as pd\\nresult=int(pd.Series(data).sum())',[1,2,3],10000)")
  assert result['result']==6 and any('pandas' in path for path in wheels)
  assert not any('matplotlib' in path for path in wheels),wheels
  await page.close();print('PASS: delayed startup preserves execution budget; stdlib loads no wheels; pandas omits matplotlib',flush=True)
  page=await prepare(browser)
  await page.route('**/src/python-worker.js',lambda r:r.fulfill(body="WebAssembly.instantiateStreaming=undefined;\n"+(ROOT/'src/python-worker.js').read_text(),content_type='text/javascript'))
  result=await page.evaluate("runtime.run('result=42',{},null)");assert result['result']==42
  await page.close();print('PASS: missing instantiateStreaming uses normal WebAssembly bytes',flush=True)
  page=await prepare(browser)
  async def wrong_mime(route):await route.fulfill(response=await route.fetch(),content_type='application/octet-stream')
  await page.route('**/vendor/pyodide/pyodide.asm.wasm',wrong_mime)
  result=await page.evaluate("runtime.run('result=43',{},null)");assert result['result']==43
  await page.close();print('PASS: incorrect WASM MIME uses the packaged binary without streaming',flush=True)
  page=await prepare(browser)
  await page.evaluate("runtime.onProgress=phase=>{if(phase==='runtime')runtime.cancel()}")
  result=await failed(page);assert 'прерван' in result['error'] and result['phase']=='runtime',result
  await page.close();print('PASS: cancellation during interpreter startup clears Worker/frame',flush=True)
  await browser.close()
asyncio.run(main());server.shutdown()
