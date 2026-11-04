import {
  samplePageReadiness,
  waitForStablePage
} from './page-readiness.js';
import {
  assert,
  safeURL,
  timeout,
  sleep
} from './util.js';
/** Executed only in an isolated CDP world. References are invalidated by any DOM mutation. */
export function pageOperation(op, args) {
  const key = '__deepseekAgentDOM';
  let state = globalThis[key];
  if (!state) {
    state = globalThis[key] = {
      revision: 0,
      refs: {},
      token: null
    };
    for (const name of ['input', 'change', 'keydown']) document.addEventListener(name, () => state.revision++,
      true);
    new MutationObserver(records => {
      const ignored = 'head,script,style,nav,header,footer,aside,time,[role=navigation],[role=banner],[role=complementary],[data-ad],[data-ad-slot],.adsbygoogle';
      if (records.some(record => {
          const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
          return !target?.closest(ignored);
        })) state.revision++;
    }).observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true
    });
  }
  const visible = e => !!(e.getClientRects().length) && getComputedStyle(e).visibility !== 'hidden';
  const root = () => {
    const node = args.selector ? document.querySelector(args.selector) : document.querySelector('article,main,[role="main"]') || document.body;
    if (!node) throw new Error('Блок не найден: ' + args.selector);
    return node;
  };
  const cloneVisible = () => {
    const source = root(),
      copy = source.cloneNode(true);
    const originals = [...source.querySelectorAll('*')],
      clones = [...copy.querySelectorAll('*')];
    originals.forEach((node, i) => {
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') clones[i].remove();
    });
    return copy;
  };
  const text = () => {
    const c = cloneVisible();
    c.querySelectorAll('script,style,nav,header,footer,form,input,textarea,[contenteditable],aside')
      .forEach(x => x.remove());
    return c.textContent.replace(/\s+/g, ' ').trim();
  };
  if (op === 'exists') return {
    exists: !!document.querySelector(args.selector) && visible(document.querySelector(args.selector))
  };
  if (op === 'html') {
    const c = cloneVisible();
    const forbidden = 'script,style,iframe,object,embed,input,textarea,select,[contenteditable],[hidden],[aria-hidden="true"]';
    if (c.matches(forbidden)) throw new Error('Этот блок содержит скрытые данные или поля ввода');
    c.querySelectorAll(forbidden).forEach(e => e.remove());
    for (const e of [c, ...c.querySelectorAll('*')]) {
      for (const {
          name,
          value
        }
        of [...e.attributes]) {
        if (!/^(id|class|role|href|src|title|alt|datetime|colspan|rowspan|aria-label|aria-expanded|data-(id|name|author|date|rating|price))$/.test(name)) e.removeAttribute(name);
        else if (name === 'href' || name === 'src') {
          try {
            const u = new URL(value, location.href);
            if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || [...u.searchParams.keys(), ...new URLSearchParams(u.hash.slice(1)).keys()].some(k => /^(token|access_token|refresh_token|api[_-]?key|password|session(?:id)?|authorization)$/i.test(k))) e.removeAttribute(name);
          } catch {
            e.removeAttribute(name);
          }
        }
      }
    }
    const html = c.outerHTML;
    if (html.length > 2000000) throw new Error('HTML блока больше 2000000 символов: выбери более узкий selector');
    return {
      url: location.href,
      documentId: performance.timeOrigin,
      html
    };
  }
  if (op === 'select') {
    const nodes = [...document.querySelectorAll(args.selector)].filter(visible);
    if (nodes.length !== 1) throw new Error('Селектор должен найти ровно один видимый элемент; найдено: ' + nodes.length);
    state.token = crypto.randomUUID();
    state.at = state.revision;
    state.refs = {
      e0: nodes[0]
    };
    return {
      snapshot: state.token,
      element: 'e0'
    };
  }
  if (op === 'snapshot') {
    state.refs = {};
    state.token = crypto.randomUUID();
    state.at = state.revision;
    const all = [...root().querySelectorAll(
      'a[href],button,input:not([type=password]):not([type=hidden]),textarea,select,[role=button]')].filter(
      visible);
    const elements = all.slice(0, 80).map((e, i) => {
      const id = 'e' + i;
      state.refs[id] = e;
      return {
        id,
        tag: e.tagName.toLowerCase(),
        role: e.getAttribute('role'),
        label: (e.getAttribute('aria-label') || e.textContent || e.getAttribute('placeholder') || '')
          .trim().slice(0, 120),
        type: e.getAttribute('type')
      };
    });
    const full = text();
    return {
      url: location.href,
      documentId: performance.timeOrigin,
      title: document.title,
      snapshot: state.token,
      text: full.slice(0, 9000),
      textCharacters: full.length,
      truncated: full.length > 9000 || all.length > 80,
      elements,
      dom: [...root().querySelectorAll('*')].slice(0, 80).map(e => ({
        tag: e.tagName.toLowerCase(),
        id: e.id || undefined,
        class: typeof e.className === 'string' ? e.className.slice(0, 180) : undefined
      }))
    };
  }
  if (op === 'locate') {
    if (args.snapshot !== state.token || state.at !== state.revision) throw new Error(
      'Устаревший snapshot: запросите новый');
    const e = state.refs[args.element];
    if (!e?.isConnected || !visible(e)) throw new Error('Элемент исчез');
    if (e.matches('input[type=password],input[type=file],input[type=submit],input[type=image]'))
      throw new Error('Секретные поля и загрузка файлов запрещены');
    e.scrollIntoView({
      block: 'center'
    });
    const r = e.getBoundingClientRect();
    return {
      x: r.x + r.width / 2,
      y: r.y + r.height / 2,
      tag: e.tagName,
      type: e.getAttribute('type'),
      href: e.tagName === 'A' ? e.href : null,
      label: (e.textContent || e.getAttribute('aria-label') || '').slice(0, 120),
      navigation: e.tagName === 'A' && !!e.href && !e.hasAttribute('download') && !e.getAttribute('onclick') && !e.getAttribute('role'),
      search: e.matches('input[type=search],[role=searchbox]') ||
        e.tagName === 'INPUT' && /^(q|query|search)$|search|поиск/i.test([e.name, e.placeholder, e.getAttribute('aria-label')].join(' ')) ||
        !!e.closest('form[role=search],[role=search]'),
      disclosure: e.hasAttribute('aria-expanded') && !e.closest('form'),
      formMethod: (e.form || e.closest('form'))?.method || null
    };
  }
  if (op === 'scroll') {
    scrollBy(0, args.delta);
    state.token = null;
    return {
      scrolled: args.delta
    };
  }
  if (op === 'interact') {
    pageOperation('locate', args);
    const element = state.refs[args.element];
    state.token = null;
    if (args.action === 'click') element.click();
    else {
      if (!element.matches(
          'textarea,input:not([type]),input[type=text],input[type=search],input[type=email],input[type=url],input[type=tel]'
        )) throw new Error('Ввод только в текстовые поля');
      element.focus();
      const start = element.selectionStart ?? element.value.length;
      const end = element.selectionEnd ?? start;
      const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement
        .prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(element, args.replace ? args.text : element.value.slice(0, start) + args.text + element.value.slice(end));
      element.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        inputType: 'insertText',
        data: args.text
      }));
      element.dispatchEvent(new Event('change', {
        bubbles: true
      }));
    }
    return {
      performed: args.action,
      requiresSnapshot: true,
      transport: 'scripting'
    };
  }
  if (op === 'selectText') {
    const e = state.refs[args.element];
    if (!e?.isConnected || !e.matches('input,textarea')) throw new Error('Поле исчезло');
    e.select();
    return true;
  }
  if (op === 'invalidate') {
    state.token = null;
    return true;
  }
}
export class BrowserTools {
  constructor(state, save, approve) {
    this.state = state;
    this.save = save;
    this.approve = approve;
    this.attached = new Set();
    this.contexts = new Map();
    this.interrupted = false;
    this.generation = 0;
    chrome.debugger?.onDetach?.addListener((source, reason) => {
      if (this.attached.delete(source.tabId)) {
        this.contexts.delete(source.tabId);
        this.interrupted = true;
        this.cancel();
        this.onIntervention?.('Debugger отключён: ' + reason);
      }
    });
    chrome.tabs.onRemoved.addListener(id => {
      if (this.state.tabs.some(t => t.id === id)) {
        this.interrupted = true;
        this.cancel();
        this.onIntervention?.('Рабочая вкладка закрыта пользователем');
      }
    });
  }
  async check(id, state = this.state) {
    assert(id !== state.modelTabId, 'Вкладка DeepSeek исключена из рабочих вкладок');
    assert(state.tabs.some(t => t.id === id), 'Вкладка не принадлежит задаче');
    const ownership = await chrome.storage.session.get('owned-tab-' + id);
    assert(ownership['owned-tab-' + id] === state.id,
      'Вкладка не подтверждена в текущем сеансе браузера. Открой страницу заново через browser.open.');
    const t = await chrome.tabs.get(id);
    const fixture = url => url?.startsWith(chrome.runtime.getURL('fixtures/'));
    if ((!t.url || t.url === 'about:blank') && t.pendingUrl) {
      if (!fixture(t.pendingUrl)) safeURL(t.pendingUrl);
    } else if (!fixture(t.url)) safeURL(t.url);
    if (t.pendingUrl && !fixture(t.pendingUrl)) safeURL(t.pendingUrl);
    return t;
  }
  async recoverTabs() {
    const valid = [];
    for (const tab of this.state.tabs) {
      try {
        await this.check(tab.id);
        valid.push(tab);
      } catch {}
    }
    this.state.tabs = valid;
  }
  async adoptTabs(previous) {
    if (!previous?.id) return;
    for (const entry of previous.tabs || []) {
      if (entry.id === previous.modelTabId) continue;
      try {
        const ownership = await chrome.storage.session.get('owned-tab-' + entry.id);
        if (ownership['owned-tab-' + entry.id] !== previous.id) continue;
        const tab = await this.check(entry.id, previous);
        await chrome.storage.session.set({
          ['owned-tab-' + entry.id]: this.state.id
        });
        this.state.tabs.push({
          id: entry.id,
          url: tab.pendingUrl || tab.url
        });
      } catch {}
    }
    this.state.workTabId = this.state.tabs.find(t => t.id === previous.workTabId)?.id || this.state.tabs.at(-1)?.id;
  }
  async attach(id) {
    await this.check(id);
    if (this.attached.has(id)) return;
    assert(chrome.debugger?.attach,
      'Этот браузер не поддерживает CDP. Включите совместимый режим в настройках.');
    await chrome.debugger.attach({
      tabId: id
    }, '1.3');
    this.attached.add(id);
    await this.send(id, 'Page.enable');
  }
  async send(id, method, params = {}) {
    return timeout(chrome.debugger.sendCommand({
      tabId: id
    }, method, params), 20000, 'CDP ' + method);
  }
  useScripting() {
    return this.transport === 'scripting' || this.transport !== 'cdp' && this.autoFallback || !chrome.debugger?.attach;
  }
  reset() {
    this.generation++;
    this.interrupted = false;
  }
  cancel() {
    this.generation++;
  }
  async waitForPage(id, options = {}) {
    const generation = this.generation;
    return waitForStablePage(async () => {
      const sample = await this.runOnce(id, 'readiness');
      const nav = this.state.tabs.find(t => t.id === id)?.navigation;
      const oldDocument = nav && (nav.fromDocumentId != null ? nav.fromDocumentId === sample.documentId : nav.fromURL === sample.url);
      if (nav && nav.phase !== 'observed' && oldDocument && sample.url !== nav.url) {
        return {
          ...sample,
          domReady: false,
          contentPresent: false,
          navigationPending: true
        };
      }
      return sample;
    }, {
      ...options,
      cancelled: () => generation !== this.generation || this.interrupted
    });
  }
  async run(id, op, args = {}) {
    const generation = this.generation;
    const reading = ['snapshot', 'html'].includes(op);
    const readiness = reading ? await this.waitForPage(id) : null;
    for (let attempt = 0;; attempt++) {
      if (generation !== this.generation) throw new Error('Действие остановлено');
      try {
        const data = await this.runOnce(id, op, args);
        if (op === 'snapshot')
          for (const element of data.elements) element.ref = `r${id}_${data.snapshot}_${element.id}`;
        if (generation !== this.generation && !reading) throw new Error('Действие остановлено');
        if (reading) {
          if (readiness.url !== data.url || data.documentId && readiness.documentId !== data.documentId) {
            readiness.ready = false;
            readiness.reason = 'navigation_changed';
          }
          return {
            ...data,
            readiness
          };
        }
        if (op === 'scroll') return {
          ...data,
          readiness: await this.waitForPage(id)
        };
        return data;
      } catch (e) {
        if (generation !== this.generation || attempt >= 1 ||
          !['snapshot', 'html', 'locate'].includes(op) || this.interrupted) throw e;
        await sleep(200);
      }
    }
  }
  async runOnce(id, op, args = {}) {
    const operation = op === 'readiness' ? samplePageReadiness : pageOperation;
    if (this.useScripting()) {
      await this.check(id);
      const [result] = await timeout(chrome.scripting.executeScript({
        target: {
          tabId: id
        },
        func: operation,
        args: [op, args]
      }), 20000, 'Инструмент страницы');
      assert(result, 'Страница недоступна. Разрешите доступ к сайтам в настройках.');
      return result.result;
    }
    try {
      await this.attach(id);
    } catch (e) {
      if (this.transport !== 'cdp' && !this.interrupted && chrome.scripting?.executeScript) {
        this.autoFallback = true;
        let granted = false;
        try {
          granted = await chrome.permissions?.contains({
            origins: ['http://*/*', 'https://*/*']
          });
        } catch {}
        await chrome.storage.local.set({
          'browser-auto-fallback': true,
          'needs-site-access': !granted
        });
        return this.runOnce(id, op, args);
      }
      throw e;
    }
    await this.check(id);
    const {
      frameTree
    } = await this.send(id, 'Page.getFrameTree');
    const {
      executionContextId
    } = await this.send(id, 'Page.createIsolatedWorld', {
      frameId: frameTree.frame.id,
      worldName: 'deepseek-agent',
      grantUniveralAccess: false
    });
    const r = await this.send(id, 'Runtime.evaluate', {
      expression: `(${operation.toString()})(${JSON.stringify(op)},${JSON.stringify(args)})`,
      contextId: executionContextId,
      returnByValue: true
    });
    assert(!r.exceptionDetails, r.exceptionDetails?.exception?.description || 'Ошибка DOM');
    return r.result.value;
  }
  async open(url, {
    fixture = false,
    commandId,
    newTab = false
  } = {}) {
    const generation = this.generation;
    const active = () => {
      if (generation !== this.generation || this.interrupted) {
        const error = new Error('Открытие страницы остановлено');
        error.definite = true;
        throw error;
      }
    };
    url = fixture ? new URL(url).href : safeURL(url);
    await this.recoverTabs();
    active();
    if (!newTab && this.state.tabs.length) {
      let entry = this.state.tabs.find(t => t.id === this.state.workTabId) || this.state.tabs.at(-1);
      for (const candidate of this.state.tabs) {
        const current = await this.check(candidate.id);
        if ((current.pendingUrl || current.url) === url) {
          entry = candidate;
          break;
        }
      }
      const tab = await this.check(entry.id);
      active();
      const current = tab.pendingUrl || tab.url;
      entry.commandId = commandId;
      this.state.workTabId = entry.id;
      if (current === url) {
        if (!tab.pendingUrl || entry.navigation?.url !== url) entry.navigation = {
          commandId,
          url,
          phase: 'observed'
        };
        else entry.navigation.commandId = commandId;
        await this.save();
        return {
          tabId: entry.id,
          url,
          requestedURL: url,
          reused: true,
          navigated: false
        };
      }
      let before = null;
      try {
        before = await this.runOnce(entry.id, 'readiness');
      } catch {}
      entry.navigation = {
        commandId,
        url,
        fromURL: tab.url,
        fromDocumentId: before?.documentId,
        phase: 'prepared'
      };
      await this.save();
      entry.navigation.phase = 'dispatching';
      await this.save(); // Persist before navigating; never replay an uncertain navigation.
      active();
      await chrome.tabs.update(entry.id, {
        url
      });
      entry.url = url;
      entry.navigation.phase = 'dispatched';
      await this.save();
      return {
        tabId: entry.id,
        url,
        requestedURL: url,
        reused: true,
        navigated: true
      };
    }
    if (this.state.tabs.length >= 5) {
      const error = new Error('Уже открыты пять рабочих вкладок. Используй browser.open с new_tab=False.');
      error.definite = true;
      throw error;
    }
    active();
    const tab = await chrome.tabs.create({
      url,
      active: false
    });
    await chrome.storage.session.set({
      ['owned-tab-' + tab.id]: this.state.id
    });
    this.state.tabs.push({
      id: tab.id,
      url,
      commandId
    });
    this.state.workTabId = tab.id;
    await this.save();
    return {
      tabId: tab.id,
      url: tab.pendingUrl || tab.url || url,
      requestedURL: url,
      reused: false,
      navigated: true
    };
  }
  resolveReference(args) {
    const match = args.ref?.match(/^r([0-9]+)_([a-f0-9-]{36})_(e[0-9]+)$/);
    if (!match) {
      const error = new Error('Устаревший ref: запросите browser.read');
      error.definite = true;
      throw error;
    }
    return {
      tabId: Number(match[1]),
      snapshot: match[2],
      element: match[3],
      ...(args.text === undefined ? {} : {
        text: args.text
      })
    };
  }
  async execute(tool, a, context = {}) {
    if (a.ref) a = this.resolveReference(a);
    const op = tool.split('.')[1];
    if (op === 'click' || op === 'type') {
      let info;
      try {
        info = await this.run(a.tabId, 'locate', a);
      } catch (e) {
        e.definite = true;
        throw e;
      }
      try {
        if (op === 'type') assert(['INPUT', 'TEXTAREA'].includes(info.tag) && (!info.type || ['text',
          'search', 'email', 'url', 'tel'
        ].includes(info.type)), 'Ввод разрешён только в текстовые поля');
      } catch (e) {
        e.definite = true;
        throw e;
      }
      // Read-only navigation/search controls run without approval dialogs.
      // Arbitrary site mutations are unavailable, rather than delegated to untrusted page text.
      const fixture = (await this.check(a.tabId)).url.startsWith(chrome.runtime.getURL('fixtures/'));
      const allowed = fixture || (op === 'type' ? info.search && info.formMethod !== 'post' :
        info.navigation || info.disclosure || info.search && info.formMethod !== 'post');
      if (!allowed) {
        const error = new Error('Это действие может изменить данные сайта. Используй чтение страницы, публичную ссылку или поиск.');
        error.definite = true;
        throw error;
      }
      try {
        if (info.href && !fixture) safeURL(info.href);
        info = await this.run(a.tabId, 'locate', a);
      } catch (e) {
        e.definite = true;
        throw e;
      }
      if (this.useScripting()) {
        const result = await this.run(a.tabId, 'interact', {
          ...a,
          action: op
        });
        return {
          ...result,
          readiness: await this.waitForPage(a.tabId)
        };
      }
      await this.send(a.tabId, 'Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: info.x,
        y: info.y,
        button: 'left',
        clickCount: 1
      });
      await this.send(a.tabId, 'Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: info.x,
        y: info.y,
        button: 'left',
        clickCount: 1
      });
      if (op === 'type') {
        assert(['INPUT', 'TEXTAREA'].includes(info.tag), 'Ввод только в текстовые поля');
        if (a.replace) await this.runOnce(a.tabId, 'selectText', a);
        await this.send(a.tabId, 'Input.insertText', {
          text: a.text
        });
      }
      await this.run(a.tabId, 'invalidate').catch(() => {});
      return {
        performed: op,
        requiresSnapshot: true,
        readiness: await this.waitForPage(a.tabId)
      };
    }
    return this.run(a.tabId, op, a);
  }
  /** Private Python bridge; a method call never grants ownership of another tab. */
  async pythonCall(method, args, context = {}) {
    assert(args && typeof args === 'object' && !Array.isArray(args), 'Неверные аргументы браузера');
    const shapes = {
      open: ['url', 'new_tab'],
      read: ['selector', 'tab_id'],
      html: ['selector', 'tab_id'],
      click: ['selector', 'ref', 'tab_id'],
      type: ['text', 'selector', 'ref', 'tab_id'],
      scroll: ['delta', 'tab_id'],
      wait: ['selector', 'timeout', 'tab_id']
    };
    assert(Object.hasOwn(shapes, method) && Object.keys(args).every(k => shapes[method].includes(k)), 'Неизвестный метод или аргументы браузера');
    if (method === 'open') {
      assert(typeof args.url === 'string' && args.url.length <= 2000 && typeof args.new_tab === 'boolean', 'Неверный URL или new_tab');
      const opened = await this.open(args.url, {
        ...context,
        newTab: args.new_tab,
        fixture: args.url.startsWith(chrome.runtime.getURL('fixtures/'))
      });
      return {
        tab_id: opened.tabId,
        url: opened.url,
        reused: opened.reused,
        readiness: await this.waitForPage(opened.tabId)
      };
    }
    const tabId = args.tab_id ?? this.state.workTabId;
    assert(Number.isInteger(tabId), 'Сначала открой страницу через browser.open');
    await this.check(tabId);
    const selector = args.selector;
    if (selector != null) assert(typeof selector === 'string' && selector.length > 0 && selector.length <= 1000, 'Неверный selector');
    if (method === 'read') return this.run(tabId, 'snapshot', {
      selector: selector || 'body'
    });
    if (method === 'html') {
      const page = await this.run(tabId, 'html', {
        selector: selector || 'body'
      });
      assert(page.readiness.ready, 'Страница ещё нестабильна: дождись browser.wait или повтори чтение; HTML не передан как полный');
      return page.html;
    }
    if (method === 'wait') {
      assert(selector && Number.isFinite(args.timeout) && args.timeout > 0 && args.timeout <= 120, 'Нужны selector и timeout от 0 до 120 секунд');
      const generation = this.generation,
        until = Date.now() + args.timeout * 1000;
      while (Date.now() < until) {
        assert(generation === this.generation && !this.interrupted, 'Ожидание остановлено');
        if ((await this.runOnce(tabId, 'exists', {
            selector
          })).exists) return {
          found: true,
          selector
        };
        await sleep(200);
      }
      throw new Error('Элемент не появился за ' + args.timeout + ' с: ' + selector);
    }
    if (method === 'scroll') {
      assert(Number.isFinite(args.delta) && Math.abs(args.delta) <= 100000, 'Неверная величина прокрутки');
      return this.run(tabId, 'scroll', {
        delta: args.delta
      });
    }
    assert(!!selector !== !!args.ref, 'Нужен либо selector, либо ref');
    let target;
    if (args.ref) {
      target = this.resolveReference({
        ref: args.ref
      });
      assert(args.tab_id == null || target.tabId === tabId, 'ref относится к другой вкладке');
      await this.check(target.tabId);
    } else target = {
      tabId,
      ...await this.runOnce(tabId, 'select', {
        selector
      })
    };
    if (method === 'type') {
      assert(typeof args.text === 'string' && args.text.length <= 50000, 'Неверный текст');
      target.text = args.text;
      target.replace = true;
    }
    return this.execute('browser.' + method, target, context);
  }
  async detach() {
    for (const id of this.attached) {
      this.attached.delete(id);
      await chrome.debugger.detach({
        tabId: id
      }).catch(() => {});
    }
    this.contexts.clear();
  }
}
