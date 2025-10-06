export interface RGBColor {
  r: number;
  g: number;
  b: number;
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

const hexMatcher = /^#?(?<value>[0-9a-fA-F]{6})$/;

export const hexToRgb = (hex: string): RGBColor => {
  const match = hexMatcher.exec(hex);
  if (!match?.groups?.value) {
    throw new Error(`Invalid hex color: ${hex}`);
  }
  const value = match.groups.value;
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return { r, g, b };
};

export const rgbToHex = (color: RGBColor): string => {
  const toHex = (component: number) =>
    Math.round(clamp01(component / 255) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${toHex(color.r)}${toHex(color.g)}${toHex(color.b)}`;
};

export const mixRgb = (a: RGBColor, b: RGBColor, t: number): RGBColor => {
  const mix = clamp01(t);
  return {
    r: a.r + (b.r - a.r) * mix,
    g: a.g + (b.g - a.g) * mix,
    b: a.b + (b.b - a.b) * mix,
  };
};

export const rgbToCss = (color: RGBColor, alpha = 1) =>
  `rgba(${Math.round(color.r)}, ${Math.round(color.g)}, ${Math.round(
    color.b
  )}, ${clamp01(alpha)})`;

export const lighten = (color: RGBColor, amount: number): RGBColor => {
  const mix = clamp01(amount);
  return {
    r: color.r + (255 - color.r) * mix,
    g: color.g + (255 - color.g) * mix,
    b: color.b + (255 - color.b) * mix,
  };
};
