import {
  hash
} from './util.js';

export const operationKey = (state, command) => state.id + ':' + command.id;

/** Inspect outcomes without replaying a command. Unknown results become tool errors, not global locks. */
export async function recoverTool(controller, command, message = 'Выполнение было прервано') {
  const {
    s: state,
    store,
    files,
    browser,
    python
  } = controller;
  const receipt = await store.get('receipt:' + operationKey(state, command));
  if (receipt) return receipt;
  const capture = await store.get('capture:' + operationKey(state, command));
  if (capture?.status === 'saved') {
    const page = JSON.parse(capture.text);
    return {
      id: command.id,
      status: 'ok',
      data: {
        savedPath: capture.savedPath,
        captureId: capture.key,
        recovered: true,
        url: page.url,
        kind: page.kind,
        savedRecords: page.records?.length,
        tabId: state.tabs.find(t => t.commandId === command.id)?.id
      }
    };
  }
  const result = {
    id: command.id,
    status: 'error',
    error: {
      code: 'OUTCOME_UNCONFIRMED',
      message,
      next: 'Не повторяй эту команду. Используй чтение, другую вкладку или другой способ решения.'
    }
  };
  const args = command.args;
  try {
    if (command.tool === 'task.finish') {
      state.status = 'completed';
      state.reason = args.summary;
      return {
        id: command.id,
        status: 'ok',
        data: {
          summary: args.summary,
          recovered: true
        }
      };
    } else if (command.tool === 'files.write') {
      const write = await store.get('write:' + operationKey(state, command));
      if (write) {
        const file = await files.file(write.path);
        if (await hash(new Uint8Array(await file.arrayBuffer())) === write.hash) {
          if (!state.files.includes(write.path)) state.files.push(write.path);
          return {
            id: command.id,
            status: 'ok',
            data: {
              path: write.path,
              recovered: true
            }
          };
        }
        result.data = {
          path: write.path,
          verified: false
        };
      }
    } else if (command.tool === 'browser.open') {
      const tab = state.tabs.find(t => t.commandId === command.id);
      if (tab) {
        const checked = await browser.check(tab.id);
        const nav = tab.navigation;
        const current = checked.pendingUrl || checked.url;
        if (nav && current !== (nav.observedURL || nav.url) && checked.pendingUrl !== nav.url) {
          result.data = {
            tabId: tab.id,
            url: current,
            requestedURL: nav.url
          };
          return result;
        }
        let page = null;
        try {
          page = await browser.run(tab.id, 'snapshot');
        } catch {}
        return {
          id: command.id,
          status: 'ok',
          data: {
            tabId: tab.id,
            url: checked.url,
            page,
            recovered: true
          }
        };
      }
    } else if (command.tool === 'python.run') {
      python.cancel(); // A lost worker result is never recovered by replaying Python.
    } else if (['browser.click', 'browser.type', 'browser.scroll'].includes(command.tool)) {
      state.blockedInteractions ??= [];
      if (!state.blockedInteractions.includes(args.tabId)) state.blockedInteractions.push(args.tabId);
      try {
        result.data = {
          page: await browser.run(args.tabId, 'snapshot')
        };
      } catch {}
    }
  } catch (e) {
    result.error.observation = e.message;
  }
  return result;
}
