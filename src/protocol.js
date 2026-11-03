import {
  decodeToolResponse,
  describeTool
} from './tool-format.js';
import {
  validateExtractionPlan
} from './dom-collector.js';
/**
 * @typedef {Object} AgentCommand
 * @property {string} id Durable unique id; a completed id is never executed again.
 * @property {string} tool Exact name from TOOLS.
 * @property {Record<string, unknown>} args Validated tool arguments.
 * @property {string} description Short human-readable action.
 *
 * @typedef {Object} ToolResult
 * @property {string} id Corresponding AgentCommand.id.
 * @property {'ok'|'error'} status
 * @property {unknown} [data]
 * @property {{code:string,message:string}} [error]
 */
import {
  assert,
  pathParts,
  safeURL
} from './util.js';
const s = (max = 20000) => Object.assign(v => typeof v === 'string' && v.length > 0 && v.length <= max, {
  type: 'string'
});
const integer = (min, max) => Object.assign(v => Number.isInteger(v) && v >= min && v <= max, {
  type: `integer ${min}..${max}`
});
const obj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
export const TOOLS = {
  'browser.open': {
    url: s(2000)
  },
  'browser.snapshot': {
    tabId: integer(1, 1e9)
  },
  'browser.extract': {
    tabId: integer(1, 1e9),
    kind: v => ['text', 'links', 'tables'].includes(v)
  },
  'browser.inspect': {
    tabId: integer(1, 1e9),
    selector: s(500),
    limit: integer(1, 100)
  },
  'browser.collect': {
    tabId: integer(1, 1e9),
    inspection: s(100),
    plan: obj
  },
  'browser.click': {
    tabId: integer(1, 1e9),
    snapshot: s(100),
    element: s(30)
  },
  'browser.type': {
    tabId: integer(1, 1e9),
    snapshot: s(100),
    element: s(30),
    text: s(5000)
  },
  'browser.scroll': {
    tabId: integer(1, 1e9),
    delta: integer(-3000, 3000)
  },
  'files.list': {},
  'files.read': {
    path: s(240),
    offset: integer(0, 10000000),
    limit: integer(1, 12000)
  },
  'files.write': {
    path: s(240),
    text: v => typeof v === 'string' && v.length <= 200000
  },
  'python.run': {
    code: s(30000)
  },
  'python.reset': {},
  'python.status': {
    jobId: s(80)
  },
  'python.cancel': {
    jobId: s(80)
  },
  'corpus.add': {
    tabId: integer(1, 1e9)
  },
  'corpus.read': {
    id: s(100),
    offset: integer(0, 10000000),
    limit: integer(1, 12000)
  },
  'analysis.save': {
    schema: obj,
    rows: Array.isArray,
    report: s(50000)
  },
  'task.finish': {
    summary: s(10000)
  }
};
const OPTIONAL = {
  'browser.open': {
    newTab: v => typeof v === 'boolean'
  },
  'python.run': {
    data: obj,
    files: Array.isArray
  },
  'python.status': {
    waitMs: integer(0, 15000)
  },
  'files.list': {
    path: v => typeof v === 'string' && v.length < 240
  }
};
export function parseCommand(text, context = {}) {
  assert(typeof text === 'string' && text.length <= 250000, 'Ответ слишком велик');
  const c = decodeToolResponse(text);
  assert(obj(c), 'Ожидался объект команды');
  assert(Object.keys(c).every(k => ['id', 'tool', 'args', 'description'].includes(k)), 'Допустимы tool, args, id?, description?');
  assert(Object.hasOwn(TOOLS, c.tool) && obj(c.args), 'Неизвестный инструмент или args');
  if (c.id !== undefined && !context.preferContext) assert(s(80)(c.id) && !['__proto__', 'constructor', 'prototype'].includes(c.id) && /^[a-zA-Z0-9_-]+$/.test(c.id), 'Некорректный id');
  if (c.description !== undefined) assert(s(400)(c.description), 'Некорректное описание');
  const refCall = ['browser.click', 'browser.type'].includes(c.tool) && Object.hasOwn(c.args, 'ref');
  const shape = refCall ? (c.tool === 'browser.type' ? {
    ref: s(100),
    text: s(5000)
  } : {
    ref: s(100)
  }) : TOOLS[c.tool];
  const optional = OPTIONAL[c.tool] || {};
  assert(Object.keys(c.args).every(k => Object.hasOwn(shape, k) || Object.hasOwn(optional, k)), 'Неверные поля args');
  for (const [k, check] of Object.entries(shape)) assert(check(c.args[k]), 'Неверный аргумент ' + k);
  for (const [k, check] of Object.entries(optional))
    if (Object.hasOwn(c.args, k)) assert(check(c.args[k]), 'Неверный аргумент ' + k);
  if (c.tool === 'python.run') c.args.data ??= {};
  if (context.preferContext) c.id = context.id;
  else c.id ??= context.id;
  c.description ??= describeTool(c.tool, c.args).slice(0, 400);
  if (c.args.path) pathParts(c.args.path);
  if (c.tool === 'browser.collect') validateExtractionPlan(c.args.plan);
  if (c.tool === 'python.run' && c.args.files) {
    assert(c.args.files.length <= 20, 'Не больше 20 входных файлов');
    const names = new Set();
    for (const f of c.args.files) {
      assert(obj(f) && Object.keys(f).sort().join(',') === 'name,path' && s(240)(f.path) && s(200)(f.name), 'Входной файл: path и name');
      pathParts(f.path);
      pathParts(f.name);
      assert(!names.has(f.name), 'Повтор имени входного файла');
      names.add(f.name);
    }
  }
  if (c.tool === 'browser.open') safeURL(c.args.url);
  if (c.tool === 'analysis.save') {
    assert(s(80)(c.args.schema.version) && Array.isArray(c.args.schema.categories) && c.args.schema.categories
      .length <= 30, 'Схема: version и categories[]');
    assert(c.args.schema.categories.every(x => obj(x) && s(120)(x.name) && s(1000)(x.definition)),
      'Категории: name, definition');
    assert(c.args.rows.length <= 1000, 'Слишком много кодировок');
    for (const r of c.args.rows) assert(obj(r) && ['documentId', 'category', 'quote', 'rationale'].every(k =>
      s(8000)(r[k])), 'Неверная строка кодирования');
  }
  return {
    id: c.id,
    tool: c.tool,
    args: c.args,
    description: c.description
  };
}
export const protocolHelp = () => JSON.stringify(Object.fromEntries(Object.entries(TOOLS).filter(([k]) => !k.startsWith('corpus.') && k !== 'analysis.save').map(([k, v]) => [k,
  k === 'browser.click' ? {
    ref: 'string'
  } : k === 'browser.type' ? {
    ref: 'string',
    text: 'string'
  } : Object.fromEntries([...Object.entries(v).map(([name, check]) => [name, check.type || ({
      kind: 'text|links|tables',
      plan: 'object',
      text: 'string',
      path: 'string',
      rows: 'array'
    } [name] || 'object')]),
    ...Object.entries(OPTIONAL[k] || {}).map(([name, check]) => [name + '?', check.type || ({
      files: '[{path:string,name:string}]',
      newTab: 'boolean',
      data: 'object',
      path: 'string'
    } [name] || 'object')])
  ])
])));
