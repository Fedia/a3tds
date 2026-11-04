import {
  assert
} from './util.js';

/** A completed assistant reply is either one executable Python block or a final answer. */
export function parseReply(text) {
  assert(typeof text === 'string' && text.trim() && text.length <= 250000, 'Пустой или слишком большой ответ');
  const blocks = [],
    lines = text.split(/\r?\n/);
  let block = null;
  for (const [index, line] of lines.entries()) {
    if (!block) {
      const opening = line.match(/^\s{0,3}(`{3,}|~{3,})([^\s]*)[ \t]*$/);
      if (opening) block = {
        fence: opening[1],
        language: opening[2].toLowerCase(),
        introduction: lines.slice(0, index).join('\n').trim(),
        lines: []
      };
    } else if (new RegExp('^\\s{0,3}' + block.fence[0] + '{' + block.fence.length + ',}[ \\t]*$').test(line)) {
      blocks.push(block);
      block = null;
    } else block.lines.push(line);
  }
  assert(!block, 'Блок кода не закрыт');
  if (!blocks.length) {
    assert(!/^\s*\{\s*"(?:tool|args|id)"/.test(text), 'JSON-команды больше не поддерживаются. Нужен блок python');
    return {
      kind: 'final',
      text: text.trim()
    };
  }
  assert(blocks.length === 1 && blocks[0].language === 'python', 'Нужен ровно один блок с меткой python');
  const code = blocks[0].lines.join('\n');
  assert(code.trim(), 'Пустой Python-код');
  return {
    kind: 'python',
    code,
    description: blocks[0].introduction.toLowerCase() === 'python' ? '' : blocks[0].introduction.slice(0, 240)
  };
}
