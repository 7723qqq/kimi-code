import { describe, expect, it } from 'bun:test';

import { deriveHoverBackground } from '#/tui/theme/hover-color';

const hexToRgb = (hex: string): [number, number, number] => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];

const relativeLuminance = (hex: string): number => {
  const channel = (value: number): number => {
    const scaled = value / 255;
    return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};

const contrastRatio = (first: string, second: string): number => {
  const a = relativeLuminance(first);
  const b = relativeLuminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};

describe('deriveHoverBackground', () => {
  it('keeps the text readable against the derived background', () => {
    for (const background of ['#1E1E1E', '#FFFFFF', '#2484C6', '#111827', '#F5F5F5']) {
      for (const foreground of ['#FFFFFF', '#000000', '#E5E7EB']) {
        const hover = deriveHoverBackground(background, foreground);
        expect(hover).toMatch(/^#[0-9A-F]{6}$/);
        const before = contrastRatio(background, foreground);
        const after = contrastRatio(hover, foreground);
        expect(after).toBeGreaterThanOrEqual(Math.min(4.5, before) - 0.01);
      }
    }
  });

  it('lightens a dark background and darkens a light one', () => {
    const dark = hexToRgb(deriveHoverBackground('#1E1E1E', '#FFFFFF'));
    expect(dark[0]).toBeGreaterThan(0x1e);
    const light = hexToRgb(deriveHoverBackground('#F5F5F5', '#000000'));
    expect(light[0]).toBeLessThan(0xf5);
  });

  it('returns a derivation even when the foreground and background are identical', () => {
    expect(deriveHoverBackground('#000000', '#000000')).toBe('#111111');
  });

  it('rejects a color that is not six-digit hex', () => {
    expect(() => deriveHoverBackground('rgb(0,0,0)', '#FFFFFF')).toThrow();
  });
});
