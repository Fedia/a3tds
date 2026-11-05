from pathlib import Path
import os, shutil, tempfile
import asyncio,json,threading,functools
from http.server import ThreadingHTTPServer,SimpleHTTPRequestHandler
from playwright.async_api import async_playwright
ROOT=str(Path(__file__).resolve().parents[2])
class Handler(SimpleHTTPRequestHandler):
 def end_headers(self):
  self.send_header('Access-Control-Allow-Origin','*')
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
  pages={};chat_urls={};next_work=[100];shared={'cloud-consent':False,'file-mode':'browser','browser-mode':'scripting','chat-bindings':{'input':'#composer','send':'#send','response':'.answer','complete':'.complete'}}
  async def dispatch(source,msg,target=None):
   origin=source['frame'];url=origin.url;page=source['page'];tabid=next((n for n,x in pages.items() if x==page),None)
   sender={'id':'test-extension','url':url,'frameId':0 if origin==page.main_frame else 1}
   if url.startswith(CHAT):sender['url']=chat_urls.get(tabid,'https://chat.deepseek.com/a/chat/test')
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
   if op=='set-chat-url':chat_urls[arg['id']]=arg['url'];return None
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
   if op=='get-tab':return {'id':arg,'url':chat_urls.get(arg,pages[arg].url),'status':'complete'}
   if op=='query':return [{'id':i,'url':url,'title':'Chat '+str(i)} for i,url in chat_urls.items() if i in pages]
   if op=='update':return {'id':arg}
   if op=='create':
    n=next_work[0];next_work[0]+=1;page=await context.new_page();pages[n]=page;await page.goto(arg['url']);return {'id':n,'url':page.url}
   if op=='navigate':await pages[arg['id']].goto(arg['options']['url']);return {'id':arg['id'],'url':pages[arg['id']].url}
   if op=='remove':await pages[arg].close();pages.pop(arg,None);return None
   if op=='script':return [{'result':await pages[arg['id']].evaluate('([source,args])=>('+arg['source']+')(...args)',[arg['source'],arg['args']])}]
   if op=='permission':return True
   raise Exception(op)
  await context.expose_binding('bridge',bridge)
  script='''window.localView=value=>{if(location.href.startsWith(CHAT)&&value){const dialog=new URL(location.href).searchParams.get('dialog');const native='https://chat.deepseek.com/a/chat/'+dialog;if(value.ownerURL===native)value.ownerURL=location.href;if(value.chatURL===native)value.chatURL=location.href;}return value};window.listeners=[];window.storageListeners=[];const evt={addListener(){}};
window.chrome={runtime:{id:'test-extension',getURL:p=>EXT+p,onMessage:{addListener:f=>listeners.push(f)},sendMessage:async m=>{const result=await bridge('message',m);if(m.type==='chat-ready')window.readyReply=result;return result}},action:{onClicked:evt},permissions:{request:()=>bridge('permission',{}),contains:()=>bridge('permission',{})},storage:{local:{get:async k=>{const d=await bridge('get-storage',k);for(const [key,value] of Object.entries(d)){if(key.startsWith('summary:'))localView(value);if(key.startsWith('history:')&&value)value.forEach(localView);}return d},set:v=>bridge('set-storage',v)},session:{get:k=>bridge('get-storage',k),set:v=>bridge('set-session',v)},onChanged:{addListener:f=>storageListeners.push((changes,area)=>{for(const [key,item] of Object.entries(changes)){if(key.startsWith('summary:'))localView(item.newValue);if(key.startsWith('history:')&&item.newValue)item.newValue.forEach(localView);}f(changes,area)})}},tabs:{getCurrent:()=>bridge('current',null),get:id=>bridge('get-tab',id),query:q=>bridge('query',q),update:(id,options)=>bridge('navigate',{id,options}),create:options=>bridge('create',options),remove:id=>bridge('remove',id),onRemoved:evt,sendMessage:(id,message)=>bridge('tab-message',{id,message})},scripting:{executeScript:a=>bridge('script',{id:a.target.tabId,source:a.func.toString(),args:a.args})}};
const attach=Element.prototype.attachShadow;Element.prototype.attachShadow=function(options){const r=attach.call(this,options);window.testShadow=r;return r};window.alert=text=>{window.lastAlert=text};window.confirm=()=>{throw new Error('Unexpected confirmation')};
'''.replace('EXT',json.dumps(EXT)).replace('CHAT',json.dumps(CHAT))
  await context.add_init_script(script)
  # Empty page hosts the actual service worker source with emulated Chrome API transport.
  sw=await context.new_page();await sw.goto(EXT+'service-worker-host');await sw.add_script_tag(url=EXT+'src/service-worker.js')
  async def chat_page(n,dialog,code=None):
   page=await context.new_page();pages[n]=page;chat_urls[n]='https://chat.deepseek.com/a/chat/'+dialog
   await page.goto(CHAT+'fixtures/chat.html?dialog='+dialog)
   await page.evaluate("""({code,dialog})=>{window.modelSends=0;document.querySelector('#send').onclick=()=>{
    const prompt=document.querySelector('#composer').value;document.querySelector('#composer').value='';window.modelSends++;
    const answer=document.createElement('div');answer.className='answer';answer.dataset.messageAuthorRole='assistant';
    answer.textContent=window.modelSends===1&&code?'```python\\n'+code+'\\n```':'Готово: '+dialog;
    const copy=document.createElement('button');copy.className='complete';copy.setAttribute('aria-label','Copy');answer.append(copy);document.querySelector('#answers').append(answer);
   }}""",{'code':code,'dialog':dialog})
   await page.add_script_tag(url=EXT+'src/chat-ui.js')
   await page.wait_for_function("()=>window.testShadow?.querySelector('input')?.onchange")
   await page.evaluate("testShadow.querySelector('input').click()")
   await page.wait_for_function("()=>window.readyReply?.ok===true")
   frame=next(f for f in page.frames if f.url==EXT+'executor.html')
   await frame.evaluate("""async()=>{const {PythonRuntime}=await import('/src/python-runtime.js');const run=PythonRuntime.prototype.run;PythonRuntime.prototype.run=function(...args){window.observedRuntime=this;return run.apply(this,args)}}""")
   return page,frame
  def state(n):return next((v for k,v in shared.items() if k.startswith('summary:') and v and v.get('ownerTabId')==n),{})
  async def wait(predicate,seconds=45):
   end=asyncio.get_running_loop().time()+seconds
   while asyncio.get_running_loop().time()<end:
    if predicate():return
    await asyncio.sleep(.1)
   raise AssertionError({i:state(i) for i in [1,3,4]})
  def code_for(dialog):return f"""from agent import browser, progress
from pathlib import Path
import asyncio
owner={dialog!r}
await browser.open({(EXT+'fixtures/article.html')!r})
Path('{dialog}-checkpoint.txt').write_text(owner)
progress('Выполняется '+owner)
await asyncio.sleep(16)
Path('{dialog}-result.txt').write_text(owner)
result={{'owner':owner}}"""
  a,fa=await chat_page(1,'A',code_for('A'));bb,fb=await chat_page(3,'B',code_for('B'))
  await a.locator('#composer').fill('Задача A');await a.locator('#send').tap()
  await bb.locator('#composer').fill('Задача B');await bb.locator('#send').tap()
  await wait(lambda:all(state(i).get('status')=='running' and state(i).get('pythonPhase')=='running' and f'{label}-checkpoint.txt' in state(i).get('files',[]) for i,label in [(1,'A'),(3,'B')]))
  id_a,id_b=state(1)['chatId'],state(3)['chatId'];assert id_a!=id_b
  session_b=await fb.evaluate('observedRuntime.sessionId');assert session_b
  async def task(frame,chatid):return await frame.evaluate("""async id=>{const {StateStore}=await import('/src/state-store.js');return(await new StateStore().init()).forChat(id).get('task')}""",chatid)
  ta,tb=await task(fa,id_a),await task(fb,id_b)
  assert {t['id'] for t in ta['tabs']}.isdisjoint({t['id'] for t in tb['tabs']}) and ta['tabs'] and tb['tabs']
  assert 'Выполняется B' not in await a.locator('body').inner_text() and 'Выполняется A' not in await bb.locator('body').inner_text()
  print('PASS: two real Python Workers and browser work tabs run concurrently; per-chat state, files and history stay separate',flush=True)
  duplicate,fd=await chat_page(4,'A',None)
  await duplicate.locator('#composer').fill('Не запускать повторно');await duplicate.locator('#send').tap()
  await duplicate.wait_for_function("()=>document.querySelector('.deepseek-agent-progress')?.textContent.includes('другой вкладке')")
  assert await duplicate.evaluate('modelSends')==0 and state(1)['status']=='running'
  await duplicate.evaluate("testShadow.querySelector('input').click()")
  assert state(1)['status']=='running'
  await duplicate.close();pages.pop(4);chat_urls.pop(4)
  print('PASS: duplicate tab of same dialog cannot execute or stop the owning tab',flush=True)
  await a.evaluate("testShadow.querySelector('input').click()")
  await wait(lambda:state(1).get('status')=='stopped')
  assert state(3)['status']=='running' and await fb.evaluate('observedRuntime.sessionId')==session_b
  await a.close();pages.pop(1);chat_urls.pop(1)
  await wait(lambda:state(3).get('status')=='completed')
  assert (await fb.evaluate("observedRuntime.run('result=owner')"))['result']=='B'
  assert await fb.evaluate('observedRuntime.sessionId')==session_b
  print('PASS: stopping and closing A leaves B running; B completes with its Python variables/session preserved',flush=True)
  a,fa=await chat_page(1,'A',None)
  await a.locator('#composer').fill('продолжай');await a.locator('#send').tap()
  await wait(lambda:state(1).get('status')=='completed')
  restored=await task(fa,id_a);assert restored['id']==ta['id'] and any(x['result'].get('error',{}).get('code')=='SCRIPT_INTERRUPTED' for x in restored['commands'].values())
  assert state(3)['status']=='completed' and (await fb.evaluate("observedRuntime.run('result=owner')"))['result']=='B'
  print('PASS: reopening A restores only A after interruption; completed B state and interpreter remain untouched',flush=True)
  settings=await context.new_page();pages[2]=settings;shared['settings-chat-tab']=1;await settings.goto(EXT+'workspace.html');await settings.wait_for_selector('#folder')
  old_b=shared['project:'+id_b].copy()
  await settings.locator('#folder').click();await settings.locator('#internal').click();await settings.wait_for_timeout(300)
  assert shared['project:'+id_b]==old_b and await fb.evaluate('observedRuntime.sessionId')==session_b
  await settings.locator('#files-toggle').click();await settings.wait_for_selector('#files button')
  assert 'A-checkpoint.txt' in await settings.locator('#files').inner_text() and 'B-result.txt' not in await settings.locator('#files').inner_text()
  async with settings.expect_download() as download:
   await settings.locator('#files li').filter(has_text='A-checkpoint.txt').locator('button').click()
  target=Path(tempfile.gettempdir())/'deepseek-agent-multi-test.txt';await(await download.value).save_as(str(target));assert target.read_text()=='A'
  print('PASS: settings/download list follow selected dialog; changing A storage does not reset B',flush=True)
  # A new conversation starts without a URL ID; confirm its own posted prompt,
  # then retain the same session identity when the site creates the URL.
  draft=await context.new_page();pages[5]=draft;chat_urls[5]='https://chat.deepseek.com/'
  await draft.goto(CHAT+'fixtures/chat.html?dialog=draft')
  await draft.evaluate("""()=>{document.querySelector('#send').onclick=async()=>{
   const text=document.querySelector('#composer').value;document.querySelector('#composer').value='';
   const user=document.createElement('div');user.className='ds-message';user.textContent=text;document.querySelector('#answers').append(user);
   await bridge('set-chat-url',{id:5,url:'https://chat.deepseek.com/a/chat/created'});
   const answer=document.createElement('div');answer.className='answer';answer.dataset.messageAuthorRole='assistant';answer.textContent='Новый диалог готов';
   const copy=document.createElement('button');copy.className='complete';copy.setAttribute('aria-label','Copy');answer.append(copy);document.querySelector('#answers').append(answer);
  }}""")
  await draft.add_script_tag(url=EXT+'src/chat-ui.js');await draft.wait_for_function("()=>window.testShadow?.querySelector('input')?.onchange")
  await draft.evaluate("testShadow.querySelector('input').click()");await draft.wait_for_function("()=>window.readyReply?.ok")
  df=next(f for f in draft.frames if f.url==EXT+'executor.html')
  draft_id=await df.evaluate("async()=>{const {StateStore}=await import('/src/state-store.js');const {ChatSessions}=await import('/src/chat-sessions.js');return new ChatSessions(await new StateStore().init()).resolve(5,'https://chat.deepseek.com/')}")
  await draft.locator('#composer').fill('Первая задача нового диалога');await draft.locator('#send').tap();await wait(lambda:state(5).get('status')=='completed')
  assert state(5)['chatId']==draft_id
  assert await df.evaluate("async()=>{const {StateStore}=await import('/src/state-store.js');return(await(await new StateStore().init()).get('chat-sessions')).find(s=>s.url==='https://chat.deepseek.com/a/chat/created').id}")==draft_id
  print('PASS: first message promotes a temporary conversation identity after verified delivery without splitting state',flush=True)
  # Navigating an existing chat must never send its task into the destination chat.
  await fa.evaluate("async()=>{const {DeepSeekAdapter}=await import('/src/deepseek-adapter.js');const {StateStore}=await import('/src/state-store.js');window.checkedAdapter=new DeepSeekAdapter(await new StateStore().init());await checkedAdapter.connect(1,{input:'#composer',send:'#send'})}")
  chat_urls[1]='https://chat.deepseek.com/a/chat/B'
  assert await fa.evaluate("async()=>{try{await checkedAdapter.dom('send','must-not-send');return false}catch(e){return e.message.includes('другой диалог')}}")
  assert await a.locator('#composer').input_value()==''
  print('PASS: adapter rejects cross-conversation navigation before inserting/sending another task',flush=True)
  await b.close()
asyncio.run(main())
for s in servers:s.shutdown()
