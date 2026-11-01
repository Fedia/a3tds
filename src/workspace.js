import {
  StateStore
} from './state-store.js';
import {
  ProjectFiles
} from './project-files.js';
import {
  BrowserTools
} from './browser-tools.js';
import {
  DeepSeekAdapter
} from './deepseek-adapter.js';
import {
  PythonRuntime
} from './python-runtime.js';
import {
  AgentController
} from './agent-controller.js';
import {
  assert
} from './util.js';
const $ = s => document.querySelector(s);
const store = await new StateStore().init();
const files = new ProjectFiles(store);
await files.restore();
const model = new DeepSeekAdapter(store);
await model.restore();
const python = new PythonRuntime();
let approvalReject;

function approve(detail) {
  return new Promise((resolve, reject) => {
    assert(!approvalReject, 'Уже есть запрос подтверждения');
    $('#approval').hidden = false;
    $('#approval-detail').textContent = JSON.stringify(detail, null, 2);
    const finish = ok => {
      $('#approval').hidden = true;
      approvalReject = null;
      ok ? resolve() : reject(new Error('Пользователь отказал'));
    };
    $('#approve').onclick = () => finish(true);
    $('#deny').onclick = () => finish(false);
    approvalReject = () => finish(false);
  });
}
const browser = new BrowserTools({
  tabs: []
}, () => controller.save(), approve);
const controller = new AgentController({
  store,
  files,
  browser,
  model,
  python,
  update: render
});
controller.s = StateStore.recover(await store.get('task'));
if (controller.s) {
  browser.state = controller.s;
  browser.onIntervention = reason => controller.pause(reason);
  await controller.save();
  $('#task').value = controller.s.task;
}
navigator.locks.request('psy-agent-workspace', {
  ifAvailable: true
}, async l => {
  if (!l) {
    document.body.textContent = 'Управление уже открыто в другой вкладке. Вернитесь к ней.';
    return;
  }
  await new Promise(() => {});
});

function render(s = controller.s) {
  $('#folder-name').textContent = files.root?.name || 'Папка не выбрана';
  if (!s) return;
  $('#status').textContent = s.status + (s.reason ? ' — ' + s.reason : '');
  $('#current').textContent = `Шаг ${s.steps}: ${s.current||''}`;
  $('#log').textContent = s.logs.slice(-100).map(x => `${x.time} ${x.event} ${x.tool||''} ${x.message||''}`)
    .join('\n');
  $('#files').replaceChildren(...s.files.map(x => {
    const li = document.createElement('li');
    li.textContent = x;
    return li;
  }));
  $('#start').disabled = controller.running;
  $('#resume').disabled = controller.running || s.status === 'completed' || s.status === 'stopped';
}

function action(id, fn) {
  $(id).onclick = async () => {
    try {
      await fn();
      render();
    } catch (e) {
      $('#status').textContent = e.message;
    }
  };
}
const labels = {
  input: 'Поле ввода',
  send: 'Кнопка отправки',
  response: 'Ответы ассистента',
  stop: 'Генерация / остановка',
  complete: 'Завершение последнего ответа',
  login: 'Требуется вход',
  challenge: 'CAPTCHA / участие',
  error: 'Ошибка / лимит'
};
for (const [key, label] of Object.entries(labels)) {
  const el = document.createElement('label');
  el.textContent = label;
  const input = document.createElement('input');
  input.type = 'text';
  input.id = 'selector-' + key;
  input.value = model.config?.[key] || '';
  el.append(input);
  $('#selectors').append(el);
}
model.onStatus = status => {
  $('#diagnostic').textContent = status;
};
async function tabs() {
  const ts = await chrome.tabs.query({
    url: 'https://chat.deepseek.com/*'
  });
  $('#deepseek-tab').replaceChildren(...ts.map(t => {
    const o = document.createElement('option');
    o.value = t.id;
    o.textContent = t.title || 'DeepSeek';
    if (t.id === model.tabId) o.selected = true;
    return o;
  }));
}
action('#refresh-tabs', tabs);
action('#folder', () => files.choose());
action('#permission', () => files.authorize());
action('#connect', async () => {
  const config = Object.fromEntries(Object.keys(labels).map(k => [k, $('#selector-' + k).value
    .trim()
  ]));
  const s = await model.connect(Number($('#deepseek-tab').value), config);
  $('#diagnostic').textContent = JSON.stringify({
    ...s,
    answer: undefined
  }, null, 2);
});
action('#start', async () => {
  assert($('#consent').checked, 'Подтвердите передачу данных в DeepSeek');
  assert($('#task').value.trim(), 'Введите задачу');
  await files.permission();
  assert(model.tabId, 'Подключите DeepSeek');
  if (controller.s && !['completed', 'stopped'].includes(controller.s.status)) assert(confirm(
    'Старая задача будет заменена. Её файлы сохранятся. Продолжить?'), 'Отменено');
  if (controller.s) await store.put('archive-' + controller.s.id, controller.s);
  await controller.create($('#task').value.trim());
  void controller.start().catch(e => {
    $('#status').textContent = e.message;
  });
});
action('#pause', () => controller.pause());
action('#resume', async () => {
  assert($('#consent').checked, 'Подтвердите передачу данных');
  void controller.start().catch(e => {
    $('#status').textContent = e.message;
  });
});
action('#stop', async () => {
  approvalReject?.();
  await controller.stop();
});
action('#reset-tabs', async () => {
  assert(!controller.running, 'Остановите выполнение');
  assert(confirm('Забыть старые рабочие вкладки? Они останутся открытыми; агент создаст новые.'),
    'Отменено');
  controller.s.tabs = [];
  await controller.save();
});
action('#reconcile', () => controller.reconcileCommand($('#reconcile-note').value));
action('#recover-send', () => controller.reconcileSend());
action('#cancel-send', async () => {
  assert(!controller.running, 'Дождитесь завершения операции');
  assert(controller.s.outbound, 'Нет неопределённой отправки');
  assert(confirm(
    'Вы проверили историю чата и уверены, что отправка не произошла? Очистите поле ввода. Только затем подтвердите.'
  ), 'Отменено');
  await controller.log('send-manually-reset', {
    phase: controller.s.outbound.phase
  });
  controller.s.outbound = null;
  await controller.save();
});
await tabs();
render();
window.addEventListener('beforeunload', e => {
  if (controller.running) {
    e.preventDefault();
    e.returnValue = '';
  }
});
// Exposed only on this extension page for the local test harness, never to websites.
export {
  controller,
  store,
  files,
  browser,
  model,
  python
};
