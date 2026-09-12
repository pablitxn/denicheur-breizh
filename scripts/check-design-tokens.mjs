import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";

const workspaceRoot = process.cwd();
const sourceRoots = [
  "apps/web/src",
  "apps/collector-web/src",
  "apps/extension/src",
  "packages/design-system/src",
];
const rawColor = /#[0-9a-f]{3,8}\b|\b(?:rgb|rgba|hsl|hsla)\(/giu;
const violations = [];

for (const sourceRoot of sourceRoots) {
  for (const file of await collectCssFiles(join(workspaceRoot, sourceRoot))) {
    if (file.endsWith("/tokens.css")) continue;
    const lines = (await readFile(file, "utf8")).split(/\r?\n/u);
    lines.forEach((line, index) => {
      const matches = [...line.matchAll(rawColor)];
      if (matches.length === 0) return;
      violations.push(`${relative(workspaceRoot, file)}:${index + 1} ${line.trim()}`);
    });
  }
}

if (violations.length > 0) {
  console.error("Raw CSS colors must be defined as design tokens:\n");
  console.error(violations.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Design token check passed: no raw colors outside tokens.css.");
}

async function collectCssFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectCssFiles(path));
    } else if (entry.isFile() && extname(entry.name) === ".css") {
      files.push(path);
    }
  }
  return files;
}
