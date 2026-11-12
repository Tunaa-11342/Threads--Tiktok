export const defaultPosition = { x: 0, y: 22 };
export const positionLimits = { x: [-10, 10], y: [13, 78] };

export function cardPosition(value) {
  return Object.fromEntries(Object.entries(positionLimits).map(([axis, [min, max]]) => {
    const raw = value?.[axis];
    return [axis, Number.isFinite(raw) ? Math.min(max, Math.max(min, Math.round(raw))) : defaultPosition[axis]];
  }));
}
