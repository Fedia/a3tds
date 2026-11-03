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
    queued: 'Python ожидает запуска…',
    sandbox: 'Подготавливаю среду Python…',
    worker: 'Запускаю Python…',
    bootstrap: 'Загружаю файлы Python…',
    runtime: 'Загружаю интерпретатор Python…',
    packages: 'Подготавливаю нужные библиотеки…',
    inputs: 'Передаю данные в Python…',
    running: 'Выполняю Python-код…',
    exporting: 'Собираю результаты Python…'
  } [phase] || '';
}
export function progressText(state) {
  if (!state) return '';
  if (state.status === 'paused') return 'Пауза. ' + shortReason(state.message || state.reason);
  if (state.status !== 'running') return '';
  const saved = state.savedFiles ? `Сохранено файлов: ${state.savedFiles} · ` : state.savedPages ? `Сохранено страниц: ${state.savedPages} · ` : '';
  const waiting = {
    sending: 'Передаю результаты в DeepSeek…',
    waiting: 'Жду ответ DeepSeek…',
    generating: 'DeepSeek готовит следующий шаг…',
    checking: 'Читаю готовый ответ DeepSeek…'
  } [state.phase];
  if (waiting) return saved + waiting + (state.waitElapsed >= 5 ? ` ${state.waitElapsed} с` : '');
  return saved + (pythonPhaseText(state.pythonPhase) || state.current || 'Выполняю задачу…');
}
export function belongsToChat(state, url, tabId) {
  if (!state || state.ownerTabId !== tabId) return false;
  if (!state.ownerURL || state.ownerURL === url) return true;
  // A first submission creates a conversation URL from the empty chat.
  return state.status === 'running' && ['/', '/a/chat', '/a/chat/'].includes(new URL(state.ownerURL).pathname);
}

/** Correlate a DOM command with its local receipt; not an execution authorization. */
export function commandUIKey(command) {
  const text = JSON.stringify([command.id, command.tool, command.args, command.description]);
  let digest = 2166136261;
  for (let i = 0; i < text.length; i++) digest = Math.imul(digest ^ text.charCodeAt(i), 16777619);
  return command.id + ':' + text.length + ':' + (digest >>> 0).toString(36);
}

function resultText(command, result) {
  if (result?.status === 'error') return shortReason(result.error?.message || 'Действие не удалось.');
  const d = result?.data || {},
    p = d.page || d;
  if (command.tool === 'browser.collect') return `Собрано записей: ${p.savedRecords ?? p.records?.length ?? 0}.`;
  if (command.tool === 'browser.extract') {
    const kind = p.kind || command.args.kind;
    return kind === 'text' ? 'Текст страницы собран и сохранён.' : kind === 'links' ? 'Ссылки собраны и сохранены.' : 'Таблицы собраны и сохранены.';
  }
  if (command.tool === 'browser.open') return p.title ? 'Открыта страница: ' + p.title.slice(0, 160) : 'Страница открыта.';
  if (command.tool === 'browser.snapshot') return 'Страница прочитана, копия сохранена.';
  if (command.tool === 'browser.inspect') return 'Структура страницы прочитана.';
  if (command.tool === 'files.write') return 'Сохранён файл: ' + (d.path || command.args.path).split('/').at(-1);
  if (command.tool === 'files.list') return `Найдено файлов и папок: ${d.entries?.length || 0}.`;
  if (command.tool === 'files.read') return 'Файл прочитан.';
  if (command.tool === 'python.run') return 'Вычисление завершено.' + (d.files?.length ? ` Создано файлов: ${d.files.length}.` : '');
  return 'Действие выполнено.';
}
export function pythonHistoryEntry(entry, job) {
  if (!job) return entry;
  const status = {
    running: 'running',
    completed: 'ok',
    failed: 'error',
    cancelled: 'interrupted',
    interrupted: 'interrupted'
  } [job.status] || 'running';
  let detail = '';
  if (status === 'running') {
    const p = job.progress;
    const progress = typeof p === 'string' ? p : typeof p === 'number' ? String(p) : p && typeof p === 'object' ?
      (Number.isFinite(p.done) && Number.isFinite(p.total) ? `Обработано ${p.done} из ${p.total}` : Object.entries(p).slice(0, 4).map(([k, v]) => `${k}: ${v===null?'—':typeof v==='object'?'…':String(v).slice(0,80)}`).join(' · ')) : '';
    detail = [pythonPhaseText(job.phase) || 'Python выполняется…', progress, `${job.status==='running'?Math.floor((Date.now()-job.started)/1000):job.elapsedSeconds||0} с`].filter(Boolean).join(' · ');
  } else if (job.error) detail = shortReason(job.error.message);
  else if (job.exportPending) detail = 'Вычисление завершено; результаты сохранены локально, выгрузка в папку ожидается.';
  else detail = 'Вычисление завершено.' + (job.files?.length ? ` Создано файлов: ${job.files.length}.` : '');
  return {
    ...entry,
    status,
    detail
  };
}
export function projectHistory(state) {
  const entries = Object.values(state.commands || {}).filter(x => x.command.tool !== 'task.finish').map(({
    command,
    result,
    source
  }) => pythonHistoryEntry({
    hidden: command.tool === 'python.status',
    commandId: command.id,
    key: commandUIKey(command),
    responseKey: source?.wireKey,
    messageKey: source?.messageKey,
    description: command.description,
    status: result?.status === 'ok' ? 'ok' : 'error',
    detail: resultText(command, result)
  }, state.pythonJobs?.[command.id]));
  const command = state.pending?.command;
  if (command && command.tool !== 'task.finish' && !state.commands?.[command.id]) entries.push(pythonHistoryEntry({
    hidden: command.tool === 'python.status',
    commandId: command.id,
    key: commandUIKey(command),
    responseKey: state.pending.source?.wireKey,
    messageKey: state.pending.source?.messageKey,
    description: command.description,
    status: state.status === 'running' ? 'running' : state.status === 'paused' ? 'paused' : 'interrupted',
    detail: command.tool === 'python.run' ? pythonPhaseText(state.pythonPhase) : ''
  }, state.pythonJobs?.[command.id]));
  return entries;
}

/** Safe UI projection; a final is accepted only after a successful task.finish command. */
export function projectTask(state) {
  const command = state.last && state.commands?.[state.last.id]?.command;
  const final = state.status === 'completed' && state.last?.status === 'ok' && command?.tool === 'task.finish' ? {
    taskId: state.id,
    chatURL: state.modelChatURL,
    commandId: command.id,
    responseKey: state.commands[state.last.id].source?.wireKey,
    messageKey: state.commands[state.last.id].source?.messageKey,
    text: command.args.summary
  } : null;
  return {
    taskId: state.id,
    status: state.status,
    phase: state.phase,
    waitElapsed: state.waitElapsed || 0,
    pythonPhase: state.pending?.command.tool === 'python.run' ? state.pythonPhase : null,
    history: projectHistory(state),
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
