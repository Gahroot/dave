// Writes the voice start/stop chimes as tiny deterministic WAV files:
//   node mobile/scripts/make-chimes.mjs   → mobile/assets/sounds/{start,stop}.wav
// Same notes and envelope as the web's WebAudio chimes (src/ui/voice/sounds.ts):
// sine tones 0.12 s apart, each ramping 0.0001 → 0.12 in 20 ms, back to 0.0001 by 220 ms, stopped at 250 ms.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const NOTES = { start: [523.25, 783.99], stop: [659.25, 392] };
const RATE = 22_050;
const STEP = 0.12, STOP = 0.25, PEAK = 0.12, FLOOR = 0.0001, ATTACK = 0.02, DECAY_END = 0.22;

function gainAt(t) {
  if (t < 0 || t >= STOP) return 0;
  if (t < ATTACK) return FLOOR * Math.pow(PEAK / FLOOR, t / ATTACK);
  if (t < DECAY_END) return PEAK * Math.pow(FLOOR / PEAK, (t - ATTACK) / (DECAY_END - ATTACK));
  return FLOOR;
}

function wav(notes) {
  const samples = Math.ceil((STEP * (notes.length - 1) + STOP) * RATE);
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const t = i / RATE;
    let v = 0;
    notes.forEach((f, n) => { const local = t - n * STEP; v += gainAt(local) * Math.sin(2 * Math.PI * f * local); });
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + data.length, 4); header.write("WAVE", 8);
  header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24); header.writeUInt32LE(RATE * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "sounds");
mkdirSync(out, { recursive: true });
for (const [name, notes] of Object.entries(NOTES)) writeFileSync(join(out, `${name}.wav`), wav(notes));
console.log(`Wrote ${Object.keys(NOTES).map((n) => `${n}.wav`).join(", ")} to ${out}`);
