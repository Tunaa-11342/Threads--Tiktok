import { cardMarkup, gridMarkup, quotePages } from './thread-card.mjs';
import { cardPosition, defaultPosition, positionLimits } from './placement.mjs';
import { effectChoices, effectFilePrefix } from './effect-options.mjs';
import { addOutroAnimation, defaultOutro, normalizeOutro, outroDuration, outroMarkup } from './outro.mjs';
import { captionsMarkup, addCaptionsAnimation } from './captions.mjs';

const $ = id => document.getElementById(id);
const storageKey = 'threads-to-video-draft-v2';
const defaults = {
  url: '',
  post: null,
  comments: [],
  selected: [],
  reads: {},
  authors: true,
  fetched: 0,
  introEffect: 'auto',
  music: '',
  commentEffects: {},
  positions: {},
  outro: defaultOutro,
  panel: 'source',
  bgFile: '',
  bgStart: 0,
  memes: {}, // { [sceneId]: { file, x: 50, y: 62, scale: 100, rotation: 0, timing: 'with_card' } }
  captions: { enabled: true, wordsPerLine: 7, y: 75, font: 'Be Vietnam Pro' }
};

let draft;
try {
  const saved = JSON.parse(localStorage.getItem(storageKey));
  draft = { ...defaults, ...saved };
  if (!draft.memes) draft.memes = {};
  if (!draft.captions) draft.captions = { enabled: true, wordsPerLine: 7, y: 75, font: 'Be Vietnam Pro' };
  if (!draft.captions.font) draft.captions.font = 'Be Vietnam Pro';
  if (draft.bgStart === undefined) draft.bgStart = 0;
} catch {
  draft = { ...defaults };
}

draft.outro = normalizeOutro(draft.outro);
let previewId;
let revision = 0;
let rendering = false;
let activeScene = 'post';
let effectTracks = [];
let effectDurationsMap = new Map();
let backgroundTracks = [];
let backgroundTracksMap = new Map();
let memeTracks = [];
let memeDetailsMap = new Map();
let voiceDurationCache = new Map();
let outroDemo;
let currentAudioPreview = null;
const maxSelected = 4;
const number = new Intl.NumberFormat('vi-VN');

function getOutroAvatarUrl(avatar) {
  if (!avatar || avatar === 'lapzone-logo.svg') return 'lapzone-logo.svg';
  if (avatar.startsWith('data:') || avatar.startsWith('/') || avatar.startsWith('http')) return avatar;
  return '/media/avatars/' + encodeURIComponent(avatar);
}

function refreshIcons() {
  if (window.lucide && typeof window.lucide.createIcons === 'function') {
    try {
      window.lucide.createIcons();
    } catch (e) {
      console.warn('lucide createIcons:', e);
    }
  }
}

function formatTime(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return String(m).padStart(2, '0') + ':' + String(rem).padStart(2, '0');
}

function updateEstimatedDuration() {
  const script = scenes();
  if (!script.length) {
    $('duration-val').textContent = '~00:00';
    return;
  }
  const introDur = (draft.introEffect && draft.introEffect !== 'off') ? 0.6 : 0;
  let totalSec = introDur;
  for (let i = 0; i < script.length; i++) {
    const s = script[i];
    const cached = voiceDurationCache.get(s.read);
    const speechDur = cached || Math.max(1.5, s.read.trim().split(/\s+/u).filter(Boolean).length / 3.4);

    let effDur = 0;
    if (s.effect && s.effect !== 'off') {
      const name = s.effect.startsWith(effectFilePrefix) ? s.effect.slice(effectFilePrefix.length) : s.effect;
      effDur = effectDurationsMap.get(name) || 0.8;
    }

    let memeHold = 0;
    if (s.meme?.file) {
      const info = memeDetailsMap.get(s.meme.file);
      const isVideo = info?.isVideo || ['.mp4', '.webm', '.mov'].some(ext => s.meme.file.toLowerCase().endsWith(ext));
      const videoDur = info?.duration || 0;
      if (s.meme.timing === 'after_read') {
        memeHold = videoDur > 0 ? videoDur : (effDur > 0 ? effDur : 1.5);
      } else {
        if (videoDur > speechDur) memeHold = videoDur - speechDur;
      }
    }

    const holdTime = Math.max(effDur, memeHold);
    totalSec += speechDur + holdTime;
  }
  if (draft.outro?.enabled) {
    totalSec += outroDuration;
  }
  $('duration-val').textContent = '~' + formatTime(totalSec);
}

function save() {
  try { localStorage.setItem(storageKey, JSON.stringify(draft)); }
  catch { /* memory fallback */ }
}

function changed() {
  stopOutroDemo();
  stopLivePlayer();
  stopAudioPreview();
  revision++;
  updateTimeline();
  updateEstimatedDuration();
  save();
  if (previewId) {
    previewId = null;
    $('player').pause();
    $('player').removeAttribute('src');
    $('player').load();
    $('player').hidden = true;
    $('placeholder').hidden = false;
    $('download').hidden = true;
    show('render-message', 'Đã sửa bản nháp. Bấm Phát thử hoặc Xuất MP4 để tạo video.');
  }
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function show(id, text, error = false) {
  const node = $(id);
  if (!node) return;
  node.hidden = !text;
  node.textContent = text || '';
  node.classList.toggle('error', error);
}

async function request(path, body) {
  const options = !body ? {} : body instanceof FormData
    ? { method: 'POST', body }
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Tool không xử lý được yêu cầu.');
  return data;
}

// Audio preview helper
function stopAudioPreview() {
  if (currentAudioPreview) {
    currentAudioPreview.audio.pause();
    currentAudioPreview.audio.currentTime = 0;
    currentAudioPreview.button.classList.remove('playing');
    if (currentAudioPreview.button.dataset.idleHtml) {
      currentAudioPreview.button.innerHTML = currentAudioPreview.button.dataset.idleHtml;
    }
    refreshIcons();
    currentAudioPreview = null;
  }
}

function playAudioPreview(url, button) {
  if (currentAudioPreview && currentAudioPreview.button === button) {
    stopAudioPreview();
    return;
  }
  stopAudioPreview();
  if (!button.dataset.idleHtml) {
    button.dataset.idleHtml = button.innerHTML;
  }
  const audio = new Audio(url);
  button.classList.add('playing');
  button.innerHTML = '<i data-lucide="square"></i> <span>Dừng</span>';
  refreshIcons();
  currentAudioPreview = { audio, button, url };
  audio.play().catch(() => stopAudioPreview());
  audio.onended = () => stopAudioPreview();
  audio.onerror = () => stopAudioPreview();
}

const sortLikes = (a, b) => (b.likes ?? -1) - (a.likes ?? -1);
const findComment = id => draft.comments.find(comment => comment.id === id);
const searchText = text => String(text || '').toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '').replaceAll('đ', 'd');

function shorten(text, limit) {
  const clean = String(text || '').trim().replace(/\s+/gu, ' ');
  if (clean.length <= limit) return clean;
  const stop = clean.lastIndexOf(' ', limit);
  return clean.slice(0, stop >= limit * .75 ? stop : limit).trimEnd() + '…';
}

function spoken(text) {
  const clean = String(text || '').replace(/https?:\/\/\S+/gi, '')
    .replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, '')
    .replace(/\s+/gu, ' ').trim();
  return shorten(clean || text, 600);
}

function scenes() {
  if (!draft.post) return [];
  return [
    { ...draft.post, id: 'post', title: 'Bài viết' },
    ...draft.selected.map((id, index) => ({ ...findComment(id), title: 'Bình luận ' + (index + 1) })),
  ].map(scene => ({
    ...scene,
    quote: scene.text,
    read: draft.reads[scene.id] ?? spoken(scene.text),
    author: draft.authors ? scene.author : '',
    position: cardPosition(draft.positions[scene.id]),
    effect: scene.id === 'post' ? 'off' : draft.commentEffects[scene.id] || 'auto',
    meme: draft.memes[scene.id] || null,
  }));
}

