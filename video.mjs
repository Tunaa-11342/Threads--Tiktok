import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { copyFile, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mixAudio } from './audio.mjs';
import { cardMarkup, gridMarkup, quotePages } from './public/thread-card.mjs';
import { addOutroAnimation, outroDuration, outroMarkup } from './public/outro.mjs';
import { captionsMarkup, addCaptionsAnimation } from './public/captions.mjs';
import { ensureVoiceCache } from './voice-cache.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const defaultPython = process.platform === 'darwin'
  ? '/Volumes/Data/VieNeu-TTS/.venv/bin/python'
  : 'E:\\24h\\AI MAKE VIDEO\\VieNeu-TTS\\.venv\\Scripts\\python.exe';
const python = process.env.VIENEU_PYTHON || defaultPython;
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

function composition(scenes, plan, hasBackground, style) {
  const { duration, mainDuration, outro, captions } = plan;
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

  const memes = scenes.map((scene, index) => {
    if (!scene.meme?.file) return '';
    const memePath = path.join(root, 'Memes', scene.meme.file);
    if (!existsSync(memePath)) return '';
    const rawScale = Number(scene.meme.scale) || 1;
    const scale = rawScale > 10 ? rawScale / 100 : rawScale;
    const isAfterRead = scene.meme.timing === 'after_read';
    const opening = index === 0 ? plan.intro?.duration ?? 0 : 0;
    const speechDur = scene.speechDur || Math.max(0.5, scene.duration - opening - (scene.reaction?.duration ?? 0));
    const mStart = isAfterRead ? (scene.start + opening + speechDur) : scene.start;
    const mDur = isAfterRead ? Math.max(0.4, scene.duration - (opening + speechDur)) : scene.duration;

    const ext = path.extname(scene.meme.file).toLowerCase();
    const isVideo = ['.mp4', '.webm', '.mov'].includes(ext);
    if (isVideo) {
      return '<video id="meme-' + index + '" class="clip thread-meme" style="--meme-x:' +
        (scene.meme.x ?? 50) + '%;--meme-y:' + (scene.meme.y ?? 62) + '%;--meme-scale:' +
        scale + ';--meme-rot:' + (scene.meme.rotation ?? 0) + 'deg;"' +
        timed(mStart, mDur, 5) + ' src="' + scene.meme.file + '" muted playsinline autoplay loop></video>';
    }

    return '<div id="meme-' + index + '" class="clip thread-meme" style="--meme-x:' +
      (scene.meme.x ?? 50) + '%;--meme-y:' + (scene.meme.y ?? 62) + '%;--meme-scale:' +
      scale + ';--meme-rot:' + (scene.meme.rotation ?? 0) + 'deg;"' +
      timed(mStart, mDur, 5) + '><img src="' + scene.meme.file + '" alt="meme"></div>';
  }).filter(Boolean);

  const shouldExtendBgForOutro = Boolean(outro && outro.blurBackground !== false);
  const bgDuration = shouldExtendBgForOutro ? duration : mainDuration;
  const backdrop = hasBackground
    ? '<video id="background" class="clip thread-backdrop" src="background.mp4"' + timed(0, bgDuration, 0) +
      ' muted playsinline></video><div id="scrim" class="clip thread-backdrop thread-scrim"' +
      timed(0, mainDuration, 1) + '></div>'
    : gridMarkup;

  const activeOutro = outro ? {
    ...outro,
    avatar: outro.avatar ? path.basename(outro.avatar) : 'lapzone-logo.svg',
  } : null;
  const ending = activeOutro ? outroMarkup(activeOutro, {
    timing: ' id="follow-outro"' + timed(mainDuration, duration - mainDuration, 4),
    blurBackground: Boolean(hasBackground && activeOutro.blurBackground !== false),
  }) : '';

  const captionsHtml = captions?.enabled ? scenes.map((scene, index) => {
    const opening = index === 0 ? plan.intro?.duration ?? 0 : 0;
    const speechDur = scene.speechDur || Math.max(0.5, scene.duration - opening - (scene.reaction?.duration ?? 0));
    return captionsMarkup(scene.read, speechDur, captions.wordsPerLine || 7, index, captions.y || 75, opening);
  }).join('\n') : '';

  const hasAnimation = Boolean(outro || captions?.enabled);
  const animationScript = hasAnimation ? '<script src="gsap.min.js"></script><script>' +
    'const masterTimeline = gsap.timeline({ paused: true });\n' +
    (outro ? '(' + addOutroAnimation.toString() + ')(masterTimeline,document.getElementById("follow-outro"),' + mainDuration + ');\n' : '') +
    (captions?.enabled ? 'const addCaptionsAnim = ' + addCaptionsAnimation.toString() + ';\n' +
      'const sceneStarts = ' + JSON.stringify(scenes.map(s => s.start)) + ';\n' +
      'document.querySelectorAll(".tiktok-captions-container").forEach((el, idx) => {\n' +
      '  addCaptionsAnim(masterTimeline, el, sceneStarts[idx] || 0);\n' +
      '});\n' : '') +
    'window.__timelines = {"threads-video": masterTimeline};\n</script>' : '';

  return '<!doctype html><html lang="vi"><head><meta charset="UTF-8"><style>' +
    '*{box-sizing:border-box}body{margin:0;background:#050609}#stage{position:relative;width:1080px;height:1920px;overflow:hidden}' +
    style + '</style></head><body><main id="stage" class="thread-stage" data-composition-id="threads-video"' +
    (hasAnimation ? ' ' : ' data-no-timeline ') +
    'data-start="0" data-width="1080" data-height="1920" data-duration="' + duration + '">' +
    backdrop + cards.join('\n') + memes.join('\n') + captionsHtml + ending +
    '<audio id="narration" class="clip" src="narration.wav"' + timed(0, duration, 3) + ' data-volume="1"></audio>' +
    '</main>' + animationScript + '</body></html>';
}

