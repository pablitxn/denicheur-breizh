import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

type Oklab = readonly [lightness: number, a: number, b: number];

const tokensCss = readFileSync(resolve(process.cwd(), "../../packages/design-system/src/tokens.css"), "utf8");
const componentsCss = readFileSync(resolve(process.cwd(), "../../packages/design-system/src/components.css"), "utf8");
const shellCss = readFileSync(resolve(process.cwd(), "src/components/Shell.module.css"), "utf8");

const rootTokens = extractBlock(/^:root\s*\{([\s\S]*?)^\}/mu);
const lightTokens = extractBlock(/^:root\[data-theme="light"\]\s*\{([\s\S]*?)^\}/mu);

function extractBlock(pattern: RegExp) {
  const match = tokensCss.match(pattern);
  if (!match?.[1]) throw new Error(`Missing token block: ${pattern.source}`);
  return match[1];
}

function tokenValue(block: string, name: string) {
  const match = block.match(new RegExp(`--${name}:\\s*([^;]+);`, "u"));
  if (!match?.[1]) throw new Error(`Missing token: --${name}`);
  return match[1].trim();
}

function themeColor(theme: "dark" | "light", name: string): Oklab {
  const themedValue = theme === "light"
    ? lightTokens.match(new RegExp(`--${name}:\\s*([^;]+);`, "u"))?.[1]
    : undefined;
  return parseOklch((themedValue ?? tokenValue(rootTokens, name)).trim());
}

function parseOklch(value: string): Oklab {
  const match = value.match(/oklch\(([\d.]+)%\s+([\d.]+)\s+([\d.]+)/u);
  if (!match) throw new Error(`Expected an OKLCH literal, received: ${value}`);

  const lightness = Number(match[1]) / 100;
  const chroma = Number(match[2]);
  const hue = Number(match[3]) * Math.PI / 180;
  return [lightness, chroma * Math.cos(hue), chroma * Math.sin(hue)];
}

function relativeLuminance([lightness, a, b]: Oklab) {
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const channels = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((channel) => Math.max(0, Math.min(1, channel)));

  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(first: Oklab, second: Oklab) {
  const firstLuminance = relativeLuminance(first);
  const secondLuminance = relativeLuminance(second);
  return (Math.max(firstLuminance, secondLuminance) + 0.05)
    / (Math.min(firstLuminance, secondLuminance) + 0.05);
}

describe("shared design-token accessibility contracts", () => {
  it.each(["dark", "light"] as const)("keeps subtle text and control borders visible in %s mode", (theme) => {
    const surface = themeColor(theme, "color-surface-2");

    expect(contrastRatio(themeColor(theme, "color-text-faint"), surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(themeColor(theme, "color-border-control"), surface)).toBeGreaterThanOrEqual(3);
  });

  it.each(["dark", "light"] as const)("keeps every CTA accent readable in %s mode", (theme) => {
    const onAccent = themeColor(theme, "color-on-accent");
    const accentPairs = [
      ["color-lavender", "color-lavender-dim"],
      ["color-sunset", "color-sunset-dim"],
      ["color-sea", "color-sea-dim"],
    ] as const;

    for (const [resting, hover] of accentPairs) {
      expect(contrastRatio(themeColor(theme, resting), onAccent)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(themeColor(theme, hover), onAccent)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(["dark", "light"] as const)("keeps status foregrounds above an AA safety margin in %s mode", (theme) => {
    const surface = themeColor(theme, "color-surface");
    for (const token of ["color-good", "color-sunset", "color-danger", "color-sea", "color-warning"] as const) {
      expect(contrastRatio(themeColor(theme, token), surface)).toBeGreaterThanOrEqual(5.4);
    }
  });

  it("uses local system font stacks instead of undeclared web fonts", () => {
    expect(rootTokens).not.toMatch(/Fraunces|Inter Tight|JetBrains Mono/u);
    expect(tokenValue(rootTokens, "font-sans")).toContain("-apple-system");
  });

  it("keeps focus, coarse-pointer, reduced-motion, and mobile-nav policies shared", () => {
    expect(componentsCss).toContain(":where(a, button, input, select, textarea, summary");
    expect(componentsCss).toContain("@media (pointer: coarse)");
    expect(componentsCss).toContain("@media (prefers-reduced-motion: reduce)");
    expect(shellCss).toContain("grid-template-columns: repeat(4, minmax(0, 1fr))");
    expect(shellCss).toContain("overflow: visible");
  });
});
