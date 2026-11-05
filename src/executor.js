import {
  ChatSessions,
  conversationURL
} from './chat-sessions.js';
/** Privileged extension iframe inside the active chat. No window.postMessage commands. */
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
  ProjectSync
} from './project-sync.js';
import {
  AgentController
} from './agent-controller.js';
import {
  assert
} from './util.js';

const current = await chrome.tabs.getCurrent();
const identity = current || await chrome.runtime.sendMessage({
  type: 'executor-identify'
});
const tabId = current?.id ?? identity?.tabId;
assert(Number.isInteger(tabId), 'Браузер не предоставил вкладку для встроенного исполнителя');
const baseStore = await new StateStore().init();
const sessions = new ChatSessions(baseStore);
let chatId = await sessions.resolve(tabId, (await chrome.tabs.get(tabId)).url);
let store = baseStore.forChat(chatId);
let files = new ProjectFiles(store);
let model = new DeepSeekAdapter(store);
let python = new PythonRuntime(new ProjectSync(store));
await navigator.locks.request(sessions.lock(chatId), {
  ifAvailable: true
}, async lock => {
  if (!lock) return;
  const savedTask = await store.get('task');
  if (savedTask) {
    const recovered = StateStore.recover(savedTask);
    if (recovered) await store.save(recovered);
    else {
      await store.put('task', null);
      await chrome.storage.local.remove([store.summaryKey, store.historyKey]);
    }
  }
});
let controller = null,
  browser = null,
  handling = false,
  cancellation = 0,
  agentEnabled = false;
