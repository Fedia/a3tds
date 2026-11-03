"""Rendered code blocks and receipt correlation for protocol v2, artificial DOM only."""
from pathlib import Path
from http.server import ThreadingHTTPServer,SimpleHTTPRequestHandler
import asyncio,functools,os,shutil,threading
from playwright.async_api import async_playwright
ROOT=Path(__file__).resolve().parents[2]
class Handler(SimpleHTTPRequestHandler):
 def log_message(self,*args):pass
server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(ROOT)))
threading.Thread(target=server.serve_forever,daemon=True).start()
async def main():
 async with async_playwright() as p:
  b=await p.chromium.launch(executable_path=os.environ.get('CHROMIUM_BIN') or shutil.which('chromium'),args=['--no-sandbox'])
  page=await b.new_page();await page.goto(f'http://127.0.0.1:{server.server_port}/fixtures/article.html')
  await page.evaluate('''async()=>{
    const {deepseekDOM}=await import('/src/chat-dom.js');const {mountFinalAnswers}=await import('/src/final-view.js');const {responseUIKey}=await import('/src/tool-format.js');
    window.dom=deepseekDOM;window.key=responseUIKey;
    document.body.innerHTML='<div class="ds-virtual-list"><div class="ds-virtual-list-visible-items"></div></div><textarea></textarea><button aria-label="Send">Send</button>';
    window.add=(id,text,language)=>{const row=document.createElement('div');row.dataset.virtualListItemKey=id;row.innerHTML='<div class="ds-message"><div class="ds-assistant-message-main-content"></div></div><button aria-label="Copy">Copy</button>';const source=row.querySelector('.ds-assistant-message-main-content');if(language){const pre=document.createElement('pre'),code=document.createElement('code');code.className='language-'+language;code.textContent=text;pre.append(code);source.append(pre);}else source.textContent=text;document.querySelector('.ds-virtual-list-visible-items').append(row);return row};
    window.short=JSON.stringify({tool:'browser.snapshot',args:{tabId:1}});
    add('one',short);add('two',short);window.entries=[{responseKey:key(short),messageKey:'one',description:'Первое чтение',status:'ok',detail:'сохранено'}];window.finals=[];
    window.view=mountFinalAnswers(()=>dom('answer-elements'),{getHistory:()=>entries,getFinals:()=>finals});
  }''')
  assert await page.locator('.psy-agent-step').count()==1
  assert 'Первое чтение' in await page.locator('[data-virtual-list-item-key=one] .psy-agent-step').inner_text()
  assert await page.locator('[data-virtual-list-item-key=two] .psy-agent-step').count()==0
  await page.evaluate("entries.push({responseKey:key(short),messageKey:'two',description:'Второе чтение',status:'error',detail:'ошибка'});view.refresh()")
  assert await page.locator('.psy-agent-step').count()==2
  assert 'Ошибка' in await page.locator('[data-virtual-list-item-key=two] .psy-agent-step').inner_text()
  print('PASS: identical short commands bind to different native message keys and cannot borrow each other\'s receipts',flush=True)
  await page.evaluate('''()=>{window.code='text = "quote"\\nresult = 42';add('python',code,'python.run');window.wire=dom('inspect').answer;entries.push({responseKey:key(wire),messageKey:'python',description:'Проверить код',status:'ok',detail:'42'});view.refresh()}''')
  assert await page.evaluate("wire==='```python.run\\n'+code+'\\n```'")
  assert '42' in await page.locator('[data-virtual-list-item-key=python] .psy-agent-step').inner_text()
  await page.evaluate("add('ordinary','print(\"example\")','python');view.refresh()")
  assert 'print' in await page.locator('[data-virtual-list-item-key=ordinary]').inner_text()
  assert await page.locator('[data-virtual-list-item-key=ordinary] .psy-agent-step').count()==0
  assert 'print' in await page.evaluate("dom('inspect').answer")
  print('PASS: explicit rendered python.run block reconstructed; ordinary Python example stays visible and remains ordinary text',flush=True)
  await page.evaluate('''()=>{window.final=JSON.stringify({tool:'task.finish',args:{summary:'Готовый ответ'}});add('final',final,'json');finals.push({responseKey:key(final),messageKey:'final',text:'Готовый ответ'});view.refresh()}''')
  assert await page.locator('.psy-agent-final').inner_text()=='Готовый ответ'
  assert await page.evaluate("dom('inspect').answer===final")
  await page.evaluate('''()=>{const root=document.querySelector('.ds-virtual-list');const next=root.cloneNode(false);next.innerHTML='<div class=ds-virtual-list-visible-items></div>';root.replaceWith(next);add('final',final,'json');view.refresh();}''')
  assert await page.locator('.psy-agent-final').count()==1
  print('PASS: short final renders from its receipt; JSON code stays readable to adapter after native list remount',flush=True)
  await b.close()
asyncio.run(main());server.shutdown()
