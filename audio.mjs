import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { outroDuration } from './public/outro.mjs';
import { effectFilePrefix } from './public/effect-options.mjs';

const rate = 48000;
const effects = {
  ting: [0.12, 0.19, 0.18, 1568],
  bell: [0.12, 0.13, 0.05, 2352],
  spring: [0.29, 0.26, 0.2, 225, 660, 1.7],
  down: [0.3, 0.23, 0.18, 430, -680, 0.8],
  game: [0.3, 0.11, 0.14, 440],
  gameEnd: [0.4, 0.15, 0.16, 659, -360],
};
const reactions = {
  spring: [effects.spring],
  down: [effects.down],
  game: [effects.game, effects.gameEnd],
};

const variants = ['spring', 'down', 'game'];
const lead = 0.02;
const tail = 0.13;
const maxEffectSeconds = 4;

function builtIn(mode, index) {
  if (mode === 'off') return null;
  const variant = mode === 'ting' ? mode : variants.includes(mode) ? mode : variants[index % variants.length];
  return { variant, duration: variant === 'ting' ? 0.44 : 0.68 };
}

export async function prepareSoundEffect(mode, files, seed, probe, opening = false) {
  if (mode === 'off') return null;
  const index = typeof seed === 'number' ? seed :
    Array.from(seed).reduce((hash, char) => (Math.imul(hash, 31) + char.codePointAt(0)) >>> 0, 0);
  const selected = mode.startsWith(effectFilePrefix) ? mode.slice(effectFilePrefix.length) : '';
  const names = [...files.keys()];
  const file = selected || (mode === 'auto' && names.length ? names[index % names.length] : '');
  if (!file) return builtIn(mode, index);
  const source = files.get(file);
  if (!source) throw new Error('Không tìm thấy hiệu ứng "' + file + '". Hãy làm mới rồi chọn lại.');
  try {
    const metadata = await probe(source.path);
    const stream = metadata.streams.find(item => item.codec_type === 'audio');
    const seconds = Number(stream?.duration) || Number(metadata.format?.duration);
    if (!stream || !(seconds >= 0.03)) throw new Error('File không có âm thanh');
    const length = Math.min(seconds, maxEffectSeconds);
    const delay = opening ? lead : 0.12;
    return { ...source, length, delay, duration: delay + length + tail };
  } catch {
    if (mode === 'auto') return builtIn(mode, index);
    throw new Error('Không đọc được hiệu ứng "' + file + '". Hãy thử file âm thanh khác.');
  }
}

function waveform([start, length, volume, frequency, slide = 0, wobble = 0]) {
  const time = '(t-' + start + ')';
  const envelope = 'sin(PI*min(1,max(0,' + time + '/' + length + ')))^2';
  const phase = '2*PI*(' + frequency + '*' + time + '+' + slide + '*' + time + '^2)';
  return volume + '*' + envelope + '*sin(' + phase + '+' + wobble + '*sin(2*PI*12*' + time + '))';
}

export async function mixAudio(folder, plan, music, command) {
  const ffmpeg = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y'];
  const files = [];
  async function appendEffect(effect, name, opening = false) {
    if (!effect) return;
    if (effect.path) {
      const fade = Math.min(0.06, effect.length / 3);
      const filter = 'aresample=' + rate + ',aformat=channel_layouts=mono,atrim=duration=' + effect.length +
        ',volume=0.72,afade=t=out:st=' + (effect.length - fade) + ':d=' + fade +
        ',adelay=' + Math.round(effect.delay * 1000) + ',apad';
      await command('ffmpeg', [...ffmpeg, '-i', effect.path, '-map', '0:a:0', '-af', filter,
        '-t', String(effect.duration), '-c:a', 'pcm_s16le', name], { cwd: folder });
    } else {
      const notes = [effects.ting, effects.bell, ...(reactions[effect.variant] || [])]
        .map(([start, ...rest]) => [start - (opening ? 0.09 : 0), ...rest]);
      const source = "aevalsrc='" + notes.map(waveform).join('+') + "':s=" + rate + ':d=' + effect.duration;
      await command('ffmpeg', [...ffmpeg, '-f', 'lavfi', '-i', source, '-c:a', 'pcm_s16le', name], { cwd: folder });
    }
    files.push(name);
  }
  await appendEffect(plan.intro, 'intro.wav', true);
  for (const [index, scene] of plan.scenes.entries()) {
    files.push('speech-' + index + '.wav');
    await appendEffect(scene.reaction, 'effect-' + index + '.wav');
  }

  if (plan.outro) {
    const notes = [
      [1.06, 0.055, 0.16, 780, -1800],
      [1.18, 0.16, 0.13, 1047],
      [1.29, 0.23, 0.15, 1568],
      [1.29, 0.16, 0.05, 2352],
    ];
    const source = "aevalsrc='" + notes.map(waveform).join('+') + "':s=" + rate + ':d=' + outroDuration;
    await command('ffmpeg', [...ffmpeg, '-f', 'lavfi', '-i', source, '-c:a', 'pcm_s16le', 'outro.wav'], { cwd: folder });
    files.push('outro.wav');
  }
  await writeFile(path.join(folder, 'concat.txt'), files.map(name => "file '" + name + "'").join('\n') + '\n');
  const speech = ['-f', 'concat', '-safe', '1', '-i', 'concat.txt'];
  const output = ['-t', String(plan.duration), '-ar', String(rate), '-ac', '1', '-c:a', 'pcm_s16le', 'narration.wav'];
  if (!music) {
    await command('ffmpeg', [...ffmpeg, ...speech, '-af', 'apad', ...output], { cwd: folder });
    return;
  }

  const fade = Math.min(0.65, plan.duration / 4);
  const filter = '[0:a]apad[voice];[1:a]aresample=48000,aformat=channel_layouts=mono,' +
    'volume=0.12,afade=t=in:d=' + fade + ',afade=t=out:st=' + (plan.duration - fade) + ':d=' + fade +
    '[music];[voice][music]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.94:level=false[audio]';
  await command('ffmpeg', [...ffmpeg, ...speech, '-stream_loop', '-1', '-i', music,
    '-filter_complex', filter, '-map', '[audio]', ...output], { cwd: folder });
}
