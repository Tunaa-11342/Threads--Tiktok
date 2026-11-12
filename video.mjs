import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { copyFile, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mixAudio } from './audio.mjs';
import { cardMarkup, gridMarkup, quotePages } from './public/thread-card.mjs';
import { addOutroAnimation, outroDuration, outroMarkup } from './public/outro.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const python = process.env.VIENEU_PYTHON || 'E:\\24h\\AI MAKE VIDEO\\VieNeu-TTS\\.venv\\Scripts\\python.exe';
const hyperframes = path.join(root, 'node_modules', 'hyperframes', 'bin', 'hyperframes.mjs');
const fps = 30;

export function command(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      windowsHide: true,
      timeout: options.timeout ?? 120_000,
      killSignal: 'SIGKILL',
      cwd: options.cwd,
      env: { ...process.env, HF_HUB_OFFLINE: '1', HYPERFRAMES_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1' },
    });
    let out = '';
    let error = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { out = (out + chunk).slice(-24000); });
    if (options.onProgress) {
      createInterface({ input: child.stdout }).on('line', line => {
        if (!line.startsWith('@hf-progress ')) return;
        try {
          const { pct } = JSON.parse(line.slice('@hf-progress '.length));
          if (Number.isFinite(pct)) options.onProgress(Math.round(pct));
        } catch { /* Continue if a renderer progress event is incomplete. */ }
      });
    }
    child.stderr.setEncoding('utf8').on('data', chunk => { error = (error + chunk).slice(-12000); });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve(out.trim());
      else reject(new Error(error.trim() || out.trim() || file + ' đã dừng trước khi hoàn tất.'));
    });
  });
}

export async function probe(file) {
  return JSON.parse(await command('ffprobe', [
    '-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate,duration,sample_rate:format=duration',
    '-of', 'json', file,
  ]));
}

function composition(scenes, plan, hasBackground, style)  {
  const { duration, mainDuration, outro } = plan;
  const timed = (start, length, track) => ' data-start="' + start + '" data-duration="' + length +
    '" data-track-index="' + track + '"';
  const cards = scenes.flatMap((scene, index) => {
    const pages = quotePages(scene.quote);
    const length = scene.duration / pages.length;
    return pages.map((quote, page) => '<section id="card-' + index + '-' + page +
      '" class="clip thread-shot" style="--card-x:' + scene.position.x + '%;--card-y:' + scene.position.y + '%"' +
      timed(scene.start + page * length, length, 2) + '>' +
      cardMarkup({ ...scene, quote }) + '</section>');
  });
  const backdrop = hasBackground
    ? '<video id="background" class="clip thread-backdrop" src="background.mp4"' + timed(0, mainDuration, 0) +
      ' muted playsinline></video><div id="scrim" class="clip thread-backdrop thread-scrim"' +
      timed(0, mainDuration, 1) + '></div>'
    : gridMarkup;

  const ending = outro ? outroMarkup(outro, {
    timing: ' id="follow-outro"' + timed(mainDuration, duration - mainDuration, 4),
    freeze: hasBackground ? 'freeze.jpg' : null,
  }) : '';
  const animation = outro ? '<script src="gsap.min.js"></script><script>' +
    'const endingTimeline = gsap.timeline({ paused: true });(' + addOutroAnimation.toString() +
    ')(endingTimeline,document.getElementById("follow-outro"),' + mainDuration + ');' +
    'window.__timelines = {"threads-video": endingTimeline};</script>' : '';

  return '<!doctype html><html lang="vi"><head><meta charset="UTF-8"><style>' +
    '*{box-sizing:border-box}body{margin:0;background:#050609}#stage{position:relative;width:1080px;height:1920px;overflow:hidden}' +
    style + '</style></head><body><main id="stage" class="thread-stage" data-composition-id="threads-video"' +
    (outro ? ' ' : ' data-no-timeline ') +
    'data-start="0" data-width="1080" data-height="1920" data-duration="' + duration + '">' +
    backdrop + cards.join('\n') + ending +
    '<audio id="narration" class="clip" src="narration.wav"' + timed(0, duration, 3) + ' data-volume="1"></audio>' +
    '</main>' + animation + '</body></html>';
}

