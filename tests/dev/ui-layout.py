"""Mobile/dark-mode layout checks with mocked Chrome transport; no live DeepSeek."""
from pathlib import Path
import asyncio, functools, os, shutil, tempfile, threading
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from playwright.async_api import async_playwright
ROOT=Path(__file__).resolve().parents[2]
server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(SimpleHTTPRequestHandler,directory=str(ROOT)))
threading.Thread(target=server.serve_forever,daemon=True).start();BASE=f'http://127.0.0.1:{server.server_port}/'
OUT=Path(os.environ.get('UI_PREVIEW_DIR',Path(tempfile.gettempdir())/'deepseek-agent-ui-preview'));OUT.mkdir(parents=True,exist_ok=True)
async def main():
 async with async_playwright() as p:
  browser=await p.chromium.launch(executable_path=os.environ.get('CHROMIUM_BIN') or shutil.which('chromium'),args=['--no-sandbox'])
  for theme in ['light','dark']:
   context=await browser.new_context(viewport={'width':390,'height':844},is_mobile=True,has_touch=True,color_scheme=theme)
   await context.add_init_script('''window.allShadows=[];const attach=Element.prototype.attachShadow;Element.prototype.attachShadow=function(o){const s=attach.call(this,o);allShadows.push(s);window.testShadow=s;return s};window.storageListeners=[];window.siteAccess=true;window.values={'file-mode':'browser','browser-mode':'auto','chat-bindings':{input:'#composer',send:'#send'}};
   window.sent=[];window.chrome={runtime:{id:'test-extension',getURL:p=>location.origin+'/'+p,onMessage:{addListener:f=>window.receive=f},sendMessage:async m=>{sent.push(m);return {ok:true,data:m.type==='engine-ping'?{tabId:1,chatURL:location.href}:{capabilities:{debugger:true,scripting:true}}}}},storage:{local:{get:async keys=>Object.fromEntries((typeof keys==='string'?[keys]:keys).map(k=>[k,values[k]])),set:async data=>{Object.assign(values,data);for(const f of storageListeners)f(Object.fromEntries(Object.entries(data).map(([k,v])=>[k,{newValue:v}])),'local')}},session:{get:async()=>({'settings-chat-tab':1}),set:async()=>{}},onChanged:{addListener:f=>storageListeners.push(f)}},tabs:{query:async()=>[{id:1,url:'https://chat.deepseek.com/a/chat/test',title:'DeepSeek',active:true}],update:async()=>({id:1}),sendMessage:async()=>({ok:true})},permissions:{contains:async()=>siteAccess,request:async()=>{siteAccess=true;return true}},scripting:{executeScript:async()=>[{result:{status:'ready'}}]}};
   ''')
   settings=await context.new_page();await settings.goto(BASE+'workspace.html');await settings.wait_for_function("document.querySelector('#chat-status').textContent==='Подключён'")
   assert not await settings.locator('#advanced').get_attribute('open')
   assert await settings.locator('#access-row').is_hidden()
   assert await settings.locator('button:visible').count()==2
   assert await settings.locator('#consent').count()==0
   assert await settings.evaluate('document.documentElement.scrollWidth<=innerWidth')
   await settings.screenshot(path=str(OUT/f'settings-{theme}.png'))
   await settings.evaluate("siteAccess=false;chrome.storage.local.set({'browser-mode':'scripting'})")
   await settings.wait_for_selector('#access-row');await settings.locator('#access').tap();await settings.wait_for_timeout(200)
   assert await settings.locator('#access-row').is_hidden()
   chat=await context.new_page();await chat.route('**/executor.html',lambda r:r.fulfill(body='<html></html>',content_type='text/html'))
   await chat.goto(BASE+'fixtures/chat-ui.html')
   await chat.evaluate("values.summary={taskId:'t',ownerTabId:1,ownerURL:location.href,status:'paused',message:'Ответ DeepSeek пока не подтверждён. Можно написать продолжай. Можно написать продолжай.',current:'Повторно объединить темы',savedPages:4};values['agent-data-notice']=true")
   await chat.add_script_tag(url=BASE+'src/chat-ui.js');await chat.wait_for_timeout(400)
   await chat.evaluate("testShadow.querySelector('input').click()");await chat.wait_for_timeout(200)
   bounds=await chat.evaluate('''()=>{const r=testShadow.host.getBoundingClientRect();return {height:r.height,position:getComputedStyle(testShadow.host).position}}''')
   assert bounds['height']<=48 and bounds['position']!='fixed',bounds
   assert await chat.evaluate("testShadow.host.nextElementSibling===document.querySelector('.deepseek-agent-progress') && document.querySelector('.deepseek-agent-progress').nextElementSibling===document.querySelector('form')"), 'Controls must precede the composer, independent of headers'
   gear=await chat.evaluate("()=>{const r=testShadow.querySelector('button').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}}")
   assert await chat.evaluate("({x,y})=>document.elementFromPoint(x,y)===testShadow.host",gear), 'Settings must be on screen and not covered'
   await chat.touchscreen.tap(gear['x'],gear['y'])
   assert await chat.evaluate("sent.some(m=>m.type==='open-workspace')"), 'A real tap must open settings'
   assert await chat.locator('.deepseek-agent-step').count()==0
   text=await chat.locator('.deepseek-agent-progress').inner_text()
   assert text=='Пауза. Не удалось прочитать ответ DeepSeek.',text
   assert 'Агент работает' not in await chat.locator('body').inner_text()
   assert await chat.evaluate('document.documentElement.scrollWidth<=innerWidth')
   await chat.evaluate("window.originalEngine=allShadows[0].querySelector('iframe').contentWindow;const h=document.querySelector('header:not([hidden])');h.replaceWith(h.cloneNode(true));const form=document.querySelector('form');form.replaceWith(form.cloneNode(true))")
   await chat.wait_for_timeout(300)
   assert await chat.evaluate("originalEngine===allShadows[0].querySelector('iframe').contentWindow && document.querySelectorAll('[data-deepseek-agent-toolbar]').length===1")
   assert await chat.evaluate("document.querySelector('.deepseek-agent-progress').nextElementSibling===document.querySelector('form') && !testShadow.host.closest('header')")
   await chat.screenshot(path=str(OUT/f'chat-{theme}.png'))
   await chat.evaluate('''async()=>{
     const {responseUIKey}=await import('/src/tool-format.js');const raw=document.querySelector('#answer').textContent;const command={description:'Выполнить сценарий'};
     const entry={responseKey:responseUIKey(raw),description:command.description,status:'running',detail:''};
     await chrome.storage.local.set({'ui-history':[{taskId:'t',chatURL:location.href,entries:[entry]}],summary:{...values.summary,status:'running',phase:'executing',current:command.description,message:''}});
   }''')
   await chat.wait_for_selector('.deepseek-agent-step');assert 'Выполняется' in await chat.locator('.deepseek-agent-step').inner_text()
   await chat.evaluate('''async()=>{
     const history=structuredClone(values['ui-history']);history[0].entries[0].status='ok';history[0].entries[0].detail='Вычисление завершено.';
     await chrome.storage.local.set({'ui-history':history,summary:{...values.summary,phase:'waiting',waitElapsed:15}});
   }''')
   await chat.wait_for_function("document.querySelector('.deepseek-agent-step').textContent.includes('Готово')")
   assert '15 с' in await chat.locator('.deepseek-agent-progress').inner_text()
   await chat.screenshot(path=str(OUT/f'chat-history-{theme}.png'))
   await settings.evaluate('''async()=>{
     chrome.tabs.onRemoved={addListener(){}};
     chrome.debugger={attach:async()=>{throw new Error('Debugger unavailable')}};
     const {BrowserTools}=await import('./src/browser-tools.js');
     const tools=new BrowserTools({tabs:[]},async()=>{},async()=>{throw new Error('Unexpected approval')});
     tools.check=async()=>({id:2});tools.attach=async()=>{throw new Error('Debugger unavailable')};
     const result=await tools.runOnce(2,'snapshot');
     if(!tools.autoFallback||!values['browser-auto-fallback']||result.status!=='ready')throw new Error('Automatic fallback failed');
     tools.autoFallback=false;tools.interrupted=true;
     let blocked=false;try{await tools.runOnce(2,'snapshot')}catch{blocked=true}
     if(!blocked||tools.autoFallback)throw new Error('Manual interruption must not trigger fallback');
     tools.interrupted=false;tools.transport='cdp';blocked=false;
     try{await tools.runOnce(2,'snapshot')}catch{blocked=true}
     if(!blocked||tools.autoFallback)throw new Error('Explicit CDP must not silently change transport');
   }''')
   print('PASS:',theme,'compact settings, conditional access, no consent, inline toolbar <=48px, single controller pause, stable executor, no horizontal overflow')
   print('PASS: automatic scripting fallback, manual interruption respected, explicit CDP respected')
   await context.close()
  await browser.close()
asyncio.run(main());server.shutdown()