// Paint UI components
function paintComments() {
  const query = searchText($('search').value.trim());
  const rows = draft.comments.filter(comment => searchText(comment.text + ' ' + (comment.author || '')).includes(query));
  if ($('sort').value === 'likes') rows.sort(sortLikes);
  const manual = draft.comments.length - draft.fetched;
  $('comment-total').textContent = draft.fetched + ' đã lấy' + (manual ? ' · ' + manual + ' nhập tay' : '');
  $('selected-total').textContent = draft.selected.length + ' / ' + maxSelected;
  $('empty-comments').hidden = rows.length > 0;
  $('empty-comments').textContent = draft.comments.length
    ? 'Không có bình luận khớp từ khóa.'
    : draft.post ? 'Chưa có bình luận. Bạn có thể nhập thêm ở trên.' : 'Bình luận sẽ xuất hiện sau khi lấy bài hoặc nhập tay.';

  $('comment-list').replaceChildren(...rows.map(comment => {
    const row = element('li');
    const label = element('label');
    const checkbox = element('input');
    checkbox.type = 'checkbox';
    checkbox.checked = draft.selected.includes(comment.id);
    checkbox.disabled = !checkbox.checked && draft.selected.length >= maxSelected;
    checkbox.dataset.comment = comment.id;
    checkbox.addEventListener('change', () => {
      draft.selected = checkbox.checked
        ? [...draft.selected, comment.id].slice(0, maxSelected)
        : draft.selected.filter(id => id !== comment.id);
      changed();
      paintComments();
      paintScript();
      $('comment-list').querySelector('[data-comment="' + CSS.escape(comment.id) + '"]')?.focus();
    });
    const authorSpan = comment.author ? element('strong', 'comment-author', '[' + comment.author + '] ') : null;
    const textSpan = element('span', 'comment-text', comment.text);
    if (authorSpan) textSpan.prepend(authorSpan);
    const likes = comment.likes == null ? 'Chưa rõ tim' : '♥ ' + number.format(comment.likes) + (comment.approximate ? '+' : '');
    label.append(checkbox, textSpan, element('span', 'comment-likes', likes));
    row.append(label);
    return row;
  }));

  $('selected-list').replaceChildren(...draft.selected.map((id, index) => {
    const comment = findComment(id);
    const entry = element('li');
    const row = element('div', 'selected-row');
    row.append(element('span', 'position', String(index + 1)), element('span', 'comment-text', (comment.author ? `[${comment.author}] ` : '') + comment.text));
    for (const [direction, icon, label] of [[-1, '↑', 'Lên'], [1, '↓', 'Xuống']]) {
      const button = element('button', 'button neutral', icon);
      button.setAttribute('aria-label', label + ' một vị trí · Bình luận ' + (index + 1));
      button.dataset.move = id + ':' + direction;
      const next = index + direction;
      button.disabled = next < 0 || next >= draft.selected.length;
      button.addEventListener('click', () => {
        [draft.selected[index], draft.selected[next]] = [draft.selected[next], draft.selected[index]];
        changed();
        paintComments();
        paintScript();
        const buttons = [...$('selected-list').querySelectorAll('button')];
        (buttons.find(button => button.dataset.move === id + ':' + direction && !button.disabled) ||
          buttons.find(button => button.dataset.move === id + ':' + -direction && !button.disabled))?.focus();
      });
      row.append(button);
    }
    const remove = element('button', 'button neutral', '×');
    remove.setAttribute('aria-label', 'Bỏ bình luận ' + (index + 1));
    remove.addEventListener('click', () => {
      draft.selected = draft.selected.filter(selected => selected !== id);
      changed();
      paintComments();
      paintScript();
      $('comment-list').querySelector('[data-comment="' + CSS.escape(id) + '"]')?.focus();
    });
    row.append(remove);

    const settings = element('div', 'selected-effect');
    const label = element('label', '', 'Hiệu ứng sau bình luận ' + (index + 1));
    const effectWrap = element('div', 'inline');
    const effect = element('select');
    effect.id = 'effect-' + id;
    effect.dataset.sceneEffect = id;
    label.htmlFor = effect.id;
    effectSelect(effect, draft.commentEffects[id] || 'auto');
    effect.addEventListener('change', () => {
      stopAudioPreview();
      draft.commentEffects[id] = effect.value;
      activeScene = id;
      changed();
      paintFrame();
    });

    const previewBtn = element('button', 'btn-preview-audio', '');
    previewBtn.innerHTML = '<i data-lucide="volume-2"></i> <span>Nghe</span>';
    previewBtn.title = 'Nghe thử hiệu ứng';
    previewBtn.type = 'button';
    previewBtn.addEventListener('click', () => {
      const chosen = effect.value;
      if (chosen === 'off') return;
      playAudioPreview('/api/effects/audio/' + encodeURIComponent(chosen), previewBtn);
    });

    effectWrap.append(effect, previewBtn);
    settings.append(label, effectWrap);
    entry.append(row, settings);
    return entry;
  }));
}

function effectSelect(select, value) {
  const options = [
    ...effectChoices.map(([key, label]) => new Option(label, key)),
    ...effectTracks.map(name => new Option(name, effectFilePrefix + name)),
  ];
  if (value?.startsWith(effectFilePrefix) && !options.some(option => option.value === value)) {
    options.push(new Option(value.slice(effectFilePrefix.length) + ' (không tìm thấy)', value));
  }
  select.replaceChildren(...options);
  select.value = value;
}

function paintSceneCardAndMeme(scene, options = {}) {
  const items = scenes();
  paintPlacement(items, scene);
  paintMemeControls(scene);

  if (!scene?.quote) {
    $('preview-card').hidden = true;
    $('preview-meme').hidden = true;
    return;
  }

  // Thẻ Threads
  $('preview-card').hidden = false;
  $('preview-card').style.setProperty('--card-x', scene.position.x + '%');
  $('preview-card').style.setProperty('--card-y', scene.position.y + '%');
  $('preview-card').innerHTML = cardMarkup({ ...scene, quote: quotePages(scene.quote)[0] });

  // Meme trên sân khấu
  const memeBox = $('preview-meme');
  const meme = scene.meme;
  const hideMeme = options.hideMeme === true;
  if (meme && meme.file && !hideMeme) {
    memeBox.hidden = false;
    memeBox.style.setProperty('--meme-x', (meme.x ?? 50) + '%');
    memeBox.style.setProperty('--meme-y', (meme.y ?? 62) + '%');
    const rawScale = Number(meme.scale) || 100;
    const normScale = rawScale > 10 ? rawScale / 100 : rawScale;
    memeBox.style.setProperty('--meme-scale', normScale);
    const ext = meme.file.slice(meme.file.lastIndexOf('.')).toLowerCase();
    const info = memeDetailsMap.get(meme.file);
    const isVideo = info?.isVideo || ['.mp4', '.webm', '.mov'].includes(ext);
    const mediaHtml = isVideo
      ? `<video src="/media/memes/${encodeURIComponent(meme.file)}" autoplay loop muted playsinline></video>`
      : `<img src="/media/memes/${encodeURIComponent(meme.file)}" alt="meme">`;
    memeBox.innerHTML = `
      ${mediaHtml}
      <div class="meme-resize-handle" title="Kéo để đổi kích thước meme"></div>
    `;
    setupMemeInteractions(memeBox, scene);
  } else {
    memeBox.hidden = true;
  }
}