async function generateNarration(folder, scenes, { intro, reactions, outro }) {
  await writeFile(path.join(folder, 'lines.json'), JSON.stringify(scenes.map(scene => scene.read)));
  await command(python, ['-X', 'utf8', '-B', path.join(root, 'tts.py'), folder], {
    cwd: path.resolve(path.dirname(python), '..', '..'),
    timeout: 600_000,
  });
  const timings = JSON.parse(await readFile(path.join(folder, 'speech.json'), 'utf8'));
  let elapsed = 0;
  const timeline = timings.map((speechDuration, index) => {
    if (!(speechDuration > 0)) throw new Error('VieNeu-TTS trả về đoạn âm thanh rỗng.');
    const opening = index === 0 ? intro?.duration ?? 0 : 0;
    const reaction = reactions[index];
    const scene = { start: elapsed, duration: speechDuration + opening + (reaction?.duration ?? 0), reaction };
    elapsed += scene.duration;
    return scene;
  });
  const duration = Math.ceil((elapsed + (outro ? outroDuration : 0)) * fps) / fps;
  if (!outro) timeline.at(-1).duration += duration - elapsed;
  return { duration, mainDuration: outro ? elapsed : duration, scenes: timeline, intro, outro };
}

async function prepareMedia(folder, background, scenes, plan, music) {
  await mixAudio(folder, plan, music, command);
  const ffmpeg = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y'];

  if (background) await command('ffmpeg', [...ffmpeg, '-stream_loop', '-1', '-i', background, '-map', '0:v:0', '-an',
    '-vf', 'scale=1080:1920:force_original_aspect_ratio=increase:force_divisible_by=2:reset_sar=1,crop=1080:1920,fps=30',
    '-t', String(plan.mainDuration), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19',
    '-pix_fmt', 'yuv420p', '-g', '30', '-movflags', '+faststart', 'background.mp4'], { cwd: folder, timeout: 300_000 });

  let style = await readFile(path.join(root, 'public', 'thread-card.css'), 'utf8');
  if (plan.outro) {
    const assets = [
      copyFile(path.join(root, 'node_modules', 'gsap', 'dist', 'gsap.min.js'), path.join(folder, 'gsap.min.js')),
      copyFile(path.join(root, 'public', 'lapzone-logo.svg'), path.join(folder, 'lapzone-logo.svg')),
    ];
    if (background) {
      assets.push(command('ffmpeg', [...ffmpeg, '-sseof', '-0.16', '-i', 'background.mp4',
        '-vf', 'reverse', '-frames:v', '1', '-q:v', '2', '-update', '1', 'freeze.jpg'], { cwd: folder }));
    }
    await Promise.all(assets);
    style += '\n' + await readFile(path.join(root, 'public', 'outro.css'), 'utf8');
  }
  const timedScenes = scenes.map((scene, index) => ({ ...scene, ...plan.scenes[index] }));
  await writeFile(path.join(folder, 'index.html'), composition(timedScenes, plan, Boolean(background), style));
}

export async function renderVideo(folder, background, scenes, audioOptions, update, state) {
  if (!state.narration) {
    update({ status: 'voice' });
    state.narration = await generateNarration(folder, scenes, audioOptions);
  }
  const { duration } = state.narration;
  if (!state.prepared) {
    update({ status: 'media', duration });
    await prepareMedia(folder, background, scenes, state.narration, audioOptions.music);
    state.prepared = true;
  }

  update({ status: 'render', duration, progress: 0 });
  await rm(path.join(folder, 'preview.mp4'), { force: true });
  await command(process.execPath, [hyperframes, 'render', '.', '--output', 'preview.mp4', '--fps',
    String(fps), '--workers', '2', '--quality', 'standard', '--strict'], {
    cwd: folder, timeout: 900_000, onProgress: progress => update({ progress }),
  });
  const metadata = await probe(path.join(folder, 'preview.mp4'));
  const video = metadata.streams.find(stream => stream.codec_type === 'video');
  const audio = metadata.streams.find(stream => stream.codec_type === 'audio');
  if (video?.codec_name !== 'h264' || video.width !== 1080 || video.height !== 1920 ||
      video.r_frame_rate !== '30/1' || audio?.codec_name !== 'aac') {
    throw new Error('File dựng không đúng định dạng MP4 đã chọn.');
  }
  const voice = await readFile(path.join(folder, 'voice.txt'), 'utf8');
  update({ status: 'ready', duration: Number(metadata.format.duration), voice });
}
