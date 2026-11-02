/** Human-facing state comes from the controller, never inferred from a model command. */
export function stateLabel(state) {
  if (!state) return 'Готов';
  if (state.status === 'running') return ['waiting', 'checking'].includes(state.phase) ? 'Проверяет ответ' : 'Работает';
  return {
    paused: 'Пауза',
    stopped: 'Остановлен',
    completed: 'Готово'
  } [state.status] || 'Готов';
}
export function shortReason(reason = '') {
  if (/captcha|участи[ея] пользователя|провер.*человек/i.test(reason)) return 'Нужна проверка в DeepSeek.';
  if (/требуется вход|войдите|login/i.test(reason)) return 'Войдите в DeepSeek.';
  if (/папк|хранилищ|разрешени/i.test(reason)) return 'Нужен доступ к хранилищу результатов.';
  if (/DeepSeek|отправк|ответ|чат/i.test(reason)) return 'Не удалось прочитать ответ DeepSeek.';
  if (/лимит|бюджет/i.test(reason)) return 'Достигнут лимит задачи.';
  return reason.replace(/Агент приостановлен:\s*/gi, '').split(/Можно\s+(?:позже\s+)?написать/i)[0]
    .trim().slice(0, 160) || 'Работа приостановлена.';
}
export function progressText(state) {
  if (!state) return '';
  if (state.status === 'paused') return 'Пауза. ' + shortReason(state.message || state.reason);
  if (state.status !== 'running') return '';
  const saved = state.savedFiles ? `Сохранено файлов: ${state.savedFiles} · ` : state.savedPages ? `Сохранено страниц: ${state.savedPages} · ` : '';
  if (['waiting', 'checking'].includes(state.phase)) return saved + 'Проверяю ответ DeepSeek…';
  return saved + (state.current || 'Выполняю задачу…');
}
export function belongsToChat(state, url, tabId) {
  if (!state || state.ownerTabId !== tabId) return false;
  if (!state.ownerURL || state.ownerURL === url) return true;
  // A first submission creates a conversation URL from the empty chat.
  return state.status === 'running' && ['/', '/a/chat', '/a/chat/'].includes(new URL(state.ownerURL).pathname);
}

/** Safe UI projection; a final is accepted only after a successful task.finish command. */
export function projectTask(state) {
  const command = state.last && state.commands?.[state.last.id]?.command;
  const final = state.status === 'completed' && state.last?.status === 'ok' && command?.tool === 'task.finish' ? {
    taskId: state.id,
    chatURL: state.modelChatURL,
    commandId: command.id,
    text: command.args.summary
  } : null;
  return {
    taskId: state.id,
    status: state.status,
    phase: state.phase,
    current: state.current || '',
    message: state.reason || state.current || '',
    updated: Date.now(),
    files: state.files,
    savedFiles: state.captures?.length || 0,
    ownerTabId: state.modelTabId,
    ownerURL: state.modelChatURL,
    final
  };
}
