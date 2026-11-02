import {
  sleep,
  timeout
} from './util.js';

/** Self-contained probe, executed in the page's isolated world through CDP or scripting. */
export function samplePageReadiness() {
  const ignored = 'script,style,nav,header,footer,aside,time,[role=navigation],[role=banner],[role=complementary],[data-ad],[data-ad-slot],.adsbygoogle';
  const visible = element => {
    const r = element.getBoundingClientRect();
    const s = getComputedStyle(element);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
  };
  const roots = [...document.querySelectorAll('main,[role=main],article')];
  const root = roots.find(visible) || roots[0] || document.body;
  const base = {
    documentId: performance.timeOrigin,
    url: location.href,
    domReady: document.readyState !== 'loading',
    contentPresent: false,
    busy: false,
    textCharacters: 0,
    sampleLimited: false,
    fingerprint: ''
  };
  if (!root || !visible(root)) return base;
  const parts = [],
    boxes = [];
  let busy = false,
    visited = 0;
  const geometry = e => {
    const r = e.getBoundingClientRect();
    // Document coordinates avoid treating a scroll itself as a layout shift.
    return [r.left + scrollX, r.top + scrollY, r.width, r.height].map(v => Math.round(v / 2) * 2);
  };
  const sampled = new WeakSet();
  const box = e => {
    if (boxes.length < 200 && !sampled.has(e)) {
      boxes.push(geometry(e));
      sampled.add(e);
    }
  };
  box(root);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        if (node.matches(ignored) || !visible(node)) return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  const inspect = e => {
    if (e.matches('[aria-busy=true],[role=progressbar],[data-state=loading],.skeleton,.spinner')) busy = true;
    if (e.matches('img') && !e.complete) {
      const r = e.getBoundingClientRect();
      if (r.top < innerHeight && r.bottom > 0 && r.left < innerWidth && r.right > 0) busy = true;
    }
    if (boxes.length < 200 && e.matches('p,h1,h2,h3,h4,li,td,th,img,input,textarea,button,[role=button]')) {
      box(e);
    }
  };
  inspect(root);
  let node;
  while (visited < 1200 && (node = walker.nextNode())) {
    visited++;
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push(node.textContent);
      if (node.textContent.trim()) box(node.parentElement);
    } else inspect(node);
  }
  const text = parts.join(' ').replace(/\s+/g, ' ').trim();
  const placeholder = /^(?:loading|please wait|загрузка|загружается|подождите)[\s.!…]*$/i.test(text);
  // Bound work on huge pages; report the sampling limit instead of claiming full coverage.
  const limited = visited >= 1200 || text.length > 80000 || boxes.length >= 200;
  let hash = 2166136261;
  const signature = JSON.stringify([location.href, text.slice(0, 80000), boxes]);
  for (let i = 0; i < signature.length; i++) hash = Math.imul(hash ^ signature.charCodeAt(i), 16777619);
  return {
    ...base,
    busy: busy || placeholder,
    textCharacters: text.length,
    sampleLimited: limited,
    contentPresent: !!text && !placeholder,
    fingerprint: (hash >>> 0).toString(16)
  };
}

/** Wait for DOMContentLoaded plus unchanged content and geometry, with a finite budget. */
export async function waitForStablePage(probe, {
  timeoutMs = 15000,
  intervalMs = 250,
  quietMs = 1000,
  minWaitMs = 1200,
  cancelled = () => false
} = {}) {
  const started = Date.now();
  let last = null,
    signature = '',
    stableSince = started,
    errors = 0;
  const check = () => {
    if (cancelled()) {
      const e = new Error('Ожидание страницы остановлено');
      e.definite = true;
      throw e;
    }
  };
  const result = (ready, reason) => ({
    ready,
    reason,
    waitedMs: Date.now() - started,
    stableMs: last?.domReady && last.contentPresent && !last.busy ? Date.now() - stableSince : 0,
    domReady: !!last?.domReady,
    contentPresent: !!last?.contentPresent,
    textCharacters: last?.textCharacters || 0,
    sampleLimited: !!last?.sampleLimited,
    url: last?.url,
    documentId: last?.documentId
  });
  while (Date.now() - started < timeoutMs) {
    check();
    try {
      const remaining = timeoutMs - (Date.now() - started);
      const sample = await timeout(probe(), Math.max(1, Math.min(2000, remaining)), 'Проверка готовности страницы');
      check();
      errors = 0;
      const next = JSON.stringify([sample.documentId, sample.fingerprint]);
      if (!sample.domReady || !sample.contentPresent || sample.busy || next !== signature) stableSince = Date.now();
      signature = next;
      last = sample;
      if (sample.domReady && sample.contentPresent && !sample.busy &&
        Date.now() - stableSince >= quietMs && Date.now() - started >= minWaitMs) return result(true, 'stable');
    } catch (e) {
      check();
      stableSince = Date.now();
      signature = '';
      // Navigation can temporarily destroy the isolated world. Retry only reads.
      if (++errors >= 3) return result(false, 'dom_unavailable');
    }
    await sleep(Math.min(intervalMs, Math.max(0, timeoutMs - (Date.now() - started))));
  }
  check();
  return result(false, last?.navigationPending ? 'navigation_pending' : !last?.domReady ? 'dom_loading' : !last.contentPresent ? 'content_missing' :
    last.busy ? 'content_loading' : 'layout_changing');
}
