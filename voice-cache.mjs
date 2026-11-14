import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { command } from './video.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const defaultPython = process.platform === 'darwin'
  ? '/Volumes/Data/VieNeu-TTS/.venv/bin/python'
  : 'E:\\24h\\AI MAKE VIDEO\\VieNeu-TTS\\.venv\\Scripts\\python.exe';
const python = process.env.VIENEU_PYTHON || defaultPython;
export const ttsCacheFolder = path.join(root, 'tts_cache');

export function hashLine(text) {
  const clean = text.trim().replace(/\s+/gu, ' ');
  return createHash('sha256').update(clean).digest('hex').slice(0, 24);
}

export async function ensureVoiceCache(lines, tempDir) {
  await mkdir(ttsCacheFolder, { recursive: true });
  const missingIndices = [];
  const results = new Array(lines.length);

  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]?.trim() || '';
    const hash = hashLine(text);
    const itemDir = path.join(ttsCacheFolder, hash);
    const wavFile = path.join(itemDir, 'speech.wav');
    const metaFile = path.join(itemDir, 'meta.json');
    if (existsSync(wavFile) && existsSync(metaFile)) {
      try {
        const meta = JSON.parse(await readFile(metaFile, 'utf8'));
        results[i] = { hash, duration: meta.duration, voice: meta.voice, wavFile };
        continue;
      } catch { /* if corrupted, re-generate */ }
    }
    missingIndices.push(i);
  }

  if (missingIndices.length > 0) {
    const subFolder = path.join(tempDir, 'tts-run-' + Date.now());
    await mkdir(subFolder, { recursive: true });
    const missingLines = missingIndices.map(i => lines[i].trim());
    await writeFile(path.join(subFolder, 'lines.json'), JSON.stringify(missingLines), 'utf8');

    await command(python, ['-X', 'utf8', '-B', path.join(root, 'tts.py'), subFolder], {
      cwd: path.resolve(path.dirname(python), '..', '..'),
      timeout: 600_000,
    });

    const timings = JSON.parse(await readFile(path.join(subFolder, 'speech.json'), 'utf8'));
    const voice = (await readFile(path.join(subFolder, 'voice.txt'), 'utf8').catch(() => 'Trúc Ly')).trim();

    for (let k = 0; k < missingIndices.length; k++) {
      const originalIdx = missingIndices[k];
      const text = lines[originalIdx].trim();
      const hash = hashLine(text);
      const itemDir = path.join(ttsCacheFolder, hash);
      await mkdir(itemDir, { recursive: true });
      const srcWav = path.join(subFolder, `speech-${k}.wav`);
      const destWav = path.join(itemDir, 'speech.wav');
      await copyFile(srcWav, destWav);
      const meta = { duration: timings[k], voice };
      await writeFile(path.join(itemDir, 'meta.json'), JSON.stringify(meta), 'utf8');
      results[originalIdx] = { hash, duration: timings[k], voice, wavFile: destWav };
    }
  }

  return results;
}
