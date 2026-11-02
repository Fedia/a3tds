import {
  assert,
  pathParts
} from './util.js';

/** Resolve only task-created, explicitly named or deliberately listed project files. */
export async function loadPythonInputs(files, state, requested = []) {
  assert(Array.isArray(requested) && requested.length <= 20, 'Не больше 20 входных файлов');
  let total = 0;
  const names = new Set(),
    inputs = [];
  for (const item of requested) {
    pathParts(item.path);
    pathParts(item.name);
    assert(!names.has(item.name), 'Повтор имени входного файла');
    names.add(item.name);
    assert(state.files.includes(item.path) || state.allowedReads?.includes(item.path) || state.task.includes(item.path),
      'Сначала выбери файл через files.list или укажи его в задаче');
    const file = await files.file(item.path);
    assert(file.size <= 10000000, 'Входной файл больше 10 МБ');
    total += file.size;
    assert(total <= 20000000, 'Входные файлы суммарно больше 20 МБ');
    inputs.push({
      name: item.name,
      bytes: new Uint8Array(await file.arrayBuffer())
    });
  }
  return inputs;
}
