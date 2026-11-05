/** Human-facing state comes from the controller, never inferred from a model command. */
export function stateLabel(state) {
  if (!state) return 'Готов';
  if (state.status === 'running') return {
    sending: 'Отправляет',
    waiting: 'Ждёт DeepSeek',
    generating: 'DeepSeek отвечает',
    checking: 'Читает ответ'
  } [state.phase] || 'Работает';
  return {
    paused: 'Пауза',
    stopped: 'Остановлен',
    completed: 'Готово'
  } [state.status] || 'Готов';
}
export function shortReason(reason = '') {
  if (/^Python:/i.test(reason)) return reason.trim().split('\n')[0].slice(0, 200);
  if (/captcha|участи[ея] пользователя|провер.*человек/i.test(reason)) return 'Нужна проверка в DeepSeek.';
  if (/требуется вход|войдите|login/i.test(reason)) return 'Войдите в DeepSeek.';
  if (/папк|хранилищ|разрешени/i.test(reason)) return 'Нужен доступ к хранилищу результатов.';
  if (/DeepSeek|отправк|ответ|чат/i.test(reason)) return 'Не удалось прочитать ответ DeepSeek.';
  return reason.replace(/Агент приостановлен:\s*/gi, '').split(/Можно\s+(?:позже\s+)?написать/i)[0]
    .trim().slice(0, 160) || 'Работа приостановлена.';
}
export function pythonPhaseText(phase) {
  return {
    worker: 'Запускаю Python…',
    bootstrap: 'Загружаю файлы Python…',
    runtime: 'Загружаю интерпретатор Python…',
    packages: 'Подготавливаю нужные библиотеки…',
    inputs: 'Подключаю папку проекта…',
    running: 'Выполняю Python-код…',
    exporting: 'Собираю результаты Python…'
  } [phase] || '';
}
export function progressText(state) {
  if (!state) return '';
  if (state.status === 'paused') return 'Пауза. ' + shortReason(state.message || state.reason);
  if (state.status !== 'running') return '';
  const saved = state.savedFiles ? `Сохранено файлов: ${state.savedFiles} · ` : '';
  const waiting = {
    sending: 'Передаю результаты в DeepSeek…',
    waiting: 'Жду ответ DeepSeek…',
    generating: 'DeepSeek готовит следующий шаг…',
    checking: 'Читаю готовый ответ DeepSeek…'
  } [state.phase];
  if (waiting) return saved + waiting + (state.waitElapsed >= 5 ? ` ${state.waitElapsed} с` : '');
  return saved + (pythonPhaseText(state.pythonPhase) || state.current || 'Выполняю задачу…');
}
export function belongsToChat(state, url, tabId, chatId) {
  if (!state) return false;
  if (chatId && state.chatId === chatId) return true;
  if (state.ownerTabId !== tabId && state.ownerURL !== url) return false;
  if (!state.ownerURL || state.ownerURL === url) return true;
  // A first submission creates a conversation URL from the empty chat.
  return state.status === 'running' && ['/', '/a/chat', '/a/chat/'].includes(new URL(state.ownerURL).pathname);
}

/** Execution receipts, not model prose, determine history status. */
function displayProgress(value) {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return value;
    }
  }
  if (value && typeof value === 'object') {
    if (Number.isFinite(value.done) && Number.isFinite(value.total)) return `Обработано ${value.done} из ${value.total}`;
    return Object.entries(value).slice(0, 4).map(([key, item]) => `${key}: ${String(item).slice(0, 120)}`).join(' · ');
  }
  return String(value ?? '');
}
export function projectHistory(state) {
  const entries = Object.values(state.commands || {});
  if (state.pending && !state.commands[state.pending.command.id]) entries.push(state.pending);
  return entries.map(entry => {
    const {
      command,
      result,
      source
    } = entry;
    const status = result ? result.status : state.status === 'running' ? 'running' : state.status === 'paused' ? 'paused' : 'interrupted';
    const activity = entry.activity || [];
    const details = [...(activity.length > 20 ? [`Предыдущих действий: ${activity.length - 20}`] : []), ...activity.slice(-20)];
    if (!result) {
      if (entry.progress) details.push(displayProgress(entry.progress).slice(-1000));
      if (entry.output) details.push(entry.output.slice(-2000));
    } else if (result.status === 'error') details.push(result.error?.message?.slice(-2500) || 'Сценарий прерван');
    else details.push(result.data?.stdout?.slice(-2000) || 'Сценарий выполнен, файлы сохранены.');
    return {
      commandId: command.id,
      key: command.id,
      responseKey: source?.wireKey,
      messageKey: source?.messageKey,
      description: command.description,
      status,
      detail: details.join('\n')
    };
  });
}

export function projectTask(state) {
  return {
    chatId: state.chatId,
    taskId: state.id,
    status: state.status,
    phase: state.phase,
    waitElapsed: state.waitElapsed || 0,
    pythonPhase: state.pending ? state.pythonPhase : null,
    history: projectHistory(state),
    current: state.current || '',
    message: state.reason || state.current || '',
    updated: Date.now(),
    files: state.files,
    savedFiles: state.files.length,
    ownerTabId: state.modelTabId,
    ownerURL: state.modelChatURL,
    final: state.status === 'completed' && state.final ? {
      taskId: state.id,
      chatURL: state.modelChatURL,
      commandId: state.final.id,
      responseKey: state.final.source?.wireKey,
      messageKey: state.final.source?.messageKey,
      text: state.final.text
    } : null
  };
}
