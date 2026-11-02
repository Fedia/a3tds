/** Supported, read-only field values. No JS, event handlers, storage or form values. */
export const EXTRACT_ATTRIBUTES = ['text', 'href', 'src', 'title', 'alt', 'datetime', 'aria-label',
  'data-id', 'data-name', 'data-author', 'data-date', 'data-rating', 'data-price'
];

export function validateExtractionPlan(plan) {
  const fail = message => {
    throw new Error(message);
  };
  if (!plan || typeof plan !== 'object' || Array.isArray(plan) ||
    Object.keys(plan).sort().join(',') !== 'container,fields,limit') fail('План: нужны container, fields, limit');
  const selector = s => typeof s === 'string' && s.length > 0 && s.length <= 500;
  if (!selector(plan.container) || !Number.isInteger(plan.limit) || plan.limit < 1 || plan.limit > 500) fail('Некорректный контейнер или лимит');
  if (!plan.fields || typeof plan.fields !== 'object' || Array.isArray(plan.fields)) fail('fields должен быть объектом');
  const entries = Object.entries(plan.fields);
  if (!entries.length || entries.length > 20) fail('От 1 до 20 полей');
  for (const [name, field] of entries) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,49}$/.test(name) || ['constructor', 'prototype'].includes(name) ||
      !field || typeof field !== 'object' || Object.keys(field).sort().join(',') !== 'attribute,selector' ||
      !selector(field.selector) || !EXTRACT_ATTRIBUTES.includes(field.attribute)) fail('Недопустимое поле плана: ' + name);
  }
  return plan;
}

