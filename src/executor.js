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
const store = await new StateStore().init();
const files = new ProjectFiles(store);
const model = new DeepSeekAdapter(store);
const python = new PythonRuntime();
const savedTask = await store.get('task');
const heldLocks = await navigator.locks?.query();
if (savedTask && !heldLocks?.held.some(lock => lock.name === 'psy-agent-execution')) await store.save(StateStore.recover(savedTask));
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
  const caps = capabilities();
  assert(caps.scripting && caps.sessionStorage && caps.worker && caps.locks,
    'В браузере недоступны scripting, session storage, Web Locks или Worker. Подробности — в диагностике настроек.'
  );
  const options = await chrome.storage.local.get(['chat-bindings', 'browser-mode', 'browser-auto-fallback']);
  await files.restore();
  await files.permission();
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
    await navigator.locks.request('psy-agent-execution', {
      ifAvailable: true
    }, async lock => {
      assert(lock, 'Агент выполняется в другом чате');
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
        if (controller.s) await store.put('archive-' + controller.s.id, controller.s);
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
        if (message.command === 'reconcile') await controller.reconcileCommand(message.note);
        if (message.command === 'recover-send') await controller.reconcileSend();
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
      respond({
        ok: true,
        data: {
          tabId,
          chatURL: (await chrome.tabs.get(tabId)).url
        }
      });
      return;
    }
    if (message.command === 'status') {
      const saved = await store.get('task');
      const locks = await navigator.locks.query();
      respond({
        ok: true,
        data: {
          active: locks.held.some(l => l.name === 'psy-agent-execution'),
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
      if (controller && (handling || controller.running)) await controller.stop();
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
window.addEventListener('pagehide', () => {
  model.cancel();
  python.cancel();
});
