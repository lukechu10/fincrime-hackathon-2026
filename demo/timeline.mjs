// Builds the timeline from the spoken sentences: one narration track plus the start and end time of every
// scene and sentence, so the visuals and captions follow the voice.
// Usage: node demo/timeline.mjs <folder-with-sentence-wavs> <output-folder>
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const [audioDir, outDir] = process.argv.slice(2);
const narration = JSON.parse(readFileSync(join(here, "narration.json"), "utf8"));

const RATE = 44100;
const LEAD = 0.9;   // silence before the first sentence of a scene
const GAP = 0.45;   // silence between sentences
const TAIL = 1.1;   // silence after the last sentence of a scene

/** The 16-bit mono samples of a WAV file, with silence trimmed from both ends. */
function samples(file) {
  const buffer = readFileSync(file);
  let offset = 12;
  while (buffer.toString("ascii", offset, offset + 4) !== "data") offset += 8 + buffer.readUInt32LE(offset + 4);
  const length = buffer.readUInt32LE(offset + 4);
  const pcm = new Int16Array(buffer.buffer, buffer.byteOffset + offset + 8, Math.floor(Math.min(length, buffer.length - offset - 8) / 2));
  let from = 0, to = pcm.length;
  while (from < to && Math.abs(pcm[from]) < 200) from++;
  while (to > from && Math.abs(pcm[to - 1]) < 200) to--;
  return pcm.slice(from, to);
}

const pieces = [];
const scenes = [];
let cursor = 0;
narration.scenes.forEach((scene, s) => {
  const start = cursor;
  cursor += LEAD;
  const sentences = scene.sentences.map((sentence, i) => {
    const pcm = samples(join(audioDir, `${String(s).padStart(2, "0")}-${String(i).padStart(2, "0")}.wav`));
    const from = cursor;
    pieces.push({ at: Math.round(from * RATE), pcm });
    cursor += pcm.length / RATE;
    const to = cursor;
    cursor += i === scene.sentences.length - 1 ? TAIL : GAP;
    return { text: sentence.text, from: +(from - start).toFixed(3), to: +(to - start).toFixed(3) };
  });
  scenes.push({ id: scene.id, start: +start.toFixed(3), duration: +(cursor - start).toFixed(3), sentences });
});

// Hold the last frame so the video does not end on the final word.
const END_HOLD = 2.5;
cursor += END_HOLD;
scenes.at(-1).duration = +(scenes.at(-1).duration + END_HOLD).toFixed(3);

const total = Math.ceil(cursor * RATE);
const track = new Int16Array(total);
for (const { at, pcm } of pieces) track.set(pcm, at);
const header = Buffer.alloc(44);
header.write("RIFF", 0); header.writeUInt32LE(36 + total * 2, 4); header.write("WAVEfmt ", 8);
header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
header.writeUInt32LE(RATE, 24); header.writeUInt32LE(RATE * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
header.write("data", 36); header.writeUInt32LE(total * 2, 40);
writeFileSync(join(outDir, "narration.wav"), Buffer.concat([header, Buffer.from(track.buffer)]));

const timeline = { duration: +cursor.toFixed(3), scenes };
writeFileSync(join(outDir, "timeline.js"), `window.TIMELINE = ${JSON.stringify(timeline, null, 1)};\n`);
for (const scene of scenes) console.log(scene.id.padEnd(10), scene.start.toFixed(1).padStart(6), scene.duration.toFixed(1).padStart(6));
console.log("total".padEnd(10), cursor.toFixed(1).padStart(6));
