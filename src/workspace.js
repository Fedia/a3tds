/** Compact settings. Execution stays in the chat; diagnostics and binding are secondary. */
import {
  StateStore
} from './state-store.js';
import {
  ProjectFiles
} from './project-files.js';
import {
  deepseekDOM
} from './chat-dom.js';
import {
  assert
} from './util.js';
const $ = s => document.querySelector(s);
const store = await new StateStore().init(),
  files = new ProjectFiles(store);
await files.restore();
let selected = null,
  stored = null,
  accessType = null,
  available = [];
const notice = text => {
  $('#status').textContent = text || '';
  $('#status').hidden = !text;
};
const action = (selector, fn) => {
  $(selector).onclick = async () => {
    try {
      notice('');
      await fn();
      await render();
    } catch (e) {
      if (e.name !== 'AbortError') notice(e.message);
    }
  };
};
async function command(name, extra = {}) {
  assert(selected, 'Откройте DeepSeek');
  const result = await chrome.runtime.sendMessage({
    type: 'settings-command',
    tabId: selected,
    command: name,
    ...extra
  });
  assert(result?.ok, result?.error || 'Обновите страницу DeepSeek');
  return result.data;
}
async function idle() {
  const {
    summary
  } = await chrome.storage.local.get('summary');
  if (selected && ['running', 'paused'].includes(summary?.status)) {
    const status = await command('status');
    assert(!status.active && !status.computing, 'Сначала остановите агента в чате');
  }

}
async function tabs() {
  available = await chrome.tabs.query({
    url: 'https://chat.deepseek.com/*'
  });
  const context = await chrome.storage.session?.get('settings-chat-tab') || {};
  const {
    summary
  } = await chrome.storage.local.get('summary');
  const desired = context['settings-chat-tab'] || selected || summary?.ownerTabId;
  selected = available.find(t => t.id === desired)?.id || available.find(t => t.active)?.id || available[0]?.id || null;
  $('#deepseek-tab').replaceChildren(...available.map(tab => {
    const option = document.createElement('option');
    option.value = tab.id;
    option.textContent = tab.title || 'DeepSeek';
    return option;
  }));
  if (selected) $('#deepseek-tab').value = selected;
  $('#chat-choice').hidden = available.length < 2;
}
async function render() {
  await files.restore();
  $('#folder-name').textContent = files.mode === 'browser' ? 'Внутри браузера' : files.root?.name || 'Не выбрано';
  $('#folder').textContent = files.root ? 'Изменить' : 'Выбрать';
  $('#choose-folder').disabled = typeof showDirectoryPicker !== 'function';
  $('#storage-hint').textContent = typeof showDirectoryPicker === 'function' ? '' : 'Выбор папки недоступен в этом браузере.';
  const preferences = await chrome.storage.local.get(['browser-mode', 'needs-site-access', 'browser-auto-fallback']);
  const mode = preferences['browser-mode'] || 'auto';
  $('#mode').value = mode;
  let directoryAccess = true;
  try {
    await files.permission();
  } catch {
    directoryAccess = false;
  }
  let webAccess = true;
  if (mode === 'scripting' || !chrome.debugger?.attach || preferences['browser-auto-fallback'] || preferences['needs-site-access']) {
    try {
      webAccess = await chrome.permissions.contains({
        origins: ['http://*/*', 'https://*/*']
      });
    } catch {
      webAccess = false;
    }
  }
  accessType = files.root && !directoryAccess ? 'directory' : !webAccess ? 'web' : null;
  $('#access-row').hidden = !accessType;
  $('#access-label').textContent = accessType === 'directory' ? 'Доступ к папке' : 'Доступ к страницам';
  $('#chat-status').textContent = selected ? 'Чат открыт' : 'Не открыт';
  if (selected) {
    try {
      const bindings = (await chrome.storage.local.get('chat-bindings'))['chat-bindings'] || {};
      const [result] = await chrome.scripting.executeScript({
        target: {
          tabId: selected
        },
        func: deepseekDOM,
        args: ['inspect', bindings, null]
      });
      const state = result.result;
      $('#chat-status').textContent = state.status === 'ready' ? 'Подключён' : state.status === 'generating' ? 'Отвечает' : state.status === 'login-required' ? 'Нужен вход' : 'Проверьте чат';
    } catch {
      $('#chat-status').textContent = 'Обновите DeepSeek';
    }
  }
  stored = await store.get('task');
  const paths = stored?.files || [];
  $('#file-count').textContent = paths.length ? `Файлы · ${paths.length}` : 'Файлы результатов';
  $('#files-empty').hidden = paths.length > 0;
  $('#files').replaceChildren(...paths.map(path => {
    const li = document.createElement('li'),
      name = document.createElement('span'),
      button = document.createElement('button');
    name.textContent = path;
    name.title = path;
    button.textContent = 'Скачать';
    button.setAttribute('aria-label', 'Скачать ' + name.textContent);
    button.onclick = async () => {
      try {
        const current = await store.get('task');
        assert(current?.files.includes(path), 'Файл больше не относится к текущей задаче');
        const file = await files.file(path),
          url = URL.createObjectURL(file),
          link = document.createElement('a');
        link.href = url;
        link.download = file.name;
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      } catch (e) {
        notice(e.message);
      }
    };
    li.append(name, button);
    return li;
  }));
}
action('#folder', () => {
  const panel = $('#storage-options');
  panel.hidden = !panel.hidden;
  $('#folder').setAttribute('aria-expanded', String(!panel.hidden));
});
action('#choose-folder', async () => {
  await idle();
  await files.choose();
  $('#storage-options').hidden = true;
  $('#folder').setAttribute('aria-expanded', 'false');
});
action('#internal', async () => {
  await idle();
  await files.useBrowserStorage();
  $('#storage-options').hidden = true;
  $('#folder').setAttribute('aria-expanded', 'false');
});
action('#access', async () => {
  if (accessType === 'directory') await files.authorize();
  else {
    assert(await chrome.permissions.request({
      origins: ['http://*/*', 'https://*/*']
    }), 'Доступ не предоставлен');
    await chrome.storage.local.set({
      'needs-site-access': false
    });
  }
});
action('#files-toggle', () => {
  const panel = $('#files-panel');
  panel.hidden = !panel.hidden;
  $('#files-toggle').setAttribute('aria-expanded', String(!panel.hidden));
});
$('#mode').onchange = async () => {
  await chrome.storage.local.set({
    'browser-mode': $('#mode').value
  });
  await render();
};
$('#deepseek-tab').onchange = async () => {
  selected = Number($('#deepseek-tab').value);
  await chrome.storage.session?.set({
    'settings-chat-tab': selected
  });
  await render();
};
action('#pick', async () => {
  await idle();
  assert(selected, 'Откройте DeepSeek');
  await chrome.tabs.update(selected, {
    active: true
  });
  const result = await chrome.tabs.sendMessage(selected, {
    type: 'pick-bindings'
  }, {
    frameId: 0
  });
  assert(result?.ok, result?.error || 'Обновите DeepSeek');
});
action('#diagnose', async () => {
  const data = await command('status');
  $('#diagnostics').hidden = false;
  $('#diagnostics').textContent = Object.entries(data.capabilities).map(([key, value]) => `${key}: ${value?'есть':'нет'}`).join('\n');
});
let refreshTimer;
const refresh = () => {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => tabs().then(render).catch(e => notice(e.message)), 100);
};
chrome.storage.onChanged.addListener(refresh);
window.addEventListener('focus', refresh);
await tabs();
await render();
