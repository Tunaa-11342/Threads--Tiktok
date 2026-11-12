import { cardMarkup, gridMarkup, quotePages } from './thread-card.mjs';
import { cardPosition, defaultPosition, positionLimits } from './placement.mjs';
import { effectChoices, effectFilePrefix } from './effect-options.mjs';
import { addOutroAnimation, defaultOutro, normalizeOutro, outroDuration, outroMarkup } from './outro.mjs';

const $ = id => document.getElementById(id);
const storageKey = 'threads-to-video-draft-v1';
const defaults = { url: '', post: null, comments: [], selected: [], reads: {}, authors: true, fetched: 0, introEffect: 'auto', music: '', commentEffects: {}, positions: {}, outro: defaultOutro, panel: 'source' };
let draft;
try { draft = { ...defaults, ...JSON.parse(localStorage.getItem(storageKey)) }; }
catch { draft = { ...defaults }; }
draft.outro = normalizeOutro(draft.outro);
if (draft.effect && draft.effect !== 'auto') {
  for (const id of draft.selected) {
    if (!draft.commentEffects[id]) draft.commentEffects[id] = draft.effect;
  }
}
delete draft.effect;
let backgroundId;
let objectUrl;
let previewId;
let revision = 0;
let rendering = false;
let activeScene = 'post';
let effectTracks = [];
let outroDemo;
const maxSelected = 4;
const number = new Intl.NumberFormat('vi-VN');

function save() {
  try { localStorage.setItem(storageKey, JSON.stringify(draft)); }
  catch { /* The current draft remains available in memory. */ }
}

function changed() {
  stopOutroDemo();
  revision++;
  updateTimeline();
  save();
  if (previewId) {
    previewId = null;
    $('player').pause();
    $('player').removeAttribute('src');
    $('player').load();
    $('player').hidden = true;
    $('placeholder').hidden = false;
    $('download').hidden = true;
    $('export').disabled = true;
    show('render-message', 'Đã sửa bản nháp. Tạo bản xem trước mới để xuất.');
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

const sortLikes = (a, b) => (b.likes ?? -1) - (a.likes ?? -1);
const findComment = id => draft.comments.find(comment => comment.id === id);
const searchText = text => text.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '').replaceAll('đ', 'd');

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
    const likes = comment.likes == null ? 'Chưa rõ tim' : '♥ ' + number.format(comment.likes) + (comment.approximate ? '+' : '');
    label.append(checkbox, element('span', 'comment-text', comment.text), element('span', 'comment-likes', likes));
    row.append(label);
    return row;
  }));

  $('selected-list').replaceChildren(...draft.selected.map((id, index) => {
    const comment = findComment(id);
    const entry = element('li');
    const row = element('div', 'selected-row');
    row.append(element('span', 'position', String(index + 1)), element('span', 'comment-text', comment.text));
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
    const effect = element('select');
    effect.id = 'effect-' + id;
    effect.dataset.sceneEffect = id;
    label.htmlFor = effect.id;
    effectSelect(effect, draft.commentEffects[id] || 'auto');
    effect.addEventListener('change', () => {
      draft.commentEffects[id] = effect.value;
      activeScene = id;
      changed();
      paintFrame();
    });
    settings.append(label, effect);
    entry.append(row, settings);
    return entry;
  }));
}

function shorten(text, limit) {
  const clean = text.trim().replace(/\s+/gu, ' ');
  if (clean.length <= limit) return clean;
  const stop = clean.lastIndexOf(' ', limit);
  return clean.slice(0, stop >= limit * .75 ? stop : limit).trimEnd() + '…';
}

function spoken(text) {
  const clean = text.replace(/https?:\/\/\S+/gi, '')
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
    ...scene, quote: scene.text, read: draft.reads[scene.id] ?? spoken(scene.text),
    author: draft.authors ? scene.author : '',
    position: cardPosition(draft.positions[scene.id]),
    effect: scene.id === 'post' ? 'off' : draft.commentEffects[scene.id] || 'auto',
  }));
}

