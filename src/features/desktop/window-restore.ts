import type { SessionBounds } from '../../shared/contracts/files';

export interface LogicalWorkArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

const WORK_AREA_INSET = 16;

function validArea(area: LogicalWorkArea) {
  return [area.x, area.y, area.width, area.height].every(Number.isFinite)
    && area.width > 0 && area.height > 0;
}

function intersectionArea(left: SessionBounds, right: LogicalWorkArea) {
  const width = Math.max(0, Math.min(left.x + left.width, right.x + right.width)
    - Math.max(left.x, right.x));
  const height = Math.max(0, Math.min(left.y + left.height, right.y + right.height)
    - Math.max(left.y, right.y));
  return width * height;
}

function centerDistanceSquared(left: SessionBounds, right: LogicalWorkArea) {
  const centerX = left.x + left.width / 2;
  const centerY = left.y + left.height / 2;
  const nearestX = Math.min(right.x + right.width, Math.max(right.x, centerX));
  const nearestY = Math.min(right.y + right.height, Math.max(right.y, centerY));
  return (centerX - nearestX) ** 2 + (centerY - nearestY) ** 2;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.round(Math.min(Math.max(value, minimum), Math.max(minimum, maximum)));
}

export function fitSessionBounds(
  bounds: SessionBounds,
  monitors: readonly LogicalWorkArea[],
  frame = { width: 0, height: 0 },
): SessionBounds | null {
  const areas = monitors.filter(validArea);
  if (areas.length === 0) return null;

  const target = areas.reduce((best, candidate) => {
    const candidateIntersection = intersectionArea(bounds, candidate);
    const bestIntersection = intersectionArea(bounds, best);
    if (candidateIntersection !== bestIntersection) {
      return candidateIntersection > bestIntersection ? candidate : best;
    }
    return centerDistanceSquared(bounds, candidate) < centerDistanceSquared(bounds, best)
      ? candidate
      : best;
  });

  const inset = Math.min(WORK_AREA_INSET, Math.max(0, Math.floor(
    Math.min(target.width, target.height) / 4,
  )));
  const frameWidth = Math.max(0, frame.width);
  const frameHeight = Math.max(0, frame.height);
  const maximumWidth = Math.max(1, Math.floor(target.width - inset * 2 - frameWidth));
  const maximumHeight = Math.max(1, Math.floor(target.height - inset * 2 - frameHeight));
  const width = Math.min(Math.max(800, Math.round(bounds.width)), maximumWidth);
  const height = Math.min(Math.max(560, Math.round(bounds.height)), maximumHeight);
  return {
    x: clamp(bounds.x, target.x + inset, target.x + target.width - inset - width - frameWidth),
    y: clamp(bounds.y, target.y + inset, target.y + target.height - inset - height - frameHeight),
    width,
    height,
  };
}
