export function assert(ok, message) {
  if (!ok) throw new Error(message);
}
export function pathParts(path) {
  assert(typeof path === 'string' && path.length > 0 && path.length < 240, 'Некорректный путь');
  const p = path.split('/');
  assert(p.every(x => x && x !== '.' && x !== '..' && !/[\\:\x00-\x1f<>"|?*]/.test(x) && !/[. ]$/.test(x) && !
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(x)), 'Путь вне папки или недопустимое имя');
  return p;
}
export function safeURL(value) {
  const u = new URL(value);
  assert(['http:', 'https:'].includes(u.protocol) && !u.username && !u.password,
    'Разрешены только HTTP(S) без учётных данных');
  assert(u.hostname !== 'chat.deepseek.com', 'Вкладка модели исключена из рабочих вкладок');
  for (const [key] of [...u.searchParams, ...new URLSearchParams(u.hash.slice(1))]) {
    assert(!/^(access_token|refresh_token|token|api[_-]?key|password|passwd|session(?:id)?|authorization)$/i.test(key),
      'Ссылка содержит данные авторизации; выбери публичную страницу без них');
  }
  return u.href;
}
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export async function hash(text) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', typeof text === 'string' ?
    new TextEncoder().encode(text) : text))].map(x => x.toString(16).padStart(2, '0')).join('');
}
export function bounded(value, max = 14000) {
  const text = JSON.stringify(value);
  if (text.length <= max) return value;
  return {
    truncated: true,
    totalCharacters: text.length,
    reason: 'Полные данные сохранены локально; запросите files.read с offset/limit либо corpus.read.',
    preview: text.slice(0, max)
  };
}
export function timeout(p, ms, label = 'Операция') {
  let t;
  return Promise.race([p, new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(label + ': таймаут; результат может быть неопределён')),
      ms);
  })]).finally(() => clearTimeout(t));
}
export function csv(rows) {
  return rows.map(r => r.map(v => '"' + String(v ?? '').replace(/"/g, '""') + '"').join(',')).join('\r\n') +
    '\r\n';
}