function paintFrame() {
  const items = scenes();
  const scene = items.find(item => item.id === activeScene) || items[0];
  $('frame-empty').hidden = Boolean(scene?.quote);
  $('preview-card').hidden = !scene?.quote;
  paintPlacement(items, scene);
  if (!scene?.quote) return;
  $('preview-card').style.setProperty('--card-x', scene.position.x + '%');
  $('preview-card').style.setProperty('--card-y', scene.position.y + '%');
  $('preview-card').innerHTML = cardMarkup({ ...scene, quote: quotePages(scene.quote)[0] });
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

function setPosition(position) {
  const id = $('placement-scene').value;
  if (!id) return;
  draft.positions[id] = cardPosition(position);
  changed();
  paintFrame();
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

$('placement-scene').addEventListener('change', () => {
  stopOutroDemo();
  activeScene = $('placement-scene').value;
  if (previewId) {
    $('player').pause();
    $('player').hidden = true;
    $('placeholder').hidden = false;
    $('show-rendered').hidden = false;
  }
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

function stopOutroDemo() {
  if (!outroDemo) return;
  const { timeline, timer, hadVideo, wasPlaying } = outroDemo;
  outroDemo = null;
  clearTimeout(timer);
  timeline.kill();
  $('outro-demo').hidden = true;
  $('outro-demo').replaceChildren();
  $('outro-play').textContent = 'Xem thử outro';
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
  $('frame-empty').hidden = true;
  video.pause();
  box.innerHTML = outroMarkup(draft.outro, { freeze: false });
  box.hidden = false;
  const timeline = gsap.timeline({ paused: true });
  addOutroAnimation(timeline, box, 0);
  const timer = still ? null : setTimeout(() => {
    stopOutroDemo();
    if (draft.panel === 'outro') showOutro(true);
  }, outroDuration * 1000);
  outroDemo = { timeline, timer, hadVideo, wasPlaying, still };
  $('outro-play').textContent = still ? 'Xem thử outro' : 'Dừng xem thử';
  if (still || matchMedia('(prefers-reduced-motion: reduce)').matches) timeline.progress(1);
  else timeline.play();
}

$('outro-enabled').checked = draft.outro.enabled;
$('outro-play').disabled = !draft.outro.enabled;
$('outro-enabled').addEventListener('change', () => {
  draft.outro.enabled = $('outro-enabled').checked;
  $('outro-play').disabled = !draft.outro.enabled;
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
  if (play && matchMedia('(max-width: 900px)').matches) document.querySelector('.frame')?.scrollIntoView();
});

effectSelect($('effect'), draft.introEffect);
$('effect').addEventListener('change', () => { draft.introEffect = $('effect').value; changed(); });
async function loadEffects() {
  const refresh = $('effects-refresh');
  if (refresh.disabled) return;
  refresh.disabled = true;
  try {
    const { tracks } = await request('/api/effects');
    effectTracks = tracks;
    effectSelect($('effect'), draft.introEffect);
    document.querySelectorAll('[data-scene-effect]').forEach(select => {
      effectSelect(select, draft.commentEffects[select.dataset.sceneEffect] || 'auto');
    });
    $('effects-hint').textContent = tracks.length
      ? tracks.length + ' file trong Sound Effects. Tự động dùng các file này.'
      : 'Thả file vào Sound Effects để thêm hiệu ứng. Tự động đang dùng âm có sẵn.';
  } catch (error) {
    $('effects-hint').textContent = error.message;
  } finally {
    refresh.disabled = false;
  }
}
$('effects-refresh').addEventListener('click', loadEffects);
window.addEventListener('focus', loadEffects);
loadEffects();

$('music').addEventListener('change', () => { draft.music = $('music').value; changed(); });

async function loadMusic() {
  const select = $('music');
  if ($('music-refresh').disabled) return;
  $('music-refresh').disabled = true;
  try {
    const { tracks } = await request('/api/music');
    const none = element('option', '', 'Không dùng nhạc');
    none.value = '';
    select.replaceChildren(none, ...tracks.map(name => {
      const option = element('option', '', name);
      option.value = name;
      return option;
    }));
    select.value = tracks.includes(draft.music) ? draft.music : '';
    if (draft.music && !select.value) {
      draft.music = '';
      changed();
    }
    $('music-hint').textContent = tracks.length
      ? tracks.length + ' bài trong thư mục Nhạc nền.'
      : 'Thả MP3, WAV hoặc M4A vào thư mục Nhạc nền cạnh Chay-tool.cmd.';
  } catch (error) {
    $('music-hint').textContent = error.message;
  } finally {
    $('music-refresh').disabled = false;
  }
}
$('music-refresh').addEventListener('click', loadMusic);
window.addEventListener('focus', loadMusic);
loadMusic();

$('thread-url').value = draft.url;
$('thread-url').addEventListener('input', () => { draft.url = $('thread-url').value; save(); });
$('authors').checked = draft.authors;
$('authors').addEventListener('change', () => { draft.authors = $('authors').checked; changed(); paintFrame(); });
$('search').addEventListener('input', paintComments);
$('sort').addEventListener('change', paintComments);
$('grid-preview').innerHTML = gridMarkup;
paintPost();

function updateTimeline() {
  $('project-name').textContent = draft.post?.text ? shorten(draft.post.text, 58) : 'Video Threads';
  $('post-summary').textContent = draft.post?.text ? shorten(draft.post.text, 54) : 'Chưa có bài';
  $('comments-summary').textContent = draft.selected.length + ' bình luận';
  $('intro-summary').textContent = effectChoices.find(([key]) => key === draft.introEffect)?.[1] ||
    draft.introEffect.slice(effectFilePrefix.length);
  $('outro-summary').textContent = draft.outro.enabled ? normalizeOutro(draft.outro).handle : 'Đã tắt';
}

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
}

document.querySelectorAll('[data-open]').forEach(button => {
  button.addEventListener('click', () => openPanel(button.dataset.open, true));
});
$('new-video').addEventListener('click', () => {
  if (rendering) return;
  if ((draft.post || draft.url) && !confirm('Tạo video mới và xóa bản nháp nội dung hiện tại?')) return;
  draft = { ...defaults, introEffect: draft.introEffect, music: draft.music,
    outro: { ...draft.outro }, reads: {}, commentEffects: {}, positions: {} };
  $('thread-url').value = '';
  $('search').value = '';
  $('manual-comments').value = '';
  $('manual').open = false;
  $('background').value = '';
  $('background').dispatchEvent(new Event('change'));
  show('thread-message', '');
  show('render-message', '');
  paintPost();
  openPanel('source', true);
});
updateTimeline();
openPanel(draft.panel || 'source');

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

$('add-manual').addEventListener('click', () => {
  const text = $('manual-post').value.trim();
  const manual = $('manual-comments').value.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
  if (!text) return show('thread-message', 'Nhập nội dung bài viết trước.', true);
  if (manual.length > 100) return show('thread-message', 'Thêm tối đa 100 bình luận mỗi lần.', true);
  if (text !== draft.post?.text) {
    draft.post = { ...draft.post, text, edited: true };
    delete draft.reads.post;
  }
  const additions = manual.map(line => {
    const match = /^(.*?)\s*\|\s*(\d+)$/u.exec(line);
    const likes = match ? Number(match[2]) : null;
    return { id: crypto.randomUUID(), text: (match?.[1] || line).trim(), likes: Number.isSafeInteger(likes) ? likes : null };
  });
  const firstComments = draft.comments.length === 0;
  draft.comments = [...draft.comments, ...additions];
  if (firstComments) draft.selected = [...additions].sort(sortLikes).slice(0, maxSelected).map(comment => comment.id);
  $('manual-comments').value = '';
  changed();
  paintPost();
  show('thread-message', 'Đã cập nhật bài viết.' + (additions.length ? ' Đã thêm ' + additions.length + ' bình luận.' : ''));
});

$('background').addEventListener('change', () => {
  const file = $('background').files[0];
  backgroundId = null;
  changed();
  const player = $('background-preview');
  player.pause();
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  player.hidden = !file;
  $('preview-scrim').hidden = !file;
  $('grid-preview').hidden = Boolean(file);
  if (file) {
    objectUrl = URL.createObjectURL(file);
    player.src = objectUrl;
    player.play().catch(() => {});
  } else {
    player.removeAttribute('src');
  }
});
$('background-preview').addEventListener('error', () => {
  $('background-preview').hidden = true;
  $('preview-scrim').hidden = true;
  $('grid-preview').hidden = false;
});

$('generate').addEventListener('click', async () => {
  if (rendering) return;
  stopOutroDemo();
  if (previewId) {
    $('show-rendered').click();
    $('player').play().catch(() => {});
    return;
  }
  const file = $('background').files[0];
  const script = scenes();
  if (!script.length || script.some(scene => !scene.read.trim() || !scene.quote.trim())) {
    openPanel(draft.post ? 'voice' : 'source', true);
    return show('render-message', 'Thêm bài và điền lời đọc cho mỗi cảnh.', true);
  }
  rendering = true;
  $('generate').disabled = true;
  $('export').disabled = true;
  $('download').hidden = true;
  $('background').disabled = true;
  const version = revision;
  try {
    if (file && !backgroundId) {
      show('render-message', 'Đang kiểm tra video nền…');
      const form = new FormData();
      form.append('video', file);
      backgroundId = (await request('/api/background', form)).id;
    }
    const { id } = await request('/api/preview', { background: backgroundId, scenes: script, introEffect: draft.introEffect, music: draft.music, outro: draft.outro });
    let result;
    const statuses = { voice: 'Đang tạo giọng đọc với VieNeu-TTS…', media: 'Đang ghép giọng, hiệu ứng và nhạc nền…', render: 'Đang dựng MP4 1080 × 1920…' };
    do {
      result = await request('/api/jobs/' + id);
      if (result.status === 'error') throw new Error(result.error);
      if (result.status !== 'ready') {
        const progress = result.status === 'render' && result.progress > 0 ? ' ' + result.progress + '%' : '';
        const length = result.duration ? ' · ' + number.format(Math.round(result.duration * 10) / 10) + ' giây' : '';
        show('render-message', statuses[result.status] + progress + length);
        await new Promise(resolve => setTimeout(resolve, 1200));
      }
    } while (result.status !== 'ready');
    if (revision !== version) {
      show('render-message', 'Bản nháp đã đổi trong lúc dựng. Tạo bản xem trước mới để xuất.');
      return;
    }
    stopOutroDemo();
    previewId = id;
    $('player').src = '/api/jobs/' + id + '/video';
    $('player').hidden = false;
    $('placeholder').hidden = true;
    $('background-preview').pause();
    $('player').play().catch(() => {});
    $('voice-name').textContent = result.voice + ' · VieNeu-TTS';
    const duration = number.format(Math.round(result.duration * 10) / 10);
    show('render-message', 'Video dài ' + duration + ' giây.' +
      (result.duration < 35 || result.duration > 50 ? ' Có thể sửa lời đọc để đưa về 35–50 giây.' : ''));
  } catch (error) {
    if (error.message.includes('Chọn video nền')) backgroundId = null;
    show('render-message', error.message, true);
  } finally {
    rendering = false;
    $('generate').disabled = false;
    $('background').disabled = false;
    $('export').disabled = !previewId;
  }
});

$('export').addEventListener('click', async () => {
  const id = previewId;
  if (!id) return;
  $('export').disabled = true;
  try {
    const data = await request('/api/jobs/' + id + '/export', {});
    if (id !== previewId) return;
    $('download').href = '/api/jobs/' + id + '/video';
    $('download').download = data.name;
    $('download').hidden = false;
    show('render-message', 'Đã lưu vào Xuất ra:\n' + data.name);
  } catch (error) {
    show('render-message', error.message, true);
  } finally {
    $('export').disabled = !previewId || rendering;
  }
});
