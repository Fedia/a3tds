/** Present protocol summaries as text. This view never executes model commands. */
export function mountFinalAnswers(getAnswers) {
  const rendered = new Map();
  let timer;
  const render = () => {
    for (const [source, entry] of rendered) {
      if (!source.isConnected || source.parentElement !== entry.card.parentElement) {
        entry.card.remove();
        rendered.delete(source);
      }
    }
    for (const answer of getAnswers()) {
      const { source, complete } = answer;
      const raw = answer.raw ?? source.textContent.trim();
      const previous = rendered.get(source);
      if (previous?.raw === raw && previous.card.isConnected) continue;
      previous?.card.remove();
      rendered.delete(source);
      if (!complete) continue;
      let command;
      try {
        command = JSON.parse(raw.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, ''));
      } catch { continue; }
      if (!command || command.tool !== 'task.finish' ||
          Object.keys(command).sort().join(',') !== 'args,description,id,tool' ||
          typeof command.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(command.id) ||
          ['__proto__', 'constructor', 'prototype'].includes(command.id) ||
          typeof command.description !== 'string' || !command.description || command.description.length > 400 ||
          !command.args || Object.keys(command.args).join(',') !== 'summary' ||
          typeof command.args.summary !== 'string' || !command.args.summary || command.args.summary.length > 10000) continue;
      const card = document.createElement('section');
      card.className = 'psy-agent-final';
      card.setAttribute('aria-label', 'Ответ агента');
      card.style.cssText = 'margin:16px 0;padding:16px;border:1px solid #6b8bba;border-radius:12px;line-height:1.6;overflow-wrap:anywhere';
      const title = document.createElement('strong');
      title.textContent = 'Ответ агента';
      const text = document.createElement('div');
      text.style.cssText = 'white-space:pre-wrap;margin-top:8px';
      text.textContent = command.args.summary;
      card.append(title, text);
      source.after(card);
      rendered.set(source, { raw, card });
    }
  };
  const observer = new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(render, 100);
  });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
  render();
  return () => { observer.disconnect(); clearTimeout(timer); for (const {card} of rendered.values()) card.remove(); };
}
