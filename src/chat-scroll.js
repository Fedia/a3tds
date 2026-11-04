/** Preserve the reader's position across tool messages and native chat autoscroll. */
export function mountChatScroll() {
  let list, anchor, reading = false,
    touching = false,
    manualUntil = 0,
    direction = 0,
    touchY = 0,
    restoring = false,
    frame, url = location.href;
  const now = () => performance.now();
  const find = () => document.querySelector('.ds-virtual-list,[role="log"]');
  const snapshot = () => {
    if (!list) return null;
    const top = list.getBoundingClientRect().top;
    const row = [...list.querySelectorAll('.ds-virtual-list-visible-items > div,[data-virtual-list-item-key]')]
      .find(node => node.getBoundingClientRect().bottom > top + 1 && node.getBoundingClientRect().height > 0);
    return {
      top: list.scrollTop,
      row,
      offset: row ? row.getBoundingClientRect().top - top : 0
    };
  };
  const restore = saved => {
    if (!saved || !reading || !list?.isConnected) return;
    const target = saved.row?.isConnected && list.contains(saved.row) ?
      list.scrollTop + saved.row.getBoundingClientRect().top - list.getBoundingClientRect().top - saved.offset : saved.top;
    if (Math.abs(list.scrollTop - target) < 1) return;
    restoring = true;
    list.scrollTop = target;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      restoring = false;
    });
  };
  const sync = () => {
    const next = find();
    if (url !== location.href || list !== next) {
      url = location.href;
      list = next;
      reading = false;
      anchor = null;
    }
    return list;
  };
  const gesture = delta => {
    if (!sync()) return;
    direction = Math.sign(delta);
    manualUntil = now() + 250;
    if (delta < 0 && !reading && list.scrollHeight > list.clientHeight + 1) {
      reading = true;
      anchor = snapshot();
    }
  };
  const within = target => !!sync()?.contains(target);
  const wheel = event => {
    if (event.isTrusted && within(event.target)) gesture(event.deltaY);
  };
  const touchstart = event => {
    if (!event.isTrusted || !within(event.target)) return;
    touching = true;
    touchY = event.touches[0]?.clientY || 0;
  };
  const touchmove = event => {
    if (!event.isTrusted || !touching) return;
    const y = event.touches[0]?.clientY ?? touchY;
    gesture(touchY - y);
    touchY = y;
  };
  const touchend = () => {
    touching = false;
    manualUntil = now() + 350;
  };
  const keydown = event => {
    if (!event.isTrusted) return;
    if (event.target.closest('textarea,input,[contenteditable=true]')) {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) reading = false;
      return;
    }
    if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) gesture(-1);
    if (['ArrowDown', 'PageDown', 'End', ' '].includes(event.key)) gesture(1);
  };
  const pointerdown = event => {
    if (!event.isTrusted) return;
    if (within(event.target)) {
      manualUntil = now() + 1000;
      direction = 0;
    }
    // Native "to latest" buttons are outside the list. A deliberate click may resume following.
    else if (event.target.closest('button,[role=button]') && !event.target.closest('[data-deepseek-agent-toolbar]')) {
      manualUntil = now() + 1000;
      direction = 1;
    }
  };
  const scroll = event => {
    if (event.target !== sync() || restoring) return;
    const manual = touching || now() < manualUntil;
    // A native submit may jump to the end during an upward gesture.
    const jumpedDown = reading && direction < 0 && anchor && list.scrollTop > anchor.top + list.clientHeight / 2;
    if (reading && (!manual || jumpedDown)) {
      restore(anchor);
      return;
    }
    if (manual) {
      manualUntil = now() + 250;
      if (!direction && anchor) direction = Math.sign(list.scrollTop - anchor.top);
      if (direction > 0 && list.scrollHeight - list.clientHeight - list.scrollTop <= 32) reading = false;
      anchor = snapshot();
    }
  };
  const listeners = {
    wheel,
    touchstart,
    touchmove,
    touchend,
    touchcancel: touchend,
    keydown,
    pointerdown,
    scroll
  };
  for (const [type, handler] of Object.entries(listeners)) document.addEventListener(type, handler, {
    capture: true,
    passive: true
  });
  const guard = {
    get reading() {
      sync();
      return reading;
    },
    preserve(work) {
      sync();
      const saved = reading ? snapshot() : null;
      const value = work();
      if (saved) {
        restore(saved);
        anchor = snapshot();
      }
      return value;
    }
  };
  // Shared only with this extension's isolated-world DOM adapter, never a page message bridge.
  globalThis.__deepseekAgentScroll = guard;
  return Object.assign(() => {
    for (const [type, handler] of Object.entries(listeners)) document.removeEventListener(type, handler, true);
    cancelAnimationFrame(frame);
    if (globalThis.__deepseekAgentScroll === guard) delete globalThis.__deepseekAgentScroll;
  }, {
    guard
  });
}
