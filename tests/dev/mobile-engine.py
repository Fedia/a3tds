from pathlib import Path
import os, shutil, tempfile
import asyncio,json,threading,functools
from http.server import ThreadingHTTPServer,SimpleHTTPRequestHandler
from playwright.async_api import async_playwright
ROOT=str(Path(__file__).resolve().parents[2])
class Handler(SimpleHTTPRequestHandler):
 def end_headers(self):
  self.send_header('Access-Control-Allow-Origin','*')
  if self.path=='/python-sandbox.html':self.send_header('Content-Security-Policy',"sandbox allow-scripts; script-src 'self' http://127.0.0.1:* 'wasm-unsafe-eval'; worker-src blob:; connect-src http://127.0.0.1:*; object-src 'none';")
  super().end_headers()
 def log_message(self,*args):pass
servers=[]
for i in range(2):
 s=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=ROOT));threading.Thread(target=s.serve_forever,daemon=True).start();servers.append(s)
CHAT=f'http://127.0.0.1:{servers[0].server_port}/';EXT=f'http://127.0.0.1:{servers[1].server_port}/'
async def main():
 async with async_playwright() as p:
  b=await p.chromium.launch(executable_path=os.environ.get('CHROMIUM_BIN') or shutil.which('chromium'),headless=True,args=['--no-sandbox'])
  context=await b.new_context(viewport={'width':390,'height':844},is_mobile=True,has_touch=True)
  pages={};shared={'cloud-consent':True,'file-mode':'browser','browser-mode':'scripting','chat-bindings':{'input':'#composer','send':'#send','response':'.answer','complete':'.complete'}}
  async def dispatch(source,msg,target=None):
   origin=source['frame'];url=origin.url;page=source['page'];tabid=next((n for n,x in pages.items() if x==page),None)
   sender={'id':'test-extension','url':url,'frameId':0 if origin==page.main_frame else 1}
   if url.startswith(CHAT):sender['url']='https://chat.deepseek.com/a/chat/test'
   if url.endswith('/service-worker-host'):sender['url']=EXT+'src/service-worker.js'
   elif tabid is not None:sender['tab']={'id':tabid,'url':sender['url']}
   frames=[f for q in context.pages for f in q.frames if f!=origin and (target is None or q==pages[target] and f==q.main_frame)]
   async def visit(frame):
    try:return await frame.evaluate('''([message,sender])=>new Promise(resolve=>{
      let answered=false,pending=false;const reply=value=>{answered=true;resolve({answer:value})};
      for(const listener of window.listeners||[])if(listener(message,sender,reply)===true)pending=true;
      if(!answered&&!pending)resolve({absent:true});
      else setTimeout(()=>resolve({absent:true}),10000);
    })''',[msg,sender])
    except Exception:return {'absent':True}
   results=await asyncio.gather(*(visit(f) for f in frames))
   return next((r['answer'] for r in results if 'answer' in r),None)
  async def bridge(source,op,arg):
   if op=='message':return await dispatch(source,arg)
   if op=='tab-message':return await dispatch(source,arg['message'],arg['id'])
   if op=='get-storage':return {k:shared.get(k) for k in ([arg] if isinstance(arg,str) else arg)}
   if op=='set-storage':shared.update(arg);return None
   if op=='current':return next(({'id':n,'url':source['page'].url} for n,v in pages.items() if v==source['page']),None)
   if op=='get-tab':return {'id':arg,'url':'https://chat.deepseek.com/a/chat/test' if arg==1 else pages[arg].url,'status':'complete'}
   if op=='query':return [{'id':1,'url':'https://chat.deepseek.com/a/chat/test','title':'DeepSeek fixture'}]
   if op=='update':return {'id':arg}
   if op=='script':return [{'result':await pages[arg['id']].evaluate('([source,args])=>('+arg['source']+')(...args)',[arg['source'],arg['args']])}]
   if op=='permission':return True
   raise Exception(op)
  await context.expose_binding('bridge',bridge)
  script='''window.listeners=[];const evt={addListener(){}};
window.chrome={runtime:{id:'test-extension',getURL:p=>EXT+p,onMessage:{addListener:f=>listeners.push(f)},sendMessage:m=>bridge('message',m)},action:{onClicked:evt},permissions:{request:()=>bridge('permission',{})},storage:{local:{get:k=>bridge('get-storage',k),set:v=>bridge('set-storage',v)},session:{get:k=>bridge('get-storage',k),set:v=>bridge('set-storage',v)},onChanged:evt},tabs:{getCurrent:()=>bridge('current',null),get:id=>bridge('get-tab',id),query:q=>bridge('query',q),update:id=>bridge('update',id),onRemoved:evt,sendMessage:(id,message)=>bridge('tab-message',{id,message})},scripting:{executeScript:a=>bridge('script',{id:a.target.tabId,source:a.func.toString(),args:a.args})}};
const attach=Element.prototype.attachShadow;Element.prototype.attachShadow=function(options){const r=attach.call(this,options);window.testShadow=r;return r};window.alert=text=>{window.lastAlert=text};window.confirm=()=>true;
'''.replace('EXT',json.dumps(EXT))
  await context.add_init_script(script)
  # Empty page hosts the actual service worker source with emulated Chrome API transport.
  sw=await context.new_page();await sw.goto(EXT+'service-worker-host');await sw.add_script_tag(url=EXT+'src/service-worker.js')
  chat=await context.new_page();pages[1]=chat;await chat.goto(CHAT+'fixtures/chat.html')
  await chat.evaluate('''() => {
   let n=0;
   document.querySelector('#send').onclick=()=>{
    document.querySelector('#composer').value='';const stop=document.createElement('button');stop.setAttribute('aria-label','Stop generating');document.body.append(stop);
    setTimeout(()=>{n++;const answer=document.createElement('div');answer.className='answer';answer.dataset.messageAuthorRole='assistant';
     const command=n===1?{id:'py',tool:'python.run',args:{code:'result = {"sum": sum(data["values"])}',data:{values:[1,2,3]}},description:'Сумма'}:{id:'finish',tool:'task.finish',args:{summary:'Сумма равна 6'},description:'Готово'};
     answer.append(document.createTextNode(JSON.stringify(command)));const copy=document.createElement('button');copy.className='complete';copy.setAttribute('aria-label','Copy');copy.textContent='Copy';answer.append(copy);document.querySelector('#answers').append(answer);stop.remove();
    },100);
   };
  }''')
  await chat.add_script_tag(url=EXT+'src/chat-ui.js')
  settings=await context.new_page();pages[2]=settings;await settings.goto(EXT+'workspace.html');await settings.wait_for_selector('#internal')
  assert await settings.evaluate('document.documentElement.scrollWidth <= innerWidth')
  await settings.close();print('Settings closed',flush=True)
  await chat.wait_for_timeout(500)
  await chat.evaluate("testShadow.querySelector('input').click()")
  await chat.wait_for_timeout(500)
  assert await chat.evaluate("testShadow.querySelector('input').checked"),await chat.evaluate('window.lastAlert')
  await chat.locator('#composer').fill('Посчитай сумму 1, 2 и 3 в Python')
  await chat.locator('#send').tap()
  for i in range(100):
   if shared.get('summary',{}).get('status') in ['completed','paused','stopped']:break
   await asyncio.sleep(.3)
  summary=shared.get('summary',{});print('SUMMARY',summary,flush=True)
  assert summary.get('status')=='completed',await chat.evaluate('window.lastAlert')
  assert 'python-result-py.json' in summary['files']
  assert await chat.locator('.answer').count()==2
  await chat.wait_for_selector('.psy-agent-final')
  assert await chat.locator('.psy-agent-final').inner_text() == 'Ответ агента\nСумма равна 6'
  frame=next(f for f in chat.frames if f.url==EXT+'executor.html')
  result=await frame.evaluate('''async()=>{const d=await(await navigator.storage.getDirectory()).getDirectoryHandle('agent-results');return JSON.parse(await(await(await d.getFileHandle('python-result-py.json')).getFile()).text())}''')
  assert result['result']['sum']==6
  settings=await context.new_page();pages[2]=settings;await settings.goto(EXT+'workspace.html')
  await settings.locator('#diagnose').click();await settings.wait_for_selector('#files button')
  assert await settings.evaluate('document.documentElement.scrollWidth <= innerWidth')
  async with settings.expect_download() as pending:
   await settings.locator('#files button').first.click()
  download=await pending.value;await download.save_as(str(Path(tempfile.gettempdir())/'psy-agent-mobile-test-result.json'))
  assert json.load(open(str(Path(tempfile.gettempdir())/'psy-agent-mobile-test-result.json')))['result']['sum']==6
  await settings.close()
  assert await chat.evaluate("chrome.runtime.sendMessage({type:'executor-command',targetTabId:1,command:'cancel-send'})") is None
  await chat.evaluate("""()=>{document.querySelector('#send').onclick=()=>{document.querySelector('#composer').value='';const answer=document.createElement('div');answer.className='answer';answer.dataset.messageAuthorRole='assistant';answer.textContent=JSON.stringify({id:'loop',tool:'python.run',args:{code:'while True: pass',data:{}},description:'loop'});const copy=document.createElement('button');copy.className='complete';copy.setAttribute('aria-label','Copy');answer.append(copy);document.querySelector('#answers').append(answer);};}""")
  await chat.locator('#composer').fill('Бесконечный цикл для проверки остановки');await chat.locator('#send').tap()
  for i in range(80):
   if shared.get('summary',{}).get('message')=='loop':break
   await asyncio.sleep(.2)
  assert shared['summary']['message']=='loop'
  await asyncio.sleep(2)
  await chat.evaluate("testShadow.querySelector('input').click()")
  for i in range(30):
   if shared.get('summary',{}).get('status')=='stopped':break
   await asyncio.sleep(.2)
  assert shared['summary']['status']=='stopped'
  print('PASS: internal file download, denied direct executor message, stop through chat toggle',flush=True)
  print('PASS: mobile viewport, foreground extension iframe, actual service-worker routing, settings closed, chat → Python Worker → files → final response',flush=True)
  await b.close()
asyncio.run(main())
for s in servers:s.shutdown()
