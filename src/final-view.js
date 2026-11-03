import {
  decodeToolResponse,
  responseUIKey
} from './tool-format.js';
import {
  commandUIKey
} from './ui-state.js';
/** Render readable tasks, execution receipts and final answers while preserving adapter DOM. */
export function mountFinalAnswers(getAnswers, {
  getFinals = () => [],
  getHistory = () => [],
  color = () => getComputedStyle(document.body).color,
  preserveScroll = work => work()
} = {}) {
  const rendered = new Map();
  let timer;
  const collapsed = 'height:0!important;max-height:0!important;min-height:0!important;overflow:hidden!important;opacity:0!important;margin:0!important;padding:0!important;pointer-events:none!important';
  const restore = entry => {
    entry.card?.remove();
    for (const item of entry.hidden) {
      item.node.style.cssText = item.style;
      if (item.aria === null) item.node.removeAttribute('aria-hidden');
      else item.node.setAttribute('aria-hidden', item.aria);
    }
    if (entry.copy && entry.copyHandler) entry.copy.removeEventListener('click', entry.copyHandler, true);
  };
  const render = () => preserveScroll(() => {
    const finals = getFinals(),
      history = getHistory();
    for (const [source, entry] of rendered) {
      if (!source.isConnected || entry.card && source.parentElement !== entry.card.parentElement) {
        restore(entry);
        rendered.delete(source);
      }
    }
    for (const answer of getAnswers()) {
      const {
        source,
        complete
      } = answer;
      const raw = answer.raw ?? source.textContent.trim();
      let text = '',
        final = false,
        step = null,
        recognized = !!answer.context;
      if (answer.context && /Состояние:\s*\{"steps":0[,}]/.test(raw)) {
        text = raw.match(/\nЗадача: ([\s\S]*?)\nОтвет —/)?.[1] || '';
      } else if (!answer.context) {
        const clean = raw.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
        let command;
        try {
          command = decodeToolResponse(raw);
        } catch {}
        recognized = command && typeof command.tool === 'string' &&
          /^(browser\.(open|snapshot|inspect|collect|click|type|scroll|extract)|files\.(list|read|write)|python\.(run|status|cancel|reset)|task\.finish)$/.test(command.tool) ||
          /^\{\s*"(?:id|tool|description|args)"\s*:/.test(clean);
        if (recognized && command) {
          const wireKey = responseUIKey(raw);
          const candidates = history.filter(item => item.responseKey === wireKey && (!item.messageKey || item.messageKey === answer.messageKey));
          step = (command.id && history.findLast(item => item.key === commandUIKey(command))) || (candidates.length === 1 ? candidates[0] : null);
          if (step && !step.hidden) text = step.description + '\n' + ({
              running: 'Выполняется…',
              ok: 'Готово',
              error: 'Ошибка',
              paused: 'Приостановлено',
              interrupted: 'Остановлено'
            } [step.status] || '') +
            (step.detail ? ' · ' + step.detail : '');
        }
        if (complete && command?.tool === 'task.finish' && typeof command.args?.summary === 'string') {
          const accepted = finals.find(item => ((item.responseKey === responseUIKey(raw) && (!item.messageKey || item.messageKey === answer.messageKey)) || command.id && item.commandId === command.id) && item.text === command.args.summary);
          if (accepted) {
            final = true;
            text = accepted.text;
          }
        }
      }
      const ink = color();
      const signature = JSON.stringify([raw, complete, text, final, step?.status, ink]);
      const previous = rendered.get(source);
      if (previous?.signature === signature) continue;
      if (!recognized) {
        if (previous) restore(previous);
        rendered.delete(source);
        continue;
      }
      const target = step?.hidden || answer.context && !text ? answer.turn || source : source;
      // Keep a not-yet-accepted reply measurable until the adapter reads completion.
      const pending = !answer.context && !text && !step;
      const conceal = pending ? 'opacity:0!important;pointer-events:none!important' : collapsed;
      let entry = previous;
      if (entry && (entry.target !== target || entry.pending !== pending)) {
        restore(entry);
        entry = null;
      }
      if (!entry) {
        entry = {
          hidden: [],
          target,
          pending
        };
        const change = (node, css, hidden = false) => {
          entry.hidden.push({
            node,
            style: node.style.cssText,
            aria: node.getAttribute('aria-hidden')
          });
          node.style.cssText += ';' + css;
          if (hidden) node.setAttribute('aria-hidden', 'true');
        };
        change(target, conceal, true);
        if (!pending && answer.turn && answer.turn !== target && answer.turn.contains(source)) {
          // Native message wrappers may reserve the original prompt/code height.
          // Compact only this known message, never the virtual list's spacer or transform.
          let node = source.parentElement;
          while (node && answer.turn.contains(node)) {
            change(node, 'min-height:0!important;height:auto!important;max-height:none!important;flex-grow:0!important');
            if (node === answer.turn) break;
            node = node.parentElement;
          }
          if (answer.context) {
            for (const sibling of answer.turn.children)
              if (!sibling.contains(source)) change(sibling, collapsed, true);
          }
        }
      }
      entry.signature = signature;
      entry.text = text;
      if (!text && entry.card) {
        entry.card.remove();
        entry.card = null;
      }
      if (text) {
        if (!entry.card) {
          const card = document.createElement('div');
          const content = document.createElement('div');
          card.append(content);
          source.after(card);
          entry.card = card;
          entry.css = null;
        }
        const card = entry.card;
        const className = final ? 'psy-agent-final' : step ? 'psy-agent-step' : 'psy-agent-task';
        if (card.className !== className) card.className = className;
        if (step && card.dataset.status !== step.status) card.dataset.status = step.status;
        const css = `display:block;color:${ink};font:inherit;line-height:1.65;white-space:pre-wrap;overflow-wrap:anywhere;margin:0;padding:0;border:0;background:transparent`;
        if (entry.css !== css) {
          card.style.cssText = css;
          entry.css = css;
        }
        if (card.firstChild.textContent !== text) card.firstChild.textContent = text;
        if ((final || step) && answer.copy && !entry.copyHandler) {
          entry.copy = answer.copy;
          entry.copyHandler = event => {
            if (!event.isTrusted) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            navigator.clipboard?.writeText(entry.text).catch(() => {});
          };
          entry.copy.addEventListener('click', entry.copyHandler, true);
        }
      }
      rendered.set(source, entry);
    }
  });
  const observer = new MutationObserver(records => {
    if (records.every(record => (record.target.nodeType === 1 ? record.target : record.target.parentElement)?.closest('.psy-agent-step,.psy-agent-final,.psy-agent-task'))) return;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      render();
    }, 50);
  });
  let observedRoot;
  const watch = () => {
    const root = document.querySelector('.ds-virtual-list,[role=log],main') || document.body;
    if (root === observedRoot) return;
    observer.disconnect();
    observedRoot = root;
    observer.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true
    });
  };
  watch();
  render();
  const cleanup = () => {
    observer.disconnect();
    clearTimeout(timer);
    for (const entry of rendered.values()) restore(entry);
  };
  cleanup.refresh = () => {
    watch();
    render();
  };
  return cleanup;
}
