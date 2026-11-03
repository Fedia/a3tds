"""Real PyPI/CDN installs in Pyodide. HTTPS is verified via the managed proxy's CA trust.
Chrome API/extension-origin loading remain covered by the other fixture tests.
"""
from pathlib import Path
import asyncio, functools, json, os, shutil, threading, urllib.request
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from playwright.async_api import async_playwright
ROOT=Path(__file__).resolve().parents[2]
MANIFEST=json.loads((ROOT/'manifest.json').read_text())
class Handler(SimpleHTTPRequestHandler):
 def log_message(self,*args):pass
 def end_headers(self):
  self.send_header('Access-Control-Allow-Origin','*')
  policy=MANIFEST['content_security_policy']['extension_pages']
  self.send_header('Content-Security-Policy',policy);super().end_headers()
server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(ROOT)))
threading.Thread(target=server.serve_forever,daemon=True).start();BASE=f'http://127.0.0.1:{server.server_port}/'
async def main():
 async with async_playwright() as p:
  browser=await p.chromium.launch(executable_path=os.environ.get('CHROMIUM_BIN') or shutil.which('chromium'),args=['--no-sandbox'])
  page=await browser.new_page();requests=[]
  # The environment's private proxy CA is not in Chromium's trust store.
  # urllib retains TLS verification and the configured HTTPS_PROXY/CA settings.
  async def remote(route):
   url=route.request.url;requests.append(url)
   def read():
    accept=route.request.headers.get('accept','*/*')
    req=urllib.request.Request(url,headers={'Accept':accept})
    with urllib.request.urlopen(req,timeout=60) as response:return response.read(),dict(response.headers),response.status
   try:
    body,headers,status=await asyncio.to_thread(read)
    for name in list(headers):
     if name.lower() in ['content-encoding','transfer-encoding','content-length']:headers.pop(name)
    await route.fulfill(status=status,headers=headers,body=body)
   except Exception as error:
    await route.fulfill(status=502,headers={'Access-Control-Allow-Origin':'*'},body=str(error))
  for host in ['pypi.org','files.pythonhosted.org','cdn.jsdelivr.net']:
   await page.context.route('https://'+host+'/**',remote)
  await page.goto(BASE+'fixtures/article.html')
  await page.evaluate("""async()=>{const {PythonRuntime}=await import('/src/python-runtime.js');window.python=new PythonRuntime();window.progress=[];python.onProgress=(phase,detail)=>progress.push({phase,detail});window.run=async(...args)=>{const r=await python.run(...args);python.acknowledge(r.requestId);return r};}""")
  result=await page.evaluate('''run(`import micropip
await micropip.install("python-slugify==8.0.4")
from slugify import slugify
result = {"slug": slugify("Привет, мир!"), "has_dependency": __import__("text_unidecode").unidecode("мир")}`,{},null)''')
  assert result['result']['slug']=='privet-mir' and result['result']['has_dependency']=='mir',result
  assert any('/simple/python-slugify/' in url for url in requests) and any('python_slugify-8.0.4' in url for url in requests),requests
  assert any('text_unidecode' in url for url in requests),requests
  print('PASS: top-level await micropip.install downloads pinned PyPI wheel and dependency; imported code executes',flush=True)
  result=await page.evaluate('''run(`import micropip
await micropip.install("wordcloud==1.9.3")
from wordcloud import WordCloud
wc = WordCloud(width=200, height=100, background_color="white").generate("данные данные исследование студент")
wc.to_file("cloud.png")
result={"words":len(wc.words_)}`,{},null)''')
  raw=result['files'][0]['bytes'];first=raw.get('0') if isinstance(raw,dict) else raw[0]
  assert result['result']['words']==3 and first==137,result
  assert any('/pyodide/v0.27.7/full/wordcloud-' in url for url in requests),requests
  print('PASS: compiled wordcloud for the pinned Pyodide ABI loads from CDN, uses local matplotlib and creates PNG',flush=True)
  count=len(requests)
  warm=await page.evaluate("run('result=len(wc.words_)',{},null)")
  assert warm['result']==3 and warm['sessionReused'] and len(requests)==count
  print('PASS: wordcloud remains installed and its object survives; warm run makes no package requests',flush=True)
  result=await page.evaluate('''run(`from pyodide.http import pyfetch
blocked=[]
for url, kwargs in [("https://pypi.org/simple/emoji/?secret=data",{}),("https://cdn.jsdelivr.net/pyodide/v0.27.7/full/pyodide.js",{}),("https://pypi.org/simple/emoji/",{"method":"POST","body":"private data"})]:
    try:
        await pyfetch(url,**kwargs)
        blocked.append(False)
    except Exception:
        blocked.append(True)
result={"blocked":blocked}`,{},null)''')
  assert all(result['result']['blocked']) and len(requests)==count,(result,requests[count:])
  print('PASS: query payload, remote JS and POST blocked before outgoing network requests',flush=True)
  assert any('Загрузка ' in (item.get('detail') or '') for item in await page.evaluate('progress'))
  waiting=asyncio.Event();release=asyncio.Event()
  async def hold(route):
   waiting.set();await release.wait()
   try:await route.abort()
   except Exception:pass
  await page.context.route('https://pypi.org/simple/agent-cancel-fixture/',hold)
  await page.evaluate('''()=>{window.pending=python.run("from pyodide.http import pyfetch\\nawait pyfetch('https://pypi.org/simple/agent-cancel-fixture/')",{},null).then(()=>({cancelled:false}),e=>({cancelled:e.message.includes('прерван')}));}''')
  await asyncio.wait_for(waiting.wait(),30)
  await page.evaluate('python.cancel()')
  assert (await page.evaluate('pending'))['cancelled'] and await page.evaluate('!python.worker')
  release.set()
  print('PASS: live download progress is visible; cancellation interrupts a pending package request and removes the Worker',flush=True)
  await browser.close()
asyncio.run(main());server.shutdown()
