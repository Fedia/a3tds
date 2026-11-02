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
  pages={};shared={'cloud-consent':False,'file-mode':'browser','browser-mode':'scripting','chat-bindings':{'input':'#composer','send':'#send','response':'.answer','complete':'.complete'}}
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
   if op in ['set-storage','set-session']:
    changes={k:{'oldValue':shared.get(k),'newValue':v} for k,v in arg.items() if shared.get(k)!=v};shared.update(arg)
    async def changed(frame):
     try:await frame.evaluate('([changes,area])=>{for(const fn of window.storageListeners||[])fn(changes,area)}',[changes,'session' if op=='set-session' else 'local'])
     except Exception:pass
    if changes:await asyncio.gather(*(changed(f) for q in context.pages for f in q.frames))
    return None
   if op=='current':return next(({'id':n,'url':source['page'].url} for n,v in pages.items() if v==source['page']),None)
   if op=='get-tab':return {'id':arg,'url':'https://chat.deepseek.com/a/chat/test' if arg==1 else pages[arg].url,'status':'complete'}
   if op=='query':return [{'id':1,'url':'https://chat.deepseek.com/a/chat/test','title':'DeepSeek fixture'}]
   if op=='update':return {'id':arg}
   if op=='script':return [{'result':await pages[arg['id']].evaluate('([source,args])=>('+arg['source']+')(...args)',[arg['source'],arg['args']])}]
   if op=='permission':return True
   raise Exception(op)
  await context.expose_binding('bridge',bridge)
  script='''window.localView=value=>{if(location.href.startsWith(CHAT)&&value){if(value.ownerURL==='https://chat.deepseek.com/a/chat/test')value.ownerURL=location.href;if(value.chatURL==='https://chat.deepseek.com/a/chat/test')value.chatURL=location.href;}return value};window.listeners=[];window.storageListeners=[];const evt={addListener(){}};
window.chrome={runtime:{id:'test-extension',getURL:p=>EXT+p,onMessage:{addListener:f=>listeners.push(f)},sendMessage:m=>bridge('message',m)},action:{onClicked:evt},permissions:{request:()=>bridge('permission',{}),contains:()=>bridge('permission',{})},storage:{local:{get:async k=>{const d=await bridge('get-storage',k);if(d.summary)localView(d.summary);if(d['ui-finals'])d['ui-finals'].forEach(localView);if(d['ui-history'])d['ui-history'].forEach(localView);return d},set:v=>bridge('set-storage',v)},session:{get:k=>bridge('get-storage',k),set:v=>bridge('set-session',v)},onChanged:{addListener:f=>storageListeners.push((changes,area)=>{if(changes.summary?.newValue)localView(changes.summary.newValue);if(changes['ui-finals']?.newValue)changes['ui-finals'].newValue.forEach(localView);if(changes['ui-history']?.newValue)changes['ui-history'].newValue.forEach(localView);f(changes,area)})}},tabs:{getCurrent:()=>bridge('current',null),get:id=>bridge('get-tab',id),query:q=>bridge('query',q),update:id=>bridge('update',id),onRemoved:evt,sendMessage:(id,message)=>bridge('tab-message',{id,message})},scripting:{executeScript:a=>bridge('script',{id:a.target.tabId,source:a.func.toString(),args:a.args})}};
const attach=Element.prototype.attachShadow;Element.prototype.attachShadow=function(options){const r=attach.call(this,options);window.testShadow=r;return r};window.alert=text=>{window.lastAlert=text};window.confirm=()=>{throw new Error('Unexpected confirmation')};
'''.replace('EXT',json.dumps(EXT)).replace('CHAT',json.dumps(CHAT))
  await context.add_init_script(script)
  # Empty page hosts the actual service worker source with emulated Chrome API transport.
  sw=await context.new_page();await sw.goto(EXT+'service-worker-host');await sw.add_script_tag(url=EXT+'src/service-worker.js')
  chat=await context.new_page();pages[1]=chat;await chat.goto(CHAT+'fixtures/chat.html')
  await chat.evaluate('''() => {
   let n=0;
   document.querySelector('#send').onclick=()=>{
    const prompt=document.querySelector('#composer').value;document.querySelector('#composer').value='';const stop=document.createElement('button');stop.setAttribute('aria-label','Stop generating');document.body.append(stop);
    setTimeout(()=>{n++;const answer=document.createElement('div');answer.className='answer';answer.dataset.messageAuthorRole='assistant';
     let state={};try{state=JSON.parse(prompt.split('Состояние: ')[1])}catch{};
     const command=n===1?{id:'py',tool:'python.run',args:{code:'result = {"sum": sum(data["values"])}',data:{values:[1,2,3]}},description:'Сумма'}:state.last?.data?.result?.sum!==6?{id:'status-'+n,tool:'python.status',args:{jobId:'py',waitMs:15000},description:'Проверить вычисление'}:{id:'finish',tool:'task.finish',args:{summary:'Сумма равна 6'},description:'Готово'};
     answer.append(document.createTextNode(JSON.stringify(command)));const copy=document.createElement('button');copy.className='complete';copy.setAttribute('aria-label','Copy');copy.textContent='Copy';answer.append(copy);document.querySelector('#answers').append(answer);stop.remove();
    },100);
   };
  }''')
  await chat.add_script_tag(url=EXT+'src/chat-ui.js')
  settings=await context.new_page();pages[2]=settings;await settings.goto(EXT+'workspace.html');await settings.wait_for_selector('#folder')
  assert await settings.evaluate('document.documentElement.scrollWidth <= innerWidth')
  await settings.close();print('Settings closed',flush=True)
  await chat.wait_for_timeout(500)
  await chat.evaluate("testShadow.querySelector('input').click()")
  await chat.wait_for_timeout(500)
  assert await chat.evaluate("testShadow.querySelector('input').checked"),await chat.evaluate('window.lastAlert')
  frame=next(f for f in chat.frames if f.url==EXT+'executor.html')
  await frame.evaluate("""async()=>{
    const {StateStore}=await import('./src/state-store.js'); const store=await new StateStore().init();
    const old=StateStore.fresh('Старая остановленная задача'); old.status='stopped';
    old.pending={command:{id:'old-command',tool:'files.write',args:{path:'old.txt',text:'old'},description:'old'}};
    old.outbound={phase:'send-uncertain',prompt:'old'};
    window.oldTaskId=old.id; await store.put('task',old);
  }""")
  await chat.locator('#composer').fill('Посчитай сумму 1, 2 и 3 в Python')
  await chat.locator('#send').tap()
  for i in range(100):
   summary=shared.get('summary',{})
   if summary.get('status') in ['completed','paused','stopped'] and (summary.get('status')!='paused' or summary.get('phase')):break
   await asyncio.sleep(.3)
  summary=shared.get('summary',{});print('SUMMARY',summary,flush=True)
  assert summary.get('status')=='completed',await chat.evaluate('window.lastAlert')
  result_path=next(path for path in summary['files'] if path.endswith('/python-result-py.json'))
  assert await frame.evaluate("""async()=>{
    const {StateStore}=await import('./src/state-store.js'); const store=await new StateStore().init();
    const old=await store.get('archive-'+oldTaskId); const current=await store.get('task');
    return !!old.pending && !!old.outbound && current.id!==old.id && !current.commands['old-command'];
  }""")
  assert await chat.locator('.answer').count()>=3
  await chat.wait_for_selector('.psy-agent-final')
  assert await chat.locator('.psy-agent-final').inner_text() == 'Сумма равна 6'
  await chat.wait_for_selector('.psy-agent-step')
  assert 'Готово' in await chat.locator('.psy-agent-step').first.inner_text()
  frame=next(f for f in chat.frames if f.url==EXT+'executor.html')
  result=await frame.evaluate("""async path=>{
    let d=await(await navigator.storage.getDirectory()).getDirectoryHandle('agent-results');
    const parts=path.split('/'); for(const part of parts.slice(0,-1))d=await d.getDirectoryHandle(part);
    return JSON.parse(await(await(await d.getFileHandle(parts.at(-1))).getFile()).text());
  }""",result_path)
  assert result['result']['sum']==6
  settings=await context.new_page();pages[2]=settings;await settings.goto(EXT+'workspace.html')
  await settings.locator('#files-toggle').click();await settings.wait_for_selector('#files button')
  assert await settings.evaluate('document.documentElement.scrollWidth <= innerWidth')
  async with settings.expect_download() as pending:
   await settings.locator('#files li').filter(has_text='python-result-py.json').locator('button').click()
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
  for i in range(100):
   if shared.get('summary',{}).get('status')=='paused':break
   await asyncio.sleep(.2)
  assert shared['summary']['status']=='paused',shared['summary']
  await asyncio.sleep(.2)
  await frame.evaluate("window.testRuntimeToken='unchanged'")
  await chat.evaluate("const h=document.createElement('header');h.className='the-header';document.body.prepend(h)")
  await chat.wait_for_timeout(300)
  assert await frame.evaluate("window.testRuntimeToken==='unchanged'"), 'Moving the toolbar must not reload the executor'
  await chat.evaluate("testShadow.querySelector('input').click()")
  for i in range(30):
   if shared.get('summary',{}).get('status')=='stopped':break
   await asyncio.sleep(.2)
  assert shared['summary']['status']=='stopped'
  old_id=await frame.evaluate("(async()=>{const {StateStore}=await import('./src/state-store.js');return (await (await new StateStore().init()).get('task')).id})()")
  await chat.evaluate("""() => { document.querySelector('#send').onclick=()=>{
    document.querySelector('#composer').value=''; const answer=document.createElement('div');
    answer.className='answer';answer.dataset.messageAuthorRole='assistant';
    answer.textContent=JSON.stringify({id:'resumed-finish',tool:'task.finish',args:{summary:'Продолжено без повторного вычисления'},description:'Готово'});
    const copy=document.createElement('button');copy.className='complete';copy.setAttribute('aria-label','Copy');answer.append(copy);
    document.querySelector('#answers').append(answer);
  }}""")
  await chat.evaluate("testShadow.querySelector('input').click()")
  await chat.locator('#composer').fill('продолжай');await chat.locator('#send').tap()
  for i in range(100):
   if shared.get('summary',{}).get('status')=='completed':break
   await asyncio.sleep(.2)
  assert shared['summary']['status']=='completed',shared['summary']
  assert await frame.evaluate("""async expected=>{
    const {StateStore}=await import('./src/state-store.js'); const s=await(await new StateStore().init()).get('task');
    return s.id===expected && s.commands.loop.result.status==='ok' && s.pythonJobs.loop.status==='cancelled' && !s.pending;
  }""",old_id)
  print('PASS: continue in chat restores the same stopped task, seals old Python outcome, and finishes without settings',flush=True)
  print('PASS: internal file download, denied direct executor message, stop through chat toggle',flush=True)
  print('PASS: mobile viewport, foreground extension iframe, actual service-worker routing, settings closed, chat → Python Worker → files → final response',flush=True)
  await b.close()
asyncio.run(main())
for s in servers:s.shutdown()
