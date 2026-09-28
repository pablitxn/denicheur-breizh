#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtemp, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({ options: {
  "frames-dir": { type: "string" },
  help: { type: "boolean" },
}, allowPositionals: false });
if (values.help) {
  console.log(`Usage: node scripts/build-readme-gifs.mjs --frames-dir /path/to/captures

Requires ffmpeg and ffprobe on PATH. Reads property-01.jpg through property-07.jpg and
builder-01.jpg through builder-05.jpg, all at the same viewport dimensions.
Writes docs/media/property-tour.gif and docs/media/recipe-builder.gif.
Frames are held for 2.5 seconds; screenshots remain unaltered apart from GIF
palette conversion. See docs/readme-media.md for the capture sequence.`);
  process.exit(0);
}
if (!values["frames-dir"]) throw new Error("--frames-dir is required; use --help for the capture contract.");
const frames = resolve(values["frames-dir"]);
const output = join(root, "docs/media");
const sequences = [
  { prefix: "property", count: 7, name: "property-tour.gif" },
  { prefix: "builder", count: 5, name: "recipe-builder.gif" },
];
const ffmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
if (ffmpeg.error || ffmpeg.status !== 0) throw new Error("ffmpeg must be installed and available on PATH.");
let dimensions;
for (const sequence of sequences) {
  for (let index = 1; index <= sequence.count; index++) {
    const file = join(frames, `${sequence.prefix}-${String(index).padStart(2, "0")}.jpg`);
    const probe = spawnSync("ffprobe", [
      "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
      "-of", "json", file,
    ], { encoding: "utf8" });
    if (probe.error || probe.status !== 0) throw new Error(`Cannot inspect screenshot (ffprobe required): ${file}`);
    const [stream] = JSON.parse(probe.stdout).streams;
    const size = `${stream.width}x${stream.height}`;
    dimensions ??= size;
    if (size !== dimensions) throw new Error(`Viewport mismatch: ${file} is ${size}, expected ${dimensions}.`);
  }
}
// Stage both GIFs on the output filesystem; failed encoding preserves prior media.
const temporary = await mkdtemp(join(output, ".gif-build-"));
try {
  for (const { prefix, count, name } of sequences) {
    const result = spawnSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-framerate", "2/5", "-start_number", "1", "-i", join(frames, `${prefix}-%02d.jpg`),
      "-frames:v", String(count),
      "-filter_complex", "split[a][b];[a]palettegen=max_colors=256[p];[b][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle",
      "-loop", "0", "-final_delay", "250", join(temporary, name),
    ], { stdio: "inherit" });
    if (result.error || result.status !== 0) throw new Error(`ffmpeg failed for ${name}.`);
  }
  for (const { count, name } of sequences) {
    await rename(join(temporary, name), join(output, name));
    const { size } = await stat(join(output, name));
    console.log(`${name}: ${dimensions}, ${count} frames, ${count * 2.5}s, ${(size / 1048576).toFixed(2)} MiB`);
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
