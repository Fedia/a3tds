/** Settings only. Closing this document does not stop the executor in DeepSeek. */
import {
  StateStore
} from './state-store.js';
import {
  ProjectFiles
} from './project-files.js';
import {
  assert
} from './util.js';
const $ = s => document.querySelector(s);
const store = await new StateStore().init();
const files = new ProjectFiles(store);
await files.restore();
const preferences = await chrome.storage.local.get(['cloud-consent', 'browser-mode']);
if (preferences['cloud-consent'] === undefined) {
  preferences['cloud-consent'] = (await store.get('cloud-consent')) === true;
  await chrome.storage.local.set({
    'cloud-consent': preferences['cloud-consent']
  });
}
$('#consent').checked = preferences['cloud-consent'];
$('#consent').onchange = () => chrome.storage.local.set({
  'cloud-consent': $('#consent').checked
});
$('#compatible').checked = preferences['browser-mode'] === 'scripting' || !chrome.debugger?.attach;
$('#compatible').onchange = () => chrome.storage.local.set({
  'browser-mode': $('#compatible').checked ? 'scripting' : 'auto'
});

function render() {
  $('#folder-name').textContent = files.mode === 'browser' ? 'Внутреннее хранилище браузера' : files.root
    ?.name || 'Хранилище не выбрано';
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
async function idle() {
  const {
    summary
  } = await chrome.storage.local.get('summary');
  if (summary?.status === 'running') {
    const state = await command('status');
    assert(!state.active, 'Сначала выключите режим агента в чате');
  }
}
async function command(command, extra = {}) {
  const tabId = Number($('#deepseek-tab').value);
  assert(tabId, 'Откройте DeepSeek и обновите список');
  const result = await chrome.runtime.sendMessage({
    type: 'settings-command',
    tabId,
    command,
    ...extra
  });
  assert(result?.ok, result?.error || 'Откройте или обновите вкладку DeepSeek');
  return result.data;
}
action('#folder', async () => {
  await idle();
  await files.choose();
});
action('#internal', async () => {
  await idle();
  await files.useBrowserStorage();
});
action('#permission', () => files.authorize());
action('#site-permission', async () => {
  assert(chrome.permissions?.request, 'Браузер не поддерживает запрос доступа к сайтам');
  const granted = await chrome.permissions.request({
    origins: ['http://*/*', 'https://*/*']
  });
  assert(granted, 'Доступ к сайтам не предоставлен');
  $('#status').textContent = 'Доступ к страницам для совместимого режима разрешён';
});
async function tabs() {
  const found = await chrome.tabs.query({
    url: 'https://chat.deepseek.com/*'
  });
  $('#deepseek-tab').replaceChildren(...found.map(t => {
    const o = document.createElement('option');
    o.value = t.id;
    o.textContent = t.title || 'DeepSeek';
    return o;
  }));
}
action('#refresh-tabs', tabs);
action('#pick', async () => {
  await idle();
  const id = Number($('#deepseek-tab').value);
  assert(id, 'Откройте DeepSeek');
  await chrome.tabs.update(id, {
    active: true
  });
  const result = await chrome.tabs.sendMessage(id, {
    type: 'pick-bindings'
  }, {
    frameId: 0
  });
  assert(result?.ok, result?.error || 'Обновите вкладку DeepSeek');
});
action('#reconcile', () => command('reconcile', {
  note: $('#note').value
}));
action('#recover-send', () => command('recover-send'));
action('#resume', () => command('resume'));
action('#reset-tabs', () => command('reset-tabs'));
action('#cancel-send', async () => {
  assert(confirm(
    'Вы проверили исходный чат и уверены, что запрос НЕ был отправлен? Очистите поле перед продолжением.'
    ), 'Отменено');
  await command('cancel-send');
});
async function diagnostics() {
  const data = await command('status');
  const c = data.capabilities;
  $('#status').textContent =
    `Исполнитель в чате доступен. CDP: ${c.debugger?'есть':'нет'}, scripting: ${c.scripting?'есть':'нет'}, session storage: ${c.sessionStorage?'есть':'нет'}, Worker: ${c.worker?'есть':'нет'}, Web Locks: ${c.locks?'есть':'нет'}, внутренние файлы: ${c.internalFiles?'есть':'нет'}.\n${data.status||''} ${data.reason||''}`;
  $('#files').replaceChildren(...data.files.map(path => {
    const li = document.createElement('li'),
      button = document.createElement('button');
    button.textContent = 'Скачать ' + path;
    button.onclick = async () => {
      try {
        const file = await command('export-file', {
          path
        });
        const url = URL.createObjectURL(new Blob([new Uint8Array(file.bytes)], {
          type: 'application/octet-stream'
        }));
        const link = document.createElement('a');
        link.href = url;
        link.download = file.name;
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      } catch (e) {
        $('#status').textContent = e.message;
      }
    };
    li.append(button);
    return li;
  }));
}
action('#diagnose', diagnostics);
$('#folder').disabled = typeof showDirectoryPicker !== 'function';
await tabs();
render();
