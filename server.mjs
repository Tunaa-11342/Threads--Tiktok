import express from 'express';
import { spawn } from 'node:child_process';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeThreadsProfile, getThread, threadUrl } from './threads.mjs';
import { probe, renderVideo } from './video.mjs';
import { prepareSoundEffect } from './audio.mjs';
import { cardPosition } from './public/placement.mjs';
import { effectChoices, effectFilePrefix } from './public/effect-options.mjs';
import { normalizeOutro } from './public/outro.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const output = path.resolve(root, '..', 'Xuất ra');
const musicFolder = path.join(root, 'Nhạc nền');
const effectFolder = path.join(root, 'Sound Effects');
await Promise.all([musicFolder, effectFolder].map(folder => mkdir(folder, { recursive: true })));
const builtInEffects = new Set(effectChoices.map(([key]) => key));
const audioFormats = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac', '.opus', '.wma']);
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

async function audioTracks(folder) {
  const entries = await readdir(folder, { withFileTypes: true });
  return entries.filter(entry => entry.isFile() && audioFormats.has(path.extname(entry.name).toLowerCase()))
    .map(entry => entry.name).sort((a, b) => a.localeCompare(b, 'vi'));
}

app.get('/api/music', async (_req, res) => {
  res.set('Cache-Control', 'no-store');
  return res.json({ tracks: await audioTracks(musicFolder) });
});

app.get('/api/effects', async (_req, res) => {
  res.set('Cache-Control', 'no-store');
  return res.json({ tracks: await audioTracks(effectFolder) });
});

function effectMode(value, fallback) {
  return typeof value === 'string' && (builtInEffects.has(value) || value.startsWith(effectFilePrefix)) ? value : fallback;
}

function readScenes(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 5) return null;
  const clean = (value, length) => typeof value === 'string' ? value.trim().slice(0, length) : '';
  const scenes = input.map(scene => ({
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
  }));
  return scenes.every(scene => scene.quote && scene.read) ? scenes : null;
}

app.post('/api/preview', async (req, res) => {
  if (busy) return res.status(409).json({ error: 'Đang dựng một clip. Chờ clip đó hoàn thành.' });
  const background = backgrounds.get(req.body?.background);
  const scenes = readScenes(req.body?.scenes);
  if (req.body?.background && !background) return res.status(400).json({ error: 'Chọn video nền lại để tiếp tục.' });
  if (!scenes) return res.status(400).json({ error: 'Thêm bài và điền lời đọc cho mỗi cảnh.' });
  const effect = effectMode(req.body?.introEffect, 'auto');
  const settings = normalizeOutro(req.body?.outro);
  const outro = settings.enabled ? settings : null;
  let music;
  let modified;
  if (req.body?.music) {
    if (!(await audioTracks(musicFolder)).includes(req.body.music)) {
      return res.status(400).json({ error: 'File nhạc đã đổi hoặc bị chuyển. Bấm Làm mới rồi chọn lại.' });
    }
    music = path.join(musicFolder, req.body.music);
    const metadata = await stat(music);
    modified = metadata.mtimeMs;
  }
  let intro;
  let reactions;
  try {
    const files = await audioTracks(effectFolder);
    const assets = await Promise.all(files.map(async name => {
      const file = path.join(effectFolder, name);
      const metadata = await stat(file).catch(() => null);
      return [name, metadata?.isFile() ? { path: file, modified: metadata.mtimeMs } : null];
    }));
    const effectFiles = new Map(assets.filter(([, file]) => file));
    [intro, ...reactions] = await Promise.all([
      prepareSoundEffect(effect, effectFiles, scenes[0].quote, probe, true),
      ...scenes.map((scene, index) => index ? prepareSoundEffect(scene.effect, effectFiles, index - 1, probe) : null),
    ]);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  if (busy) return res.status(409).json({ error: 'Đang dựng một clip. Chờ clip đó hoàn thành.' });
  busy = true;
  const fingerprint = JSON.stringify([background, scenes, intro, reactions, music, modified, outro]);
  const retry = lastFailed?.fingerprint === fingerprint;
  const id = retry ? lastFailed.id : randomUUID();
  const folder = path.join(work, id);
  const job = retry ? lastFailed : { id, folder, fingerprint, state: {} };
  Object.assign(job, { status: 'voice', error: undefined, progress: undefined });
  jobs.set(id, job);
  res.status(202).json({ id });
  try {
    await mkdir(folder, { recursive: true });
    await renderVideo(folder, background, scenes, { intro, reactions, music, outro }, patch => Object.assign(job, patch), job.state);
    lastFailed = undefined;
  } catch (error) {
    console.error('Dựng video:', error.message);
    job.error = ({
      voice: 'VieNeu-TTS chưa tạo được giọng đọc. Kiểm tra bản cài VieNeu-TTS rồi thử lại.',
      media: 'Không xử lý được âm thanh, nhạc nền hoặc video nền. Kiểm tra các file đã chọn.',
      render: 'HyperFrames chưa dựng xong clip. Kiểm tra cửa sổ chạy tool rồi thử lại.',
    })[job.status];
    job.status = 'error';
    lastFailed = job;
  } finally {
    busy = false;
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
  if (error.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Video nền vượt quá 500 MB.' });
  console.error(error.message);
  return res.status(error.status === 400 ? 400 : 500).json({ error: 'Tool không xử lý được yêu cầu. Thử lại.' });
});

function openEditor() {
  if (!process.argv.includes('--open')) return;
  const browser = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', origin], {
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