/** Self-contained DOM-only implementation; runs in an isolated page world. */
export function domCollectionOperation(op, args) {
  const attributes = ['href', 'src', 'title', 'alt', 'datetime', 'aria-label', 'data-id', 'data-name', 'data-author', 'data-date', 'data-rating', 'data-price'];
  const forbidden = 'script,style,noscript,meta,link,iframe,input,textarea,select,[contenteditable]';
  const visible = e => {
    const s = getComputedStyle(e);
    return e.getClientRects().length && s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
  };
  const visibility = new WeakMap();
  const readable = e => {
    if (!e) return true;
    if (visibility.has(e)) return visibility.get(e);
    const s = getComputedStyle(e);
    const ok = s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0' && readable(e.parentElement);
    visibility.set(e, ok);
    return ok;
  };
  const allowed = e => e && !e.closest(forbidden) && !e.closest('[hidden],[aria-hidden=true]') && visible(e) && readable(e);
  const safeURL = raw => {
    try {
      const u = new URL(raw, document.baseURI);
      if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) return null;
      if ([...u.searchParams, ...new URLSearchParams(u.hash.slice(1))].some(([k]) =>
          /^(token|access_token|refresh_token|password|passwd|api[_-]?key|session(?:id)?|authorization)$/i.test(k))) return null;
      return u.href;
    } catch {
      return null;
    }
  };
  const text = (e, max) => {
    const parts = [];
    let size = 0,
      truncated = false,
      visited = 0;
    const walker = document.createTreeWalker(e, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: node =>
        allowed(node.nodeType === Node.TEXT_NODE ? node.parentElement : node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
    });
    let node;
    while ((node = walker.nextNode())) {
      if (++visited > 5000) {
        truncated = true;
        break;
      }
      if (node.nodeType !== Node.TEXT_NODE) continue;
      const part = node.textContent.replace(/\s+/g, ' ').trim();
      if (!part) continue;
      if (size + part.length + 1 > max) {
        parts.push(part.slice(0, Math.max(0, max - size)));
        truncated = true;
        break;
      }
      parts.push(part);
      size += part.length + 1;
    }
    return {
      value: parts.join(' '),
      truncated
    };
  };
  const value = (e, attribute) => {
    if (!allowed(e)) return {
      value: null,
      truncated: false
    };
    if (attribute === 'text') return text(e, 20000);
    if (!attributes.includes(attribute)) throw new Error('Атрибут недоступен');
    const raw = e.getAttribute(attribute);
    if (raw === null) return {
      value: null,
      truncated: false
    };
    if (['href', 'src'].includes(attribute)) return {
      value: safeURL(raw),
      truncated: false
    };
    return {
      value: raw.slice(0, 20000),
      truncated: raw.length > 20000
    };
  };
  const query = (root, selector) => selector === ':scope' ? root : root.querySelector(selector);
  if (op === 'inspect') {
    const root = document.querySelector(args.selector);
    if (!allowed(root)) throw new Error('Блок не найден или недоступен для чтения');
    const token = crypto.randomUUID();
    globalThis.__psyAgentInspection = {
      token,
      url: location.href,
      documentId: performance.timeOrigin,
      root
    };
    const all = [root, ...root.querySelectorAll('*')].filter(allowed);
    const nodes = [];
    let size = 0;
    for (const e of all) {
      if (!allowed(e)) continue;
      const attrs = {};
      for (const name of ['id', 'class', 'role', ...attributes]) {
        if (!e.hasAttribute(name)) continue;
        const raw = e.getAttribute(name);
        attrs[name] = ['href', 'src'].includes(name) ? safeURL(raw) : raw.slice(0, 160);
      }
      const candidates = [];
      if (e.id) candidates.push('#' + CSS.escape(e.id));
      if (e.classList.length) candidates.push(e.localName + [...e.classList].slice(0, 4).map(c => '.' + CSS.escape(c)).join(''));
      candidates.push(e.localName);
      const row = {
        tag: e.localName,
        depth: 0,
        attributes: attrs,
        textPreview: text(e, 160).value,
        selectors: [...new Set(candidates)].map(selector => ({
          selector,
          matches: document.querySelectorAll(selector).length
        }))
      };
      let parent = e.parentElement;
      while (parent && parent !== root.parentElement) {
        row.depth++;
        parent = parent.parentElement;
      }
      size += JSON.stringify(row).length;
      if (nodes.length >= args.limit || size > 14000) break;
      nodes.push(row);
    }
    return {
      url: location.href,
      title: document.title,
      inspection: token,
      root: args.selector,
      nodes,
      totalElements: all.length,
      truncated: nodes.length < all.length,
      method: 'dom-inspection-v1'
    };
  }
  if (op !== 'collect') throw new Error('Неизвестная операция DOM');
  const inspection = globalThis.__psyAgentInspection;
  if (!inspection || inspection.token !== args.inspection || inspection.url !== location.href ||
    inspection.documentId !== performance.timeOrigin || !inspection.root.isConnected) throw new Error('Запроси новый browser.inspect для текущей страницы');
  const plan = args.plan;
  const containers = [...document.querySelectorAll(plan.container)].filter(e => (e === inspection.root || inspection.root.contains(e)) && allowed(e));
  const records = [];
  let truncated = containers.length > plan.limit,
    bytes = 0;
  const missing = {};
  for (const [index, container] of containers.slice(0, plan.limit).entries()) {
    const fields = Object.create(null), rowMissing = {};
    for (const [name, field] of Object.entries(plan.fields)) {
      const out = value(query(container, field.selector), field.attribute);
      fields[name] = out.value;
      truncated ||= out.truncated;
      if (out.value === null) rowMissing[name] = 1;
    }
    const record = {
      id: 'r' + (index + 1),
      fields,
      source: {
        url: location.href,
        index
      }
    };
    bytes += JSON.stringify(record).length;
    if (bytes > 2000000) {
      truncated = true;
      break;
    }
    for (const name of Object.keys(rowMissing)) missing[name] = (missing[name] || 0) + 1;
    records.push(record);
  }
  return {
    schemaVersion: 1,
    kind: 'records',
    url: location.href,
    title: document.title,
    collectedAt: new Date().toISOString(),
    method: 'dom-plan-v1',
    plan,
    records,
    totalMatched: containers.length,
    missing,
    truncated,
    limits: {
      maxRecords: plan.limit,
      maxFieldCharacters: 20000,
      maxJSONCharacters: 2000000
    }
  };
}
