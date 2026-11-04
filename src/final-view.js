import {
  responseUIKey
} from './tool-format.js';
/** Render readable tasks, execution receipts and final answers while preserving adapter DOM. */
export function mountFinalAnswers(getAnswers, {
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
    const history = getHistory();
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
      if (answer.context && raw.startsWith('Режим Python-агента.')) {
        text = raw.match(/\nЗадача: ([\s\S]*?)\nКонец задачи\./)?.[1] || '';
      } else if (!answer.context) {
        const candidates = history.filter(item => item.responseKey === responseUIKey(raw) && (!item.messageKey || item.messageKey === answer.messageKey));
        step = candidates.length === 1 ? candidates[0] : null;
        recognized = !!step;
        if (step) text = step.description + '\n' + ({
          running: 'Выполняется…',
          ok: 'Готово',
          error: 'Ошибка',
          paused: 'Приостановлено',
          interrupted: 'Остановлено'
        } [step.status] || '') + (step.detail ? ' · ' + step.detail : '');
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
        const className = final ? 'deepseek-agent-final' : step ? 'deepseek-agent-step' : 'deepseek-agent-task';
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
    if (records.every(record => (record.target.nodeType === 1 ? record.target : record.target.parentElement)?.closest('.deepseek-agent-step,.deepseek-agent-final,.deepseek-agent-task'))) return;
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
