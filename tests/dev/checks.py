import asyncio,json,threading,functools
from http.server import ThreadingHTTPServer,SimpleHTTPRequestHandler
from playwright.async_api import async_playwright
from pathlib import Path
import os,shutil
ROOT=str(Path(__file__).resolve().parents[2])
class Handler(SimpleHTTPRequestHandler):
 def end_headers(self):
  self.send_header('Access-Control-Allow-Origin','*')
  policy=json.loads(Path(ROOT,'manifest.json').read_text())['content_security_policy']['extension_pages']
  self.send_header('Content-Security-Policy',policy);super().end_headers()
 def log_message(self,*a):pass
server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=ROOT));threading.Thread(target=server.serve_forever,daemon=True).start();url='http://127.0.0.1:'+str(server.server_port)+'/'
async def main():
 async with async_playwright() as p:
  browser=await p.chromium.launch(executable_path=os.environ.get('CHROMIUM_BIN') or shutil.which('chromium'),headless=True,args=['--no-sandbox']);context=await browser.new_context();tabs={};sessions={};values={};next_id=[1]
  async def bridge(source,op,args):
   if op=='storage-get':return {k:values.get(k) for k in ([args] if isinstance(args,str) else args)}
   if op=='storage-set':values.update(args);return None
   if op=='create':
    n=next_id[0];next_id[0]+=1;page=await context.new_page();await page.goto(args['url']);tabs[n]=page;return {'id':n,'url':page.url,'status':'complete'}
   if op=='get':return {'id':args,'url':tabs[args].url,'status':'complete'}
   if op=='update':await tabs[args['id']].goto(args['options']['url'],wait_until='domcontentloaded');return {'id':args['id'],'url':tabs[args['id']].url}
   if op=='remove':await tabs[args].close();del tabs[args];return None
   if op=='attach':sessions[args]=await context.new_cdp_session(tabs[args]);return None
   if op=='detach':await sessions.pop(args).detach();return None
   if op=='cdp':return await sessions[args['id']].send(args['method'],args['params'])
   if op=='script':return [{'result':await tabs[args['id']].evaluate('([source,args])=> ('+args['source']+')(...args)',[args['source'],args['args']])}]
   if op=='query':return []
   raise Exception(op)
  await context.expose_binding('harness',bridge)
  await context.add_init_script('''const evt={addListener(){}};window.chrome={runtime:{getURL:p=>location.origin+'/'+p},storage:{session:{get:k=>harness('storage-get',k),set:v=>harness('storage-set',v)},local:{get:k=>harness('storage-get',k),set:v=>harness('storage-set',v)},onChanged:evt},tabs:{create:a=>harness('create',a),get:id=>harness('get',id),remove:id=>harness('remove',id),update:(id,options)=>harness('update',{id,options}),query:a=>harness('query',a),onRemoved:evt},debugger:{attach:a=>harness('attach',a.tabId),detach:a=>harness('detach',a.tabId),sendCommand:(a,method,params)=>harness('cdp',{id:a.tabId,method,params}),onDetach:evt},scripting:{executeScript:a=>harness('script',{id:a.target.tabId,source:a.func.toString(),args:a.args})}};''')
  page=await context.new_page();page.on('console',lambda m:print('CONSOLE',m.type,m.text,flush=True));page.on('pageerror',lambda e:print('PAGEERROR',e,flush=True));await page.goto(url+'tests/index.html');print('Running async harness',flush=True)
  results=await page.evaluate('''async()=>{const m=await import('./tests.js');return await m.runTests()}''');print(f'Checks: {sum(r["ok"] for r in results)}/{len(results)} PASS',flush=True);Path(ROOT,'tests','last-results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2));await browser.close();assert all(r['ok'] for r in results),'Checks failed'
asyncio.run(main());server.shutdown()
