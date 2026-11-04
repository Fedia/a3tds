/* Isolated content script. Page scripts cannot call the extension message bridge. */
(async () => {
  const {
    deepseekDOM,
    bindingSelector,
    bindingTarget
  } = await import(chrome.runtime.getURL('src/chat-dom.js'));
  const {
    mountFinalAnswers
  } = await import(chrome.runtime.getURL('src/final-view.js'));
  const {
    stateLabel,
    progressText,
    shortReason,
    belongsToChat
  } = await import(chrome.runtime.getURL('src/ui-state.js'));
  const {
    mountChatScroll
  } = await import(chrome.runtime.getURL('src/chat-scroll.js'));
  const scroll = mountChatScroll();
  let enabled = false,
    busy = false,
    config = {},
    picking = false,
    ownerTabId = null,
    currentState = null,
    histories = [],
    lastURL = location.href;
  // The executor has a stable root. Moving the toolbar during SPA layout changes must not reload it.
  const engineHost = document.createElement('div');
  engineHost.hidden = true;
  const engineShadow = engineHost.attachShadow({
    mode: 'closed'
  });
  const executor = document.createElement('iframe');
  executor.src = chrome.runtime.getURL('executor.html');
  executor.hidden = true;
  executor.title = 'Agent executor';
  engineShadow.append(executor);
  document.documentElement.append(engineHost);
  const host = document.createElement('div');
  host.dataset.psyAgentToolbar = '';
  host.style.cssText = 'display:flex;align-items:center;justify-content:flex-end;flex:0 0 auto;max-width:100%;min-width:0';
  const shadow = host.attachShadow({
    mode: 'closed'
  });
  const style = document.createElement('style');
  style.textContent = `
    :host{font:14px system-ui;color:inherit;box-sizing:border-box}
    .bar{display:flex;align-items:center;gap:4px;white-space:nowrap;height:44px;max-width:100%}
    label,button{display:inline-flex;align-items:center;justify-content:center;min-height:44px;touch-action:manipulation;font:inherit;color:inherit;cursor:pointer;box-sizing:border-box}
    label{gap:7px;padding:0 6px}button{width:44px;border:0;background:transparent;border-radius:8px;font-size:23px}
    button:hover{background:color-mix(in srgb,currentColor 8%,transparent)}
    input{appearance:none;width:32px;height:20px;margin:0;border:1px solid #89929f;border-radius:12px;background:#89929f;position:relative}
    input:before{content:'';position:absolute;left:2px;top:2px;width:14px;height:14px;border-radius:50%;background:white}
    input:checked{background:#4d6bfe;border-color:#4d6bfe}input:checked:before{left:14px}
    input:focus-visible,button:focus-visible{outline:2px solid #4d6bfe;outline-offset:2px}
    .status{font-size:12px;opacity:.7;max-width:105px;overflow:hidden;text-overflow:ellipsis}
    @media(max-width:600px){.status{max-width:85px}}
  `;
  const bar = document.createElement('div');
  bar.className = 'bar';
  const label = document.createElement('label');
  const toggle = document.createElement('input');
  toggle.type = 'checkbox';
  toggle.setAttribute('role', 'switch');
  toggle.setAttribute('aria-label', 'Режим агента');
  label.append(toggle, 'Агент');
  const badge = document.createElement('span');
  badge.className = 'status';
  const settings = document.createElement('button');
  settings.textContent = '⚙';
  settings.title = 'Настройки';
  settings.setAttribute('aria-label', 'Настройки');
  bar.append(label, badge, settings);
  shadow.append(style, bar);
  const progress = document.createElement('div');
  progress.className = 'psy-agent-progress';
  progress.setAttribute('role', 'status');
  progress.setAttribute('aria-live', 'polite');
  progress.style.cssText = 'display:none;flex:0 0 auto;padding:6px 12px;font:13px/1.45 system-ui;overflow-wrap:anywhere;max-width:100%;box-sizing:border-box';
  let transient = '',
    noticeTimer;
  const send = message => chrome.runtime.sendMessage(message);
  const inputElement = () => deepseekDOM('elements', config).input;
  const nativeColor = () => getComputedStyle(inputElement() || document.body).color;
  const activeState = () => belongsToChat(currentState, location.href, ownerTabId) ? currentState : null;
  const view = () => mountFinalAnswers(() => deepseekDOM('answer-elements', config), {
    getHistory: () => histories.filter(item => item.chatURL === location.href).flatMap(item => item.entries),
    color: nativeColor,
    preserveScroll: work => scroll.guard.preserve(work)
  });
  let unmountView = () => {};

  function paint() {
    const state = activeState();
    const label = enabled ? stateLabel(state) : 'Выключен';
    if (badge.textContent !== label) badge.textContent = label;
    toggle.title = enabled ? stateLabel(state) : 'Включить режим агента';
    const text = transient || progressText(state);
    if (progress.textContent !== text) progress.textContent = text;
    const display = text ? 'block' : 'none',
      color = nativeColor();
    if (progress.style.display !== display) progress.style.display = display;
    if (progress.style.color !== color) progress.style.color = color;
    if (host.style.color !== color) host.style.color = color;
  }
  const showNotice = text => {
    transient = text ? shortReason(text) : '';
    clearTimeout(noticeTimer);
    paint();
    if (transient) noticeTimer = setTimeout(() => {
      transient = '';
      paint();
    }, 8000);
  };
  const composerAnchor = composer => {
    const form = composer.closest('form');
    if (form) return form;
    const parent = composer.parentElement;
    if (parent === document.body || parent === document.documentElement) return composer;
    const grand = parent.parentElement;
    return grand === document.body || grand === document.documentElement ? parent : grand;
  };

  function place() {
    document.querySelectorAll('[data-psy-agent-toolbar]').forEach(node => {
      if (node !== host) node.remove();
    });
    if (location.href !== lastURL) {
      const old = new URL(lastURL).pathname;
      lastURL = location.href;
      if (enabled && !['/', '/a/chat', '/a/chat/'].includes(old)) {
        enabled = false;
        toggle.checked = false;
        void send({
          type: 'chat-stop'
        });
      }
    }
    const composer = inputElement();
    if (composer) {
      const anchor = composerAnchor(composer);
      if (host.nextElementSibling !== progress || progress.nextElementSibling !== anchor) anchor.before(host, progress);
    } else {
      if (!host.isConnected) document.body.prepend(host);
      if (host.nextElementSibling !== progress) host.after(progress);
    }
    paint();
    unmountView.refresh?.();
  }
  let placementTimer;
  new MutationObserver(records => {
      if (records.every(record => record.target.closest?.('.ds-virtual-list,[role=log]'))) return;
      if (records.every(record => record.type === 'attributes' && [host, progress].includes(record.target))) return;
      if (placementTimer) return;
      placementTimer = setTimeout(() => {
        placementTimer = null;
        place();
      }, 100);
    })
    .observe(document.body, {
      childList: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden'],
      subtree: true
    });
  window.addEventListener('resize', place);
  window.visualViewport?.addEventListener('resize', place);
  async function load() {
    const values = await chrome.storage.local.get(['chat-bindings', 'summary', 'ui-history']);
    config = values['chat-bindings'] || {};
    currentState = values.summary || null;
    histories = values['ui-history'] || [];

  }
  async function ensureExecutor() {
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        const result = await send({
          type: 'engine-ping'
        });
        if (result?.ok) {
          ownerTabId = result.data?.tabId ?? ownerTabId;
          paint();
          return;
        }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    throw new Error('Не удалось подключиться к чату. Обновите страницу DeepSeek.');
  }
  await load();
  unmountView = view();
  place();
  void ensureExecutor().catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes['chat-bindings']) config = changes['chat-bindings'].newValue || {};
    if (changes.summary) currentState = changes.summary.newValue || null;
    if (changes['ui-history']) histories = changes['ui-history'].newValue || [];
    if (changes.summary) transient = '';
    paint();
    if (changes['ui-history'] || changes.summary) unmountView.refresh?.();
  });
  settings.onclick = () => send({
    type: 'open-workspace'
  });
  toggle.onchange = async () => {
    transient = '';
    enabled = toggle.checked;
    paint();
    if (!enabled) {
      await send({
        type: 'chat-stop'
      });
      return;
    }
    try {
      await load();
      await ensureExecutor();
      const result = await send({
        type: 'chat-ready'
      });
      if (!result?.ok) throw new Error(result?.error || 'Выберите хранилище результатов.');
      const seen = await chrome.storage.local.get('agent-data-notice');
      if (!seen['agent-data-notice']) {
        transient = 'Задача и выбранные данные передаются в ваш чат DeepSeek.';
        paint();
        await chrome.storage.local.set({
          'agent-data-notice': true
        });
      }
    } catch (e) {
      enabled = false;
      toggle.checked = false;
      showNotice(e.message);
    }
  };
  const elements = () => deepseekDOM('elements', config);
  const input = () => elements().input;
  async function submit() {
    if (busy) return;
    const element = input();
    const task = element?.value ?? element?.innerText ?? '';
    if (!task.trim()) return;
    showNotice('');
    busy = true;
    try {
      const result = await send({
        type: 'chat-task',
        task
      });
      if (!result?.ok) throw new Error(result?.error || 'Задача не принята. Черновик сохранён.');
    } catch (e) {
      showNotice(e.message);
    } finally {
      busy = false;
    }
  }

  function intercept(event) {
    if (!enabled || picking || !event.isTrusted) return;
    const element = input();
    const click = event.type === 'click' && elements().send?.contains(event.target);
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
        approved: false
      });
      return;
    }
    if (message.type === 'chat-notice') {
      showNotice(message.text);
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

  async function pick() {
    if (picking) return;
    enabled = false;
    toggle.checked = false;
    picking = true;
    unmountView();
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
            const el = bindingTarget(e.target, key);
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
          if (!response || response === element || response === document.body || response === document.documentElement)
            throw new Error('Выберите текст и кнопку одного ответа.');
          result.response = bindingSelector(response, document, true);
        }
        result[key] = bindingSelector(element, key === 'complete' ? response : document);
      }
      await chrome.storage.local.set({
        'chat-bindings': result
      });
      config = result;
      showNotice('Привязка сохранена. Можно запускать агента.');
    } finally {
      hint.remove();
      picking = false;
      unmountView = view();
    }
  }
})();
