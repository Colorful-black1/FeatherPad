// Trusted preview UI only. CSP pins the normalized bytes of this runtime.
// This opaque-origin frame has no Tauri bridge or network capability.
(() => {
  'use strict';
  const channel = document.body.dataset.channel;
  const readOnly = document.body.dataset.readOnly === 'true';
  let ignoreScrollUntil = 0;
  let scheduledScroll = 0;
  let lastReported = -1;
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
      article.innerHTML = data.html;
      applyReadOnly();
      ignoreScrollUntil = 0;
      lastReported = -1;
      reportScroll();
    }
    let target = null;
    if (data.kind === 'anchor' && typeof data.fragment === 'string' && data.fragment.length <= 512) target = document.getElementById(data.fragment);
    if (data.kind === 'sourceScroll' && Number.isSafeInteger(data.from) && data.from >= 0) target = document.querySelector(`[data-source-from="${data.from}"]`);
    if (target) { ignoreScrollUntil = performance.now() + 180; target.scrollIntoView({ block: 'start' }); }
  });
  const reportScroll = () => {
    if (performance.now() < ignoreScrollUntil || scheduledScroll) return;
    scheduledScroll = requestAnimationFrame(() => {
      scheduledScroll = 0;
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
  addEventListener('wheel', () => { ignoreScrollUntil = 0; }, { passive: true });
  addEventListener('pointerdown', () => { ignoreScrollUntil = 0; }, { passive: true });
  new ResizeObserver(reportScroll).observe(document.body);
})();
