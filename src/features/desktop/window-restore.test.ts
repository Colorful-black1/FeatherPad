import { describe, expect, it } from 'vitest';
import { fitSessionBounds } from './window-restore';

describe('fitSessionBounds', () => {
  it('preserves a visible window and moves an off-screen window into the work area', () => {
    const monitor = { x: 0, y: 0, width: 1920, height: 1040 };
    expect(fitSessionBounds({ x: 100, y: 80, width: 1200, height: 800 }, [monitor]))
      .toEqual({ x: 100, y: 80, width: 1200, height: 800 });
    expect(fitSessionBounds({ x: -5000, y: 2000, width: 1200, height: 800 }, [monitor]))
      .toEqual({ x: 16, y: 224, width: 1200, height: 800 });
  });

  it('chooses the monitor with the largest overlap and clamps oversized bounds', () => {
    const monitors = [
      { x: 0, y: 0, width: 1920, height: 1040 },
      { x: 1920, y: 0, width: 1920, height: 1040 },
    ];
    expect(fitSessionBounds({ x: 1800, y: 100, width: 1000, height: 700 }, monitors))
      .toEqual({ x: 1936, y: 100, width: 1000, height: 700 });
    expect(fitSessionBounds({ x: 100, y: 100, width: 4000, height: 3000 }, monitors))
      .toEqual({ x: 1936, y: 16, width: 1888, height: 1008 });
  });

  it('returns null when no trustworthy monitor work area is available', () => {
    expect(fitSessionBounds({ x: 0, y: 0, width: 1200, height: 800 }, [])).toBeNull();
    expect(fitSessionBounds({ x: 0, y: 0, width: 1200, height: 800 }, [
      { x: 0, y: 0, width: 0, height: 1040 },
    ])).toBeNull();
  });

  it('keeps the complete native frame visible and respects configured minimum content dimensions', () => {
    const monitor = { x: 0, y: 0, width: 1920, height: 1040 };
    expect(fitSessionBounds({ x: 0, y: 0, width: 4000, height: 3000 }, [monitor],
      { width: 16, height: 39 })).toEqual({ x: 16, y: 16, width: 1872, height: 969 });
    expect(fitSessionBounds({ x: 0, y: 0, width: 100, height: 100 }, [monitor]))
      .toEqual({ x: 16, y: 16, width: 800, height: 560 });
  });
});