async function generateNarration(folder, scenes, { intro, reactions, outro, captions, backgroundStart }) {
  const cachedItems = await ensureVoiceCache(scenes.map(scene => scene.read), folder);
  const timings = [];
  let voiceName = 'Trúc Ly';
  for (let index = 0; index < cachedItems.length; index++) {
    const item = cachedItems[index];
    await copyFile(item.wavFile, path.join(folder, `speech-${index}.wav`));
    timings.push(item.duration);
    if (item.voice) voiceName = item.voice;
  }
  await writeFile(path.join(folder, 'speech.json'), JSON.stringify(timings), 'utf8');
  await writeFile(path.join(folder, 'voice.txt'), voiceName, 'utf8');

  let elapsed = 0;
  const timeline = [];
  for (let index = 0; index < timings.length; index++) {
    const speechDuration = timings[index];
    if (!(speechDuration > 0)) throw new Error('VieNeu-TTS trả về đoạn âm thanh rỗng.');
    const opening = index === 0 ? intro?.duration ?? 0 : 0;
    const reaction = reactions[index];
    const reactionDuration = reaction?.duration ?? 0;

    let memeHold = 0;
    const meme = scenes[index]?.meme;
    if (meme?.file) {
      const ext = path.extname(meme.file).toLowerCase();
      const isVideo = ['.mp4', '.webm', '.mov'].includes(ext);
      let memeDur = Number(meme.duration) || 0;
      if (!memeDur && isVideo) {
        try {
          const meta = await probe(path.join(root, 'Memes', meme.file));
          memeDur = Number(meta.format?.duration) || 0;
        } catch {}
      }
      if (meme.timing === 'after_read') {
        memeHold = memeDur > 0 ? memeDur : (reactionDuration > 0 ? reactionDuration : 1.5);
      } else {
        if (memeDur > speechDuration) {
          memeHold = memeDur - speechDuration;
        }
      }
    }

    const extraHold = Math.max(reactionDuration, memeHold);
    const sceneDur = speechDuration + opening + extraHold;
    const scene = { start: elapsed, duration: sceneDur, reaction, speechDur: speechDuration, extraHold };
    elapsed += sceneDur;
    timeline.push(scene);
  }
  const duration = Math.ceil((elapsed + (outro ? outroDuration : 0)) * fps) / fps;
  if (!outro) timeline.at(-1).duration += duration - elapsed;
  return { duration, mainDuration: outro ? elapsed : duration, scenes: timeline, intro, outro, captions, backgroundStart: backgroundStart || 0 };
}