const capabilities = () => ({
  debugger: !!chrome.debugger?.attach,
  scripting: !!chrome.scripting?.executeScript,
  sessionStorage: !!chrome.storage.session,
  internalFiles: !!navigator.storage?.getDirectory,
  worker: typeof Worker === 'function',
  locks: !!navigator.locks?.request
});
async function selectSession(allowChange = !handling) {
  const id = await sessions.resolve(tabId, (await chrome.tabs.get(tabId)).url);
  if (id === chatId) return;
  assert(allowChange, 'Диалог сменился во время запуска; задача не отправлена');
  assert(!controller?.running && !python.running, 'Предыдущий диалог ещё останавливается');
  await python.flush();
  python.reset('Открыт другой диалог');
  await browser?.detach();
  chatId = id;
  store = baseStore.forChat(id);
  files = new ProjectFiles(store);
  model = new DeepSeekAdapter(store);
  python = new PythonRuntime(new ProjectSync(store));
  controller = null;
  browser = null;
}
async function notice(text) {
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: 'chat-notice',
      text
    }, {
      frameId: 0
    });
  } catch {}
}
async function connect({
  allowGenerating = false
} = {}) {
  await selectSession();
  const caps = capabilities();
  assert(caps.scripting && caps.sessionStorage && caps.worker && caps.locks,
    'В браузере недоступны scripting, session storage, Web Locks или Worker. Подробности — в диагностике настроек.'
  );
  const options = await chrome.storage.local.get(['chat-bindings', 'browser-mode', 'browser-auto-fallback']);
  await files.restore();
  await files.permission();
  try {
    await python.flush();
  } catch (error) {
    if (error.code !== 'PROJECT_CONFLICT') throw error;
    const saved = await store.get('task');
    if (saved) {
      saved.files = [...new Set([...saved.files, ...(error.conflictFiles || [])])];
      saved.recoveryNotice = error.message;
      await store.save(saved);
    }
  }
  await python.bindScope((await chrome.tabs.get(tabId)).url, files.root);
  const state = await model.connect(tabId, options['chat-bindings'] || {});
  assert(state.status === 'ready' || allowGenerating && state.status === 'generating', state.reason || 'Чат ещё не готов к отправке');
  return options;
}
async function restoreController(options = {}) {
  const settings = await connect(options);
  browser ||= new BrowserTools({
    tabs: []
  }, () => controller.save(), async detail => {
    const result = await chrome.tabs.sendMessage(tabId, {
      type: 'chat-approval',
      text: detail.reason || 'Действие недоступно в автоматическом режиме'
    }, {
      frameId: 0
    });
    assert(result?.approved, 'Пользователь отказал');
  });
  browser.transport = settings['browser-mode'] || 'auto';
  browser.autoFallback = !!settings['browser-auto-fallback'];
  controller = new AgentController({
    store,
    files,
    browser,
    model,
    python
  });
  controller.onConversation = async url => {
    if (!conversationURL(controller.s.modelChatURL) && conversationURL(url)) {
      const prompt = controller.s.outbound?.prompt;
      const delivery = prompt && await model.dom('delivery', prompt);
      assert(delivery?.posted && delivery.latest, 'Не удалось подтвердить отправку в новом диалоге. Повторной отправки не было.');
    }
    await sessions.promote(chatId, url);
    model.conversation = conversationURL(url);
  };
  controller.s = StateStore.recover(await store.get('task'));
  if (controller.s) {
    browser.state = controller.s;
    browser.onIntervention = reason => controller.pause(reason);
  }
}
async function runLocked(message, respond) {
  assert(!handling && !controller?.running, 'Агент ещё выполняет задачу');
  handling = true;
  const generation = cancellation;
  try {
    await selectSession(true);
    await navigator.locks.request(sessions.lock(chatId), {
      ifAvailable: true
    }, async lock => {
      assert(lock, 'Этот диалог уже выполняется в другой вкладке. Продолжите в ней либо остановите её задачу.');
      assert(agentEnabled, 'Включите режим агента в чате');
      const continuing = message.command === 'resume' || message.command === 'chat-task' &&
        /^(продолжай|продолжи|продолжить|возобнови|дальше)[.!\s]*$/i.test(message.task?.trim() || '');
      await restoreController({
        allowGenerating: continuing
      });
      assert(generation === cancellation, 'Запуск отменён');
      if (message.command === 'chat-task' && !continuing) {
        // A new task archives uncertainty; it never resumes or retries the old command.
        assert(typeof message.task === 'string' && message.task.trim() && message.task.length <=
          20000, 'Задача пуста или слишком длинная');
        if (controller.s) {
          controller.s = StateStore.recover(await store.get('task'));
          browser.state = controller.s;
        }
        if (controller.s) {
          await store.put('archive-' + controller.s.id, controller.s);
        }
        await controller.create(message.task);
        controller.s.modelTabId = tabId;
        controller.s.modelChatURL = (await chrome.tabs.get(tabId)).url;
        await controller.save();
        assert(generation === cancellation, 'Запуск отменён');
        await model.dom('clear-task', message.task);
        assert(generation === cancellation, 'Запуск отменён');
      } else {
        assert(controller.s, 'Нет задачи для восстановления');
        const chatURL = (await chrome.tabs.get(tabId)).url;
        let sameChat = controller.s.modelChatURL ? controller.s.modelChatURL === chatURL : controller.s.modelTabId === tabId;
        if (!sameChat && controller.s.outbound && controller.s.modelChatURL && ['/', '/a/chat', '/a/chat/'].includes(new URL(controller.s.modelChatURL).pathname)) {
          const delivery = await model.dom('delivery', controller.s.outbound.prompt);
          sameChat = delivery.posted && delivery.latest;
          if (sameChat) controller.s.modelChatURL = chatURL;
        }
        assert(sameChat, 'Эта задача относится к другому чату. Можно отправить здесь новую задачу.');
        controller.s.modelTabId = tabId;
        if (continuing && message.command === 'chat-task') await model.dom('clear-task', message.task);
        if (continuing && controller.s.status === 'stopped') controller.s.status = 'paused';
        if (message.command === 'reset-tabs') {
          controller.s.tabs = [];
          await controller.save();
        }
        if (!continuing) {
          respond({
            ok: true
          });
          return;
        }
      }
      respond({
        ok: true
      });
      try {
        await controller.start();
      } catch (e) {
        await notice(e.message);
      }
      // The controller projection is displayed once in chat; no duplicate pause notification.
    });
  } finally {
    handling = false;
  }
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || sender.tab || (sender.url && sender.url !== chrome.runtime
      .getURL('src/service-worker.js'))) return;
  if (message.type !== 'executor-command' || message.targetTabId !== tabId) return;
  let replied = false;
  const respond = value => {
    if (!replied) {
      replied = true;
      reply(value);
    }
  };
  (async () => {
    if (message.command === 'engine-ping') {
      await selectSession();
      respond({
        ok: true,
        data: {
          tabId,
          chatId,
          chatURL: (await chrome.tabs.get(tabId)).url
        }
      });
      return;
    }
    if (message.command === 'status') {
      await selectSession();
      const saved = await store.get('task');
      const locks = await navigator.locks.query();
      respond({
        ok: true,
        data: {
          active: locks.held.some(l => l.name === sessions.lock(chatId)),
          computing: !!python.running,
          capabilities: capabilities(),
          status: saved?.status,
          reason: saved?.reason,
          files: saved?.files || []
        }
      });
      return;
    }
    if (message.command === 'chat-stop') {
      agentEnabled = false;
      cancellation++;
      if (controller && (handling || controller.running || python.running)) await controller.stop();
      respond({
        ok: true
      });
      return;
    }
    if (message.command === 'chat-ready') {
      await connect();
      agentEnabled = true;
      respond({
        ok: true,
        data: capabilities()
      });
      return;
    }
    if (message.command === 'export-file') {
      const saved = await store.get('task');
      assert(saved?.files.includes(message.path), 'Файл не принадлежит результатам задачи');
      await files.restore();
      const file = await files.file(message.path);
      assert(file.size <= 10000000, 'Файл больше 10 МБ');
      respond({
        ok: true,
        data: {
          name: file.name,
          bytes: Array.from(new Uint8Array(await file.arrayBuffer()))
        }
      });
      return;
    }
    await runLocked(message, respond);
  })().catch(e => respond({
    ok: false,
    error: e.message
  }));
  return true;
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[files.configKey]) void files.restore().then(() => python.bindScope(model.config ? controller?.s?.modelChatURL || python.chatURL : python.chatURL, files.root)).catch(() => python.reset('Изменено хранилище'));
});
chrome.tabs.onUpdated?.addListener((id, change) => {
  if (id !== tabId || !change.url) return;
  void sessions.resolve(tabId, change.url).then(async next => {
    if (next !== chatId) {
      agentEnabled = false;
      cancellation++;
      if (controller?.running) await controller.stop();
      else {
        model.cancel();
        python.reset('Открыт другой диалог');
      }
    } else await python.bindScope(change.url, files.root);
  }).catch(() => {});
});
window.addEventListener('pagehide', () => {
  model.cancel();
  python.cancel();
});
