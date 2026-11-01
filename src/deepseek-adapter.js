import {
  assert,
  sleep,
  timeout
} from './util.js';
/** Automatic semantic discovery; explicit selectors remain an optional developer override. */
export function deepseekDOM(action, config, payload) {
  config ||= {};
  const automatic = !config.input;
  const visible = e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
  const label = e => [e.getAttribute('aria-label'), e.getAttribute('title'), e.textContent].filter(Boolean)
    .join(' ').trim();
  const all = (selector, root = document) => [...root.querySelectorAll(selector)].filter(visible);
  const unique = nodes => nodes.length === 1 ? nodes[0] : null;
  const buttons = all('button,[role="button"]');
  const named = re => buttons.filter(e => re.test(label(e)));
  // These are semantic conventions, not claims about the current DeepSeek DOM.
  const assistantNodes = () => all(
    '[data-message-author-role="assistant"],[data-role="assistant"],[data-author="assistant"]').filter(e =>
    !e.parentElement.closest(
      '[data-message-author-role="assistant"],[data-role="assistant"],[data-author="assistant"]'));
  const composer = unique(all('textarea,[contenteditable="true"][role="textbox"]'));
  const alerts = all('[role="alert"],[role="dialog"],[aria-live="assertive"]');
  const notice = re => alerts.find(e => re.test(label(e)));
  const detected = {
    input: composer,
    send: unique(named(/^(send|send message|отправить|отправить сообщение|发送)(\s|$)/i)),
    stop: unique(named(/stop (generating|generation|response)|остановить|停止生成/i)),
    login: !composer && (unique(named(/^(log in|sign in|войти|登录)$/i)) || document.querySelector(
      'input[type="password"]')),
    challenge: notice(/captcha|verify.*human|провер.*человек|подтверд.*человек|人机验证/i) || all(
      'iframe[title]').find(e => /captcha|challenge|verification/i.test(e.title)),
    error: notice(
      /rate limit|too many requests|try again later|service unavailable|слишком много|лимит|попробуйте позже|服务繁忙/i
      )
  };
  const one = k => {
    if (automatic) return detected[k] || null;
    if (!config[k]) return detected[k] || null;
    const nodes = [...document.querySelectorAll(config[k])].filter(e => e.getClientRects().length);
    return nodes.at(-1) || null;
  };
  const responses = () => (automatic ? assistantNodes() : config.response ? [...document.querySelectorAll(
    config.response)] : []).map(e => {
    const c = e.cloneNode(true);
    if (config.complete) c.querySelectorAll(config.complete).forEach(x => x.remove());
    c.querySelectorAll('button').forEach(x => x.remove());
    return c.textContent.trim();
  });
  const inspect = () => {
    const error = one('error'),
      login = one('login'),
      challenge = one('challenge'),
      stop = one('stop'),
      send = one('send'),
      input = one('input');
    const answers = responses();
    const last = answers.at(-1) || '';
    const responseNodes = automatic ? assistantNodes() : config.response ? [...document.querySelectorAll(
      config.response)] : [];
    const latest = responseNodes.at(-1);
    const complete = automatic ? latest && all('button,[role=button]', latest).find(e =>
        /copy|копировать|复制|regenerate|повторить ответ/i.test(label(e))) : latest && config.complete ?
      latest.querySelector(config.complete) : null;
    let status = challenge ? 'user-required' : login ? 'login-required' : error ? 'service-error' : stop ?
      'generating' : input && send && !input.disabled ? 'ready' : 'user-required';
    return {
      status,
      answer: last,
      count: answers.length,
      completion: !!complete && !!complete.getClientRects().length,
      stop: !!stop,
      input: !!input,
      send: !!send,
      reason: challenge ? 'CAPTCHA или участие пользователя' : login ? 'Требуется вход' : error ?
        'Ошибка/ограничение сервиса' : status === 'user-required' ?
        'Не удалось уверенно распознать чат. Откройте вкладку DeepSeek, проверьте вход и доступность чата, затем подключите снова.' :
        '',
      diagnostic: {
        inputCount: config.input ? document.querySelectorAll(config.input).length : 0,
        responseCount: answers.length,
        sendCount: config.send ? document.querySelectorAll(config.send).length : 0
      }
    };
  };
  if (action === 'inspect') return inspect();
  if (action === 'clear-task') {
    const input = one('input');
    const current = input?.value ?? input?.innerText;
    if (!input || current !== payload) throw new Error('Черновик изменился. Отправьте задачу снова.');
    if (input.isContentEditable) input.textContent = '';
    else Object.getOwnPropertyDescriptor(input instanceof HTMLTextAreaElement ? HTMLTextAreaElement
      .prototype : HTMLInputElement.prototype, 'value').set.call(input, '');
    input.dispatchEvent(new Event('input', {
      bubbles: true
    }));
    return {
      cleared: true
    };
  }
  if (action === 'send') {
    const before = inspect();
    if (before.status !== 'ready') throw new Error(before.reason || 'Чат не готов');
    const input = one('input');
    if (input.value?.trim() || input.isContentEditable && input.innerText.trim()) throw new Error(
      'В поле уже есть текст пользователя');
    if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) {
      const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement
        .prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, payload);
      input.dispatchEvent(new Event('input', {
        bubbles: true
      }));
    } else if (input.isContentEditable) {
      input.textContent = payload;
      input.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        inputType: 'insertText',
        data: payload
      }));
    } else throw new Error('Неподдерживаемое поле');
    return {
      ...before,
      inserted: true
    };
  }
  if (action === 'submit') {
    const send = one('send');
    if (!send || send.disabled) throw new Error('Кнопка отправки недоступна');
    send.click();
    return {
      attempted: true
    };
  }
}
export class DeepSeekAdapter {
  constructor(store) {
    this.store = store;
    this.abort = false;
  }
  async connect(tabId, config = {}) {
    const tab = await chrome.tabs.get(tabId);
    assert(new URL(tab.url).origin === 'https://chat.deepseek.com',
      'Нужна отдельная вкладка chat.deepseek.com');
    config ||= {};
    this.tabId = tabId;
    this.config = config;
    await this.store.put('deepseek', {
      tabId,
      config
    });
    await chrome.storage.session.set({
      'deepseek-bound-tab': tabId
    });
    return this.inspect();
  }
  async restore() {
    const x = await this.store.get('deepseek');
    if (x) {
      this.config = {}; // Migrate old installations to automatic discovery.
      const bound = await chrome.storage.session.get('deepseek-bound-tab');
      if (bound['deepseek-bound-tab'] === x.tabId) this.tabId = x.tabId;
    }
  }
  async dom(action, payload) {
    assert(this.tabId && this.config, 'Подключите DeepSeek');
    const tab = await chrome.tabs.get(this.tabId);
    assert(new URL(tab.url).origin === 'https://chat.deepseek.com', 'Вкладка модели сменила адрес');
    const [r] = await timeout(chrome.scripting.executeScript({
      target: {
        tabId: this.tabId
      },
      func: deepseekDOM,
      args: [action, this.config, payload ?? null]
    }), 15000, 'DeepSeek DOM');
    return r.result;
  }
  inspect() {
    return this.dom('inspect');
  }
  async exchange(prompt, journal) {
    this.abort = false;
    assert(prompt.length <= 45000, 'Бюджет одного сообщения: 45000 символов');
    const before = await this.inspect();
    assert(before.status === 'ready', before.reason || 'Чат не готов');
    await journal({
      phase: 'prepared',
      prompt,
      before: {
        count: before.count,
        answer: before.answer
      }
    });
    assert(!this.abort, 'Отправка отменена');
    await this.dom('send', prompt);
    await sleep(200);
    // Persist BEFORE clicking: on any uncertain outcome never send again automatically.
    await journal({
      phase: 'send-uncertain',
      prompt,
      before: {
        count: before.count,
        answer: before.answer
      }
    });
    assert(!this.abort, 'Отправка отменена до нажатия кнопки');
    await this.dom('submit');
    this.onStatus?.('waiting-response');
    return this.waitAnswer({
      ...before,
      sentPrompt: prompt
    });
  }
  async waitAnswer(before) {
    let seenGeneration = false,
      stable = 0,
      last = '',
      started = Date.now();
    while (Date.now() - started < 180000) {
      assert(!this.abort, 'Ожидание прервано');
      const s = await this.inspect();
      this.onStatus?.(s.status);
      if (['login-required', 'service-error', 'user-required'].includes(s.status)) throw new Error(s
        .reason || s.status);
      if (s.status === 'generating') seenGeneration = true;
      const changed = s.count > before.count && s.answer && s.answer.trim() !== before.sentPrompt?.trim();
      stable = changed && s.answer === last ? stable + 1 : 0;
      last = s.answer;
      // Stability is supplementary; a completion marker, absent stop, and enabled composer are mandatory.
      if (changed && s.completion && !s.stop && s.status === 'ready' && stable >= 2) {
        this.onStatus?.('completed');
        return s.answer;
      }
      await sleep(750);
    }
    throw new Error('DeepSeek: таймаут; проверьте чат, повторная отправка заблокирована');
  }
  cancel() {
    this.abort = true;
  }
}
