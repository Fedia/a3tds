"""Readiness regression using real DOM/layout and both Chrome API transports."""
from pathlib import Path
import asyncio, functools, os, shutil, threading
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from playwright.async_api import async_playwright
ROOT=Path(__file__).resolve().parents[2]
server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(SimpleHTTPRequestHandler,directory=str(ROOT)))
threading.Thread(target=server.serve_forever,daemon=True).start()
BASE=f'http://127.0.0.1:{server.server_port}/'
async def main():
 async with async_playwright() as p:
  b=await p.chromium.launch(executable_path=os.environ.get('CHROMIUM_BIN') or shutil.which('chromium'),args=['--no-sandbox'])
  context=await b.new_context();host=await context.new_page();tabs={};cdp={};storage={};pending={};next_id=[2]
  async def bridge(source,op,arg):
   if op=='get':return {'id':arg,'url':tabs[arg].url,**({'pendingUrl':pending[arg]} if arg in pending else {})}
   if op=='storage-set':storage.update(arg);return None
   if op=='create':
    n=next_id[0];next_id[0]+=1;tabs[n]=await context.new_page();await tabs[n].goto(arg['url']);return {'id':n,'url':tabs[n].url}
   if op=='update':
    n=arg['id'];pending[n]=arg['options']['url']
    async def navigate():
     await asyncio.sleep(.3);await tabs[n].goto(pending[n],wait_until='domcontentloaded');pending.pop(n,None)
    asyncio.create_task(navigate());return {'id':n,'url':tabs[n].url,'pendingUrl':pending[n]}
   if op=='storage':return {arg:storage.get(arg)}
   if op=='script':return [{'result':await tabs[arg['id']].evaluate('([fn,args])=>('+arg['fn']+')(...args)',[arg['fn'],arg['args']])}]
   if op=='attach':cdp[arg]=await context.new_cdp_session(tabs[arg]);return None
   if op=='cdp':return await cdp[arg['id']].send(arg['method'],arg['params'])
   if op=='detach':await cdp[arg].detach();return None
   raise Exception(op)
  await host.expose_binding('bridge',bridge)
  await host.goto(BASE+'tests/index.html')
  await host.evaluate('''() => { const evt={addListener(){}}; window.chrome={runtime:{getURL:p=>location.origin+'/'+p},tabs:{get:id=>bridge('get',id),create:a=>bridge('create',a),update:(id,options)=>bridge('update',{id,options}),onRemoved:evt},storage:{session:{get:k=>bridge('storage',k),set:v=>bridge('storage-set',v)}},scripting:{executeScript:a=>bridge('script',{id:a.target.tabId,fn:a.func.toString(),args:a.args})},debugger:{onDetach:evt,attach:a=>bridge('attach',a.tabId),sendCommand:(a,method,params)=>bridge('cdp',{id:a.tabId,method,params}),detach:a=>bridge('detach',a.tabId)}}; }''')
  for transport in ['scripting','auto']:
   target=await context.new_page();tabs[1]=target;storage['owned-tab-1']='ready-test'
   async def slow_image(route):
    await asyncio.sleep(8)
    try: await route.fulfill(body=b'',content_type='image/png')
    except Exception: pass
   await target.route('**/slow-outside.png',slow_image)
   await target.add_init_script("document.addEventListener('DOMContentLoaded',()=>{const img=document.createElement('img');img.src='/slow-outside.png';document.body.append(img)},{once:true})")
   await target.goto(BASE+'fixtures/readiness.html',wait_until='domcontentloaded')
   result=await host.evaluate('''async transport => { const {BrowserTools}=await import('/src/browser-tools.js'); const tools=new BrowserTools({id:'ready-test',tabs:[{id:1}]},async()=>{},async()=>{}); tools.transport=transport;window.tools=tools;return tools.execute('browser.snapshot',{tabId:1}); }''',transport)
   assert result['readiness']['ready'] and '+7' in result['text'],result['readiness']
   assert await target.evaluate('document.readyState === "interactive"'), 'Must not wait for window.load or unrelated network activity'
   assert result['readiness']['stableMs']>=1000
   action=await host.evaluate("""async()=>{
     const snapshot=await tools.run(1,'snapshot',{selector:'body'});const button=snapshot.elements.find(e=>e.label==='Обновить');
     return tools.execute('browser.click',{tabId:1,snapshot:snapshot.snapshot,element:button.id});
   }""")
   assert action['readiness']['ready'] and action['requiresSnapshot'],action
   assert '+9' in await target.locator('#content').text_content()
   # Readiness ignores the continuously updating clock but sees a geometry change.
   await target.evaluate("document.querySelector('#moving').style.top='0px';setTimeout(()=>document.querySelector('#moving').style.top='50px',250)")
   state=await host.evaluate('tools.waitForPage(1,{timeoutMs:3000,minWaitMs:300,quietMs:600,intervalMs:100})')
   assert state['ready'] and state['waitedMs']>=800,state
   await target.evaluate("document.querySelector('main').setAttribute('aria-busy','true')")
   state=await host.evaluate('tools.waitForPage(1,{timeoutMs:450,minWaitMs:100,quietMs:100,intervalMs:50})')
   assert not state['ready'] and state['reason']=='content_loading',state
   await target.evaluate("document.querySelector('main').setAttribute('aria-busy','false');window.ticker=setInterval(()=>document.querySelector('#content').textContent=String(Date.now()),50)")
   state=await host.evaluate('tools.waitForPage(1,{timeoutMs:550,minWaitMs:100,quietMs:200,intervalMs:50})')
   assert not state['ready'] and state['reason']=='layout_changing',state
   await target.evaluate("clearInterval(ticker);document.querySelector('main').replaceChildren()")
   state=await host.evaluate('tools.waitForPage(1,{timeoutMs:300,minWaitMs:100,quietMs:100,intervalMs:50})')
   assert not state['ready'] and state['reason']=='content_missing',state
   await target.evaluate("document.querySelector('main').textContent='Hidden content';document.querySelector('main').style.opacity='0'")
   state=await host.evaluate('tools.waitForPage(1,{timeoutMs:300,minWaitMs:100,quietMs:100,intervalMs:50})')
   assert not state['ready'] and state['reason']=='content_missing',state
   await target.evaluate("document.querySelector('main').style.opacity='1'")
   # A cancelled wait must finish promptly rather than issuing more commands.
   assert await host.evaluate('''async()=>{setTimeout(()=>tools.cancel(),100);try{await tools.waitForPage(1);return false}catch{return true}}''')
   await host.evaluate('tools.reset()')
   await target.evaluate("document.querySelector('main').setAttribute('aria-busy','false')")
   async def slow_parser(route):
    await asyncio.sleep(.8)
    await route.fulfill(body="document.querySelector('p').textContent='Parser completed content';",content_type='application/javascript')
   await target.route('**/slow-parser.js',slow_parser)
   await target.route('**/dom-gate.html',lambda route:route.fulfill(body='<main><p>Visible before DOMContentLoaded</p></main><script src="/slow-parser.js"></script>',content_type='text/html'))
   await target.goto(BASE+'fixtures/dom-gate.html',wait_until='commit')
   state=await host.evaluate('tools.waitForPage(1,{timeoutMs:5000,minWaitMs:100,quietMs:300,intervalMs:100})')
   assert state['ready'] and state['domReady'] and state['waitedMs']>=700,state
   assert await target.locator('p').text_content()=='Parser completed content'
   await target.goto(BASE+'fixtures/records.html',wait_until='domcontentloaded')
   html=await host.evaluate("tools.pythonCall('html',{tab_id:1,selector:'#reviews'})")
   assert 'Анна' in html and 'HIDDEN_DATA' not in html and 'NOT_FOR_COLLECTION' not in html
   await target.goto(BASE+'fixtures/records-page2.html',wait_until='domcontentloaded')
   print('PASS:',transport,'safe HTML removes hidden fields/scripts and CSS-hidden text')
   reused=await host.evaluate("tools.pythonCall('open',{url:location.origin+'/fixtures/records.html',new_tab:false})")
   assert reused['reused'] and reused['tab_id']==1 and reused['readiness']['ready'],reused
   unchanged=await host.evaluate("tools.pythonCall('open',{url:location.origin+'/fixtures/records.html',new_tab:false})")
   assert unchanged['tab_id']==1
   separate=await host.evaluate("tools.pythonCall('open',{url:location.origin+'/fixtures/records-page2.html',new_tab:true})")
   assert separate['tab_id']!=1 and not separate['reused']
   await target.goto(BASE+'fixtures/article.html')
   await host.evaluate("tools.pythonCall('type',{selector:'input',text:'first',tab_id:1})")
   await host.evaluate("tools.pythonCall('type',{selector:'input',text:'second',tab_id:1})")
   assert await target.locator('input').input_value()=='second'
   await host.evaluate("tools.pythonCall('wait',{selector:'input',timeout:1,tab_id:1})")
   print('PASS:',transport,'default reuse, explicit new tab, selector interaction, type replaces, wait finds content')
   await host.evaluate('tools.detach()');await target.close()
   for n,page in list(tabs.items()):
    if n!=1 and not page.is_closed():await page.close()
   tabs.clear()
   print('PASS:',transport,'DOMContentLoaded, delayed content/layout, clock exclusion, busy timeout, cancellation')
  await b.close()
asyncio.run(main());server.shutdown()
