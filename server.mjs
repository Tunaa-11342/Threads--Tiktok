import express from 'express';
import { spawn } from 'node:child_process';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { constants, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeThreadsProfile, getThread, threadUrl } from './threads.mjs';
import { command, probe, renderVideo } from './video.mjs';
import { prepareSoundEffect, renderBuiltinEffect } from './audio.mjs';
import { cardPosition } from './public/placement.mjs';
import { effectChoices, effectFilePrefix } from './public/effect-options.mjs';
import { normalizeOutro } from './public/outro.mjs';
import { ensureVoiceCache, ttsCacheFolder } from './voice-cache.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const output = path.resolve(root, '..', 'Xuất ra');
const musicFolder = path.join(root, 'Nhạc nền');
const effectFolder = path.join(root, 'Sound Effects');
const memeFolder = path.join(root, 'Memes');
const fontFolder = path.join(root, 'Fonts');
const avatarFolder = path.join(root, 'Avatars');

// Support normalized directory name for Video nền
const existingRootEntries = await readdir(root).catch(() => []);
const bgEntry = existingRootEntries.find(e => e.normalize('NFC') === 'Video nền') || 'Video nền';
const backgroundFolder = path.join(root, bgEntry);

await Promise.all([musicFolder, effectFolder, backgroundFolder, memeFolder, fontFolder, avatarFolder, ttsCacheFolder, output]
  .map(folder => mkdir(folder, { recursive: true })));

const builtInEffects = new Set(effectChoices.map(([key]) => key));
const audioFormats = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac', '.opus', '.wma']);
const videoFormats = new Set(['.mp4', '.mov', '.mkv', '.webm', '.m4v']);
const imageFormats = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);
const memeFormats = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.mp4', '.webm', '.mov']);
const fontFormats = new Set(['.ttf', '.otf', '.woff', '.woff2']);

const work = await mkdtemp(path.join(os.tmpdir(), 'threads-to-video-'));
const port = 3917;
const host = '127.0.0.1';
const origin = 'http://' + host + ':' + port;
const app = express();
const upload = multer({ dest: work, limits: { files: 1, fileSize: 500 * 1024 * 1024 } });
const backgrounds = new Map();
const jobs = new Map();
let reading = false;
let busy = false;
let lastFailed;

app.disable('x-powered-by');
app.use((req, res, next) => {
  if (req.get('host') !== host + ':' + port ||
      (req.method === 'POST' && req.get('origin') && req.get('origin') !== origin) ||
      req.get('sec-fetch-site') === 'cross-site') {
    return res.status(403).json({ error: 'Mở tool bằng địa chỉ ' + origin });
  }
  res.set('X-Content-Type-Options', 'nosniff');
  return next();
});
app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(root, 'public')));
app.get('/gsap.min.js', (_req, res) => res.sendFile(path.join(root, 'node_modules', 'gsap', 'dist', 'gsap.min.js')));
app.get('/lucide.min.js', (_req, res) => res.sendFile(path.join(root, 'node_modules', 'lucide', 'dist', 'umd', 'lucide.min.js')));

// Static media access
app.use('/media/music', express.static(musicFolder));
app.use('/media/effects', express.static(effectFolder));
app.use('/media/backgrounds', express.static(backgroundFolder));
app.use('/media/memes', express.static(memeFolder));
app.use('/media/fonts', express.static(fontFolder));
app.use('/media/avatars', express.static(avatarFolder));
app.use('/media/cache_tts', express.static(ttsCacheFolder, { dotfiles: 'allow' }));

app.post('/api/thread', async (req, res) => {
  if (reading) return res.status(409).json({ error: 'Tool đang lấy một bài khác.' });
  const url = threadUrl(req.body?.url);
  if (!url) return res.status(400).json({ error: 'Dán link bài viết công khai từ Threads.' });
  reading = true;
  try {
    return res.json(await getThread(url));
  } catch (error) {
    console.error('Threads:', error.message);
    return res.status(502).json({ error: 'Không tải được trang Threads. Thử lại hoặc dán nội dung bên dưới.' });
  } finally {
    reading = false;
  }
});

