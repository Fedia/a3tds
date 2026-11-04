"""Offline test of observed DOM. Optional argument: private outerHTML export.
Never logs or writes the conversation; all network requests are blocked.
"""
from pathlib import Path
import asyncio, os, re, shutil, sys
from playwright.async_api import async_playwright
ROOT = Path(__file__).resolve().parents[2]
path = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / 'fixtures/deepseek-observed.html'
html = re.sub(r'<script\b[^>]*>.*?</script>', '', path.read_text(), flags=re.S|re.I)
source = (ROOT / 'src/chat-dom.js').read_text().replace('export function', 'function')
async def main():
 async with async_playwright() as p:
  browser = await p.chromium.launch(executable_path=os.environ.get('CHROMIUM_BIN') or shutil.which('chromium'), args=['--no-sandbox'])
  page = await browser.new_page()
  await page.route('**/*', lambda route: route.abort())
  await page.set_content(html)
  await page.add_script_tag(content=source)
  inspect = lambda: page.evaluate("deepseekDOM('inspect', {})")
  state = await inspect()
  assert state['status'] == 'ready' and state['input'] and state['send']
  assert not state['sendEnabled'] and state['completion'] and state['count'] == 1
  assert await page.evaluate("deepseekDOM('inspect', {}).answer === document.querySelector('.ds-assistant-message-main-content').textContent.trim()")
  assert await page.evaluate("""() => {
    const {input,send} = deepseekDOM('elements', {});
    return document.querySelector(bindingSelector(input)) === input && document.querySelector(bindingSelector(send)) === send;
  }""")
  # Simulate the website's event handler enabling a div, not a native button.
  await page.evaluate("""document.querySelector('textarea').addEventListener('input', () => {
    document.querySelector('.ds-button--primary.ds-button--circle').classList.remove('ds-button--disabled');
  })""")
  await page.evaluate("deepseekDOM('send', {}, 'Synthetic test prompt')")
  assert (await inspect())['sendEnabled']
  await page.evaluate("document.querySelector('.ds-button--primary.ds-button--circle').onclick = () => window.clicked = true")
  await page.evaluate("deepseekDOM('submit', {})")
  assert await page.evaluate('window.clicked === true')
  # Unknown replacement icon must block submission, without guessing a stop SVG.
  await page.evaluate("document.querySelector('.ds-button--primary.ds-button--circle path').setAttribute('d', 'M0 0 H10 V10 Z')")
  assert (await inspect())['status'] == 'generating'
  await page.evaluate("document.querySelector('.ds-assistant-message-main-content').closest('.ds-message').parentElement.querySelectorAll('[role=button]').forEach(e=>e.remove())")
  assert not (await inspect())['completion']
  await page.set_content(html)
  await page.add_script_tag(content=source)
  adapter = (ROOT / 'src/deepseek-adapter.js').read_text()
  adapter = re.sub(r"(?:import|export)\s+(?:[\s\S]*?)from\s+'[^']+';", '', adapter)
  adapter = adapter.replace('export class', 'class')
  await page.add_script_tag(content="const assert=(ok,msg)=>{if(!ok)throw new Error(msg)}; const sleep=ms=>new Promise(r=>setTimeout(r,ms));" + adapter + ';window.TestAdapter=DeepSeekAdapter;')
  assert await page.evaluate("""async () => {
    const primary=document.querySelector('.ds-button--primary.ds-button--circle');
    const arrow=primary.querySelector('path').getAttribute('d');
    const body=document.querySelector('.ds-assistant-message-main-content');
    const next='Готовый ответ нового сообщения';
    const input=document.querySelector('textarea'); input.value='';
    input.addEventListener('input',()=>primary.classList.remove('ds-button--disabled'));
    primary.onclick=()=>{
      input.value=''; primary.querySelector('path').setAttribute('d','M0 0 H10 V10 Z');
      setTimeout(()=>{body.textContent=next;primary.querySelector('path').setAttribute('d',arrow)},100);
    };
    const adapter=new TestAdapter({});
    adapter.dom=async(action,payload)=>deepseekDOM(action,{},payload);
    const journal=[];
    const answer=await adapter.exchange('Synthetic lifecycle prompt',async event=>journal.push(event.phase));
    return answer===next && journal.join(',')==='prepared,inserted,send-uncertain';
  }""")
  print('PASS: observed DOM, automatic composer/send/answer/copy, disabled div, insertion and click, unknown icon blocked, toolbar completion required; network blocked')
  await browser.close()
asyncio.run(main())
