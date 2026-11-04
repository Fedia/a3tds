import {
  parseReply
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
  ProjectSync
} from '../src/project-sync.js';
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
  deepseekDOM
} from '../src/chat-dom.js';
import {
  projectTask,
  progressText
} from '../src/ui-state.js';
import {
  responseUIKey
} from '../src/tool-format.js';
const checks = [];
const test = (name, fn) => checks.push({
  name,
  fn
});
async function fail(fn) {
  let failed = false;
  try {
    await fn();
  } catch {
    failed = true;
  }
  assert(failed, 'Ожидалась ошибка');
}
const block = code => '```python\n' + code + '\n```';
let store, root, files, sync;
const fixture = name => chrome.runtime.getURL('fixtures/' + name);
const stubBrowser = () => ({
  state: {},
  reset() {},
  cancel() {},
  detach: async () => {},
  adoptTabs: async () => {},
  recoverTabs: async () => {}
});
const stubPython = () => ({
  flush: async () => {},
  cancel() {},
  run: async () => ({
    stdout: '',
    stderr: '',
    result: 1
  })
});
async function controller(model, python = stubPython()) {
  const c = new AgentController({
    store,
    files,
    browser: stubBrowser(),
    model: {
      reset() {},
      cancel() {},
      ...model
    },
    python
  });
  await c.create('Проверить сценарий');
  return c;
}

