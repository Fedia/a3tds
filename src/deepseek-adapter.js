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
      this.config = (await chrome.storage.local.get('chat-bindings'))['chat-bindings'] || x.config || {};
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
