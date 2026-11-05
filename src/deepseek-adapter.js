import {
  conversationURL
} from './chat-sessions.js';
import {
  assert,
  sleep,
  timeout
} from './util.js';
import {
  deepseekDOM
} from './chat-dom.js';
export {
  deepseekDOM
}
from './chat-dom.js';
export class DeepSeekAdapter {
  constructor(store) {
    this.store = store;
    this.abort = false;
    this.waitMs = 180000;
    this.idleMs = 45000;
    this.pollMs = 750;
    this.nudgeMs = 8000;
  }
  async connect(tabId, config = {}) {
    const tab = await chrome.tabs.get(tabId);
    assert(new URL(tab.url).origin === 'https://chat.deepseek.com',
      'Нужна отдельная вкладка chat.deepseek.com');
    config ||= {};
    this.tabId = tabId;
    this.conversation = conversationURL(tab.url);
    this.submitted = false;
    this.config = config;
    await this.store.put('deepseek', {
      tabId,
      config
    });
    await chrome.storage.session.set({
      ['deepseek-bound-tab:' + this.store.chatId]: tabId
    });
    return this.inspect();
  }
  async restore() {
    const x = await this.store.get('deepseek');
    if (x) {
      this.config = (await chrome.storage.local.get('chat-bindings'))['chat-bindings'] || x.config || {};
      const bound = await chrome.storage.session.get('deepseek-bound-tab:' + this.store.chatId);
      if (bound['deepseek-bound-tab:' + this.store.chatId] === x.tabId) this.tabId = x.tabId;
    }
  }
  async dom(action, payload) {
    assert(this.tabId && this.config, 'Подключите DeepSeek');
    const tab = await chrome.tabs.get(this.tabId);
    assert(new URL(tab.url).origin === 'https://chat.deepseek.com', 'Вкладка модели сменила адрес');
    const current = conversationURL(tab.url);
    assert(!this.conversation || this.conversation === current, 'Вкладка перешла в другой диалог');
    assert(this.conversation || !current || this.submitted || !['send', 'submit'].includes(action), 'Диалог сменился до отправки задачи');
    const [r] = await timeout(chrome.scripting.executeScript({
      target: {
        tabId: this.tabId
      },
      func: deepseekDOM,
      args: [action, this.config, payload ?? null]
    }), 15000, 'DeepSeek DOM');
    if (action === 'submit' && r.result?.attempted !== false) this.submitted = true;
    return r.result;
  }
  async conversationURL() {
    return (await chrome.tabs.get(this.tabId)).url;
  }
  async inspect() {
    for (let attempt = 0;; attempt++) {
      try {
        return await this.dom('inspect');
      } catch (e) {
        if (attempt >= 1 || this.abort) throw e;
        await sleep(200);
      }
    }
  }
  async exchange(prompt, journal) {
    this.abort = false;
    const before = {
      ...await this.inspect(),
      deadline: Date.now() + this.waitMs
    };
    await this.onStatus?.('sending', {
      elapsed: 0
    });
    assert(before.status === 'ready', before.reason || 'Чат не готов');
    await journal({
      phase: 'prepared',
      prompt,
      before: {
        count: before.count,
        answer: before.answer,
        userCount: before.userCount,
        deadline: before.deadline
      }
    });
    assert(!this.abort, 'Отправка отменена');
    await this.dom('send', prompt);
    await sleep(200);
    await this.submitPrepared(prompt, before, journal);
    await this.onStatus?.('waiting-response', {
      elapsed: 0
    });
    return this.waitAnswer({
      ...before,
      sentPrompt: prompt
    });
  }
  reset() {
    this.abort = false;
  }
  async submitPrepared(prompt, before, journal) {
    await journal({
      phase: 'inserted',
      prompt,
      before: {
        count: before.count,
        answer: before.answer,
        userCount: before.userCount,
        deadline: before.deadline
      }
    });
    for (let attempt = 0; attempt < 10; attempt++) {
      assert(!this.abort, 'Отправка отменена');
      const state = await this.inspect();
      assert(state.status === 'ready', state.reason || 'Чат не готов к отправке');
      if (state.sendEnabled !== false) break;
      await sleep(150);
    }
    assert(!this.abort, 'Отправка отменена');
    const ready = await this.inspect();
    assert(ready.status === 'ready' && ready.sendEnabled !== false, 'Чат пока не разрешил отправку. Запрос сохранён и ещё не отправлен.');
    const delivery = await this.dom('delivery', prompt);
    assert(delivery.draft === 'exact', 'Поле DeepSeek изменило текст запроса. Полный запрос сохранён и не отправлен.');
    // Only this durable phase means a click may have happened.
    await journal({
      phase: 'send-uncertain',
      prompt,
      before: {
        count: before.count,
        answer: before.answer,
        userCount: before.userCount,
        deadline: before.deadline
      }
    });
    assert(!this.abort, 'Отправка отменена');
    const submitted = await this.dom('submit');
    if (submitted?.attempted === false) {
      await journal({
        phase: 'inserted',
        prompt,
        before: {
          count: before.count,
          answer: before.answer,
          userCount: before.userCount,
          deadline: before.deadline
        }
      });
      throw new Error(submitted.reason);
    }
  }
  async recoverExchange(outbound, journal) {
    assert(!this.abort, 'Ожидание остановлено');
    const state = await this.inspect();
    assert(['ready', 'generating'].includes(state.status), state.reason || 'Веб-чат пока недоступен');
    const delivery = await this.dom('delivery', outbound.prompt);
    if (outbound.phase === 'send-uncertain') {
      assert(delivery.posted && delivery.latest,
        'Ответ DeepSeek пока не подтверждён. Можно позже написать «продолжай» или отправить новую задачу.');
      // Read the already sent exchange, never click Send again.
      return this.waitAnswer({
        ...outbound.before,
        sentPrompt: outbound.prompt
      });
    }
    assert(['prepared', 'inserted'].includes(outbound.phase), 'Неизвестное состояние отправки');
    if (delivery.posted && delivery.latest && (outbound.before.userCount === undefined ||
        delivery.userCount > outbound.before.userCount || state.status === 'generating' ||
        state.answer !== outbound.before.answer)) {
      return this.waitAnswer({
        ...outbound.before,
        sentPrompt: outbound.prompt
      });
    }
    assert(state.status === 'ready' && delivery.draft !== 'other',
      'В поле чата другой текст. Отправь его как новую задачу, когда чат будет готов.');
    if (delivery.draft === 'empty') await this.dom('send', outbound.prompt);
    await this.submitPrepared(outbound.prompt, outbound.before, journal);
    return this.waitAnswer({
      ...outbound.before,
      sentPrompt: outbound.prompt
    });
  }
  async waitAnswer(before) {
    let stable = 0,
      last = '',
      lastChange = Date.now(),
      lastNudge = Date.now(),
      nudged = false;
    const started = Date.now(),
      deadline = before.deadline || started + this.waitMs;
    while (Date.now() < deadline) {
      assert(!this.abort, 'Ожидание прервано');
      const s = await this.inspect();
      if (['login-required', 'service-error', 'user-required'].includes(s.status)) throw new Error(s.reason || s.status);
      // DeepSeek virtualizes messages: mounted count alone does not identify a new reply.
      const changed = s.answer && (s.count > before.count || s.answer !== before.answer) &&
        s.answer.trim() !== before.sentPrompt?.trim();
      if (s.status === 'generating' || changed && s.answer !== last) lastChange = Date.now();
      stable = changed && s.answer === last ? stable + 1 : 0;
      last = s.answer;
      await this.onStatus?.(s.status === 'generating' ? 'generating' : changed && s.completion ? 'reading-response' : 'waiting-response', {
        elapsed: Math.floor((Date.now() - started) / 1000)
      });
      // Stability supplements the actual toolbar and known composer state.
      if (changed && s.completion && !s.stop && s.status === 'ready' && stable >= 2) {
        await this.onStatus?.('completed', {
          elapsed: Math.floor((Date.now() - started) / 1000)
        });
        this.lastReply = {
          messageKey: s.messageKey || null
        };
        return s.answer;
      }
      // A virtualized latest reply may be outside the mounted DOM. Reveal it, never resend.
      if (!nudged && s.status === 'ready' && Date.now() - lastChange >= this.nudgeMs && Date.now() - lastNudge >= this.nudgeMs) {
        const reveal = await this.dom('reveal-latest');
        nudged = reveal?.reason !== 'reading-history';
        lastNudge = Date.now();
      }
      if (s.status === 'ready' && Date.now() - lastChange >= this.idleMs) {
        const error = new Error('DeepSeek не показывает новый завершённый ответ. Запрос сохранён; повторной отправки не было.');
        error.code = 'RESPONSE_IDLE';
        throw error;
      }
      await sleep(Math.min(this.pollMs, Math.max(0, deadline - Date.now())));
    }
    const error = new Error('DeepSeek пока не завершил ответ. Запрос сохранён; повторной отправки не было.');
    error.code = 'RESPONSE_TIMEOUT';
    throw error;
  }
  cancel() {
    this.abort = true;
  }
}
