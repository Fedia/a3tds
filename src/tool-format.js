/** Decode exactly one command. Ordinary Markdown/python examples are never executable. */
export function decodeToolResponse(text) {
  if (typeof text !== 'string' || text.length > 250000) throw new Error('Ответ слишком велик');
  const raw = text.trim();
  const fenced = raw.match(/^(`{3,})python\.run[ \t]*\r?\n([\s\S]*?)\r?\n\1[ \t]*$/);
  if (fenced) {
    if (new RegExp('^`{' + fenced[1].length + ',}[ \\t]*$', 'm').test(fenced[2])) throw new Error('Нужен один целый блок python.run');
    return {
      tool: 'python.run',
      args: {
        code: fenced[2],
        data: {}
      }
    };
  }
  return JSON.parse(raw.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, ''));
}
/** Presentation correlation only, never execution authorization. */
export function responseUIKey(text) {
  const raw = text.trim();
  let digest = 2166136261;
  for (let i = 0; i < raw.length; i++) digest = Math.imul(digest ^ raw.charCodeAt(i), 16777619);
  return raw.length + ':' + (digest >>> 0).toString(36);
}
export function describeTool(tool, args) {
  if (tool === 'browser.open') return 'Открыть ' + args.url;
  if (tool === 'files.write') return 'Сохранить ' + args.path;
  return ({
    'browser.snapshot': 'Прочитать страницу',
    'browser.inspect': 'Изучить структуру страницы',
    'browser.collect': 'Собрать данные страницы',
    'browser.extract': 'Извлечь данные страницы',
    'browser.click': 'Открыть выбранный элемент',
    'browser.type': 'Ввести текст',
    'browser.scroll': 'Прокрутить страницу',
    'files.list': 'Посмотреть файлы',
    'files.read': 'Прочитать файл',
    'python.run': 'Выполнить Python',
    'python.status': 'Проверить вычисление',
    'python.cancel': 'Остановить вычисление',
    'python.reset': 'Сбросить Python-сессию',
    'task.finish': 'Завершить задачу'
  })[tool] || tool;
}
