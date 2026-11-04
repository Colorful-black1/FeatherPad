export type FocusMemory = WeakMap<HTMLElement, HTMLElement>;
const regionSelector = '.app-heading, .activity-rail, .sidebar, .document-toolbar, .document-tabs, .document-view, .welcome, .statusbar';
const controlSelector = 'button, summary, input, select, textarea, a[href], [tabindex]';

function available(element: HTMLElement) {
  return !element.matches(':disabled') && !element.closest('[hidden], [inert]')
    && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
}

export function rememberRegionFocus(root: HTMLElement, target: HTMLElement, memory: FocusMemory) {
  const region = target.closest<HTMLElement>(regionSelector);
  if (region && root.contains(region)) memory.set(region, target);
}

export function focusRegion(region: HTMLElement, memory: FocusMemory): boolean {
  const previous = memory.get(region);
  const preferred = region.matches('.document-view') ? region.querySelector<HTMLElement>('.cm-content, .large-file-text')
    : region.matches('.document-tabs') ? region.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]') : null;
  const controls = [...region.querySelectorAll<HTMLElement>(controlSelector)].filter(element => element.tabIndex >= 0);
  for (const candidate of [previous, preferred, ...controls, region.hasAttribute('tabindex') ? region : null]) {
    if (!candidate || !region.contains(candidate) || (candidate !== region && candidate.tabIndex < 0)
      || !available(candidate)) continue;
    candidate.focus();
    if (candidate.ownerDocument.activeElement === candidate) return true;
  }
  return false;
}

export function moveRegionFocus(root: HTMLElement, reverse: boolean, memory: FocusMemory): boolean {
  const regions = [...root.querySelectorAll<HTMLElement>(regionSelector)].filter(available);
  const active = root.ownerDocument.activeElement;
  const current = regions.findIndex(region => active && region.contains(active));
  for (let step = 1; step <= regions.length; step++) {
    const index = current < 0 ? reverse ? regions.length - step : step - 1
      : (current + (reverse ? -step : step) + regions.length) % regions.length;
    const region = regions[index];
    if (region && focusRegion(region, memory)) return true;
  }
  return false;
}