function paintFrame() {
  const items = scenes();
  const scene = items.find(item => item.id === activeScene) || items[0];
  $('frame-empty').hidden = Boolean(scene?.quote);
  paintSceneCardAndMeme(scene);

  // Khi đang phát thử Live, timeline GSAP toàn quyền điều khiển phụ đề; không ghi đè DOM
  if (isPlayingLive) return;

  const capBox = $('preview-captions');
  if (draft.captions?.enabled && scene?.read) {
    capBox.hidden = false;
    applyCaptionsFont(draft.captions?.font || 'Be Vietnam Pro');
    capBox.innerHTML = captionsMarkup(scene.read, 3, draft.captions.wordsPerLine || 7, 0, draft.captions.y || 75, 0);
    // highlight first word as sample preview
    const firstWord = capBox.querySelector('.tiktok-word');
    const firstLine = capBox.querySelector('.tiktok-caption-line');
    if (firstLine) firstLine.style.display = 'inline-block';
    if (firstWord) {
      firstWord.style.color = '#FFE600';
      firstWord.style.transform = 'scale(1.2)';
    }
  } else {
    capBox.hidden = true;
    capBox.innerHTML = '';
  }
}

// Drag & Resize Meme on stage
function setupMemeInteractions(memeEl, scene) {
  const handle = memeEl.querySelector('.meme-resize-handle');
  const stageEl = $('placeholder');

  let dragging = false;
  let resizing = false;
  let startX = 0, startY = 0;
  let initMemeX = scene.meme.x ?? 50;
  let initMemeY = scene.meme.y ?? 62;
  let initScale = scene.meme.scale ?? 100;

  memeEl.onmousedown = e => {
    if (e.target === handle) return;
    e.preventDefault();
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    initMemeX = scene.meme.x ?? 50;
    initMemeY = scene.meme.y ?? 62;
    memeEl.classList.add('active-meme');

    const onMove = ev => {
      if (!dragging) return;
      const rect = stageEl.getBoundingClientRect();
      const dx = ((ev.clientX - startX) / rect.width) * 100;
      const dy = ((ev.clientY - startY) / rect.height) * 100;
      const newX = Math.round(Math.max(5, Math.min(95, initMemeX + dx)));
      const newY = Math.round(Math.max(10, Math.min(90, initMemeY + dy)));
      scene.meme.x = newX;
      scene.meme.y = newY;
      draft.memes[scene.id] = { ...scene.meme };
      memeEl.style.setProperty('--meme-x', newX + '%');
      memeEl.style.setProperty('--meme-y', newY + '%');
      $('meme-x').value = newX;
      $('meme-x-value').value = newX + '%';
      $('meme-y').value = newY;
      $('meme-y-value').value = newY + '%';
    };

    const onUp = () => {
      dragging = false;
      memeEl.classList.remove('active-meme');
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      changed();
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  if (handle) {
    handle.onmousedown = e => {
      e.stopPropagation();
      e.preventDefault();
      resizing = true;
      startX = e.clientX;
      initScale = scene.meme.scale ?? 100;
      memeEl.classList.add('active-meme');

      const onResizeMove = ev => {
        if (!resizing) return;
        const delta = ev.clientX - startX;
        const newScale = Math.round(Math.max(30, Math.min(250, initScale + delta * 0.8)));
        scene.meme.scale = newScale;
        draft.memes[scene.id] = { ...scene.meme };
        memeEl.style.setProperty('--meme-scale', newScale / 100);
        $('meme-scale').value = newScale;
        $('meme-scale-value').value = newScale + '%';
      };

      const onResizeUp = () => {
        resizing = false;
        memeEl.classList.remove('active-meme');
        window.removeEventListener('mousemove', onResizeMove);
        window.removeEventListener('mouseup', onResizeUp);
        changed();
      };

      window.addEventListener('mousemove', onResizeMove);
      window.addEventListener('mouseup', onResizeUp);
    };
  }
}

function paintPlacement(items, scene) {
  const select = $('placement-scene');
  $('placement').hidden = !scene;
  $('placement-empty').hidden = Boolean(scene);
  if (!scene) return;
  if (Array.from(select.options).map(option => option.value + option.text).join('|') !==
      items.map(item => item.id + item.title).join('|')) {
    select.replaceChildren(...items.map(item => new Option(item.title, item.id)));
  }
  select.value = scene.id;
  for (const axis of Object.keys(positionLimits)) {
    $('card-' + axis).value = scene.position[axis];
    $('card-' + axis + '-value').value = scene.position[axis] + '%';
  }
}

function paintMemeControls(scene) {
  if (!scene) return;
  const memeSelect = $('scene-meme-select');
  const meme = draft.memes[scene.id] || null;

  memeSelect.value = meme?.file || '';
  $('scene-meme-controls').hidden = !meme?.file;

  if (meme?.file) {
    $('meme-timing').value = meme.timing || 'with_card';
    $('meme-x').value = meme.x ?? 50;
    $('meme-x-value').value = (meme.x ?? 50) + '%';
    $('meme-y').value = meme.y ?? 62;
    $('meme-y-value').value = (meme.y ?? 62) + '%';
    $('meme-scale').value = meme.scale ?? 100;
    $('meme-scale-value').value = (meme.scale ?? 100) + '%';
  }
}

$('meme-timing').addEventListener('change', () => {
  const meme = draft.memes[activeScene];
  if (meme) {
    meme.timing = $('meme-timing').value;
    changed();
  }
});

function setPosition(position) {
  const id = $('placement-scene').value;
  if (!id) return;
  draft.positions[id] = cardPosition(position);
  changed();
  paintFrame();
}

function paintScript() {
  paintFrame();
  const items = scenes();
  $('empty-script').hidden = items.length > 0;
  $('script').replaceChildren(...items.map(scene => {
    const block = element('div', 'script-scene');
    const label = element('label', '', 'Lời đọc · ' + scene.title);
    const input = element('textarea');
    input.id = 'read-' + scene.id;
    input.rows = 2;
    input.maxLength = 600;
    input.value = scene.read;
    label.htmlFor = input.id;
    input.addEventListener('focus', () => { activeScene = scene.id; paintFrame(); });
    input.addEventListener('input', () => {
      draft.reads[scene.id] = input.value;
      changed();
    });
    block.append(label, input);
    return block;
  }));
}

function paintPost() {
  $('post-preview').hidden = !draft.post?.text;
  $('post-preview').innerHTML = draft.post?.text ? cardMarkup({ ...draft.post, quote: draft.post.text }) : '';
  $('manual-post').value = draft.post?.text || '';
  paintComments();
  paintScript();
}

// Background Video & Resource Management
async function loadBackgrounds() {
  try {
    const { tracks } = await request('/api/backgrounds');
    backgroundTracks = tracks;
    backgroundTracksMap.clear();
    tracks.forEach(t => backgroundTracksMap.set(t.name, t.duration));
    const select = $('bg-select');
    const none = new Option('Nền lưới mặc định', '');
    select.replaceChildren(none, ...tracks.map(t => new Option(t.name + (t.duration > 0 ? ` (${formatTime(t.duration)})` : ''), t.name)));
    select.value = tracks.some(t => t.name === draft.bgFile) ? draft.bgFile : '';
    $('bg-count').textContent = tracks.length + ' video';
    updateBackgroundPlayer();
  } catch (err) {
    console.error('Lỗi tải video nền:', err);
  }
}

function updateBackgroundPlayer() {
  const player = $('background-preview');
  player.pause();
  const file = draft.bgFile;
  player.hidden = !file;
  $('preview-scrim').hidden = !file;
  $('grid-preview').hidden = Boolean(file);

  const dur = backgroundTracksMap.get(file) || 0;
  const offsetBox = $('bg-offset-box');
  if (file && dur > 15) {
    offsetBox.hidden = false;
    const maxStart = Math.max(0, Math.floor(dur - 10));
    const slider = $('bg-start-slider');
    slider.max = String(maxStart);
    draft.bgStart = Math.min(draft.bgStart || 0, maxStart);
    slider.value = String(draft.bgStart);
    $('bg-start-label').textContent = formatTime(draft.bgStart);
    $('bg-duration-label').textContent = `(Tổng: ${formatTime(dur)})`;
  } else {
    offsetBox.hidden = true;
    draft.bgStart = 0;
  }

  if (file) {
    player.src = '/media/backgrounds/' + encodeURIComponent(file);
    player.currentTime = draft.bgStart || 0;
    player.play().catch(() => {});
  } else {
    player.removeAttribute('src');
  }
}

$('bg-start-slider').addEventListener('input', () => {
  draft.bgStart = $('bg-start-slider').valueAsNumber;
  $('bg-start-label').textContent = formatTime(draft.bgStart);
  const player = $('background-preview');
  if (!player.hidden) {
    player.currentTime = draft.bgStart;
  }
  changed();
});

$('bg-random-btn').addEventListener('click', () => {
  const file = draft.bgFile;
  const dur = backgroundTracksMap.get(file) || 0;
  const maxStart = Math.max(0, Math.floor(dur - 10));
  if (maxStart <= 0) return;
  draft.bgStart = Math.floor(Math.random() * (maxStart + 1));
  $('bg-start-slider').value = String(draft.bgStart);
  $('bg-start-label').textContent = formatTime(draft.bgStart);
  const player = $('background-preview');
  if (!player.hidden) {
    player.currentTime = draft.bgStart;
  }
  changed();
});

$('bg-reset-btn').addEventListener('click', () => {
  draft.bgStart = 0;
  $('bg-start-slider').value = '0';
  $('bg-start-label').textContent = '00:00';
  const player = $('background-preview');
  if (!player.hidden) {
    player.currentTime = 0;
  }
  changed();
});

$('bg-select').addEventListener('change', () => {
  draft.bgFile = $('bg-select').value;
  changed();
  updateBackgroundPlayer();
});

$('bg-upload-btn').addEventListener('click', () => $('bg-file-input').click());
$('bg-file-input').addEventListener('change', async () => {
  const file = $('bg-file-input').files[0];
  if (!file) return;
  show('render-message', 'Đang tải video nền lên...');
  try {
    const form = new FormData();
    form.append('video', file);
    const { file: savedName } = await request('/api/backgrounds/upload', form);
    draft.bgFile = savedName;
    await loadBackgrounds();
    changed();
    show('render-message', 'Đã lưu video vào thư mục Video nền: ' + savedName);
  } catch (err) {
    show('render-message', err.message, true);
  } finally {
    $('bg-file-input').value = '';
  }
});

// Memes Management
async function loadMemes() {
  try {
    const { tracks = [], details = {} } = await request('/api/memes');
    memeTracks = tracks;
    memeDetailsMap.clear();
    Object.entries(details).forEach(([k, v]) => memeDetailsMap.set(k, v));
    $('meme-count').textContent = tracks.length + ' meme';

    // Update scene meme select
    const select = $('scene-meme-select');
    const none = new Option('Không chèn meme', '');
    select.replaceChildren(none, ...tracks.map(name => {
      const info = memeDetailsMap.get(name);
      const isVideo = info?.isVideo || ['.mp4', '.webm', '.mov'].some(ext => name.toLowerCase().endsWith(ext));
      const label = name + (isVideo ? (info?.duration > 0 ? ` [Video ${formatTime(info.duration)}]` : ' [Video]') : '');
      return new Option(label, name);
    }));
    const currentMeme = draft.memes[activeScene]?.file || '';
    select.value = tracks.includes(currentMeme) ? currentMeme : '';

    // Update meme library grid
    const grid = $('meme-library-grid');
    grid.replaceChildren(...tracks.map(name => {
      const item = element('div', 'meme-item');
      item.title = name;
      const info = memeDetailsMap.get(name);
      const isVideo = info?.isVideo || ['.mp4', '.webm', '.mov'].some(ext => name.toLowerCase().endsWith(ext));
      if (isVideo) {
        const vid = element('video');
        vid.src = '/media/memes/' + encodeURIComponent(name);
        vid.muted = true;
        vid.playsInline = true;
        const badge = element('span', 'video-badge');
        badge.innerHTML = '<i data-lucide="film"></i>';
        item.append(vid, badge);
      } else {
        const img = element('img');
        img.src = '/media/memes/' + encodeURIComponent(name);
        item.append(img);
      }
      item.addEventListener('click', () => {
        draft.memes[activeScene] = {
          file: name,
          x: draft.memes[activeScene]?.x ?? 50,
          y: draft.memes[activeScene]?.y ?? 62,
          scale: draft.memes[activeScene]?.scale ?? 100,
          timing: draft.memes[activeScene]?.timing || 'with_card',
        };
        changed();
        paintFrame();
      });
      return item;
    }));
    refreshIcons();
  } catch (err) {
    console.error('Lỗi tải meme:', err);
  }
}

$('meme-lib-upload-btn').addEventListener('click', () => $('meme-lib-file-input').click());
$('meme-lib-file-input').addEventListener('change', async () => {
  const file = $('meme-lib-file-input').files[0];
  if (!file) return;
  show('render-message', 'Đang tải meme (ảnh/GIF/video)...');
  try {
    const form = new FormData();
    form.append('media', file);
    const { file: savedName } = await request('/api/memes/upload', form);
    await loadMemes();
    show('render-message', 'Đã thêm meme: ' + savedName);
  } catch (err) {
    show('render-message', err.message, true);
  } finally {
    $('meme-lib-file-input').value = '';
  }
});
$('meme-refresh').addEventListener('click', loadMemes);

$('scene-meme-select').addEventListener('change', () => {
  const val = $('scene-meme-select').value;
  if (!val) {
    delete draft.memes[activeScene];
  } else {
    draft.memes[activeScene] = {
      file: val,
      x: draft.memes[activeScene]?.x ?? 50,
      y: draft.memes[activeScene]?.y ?? 62,
      scale: draft.memes[activeScene]?.scale ?? 100,
      timing: draft.memes[activeScene]?.timing || 'with_card',
    };
  }
  changed();
  paintFrame();
});

$('btn-add-meme-scene').addEventListener('click', () => $('meme-file-input-scene').click());
$('meme-file-input-scene').addEventListener('change', async () => {
  const file = $('meme-file-input-scene').files[0];
  if (!file) return;
  try {
    const form = new FormData();
    form.append('media', file);
    const { file: savedName } = await request('/api/memes/upload', form);
    await loadMemes();
    draft.memes[activeScene] = {
      file: savedName,
      x: 50,
      y: 62,
      scale: 100,
      timing: draft.memes[activeScene]?.timing || 'with_card',
    };
    changed();
    paintFrame();
  } catch (err) {
    show('render-message', err.message, true);
  } finally {
    $('meme-file-input-scene').value = '';
  }
});

$('btn-remove-meme').addEventListener('click', () => {
  delete draft.memes[activeScene];
  changed();
  paintFrame();
});

for (const key of ['x', 'y', 'scale']) {
  $('meme-' + key).addEventListener('input', () => {
    if (!draft.memes[activeScene]) return;
    const val = $('meme-' + key).valueAsNumber;
    draft.memes[activeScene][key] = val;
    $('meme-' + key + '-value').value = val + '%';
    changed();
    paintFrame();
  });
}

// TikTok Captions settings
$('captions-enabled').checked = draft.captions.enabled;
$('captions-settings').hidden = !draft.captions.enabled;
$('captions-enabled').addEventListener('change', () => {
  draft.captions.enabled = $('captions-enabled').checked;
  $('captions-settings').hidden = !draft.captions.enabled;
  changed();
  paintFrame();
});

$('captions-words').value = draft.captions.wordsPerLine || 7;
$('captions-words-value').value = (draft.captions.wordsPerLine || 7) + ' từ';
$('captions-words').addEventListener('input', () => {
  draft.captions.wordsPerLine = $('captions-words').valueAsNumber;
  $('captions-words-value').value = draft.captions.wordsPerLine + ' từ';
  changed();
  paintFrame();
});

$('captions-y').value = draft.captions.y || 75;
$('captions-y-value').value = (draft.captions.y || 75) + '%';
$('captions-y').addEventListener('input', () => {
  draft.captions.y = $('captions-y').valueAsNumber;
  $('captions-y-value').value = draft.captions.y + '%';
  changed();
  paintFrame();
});

function applyCaptionsFont(fontName) {
  const capBox = $('preview-captions');
  if (capBox) {
    capBox.style.setProperty('--captions-font', `"${fontName}", "Be Vietnam Pro", sans-serif`);
  }
}

async function loadFonts() {
  try {
    const { fonts = [], custom = [] } = await request('/api/fonts');
    for (const cf of custom) {
      if (!document.fonts.check(`16px "${cf.name}"`)) {
        try {
          const face = new FontFace(cf.name, `url(/media/fonts/${encodeURIComponent(cf.file)})`);
          await face.load();
          document.fonts.add(face);
        } catch (e) {
          console.warn('Không thể load font face:', cf.name, e);
        }
      }
    }
    const select = $('captions-font');
    select.replaceChildren(...fonts.map(f => new Option(f.name, f.name)));
    const targetFont = draft.captions.font || 'Be Vietnam Pro';
    select.value = fonts.some(f => f.name === targetFont) ? targetFont : (fonts[0]?.name || 'Be Vietnam Pro');
    draft.captions.font = select.value;
    applyCaptionsFont(draft.captions.font);
  } catch (err) {
    console.error('Lỗi nạp font:', err);
  }
}

$('captions-font').addEventListener('change', () => {
  draft.captions.font = $('captions-font').value;
  applyCaptionsFont(draft.captions.font);
  changed();
  paintFrame();
});

$('btn-add-font').addEventListener('click', () => $('font-file-input').click());
$('font-file-input').addEventListener('change', async () => {
  const file = $('font-file-input').files[0];
  if (!file) return;
  show('render-message', 'Đang tải font lên...');
  try {
    const form = new FormData();
    form.append('font', file);
    const { name: fontName } = await request('/api/fonts/upload', form);
    await loadFonts();
    draft.captions.font = fontName;
    $('captions-font').value = fontName;
    applyCaptionsFont(fontName);
    changed();
    paintFrame();
    show('render-message', 'Đã thêm font mới: ' + fontName);
  } catch (err) {
    show('render-message', 'Lỗi tải font: ' + err.message, true);
  } finally {
    $('font-file-input').value = '';
  }
});

// Sound Effects Preview
$('effect').addEventListener('change', () => {
  stopAudioPreview();
  draft.introEffect = $('effect').value;
  changed();
});
$('btn-preview-intro-effect').addEventListener('click', () => {
  const chosen = $('effect').value;
  if (chosen === 'off') return;
  playAudioPreview('/api/effects/audio/' + encodeURIComponent(chosen), $('btn-preview-intro-effect'));
});

async function loadEffects() {
  const refresh = $('effects-refresh');
  if (refresh.disabled) return;
  refresh.disabled = true;
  try {
    const { tracks = [], durations = {} } = await request('/api/effects');
    effectTracks = tracks;
    effectDurationsMap.clear();
    Object.entries(durations).forEach(([k, v]) => effectDurationsMap.set(k, v));
    effectSelect($('effect'), draft.introEffect);
    document.querySelectorAll('[data-scene-effect]').forEach(select => {
      effectSelect(select, draft.commentEffects[select.dataset.sceneEffect] || 'auto');
    });
    $('effects-hint').textContent = tracks.length
      ? tracks.length + ' file trong Sound Effects.'
      : 'Thả file vào Sound Effects để thêm hiệu ứng.';
    updateEstimatedDuration();
  } catch (error) {
    $('effects-hint').textContent = error.message;
  } finally {
    refresh.disabled = false;
  }
}
$('effects-refresh').addEventListener('click', loadEffects);
loadEffects();

async function loadEffectsLibrary() {
  try {
    const { tracks = [], durations = {} } = await request('/api/effects');
    effectTracks = tracks;
    effectDurationsMap.clear();
    Object.entries(durations).forEach(([k, v]) => effectDurationsMap.set(k, v));
    const countEl = $('effects-lib-count');
    if (countEl) countEl.textContent = tracks.length + ' hiệu ứng';
    const grid = $('effects-library-grid');
    if (!grid) return;
    if (!tracks.length) {
      grid.innerHTML = '<div class="empty-hint">Chưa có hiệu ứng âm thanh trong Sound Effects.</div>';
      return;
    }
    grid.replaceChildren(...tracks.map(name => {
      const chip = element('div', 'effect-chip');
      const durText = durations[name] ? ` (${durations[name]}s)` : '';
      const span = element('span', '', name + durText);
      const playBtn = element('button', 'chip-preview-btn');
      playBtn.type = 'button';
      playBtn.title = 'Nghe thử ' + name;
      playBtn.innerHTML = '<i data-lucide="volume-2"></i>';
      playBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        playAudioPreview('/api/effects/audio/' + encodeURIComponent(name), playBtn);
      });
      chip.append(span, playBtn);
      return chip;
    }));
    refreshIcons();
    updateEstimatedDuration();
  } catch (err) {
    console.error('Lỗi nạp thư viện hiệu ứng:', err);
  }
}

