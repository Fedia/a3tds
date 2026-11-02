import {
  domCollectionOperation,
  validateExtractionPlan
} from './dom-collector.js';
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
  const key = '__psyAgentDOM';
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
  const text = () => {
    const c = (document.querySelector('article,main,[role="main"]') || document.body).cloneNode(true);
    c.querySelectorAll('script,style,nav,header,footer,form,input,textarea,[contenteditable],aside')
      .forEach(x => x.remove());
    return c.textContent.replace(/\s+/g, ' ').trim();
  };
  if (op === 'snapshot') {
    state.refs = {};
    state.token = crypto.randomUUID();
    state.at = state.revision;
    const all = [...document.querySelectorAll(
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
      elements
    };
  }
  if (op === 'extract') {
    let data;
    let truncated = false;
    let limits = null;
    if (args.kind === 'text') data = text();
    if (args.kind === 'links') {
      const all = [...document.querySelectorAll('a[href]')];
      truncated = all.length > 500 || all.some(e => e.textContent.trim().length > 200);
      limits = {
        totalLinks: all.length,
        maxLinks: 500,
        labelCharacters: 200
      };
      data = all.slice(0, 500).map(e => ({
        text: e.textContent.trim().slice(0, 200),
        url: e.href
      }));
    }
    if (args.kind === 'tables') {
      const all = [...document.querySelectorAll('table')];
      truncated = all.length > 30 || all.some(t => t.rows.length > 300 || [...t.rows].some(r => r.cells
        .length > 40));
      limits = {
        totalTables: all.length,
        maxTables: 30,
        maxRows: 300,
        maxColumns: 40
      };
      data = [...document.querySelectorAll('table')].slice(0, 30).map(t => [...t.rows].slice(0, 300).map(
        r => [...r.cells].slice(0, 40).map(c => c.textContent.trim())));
    }
    const raw = JSON.stringify(data);
    if (raw.length > 300000) throw new Error(
      'Извлечение превышает 300000 символов; требуется более узкий источник');
    return {
      url: location.href,
      documentId: performance.timeOrigin,
      title: document.title,
      method: 'dom-main-text-v1',
      kind: args.kind,
      data,
      truncated,
      limits,
      collectedAt: new Date().toISOString()
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
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(element, element.value.slice(0, start) + args
        .text + element.value.slice(end));
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
  async check(id) {
    assert(this.state.tabs.some(t => t.id === id), 'Вкладка не принадлежит задаче');
    const ownership = await chrome.storage.session.get('owned-tab-' + id);
    assert(ownership['owned-tab-' + id] === this.state.id,
      'Вкладка не подтверждена в текущем сеансе браузера. Сбросьте старые вкладки и откройте новые.');
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
    return this.transport === 'scripting' || !chrome.debugger?.attach;
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
    return waitForStablePage(() => this.runOnce(id, 'readiness'), {
      ...options,
      cancelled: () => generation !== this.generation || this.interrupted
    });
  }
  async run(id, op, args = {}) {
    const generation = this.generation;
    const reading = ['snapshot', 'extract', 'inspect', 'collect'].includes(op);
    const readiness = reading ? await this.waitForPage(id) : null;
    for (let attempt = 0;; attempt++) {
      if (generation !== this.generation) throw new Error('Действие остановлено');
      try {
        const data = await this.runOnce(id, op, args);
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
          !['snapshot', 'extract', 'inspect', 'collect', 'locate'].includes(op) || this.interrupted) throw e;
        await sleep(200);
      }
    }
  }
  async runOnce(id, op, args = {}) {
    const operation = op === 'readiness' ? samplePageReadiness : ['inspect', 'collect'].includes(op) ? domCollectionOperation : pageOperation;
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
    await this.attach(id);
    await this.check(id);
    const {
      frameTree
    } = await this.send(id, 'Page.getFrameTree');
    const {
      executionContextId
    } = await this.send(id, 'Page.createIsolatedWorld', {
      frameId: frameTree.frame.id,
      worldName: 'psy-agent',
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
    commandId
  } = {}) {
    assert(this.state.tabs.length < 5, 'Лимит пяти рабочих страниц');
    if (!fixture) {
      safeURL(url);

    }
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
    await this.save();
    return {
      tabId: tab.id,
      url: tab.pendingUrl || tab.url || url
    };

  }
  async execute(tool, a, context = {}) {
    const op = tool.split('.')[1];
    if (op === 'collect') validateExtractionPlan(a.plan);
    if (op === 'open') {
      const opened = await this.open(a.url, context);
      try {
        const page = await this.run(opened.tabId, 'snapshot');
        return {
          ...opened,
          url: page.url || opened.url,
          page
        };
      } catch (e) {
        // Navigation succeeded: report failed reading separately, never reopen blindly.
        return {
          ...opened,
          page: null,
          readError: {
            code: 'SNAPSHOT_FAILED',
            message: e.message
          },
          next: 'Вкладка открыта, но текст не прочитан. Используй browser.snapshot или browser.extract.'
        };
      }
    }
    if (op === 'click' || op === 'type') {
      if (this.state.blockedInteractions?.includes(a.tabId)) {
        const error = new Error('Исход предыдущего взаимодействия не подтверждён. Эта вкладка доступна для чтения; используй чтение или открой другую.');
        error.definite = true;
        throw error;
      }
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