test('Подготовка: изолированная OPFS и IndexedDB', async () => {
  store = await new StateStore('python-agent-tests-' + crypto.randomUUID()).init();
  root = await (await navigator.storage.getDirectory()).getDirectoryHandle('test-' + crypto.randomUUID(), {
    create: true
  });
  files = new ProjectFiles(store, {
    get: async () => ({
      'file-mode': 'browser'
    })
  });
  files.mode = 'browser';
  files.root = root;
  sync = new ProjectSync(store);
});
test('Протокол: пояснение и один обычный блок python, без JSON-экранирования', async () => {
  const code = 'from pathlib import Path\nPath("тест.txt").write_text("текст")';
  assert(parseReply('Сохраню файл.\n\n' + block(code)).code === code);
  assert(parseReply('Готово, сохранены три записи.').kind === 'final');
  assert(parseReply('~~~~python\nprint("```")\n~~~~').kind === 'python');
});
test('Протокол: неоднозначный, незакрытый, старый JSON и python.run отвергаются целиком', async () => {
  for (const raw of [block('a=1') + '\n' + block('b=2'), '```python\na=1', '```python\n\n```', '```python.run\nprint(1)\n```', '{"tool":"python.run","args":{}}']) await fail(() => parseReply(raw));
});
test('Пути и URL: выход из папки, секретные URL и вкладка DeepSeek запрещены', async () => {
  for (const path of ['../a', '/a', 'a/../b', 'C:\\a', 'a//b', 'a/CON.txt']) await fail(() => pathParts(path));
  for (const url of ['file:///etc/passwd', 'https://chat.deepseek.com/', 'https://example.com/?token=secret']) await fail(() => safeURL(url));
  assert(pathParts('данные/results.csv').length === 2);
});
test('ProjectSync: перезапись в корне без переименований, чужие файлы не затрагиваются', async () => {
  const bytes = text => new TextEncoder().encode(text);
  await sync.submit(root, [{
    type: 'write',
    path: 'user.txt',
    bytes: bytes('original')
  }, {
    type: 'write',
    path: 'untouched.txt',
    bytes: bytes('keep')
  }]);
  await sync.submit(root, [{
    type: 'write',
    path: 'user.txt',
    bytes: bytes('changed')
  }]);
  assert(await (await (await root.getFileHandle('user.txt')).getFile()).text() === 'changed');
  assert(await (await (await root.getFileHandle('untouched.txt')).getFile()).text() === 'keep');
  await fail(() => sync.submit(root, [{
    type: 'remove',
    path: '../untouched.txt'
  }]));
});
test('ProjectSync: очередь переживает ошибку записи и восстанавливается без повторного сценария', async () => {
  const apply = sync.drain.bind(sync);
  sync.drain = async () => {
    throw Error('test permission failure');
  };
  await fail(() => sync.submit(root, [{
    type: 'write',
    path: 'recovered.txt',
    bytes: new TextEncoder().encode('durable')
  }]));
  assert((await store.get('project-write-queue')).length === 1);
  sync.drain = apply;
  await new ProjectSync(store).flush();
  assert((await store.get('project-write-queue')).length === 0);
  assert(await (await (await root.getFileHandle('recovered.txt')).getFile()).text() === 'durable');
});
test('Доступ к папке: permission только проверяет grant, не вызывает requestPermission', async () => {
  let requested = 0;
  const f = new ProjectFiles(store);
  f.root = {
    queryPermission: async () => 'granted',
    requestPermission: async () => requested++
  };
  await f.permission();
  await f.permission();
  assert(!requested);
  f.root.queryPermission = async () => 'denied';
  await fail(() => f.permission());
  assert(!requested);
});
test('Цикл: последовательное выполнение и обычный финальный ответ', async () => {
  let calls = 0,
    executing = false,
    ran = 0;
  const python = stubPython();
  python.run = async () => {
    assert(!executing);
    executing = true;
    ran++;
    await sleep(10);
    executing = false;
    return {
      stdout: 'ok',
      result: 42
    };
  };
  const c = await controller({
    exchange: async prompt => {
      assert(!executing);
      calls++;
      assert(calls === 1 ? prompt.includes('os.chdir') : prompt.startsWith('Результат Python'));
      return calls <= 2 ? block('result=42') : 'Готово';
    }
  }, python);
  await c.start();
  assert(c.s.status === 'completed' && ran === 2 && calls === 3);
  assert(projectTask(c.s).final.text === 'Готово');
});
test('Цикл: выполненный exchangeId не исполняется повторно', async () => {
  let ran = 0;
  const python = stubPython();
  python.run = async () => {
    ran++;
    return {
      result: 1
    };
  };
  const c = await controller({
    exchange: async () => 'Готово'
  }, python);
  c.s.bootstrapSent = true;
  c.s.exchangeId = 'done';
  c.s.received = block('print("must not run")');
  c.s.commands.done = {
    command: {
      id: 'done',
      tool: 'python',
      description: 'test',
      args: {}
    },
    result: {
      id: 'done',
      status: 'ok',
      data: 1
    }
  };
  await c.start();
  assert(!ran && c.s.status === 'completed');
});
test('Восстановление: незавершённый сценарий не повторяется, модель получает SCRIPT_INTERRUPTED', async () => {
  let ran = 0;
  const python = stubPython();
  python.run = async () => ran++;
  const c = await controller({
    exchange: async prompt => {
      assert(prompt.includes('SCRIPT_INTERRUPTED'));
      return 'Работа восстановлена';
    }
  }, python);
  c.s.bootstrapSent = true;
  c.s.pending = {
    command: {
      id: 'interrupted',
      tool: 'python',
      args: {
        code: 'append()'
      },
      description: 'сбор'
    },
    source: {}
  };
  c.s.status = 'running';
  await c.save();
  c.s = StateStore.recover(await store.get('task'));
  assert(c.s.status === 'paused');
  await c.start();
  assert(!ran && !c.s.pending && c.s.status === 'completed');
  assert(StateStore.recover({
    version: 1
  }) === null);
});
test('Пауза: текущий блок заканчивается, новые блоки не выдаются', async () => {
  let calls = 0;
  const python = stubPython();
  const c = await controller({
    exchange: async () => {
      calls++;
      return block('pass');
    }
  }, python);
  python.run = async () => {
    await c.pause('Проверка паузы');
    return {
      result: 1
    };
  };
  await c.start();
  assert(c.s.status === 'paused' && calls === 1 && c.s.steps === 1);
});
test('Остановка: Worker отменяется, результат не отправляется модели', async () => {
  let rejectRun, called = 0;
  const python = stubPython();
  python.run = () => new Promise((_, reject) => {
    rejectRun = reject;
  });
  python.cancel = () => rejectRun?.(Error('stopped'));
  const c = await controller({
    exchange: async () => {
      called++;
      return block('while True: pass');
    }
  }, python);
  const running = c.start();
  while (!rejectRun) await sleep(5);
  await c.stop();
  await running;
  assert(c.s.status === 'stopped' && called === 1 && c.s.pending);
});
test('Ошибка Python: traceback возвращается модели, исправление выполняется последовательно', async () => {
  let ran = 0,
    calls = 0;
  const python = stubPython();
  python.run = async () => {
    if (++ran === 1) throw Error('ValueError: fixture');
    return {
      result: 2
    };
  };
  const c = await controller({
    exchange: async prompt => {
      if (++calls === 2) assert(prompt.includes('ValueError'));
      return calls < 3 ? block('result=2') : 'Исправлено';
    }
  }, python);
  await c.start();
  assert(c.s.status === 'completed' && ran === 2);
});
test('Формат: максимум два запроса исправления, отвергнутый код не выполняется', async () => {
  let calls = 0,
    ran = 0;
  const python = stubPython();
  python.run = async () => ran++;
  const c = await controller({
    exchange: async () => {
      calls++;
      return block('x=1') + '\n' + block('y=1');
    }
  }, python);
  await c.start();
  assert(c.s.status === 'paused' && calls === 3 && !ran);
});
test('Неопределённая отправка: восстановление читает прежний ответ без повторного exchange', async () => {
  let sends = 0, recovered = 0;
  const c = await controller({
    exchange: async () => { sends++; throw Object.assign(Error('wait'), { code: 'RESPONSE_TIMEOUT' }); },
    recoverExchange: async () => { recovered++; return 'Ответ уже получен'; }
  });
  c.s.outbound = { phase: 'send-uncertain', before: {}, prompt: 'saved' };
  c.s.exchangeId = 'saved-exchange';
  await c.start();
  assert(c.s.status === 'completed' && !sends && recovered === 1 && !c.s.outbound);
});
test('Остановка во время подготовки не позволяет запустить новый Worker или отправку', async () => {
  let release, sends = 0;
  const c = await controller({ exchange: async () => { sends++; return 'Готово'; } });
  c.files = { permission: () => new Promise(resolve => { release = resolve; }) };
  const starting = c.start();
  const rejected = fail(() => starting);
  await c.stop(); release(); await rejected;
  assert(c.s.status === 'stopped' && !sends);
});
test('Ошибка сохранения приостанавливает цикл, не запускает бесконечные исправления модели', async () => {
  let sends = 0;
  const python = stubPython();
  python.run = async () => { throw Object.assign(Error('folder unavailable'), { code: 'PROJECT_SYNC_FAILED' }); };
  const c = await controller({ exchange: async () => { sends++; return block('pass'); } }, python);
  await c.start();
  assert(c.s.status === 'paused' && c.s.pending && sends === 1);
});
test('Таймаут операции возвращает ошибку', async () => {
  await fail(() => timeout(new Promise(() => {}), 20, 'test'));
});
test('Границы вкладок: DeepSeek, посторонний tab_id и неизвестный метод запрещены', async () => {
  const b = new BrowserTools({
    id: 'test',
    tabs: [],
    modelTabId: 99
  }, async () => {});
  await fail(() => b.check(99));
  await fail(() => b.check(2));
  await fail(() => b.pythonCall('evaluate', {
    code: 'document.cookie'
  }));
});
test('DOM DeepSeek: пояснение + python восстанавливаются; несколько блоков не склеиваются', async () => {
  const host = document.createElement('section');
  document.body.append(host);
  host.innerHTML = '<textarea></textarea><button aria-label="Send">Send</button><div data-message-author-role="assistant"><p>Проверю страницу.</p><pre><code class="language-python">print(42)</code></pre><button aria-label="Copy">Copy</button></div>';
  const raw = deepseekDOM('inspect', {}, null).answer;
  assert(raw.includes('Проверю') && parseReply(raw).code === 'print(42)');
  host.querySelector('pre').after(host.querySelector('pre').cloneNode(true));
  await fail(() => parseReply(deepseekDOM('inspect', {}, null).answer));
  host.remove();
});
test('UI: история и финал подтверждаются состоянием, прогресс не содержит JSON', async () => {
  const s = StateStore.fresh('ui');
  s.status = 'running';
  s.pythonPhase = 'running';
  s.pending = {
    command: {
      id: 'run',
      tool: 'python',
      description: 'Сбор данных'
    },
    source: {
      wireKey: responseUIKey(block('pass'))
    },
    activity: ['Открываю страницу', 'Получаю DOM'],
    output: 'Обработано: 2'
  };
  const ui = projectTask(s);
  assert(ui.history[0].detail.includes('Обработано: 2') && !ui.final);
  assert(progressText(ui).includes('Python'));
});
test('Сквозной сценарий: один Python-блок обходит две страницы, пишет JSONL, CSV и отчёт в корень', async () => {
  const browser = new BrowserTools({
    tabs: []
  }, () => c.save());
  const python = new PythonRuntime(sync);
  await python.bindScope('https://chat.deepseek.com/a/chat/test', root);
  const urls = [fixture('records.html'), fixture('records-page2.html')];
  let exchanges = 0;
  const code = `from agent import browser, progress
from bs4 import BeautifulSoup
from pathlib import Path
import json, csv, hashlib
from datetime import datetime, timezone
assert __import__('os').getcwd() == '/project'
records = []
for url in ${JSON.stringify(urls)}:
    await browser.open(url)
    soup = BeautifulSoup(await browser.html('#reviews'), 'html.parser')
    for article in soup.select('.review'):
        text = article.select_one('.body').get_text(' ', strip=True)
        records.append({'id':str(len(records)+1),'url':url,'collectedAt':datetime.now(timezone.utc).isoformat(),'title':article.select_one('.author').text,'text':text,'method':'dom-beautifulsoup','hash':hashlib.sha256(text.encode()).hexdigest()})
    with open('corpus.jsonl','w',encoding='utf-8') as f:
        for record in records: f.write(json.dumps(record,ensure_ascii=False)+chr(10))
    Path('checkpoint.json').write_text(json.dumps({'last_url':url,'count':len(records)}))
    progress('Сохранено: '+str(len(records)))
assert len(records)==3
assert all('HIDDEN_DATA' not in r['text'] for r in records)
with open('coding.csv','w',newline='',encoding='utf-8') as f:
    writer=csv.writer(f);writer.writerow(['id','category','quote','rationale','schemaVersion'])
    for r in records:
        quote=r['text']; assert quote in r['text']
        writer.writerow([r['id'],'Общая',quote,'Тестовая схема','test-1'])
Path('report.md').write_text('Собрано документов: '+str(len(records)),encoding='utf-8')
print('Документов:',len(records))
result={'documents':len(records)}`;
  const model = {
    reset() {},
    cancel() {},
    exchange: async prompt => {
      exchanges++;
      if (exchanges === 1) return block(code);
      assert(prompt.includes('"documents":3') && !prompt.includes('BODY_SENTINEL_AFTER_PREVIEW'));
      return 'Сохранены corpus.jsonl, coding.csv и report.md. Собрано 3 документа.';
    }
  };
  const c = new AgentController({
    store,
    files,
    browser,
    model,
    python
  });
  await c.create('Сбор двух страниц');
  c.s.modelTabId = 99999;
  c.s.modelChatURL = 'https://chat.deepseek.com/a/chat/test';
  await c.start();
  assert(c.s.status === 'completed', c.s.reason);
  assert(c.s.last.data.result.documents === 3 && exchanges === 2);
  assert(c.s.tabs.length === 1, 'Рабочая вкладка переиспользуется');
  const corpus = await (await (await root.getFileHandle('corpus.jsonl')).getFile()).text();
  assert(corpus.includes('BODY_SENTINEL_AFTER_PREVIEW') && corpus.trim().split('\n').length === 3);
  assert((await files.file('coding.csv')).size > 0 && (await files.file('report.md')).size > 0);
  const names = [];
  for await (const [name] of root) names.push(name);
  assert(!names.includes('tasks') && !names.includes('execution.jsonl') && !names.includes('task-state.json'));
  const saved = await store.get('task');
  assert(saved.status === 'completed' && saved.files.includes('corpus.jsonl'));
  python.reset();
  for (const tab of c.s.tabs) await chrome.tabs.remove(tab.id);
});

export async function runTests() {
  const out = document.querySelector('#result'),
    results = [];
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
    } catch (error) {
      results.push({
        name,
        ok: false,
        error: error.stack || error.message
      });
    }
    console.log(JSON.stringify(results.at(-1)));
    out.textContent = results.map(r => (r.ok ? 'PASS ' : 'FAIL ') + r.name + (r.error ? '\n' + r.error : '')).join('\n');
  }
  document.querySelector('#run').disabled = false;
  window.testResults = results;
  return results;
}
document.querySelector('#run').onclick = runTests;