$('effect-upload-btn').addEventListener('click', () => $('effect-file-input').click());
$('effect-file-input').addEventListener('change', async () => {
  const file = $('effect-file-input').files[0];
  if (!file) return;
  show('render-message', 'Đang tải hiệu ứng âm thanh...');
  try {
    const form = new FormData();
    form.append('audio', file);
    const { file: savedName } = await request('/api/effects/upload', form);
    await loadEffects();
    await loadEffectsLibrary();
    show('render-message', 'Đã thêm hiệu ứng âm thanh: ' + savedName);
  } catch (err) {
    show('render-message', err.message, true);
  } finally {
    $('effect-file-input').value = '';
  }
});
$('effects-lib-refresh').addEventListener('click', () => {
  loadEffects();
  loadEffectsLibrary();
});

// Music Preview
async function loadMusic() {
  const select = $('music');
  if ($('music-refresh').disabled) return;
  $('music-refresh').disabled = true;
  try {
    const { tracks } = await request('/api/music');
    const none = new Option('Không dùng nhạc', '');
    select.replaceChildren(none, ...tracks.map(name => new Option(name, name)));
    select.value = tracks.includes(draft.music) ? draft.music : '';
    if (draft.music && !select.value) {
      draft.music = '';
      changed();
    }
  } catch (error) {
    $('music-hint').textContent = error.message;
  } finally {
    $('music-refresh').disabled = false;
  }
}
$('music-refresh').addEventListener('click', loadMusic);
$('btn-preview-music').addEventListener('click', () => {
  if (!draft.music) return;
  playAudioPreview('/media/music/' + encodeURIComponent(draft.music), $('btn-preview-music'));
});
$('music').addEventListener('change', () => {
  stopAudioPreview();
  draft.music = $('music').value;
  changed();
});
loadMusic();

