import {
  parseCommand
} from '../src/protocol.js';
import {
  assert,
  pathParts,
  safeURL,
  timeout,
  sleep
} from '../src/util.js';
import {
  StateStore
} from '../src/state-store.js';
import {
  ProjectFiles
} from '../src/project-files.js';
import {
  BrowserTools
} from '../src/browser-tools.js';
import {
  AgentController
} from '../src/agent-controller.js';
import {
  PythonRuntime
} from '../src/python-runtime.js';
import {
  deepseekDOM,
  DeepSeekAdapter
} from '../src/deepseek-adapter.js';
const checks = [];
const test = (name, fn) => checks.push({
  name,
  fn
});
const command = (id, tool, args) => ({
  id,
  tool,
  args,
  description: 'Тест ' + tool
});
const fail = async fn => {
  let failed = false;
  try {
    await fn();
  } catch {
    failed = true;
  }
  assert(failed, 'Ожидалась ошибка');
};
let store, files, root, browser, c;
test('JSON: корректная команда, запрет лишних полей и инструментов', async () => {
  parseCommand(JSON.stringify(command('a', 'browser.open', {
    url: 'https://example.org/'
  })));
  for (const x of [{
      ...command('a', 'files.list', {}),
      extra: true
    }, command('a', '__proto__', {}), command('__proto__', 'files.list', {}), command('a',
      'browser.scroll', {
        tabId: 1,
        delta: 3.1
      })]) await fail(() => parseCommand(JSON.stringify(x)));
});
test('Пути: запрет выхода, Windows-имён, абсолютных путей', async () => {
  for (const p of ['../x', '/x', 'a/../b', 'C:/x', 'a\\b', 'a//b', 'CON.txt', 'a.', 'a\u0000b'])
    await fail(() => pathParts(p));
  assert(pathParts('results/coding.csv').length === 2, 'Нормальный путь');
});
test('URL: параметры поиска разрешены; схемы и секреты запрещены', async () => {
  assert(safeURL('https://example.org/search?q=hello&page=2#results').includes('q=hello'), 'Параметры и фрагменты допустимы');
  for (const u of ['chrome://settings', 'javascript:alert(1)', 'https://chat.deepseek.com/',
      'https://u:p@example.org', 'https://example.org/?token=secret'
    ]) await fail(() => safeURL(u));
});
test('IndexedDB и File API: восстановление, конфликт, отзыв разрешения', async () => {
  store = await new StateStore('psy-agent-tests').init();
  await store.put('test-value', {
    value: 12
  });
  assert((await store.get('test-value')).value === 12, 'IDB');
  root = await navigator.storage.getDirectory();
  root = await root.getDirectoryHandle('psy-tests-' + crypto.randomUUID(), {
    create: true
  });
  files = new ProjectFiles(store);
  files.root = root;
  const a = await files.write('user.txt', 'original');
  const b = await files.write('user.txt', 'changed');
  assert(a.path !== b.path, 'Нельзя перезаписывать');
  assert((await files.read(a.path)).text === 'original', 'Исходник сохранён');
  const auto = await files.write('own.txt', 'v1');
  await files.write(auto.path, 'v2', {
    owned: true
  });
  assert((await files.read(auto.path)).text === 'v2', 'Свой результат');
  const original = files.root;
  files.root = {
    queryPermission: async () => 'denied'
  };
  await fail(() => files.list());
  files.root = original;
});
test('Восстановление незавершённой операции; таймаут', async () => {
  const s = StateStore.fresh('test');
  s.status = 'running';
  s.pending = {
    command: command('u', 'files.write', {
      path: 'x',
      text: 'x'
    })
  };
  assert(StateStore.recover(s).status === 'paused' && s.pending, 'Неопределённая команда сохранена');
  await fail(() => timeout(new Promise(() => {}), 5));
});
test('CDP / BrowserTools: открытие, snapshot, текст/ссылки/таблицы, stale DOM, ввод, навигация', async () => {
  const state = {
    tabs: [],
    id: 'browser-test'
  };
  browser = new BrowserTools(state, async () => {}, async () => {});
  const open = browser.open.bind(browser);
  browser.open = url => open(url, { fixture: true });
  const t = await browser.execute('browser.open', { url: chrome.runtime.getURL('fixtures/article.html') });
  const s = t.page;
  assert(s?.snapshot && s.url, 'Открытие сразу возвращает снимок страницы');
  assert(s.text.includes('Социальная поддержка'), 'Извлечение');
  assert((await browser.run(t.tabId, 'extract', {
    kind: 'tables'
  })).data[0][1][1] === '2', 'Таблица');
  assert((await browser.run(t.tabId, 'extract', {
    kind: 'links'
  })).data.length === 1, 'Ссылки');
  await fail(() => browser.check(999999));
  const e = s.elements.find(x => x.label === 'Обновить данные');
  await browser.execute('browser.click', {
    tabId: t.tabId,
    snapshot: s.snapshot,
    element: e.id
  });
  await sleep(50);
  await fail(() => browser.execute('browser.click', {
    tabId: t.tabId,
    snapshot: s.snapshot,
    element: e.id
  }));
  const fresh = await browser.run(t.tabId, 'snapshot');
  const input = fresh.elements.find(e => e.tag === 'input');
  await browser.execute('browser.type', {
    tabId: t.tabId,
    snapshot: fresh.snapshot,
    element: input.id,
    text: 'test'
  });
  const next = await browser.run(t.tabId, 'snapshot');
  await browser.execute('browser.click', {
    tabId: t.tabId,
    snapshot: next.snapshot,
    element: next.elements.find(e => e.tag === 'a').id
  });
  await sleep(200);
  assert((await browser.run(t.tabId, 'snapshot')).title === 'Страница 2', 'Навигация');
  let opens = 0;
  browser.open = async () => { opens++; return { tabId: t.tabId, url: 'https://example.org' }; };
  browser.run = async () => { throw new Error('Read denied'); };
  const failedRead = await browser.execute('browser.open', { url: 'https://example.org' });
  assert(opens === 1 && failedRead.page === null && failedRead.readError.code === 'SNAPSHOT_FAILED',
    'Ошибка чтения не повторяет уже выполненное открытие');
  await browser.detach();
  for (const t of state.tabs) await chrome.tabs.remove(t.id);
});
test('Совместимый режим: snapshot, касание/клик, ввод и устаревшие ссылки без CDP', async () => {
  const state = {
    tabs: [],
    id: 'scripting-test'
  };
  const tools = new BrowserTools(state, async () => {}, async () => {});
  tools.transport = 'scripting';
  const tab = await tools.open(chrome.runtime.getURL('fixtures/article.html'), {
    fixture: true
  });
  try {
    const snapshot = await tools.run(tab.tabId, 'snapshot');
    const field = snapshot.elements.find(e => e.tag === 'input');
    await tools.execute('browser.type', {
      tabId: tab.tabId,
      snapshot: snapshot.snapshot,
      element: field.id,
      text: 'mobile input'
    });
    const [read] = await chrome.scripting.executeScript({
      target: {
        tabId: tab.tabId
      },
      func: () => document.querySelector('input').value
    });
    assert(read.result === 'mobile input', 'Ввод через стандартные API');
    await fail(() => tools.execute('browser.type', {
      tabId: tab.tabId,
      snapshot: snapshot.snapshot,
      element: field.id,
      text: 'stale'
    }));
    const next = await tools.run(tab.tabId, 'snapshot');
    const button = next.elements.find(e => e.label === 'Обновить данные');
    await tools.execute('browser.click', {
      tabId: tab.tabId,
      snapshot: next.snapshot,
      element: button.id
    });
    assert((await tools.run(tab.tabId, 'snapshot')).text.includes('Новый текст'),
      'Программный клик выполнен');
  } finally {
    await tools.detach();
    await chrome.tabs.remove(tab.tabId);
  }
});
test('Автоматические действия: ссылки и поиск без вопросов; опасные кнопки отклоняются до клика', async () => {
  const tools = new BrowserTools({ tabs: [] }, async () => {}, async () => { throw new Error('Не должно быть вопросов'); });
  tools.transport = 'scripting';
  tools.check = async () => ({ url: 'https://example.org/search?q=test' });
  let info = { tag: 'A', href: 'https://example.org/?page=2', navigation: true };
  let clicks = 0;
  tools.run = async (id, op) => {
    if (op === 'locate') return info;
    if (op === 'interact') { clicks++; return { performed: 'click' }; }
  };
  await tools.execute('browser.click', { tabId: 1 });
  info = { tag: 'INPUT', type: 'search', search: true, formMethod: 'get' };
  await tools.execute('browser.type', { tabId: 1, text: 'Погода в Москве' });
  info = { tag: 'BUTTON', label: 'Удалить' };
  let rejected = false;
  try { await tools.execute('browser.click', { tabId: 1 }); }
  catch (e) { rejected = e.definite === true; }
  assert(rejected && clicks === 2, 'Опасное действие не отправлено и не требует согласования');
});
test('DOM-адаптер: вставка, отправка, генерация, завершение на chat fixture', async () => {
  const tab = await chrome.tabs.create({
    url: chrome.runtime.getURL('fixtures/chat.html'),
    active: false
  });
  await sleep(150);
  const config = {
    input: '#composer',
    send: '#send',
    response: '.answer',
    stop: '#stop',
    complete: '.complete',
    login: '.login',
    challenge: '.captcha',
    error: '.error'
  };
  const run = async (action, payload) => {
    const [r] = await chrome.scripting.executeScript({
      target: {
        tabId: tab.id
      },
      func: deepseekDOM,
      args: [action, {}, payload || null]
    });
    return r.result;
  };
  assert((await run('inspect')).status === 'ready', 'Готов');
  await run('send', 'test');
  await run('submit');
  assert((await run('inspect')).status === 'generating', 'Генерирует');
  await sleep(200);
  const done = await run('inspect');
  assert(done.completion && done.answer.includes('fixture-final'), 'Завершён');
  const adapter = new DeepSeekAdapter(store);
  adapter.dom = run;
  const journal = [];
  const answer = await adapter.exchange('test lifecycle', async entry => journal.push(entry));
  assert(answer.includes('fixture-final') && journal.map(x => x.phase).join(',') ===
    'prepared,send-uncertain', 'Адаптер: полный цикл и журнал отправки');
  let sends = 0;
  adapter.dom = async action => {
    if (action === 'inspect') return {
      status: 'ready',
      count: 0,
      answer: ''
    };
    if (action === 'submit') {
      sends++;
      throw new Error('uncertain');
    }
    return {
      inserted: true
    };
  };
  await fail(() => adapter.exchange('test uncertain', async entry => journal.push(entry)));
  assert(sends === 1 && journal.at(-1).phase === 'send-uncertain',
    'Неопределённая отправка не повторяется');
  await chrome.tabs.remove(tab.id);
});
test('Pyodide: pandas, статистика, matplotlib, файл и изоляция', async () => {
  const p = new PythonRuntime();
  const r = await p.run(
    `import pandas as pd\nimport statistics\nimport matplotlib.pyplot as plt\nfrom js import globalThis\nassert not hasattr(globalThis, 'chrome') or not hasattr(globalThis.chrome, 'tabs')\ntry:\n    globalThis.indexedDB.open('psy-agent')\n    raise AssertionError('IndexedDB must be inaccessible')\nexcept Exception as e:\n    assert 'SecurityError' in str(e)\nplt.plot([1,2],[3,4])\nplt.savefig('plot.png')\nresult={'total':int(pd.DataFrame(data)['x'].sum()),'mean':statistics.mean(data['x'])}`, {
      x: [1, 2, 3]
    }, 90000);
  assert(r.result.total === 6 && r.files[0].bytes[0] === 137, 'Python/PNG');
});
test('Python: таймаут и остановка завершают Worker', async () => {
  const p = new PythonRuntime();
  await fail(() => p.run('while True: pass', {}, 200));
  assert(!p.worker, 'Worker завершён');
  let running = false;
  p.onProgress = () => {
    running = true;
    setTimeout(() => p.cancel(), 200);
  };
  const wait = p.run('while True: pass', {}, 30000);
  await fail(() => wait);
  assert(running, 'Прервано уже выполняющееся вычисление');
});
test('Сквозной цикл с тестовой моделью: корпус → Python → CSV/отчёт; duplicate guard', async () => {
  let calls = 0;
  let id;
  const model = {
    cancel() {},
    async exchange(prompt, journal) {
      calls++;
      await journal({
        phase: 'send-uncertain',
        before: {
          count: calls
        },
        prompt
      });
      if (calls === 1) return JSON.stringify(command('snap', 'browser.snapshot', {
        tabId: id
      }));
      if (calls === 2 || calls === 3) return JSON.stringify(command('corpus', 'corpus.add', {
        tabId: id
      }));
      if (calls === 4) return JSON.stringify(command('python', 'python.run', {
        code: 'result={"count": len(data["ids"])}',
        data: {
          ids: ['d1']
        }
      }));
      if (calls === 5) return JSON.stringify(command('analysis', 'analysis.save', {
        schema: {
          version: '1.0-test',
          categories: [{
            name: 'Поддержка',
            definition: 'Упоминание социальной поддержки'
          }]
        },
        rows: [{
          documentId: 'd1',
          category: 'Поддержка',
          quote: 'Социальная поддержка помогает студентам справляться со стрессом.',
          rationale: 'Прямое упоминание'
        }],
        report: '# Тестовый отчёт\nОдин документ. Разметка ИИ.'
      }));
      return JSON.stringify(command('finish', 'task.finish', {
        summary: 'Тест завершён'
      }));
    }
  };
  browser = new BrowserTools({
    tabs: []
  }, async () => c.save(), async () => {});
  c = new AgentController({
    store,
    files,
    browser,
    model,
    python: new PythonRuntime()
  });
  await c.create('Тест корпуса');
  const t = await browser.open(chrome.runtime.getURL('fixtures/article.html'), {
    fixture: true
  });
  id = t.tabId;
  await c.start();
  assert(c.s.status === 'completed', c.s.reason);
  assert(c.s.corpus.length === 1, 'Без повторного добавления');
  for (const f of ['corpus.jsonl', 'coding.csv', 'report.md', 'prompts.json', 'task-state.json'])
    assert(c.s.files.includes(f), 'Нет ' + f);
  assert(c.s.analysis.frequencies['Поддержка'] === 1, 'Частоты');
  assert((await files.read('coding.csv')).text.includes('schemaVersion'), 'Версия схемы');
  assert(c.s.logs.some(x => x.event === 'duplicate-skipped'), 'Повтор команды пропущен');
  const saved = await store.get('task');
  assert(saved.corpus[0].hash === c.s.corpus[0].hash, 'Корпус устойчив');
  await chrome.tabs.remove(id);
});
test('Неподтверждённая цитата отклоняется', async () => {
  await fail(() => c.execute(command('bad', 'analysis.save', {
    schema: {
      version: '1',
      categories: [{
        name: 'X',
        definition: 'X'
      }]
    },
    rows: [{
      documentId: 'd1',
      category: 'X',
      quote: 'такой цитаты нет',
      rationale: 'x'
    }],
    report: 'x'
  })));
});
test('Пауза не выдаёт новые команды; stop отменяет ожидание', async () => {
  let resolve;
  const model = {
    exchange: () => new Promise(r => resolve = r),
    cancel() {
      resolve?.(JSON.stringify(command('never', 'task.finish', {
        summary: 'x'
      })));
    }
  };
  const b = new BrowserTools({
    tabs: []
  }, async () => {}, async () => {});
  const cc = new AgentController({
    store,
    files,
    browser: b,
    model,
    python: new PythonRuntime()
  });
  await cc.create('pause');
  const p = cc.start();
  await sleep(30);
  await cc.pause();
  resolve(JSON.stringify(command('p', 'task.finish', {
    summary: 'x'
  })));
  await p;
  assert(!cc.s.commands.p && cc.s.received, 'Ответ сохранён без выполнения');
  const p2 = cc.start();
  await p2;
  assert(cc.s.status === 'completed', 'Продолжение');
  await cc.create('stop');
  const p3 = cc.start();
  await sleep(30);
  await cc.stop();
  await p3;
  assert(cc.s.status === 'stopped' && !cc.s.commands.never, 'Остановка');
});

