"""DOM regressions only: synthetic chat, no claims about live DeepSeek."""
from pathlib import Path
import asyncio, os, shutil
from playwright.async_api import async_playwright
source = (Path(__file__).resolve().parents[2] / 'src/chat-dom.js').read_text().replace('export function', 'function')
async def main():
 async with async_playwright() as p:
  browser = await p.chromium.launch(executable_path=os.environ.get('CHROMIUM_BIN') or shutil.which('chromium'), args=['--no-sandbox'])
  page = await browser.new_page()
  await page.set_content('<textarea></textarea><button aria-label="Send">↑</button><section><article><p>Answer text</p><div><button aria-label="Copy">⧉</button></div></article></section>')
  await page.add_script_tag(content=source)
  inspect = lambda config: page.evaluate("c => deepseekDOM('inspect', c)", config)
  result = await inspect({})
  assert result['status'] == 'ready' and result['answer'] == 'Answer text' and result['completion']
  result = await inspect({'input':'#gone','send':'[invalid','response':'.old','complete':'.old-copy'})
  assert result['status'] == 'ready' and result['answer'] == 'Answer text' and result['completion']
  await page.evaluate("document.body.insertAdjacentHTML('beforeend', '<button aria-label=Send>Other</button>')")
  assert (await inspect({}))['status'] == 'user-required'
  await page.evaluate("document.body.lastElementChild.remove(); document.querySelector('article button').remove()")
  assert not (await inspect({}))['completion']
  await page.evaluate("document.body.insertAdjacentHTML('beforeend', '<div role=alert>Too many requests</div>')")
  assert (await inspect({}))['status'] == 'service-error'
  await page.set_content('<div><i></i><div style="cursor:pointer"><svg width="30" height="30"><path d="M0 0 L30 30" /></svg></div><button></button><button></button></div>')
  assert await page.evaluate("""() => {
    const path = document.querySelector('path');
    const control = bindingTarget(path, 'send');
    if (control !== document.querySelector('svg').parentElement) return false;
    for (const root of [document, document.body, control]) {
      const selector = bindingSelector(path, root);
      if (root.querySelectorAll(selector).length !== 1 || root.querySelector(selector) !== path) return false;
    }
    const button = document.querySelectorAll('button')[1];
    return document.querySelector(bindingSelector(button)) === button;
  }""")
  print('PASS: SVG controls, anonymous siblings, relative selector identity; automatic discovery, stale/invalid bindings, ambiguous send blocked, missing completion, service error')
  await browser.close()
asyncio.run(main())
