import {
  deepseekDOM
} from './chat-dom.js';

/** Canonical conversation identity; draft chats get independent temporary identities. */
export function conversationURL(value) {
  const url = new URL(value);
  const path = url.pathname.replace(/\/+$/, '');
  return !path || path === '/a/chat' ? null : url.origin + path;
}

export class ChatSessions {
  constructor(store) {
    this.store = store.global();
  }
  lock(id) {
    return 'deepseek-agent-chat:' + id;
  }
  async resolve(tabId, url) {
    return navigator.locks.request('deepseek-agent-sessions', async () => {
      const canonical = conversationURL(url);
      const sessions = await this.store.get('chat-sessions') || [];
      const bindingKey = 'chat-binding:' + tabId;
      const binding = (await chrome.storage.session.get(bindingKey))[bindingKey];
      let deferred = false;
      let record = canonical ? sessions.find(s => s.url === canonical) :
        sessions.find(s => s.id === binding && !s.url);
      // Another tab may open the just-created conversation before this executor sees
      // its first reply. Verify delivery before adopting the draft session identity.
      if (!record && canonical) {
        for (const draft of sessions.filter(s => !s.url)) {
          const ownerKey = 'chat-binding:' + draft.tabId;
          if ((await chrome.storage.session.get(ownerKey))[ownerKey] !== draft.id) continue;
          try {
            const tab = await chrome.tabs.get(draft.tabId);
            if (conversationURL(tab.url) !== canonical) continue;
            const task = await this.store.forChat(draft.id).get('task');
            if (!task?.outbound?.prompt) continue;
            const config = (await chrome.storage.local.get('chat-bindings'))['chat-bindings'] || {};
            const [delivery] = await chrome.scripting.executeScript({
              target: {
                tabId: draft.tabId
              },
              func: deepseekDOM,
              args: ['delivery', config, task.outbound.prompt]
            });
            if (delivery?.result?.posted && delivery.result.latest) {
              record = draft;
              break;
            }
            if (draft.tabId === tabId) {
              record = draft;
              deferred = true;
              break;
            }
            throw Object.assign(new Error('Этот диалог ещё подключается в первой вкладке; повторный запуск недоступен'), {
              pendingConversation: true
            });
          } catch (error) {
            if (error.pendingConversation) throw error;
            /* A closed or unrelated tab cannot claim this conversation. */
          }
        }
      }
      if (!record) {
        record = {
          id: crypto.randomUUID(),
          url: canonical,
          tabId
        };
        sessions.push(record);
      }
      if (canonical && !record.url && !deferred) record.url = canonical;
      await this.store.put('chat-sessions', sessions);
      await chrome.storage.session.set({
        [bindingKey]: record.id
      });
      return record.id;
    });
  }
  async promote(id, url) {
    const canonical = conversationURL(url);
    if (!canonical) return;
    await navigator.locks.request('deepseek-agent-sessions', async () => {
      const sessions = await this.store.get('chat-sessions') || [];
      const existing = sessions.find(s => s.url === canonical);
      if (existing && existing.id !== id) throw new Error('Этот диалог уже открыт другим исполнителем');
      const record = sessions.find(s => s.id === id);
      if (record && !record.url) {
        record.url = canonical;
        await this.store.put('chat-sessions', sessions);
      } else if (record?.url !== canonical) throw new Error('Вкладка перешла в другой диалог');
    });
  }
}