// Outro
$('outro-enabled').checked = draft.outro.enabled;
$('outro-play').disabled = !draft.outro.enabled;
$('outro-blur-bg').checked = draft.outro.blurBackground !== false;

function updateOutroAvatar() {
  const img = $('outro-avatar-preview');
  if (img) img.src = getOutroAvatarUrl(draft.outro.avatar);
}
updateOutroAvatar();

$('outro-avatar-btn').addEventListener('click', () => $('outro-avatar-input').click());
$('outro-avatar-input').addEventListener('change', async () => {
  const file = $('outro-avatar-input').files[0];
  if (!file) return;
  show('render-message', 'Đang tải ảnh đại diện...');
  try {
    const form = new FormData();
    form.append('avatar', file);
    const res = await request('/api/avatars/upload', form);
    draft.outro.avatar = res.file;
    updateOutroAvatar();
    changed();
    if (draft.outro.enabled) showOutro(true);
    show('render-message', 'Đã cập nhật ảnh đại diện outro: ' + res.file);
  } catch (err) {
    show('render-message', 'Lỗi tải avatar: ' + err.message, true);
  } finally {
    $('outro-avatar-input').value = '';
  }
});
$('outro-avatar-reset').addEventListener('click', () => {
  draft.outro.avatar = 'lapzone-logo.svg';
  updateOutroAvatar();
  changed();
  if (draft.outro.enabled) showOutro(true);
});

