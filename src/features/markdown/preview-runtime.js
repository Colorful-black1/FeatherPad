// Trusted preview UI only. CSP pins the normalized bytes of this runtime.
// This opaque-origin frame has no Tauri bridge or network capability.
(() => {
  'use strict';
  const channel = document.body.dataset.channel;
  const readOnly = document.body.dataset.readOnly === 'true';
  let ignoreScrollUntil = 0;
  let scheduledScroll = 0;
  let lastReported = -1;
  // Only user gestures may drive the source editor. Content replacement and
  // image reflow also fire scroll events, and reporting those dragged the
  // source view to the top while typing.
  let userScrolled = false;
  const article = document.querySelector('article[aria-label="Markdown正文"]');
  const send = (kind, index) => parent.postMessage({ channel, kind, index }, '*');
  const applyReadOnly = () => {
    for (const input of document.querySelectorAll('input[data-task-id]')) input.disabled = readOnly;
  };
  applyReadOnly();
  document.addEventListener('change', event => {
    const input = event.target;
    if (!readOnly && input instanceof HTMLInputElement && input.dataset.taskId !== undefined) {
      send('task', Number(input.dataset.taskId));
    }
  });
  document.addEventListener('click', event => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest('button[data-copy-id]');
    if (button) send('copy', Number(button.getAttribute('data-copy-id')));
    const link = target.closest('button[data-link-id]');
    if (link) send('link', Number(link.getAttribute('data-link-id')));
  });
  document.addEventListener('keydown', event => {
    ignoreScrollUntil = 0;
    userScrolled = true;
    if (!readOnly && (event.ctrlKey || event.metaKey) && !event.altKey
      && ['z', 'y'].includes(event.key.toLowerCase())) {
      event.preventDefault();
      send('history', event.key.toLowerCase() === 'y' || event.shiftKey ? 1 : 0);
    }
  });
  addEventListener('message', event => {
    const data = event.data;
    if (event.source !== parent || !data || data.channel !== channel) return;
    if (data.kind === 'render' && typeof data.html === 'string' && data.html.length <= 16 * 1024 * 1024 && article) {
      const retainedTop = document.scrollingElement?.scrollTop ?? 0;
      article.innerHTML = data.html;
      applyReadOnly();
      if (retainedTop > 0) window.scrollTo(0, retainedTop);
      // Replacing the article resets the browser's scroll anchoring. Do not
      // report that transient position back to the editor, otherwise a single
      // Enter keystroke drags the source view to the top.
      ignoreScrollUntil = performance.now() + 220;
      lastReported = -1;
      userScrolled = false;
      if (scheduledScroll) { cancelAnimationFrame(scheduledScroll); scheduledScroll = 0; }
    }
    let target = null;
    if (data.kind === 'anchor' && typeof data.fragment === 'string' && data.fragment.length <= 512) target = document.getElementById(data.fragment);
    if (data.kind === 'sourceScroll' && Number.isSafeInteger(data.from) && data.from >= 0) target = document.querySelector(`[data-source-from="${data.from}"]`);
    if (target) { ignoreScrollUntil = performance.now() + 180; target.scrollIntoView({ block: 'start' }); }
  });
  const reportScroll = () => {
    if (!userScrolled || performance.now() < ignoreScrollUntil || scheduledScroll) return;
    scheduledScroll = requestAnimationFrame(() => {
      scheduledScroll = 0;
      if (!userScrolled) return;
      const blocks = [...document.querySelectorAll('[data-source-from]')];
      let best = null;
      let bestTop = -Infinity;
      for (const block of blocks) {
        const bounds = block.getBoundingClientRect();
        if (bounds.top <= 24 && bounds.bottom >= 0 && bounds.top > bestTop) { best = block; bestTop = bounds.top; }
      }
      best ??= blocks.find(block => block.getBoundingClientRect().top >= 0);
      const from = Number(best?.getAttribute('data-source-from'));
      if (best && Number.isSafeInteger(from) && from !== lastReported) { lastReported = from; send('scroll', from); }
    });
  };
  addEventListener('scroll', reportScroll, { passive: true });
  const markUserScroll = () => { ignoreScrollUntil = 0; userScrolled = true; };
  for (const event of ['wheel', 'pointerdown', 'touchstart']) addEventListener(event, markUserScroll, { passive: true });
  new ResizeObserver(reportScroll).observe(document.body);
})();
