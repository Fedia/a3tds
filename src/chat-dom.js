/** Automatic semantic discovery; explicit selectors remain an optional developer override. */
export function deepseekDOM(action, config, payload) {
  config ||= {};
  const visible = e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
  const label = e => [e.getAttribute('aria-label'), e.getAttribute('title'), e.textContent].filter(Boolean)
    .join(' ').trim();
  const all = (selector, root = document) => {
    try {
      return [...root.querySelectorAll(selector)].filter(visible);
    } catch {
      return [];
    }
  };
  const bound = (key, root = document) => config[key] ? all(config[key], root) : [];
  const unique = nodes => nodes.length === 1 ? nodes[0] : null;
  const buttons = all('button,[role="button"]');
  const named = re => buttons.filter(e => re.test(label(e)));
  // These are semantic conventions, not claims about the current DeepSeek DOM.
  const assistantNodes = () => all(
    '[data-message-author-role="assistant"],[data-role="assistant"],[data-author="assistant"]').filter(e =>
    !e.parentElement.closest(
      '[data-message-author-role="assistant"],[data-role="assistant"],[data-author="assistant"]'));
  const composer = unique(all('textarea,[contenteditable="true"][role="textbox"]'));
  const alerts = all('[role="alert"],[role="dialog"],[aria-live="assertive"]');
  const notice = re => alerts.find(e => re.test(label(e)));
  const detected = {
    input: composer,
    send: unique(named(/^(send|send message|отправить|отправить сообщение|发送)(\s|$)/i)),
    stop: unique(named(/stop (generating|generation|response)|остановить|停止生成/i)),
    login: !composer && (unique(named(/^(log in|sign in|войти|登录)$/i)) || document.querySelector(
      'input[type="password"]')),
    challenge: notice(/captcha|verify.*human|провер.*человек|подтверд.*человек|人机验证/i) || all(
      'iframe[title]').find(e => /captcha|challenge|verification/i.test(e.title)),
    error: notice(
      /rate limit|too many requests|try again later|service unavailable|слишком много|лимит|попробуйте позже|服务繁忙/i
    )
  };
  // Never select an arbitrary last button when a binding matches several controls.
  const one = k => unique(bound(k)) || detected[k] || null;
  const copyPattern = /^(copy( response| message)?|копировать( ответ| сообщение)?|复制|regenerate|повторить ответ)(\s|$)/i;
  const completion = root => unique(bound('complete', root)) ||
    all('button,[role=button]', root).find(e => copyPattern.test(label(e)));
  const responseNodes = () => {
    const semantic = assistantNodes();
    if (semantic.length) return semantic;
    // A manual answer container is useful only if it also owns its action toolbar.
    const manual = bound('response').filter(e => completion(e));
    if (manual.length) return manual;
    // Infer a message boundary from its copy toolbar, never from a guessed site class.
    const copies = buttons.filter(e => copyPattern.test(label(e)));
    const inferred = [];
    for (const copy of copies) {
      let node = copy.parentElement;
      while (node && node !== document.body && node !== document.documentElement) {
        const controls = all('button,[role=button]', node).filter(e => copyPattern.test(label(e)));
        if (controls.length > 1 || node.contains(composer)) break;
        const clone = node.cloneNode(true);
        clone.querySelectorAll('button,[role=button]').forEach(e => e.remove());
        if (clone.textContent.trim()) {
          inferred.push(node);
          break;
        }
        node = node.parentElement;
      }
    }
    return [...new Set(inferred)];
  };
  const responses = nodes => nodes.map(e => {
    const c = e.cloneNode(true);
    if (config.complete) {
      try {
        c.querySelectorAll(config.complete).forEach(x => x.remove());
      } catch {}
    }
    c.querySelectorAll('button,[role=button]').forEach(x => x.remove());
    return c.textContent.trim();
  });
  if (action === 'elements') return {
    input: one('input'),
    send: one('send')
  };
  const inspect = () => {
    const error = one('error'),
      login = one('login'),
      challenge = one('challenge'),
      stop = one('stop'),
      send = one('send'),
      input = one('input');
    const nodes = responseNodes();
    const answers = responses(nodes);
    const last = answers.at(-1) || '';
    const latest = nodes.at(-1);
    const complete = latest && completion(latest);
    let status = challenge ? 'user-required' : login ? 'login-required' : error ? 'service-error' : stop ?
      'generating' : input && send && !input.disabled ? 'ready' : 'user-required';
    return {
      status,
      answer: last,
      count: answers.length,
      completion: !!complete && !!complete.getClientRects().length,
      stop: !!stop,
      input: !!input,
      send: !!send,
      reason: challenge ? 'CAPTCHA или участие пользователя' : login ? 'Требуется вход' : error ?
        'Ошибка/ограничение сервиса' : status === 'user-required' ?
        !input ? 'Не удалось однозначно найти поле сообщения. Закройте диалоги или уточните привязку поля в настройках.' : 'Не удалось однозначно найти кнопку отправки. Уточните её привязку в настройках.' : '',
      diagnostic: {
        inputCount: bound('input').length,
        responseCount: answers.length,
        sendCount: bound('send').length
      }
    };
  };
  if (action === 'inspect') return inspect();
  if (action === 'clear-task') {
    const input = one('input');
    const current = input?.value ?? input?.innerText;
    if (!input || current !== payload) throw new Error('Черновик изменился. Отправьте задачу снова.');
    if (input.isContentEditable) input.textContent = '';
    else Object.getOwnPropertyDescriptor(input instanceof HTMLTextAreaElement ? HTMLTextAreaElement
      .prototype : HTMLInputElement.prototype, 'value').set.call(input, '');
    input.dispatchEvent(new Event('input', {
      bubbles: true
    }));
    return {
      cleared: true
    };
  }
  if (action === 'send') {
    const before = inspect();
    if (before.status !== 'ready') throw new Error(before.reason || 'Чат не готов');
    const input = one('input');
    if (input.value?.trim() || input.isContentEditable && input.innerText.trim()) throw new Error(
      'В поле уже есть текст пользователя');
    if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) {
      const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement
        .prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, payload);
      input.dispatchEvent(new Event('input', {
        bubbles: true
      }));
    } else if (input.isContentEditable) {
      input.textContent = payload;
      input.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        inputType: 'insertText',
        data: payload
      }));
    } else throw new Error('Неподдерживаемое поле');
    return {
      ...before,
      inserted: true
    };
  }
  if (action === 'submit') {
    const send = one('send');
    if (!send || send.disabled) throw new Error('Кнопка отправки недоступна');
    send.click();
    return {
      attempted: true
    };
  }
}