$('outro-enabled').addEventListener('change', () => {
  draft.outro.enabled = $('outro-enabled').checked;
  $('outro-play').disabled = !draft.outro.enabled;
  changed();
  if (draft.outro.enabled) showOutro(true);
});

$('outro-blur-bg').addEventListener('change', () => {
  draft.outro.blurBackground = $('outro-blur-bg').checked;
  changed();
  if (draft.outro.enabled) showOutro(true);
});

for (const key of ['handle', 'name', 'button', 'prompt', 'confirm']) {
  const input = $('outro-' + key);
  input.value = draft.outro[key];
  input.addEventListener('input', () => {
    draft.outro[key] = input.value;
    changed();
    showOutro(true);
  });
}
$('outro-play').addEventListener('click', () => {
  const play = !outroDemo || outroDemo.still;
  showOutro(!play);
});

function stopOutroDemo() {
  if (!outroDemo) return;
  const { timeline, timer, hadVideo, wasPlaying } = outroDemo;
  outroDemo = null;
  clearTimeout(timer);
  timeline.kill();
  $('outro-demo').hidden = true;
  $('outro-demo').replaceChildren();
  $('outro-play').innerHTML = '<i data-lucide="play"></i> <span>Xem thử outro</span>';
  refreshIcons();
  paintFrame();
  if (hadVideo && previewId) {
    $('player').hidden = false;
    $('placeholder').hidden = true;
  } else if (wasPlaying) {
    $('background-preview').play().catch(() => {});
  }
}

function showOutro(still = false) {
  stopOutroDemo();
  if (!draft.outro.enabled) return;
  const box = $('outro-demo');
  const video = $('background-preview');
  const hadVideo = !$('player').hidden;
  const wasPlaying = !video.paused;
  $('player').pause();
  $('player').hidden = true;
  $('placeholder').hidden = false;
  $('preview-card').hidden = true;
  $('preview-meme').hidden = true;
  $('preview-captions').hidden = true;
  $('frame-empty').hidden = true;

  const useBlurBg = draft.outro.blurBackground !== false && Boolean(draft.bgFile);
  if (useBlurBg) {
    video.hidden = false;
    video.play().catch(() => {});
  } else {
    video.pause();
    video.hidden = true;
  }

  box.innerHTML = outroMarkup(draft.outro, { freeze: false, blurBackground: useBlurBg, avatarUrl: getOutroAvatarUrl(draft.outro.avatar) });
  box.hidden = false;
  const timeline = gsap.timeline({ paused: true });
  addOutroAnimation(timeline, box, 0);
  const timer = still ? null : setTimeout(() => {
    stopOutroDemo();
    if (draft.panel === 'outro') showOutro(true);
  }, outroDuration * 1000);
  outroDemo = { timeline, timer, hadVideo, wasPlaying, still };
  $('outro-play').innerHTML = still ? '<i data-lucide="play"></i> <span>Xem thử outro</span>' : '<i data-lucide="square"></i> <span>Dừng xem thử</span>';
  refreshIcons();
  if (still || matchMedia('(prefers-reduced-motion: reduce)').matches) timeline.progress(1);
  else timeline.play();
}

// Navigation & Panels
function openPanel(name, scroll = false) {
  const panel = document.querySelector('[data-panel="' + CSS.escape(name) + '"]');
  if (!panel) return;
  stopOutroDemo();
  draft.panel = name;
  if (name === 'source' || name === 'intro') activeScene = 'post';
  if (name === 'comments' && draft.selected.length && !draft.selected.includes(activeScene)) activeScene = draft.selected[0];
  for (const group of document.querySelectorAll('[data-panel]')) group.hidden = group !== panel;
  for (const button of document.querySelectorAll('[data-open]')) {
    if (button.dataset.open === name) button.setAttribute('aria-current', 'true');
    else button.removeAttribute('aria-current');
  }
  if (name === 'outro' && draft.outro.enabled) showOutro(true);
  else {
    if (previewId && !$('player').hidden) {
      $('player').pause();
      $('player').hidden = true;
      $('placeholder').hidden = false;
      $('show-rendered').hidden = false;
    }
    paintFrame();
  }
  document.querySelector('.inspector').scrollTop = 0;
  if (scroll && matchMedia('(max-width: 900px)').matches) panel.scrollIntoView({ block: 'start' });
  save();
  refreshIcons();
}

document.querySelectorAll('[data-open]').forEach(button => {
  button.addEventListener('click', () => openPanel(button.dataset.open, true));
});

$('placement-scene').addEventListener('change', () => {
  stopOutroDemo();
  activeScene = $('placement-scene').value;
  paintFrame();
});
$('show-rendered').addEventListener('click', () => {
  stopOutroDemo();
  $('player').hidden = false;
  $('placeholder').hidden = true;
  $('show-rendered').hidden = true;
});
for (const axis of Object.keys(positionLimits)) {
  const field = $('card-' + axis);
  [field.min, field.max] = positionLimits[axis];
  field.addEventListener('input', () => setPosition({ x: $('card-x').valueAsNumber, y: $('card-y').valueAsNumber }));
}
$('placement-reset').addEventListener('click', () => setPosition(defaultPosition));

function updateTimeline() {
  $('project-name').textContent = draft.post?.text ? shorten(draft.post.text, 58) : 'Video Threads';
  $('post-summary').textContent = draft.post?.text ? shorten(draft.post.text, 54) : 'Chưa có bài';
  $('comments-summary').textContent = draft.selected.length + ' bình luận';
  $('intro-summary').textContent = effectChoices.find(([key]) => key === draft.introEffect)?.[1] ||
    draft.introEffect.slice(effectFilePrefix.length);
  $('outro-summary').textContent = draft.outro.enabled ? normalizeOutro(draft.outro).handle : 'Đã tắt';
}

// Manual comments addition with strict syntax check
$('add-manual').addEventListener('click', () => {
  const text = $('manual-post').value.trim();
  const rawComments = $('manual-comments').value.trim();

  if (!text) {
    $('manual-error').hidden = false;
    $('manual-error').textContent = 'Vui lòng nhập nội dung bài viết trước.';
    return;
  }

  const additions = [];
  if (rawComments) {
    const lines = rawComments.split(/\r?\n/u).map(l => l.trim()).filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const match = /^\[([^\]]+)\]\s*(.+)$/u.exec(line);
      if (!match) {
        $('manual-error').hidden = false;
        $('manual-error').textContent = `Lỗi cú pháp ở dòng ${i + 1}: "${line}".\n` +
          `Cú pháp chuẩn: [Tên user] Nội dung comment\n` +
          `Ví dụ: [jstnzp.wav] hôm nay trời đẹp quá | 15`;
        return;
      }
      const author = match[1].trim();
      if (!author) {
        $('manual-error').hidden = false;
        $('manual-error').textContent = `Lỗi ở dòng ${i + 1}: Tên user trong ngoặc [...] không được để trống.`;
        return;
      }
      let content = match[2].trim();
      let likes = null;
      const likesMatch = /^(.*?)\s*\|\s*(\d+)$/u.exec(content);
      if (likesMatch) {
        content = likesMatch[1].trim();
        likes = Number(likesMatch[2]);
      }
      if (!content) {
        $('manual-error').hidden = false;
        $('manual-error').textContent = `Lỗi ở dòng ${i + 1}: Nội dung bình luận không được để trống.`;
        return;
      }
      additions.push({
        id: crypto.randomUUID(),
        author,
        text: content,
        likes: Number.isSafeInteger(likes) ? likes : null,
        edited: true,
      });
    }
  }

  $('manual-error').hidden = true;
  if (text !== draft.post?.text) {
    draft.post = { ...draft.post, text, edited: true };
    delete draft.reads.post;
  }

  const firstComments = draft.comments.length === 0;
  draft.comments = [...draft.comments, ...additions];
  if (firstComments) draft.selected = [...additions].sort(sortLikes).slice(0, maxSelected).map(comment => comment.id);
  $('manual-comments').value = '';
  changed();
  paintPost();
  show('thread-message', 'Đã cập nhật bài viết.' + (additions.length ? ' Đã thêm ' + additions.length + ' bình luận.' : ''));
});

