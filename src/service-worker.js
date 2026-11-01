chrome.sidePanel.setPanelBehavior({
  openPanelOnActionClick: true
});
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message.type === 'open-workspace') {
    chrome.tabs.query({}).then(async tabs => {
      const url = chrome.runtime.getURL('workspace.html');
      const tab = tabs.find(t => t.url === url);
      if (tab) await chrome.tabs.update(tab.id, {
        active: true
      });
      else await chrome.tabs.create({
        url
      });
      reply({
        ok: true
      });
    });
    return true;
  }
});
