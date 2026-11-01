/** A local presentation of protocol messages; never executes commands or changes raw text. */
export function mountFinalAnswers(getAnswers) {
  const rendered = new Map();
  let timer;
  const restore = (source, entry) => {
    entry.card.remove();
    source.style.cssText = entry.style;
    if (entry.aria === null) source.removeAttribute('aria-hidden');
    else source.setAttribute('aria-hidden', entry.aria);
  };
  const render = () => {
    for (const [source, entry] of rendered) {
      if (!source.isConnected || source.parentElement !== entry.card.parentElement) {
        restore(source, entry);
        rendered.delete(source);
      }
    }
    for (const answer of getAnswers()) {
      const { source, complete } = answer;
      const raw = answer.raw ?? source.textContent.trim();
      const previous = rendered.get(source);
      if (previous?.raw === raw && previous.complete === complete && previous.card.isConnected) continue;
      if (previous) restore(source, previous);
      rendered.delete(source);
      let heading = 'Агент работает', text = '', final = false;
      if (answer.context) {
        heading = 'Задача';
        text = raw.match(/Состояние:\s*\{"steps":0[,}]/) ?
          raw.match(/\nЗадача: ([\s\S]*?)\nОтвет —/)?.[1] || 'Выполняю задачу' : 'Продолжаю работу';
      } else {
        const clean = raw.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
        let command;
        try { command = JSON.parse(clean); } catch {}
        if (command && typeof command.tool === 'string' &&
            /^(browser\.(open|snapshot|click|type|scroll|extract)|files\.(list|read|write)|python\.run|task\.finish)$/.test(command.tool) &&
            typeof command.description === 'string' && command.description.length <= 400) {
          text = command.description;
          if (complete && command.tool === 'task.finish' && typeof command.args?.summary === 'string' &&
              command.args.summary.length > 0 && command.args.summary.length <= 10000) {
            final = true; heading = 'Ответ агента'; text = command.args.summary;
          }
        } else if (!complete && /^\{\s*"(?:id|tool)"\s*:/.test(clean)) {
          text = 'Выполняю следующий шаг…';
        } else continue;
      }
      const entry = { raw, complete, style: source.style.cssText, aria: source.getAttribute('aria-hidden') };
      // Keep a layout box and the untouched text so DOM discovery and React can still read it.
      source.style.cssText += ';height:0!important;max-height:0!important;min-height:0!important;overflow:hidden!important;opacity:0!important;margin:0!important;padding:0!important;pointer-events:none!important';
      source.setAttribute('aria-hidden', 'true');
      const card = document.createElement('section');
      card.className = final ? 'psy-agent-final' : 'psy-agent-step';
      card.setAttribute('aria-label', heading);
      card.style.cssText = 'margin:12px 0;padding:12px;border:1px solid #6b8bba;border-radius:12px;line-height:1.6;overflow-wrap:anywhere';
      const title = document.createElement('strong'); title.textContent = heading;
      const content = document.createElement('div');
      content.style.cssText = 'white-space:pre-wrap;margin-top:6px'; content.textContent = text;
      card.append(title, content); source.after(card);
      entry.card = card; rendered.set(source, entry);
    }
  };
  const observer = new MutationObserver(() => {
    if (timer) return;
    timer = setTimeout(() => { timer = null; render(); }, 50);
  });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
  render();
  return () => {
    observer.disconnect(); clearTimeout(timer);
    for (const [source, entry] of rendered) restore(source, entry);
  };
}