// Video background upload (single session background or library)
app.post('/api/background', upload.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Chọn một file video nền.' });
  try {
    const metadata = await probe(req.file.path);
    const video = metadata.streams?.find(stream => stream.codec_type === 'video' && stream.width && stream.height);
    if (!video || !(Number(metadata.format?.duration) > 0)) throw new Error('No video stream');
    const id = randomUUID();
    backgrounds.set(id, req.file.path);
    return res.json({ id });
  } catch (error) {
    await rm(req.file.path, { force: true }).catch(() => {});
    return res.status(400).json({ error: 'Không đọc được video nền. Hãy chọn file MP4 hoặc video khác.' });
  }
});

async function listFiles(folder, extensions) {
  const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
  return entries.filter(entry => entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase()))
    .map(entry => entry.name).sort((a, b) => a.localeCompare(b, 'vi'));
}

async function saveFileToFolder(tempPath, originalName, destFolder) {
  const ext = path.extname(originalName).toLowerCase();
  const rawBase = path.basename(originalName, ext).replace(/[^\w\s.-]/gu, '').trim() || 'file';
  let targetName = `${rawBase}${ext}`;
  let targetPath = path.join(destFolder, targetName);
  let counter = 1;
  while (existsSync(targetPath)) {
    targetName = `${rawBase}-${counter++}${ext}`;
    targetPath = path.join(destFolder, targetName);
  }
  await copyFile(tempPath, targetPath);
  await rm(tempPath, { force: true }).catch(() => {});
  return targetName;
}

app.get('/api/music', async (_req, res) => {
  res.set('Cache-Control', 'no-store');
  return res.json({ tracks: await listFiles(musicFolder, audioFormats) });
});

app.get('/api/effects', async (_req, res) => {
  res.set('Cache-Control', 'no-store');
  const files = await listFiles(effectFolder, audioFormats);
  const durations = {};
  await Promise.all(files.map(async name => {
    try {
      const meta = await probe(path.join(effectFolder, name));
      const stream = meta.streams?.find(s => s.codec_type === 'audio');
      durations[name] = Math.round((Number(stream?.duration) || Number(meta.format?.duration) || 1) * 10) / 10;
    } catch {
      durations[name] = 1;
    }
  }));
  return res.json({ tracks: files, durations });
});

app.post('/api/effects/upload', upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Chọn một file âm thanh để tải lên.' });
  try {
    const metadata = await probe(req.file.path);
    const stream = metadata.streams?.find(s => s.codec_type === 'audio');
    if (!stream) throw new Error('File không chứa luồng âm thanh hợp lệ.');
    const savedName = await saveFileToFolder(req.file.path, req.file.originalname, effectFolder);
    return res.json({ file: savedName, tracks: await listFiles(effectFolder, audioFormats) });
  } catch (error) {
    await rm(req.file.path, { force: true }).catch(() => {});
    return res.status(400).json({ error: 'Không đọc được file âm thanh: ' + error.message });
  }
});

app.get('/api/backgrounds', async (_req, res) => {
  res.set('Cache-Control', 'no-store');
  const files = await listFiles(backgroundFolder, videoFormats);
  const tracks = await Promise.all(files.map(async name => {
    try {
      const meta = await probe(path.join(backgroundFolder, name));
      const duration = Number(meta.format?.duration) || 0;
      return { name, duration: Math.round(duration * 10) / 10 };
    } catch {
      return { name, duration: 0 };
    }
  }));
  return res.json({ tracks });
});

app.post('/api/backgrounds/upload', upload.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Chọn một file video để tải lên.' });
  try {
    const metadata = await probe(req.file.path);
    const video = metadata.streams?.find(stream => stream.codec_type === 'video' && stream.width && stream.height);
    if (!video || !(Number(metadata.format?.duration) > 0)) throw new Error('No video stream');
    const savedName = await saveFileToFolder(req.file.path, req.file.originalname, backgroundFolder);
    const files = await listFiles(backgroundFolder, videoFormats);
    const tracks = await Promise.all(files.map(async name => {
      try {
        const meta = await probe(path.join(backgroundFolder, name));
        return { name, duration: Math.round((Number(meta.format?.duration) || 0) * 10) / 10 };
      } catch {
        return { name, duration: 0 };
      }
    }));
    return res.json({ file: savedName, tracks });
  } catch (error) {
    await rm(req.file.path, { force: true }).catch(() => {});
    return res.status(400).json({ error: 'Không đọc được file video. Vui lòng thử lại.' });
  }
});