test('Исправление JSON ограничено; неопределённая команда блокирует повтор', async () => {
  let requests = 0;
  const b = new BrowserTools({
    tabs: []
  }, async () => {}, async () => {});
  const cc = new AgentController({
    store,
    files,
    browser: b,
    model: {
      cancel() {},
      async exchange() {
        requests++;
        return 'not json';
      }
    },
    python: new PythonRuntime()
  });
  await cc.create('invalid');
  await cc.start();
  assert(cc.s.status === 'paused' && requests === 3, 'Лимит исправлений');
  cc.s.pending = {
    command: command('uncertain', 'files.write', {
      path: 'z.txt',
      text: 'z'
    }),
    started: Date.now()
  };
  await fail(() => cc.start());
  await cc.reconcileCommand('Проверено: файл отсутствует, повтор этой команды запрещён');
  assert(cc.s.commands.uncertain.result.status === 'error' && !cc.s.pending, 'Ручная сверка');
});

export async function runTests() {
  const out = document.querySelector('#result');
  const results = [];
  document.querySelector('#run').disabled = true;
  for (const {
      name,
      fn
    }
    of checks) {
    try {
      await fn();
      results.push({
        name,
        ok: true
      });
    } catch (e) {
      results.push({
        name,
        ok: false,
        error: e.stack || e.message
      });
    }
    console.log(JSON.stringify(results.at(-1)));
    out.textContent = results.map(r => (r.ok ? 'PASS ' : 'FAIL ') + r.name + (r.error ? '\n' + r.error :
      '')).join('\n');
  }
  document.querySelector('#run').disabled = false;
  window.testResults = results;
  return results;
}
document.querySelector('#run').onclick = runTests;
