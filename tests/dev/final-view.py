"""Offline rendering regression. Optional argument: private DeepSeek DOM export."""
from pathlib import Path
import asyncio, json, os, re, shutil, sys
from playwright.async_api import async_playwright
ROOT = Path(__file__).resolve().parents[2]
path = Path(sys.argv[1]) if len(sys.argv)>1 else ROOT/'fixtures/deepseek-observed.html'
html = re.sub(r'<script\b[^>]*>.*?</script>', '', path.read_text(), flags=re.I|re.S)
source = '\n'.join((ROOT/'src'/name).read_text().replace('export function', 'function') for name in ['chat-dom.js','final-view.js'])
async def main():
 async with async_playwright() as p:
  browser=await p.chromium.launch(executable_path=os.environ.get('CHROMIUM_BIN') or shutil.which('chromium'),args=['--no-sandbox'])
  page=await browser.new_page();await page.route('**/*',lambda r:r.abort());await page.set_content(html)
  await page.add_script_tag(content=source)
  expected=await page.evaluate("JSON.parse(deepseekDOM('inspect',{}).answer).args.summary")
  await page.evaluate("() => { window.originalAnswer=deepseekDOM('inspect',{}).answer; window.unmount=mountFinalAnswers(()=>deepseekDOM('answer-elements',{})); }")
  assert await page.locator('.psy-agent-final').count()==1
  assert await page.locator('.psy-agent-final > div').text_content()==expected
  assert await page.evaluate("deepseekDOM('inspect',{}).answer === originalAnswer")
  assert await page.evaluate(r"""deepseekDOM('answer-elements',{}).filter(a=>a.context || /\"tool\"\s*:/.test(a.raw)).every(a=>getComputedStyle(a.source).opacity==='0')""")
  # Re-mounting the view and reloading history must not duplicate the final text.
  await page.evaluate("() => { unmount(); window.unmount=mountFinalAnswers(()=>deepseekDOM('answer-elements',{})); }")
  await page.wait_for_timeout(300);assert await page.locator('.psy-agent-final').count()==1
  await page.evaluate("""() => {
    const body=document.querySelectorAll('.ds-assistant-message-main-content');
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
