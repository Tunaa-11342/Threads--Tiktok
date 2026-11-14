import { escape } from './thread-card.mjs';

export function splitWords(text) {
  return String(text || '').trim().split(/\s+/u).filter(Boolean);
}

export function chunkLines(words, wordsPerLine = 7) {
  const lines = [];
  for (let i = 0; i < words.length; i += wordsPerLine) {
    lines.push(words.slice(i, i + wordsPerLine));
  }
  return lines;
}

export function computeCaptionsTiming(text, duration, wordsPerLine = 7, delay = 0) {
  const words = splitWords(text);
  if (!words.length || !(duration > 0)) return { lines: [], allWords: [] };

  const weights = words.map(w => Math.max(2, w.length));
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const timePerUnit = duration / totalWeight;

  let current = delay;
  const wordObjs = words.map((w, index) => {
    const wordDur = weights[index] * timePerUnit;
    const obj = {
      text: w,
      index,
      start: current,
      end: current + wordDur,
      duration: wordDur,
    };
    current += wordDur;
    return obj;
  });

  const rawLines = chunkLines(wordObjs, wordsPerLine);
  const lines = rawLines.map((lineWords, lineIndex) => ({
    lineIndex,
    start: lineWords[0].start,
    end: lineWords[lineWords.length - 1].end,
    duration: lineWords[lineWords.length - 1].end - lineWords[0].start,
    words: lineWords,
  }));

  return { lines, allWords: wordObjs };
}

export function captionsMarkup(text, duration, wordsPerLine = 7, sceneIndex = 0, y = 75, delay = 0) {
  const { lines } = computeCaptionsTiming(text, duration, wordsPerLine, delay);
  if (!lines.length) return '';

  const linesHtml = lines.map(line => {
    const wordsHtml = line.words.map(w =>
      `<span class="tiktok-word" id="word-${sceneIndex}-${w.index}" data-wstart="${w.start.toFixed(3)}" data-wdur="${w.duration.toFixed(3)}">${escape(w.text)}</span>`
    ).join(' ');
    return `<div class="tiktok-caption-line" id="line-${sceneIndex}-${line.lineIndex}" data-lstart="${line.start.toFixed(3)}" data-ldur="${line.duration.toFixed(3)}" style="display: none;">${wordsHtml}</div>`;
  }).join('');

  return `<div class="tiktok-captions-container" id="captions-${sceneIndex}" style="--captions-y: ${y}%;">${linesHtml}</div>`;
}

export function addCaptionsAnimation(timeline, container, sceneStart = 0) {
  if (!timeline || !container) return;
  const lines = container.querySelectorAll('.tiktok-caption-line');
  lines.forEach(lineEl => {
    const lStart = sceneStart + Number(lineEl.dataset.lstart);
    const lDur = Number(lineEl.dataset.ldur);
    timeline.set(lineEl, { display: 'inline-block', immediateRender: false }, lStart);
    timeline.set(lineEl, { display: 'none', immediateRender: false }, lStart + lDur);
  });

  const words = container.querySelectorAll('.tiktok-word');
  words.forEach(wordEl => {
    const wStart = sceneStart + Number(wordEl.dataset.wstart);
    const wDur = Number(wordEl.dataset.wdur);
    timeline.set(wordEl, { color: '#FFE600', scale: 1.2, textShadow: '0 0 1.2cqw rgba(255, 230, 0, 0.85)', immediateRender: false }, wStart);
    timeline.set(wordEl, { color: '#FFFFFF', scale: 1.0, textShadow: 'none', immediateRender: false }, wStart + wDur);
  });
}
