async function openSettings(source) {
  if (source?.url?.startsWith('https://chat.deepseek.com/')) await chrome.storage.session.set({
    'settings-chat-tab': source.id
  });
  const url = chrome.runtime.getURL('workspace.html');
  const tabs = await chrome.tabs.query({});
  const tab = tabs.find(t => t.url === url);
  if (tab) await chrome.tabs.update(tab.id, {
    active: true
  });
  else await chrome.tabs.create({
    url
  });
}
chrome.action.onClicked.addListener(openSettings);
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return;
  if (message.type === 'executor-identify' && sender.url === chrome.runtime.getURL('executor.html')) {
    reply({
      tabId: sender.tab?.id
    });
    return;
  }
  if (message.type === 'cancel-previous-python' && sender.url === chrome.runtime.getURL('executor.html') && Number.isInteger(sender.tab?.id || message.currentTabId)) {
    (async () => {
      const {
        summary
      } = await chrome.storage.local.get('summary');
      if (summary?.ownerTabId && summary.ownerTabId !== (sender.tab?.id || message.currentTabId)) await chrome.runtime.sendMessage({
        type: 'executor-command',
        targetTabId: summary.ownerTabId,
        command: 'cancel-python-only',
        taskId: summary.taskId
      }).catch(() => {});
      return {
        ok: true
      };
    })().then(reply, e => reply({
      ok: false,
      error: e.message
    }));
    return true;
  }
  const chat = sender.frameId === 0 && sender.tab && sender.url?.startsWith('https://chat.deepseek.com/');
  const settings = sender.url === chrome.runtime.getURL('workspace.html');
  if (message.type === 'open-workspace' && (chat || settings)) {
    openSettings(sender.tab).then(() => reply({
      ok: true
    }), e => reply({
      ok: false,
      error: e.message
    }));
    return true;
  }
  const allowedChat = ['chat-ready', 'chat-task', 'chat-stop', 'engine-ping'];
  const allowedSettings = ['status', 'export-file', 'resume',
    'reset-tabs'
  ];
  let targetTabId, command;
  if (chat && allowedChat.includes(message.type)) {
    targetTabId = sender.tab.id;
    command = message.type;
  } else if (settings && message.type === 'settings-command' && allowedSettings.includes(message
      .command) && Number.isInteger(message.tabId)) {
    targetTabId = message.tabId;
    command = message.command;
  } else return;
  chrome.runtime.sendMessage({
      type: 'executor-command',
      targetTabId,
      command,
      task: message.task,
      path: message.path,
      note: message.note
    })
    .then(result => reply(result || {
        ok: false,
        error: 'Исполнитель не готов. Обновите вкладку DeepSeek.'
      }),
      () => reply({
        ok: false,
        error: 'Исполнитель не готов. Обновите вкладку DeepSeek.'
      }));
  return true;
});