app.get('/api/memes', async (_req, res) => {
  res.set('Cache-Control', 'no-store');
  const files = await listFiles(memeFolder, memeFormats);
  const details = {};
  await Promise.all(files.map(async name => {
    const ext = path.extname(name).toLowerCase();
    const isVideo = ['.mp4', '.webm', '.mov'].includes(ext);
    let duration = 0;
    if (isVideo) {
      try {
        const meta = await probe(path.join(memeFolder, name));
        duration = Math.round((Number(meta.format?.duration) || 0) * 10) / 10;
      } catch {}
    }
    details[name] = { isVideo, duration };
  }));
  return res.json({ tracks: files, details });
});

app.post('/api/memes/upload', upload.single('media'), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'Chọn một file ảnh, GIF hoặc video meme.' });
  try {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!memeFormats.has(ext)) throw new Error('Định dạng không hỗ trợ. Hãy chọn file ảnh (.png, .jpg, .webp), GIF (.gif) hoặc video (.mp4, .webm, .mov).');
    const savedName = await saveFileToFolder(file.path, file.originalname, memeFolder);
    const files = await listFiles(memeFolder, memeFormats);
    let isVideo = ['.mp4', '.webm', '.mov'].includes(ext);
    let duration = 0;
    if (isVideo) {
      try {
        const meta = await probe(path.join(memeFolder, savedName));
        duration = Math.round((Number(meta.format?.duration) || 0) * 10) / 10;
      } catch {}
    }
    return res.json({ file: savedName, tracks: files, isVideo, duration });
  } catch (error) {
    if (file) await rm(file.path, { force: true }).catch(() => {});
    return res.status(400).json({ error: 'Không lưu được meme: ' + error.message });
  }
});

app.get('/api/avatars', async (_req, res) => {
  res.set('Cache-Control', 'no-store');
  const files = await listFiles(avatarFolder, imageFormats);
  return res.json({ tracks: files });
});

app.post('/api/avatars/upload', upload.single('avatar'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Chọn một file ảnh đại diện.' });
  try {
    const ext = path.extname(req.file.originalname).toLowerCase();
    if (!imageFormats.has(ext)) throw new Error('Định dạng không hỗ trợ. Hãy chọn file ảnh (.png, .jpg, .jpeg, .webp, .svg).');
    const savedName = await saveFileToFolder(req.file.path, req.file.originalname, avatarFolder);
    return res.json({ file: savedName, url: `/media/avatars/${encodeURIComponent(savedName)}` });
  } catch (error) {
    await rm(req.file.path, { force: true }).catch(() => {});
    return res.status(400).json({ error: 'Không lưu được avatar: ' + error.message });
  }
});

app.get('/api/fonts', async (_req, res) => {
  res.set('Cache-Control', 'no-store');
  const customFiles = await listFiles(fontFolder, fontFormats);
  const defaultFonts = [
    { name: 'Be Vietnam Pro', file: 'BeVietnamPro-Bold.ttf', isDefault: true },
  ];
  const custom = customFiles.map(name => ({
    name: path.basename(name, path.extname(name)),
    file: name,
    url: `/media/fonts/${encodeURIComponent(name)}`,
  }));
  return res.json({
    fonts: [...defaultFonts, ...custom],
    custom,
  });
});

app.post('/api/fonts/upload', upload.single('font'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Chọn một file font (.ttf, .otf, .woff, .woff2).' });
  try {
    const ext = path.extname(req.file.originalname).toLowerCase();
    if (!fontFormats.has(ext)) throw new Error('Định dạng font không hỗ trợ. Hãy chọn .ttf, .otf, .woff hoặc .woff2');
    const savedName = await saveFileToFolder(req.file.path, req.file.originalname, fontFolder);
    const customFiles = await listFiles(fontFolder, fontFormats);
    const fontName = path.basename(savedName, path.extname(savedName));
    return res.json({
      name: fontName,
      file: savedName,
      custom: customFiles.map(name => ({
        name: path.basename(name, path.extname(name)),
        file: name,
        url: `/media/fonts/${encodeURIComponent(name)}`,
      })),
    });
  } catch (error) {
    await rm(req.file.path, { force: true }).catch(() => {});
    return res.status(400).json({ error: error.message });
  }
});

