import {
  commandUIKey
} from './ui-state.js';
/** Render readable tasks, execution receipts and final answers while preserving adapter DOM. */
export function mountFinalAnswers(getAnswers, {
  getFinals = () => [],
  getHistory = () => [],
  color = () => getComputedStyle(document.body).color
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
  const render = () => {
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
          command = JSON.parse(clean);
        } catch {}
        recognized = command && typeof command.tool === 'string' &&
          /^(browser\.(open|snapshot|inspect|collect|click|type|scroll|extract)|files\.(list|read|write)|python\.(run|status|cancel)|task\.finish)$/.test(command.tool) ||
          /^\{\s*"(?:id|tool|description|args)"\s*:/.test(clean);
        if (recognized && command) {
          step = history.findLast(item => item.key === commandUIKey(command));
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
          const accepted = finals.find(item => item.commandId === command.id && item.text === command.args.summary);
          if (accepted) {
            final = true;
            text = accepted.text;
          }
        }
      }
      const signature = JSON.stringify([raw, complete, text, final, step?.status, color()]);
      const previous = rendered.get(source);
      if (previous?.signature === signature) continue;
      if (previous) restore(previous);
      rendered.delete(source);
      if (!recognized) continue;
      const entry = {
        signature,
        hidden: []
      };
      const target = step?.hidden ? answer.turn || source : source;
      // Never collapse a live or unaccepted reply: virtualizers may unmount its
      // completion toolbar before the adapter has observed it. Keep its geometry.
      const conceal = !answer.context && !text && !step ? 'opacity:0!important;pointer-events:none!important' : collapsed;
      // Keep DOM text and boxes available to the adapter while collapsing the visible turn.
      entry.hidden.push({
        node: target,
        style: target.style.cssText,
        aria: target.getAttribute('aria-hidden')
      });
      target.style.cssText += ';' + conceal;
      target.setAttribute('aria-hidden', 'true');
      if (text) {
        const card = document.createElement('div');
        card.className = final ? 'psy-agent-final' : step ? 'psy-agent-step' : 'psy-agent-task';
        if (step) card.dataset.status = step.status;
        card.style.cssText = `display:block;color:${color()};font:inherit;line-height:1.65;white-space:pre-wrap;overflow-wrap:anywhere;margin:0;padding:0;border:0;background:transparent`;
        const content = document.createElement('div');
        content.textContent = text;
        card.append(content);
        source.after(card);
        entry.card = card;
        if ((final || step) && answer.copy) {
          entry.copy = answer.copy;
          entry.copyHandler = event => {
            if (!event.isTrusted) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            navigator.clipboard?.writeText(text).catch(() => {});
          };
          entry.copy.addEventListener('click', entry.copyHandler, true);
        }
      }
      rendered.set(source, entry);
    }
  };
  const observer = new MutationObserver(() => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      render();
    }, 50);
  });
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true
  });
  render();
  const cleanup = () => {
    observer.disconnect();
    clearTimeout(timer);
    for (const entry of rendered.values()) restore(entry);
  };
  cleanup.refresh = render;
  return cleanup;
}