// Crawl Thread Form
$('load-form').addEventListener('submit', async event => {
  event.preventDefault();
  $('load').disabled = true;
  show('thread-message', 'Đang mở bài viết và đọc bình luận…');
  try {
    const data = await request('/api/thread', { url: draft.url });
    if (data.post) {
      const samePost = draft.post?.id === data.post.id;
      const manual = samePost ? draft.comments.slice(draft.fetched) : [];
      const hadComments = samePost && draft.comments.length > 0;
      const postText = samePost && draft.post.edited ? { text: draft.post.text, edited: true } : {};
      draft.post = { ...data.post, ...postText };
      draft.comments = [...data.comments, ...manual];
      draft.fetched = data.comments.length;
      draft.selected = hadComments
        ? draft.selected.filter(id => findComment(id))
        : [...draft.comments].sort(sortLikes).slice(0, maxSelected).map(comment => comment.id);
      if (!samePost) {
        draft.reads = {};
        draft.commentEffects = {};
        draft.positions = { post: cardPosition(draft.positions.post) };
        activeScene = 'post';
        $('search').value = '';
      }
      changed();
      paintPost();
    }
    if (data.warning) $('manual').open = true;
    show('thread-message', (data.post ? 'Đã lấy ' + data.comments.length + ' bình luận. ' : '') + (data.warning || ''));
  } catch (error) {
    $('manual').open = true;
    show('thread-message', error.message, true);
  } finally {
    $('load').disabled = false;
  }
});

// Real-time Live Preview Player (0s wait!)
let isPlayingLive = false;
let liveTimeline = null;
let liveAudios = [];
let liveMusicAudio = null;

async function startLivePlayer() {
  const script = scenes();
  if (!script.length || script.some(s => !s.read.trim() || !s.quote.trim())) {
    openPanel(draft.post ? 'voice' : 'source', true);
    show('render-message', 'Thêm bài và điền lời đọc cho mỗi cảnh trước khi phát thử.', true);
    return;
  }

  stopOutroDemo();
  stopAudioPreview();
  $('player').pause();
  $('player').hidden = true;
  $('placeholder').hidden = false;

  $('generate').innerHTML = '<i data-lucide="square"></i> <span>Dừng phát</span>';
  refreshIcons();
  isPlayingLive = true;
  show('render-message', 'Đang tạo giọng đọc với VieNeu-TTS...');

  let voiceData;
  try {
    voiceData = await request('/api/voice', { lines: script.map(s => s.read) });
    voiceData.lines?.forEach((line, i) => {
      voiceDurationCache.set(line, voiceData.timings[i]);
    });
    updateEstimatedDuration();
  } catch (err) {
    show('render-message', 'Lỗi tạo giọng đọc: ' + err.message, true);
    stopLivePlayer();
    return;
  }

  if (!isPlayingLive) return;
  show('render-message', 'Đang tải âm thanh và chuẩn bị bản xem thử...');

  // Compute timeline
  const introDur = (draft.introEffect && draft.introEffect !== 'off') ? 0.6 : 0;
  let elapsed = 0;
  const scenePlans = script.map((scene, i) => {
    const speechDur = voiceData.timings[i] || 2;
    const opening = (i === 0) ? introDur : 0;

    let effDur = 0;
    if (scene.effect && scene.effect !== 'off') {
      const name = scene.effect.startsWith(effectFilePrefix) ? scene.effect.slice(effectFilePrefix.length) : scene.effect;
      effDur = effectDurationsMap.get(name) || 0.8;
    }

    let memeHold = 0;
    if (scene.meme?.file) {
      const info = memeDetailsMap.get(scene.meme.file);
      const isVideo = info?.isVideo || ['.mp4', '.webm', '.mov'].some(ext => scene.meme.file.toLowerCase().endsWith(ext));
      const videoDur = info?.duration || 0;
      if (scene.meme.timing === 'after_read') {
        memeHold = videoDur > 0 ? videoDur : (effDur > 0 ? effDur : 1.5);
      } else {
        if (videoDur > speechDur) memeHold = videoDur - speechDur;
      }
    }

    const reactionDur = Math.max(effDur, memeHold);
    const totalDur = speechDur + opening + reactionDur;
    const plan = {
      start: elapsed,
      duration: totalDur,
      speechDur,
      opening,
      reactionDur,
      audioUrl: voiceData.items[i].url,
      reactionEffect: scene.effect,
      sceneId: scene.id,
      sceneObj: scene,
      index: i,
    };
    elapsed += totalDur;
    return plan;
  });

  // Preload voice audios upfront so playback is zero-latency & in exact sync
  const voiceAudioMap = new Map();
  await Promise.all(scenePlans.map(plan => new Promise(resolve => {
    const audio = new Audio(plan.audioUrl);
    audio.preload = 'auto';
    const done = () => {
      audio.removeEventListener('canplaythrough', done);
      audio.removeEventListener('error', done);
      resolve();
    };
    audio.addEventListener('canplaythrough', done);
    audio.addEventListener('error', done);
    audio.load();
    voiceAudioMap.set(plan.index, audio);
    setTimeout(done, 1200);
  })));

  // Preload intro effect
  let introAudio = null;
  if (introDur > 0 && draft.introEffect && draft.introEffect !== 'off') {
    introAudio = new Audio('/api/effects/audio/' + encodeURIComponent(draft.introEffect));
    introAudio.volume = 0.7;
    introAudio.preload = 'auto';
    introAudio.load();
  }

  // Preload reaction sound effects
  const reactionAudioMap = new Map();
  for (const plan of scenePlans) {
    if (plan.reactionDur > 0 && plan.reactionEffect !== 'off') {
      const effAudio = new Audio('/api/effects/audio/' + encodeURIComponent(plan.reactionEffect));
      effAudio.volume = 0.7;
      effAudio.preload = 'auto';
      effAudio.load();
      reactionAudioMap.set(plan.index, effAudio);
    }
  }

  if (!isPlayingLive) return;

  show('render-message', 'Đang phát thử đồng bộ (Live Preview)...');

  // Background Video
  const bgPlayer = $('background-preview');
  if (draft.bgFile && !bgPlayer.hidden) {
    bgPlayer.currentTime = draft.bgStart || 0;
    bgPlayer.play().catch(() => {});
  }

  // Background Music
  if (draft.music) {
    liveMusicAudio = new Audio('/media/music/' + encodeURIComponent(draft.music));
    liveMusicAudio.volume = 0.15;
    liveMusicAudio.loop = true;
    liveMusicAudio.play().catch(() => {});
  }

  // Setup captions DOM for all scenes
  const capBox = $('preview-captions');
  if (draft.captions?.enabled) {
    capBox.hidden = false;
    applyCaptionsFont(draft.captions?.font || 'Be Vietnam Pro');
    capBox.innerHTML = scenePlans.map(plan =>
      captionsMarkup(plan.sceneObj.read, plan.speechDur, draft.captions.wordsPerLine || 7, plan.index, draft.captions.y || 75, plan.opening)
    ).join('\n');
  } else {
    capBox.hidden = true;
    capBox.innerHTML = '';
  }

  // Paint the first scene card & meme immediately
  activeScene = scenePlans[0].sceneId;
  const firstMeme = scenePlans[0].sceneObj.meme;
  const firstIsAfterRead = firstMeme?.file && firstMeme.timing === 'after_read';
  paintSceneCardAndMeme(scenePlans[0].sceneObj, { hideMeme: firstIsAfterRead });

  // GSAP Master Timeline
  liveTimeline = gsap.timeline({
    onComplete: () => {
      stopLivePlayer();
      show('render-message', 'Đã phát xong bản xem trước.');
    }
  });

  // Attach Captions Animations to GSAP timeline
  if (draft.captions?.enabled) {
    scenePlans.forEach(plan => {
      const container = capBox.querySelector(`#captions-${plan.index}`);
      if (container) {
        addCaptionsAnimation(liveTimeline, container, plan.start);
      }
    });
  }

  // Schedule scene cards, memes, and audios
  scenePlans.forEach((plan, idx) => {
    const meme = plan.sceneObj.meme;
    const isAfterRead = meme?.file && meme.timing === 'after_read';

    // Switch Card & Meme at plan.start (hide meme initially if after_read)
    liveTimeline.call(() => {
      activeScene = plan.sceneId;
      paintSceneCardAndMeme(plan.sceneObj, { hideMeme: isAfterRead });
    }, null, plan.start);

    // If after_read, show meme when speech finishes (reaction timing)
    if (isAfterRead) {
      liveTimeline.call(() => {
        paintSceneCardAndMeme(plan.sceneObj, { hideMeme: false });
      }, null, plan.start + plan.opening + plan.speechDur);
    }

    // Intro effect
    if (idx === 0 && plan.opening > 0 && introAudio) {
      liveTimeline.call(() => {
        introAudio.currentTime = 0;
        introAudio.play().catch(() => {});
        liveAudios.push(introAudio);
      }, null, 0);
    }

    // TTS Voice
    const voiceAudio = voiceAudioMap.get(idx);
    if (voiceAudio) {
      liveTimeline.call(() => {
        voiceAudio.currentTime = 0;
        voiceAudio.play().catch(() => {});
        liveAudios.push(voiceAudio);
      }, null, plan.start + plan.opening);
    }

    // Reaction effect
    const reactionAudio = reactionAudioMap.get(idx);
    if (reactionAudio) {
      liveTimeline.call(() => {
        reactionAudio.currentTime = 0;
        reactionAudio.play().catch(() => {});
        liveAudios.push(reactionAudio);
      }, null, plan.start + plan.opening + plan.speechDur);
    }
  });

  // Outro
  if (draft.outro?.enabled) {
    liveTimeline.call(() => {
      $('preview-card').hidden = true;
      $('preview-meme').hidden = true;
      $('preview-captions').hidden = true;
      const box = $('outro-demo');
      const useBlurBg = draft.outro.blurBackground !== false && Boolean(draft.bgFile);
      if (!useBlurBg) {
        const bg = $('background-preview');
        if (bg) { bg.pause(); bg.hidden = true; }
      }
      box.innerHTML = outroMarkup(draft.outro, { freeze: false, blurBackground: useBlurBg, avatarUrl: getOutroAvatarUrl(draft.outro.avatar) });
      box.hidden = false;
      addOutroAnimation(liveTimeline, box, elapsed);
    }, null, elapsed);
  }

  liveTimeline.play();
}