// Sound effect preview endpoint
app.get('/api/effects/audio/:name', async (req, res) => {
  const rawName = req.params.name;
  if (!rawName || rawName === 'off') return res.sendStatus(404);
  const cleanName = rawName.startsWith(effectFilePrefix) ? rawName.slice(effectFilePrefix.length) : rawName;

  const customPath = path.join(effectFolder, cleanName);
  if (existsSync(customPath)) {
    return res.sendFile(path.resolve(customPath), { dotfiles: 'allow' });
  }

  let variantName = cleanName;
  if (variantName === 'auto') {
    const files = await listFiles(effectFolder, audioFormats);
    if (files.length > 0) {
      return res.sendFile(path.resolve(path.join(effectFolder, files[0])), { dotfiles: 'allow' });
    }
    variantName = 'ting';
  }

  // Built-in effect synthesis
  try {
    const builtinDir = path.join(ttsCacheFolder, 'builtin_effects');
    await mkdir(builtinDir, { recursive: true });
    const targetWav = path.join(builtinDir, `${variantName}.wav`);
    if (!existsSync(targetWav)) {
      await renderBuiltinEffect(variantName, targetWav, command);
    }
    return res.sendFile(path.resolve(targetWav), { dotfiles: 'allow' });
  } catch (err) {
    console.error('Audio preview error:', err);
    return res.sendStatus(500);
  }
});

// Smart TTS endpoint for Live Preview & Audio Pre-generation
app.post('/api/voice', async (req, res) => {
  const lines = req.body?.lines;
  if (!Array.isArray(lines) || !lines.length) {
    return res.status(400).json({ error: 'Danh sách lời đọc không hợp lệ.' });
  }
  try {
    const cachedItems = await ensureVoiceCache(lines, work);
    const timings = cachedItems.map(item => item.duration);
    const voice = cachedItems[0]?.voice || 'Trúc Ly';
    const items = cachedItems.map(item => ({
      hash: item.hash,
      duration: item.duration,
      url: `/media/cache_tts/${item.hash}/speech.wav`,
    }));
    return res.json({ voice, timings, items });
  } catch (error) {
    console.error('Voice cache error:', error);
    return res.status(500).json({ error: 'Không tạo được giọng đọc: ' + error.message });
  }
});

function effectMode(value, fallback) {
  return typeof value === 'string' && (builtInEffects.has(value) || value.startsWith(effectFilePrefix)) ? value : fallback;
}

function readScenes(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 5) return null;
  const clean = (value, length) => typeof value === 'string' ? value.trim().slice(0, length) : '';
  const scenes = input.map(scene => ({
    id: scene?.id,
    position: cardPosition(scene?.position),
    effect: effectMode(scene?.effect, 'auto'),
    edited: scene?.edited === true || String(scene?.id ?? '').length === 36,
    metrics: Object.fromEntries(['likes', 'replies', 'reposts', 'shares']
      .map(key => [key, clean(scene?.metrics?.[key], 20)])),
    quote: clean(scene?.quote, 5000),
    read: clean(scene?.read, 600),
    author: clean(scene?.author, 70),
    approximate: scene?.approximate === true,
    likes: Number.isSafeInteger(scene?.likes) && scene.likes >= 0 ? scene.likes : null,
    meme: scene?.meme && scene.meme.file ? {
      file: clean(scene.meme.file, 200),
      x: Number(scene.meme.x) || 50,
      y: Number(scene.meme.y) || 62,
      scale: (Number(scene.meme.scale) > 10 ? Number(scene.meme.scale) / 100 : Number(scene.meme.scale)) || 1,
      rotation: Number(scene.meme.rotation) || 0,
      timing: scene.meme.timing === 'after_read' ? 'after_read' : 'with_card',
      duration: Number(scene.meme.duration) || 0,
    } : null,
  }));
  return scenes.every(scene => scene.quote && scene.read) ? scenes : null;
}