async function prepareMedia(folder, background, scenes, plan, music) {
  await mixAudio(folder, plan, music, command);
  const ffmpeg = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y'];

  if (background) {
    const bgStart = Number(plan.backgroundStart) || 0;
    const shouldExtendBgForOutro = Boolean(plan.outro && plan.outro.blurBackground !== false);
    const bgRenderDur = shouldExtendBgForOutro ? plan.duration : plan.mainDuration;

    await command('ffmpeg', [...ffmpeg, '-ss', String(bgStart), '-stream_loop', '-1', '-i', background, '-map', '0:v:0', '-an',
      '-vf', 'scale=1080:1920:force_original_aspect_ratio=increase:force_divisible_by=2:reset_sar=1,crop=1080:1920,fps=30',
      '-t', String(bgRenderDur), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19',
      '-pix_fmt', 'yuv420p', '-g', '30', '-movflags', '+faststart', 'background.mp4'], { cwd: folder, timeout: 300_000 });
  }

  // Copy any meme images to folder
  for (const scene of scenes) {
    if (scene.meme?.file) {
      const memePath = path.join(root, 'Memes', scene.meme.file);
      if (existsSync(memePath)) {
        await copyFile(memePath, path.join(folder, scene.meme.file));
      }
    }
  }

  let style = await readFile(path.join(root, 'public', 'thread-card.css'), 'utf8');

  // Copy fonts if captions enabled
  if (plan.captions?.enabled) {
    const defaultFontBlack = path.join(root, 'public', 'fonts', 'BeVietnamPro-Black.ttf');
    const defaultFontBold = path.join(root, 'public', 'fonts', 'BeVietnamPro-Bold.ttf');
    if (existsSync(defaultFontBlack)) await copyFile(defaultFontBlack, path.join(folder, 'BeVietnamPro-Black.ttf')).catch(() => {});
    if (existsSync(defaultFontBold)) await copyFile(defaultFontBold, path.join(folder, 'BeVietnamPro-Bold.ttf')).catch(() => {});

    if (plan.captions.font && plan.captions.font !== 'Be Vietnam Pro') {
      const customFontFiles = await readdir(path.join(root, 'Fonts')).catch(() => []);
      const matched = customFontFiles.find(f => path.basename(f, path.extname(f)).toLowerCase() === plan.captions.font.toLowerCase());
      if (matched) {
        await copyFile(path.join(root, 'Fonts', matched), path.join(folder, matched)).catch(() => {});
        style += `\n@font-face { font-family: '${plan.captions.font}'; src: url('${matched}'); }\n.tiktok-caption-line { font-family: '${plan.captions.font}', 'Be Vietnam Pro', sans-serif !important; }`;
      }
    }
  }

  const needsGsap = Boolean(plan.outro || plan.captions?.enabled);
  if (needsGsap) {
    await copyFile(path.join(root, 'node_modules', 'gsap', 'dist', 'gsap.min.js'), path.join(folder, 'gsap.min.js'));
  }
  if (plan.outro) {
    const avatarFile = plan.outro.avatar ? path.basename(plan.outro.avatar) : 'lapzone-logo.svg';
    const assets = [];
    if (avatarFile === 'lapzone-logo.svg') {
      assets.push(copyFile(path.join(root, 'public', 'lapzone-logo.svg'), path.join(folder, 'lapzone-logo.svg')));
    } else {
      const avatarPath = path.join(root, 'Avatars', avatarFile);
      if (existsSync(avatarPath)) {
        assets.push(copyFile(avatarPath, path.join(folder, avatarFile)));
      } else if (existsSync(path.join(root, 'public', avatarFile))) {
        assets.push(copyFile(path.join(root, 'public', avatarFile), path.join(folder, avatarFile)));
      } else {
        assets.push(copyFile(path.join(root, 'public', 'lapzone-logo.svg'), path.join(folder, 'lapzone-logo.svg')));
      }
    }
    const shouldExtendBgForOutro = Boolean(plan.outro && plan.outro.blurBackground !== false);
    if (background && !shouldExtendBgForOutro) {
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
    String(fps), '--workers', '2', '--quality', 'standard'], {
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
