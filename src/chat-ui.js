/* Isolated content script. Page scripts cannot call the extension message bridge. */
(() => {
  let enabled = false,
    busy = false,
    config = {},
    picking = false;
  const host = document.createElement('div');
  const shadow = host.attachShadow({
    mode: 'closed'
  });
  const style = document.createElement('style');
  style.textContent = `
    :host{position:fixed;right:max(8px,env(safe-area-inset-right));top:max(8px,env(safe-area-inset-top));z-index:2147483646;max-width:calc(100vw - 16px)}
    div{display:flex;align-items:center;gap:8px;background:#fff;color:#222;padding:4px 8px;border:1px solid #aaa;border-radius:10px;font:16px system-ui;box-sizing:border-box}
    button,label{min-height:44px;display:flex;align-items:center;cursor:pointer;touch-action:manipulation;font:inherit}
    button{padding:0 12px;border:1px solid #aaa;border-radius:6px;background:#f5f5f5;color:#222}
    input{width:22px;height:22px;margin-right:8px}
  `;
  const bar = document.createElement('div');
  const label = document.createElement('label');
  const toggle = document.createElement('input');
  toggle.type = 'checkbox';
  label.append(toggle, ' Агент');
  const settings = document.createElement('button');
  settings.textContent = 'Настройки';
  bar.append(label, settings);
  shadow.append(style, bar);
  document.documentElement.append(host);
  // Extension-origin executor stays with the foreground chat, not the settings tab.
  const executor = document.createElement('iframe');
  executor.src = chrome.runtime.getURL('executor.html');
  executor.hidden = true;
  executor.title = 'Agent executor';
  shadow.append(executor);
  async function ensureExecutor() {
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        if ((await chrome.runtime.sendMessage({
            type: 'engine-ping'
          }))?.ok) return;
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    throw new Error(
      'Встроенный исполнитель недоступен. Обновите DeepSeek; если ошибка повторяется, откройте диагностику настроек.'
      );
  }
  const send = message => chrome.runtime.sendMessage(message);
  const load = async () => {
    config = (await chrome.storage.local.get('chat-bindings'))['chat-bindings'] || {};
  };
  load();
  chrome.storage.onChanged.addListener(load);
  settings.onclick = () => send({
    type: 'open-workspace'
  });
  toggle.onchange = async () => {
    enabled = toggle.checked;
    if (!enabled) {
      await send({
        type: 'chat-stop'
      });
      return;
    }
    try {
      await ensureExecutor();
      const result = await send({
        type: 'chat-ready'
      });
      if (!result?.ok) throw new Error(result?.error || 'Откройте настройки и выберите папку проекта.');
      if (!config.input || !config.send || !config.response || !config.complete) throw new Error(
        'Откройте настройки и выполните привязку четырьмя кликами.');
    } catch (e) {
      enabled = false;
      toggle.checked = false;
      alert(e.message);
    }
  };
  const input = () => config.input && document.querySelector(config.input);
  async function submit() {
    if (busy) return;
    const element = input();
    const task = element?.value ?? element?.innerText ?? '';
    if (!task.trim()) return;
    busy = true;
    try {
      const result = await send({
        type: 'chat-task',
        task
      });
      if (!result?.ok) throw new Error(result?.error || 'Задача не принята. Черновик сохранён.');
    } catch (e) {
      alert(e.message);
    } finally {
      busy = false;
    }
  }

  function intercept(event) {
    if (!enabled || picking || !event.isTrusted) return;
    const element = input();
    const click = event.type === 'click' && config.send && event.target.closest(config.send);
    const enter = event.type === 'keydown' && event.key === 'Enter' && !event.shiftKey && !event
      .isComposing && element?.contains(event.target);
    if (!click && !enter) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    submit();
  }
  window.addEventListener('click', intercept, true);
  window.addEventListener('keydown', intercept, true);
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (sender.id !== chrome.runtime.id) return;
    if (message.type === 'chat-approval') {
      reply({
        approved: confirm(message.text)
      });
      return;
    }
    if (message.type === 'chat-notice') {
      alert(message.text);
      reply({
        ok: true
      });
      return;
    }
    if (message.type === 'pick-bindings') {
      pick().then(() => reply({
        ok: true
      }), e => reply({
        error: e.message
      }));
      return true;
    }
  });

  function selector(element, root = document, repeated = false) {
    for (const attr of ['data-message-author-role', 'data-role', 'aria-label', 'data-testid', 'id']) {
      const value = element.getAttribute(attr);
      if (value) {
        const css = `${element.localName}[${attr}="${CSS.escape(value)}"]`;
        if (repeated || root.querySelectorAll(css).length === 1) return css;
      }
    }
    const classes = [...element.classList].filter(c => !/[0-9]{4}/.test(c));
    if (classes.length) {
      const css = element.localName + classes.map(c => '.' + CSS.escape(c)).join('');
      if (repeated || root.querySelectorAll(css).length === 1) return css;
    }
    if (repeated) throw new Error(
      'У блока ответа нет устойчивого признака. Выберите его внешний контейнер.');
    let node = element,
      parts = [];
    while (node && node !== root && node !== document.documentElement) {
      const peers = [...node.parentElement.children].filter(e => e.localName === node.localName);
      parts.unshift(node.localName + ':nth-of-type(' + (peers.indexOf(node) + 1) + ')');
      const css = parts.join(' > ');
      if (root.querySelectorAll(css).length === 1) return css;
      node = node.parentElement;
    }
    throw new Error('Не удалось сохранить привязку');
  }
  async function pick() {
    if (picking) return;
    enabled = false;
    toggle.checked = false;
    picking = true;
    const result = {};
    let response;
    const hint = document.createElement('div');
    hint.style.cssText =
      'position:fixed;top:76px;left:8px;right:8px;max-width:600px;box-sizing:border-box;z-index:2147483647;background:#123;color:white;padding:12px;font:16px system-ui';
    document.documentElement.append(hint);
    const cancel = document.createElement('button');
    cancel.textContent = 'Отменить';
    cancel.style.cssText =
      'display:block;min-height:44px;margin-top:8px;font:16px system-ui;padding:8px 16px';
    const steps = [
      ['input', 'Кликните поле сообщения'],
      ['send', 'Кликните кнопку отправки'],
      ['response', 'Кликните текст последнего готового ответа ассистента'],
      ['complete', 'Кликните кнопку копирования внутри выбранного ответа']
    ];
    try {
      for (const [key, title] of steps) {
        hint.replaceChildren(document.createTextNode(title), cancel);
        const element = await new Promise((resolve, reject) => {
          let outlined;
          const restore = () => {
            if (outlined) {
              outlined.style.outline = outlined.dataset.psyOldOutline || '';
              delete outlined.dataset.psyOldOutline;
            }
          };
          const move = e => {
            if (hint.contains(e.target)) return;
            restore();
            outlined = e.target;
            outlined.dataset.psyOldOutline = outlined.style.outline;
            outlined.style.outline = '3px solid #00a896';
          };
          const cleanup = () => {
            restore();
            window.removeEventListener('mouseover', move, true);
            window.removeEventListener('click', click, true);
            window.removeEventListener('keydown', keyDown, true);
          };
          const click = e => {
            e.preventDefault();
            e.stopImmediatePropagation();
            if (hint.contains(e.target)) {
              if (e.target === cancel) {
                cleanup();
                reject(new Error('Настройка отменена'));
              }
              return;
            }
            const el = e.target.closest(
              'button,[role=button],textarea,input,[contenteditable=true]') || e.target;
            cleanup();
            resolve(el);
          };
          const keyDown = e => {
            if (e.key === 'Escape') {
              e.preventDefault();
              cleanup();
              reject(new Error('Настройка отменена'));
            }
          };
          window.addEventListener('mouseover', move, true);
          window.addEventListener('click', click, true);
          window.addEventListener('keydown', keyDown, true);
        });
        if (key === 'input' && !element.matches('textarea,input,[contenteditable=true]')) throw new Error(
          'Выберите поле ввода сообщения.');
        if (key === 'response') {
          response = element;
          continue;
        }
        if (key === 'complete') {
          while (response && !response.contains(element)) response = response.parentElement;
          if (!response || response === document.body || response === document.documentElement)
          throw new Error('Выберите текст и кнопку одного ответа.');
          result.response = selector(response, document, true);
        }
        result[key] = selector(element, key === 'complete' ? response : document);
      }
      config = result;
      await chrome.storage.local.set({
        'chat-bindings': result
      });
      alert('Привязка сохранена. Включите режим агента и напишите задачу в чат.');
    } finally {
      hint.remove();
      picking = false;
    }
  }
})();
