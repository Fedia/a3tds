import { PythonPackages, PYODIDE_CDN } from '../src/python-packages.js';
import { stateLabel, progressText, projectTask, belongsToChat } from '../src/ui-state.js';
import { Captures } from '../src/captures.js';
import { loadPythonInputs } from '../src/python-inputs.js';
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
test('UI: состояние контроллера, отсутствие ложного финала и дублирующих инструкций', async () => {
  const s = StateStore.fresh('ui');
  s.modelTabId = 1;
  s.modelChatURL = 'https://chat.deepseek.com/a/chat/a';
  s.current = 'Собираю данные';
  s.status = 'paused';
  s.phase = 'executing';
  s.reason = 'Ответ DeepSeek пока не подтверждён. Можно написать продолжай. Можно написать продолжай.';
  const paused = projectTask(s);
  assert(stateLabel(paused) === 'Пауза' && progressText(paused) === 'Пауза. Не удалось прочитать ответ DeepSeek.', 'Пауза имеет один короткий текст');
  s.status = 'running';
  s.phase = 'waiting';
  assert(stateLabel(projectTask(s)) === 'Ждёт DeepSeek', 'Ожидание не выдаётся за выполнение инструмента');
  s.last = {
    id: 'done',
    status: 'ok'
  };
  s.commands.done = {
    command: command('done', 'task.finish', {
      summary: 'Ответ'
    })
  };
  assert(!projectTask(s).final, 'Команды модели недостаточно для подтверждения финала');
  s.status = 'completed';
  assert(projectTask(s).final.text === 'Ответ' && !progressText(projectTask(s)), 'Готовый ответ не сопровождается старой строкой работы');
  assert(!belongsToChat(projectTask(s), 'https://chat.deepseek.com/a/chat/b', 1), 'Состояние не попадает в другой чат');
});
test('UI: история подтверждённых результатов, текущий шаг и остановка без ложного успеха', async()=>{
  const s=StateStore.fresh('history');s.status='running';
  s.commands.collect={command:command('collect','browser.collect',{tabId:1}),result:{status:'ok',data:{savedRecords:100}}};
  s.pending={command:command('python','python.run',{code:'secret_code',data:{secret:'data'}})};
  let view=projectTask(s);
  assert(view.history.length===2 && view.history[0].status==='ok' && view.history[0].detail.includes('100'),'Подтверждённый сбор отображает число записей');
  assert(view.history[1].status==='running' && !JSON.stringify(view.history).includes('secret_code'),'В истории нет кода и полных аргументов');
  s.status='stopped';view=projectTask(s);assert(view.history[1].status==='interrupted' && view.history[0].status==='ok','Остановка не выдаётся за успешное вычисление и не стирает историю');
  s.status='running';s.phase='generating';s.waitElapsed=25;
  assert(progressText(projectTask(s)).includes('25 с') && stateLabel(projectTask(s))==='DeepSeek отвечает','Генерация и длительность видны');
});
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
test('Папка: живой handle сохраняется, доступ не запрашивается повторно, отзыв учитывается', async()=>{
  const preferences={'file-mode':'directory','file-revision':'initial'};
  const prefs={get:async keys=>Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(k=>[k,preferences[k]])),set:async values=>Object.assign(preferences,values)};
  let loads=0,requests=0,permission='granted';
  const root={name:'results',queryPermission:async()=>permission,requestPermission:async()=>{requests++;await sleep(5);permission='granted';return permission},async *entries(){yield ['result.csv',{kind:'file'}]}};
  const memory=new Map([['directory',root]]);
  const storage={get:async key=>{if(key==='directory')loads++;return memory.get(key)},put:async(key,value)=>memory.set(key,value),putMany:async entries=>entries.forEach(([k,v])=>memory.set(k,v))};
  const f=new ProjectFiles(storage,prefs);await f.restore();const initial=f.root;
  for(let i=0;i<10;i++){await f.restore();await f.list();await f.authorize()}
  assert(loads===1&&f.root===initial&&requests===0,'Перезапуск/чтение не заменяют разрешённый handle и не показывают запрос');
  permission='denied';await fail(()=>f.list());assert(requests===0,'Рабочая операция не запрашивает доступ сама');
  await Promise.all([f.authorize(),f.authorize()]);assert(requests===1,'Два клика не создают два диалога');
  await f.restore();assert(f.root===initial&&loads===1,'Собственный grant не теряет живой handle');
  const other=new ProjectFiles(storage,prefs);await other.restore();assert(other.root===root,'Новый контекст восстанавливает выбранную папку');
  const replacement={...root,name:'new-results'};memory.set('directory',replacement);preferences['file-revision']='changed';
  await f.restore();assert(f.root===replacement,'Смена папки в другом контексте обновляет handle');
  assert(requests===1,'Восстановление и смена папки не вызывают скрытых запросов');
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
test('Переиспользование: переход в той же вкладке, newTab, передача новой задаче и защита посторонних', async () => {
  const b=new BrowserTools({tabs:[]},async()=>{},async()=>{});
  const rawOpen=b.open.bind(b);b.open=(url,options={})=>rawOpen(url,{...options,fixture:true});
  const cc=new AgentController({store,files,browser:b,model:{},python:{}});await cc.create('reuse tabs');
  const created=new Set();
  try {
    const first=await cc.execute(command('reuse-first','browser.open',{url:chrome.runtime.getURL('fixtures/article.html')}));created.add(first.tabId);
    const second=await cc.execute(command('reuse-second','browser.open',{url:chrome.runtime.getURL('fixtures/page2.html')}));
    assert(second.tabId===first.tabId&&second.reused&&b.state.tabs.length===1,'Обычное открытие переиспользует вкладку');
    assert(second.page.title==='Страница 2'&&(await files.read(first.page.savedPath)).text.includes('Социальная поддержка'),'Старая страница сохранена, новая прочитана');
    const repeat=await cc.execute(command('reuse-repeat','browser.open',{url:chrome.runtime.getURL('fixtures/page2.html')}));
    assert(!repeat.navigated&&repeat.tabId===first.tabId,'Совпавший URL не перезагружается');
    const extra=await cc.execute(command('reuse-extra','browser.open',{url:chrome.runtime.getURL('fixtures/article.html'),newTab:true}));created.add(extra.tabId);
    assert(extra.tabId!==first.tabId&&b.state.tabs.length===2,'Явная отдельная вкладка поддерживается');
    const known=await cc.execute(command('reuse-known','browser.open',{url:chrome.runtime.getURL('fixtures/page2.html')}));
    assert(known.tabId===first.tabId&&!known.navigated&&(await chrome.tabs.get(extra.tabId)).url.endsWith('/article.html'),'Уже открытый URL выбирается среди рабочих вкладок');
    const oldId=cc.s.id;await cc.create('next task');
    const next=await cc.execute(command('reuse-next','browser.open',{url:chrome.runtime.getURL('fixtures/page2.html')}));
    assert(cc.s.id!==oldId&&next.tabId===first.tabId&&next.reused,'Новая задача перенимает подтверждённую рабочую вкладку');
    const outsider=await chrome.tabs.create({url:chrome.runtime.getURL('fixtures/article.html'),active:false});created.add(outsider.id);
    cc.s.tabs.push({id:outsider.id,url:outsider.url});cc.s.workTabId=outsider.id;
    const safe=await cc.execute(command('reuse-safe','browser.open',{url:chrome.runtime.getURL('fixtures/page2.html')}));
    assert(safe.tabId!==outsider.id,'Посторонняя вкладка без маркера собственности не используется');
    cc.s.modelTabId=safe.tabId;await fail(()=>b.check(safe.tabId));
    assert((await chrome.tabs.get(outsider.id)).url.endsWith('/fixtures/article.html'),'Посторонняя вкладка не изменена');
    delete cc.s.modelTabId;
    const actual=await chrome.tabs.get(safe.tabId);
    b.save=async()=>{if(cc.s.tabs.some(t=>t.navigation?.phase==='prepared'))b.cancel();};
    await fail(()=>b.open(chrome.runtime.getURL('fixtures/records.html'),{fixture:true,commandId:'stop-before-navigation'}));
    assert((await chrome.tabs.get(safe.tabId)).url===actual.url,'Остановка до dispatch не запускает переход');
  } finally {await b.detach();for(const id of created)await chrome.tabs.remove(id);}
});
test('Готовность страницы: отложенный текст, визуальная стабилизация, часы и отмена', async () => {
  const state = { id: 'readiness-test', tabs: [] };
  const tools = new BrowserTools(state, async () => {}, async () => {});
  const tab = await tools.open(chrome.runtime.getURL('fixtures/readiness.html'), { fixture: true });
  try {
    const snapshot = await tools.run(tab.tabId, 'snapshot');
    assert(snapshot.readiness.ready && snapshot.readiness.stableMs >= 1000 && snapshot.text.includes('+7'),
      'Чтение дождалось содержимого, а не только загрузки вкладки');
    await tools.execute('browser.click', { tabId: tab.tabId, snapshot: snapshot.snapshot,
      element: snapshot.elements.find(e => e.label === 'Обновить').id });
    assert((await tools.run(tab.tabId, 'snapshot')).text.includes('+9'), 'После действия дождались обновления данных');
    const wait = tools.waitForPage(tab.tabId, { quietMs: 60000 });
    setTimeout(() => tools.cancel(), 100);
    await fail(() => wait);
  } finally { await tools.detach(); await chrome.tabs.remove(tab.tabId); }
});
test('Автоматические действия: ссылки и поиск без вопросов; опасные кнопки отклоняются до клика', async () => {
  const tools = new BrowserTools({ tabs: [] }, async () => {}, async () => { throw new Error('Не должно быть вопросов'); });
  tools.transport = 'scripting';
  tools.check = async () => ({ url: 'https://example.org/search?q=test' });
  tools.waitForPage = async () => ({ ready: true });
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
    'prepared,inserted,send-uncertain', 'Адаптер: полный цикл и журнал отправки');
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
    if (action === 'delivery') return { draft: 'exact' };
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
test('Загрузка пакетов: только известные wheel/метаданные, SHA-256 и отсутствие тела/учётных данных', async()=>{
  const payload=new TextEncoder().encode('wheel bytes'),digest=await(await import('../src/util.js')).hash(payload);
  let calls=0;const loader=new PythonPackages({fetcher:async(url,options)=>{calls++;assert(options.method==='GET'&&options.credentials==='omit'&&options.redirect==='error'&&!options.body,'Разрешено только анонимное скачивание');return new Response(payload,{headers:{'Content-Type':'application/octet-stream'}})}});
  for(const url of ['https://example.com/pkg.whl','https://pypi.org/simple/emoji/?secret=data',PYODIDE_CDN+'pyodide.js','https://user:password@pypi.org/simple/emoji/'])await fail(()=>loader.download(url));
  assert(calls===0,'Запрещённые URL не отправляются');
  const asset=PYODIDE_CDN+'known.whl';loader.assets.set(asset,{digest});assert((await loader.download(asset)).bytes.length===payload.length,'Разрешённый пакет проверен');
  loader.assets.set(asset,{digest:'0'.repeat(64)});await fail(()=>loader.download(asset));
  loader.register({files:[{url:'https://evil.example/pkg.whl',hashes:{sha256:digest}},{url:'https://files.pythonhosted.org/packages/test/demo-1-py3-none-any.whl',hashes:{sha256:digest}}]},'simple');
  assert(!loader.assets.has('https://evil.example/pkg.whl')&&loader.assets.has('https://files.pythonhosted.org/packages/test/demo-1-py3-none-any.whl'),'Индекс не расширяет доверенные источники');
});
test('Python: простой код без тяжёлых библиотек, этапы запуска и отдельное время вычисления', async()=>{
  const p=new PythonRuntime(), phases=[];p.onProgress=phase=>phases.push(phase);
  const r=await p.run("import sys, asyncio\nawait asyncio.sleep(0.01)\nresult={'sum':sum(data),'heavy':[name for name in ['numpy','pandas','matplotlib'] if name in sys.modules]}",[1,2,3],1000);
  assert(r.result.sum===6&&r.result.heavy.length===0,'Простой код не загружает NumPy/pandas/matplotlib');
  assert(['sandbox','worker','bootstrap','runtime','packages','inputs','running','exporting'].every(x=>phases.includes(x)),'Все этапы различимы');
  assert(!p.worker,'Среда очищена после выполнения');
});
test('Python: таймаут и остановка завершают Worker', async () => {
  const p = new PythonRuntime();
  await fail(() => p.run('while True: pass', {}, 200));
  assert(!p.worker, 'Worker завершён');
  let running = false;
  p.onProgress = phase => {
    if (phase !== 'running') return;
    running = true;
    setTimeout(() => p.cancel(), 200);
  };
  const wait = p.run('while True: pass', {}, 30000);
  await fail(() => wait);
  assert(running, 'Прервано уже выполняющееся вычисление');
});
test('Python jobs: живой прогресс/вывод, другие инструменты, файлы и защита от повторного запуска', async()=>{
  const runtime=new PythonRuntime();let runs=0;const run=runtime.run.bind(runtime);runtime.run=(...args)=>{runs++;assert(args[2]===null,'Нет автоматического таймаута вычисления');return run(...args)};
  let scrolled=false;
  const cc=new AgentController({store,files,browser:{detach:async()=>{},execute:async()=>{scrolled=true;return {scrolled:true}}},model:{cancel(){}},python:runtime});
  await cc.create('Фоновый Python');
  const cmd=command('background','python.run',{data:{},code:'import time\nprogress({"done":0,"total":2})\nprint("Первая часть")\ntime.sleep(1)\nprogress({"done":1,"total":2})\nprint("Вторая часть")\ntime.sleep(1)\nopen("done.txt","w").write("готово")\nresult={"value":42}'});
  const job=await cc.execute(cmd);assert(job.status==='running','Вызов возвращается до окончания кода');
  await cc.execute(command('parallel-scroll','browser.scroll',{tabId:1,delta:100}));assert(scrolled,'Браузер доступен во время вычисления');
  let progress=false,output;
  for(let i=0;i<100;i++){output=await cc.execute(command('poll-'+i,'python.status',{jobId:job.jobId,waitMs:100}));if(output.progress?.done===1&&output.stdout.includes('Вторая часть'))progress=true;if(output.status!=='running')break;}
  assert(progress&&output.status==='completed'&&output.result.value===42,'Модель видит прогресс, stdout и окончательный результат');
  assert((await files.read(output.files[0].path)).text==='готово','Выходной файл сохранён автоматически');
  cc.s.pending={command:cmd};await cc.recoverPending();assert(cc.s.last.status==='ok'&&runs===1,'Прерванная квитанция не перезапускает Python');
  await fail(()=>cc.execute(command('foreign','python.status',{jobId:'other-task-job',waitMs:0})));
});
test('Python jobs: отмена, запрет преждевременного finish и восстановление потерянного Worker', async()=>{
  let rejectRun,runs=0,limit;
  const runtime={run:(_code,_data,time)=>{runs++;limit=time;return new Promise((_,reject)=>{rejectRun=reject})},cancel(){rejectRun?.(new Error('Python прерван пользователем'))}};
  const cc=new AgentController({store,files,browser:{detach:async()=>{}},model:{cancel(){}},python:runtime});await cc.create('Долгое вычисление');
  const job=await cc.execute(command('long-job','python.run',{code:'while True: pass',data:{}}));
  for(let i=0;i<100&&!rejectRun;i++)await sleep(5);
  assert(rejectRun&&limit===null,'Никакие 60 секунд не задаются');
  await fail(()=>cc.execute(command('too-early','task.finish',{summary:'готово'})));
  cc.pythonJobs().jobs.get(job.jobId).record.started-=120000;
  assert((await cc.execute(command('long-status','python.status',{jobId:job.jobId,waitMs:0}))).status==='running','Само время не означает зависание');
  const cancelled=await cc.execute(command('cancel-job','python.cancel',{jobId:job.jobId}));assert(cancelled.status==='cancelled'&&runs===1,'Отмена не перезапускает код');
  await cc.create('После перезагрузки');const id=cc.s.id;
  cc.s.pythonJobs={lost:{jobId:'lost',status:'running'}};await cc.save();
  await store.put('python-job:'+id+':lost',{taskId:id,jobId:'lost',status:'running',phase:'running',started:Date.now()-10000,updated:Date.now()-10000});
  const fresh=new AgentController({store,files,browser:{detach:async()=>{}},model:{},python:{run(){throw new Error('Нельзя повторять')},cancel(){}}});fresh.s=await store.get('task');
  const lost=await fresh.execute(command('lost-status','python.status',{jobId:'lost',waitMs:0}));assert(lost.status==='interrupted'&&lost.error.code==='WORKER_LOST','Перезагрузка обозначена явно, код не повторён');
});
test('Python jobs: результат переживает ошибку экспорта; фоновая запись не перетирает новую задачу', async()=>{
  const outcome={stdout:'ok',stderr:'',result:{n:1},files:[{path:'durable.txt',bytes:new TextEncoder().encode('KEEP')}],stdoutTruncated:false,stderrTruncated:false};
  let resolveRun,runs=0;
  const runtime={run(){runs++;return new Promise(resolve=>{resolveRun=resolve})},cancel(){}};
  const cc=new AgentController({store,files,browser:{detach:async()=>{}},model:{},python:runtime});await cc.create('Надёжный результат');
  const job=await cc.execute(command('durable-python','python.run',{code:'result=1',data:{}}));for(let i=0;i<100&&!resolveRun;i++)await sleep(5);
  const write=files.write.bind(files);files.write=async()=>{throw new Error('Папка временно недоступна')};
  resolveRun(outcome);await cc.pythonJobs().jobs.get(job.jobId).completion;
  files.write=write;
  const staged=await store.get('python-job:'+cc.s.id+':'+job.jobId);assert(staged.outcome.files[0].bytes.length===4,'Полный результат сохранён до выгрузки');
  const fresh=new AgentController({store,files,browser:{detach:async()=>{}},model:{},python:{cancel(){},run(){throw new Error('Нельзя повторять')}}});fresh.s=await store.get('task');
  const saved=await fresh.execute(command('export-recovery','python.status',{jobId:job.jobId,waitMs:0}));assert((await files.read(saved.files[0].path)).text==='KEEP'&&runs===1,'После восстановления нужен только экспорт');
  // A result from an old frame patches its archive, never the active task object.
  await store.put('archive-'+fresh.s.id,fresh.s);const next=StateStore.fresh('Новая активная задача');await store.save(next);
  await fresh.pythonJobs().publish(await fresh.pythonJobs().get(job.jobId));
  assert((await store.get('task')).id===next.id&&(await store.get('archive-'+fresh.s.id)).pythonJobs[job.jobId].status==='completed','Новая задача не потеряна из-за фонового результата');
  await store.putPythonJob('python-job:'+fresh.s.id+':'+job.jobId,staged);
  const nextController=new AgentController({store,files,browser:{detach:async()=>{}},model:{},python:{cancel(){},run(){throw new Error('Нельзя повторять')}}});nextController.s=next;
  files.write=async()=>{throw new Error('Не следует повторно записывать уже сохранённый файл')};
  try{await nextController.pythonJobs().flushPending();}finally{files.write=write;}
  assert((await store.get('python-export-queue')).length===0&&(await store.get('task')).id===next.id&&runs===1,'Архивная выгрузка доведена до конца без повторного Python и дубликатов');
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
      if(c.s.pythonJobs?.python?.status==='running')return JSON.stringify(command('python-status-'+calls,'python.status',{jobId:'python',waitMs:15000}));
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
    assert(c.s.files.some(path=>path.endsWith('/'+f)), 'Нет ' + f);
  assert(c.s.analysis.frequencies['Поддержка'] === 1, 'Частоты');
  assert((await files.read(c.s.files.find(path=>path.endsWith('/coding.csv')))).text.includes('schemaVersion'), 'Версия схемы');
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

test('Исправление JSON ограничено; прерванная команда проверяется без ручного сброса', async () => {
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
  await cc.start();
  assert(cc.s.commands.uncertain.result.status === 'error' && !cc.s.pending, 'Автоматическая сверка без повторного выполнения');
});

test('Восстановление записи: проверка хеша, без перезаписи и повторного инструмента', async () => {
  const cc = new AgentController({store,files,browser:{detach:async()=>{}},model:{},python:{cancel(){}}});
  await cc.create('recovery');
  const cmd = command('verified-write','files.write',{path:'recover.txt',text:'saved'});
  const saved = await files.write(cmd.args.path,cmd.args.text,{operationId:cc.s.id+':'+cmd.id});
  cc.s.pending={command:cmd}; await cc.recoverPending();
  assert(cc.s.last.status==='ok' && cc.s.last.data.path===saved.path && !cc.s.pending, 'Файл подтверждён чтением хеша');
  const changed=command('changed','files.write',{path:'changed.txt',text:'expected'});
  const output=await files.write(changed.args.path,changed.args.text,{operationId:cc.s.id+':'+changed.id});
  await files.write(output.path,'different',{owned:true});
  cc.s.pending={command:changed}; await cc.recoverPending();
  assert(cc.s.last.status==='error' && (await files.read(output.path)).text==='different', 'Несовпадение не перезаписывается и не блокирует цикл');
});
test('Восстановление вкладки по commandId; неизвестный клик закрыт для повторов', async () => {
  const b={detach:async()=>{},check:async()=>({url:'https://example.org/'}),run:async()=>({text:'Observed'})};
  const cc=new AgentController({store,files,browser:b,model:{},python:{cancel(){}}});
  await cc.create('tabs');cc.s.tabs=[{id:7,commandId:'open'}];
  cc.s.pending={command:command('open','browser.open',{url:'https://example.org/'})};
  await cc.recoverPending();assert(cc.s.last.status==='ok' && cc.s.last.data.tabId===7, 'Открытая вкладка повторно не создаётся');
  cc.s.pending={command:command('click','browser.click',{tabId:7,snapshot:'old',element:'e0'})};
  await cc.recoverPending();assert(cc.s.last.status==='error' && cc.s.blockedInteractions.includes(7) && !cc.s.pending, 'Ошибка одного взаимодействия не блокирует чтение и цикл');
  cc.s.tabs[0].commandId='unconfirmed-nav';cc.s.tabs[0].navigation={url:'https://wanted.example/',phase:'dispatching'};
  cc.s.pending={command:command('unconfirmed-nav','browser.open',{url:'https://wanted.example/'})};
  await cc.recoverPending();assert(cc.s.last.status==='error','Старую страницу нельзя выдать за результат непроверенного перехода');
});
test('Ошибка Python возвращается модели; следующий шаг выполняется без ручного восстановления', async () => {
  let calls=0, runs=0;
  const cc=new AgentController({store,files,browser:{detach:async()=>{}},python:{cancel(){},async run(){runs++;throw new Error('Python timeout');}},
    model:{async exchange(prompt){calls++;if(calls===1)return JSON.stringify(command('py-fail','python.run',{code:'result=1',data:{}}));
      if(calls===2)return JSON.stringify(command('check-failure','python.status',{jobId:'py-fail',waitMs:15000}));
      assert(prompt.includes('PYTHON_FAILED'),'Модель получает причину ошибки фоновой задачи');
      return JSON.stringify(command('done','task.finish',{summary:'Вычисление не удалось, использую доступные данные'}));}}});
  await cc.create('python failure');await cc.start();
  assert(cc.s.status==='completed' && runs===1 && calls===3 && !cc.s.pending,'Цикл продолжен, вычисление не повторено');
});
test('DeepSeek: восстановление отправленного ответа без повторного клика', async () => {
  const adapter=new DeepSeekAdapter(store);let sends=0;
  adapter.inspect=async()=>({status:'ready',answer:'new'});
  adapter.dom=async action=>{if(action==='delivery')return {posted:true,latest:true,draft:'empty'};sends++;};
  adapter.waitAnswer=async()=> 'recovered';
  assert(await adapter.recoverExchange({phase:'send-uncertain',prompt:'prompt',before:{}},async()=>{})==='recovered' && sends===0,'Ответ уже отправленного запроса прочитан');
  adapter.dom=async action=>{if(action==='delivery')return {posted:false,latest:false,draft:'exact'};sends++;};
  await fail(()=>adapter.recoverExchange({phase:'send-uncertain',prompt:'prompt',before:{}},async()=>{}));
  assert(sends===0,'Неопределённая отправка никогда не повторяется');
  const phases=[];
  adapter.dom=async action=>{if(action==='delivery')return {posted:false,latest:false,draft:'exact'};
    assert(action==='submit','Повторная вставка в уже заполненное поле запрещена');sends++;return {attempted:true};};
  await adapter.recoverExchange({phase:'inserted',prompt:'prompt',before:{}},async event=>phases.push(event.phase));
  assert(sends===1 && phases.join(',')==='inserted,send-uncertain','Доказанно не отправленный черновик отправляется один раз');
});

const reviewPlan = () => ({ container: '.review', limit: 500, fields: {
  author: {selector:'.author',attribute:'text'}, date:{selector:'time',attribute:'datetime'},
  rating:{selector:'.rating',attribute:'data-rating'}, text:{selector:'.body',attribute:'text'}, source:{selector:'.source',attribute:'href'}
}});
test('DeepSeek: общий таймаут, видимые фазы, прокрутка виртуального ответа без повторной отправки', async()=>{
  const adapter=new DeepSeekAdapter(store);adapter.waitMs=70;adapter.idleMs=20;adapter.nudgeMs=5;adapter.pollMs=2;
  let nudges=0;const phases=[];adapter.onStatus=async phase=>phases.push(phase);
  adapter.inspect=async()=>({status:'ready',answer:'old',count:1,completion:true});
  adapter.dom=async action=>{assert(action==='reveal-latest','Нельзя повторять отправку');nudges++;};
  let code;try{await adapter.waitAnswer({answer:'old',count:1})}catch(e){code=e.code}
  assert(code==='RESPONSE_IDLE' && nudges>0 && phases.includes('waiting-response'),'Пустое ожидание ограничено, виртуальный список раскрыт');
  adapter.inspect=async()=>({status:'generating',answer:'partial',count:2});
  try{await adapter.waitAnswer({answer:'old',count:1,deadline:Date.now()+10})}catch(e){code=e.code}
  assert(code==='RESPONSE_TIMEOUT' && phases.includes('generating'),'Генерация имеет общий конечный бюджет');
  let recovered=0;
  const cc=new AgentController({store,files,browser:{detach:async()=>{}},python:{cancel(){}},model:{
    async exchange(prompt,journal){await journal({phase:'send-uncertain',prompt,before:{}});const e=new Error('Время ответа истекло');e.code='RESPONSE_TIMEOUT';throw e;},
    async recoverExchange(){recovered++;throw new Error('Недопустимый второй таймаут');}
  }});
  await cc.create('timeout');await cc.start();
  assert(cc.s.status==='paused' && recovered===0 && cc.s.outbound,'Таймаут не запускает второй цикл ожидания, запрос остаётся сохранён');
});

test('Длительная задача: продолжение после прежнего лимита, более 50 новых шагов, компактный контекст', async()=>{
  let calls=0,runs=0;
  const fakeFiles={permission:async()=>{},write:async path=>({path})};
  const cc=new AgentController({store,files:fakeFiles,browser:{detach:async()=>{},execute:async()=>{runs++;return {scrolled:true}}},python:{cancel(){}},model:{
    async exchange(prompt){
      assert(!prompt.includes('"remaining"')&&!prompt.includes('50 шагов'),'Старый бюджет отсутствует в инструкции');
      calls++;return JSON.stringify(calls<=55?command('long-'+calls,'browser.scroll',{tabId:1,delta:calls}):command('long-done','task.finish',{summary:'Готово'}));
    }
  }});
  await cc.create('Продолжи длительный сбор');
  cc.s.steps=50;cc.s.started=Date.now()-2*24*60*60000;cc.s.reason='Достигнут лимит 50 шагов';
  cc.s.files=['old-result.csv'];
  await cc.start();
  assert(cc.s.status==='completed'&&runs===55&&cc.s.steps===106&&cc.s.files.includes('old-result.csv'),'Старая задача продолжена без сброса и потери файлов');
  cc.s.files=Array.from({length:2000},(_,i)=>'tasks/'+cc.s.id+'/pages/page-'+i+'.json');
  const prompt=cc.prompt(),context=JSON.parse(prompt.split('Состояние: ')[1]);
  assert(prompt.length<45000&&context.files.length===20&&context.totalFiles===2000&&context.filesTruncated,'История файлов не раздувает каждый запрос, усечение явно обозначено');
  calls=0;runs=0;
  cc.model.exchange=async()=>{calls++;return JSON.stringify(command('duplicate-loop','browser.scroll',{tabId:1,delta:42}))};
  await cc.create('Проверка повторяющейся команды');await cc.start();
  assert(cc.s.status==='paused'&&runs===1&&calls===4&&cc.s.reason.includes('Повторяющиеся'),'Повтор выполненного id не создаёт бесконечный цикл и не выполняется заново');
  cc.model.exchange=async()=>JSON.stringify(command('after-loop','task.finish',{summary:'Продолжено'}));await cc.start();
  assert(cc.s.status==='completed'&&runs===1,'Продолжение не застревает на старом дублирующемся ответе');
});
test('DeepSeek: большое сообщение не отклоняется искусственным порогом расширения', async()=>{
  const adapter=new DeepSeekAdapter(store);let inserted='';
  adapter.inspect=async()=>({status:'ready',count:0,answer:''});
  adapter.dom=async(action,prompt)=>{assert(action==='send','Ожидалась только вставка');inserted=prompt;};
  adapter.submitPrepared=async()=>{};adapter.waitAnswer=async()=> 'ok';
  assert(await adapter.exchange('x'.repeat(46000),async()=>{})==='ok'&&inserted.length===46000,'Порог 45000 удалён; ограничения самого сервиса определяет его интерфейс');
  const checked=new DeepSeekAdapter(store);let sends=0;
  checked.inspect=async()=>({status:'ready',sendEnabled:true});
  checked.dom=async action=>{if(action==='submit')sends++;return {draft:'other'}};
  await fail(()=>checked.submitPrepared('full prompt',{},async()=>{}));
  assert(sends===0,'Изменённый самим сайтом текст нельзя молча отправить вместо полного запроса');
});

test('Планы и входные файлы: валидация, запрет JS, значений форм и выхода из папки', async () => {
  parseCommand(JSON.stringify(command('plan','browser.collect',{tabId:1,inspection:'i',plan:reviewPlan()})));
  for (const plan of [{...reviewPlan(),js:'fetch(document.cookie)'}, {...reviewPlan(),limit:501},
    {...reviewPlan(),fields:{secret:{selector:'input',attribute:'value'}}}]) {
    await fail(()=>parseCommand(JSON.stringify(command('bad','browser.collect',{tabId:1,inspection:'i',plan}))));
  }
  await fail(()=>parseCommand(JSON.stringify(command('bad','python.run',{code:'pass',data:{},files:[{path:'../secret',name:'a'}]}))));
  parseCommand(JSON.stringify(command('open-new','browser.open',{url:'https://example.org/',newTab:true})));
  await fail(()=>parseCommand(JSON.stringify(command('bad-new','browser.open',{url:'https://example.org/',newTab:'yes'}))));
  parseCommand(JSON.stringify(command('old','python.run',{code:'result=1',data:{}})));
  parseCommand(JSON.stringify(command('new','python.run',{code:'result=1',data:{},files:[{path:'data.csv',name:'data.csv'}]})));
});
test('Страницы → план → сохранённые файлы → остановка/восстановление → настоящий Python/CSV', async () => {
  const b=new BrowserTools({tabs:[]},async()=>{},async()=>{});
  const open=b.open.bind(b);b.open=(url,options={})=>open(url,{...options,fixture:true});
  const cc=new AgentController({store,files,browser:b,model:{cancel(){}},python:new PythonRuntime()});
  await cc.create('Собери отзывы и обработай локальные файлы');
  const paths=[], tabs=[];
  try {
    for (const [index,name] of ['records.html','records-page2.html'].entries()) {
      const tab=await cc.execute(command('open'+index,'browser.open',{url:chrome.runtime.getURL('fixtures/'+name)}));
      tabs.push(tab.tabId);
      assert(tab.page.savedPath,'Открытая страница уже сохранена');
      const inspect=await cc.execute(command('inspect'+index,'browser.inspect',{tabId:tab.tabId,selector:'#reviews',limit:40}));
      assert(inspect.nodes.some(n=>n.selectors.some(s=>s.selector==='article.review')),'Селекторы доступны модели');
      assert(!JSON.stringify(inspect).includes('NOT_FOR_COLLECTION'),'Нет значений форм и скриптов');
      const rows=await cc.execute(command('collect'+index,'browser.collect',{tabId:tab.tabId,inspection:inspect.inspection,plan:reviewPlan()}));
      paths.push(rows.savedPath);
      assert(rows.savedRecords===(index===0?2:1),'Собраны все записи');
      if(index===1)assert(rows.missing.date===1,'Отсутствующее поле отмечено');
      assert(!JSON.stringify(rows.records).includes('BODY_SENTINEL_AFTER_PREVIEW'),'В чат передан только предварительный просмотр');
      const full=JSON.parse(await(await files.file(rows.savedPath)).text());
      assert(full.capture.contentHash && full.plan && full.url && full.collectedAt,'Происхождение и план сохранены');
      assert(!JSON.stringify(full.records).includes('NOT_FOR_COLLECTION')&&!JSON.stringify(full.records).includes('HIDDEN_DATA'),'Секретные и скрытые элементы исключены');
    }
    await cc.stop();
    const reloaded=await new StateStore('psy-agent-tests').init();const saved=await reloaded.get('task');
    assert(saved.status==='stopped'&&paths.every(p=>saved.files.includes(p)),'Остановка и перезагрузка не теряют сбор');
    cc.s=StateStore.recover(saved);cc.s.status='paused';b.state=cc.s;
    const job=await cc.execute(command('CON','python.run',{data:{},files:paths.map((path,i)=>({path,name:'page'+i+'.json'})),code:
      'import json, pandas as pd\ndocs=[json.load(open(inputs[name],encoding="utf-8")) for name in sorted(inputs)]\nrows=[r["fields"] for d in docs for r in d["records"]]\ndf=pd.DataFrame(rows)\ndf["rating"]=pd.to_numeric(df["rating"])\ndf.to_csv("reviews.csv",index=False)\nresult={"rows":len(df),"mean":float(df["rating"].mean()),"full_text": "BODY_SENTINEL_AFTER_PREVIEW" in df.iloc[-1]["text"]}'
    }));
    let output;for(let i=0;i<5;i++){output=await cc.execute(command('check-CON-'+i,'python.status',{jobId:job.jobId,waitMs:15000}));if(output.status!=='running')break;}
    assert(output.result.rows===3&&output.result.mean===4&&output.result.full_text,'Worker обработал полные локальные файлы');
    assert(output.files[0].path.endsWith('/reviews.csv')&&(await files.read(output.files[0].path)).text.includes('Ирина'),'CSV сохранён в папке');
    const old=cc.s.id;await cc.create('Новая задача');
    assert(old!==cc.s.id&&paths.every(p=>p.includes(old)),'Файлы задач разделены');
    for(const path of paths)assert((await files.file(path)).size>0,'Предыдущие результаты остались в папке');
  } finally { await b.detach();for(const id of new Set(tabs))await chrome.tabs.remove(id); }
});
test('Сбой экспорта: журнал сохраняет данные, повторный запуск выгружает файл без дубликатов', async () => {
  const cc=new AgentController({store,files,browser:{detach:async()=>{}},model:{cancel(){}},python:{cancel(){}}});
  await cc.create('durable');const capture=new Captures(store,files,cc.s,()=>cc.save());
  const write=files.write.bind(files);
  files.write=async()=>{throw new Error('temporary directory failure')};
  try {await fail(()=>capture.capture(command('saved','browser.collect',{}),{kind:'records',url:'https://example.org',records:[{fields:{text:'KEEP'}}]}));}
  finally {files.write=write;}
  const reopened=await new StateStore('psy-agent-tests').init();
  const replay=new Captures(reopened,files,cc.s,()=>cc.save());let exports=0;
  files.write=async(...args)=>{exports++;return write(...args)};
  try {await Promise.all([replay.flush(),replay.flush()]);}finally{files.write=write;}
  assert(exports===1,'Одновременные flush записывают страницу один раз');
  const path=cc.s.files.find(p=>p.endsWith('/pages/step-saved.json'));
  assert(path&&(await files.read(path)).text.includes('KEEP'),'После сбоя данные выгружены из журнала');
  const key='capture:'+cc.s.id+':saved';const record=await reopened.get(key);record.status='staged';delete record.savedPath;await reopened.put(key,record);
  files.write=async()=>{throw new Error('Нельзя повторять уже завершённую запись')};
  try {await replay.flush();} finally {files.write=write;}
  assert(cc.s.files.filter(p=>p===path).length===1,'Сверка по хешу не создаёт копию');
  const collision='tasks/'+cc.s.id+'/pages/step-collision.json';await files.write(collision,'user original');
  const out=await replay.capture(command('collision','browser.collect',{}),{text:'new'});
  assert(out.savedPath!==collision&&(await files.read(collision)).text==='user original','Пользовательский файл не перезаписан');
  const portable=await replay.capture(command('CON','browser.collect',{}),{text:'portable'});
  assert(pathParts(portable.savedPath).length>0,'Идентификатор команды не создаёт зарезервированное имя Windows');
});
test('Отложенная выгрузка прошлой задачи завершается при запуске новой', async () => {
  const cc=new AgentController({store,files,browser:{detach:async()=>{}},model:{},python:{}});await cc.create('old export');
  const old=cc.s,write=files.write.bind(files);files.write=async()=>{throw new Error('directory unavailable')};
  try{await fail(()=>cc.captures().capture(command('queued','browser.collect',{}),{text:'OLD_COLLECTED'}));}finally{files.write=write;}
  await store.put('archive-'+old.id,old);await cc.create('new export');await cc.captures().flush();
  const archived=await store.get('archive-'+old.id);
  const path=archived.files.find(p=>p.endsWith('/step-queued.json'));
  assert(path&&(await files.read(path)).text.includes('OLD_COLLECTED'),'Старая страница выгружена без возврата в настройки и старую задачу');
  assert(!cc.s.files.includes(path),'Файлы задач не смешиваются');
});
test('Остановка во время сохранения: уже полученная страница остаётся в папке', async () => {
  const cc=new AgentController({store,files,browser:{detach:async()=>{},execute:async()=>({url:'https://example.org',data:'COLLECTED'})},model:{cancel(){}},python:{cancel(){}}});
  await cc.create('stop capture');cc.running=true;
  const original=files.write.bind(files);let reached,release;
  const started=new Promise(r=>reached=r),gate=new Promise(r=>release=r);
  files.write=async(...args)=>{if(args[0].includes('/pages/')){reached();await gate;}return original(...args)};
  const collection=cc.execute(command('during-stop','browser.extract',{tabId:1,kind:'text'}));
  try {await started;await cc.stop();release();const out=await collection;
    assert(cc.s.status==='stopped'&&(await files.read(out.savedPath)).text.includes('COLLECTED'),'Начатая запись завершена после stop');}
  finally {release();files.write=original;cc.running=false;}
});
test('Python inputs: список папки даёт доступ к файлам, сторонние пути и размеры ограничены', async () => {
  const out=await files.write('user-data.csv','x\n1\n');
  const cc=new AgentController({store,files,browser:{detach:async()=>{}},model:{},python:{}});await cc.create('Обработай файлы проекта');
  await fail(()=>loadPythonInputs(files,cc.s,[{path:out.path,name:'data.csv'}]));
  await cc.execute(command('list-inputs','files.list',{}));
  const input=await loadPythonInputs(files,cc.s,[{path:out.path,name:'data.csv'}]);
  assert(new TextDecoder().decode(input[0].bytes).includes('1'),'Вход загружен локально');
  await fail(()=>loadPythonInputs(files,cc.s,[{path:'../bad',name:'data.csv'}]));
  await fail(()=>loadPythonInputs({file:async()=>({size:10000001})},cc.s,[{path:out.path,name:'data.csv'}]));
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
