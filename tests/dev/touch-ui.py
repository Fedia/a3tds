from pathlib import Path
import os, shutil, tempfile
import asyncio,threading,functools
from http.server import ThreadingHTTPServer,SimpleHTTPRequestHandler
from playwright.async_api import async_playwright
server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(SimpleHTTPRequestHandler,directory=str(Path(__file__).resolve().parents[2])));threading.Thread(target=server.serve_forever,daemon=True).start()
async def main():
 async with async_playwright() as p:
  b=await p.chromium.launch(executable_path=os.environ.get('CHROMIUM_BIN') or shutil.which('chromium'),headless=True,args=['--no-sandbox']);page=await b.new_page(viewport={'width':390,'height':844},is_mobile=True,has_touch=True)
  await page.add_init_script('''window.messages=[];window.bindings={input:'#composer',send:'#send',response:'.answer',complete:'.complete'};window.chrome={runtime:{id:'test-extension',getURL:p=>location.origin+'/'+p,sendMessage:async m=>{messages.push(m);return {ok:true}},onMessage:{addListener:f=>window.receive=f}},storage:{local:{get:async()=>({'chat-bindings':bindings}),set:async v=>{window.saved=v;window.bindings=v['chat-bindings']}},onChanged:{addListener(){}}}};const attach=Element.prototype.attachShadow;Element.prototype.attachShadow=function(options){const r=attach.call(this,options);window.testShadow=r;return r;};window.alert=()=>{};''')
  await page.route('**/executor.html',lambda route:route.fulfill(status=200,body='<html></html>',content_type='text/html'))
  await page.goto(f'http://127.0.0.1:{server.server_port}/fixtures/chat.html')
  await page.evaluate("() => {const meta=document.createElement('meta');meta.name='viewport';meta.content='width=device-width, initial-scale=1';document.head.append(meta);document.body.style.paddingTop='240px'}");await page.add_script_tag(url='/src/chat-ui.js');await page.wait_for_timeout(100)
  await page.evaluate("window.bindings = {}; testShadow.querySelector('input').click()")
  await page.locator('#composer').fill('Моя задача');await page.locator('#send').tap();await page.wait_for_timeout(100)
  assert await page.evaluate("messages.filter(m=>m.type==='chat-task').length") == 1
  assert await page.locator('.answer').count()==0
  await page.locator('#composer').press('Enter');await page.wait_for_timeout(100)
  assert await page.evaluate("messages.filter(m=>m.type==='chat-task').length") == 2
  await page.evaluate("testShadow.querySelector('input').click()")
  assert await page.evaluate("messages.some(m=>m.type==='chat-stop')")
  await page.locator('#send').tap();await page.wait_for_timeout(150)
  assert await page.locator('.answer').count()==1
  await page.evaluate("receive({type:'pick-bindings'},{id:'test-extension'},r=>window.pickResult=r)")
  await page.locator('#composer').tap();await page.locator('#send').tap()
  await page.locator('.answer').tap(position={'x':20,'y':5});await page.locator('.complete').tap();await page.wait_for_timeout(100)
  assert await page.evaluate("pickResult.ok && !!saved['chat-bindings'].response && !!saved['chat-bindings'].complete")
  assert await page.locator('.answer').count()==1
  await page.evaluate("testShadow.querySelector('input').click()")
  await page.evaluate("document.querySelector('#send').click()")
  await page.wait_for_timeout(150)
  assert await page.locator('.answer').count()==2
  await page.evaluate("receive({type:'pick-bindings'},{id:'test-extension'},r=>window.cancelResult=r)")
  await page.get_by_text('Отменить',exact=True).tap();await page.wait_for_timeout(100)
  assert await page.evaluate("cancelResult.error === 'Настройка отменена'")
  print('PASS: click/Enter interception, ordinary chat, stop toggle, four-click picker, programmatic adapter send')
  await b.close()
asyncio.run(main());server.shutdown()
