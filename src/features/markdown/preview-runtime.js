// Trusted preview UI only. CSP pins the normalized bytes of this runtime.
// This opaque-origin frame has no Tauri bridge or network capability.
(() => {
  'use strict';
  const channel = document.body.dataset.channel;
  const readOnly = document.body.dataset.readOnly === 'true';
  const send = (kind, index) => parent.postMessage({ channel, kind, index }, '*');
  for (const input of document.querySelectorAll('input[data-task-id]')) input.disabled = readOnly;
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
  });
  document.addEventListener('keydown', event => {
    if (!readOnly && (event.ctrlKey || event.metaKey) && !event.altKey
      && ['z', 'y'].includes(event.key.toLowerCase())) {
      event.preventDefault();
      send('history', event.key.toLowerCase() === 'y' || event.shiftKey ? 1 : 0);
    }
  });
})();