function stopLivePlayer() {
  if (!isPlayingLive) return;
  isPlayingLive = false;
  $('generate').innerHTML = '<i data-lucide="play"></i> <span>Phát thử (Live)</span>';
  refreshIcons();
  if (liveTimeline) {
    liveTimeline.kill();
    liveTimeline = null;
  }
  liveAudios.forEach(a => { a.pause(); a.currentTime = 0; });
  liveAudios = [];
  if (liveMusicAudio) {
    liveMusicAudio.pause();
    liveMusicAudio.currentTime = 0;
    liveMusicAudio = null;
  }
  const bgPlayer = $('background-preview');
  if (bgPlayer) {
    bgPlayer.pause();
    bgPlayer.currentTime = draft.bgStart || 0;
  }
  paintFrame();
}

$('generate').addEventListener('click', () => {
  if (isPlayingLive) {
    stopLivePlayer();
  } else {
    startLivePlayer();
  }
});

// Full MP4 Export ("Xuất MP4")
$('export').addEventListener('click', async () => {
  if (rendering) return;
  stopLivePlayer();
  stopOutroDemo();

  const script = scenes();
  if (!script.length || script.some(scene => !scene.read.trim() || !scene.quote.trim())) {
    openPanel(draft.post ? 'voice' : 'source', true);
    return show('render-message', 'Thêm bài và điền lời đọc cho mỗi cảnh.', true);
  }

  rendering = true;
  $('export').disabled = true;
  $('generate').disabled = true;
  $('download').hidden = true;
  show('render-message', 'Bắt đầu dựng toàn bộ video MP4 1080 × 1920...');

  try {
    const { id } = await request('/api/preview', {
      backgroundFile: draft.bgFile,
      backgroundStart: draft.bgStart || 0,
      scenes: script,
      introEffect: draft.introEffect,
      music: draft.music,
      outro: draft.outro,
      captions: draft.captions,
    });

    let result;
    const statuses = { voice: 'Đang tạo giọng đọc với VieNeu-TTS…', media: 'Đang ghép giọng, hiệu ứng và nhạc nền…', render: 'Đang dựng MP4 1080 × 1920…' };
    do {
      result = await request('/api/jobs/' + id);
      if (result.status === 'error') throw new Error(result.error);
      if (result.status !== 'ready') {
        const progress = result.status === 'render' && result.progress > 0 ? ' ' + result.progress + '%' : '';
        const length = result.duration ? ' · ' + number.format(Math.round(result.duration * 10) / 10) + ' giây' : '';
        show('render-message', (statuses[result.status] || 'Đang xử lý...') + progress + length);
        await new Promise(r => setTimeout(r, 1200));
      }
    } while (result.status !== 'ready');

    previewId = id;
    $('player').src = '/api/jobs/' + id + '/video';
    $('player').hidden = false;
    $('placeholder').hidden = true;
    $('player').play().catch(() => {});

    // Automatically export to Xuất ra
    const data = await request('/api/jobs/' + id + '/export', {});
    $('download').href = '/api/jobs/' + id + '/video';
    $('download').download = data.name;
    $('download').hidden = false;
    show('render-message', 'Đã xuất video MP4 thành công vào thư mục Xuất ra:\n' + data.name);
  } catch (err) {
    show('render-message', err.message, true);
  } finally {
    rendering = false;
    $('export').disabled = false;
    $('generate').disabled = false;
  }
});

$('new-video').addEventListener('click', () => {
  if (rendering) return;
  if ((draft.post || draft.url) && !confirm('Tạo video mới và xóa bản nháp nội dung hiện tại?')) return;
  draft = {
    ...defaults,
    introEffect: draft.introEffect,
    music: draft.music,
    bgFile: draft.bgFile,
    outro: { ...draft.outro },
    captions: { ...draft.captions },
    reads: {},
    commentEffects: {},
    positions: {},
    memes: {},
  };
  $('thread-url').value = '';
  $('search').value = '';
  $('manual-comments').value = '';
  $('manual').open = false;
  show('thread-message', '');
  show('render-message', '');
  paintPost();
  openPanel('source', true);
});

// Initialization
$('thread-url').value = draft.url;
$('thread-url').addEventListener('input', () => { draft.url = $('thread-url').value; save(); });
$('authors').checked = draft.authors;
$('authors').addEventListener('change', () => { draft.authors = $('authors').checked; changed(); paintFrame(); });
$('search').addEventListener('input', paintComments);
$('sort').addEventListener('change', paintComments);
$('grid-preview').innerHTML = gridMarkup;

loadBackgrounds();
loadMemes();
loadFonts();
loadEffectsLibrary();
paintPost();
updateTimeline();
updateEstimatedDuration();
openPanel(draft.panel || 'source');
refreshIcons();
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', refreshIcons);
}
window.addEventListener('load', refreshIcons);
setTimeout(refreshIcons, 100);
setTimeout(refreshIcons, 500);
