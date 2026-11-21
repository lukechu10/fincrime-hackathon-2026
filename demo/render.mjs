// Renders demo.html frame by frame in headless Chrome and encodes it with ffmpeg.
// Usage: node demo/render.mjs <folder-with-node_modules> <output.mp4> [--still <seconds> <output.png>]
// The first argument is a folder where `npm install puppeteer-core ffmpeg-static` has been run.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const [tools, output, ...rest] = process.argv.slice(2);
const require = createRequire(join(resolve(tools), "package.json"));
const puppeteer = require("puppeteer-core");
const ffmpeg = require("ffmpeg-static");

const chrome = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"]
  .find((path) => existsSync(path));
const FPS = 30;
const duration = JSON.parse(readFileSync(join(here, "build", "timeline.js"), "utf8").replace(/^window\.TIMELINE = /, "").replace(/;\s*$/, "")).duration;

const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ["--force-device-scale-factor=1", "--hide-scrollbars"] });
const page = await browser.newPage();
await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
await page.goto(`${pathToFileURL(join(here, "demo.html")).href}?render`);
await page.evaluate(() => document.fonts.ready);

if (rest[0] === "--still") {
  // Stills for checking the layout: pairs of <seconds> <file>.
  for (let i = 1; i + 1 < rest.length; i += 2) {
    await page.evaluate((t) => window.seek(t), Number(rest[i]));
    await page.screenshot({ path: rest[i + 1], type: "png" });
  }
  await browser.close();
  process.exit(0);
}

const encoder = spawn(ffmpeg, ["-y", "-loglevel", "error",
  "-f", "image2pipe", "-framerate", String(FPS), "-c:v", "png", "-i", "-",
  "-i", join(here, "build", "narration.wav"),
  "-c:v", "libx264", "-preset", "slow", "-crf", "17", "-pix_fmt", "yuv420p", "-r", String(FPS),
  "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", "-shortest", output], { stdio: ["pipe", "inherit", "inherit"] });
const closed = new Promise((done) => encoder.on("close", done));

const frames = Math.round(duration * FPS);
let previous, image, captured = 0;
for (let frame = 0; frame < frames; frame++) {
  const signature = await page.evaluate((t) => window.seek(t), frame / FPS);
  // Identical frames reuse the last screenshot.
  if (signature !== previous) { image = await page.screenshot({ type: "png", optimizeForSpeed: true }); previous = signature; captured++; }
  if (!encoder.stdin.write(image)) await new Promise((drained) => encoder.stdin.once("drain", drained));
  if (frame % 300 === 0) console.log(`frame ${frame} of ${frames}`);
}
encoder.stdin.end();
const code = await closed;
await browser.close();
console.log(`${frames} frames (${captured} captured), ${duration.toFixed(1)} s, ffmpeg exit ${code}`);
process.exit(code ?? 1);
