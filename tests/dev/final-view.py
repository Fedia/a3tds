"""Offline rendering regression. Optional argument: private DeepSeek DOM export."""
from pathlib import Path
import asyncio, json, os, re, shutil, sys
from playwright.async_api import async_playwright
ROOT = Path(__file__).resolve().parents[2]
path = Path(sys.argv[1]) if len(sys.argv)>1 else ROOT/'fixtures/deepseek-observed.html'
html = re.sub(r'<script\b[^>]*>.*?</script>', '', path.read_text(), flags=re.I|re.S)
source = '\n'.join((ROOT/'src'/name).read_text().replace('export function', 'function') for name in ['tool-format.js','ui-state.js','chat-dom.js','final-view.js'])
source = re.sub(r"import\s*\{\s*commandUIKey\s*\}\s*from './ui-state.js';\n", '', source)
source = re.sub(r"import\s*\{[^}]*\}\s*from './tool-format.js';\n", '', source)
async def main():
 async with async_playwright() as p:
  browser=await p.chromium.launch(executable_path=os.environ.get('CHROMIUM_BIN') or shutil.which('chromium'),args=['--no-sandbox'])
  page=await browser.new_page();await page.route('**/*',lambda r:r.abort());await page.set_content(html)
  await page.add_script_tag(content=source)
  expected=await page.evaluate("JSON.parse(deepseekDOM('inspect',{}).answer).args.summary")
  await page.evaluate("""() => {
    window.originalAnswer=deepseekDOM('inspect',{}).answer;
    const command=JSON.parse(originalAnswer);window.acceptedFinals=[];window.actionHistory=[];
    window.unmount=mountFinalAnswers(()=>deepseekDOM('answer-elements',{}),{getFinals:()=>acceptedFinals,getHistory:()=>actionHistory});
    const rawSource=deepseekDOM('answer-elements',{}).find(a=>a.raw===originalAnswer).source;
    if(rawSource.getBoundingClientRect().height<=0)throw new Error('Unaccepted answer geometry must remain available');
    if(document.querySelector('.psy-agent-final'))throw new Error('Unconfirmed final must remain hidden');
    acceptedFinals=[{commandId:command.id,text:command.args.summary}];unmount.refresh();
  }""")
  assert await page.locator('.psy-agent-final').count()==1
  assert await page.locator('.psy-agent-step').count()==0
  assert await page.locator('.psy-agent-final').evaluate("e=>getComputedStyle(e).borderTopWidth==='0px'")
  assert await page.locator('.psy-agent-final > div').text_content()==expected
  assert await page.evaluate("deepseekDOM('inspect',{}).answer === originalAnswer")
  assert await page.evaluate(r"""deepseekDOM('answer-elements',{}).filter(a=>a.context || /\"tool\"\s*:/.test(a.raw)).every(a=>{let e=a.source;while(e&&e!==document.body){if(getComputedStyle(e).opacity==='0')return true;e=e.parentElement}return false})""")
  # Accepted tool history follows local receipts, never the model's self-reported status.
  await page.evaluate("""()=>{
    const command={id:'history',tool:'browser.extract',args:{tabId:1,kind:'text'},description:'Собрать посты форума'};
    const body=document.querySelector('.ds-assistant-message-main-content');window.historyBody=body;window.historyOriginal=body.textContent;window.historyCommand=command;
    body.textContent=JSON.stringify(command);actionHistory=[{key:commandUIKey(command),description:command.description,status:'running',detail:''}];
  }""")
  await page.wait_for_timeout(150)
  assert 'Выполняется' in await page.locator('.psy-agent-step').inner_text()
  await page.evaluate("actionHistory[0].status='ok';actionHistory[0].detail='Текст собран и сохранён.';unmount.refresh()")
  assert 'Готово' in await page.locator('.psy-agent-step').inner_text()
  assert await page.evaluate("historyBody.textContent===JSON.stringify(historyCommand)")
  await page.evaluate("actionHistory[0].status='error';unmount.refresh()")
  assert 'Ошибка' in await page.locator('.psy-agent-step').inner_text()
  await page.evaluate("historyBody.textContent=historyOriginal")
  await page.wait_for_timeout(150)
  # Re-mounting the view and reloading history must not duplicate the final text.
  await page.evaluate("() => { unmount(); window.unmount=mountFinalAnswers(()=>deepseekDOM('answer-elements',{}),{getFinals:()=>acceptedFinals,getHistory:()=>actionHistory}); }")
  await page.wait_for_timeout(300);assert await page.locator('.psy-agent-final').count()==1
  await page.evaluate("""() => {
    const body=document.querySelectorAll('.ds-assistant-message-main-content');
    window.acceptedFinals=[{commandId:'safe',text:'<img src=x onerror=alert(1)>'}];
    body[body.length-1].textContent=JSON.stringify({id:'safe',tool:'task.finish',args:{summary:'<img src=x onerror=alert(1)>'},description:'test'});
  }""")
  await page.wait_for_timeout(300)
  assert await page.locator('.psy-agent-final img').count()==0
  assert await page.locator('.psy-agent-final > div').text_content()=='<img src=x onerror=alert(1)>'
  await page.evaluate("document.querySelectorAll('.ds-assistant-message-main-content').forEach(e=>e.textContent='incomplete JSON')")
  await page.wait_for_timeout(300);assert await page.locator('.psy-agent-final').count()==0
  print('PASS: observed final summary rendered, raw answer preserved, history restore, no duplicates, text-only rendering, stale view removed; network blocked')
  await browser.close()
asyncio.run(main())
