"""Mobile history regression: compact protocol rows, stable updates and trusted manual scrolling."""
from pathlib import Path
from http.server import ThreadingHTTPServer,SimpleHTTPRequestHandler
import asyncio,functools,json,os,shutil,threading
from playwright.async_api import async_playwright
ROOT=Path(__file__).resolve().parents[2]
class Handler(SimpleHTTPRequestHandler):
 def log_message(self,*args):pass
server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(ROOT)))
threading.Thread(target=server.serve_forever,daemon=True).start()
async def main():
 async with async_playwright() as p:
  browser=await p.chromium.launch(executable_path=os.environ.get('CHROMIUM_BIN') or shutil.which('chromium'),args=['--no-sandbox'])
  page=await browser.new_page(viewport={'width':390,'height':844},is_mobile=True,has_touch=True)
  await page.goto(f'http://127.0.0.1:{server.server_port}/fixtures/article.html')
  await page.evaluate('''async()=>{
    const {mountChatScroll}=await import('/src/chat-scroll.js');
    const {mountFinalAnswers}=await import('/src/final-view.js');
    const {deepseekDOM}=await import('/src/chat-dom.js');
    const {responseUIKey}=await import('/src/tool-format.js');
    window.deepseekDOM=deepseekDOM;
    document.body.innerHTML='<style>body{margin:0} .ds-virtual-list{height:400px;overflow:auto;overflow-anchor:none} .ds-message{white-space:pre-wrap} [role=button],button{min-height:24px}</style><div class="ds-virtual-list"><div class="ds-virtual-list-items" style="min-height:2400px"><div class="ds-virtual-list-visible-items"></div></div></div><textarea></textarea><button aria-label="Send">Send</button>';
    const rows=document.querySelector('.ds-virtual-list-visible-items');
    for(let i=0;i<15;i++){const row=document.createElement('div');row.dataset.virtualListItemKey='old-'+i;row.style.height='120px';row.textContent='История '+i;rows.append(row);}
    const context=document.createElement('div');context.id='context';context.dataset.virtualListItemKey='context';context.style.minHeight='700px';
    context.innerHTML='<div class="ds-message"></div><div class="native-tools"><button>Copy</button><button>Edit</button></div>';
    context.firstChild.textContent='Режим Python-агента.\\nЗадача: Собрать данные\\nКонец задачи.\\n'+'инструменты '.repeat(200)+'\\nСостояние: {"steps":0,"last":null}';rows.append(context);
    const commands=[{id:'python',raw:'```python\\n'+'print(42)\\n'.repeat(200)+'```',description:'Вычислить результат'},
      {id:'finish',raw:'Ответ: 42',description:'Готово'}];
    for(const command of commands){const row=document.createElement('div');row.id=command.id;row.dataset.virtualListItemKey=command.id;row.style.minHeight=command.id==='finish'?'0':'800px';row.innerHTML='<div class="ds-message"><div class="ds-assistant-message-main-content"></div></div><button aria-label="Copy">Copy</button>';row.querySelector('.ds-assistant-message-main-content').textContent=command.raw;rows.append(row);}
    window.historyEntries=[{responseKey:responseUIKey(commands[0].raw),messageKey:'python',description:commands[0].description,status:'ok',detail:'Вычисление завершено.'}];
    window.scrollControl=mountChatScroll();
    window.view=mountFinalAnswers(()=>deepseekDOM('answer-elements'),{getHistory:()=>historyEntries,getFinals:()=>[{commandId:'finish',text:'Ответ: 42'}],preserveScroll:work=>scrollControl.guard.preserve(work)});
    window.list=document.querySelector('.ds-virtual-list');
    window.rawBefore=deepseekDOM('inspect').answer;
  }''')
  await page.wait_for_timeout(150)
  heights=await page.evaluate("Object.fromEntries(['context','python','finish'].map(id=>[id,document.getElementById(id).getBoundingClientRect().height]))")
  assert heights['context']<100 and heights['python']<150 and heights['finish']<100,heights
  assert await page.evaluate("document.querySelector('.ds-virtual-list-items').style.minHeight==='2400px'")
  assert await page.evaluate("deepseekDOM('inspect').answer===rawBefore && deepseekDOM('inspect').completion")
  assert await page.locator('#context .native-tools').evaluate('e=>e.getBoundingClientRect().height')==0
  print('PASS: accepted protocol rows lose reserved height; context toolbar collapses; virtual spacer and raw adapter answer remain intact',flush=True)
  await page.evaluate('''()=>{window.card=document.querySelector('.psy-agent-step');window.rawStyleChanges=0;const raw=document.querySelector('#python .ds-assistant-message-main-content');window.tracker=new MutationObserver(records=>rawStyleChanges+=records.length);tracker.observe(raw,{attributes:true,attributeFilter:['style']});for(let i=0;i<10;i++){historyEntries[0].detail='Обработано '+i;view.refresh();}}''')
  await page.wait_for_timeout(200)
  assert await page.evaluate("card===document.querySelector('.psy-agent-step') && rawStyleChanges===0")
  print('PASS: progress refresh updates the same card without restoring full code geometry',flush=True)
  await page.evaluate("list.scrollTop=list.scrollHeight")
  await page.mouse.move(180,180);await page.mouse.wheel(0,-300);await page.wait_for_timeout(150)
  assert await page.evaluate('scrollControl.guard.reading')
  before=await page.evaluate('list.scrollTop')
  result=await page.evaluate("deepseekDOM('reveal-latest')")
  assert result=={'revealed':False,'reason':'reading-history'},result
  await page.evaluate('list.scrollTop=list.scrollHeight');await page.wait_for_timeout(150)
  assert abs(await page.evaluate('list.scrollTop')-before)<2
  await page.mouse.wheel(0,-150);await page.wait_for_timeout(400)
  before=await page.evaluate('list.scrollTop')
  for i in range(3):
   await page.evaluate('list.scrollTop=list.scrollHeight');await page.wait_for_timeout(100)
  assert abs(await page.evaluate('list.scrollTop')-before)<2
  await page.evaluate("historyEntries[0].detail='Новое состояние';view.refresh()")
  await page.wait_for_timeout(150)
  assert abs(await page.evaluate('list.scrollTop')-before)<2
  await page.evaluate("scrollControl.guard.preserve(()=>document.querySelector('[data-virtual-list-item-key=old-0]').style.height='80px')")
  await page.wait_for_timeout(100)
  assert abs(await page.evaluate('list.scrollTop')-(before-40))<2
  print('PASS: real wheel scrolling disables reveal-latest; repeated native autoscroll and tool updates preserve history position',flush=True)
  # Actual trusted mobile touch gestures must be allowed while native autoscroll is blocked.
  session=await page.context.new_cdp_session(page)
  before=await page.evaluate('list.scrollTop')
  await session.send('Input.dispatchTouchEvent',{'type':'touchStart','touchPoints':[{'x':180,'y':100}]})
  for y in [130,160,200,240]:
   await session.send('Input.dispatchTouchEvent',{'type':'touchMove','touchPoints':[{'x':180,'y':y}]});await page.wait_for_timeout(30)
  await session.send('Input.dispatchTouchEvent',{'type':'touchEnd','touchPoints':[]});await page.wait_for_timeout(450)
  assert await page.evaluate('list.scrollTop')<before-30
  print('PASS: trusted touch swipe continues scrolling upward instead of being pulled to the latest turn',flush=True)
  await page.mouse.wheel(0,10000);await page.wait_for_timeout(150)
  assert not await page.evaluate('scrollControl.guard.reading')
  assert (await page.evaluate("deepseekDOM('reveal-latest')"))['revealed']
  await page.mouse.wheel(0,-200);await page.wait_for_timeout(150)
  assert await page.evaluate('scrollControl.guard.reading')
  await page.locator('textarea').press('Enter')
  assert not await page.evaluate('scrollControl.guard.reading')
  await page.mouse.move(180,180);await page.mouse.wheel(0,-100);await page.wait_for_timeout(150)
  assert await page.evaluate('scrollControl.guard.reading')
  await page.evaluate("history.pushState({},'',location.pathname+'?other-chat');scrollControl.guard.reading")
  assert not await page.evaluate('scrollControl.guard.reading')
  await page.evaluate('view();scrollControl()')
  assert await page.evaluate("document.getElementById('context').style.minHeight==='700px' && !globalThis.__psyAgentScroll")
  print('PASS: deliberate return to the bottom resumes following; navigation and unmount reset the guard and restore original styles',flush=True)
  await browser.close()
asyncio.run(main());server.shutdown()