// Build render job
async function startRenderJob(backgroundPath, scenes, { introEffect, music, outro, captions, backgroundStart }) {
  const effect = effectMode(introEffect, 'auto');
  const settings = normalizeOutro(outro);
  const activeOutro = settings.enabled ? settings : null;

  let musicFile;
  let modified;
  if (music) {
    if (!(await listFiles(musicFolder, audioFormats)).includes(music)) {
      throw new Error('File nhạc đã đổi hoặc bị chuyển. Bấm Làm mới rồi chọn lại.');
    }
    musicFile = path.join(musicFolder, music);
    const metadata = await stat(musicFile);
    modified = metadata.mtimeMs;
  }

  const files = await listFiles(effectFolder, audioFormats);
  const assets = await Promise.all(files.map(async name => {
    const file = path.join(effectFolder, name);
    const metadata = await stat(file).catch(() => null);
    return [name, metadata?.isFile() ? { path: file, modified: metadata.mtimeMs } : null];
  }));
  const effectFiles = new Map(assets.filter(([, file]) => file));
  const [intro, ...reactions] = await Promise.all([
    prepareSoundEffect(effect, effectFiles, scenes[0].quote, probe, true),
    ...scenes.map((scene, index) => index ? prepareSoundEffect(scene.effect, effectFiles, index - 1, probe) : null),
  ]);

  const fingerprint = JSON.stringify([backgroundPath, scenes, intro, reactions, musicFile, modified, activeOutro, captions, backgroundStart]);
  const retry = lastFailed?.fingerprint === fingerprint;
  const id = retry ? lastFailed.id : randomUUID();
  const folder = path.join(work, id);
  const job = retry ? lastFailed : { id, folder, fingerprint, state: {} };
  Object.assign(job, { status: 'voice', error: undefined, progress: undefined });
  jobs.set(id, job);

  // Run async
  (async () => {
    try {
      await mkdir(folder, { recursive: true });
      await renderVideo(folder, backgroundPath, scenes, {
        intro, reactions, music: musicFile, outro: activeOutro, captions,
        backgroundStart: Number(backgroundStart) || 0
      }, patch => Object.assign(job, patch), job.state);
      lastFailed = undefined;
    } catch (error) {
      console.error('Dựng video:', error.message);
      job.error = ({
        voice: 'VieNeu-TTS chưa tạo được giọng đọc. Kiểm tra bản cài VieNeu-TTS rồi thử lại.',
        media: 'Không xử lý được âm thanh, nhạc nền hoặc video nền. Kiểm tra các file đã chọn.',
        render: 'HyperFrames chưa dựng xong clip. Kiểm tra cửa sổ chạy tool rồi thử lại.',
      })[job.status] || error.message;
      job.status = 'error';
      lastFailed = job;
    } finally {
      busy = false;
    }
  })();

  return id;
}

// Full preview render
app.post('/api/preview', async (req, res) => {
  if (busy) return res.status(409).json({ error: 'Đang dựng một clip. Chờ clip đó hoàn thành.' });
  const background = req.body?.backgroundFile
    ? path.join(backgroundFolder, req.body.backgroundFile)
    : backgrounds.get(req.body?.background);
  const scenes = readScenes(req.body?.scenes);
  if ((req.body?.background || req.body?.backgroundFile) && !background) {
    return res.status(400).json({ error: 'Chọn video nền lại để tiếp tục.' });
  }
  if (!scenes) return res.status(400).json({ error: 'Thêm bài và điền lời đọc cho mỗi cảnh.' });

  const captions = req.body?.captions ? {
    enabled: Boolean(req.body.captions.enabled),
    wordsPerLine: Math.max(3, Math.min(15, Number(req.body.captions.wordsPerLine) || 7)),
    y: Number(req.body.captions.y) || 75,
    font: typeof req.body.captions.font === 'string' ? req.body.captions.font.trim() : 'Be Vietnam Pro',
  } : { enabled: false };

  busy = true;
  try {
    const id = await startRenderJob(background, scenes, {
      introEffect: req.body?.introEffect,
      music: req.body?.music,
      outro: req.body?.outro,
      captions,
      backgroundStart: Number(req.body?.backgroundStart) || 0,
    });
    return res.status(202).json({ id });
  } catch (error) {
    busy = false;
    return res.status(400).json({ error: error.message });
  }
});

// Single scene segment preview render
app.post('/api/preview/scene', async (req, res) => {
  if (busy) return res.status(409).json({ error: 'Đang dựng một clip. Chờ clip đó hoàn thành.' });
  const sceneIdx = Number(req.body?.sceneIndex) || 0;
  const allScenes = readScenes(req.body?.scenes);
  if (!allScenes || !allScenes[sceneIdx]) {
    return res.status(400).json({ error: 'Cảnh không hợp lệ.' });
  }
  const singleScene = [allScenes[sceneIdx]];
  const background = req.body?.backgroundFile
    ? path.join(backgroundFolder, req.body.backgroundFile)
    : backgrounds.get(req.body?.background);

  const captions = req.body?.captions ? {
    enabled: Boolean(req.body.captions.enabled),
    wordsPerLine: Math.max(3, Math.min(15, Number(req.body.captions.wordsPerLine) || 7)),
    y: Number(req.body.captions.y) || 75,
  } : { enabled: false };

  busy = true;
  try {
    const id = await startRenderJob(background, singleScene, {
      introEffect: sceneIdx === 0 ? req.body?.introEffect : 'off',
      music: req.body?.music,
      outro: null,
      captions,
    });
    return res.status(202).json({ id });
  } catch (error) {
    busy = false;
    return res.status(400).json({ error: error.message });
  }
});

app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  res.set('Cache-Control', 'no-store');
  if (!job) return res.status(404).json({ error: 'Bản xem trước đã hết phiên.' });
  const { status, duration, voice, error, progress } = job;
  return res.json({ status, duration, voice, error, progress });
});

app.get('/api/jobs/:id/video', (req, res) => {
  const job = jobs.get(req.params.id);
  if (job?.status !== 'ready') return res.sendStatus(404);
  return res.sendFile(path.join(job.folder, 'preview.mp4'));
});

app.post('/api/jobs/:id/export', async (req, res) => {
  const job = jobs.get(req.params.id);
  if (job?.status !== 'ready') return res.status(404).json({ error: 'Hãy tạo bản xem trước trước khi xuất.' });
  const name = 'Threads-' + new Date().toISOString().slice(0, 19).replaceAll(':', '-') + '-' + job.id.slice(0, 8) + '.mp4';
  if (!job.exportPromise) {
    job.exportPromise = (async () => {
      await mkdir(output, { recursive: true });
      const destination = path.join(output, name);
      await copyFile(path.join(job.folder, 'preview.mp4'), destination, constants.COPYFILE_EXCL);
      return { name, path: destination };
    })().catch(error => {
      job.exportPromise = null;
      throw error;
    });
  }
  return res.json(await job.exportPromise);
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File tải lên vượt quá giới hạn.' });
  console.error(error.message);
  return res.status(error.status === 400 ? 400 : 500).json({ error: 'Tool không xử lý được yêu cầu. Thử lại.' });
});

function openEditor() {
  if (!process.argv.includes('--open')) return;
  const cmd = process.platform === 'darwin' ? 'open' : 'rundll32.exe';
  const args = process.platform === 'darwin' ? [origin] : ['url.dll,FileProtocolHandler', origin];
  const browser = spawn(cmd, args, {
    windowsHide: true, stdio: 'ignore', detached: true,
  });
  browser.on('error', () => console.log('Mở tool trong trình duyệt: ' + origin));
  browser.unref();
}

const server = app.listen(port, host, () => {
  console.log('Threads → TikTok: ' + origin);
  openEditor();
});
server.on('error', async error => {
  if (error.code === 'EADDRINUSE') {
    console.log('Tool đang chạy tại ' + origin);
    openEditor();
  } else {
    console.error(error.message);
    process.exitCode = 1;
  }
  await rm(work, { recursive: true, force: true });
});
process.once('SIGINT', () => {
  server.close();
  Promise.allSettled([closeThreadsProfile(), rm(work, { recursive: true, force: true })]).finally(() => process.exit());
});
