import { escape, gridMarkup } from './thread-card.mjs';

export const outroDuration = 3;
export const defaultOutro = {
  enabled: true, handle: '@lapzone64', name: 'LapZone', button: 'Follow',
  prompt: 'Follow để không lỡ phần tiếp theo nha!',
  confirm: 'Đã theo dõi · cảm ơn bạn',
};

export function normalizeOutro(settings) {
  const limit = { handle: 32, name: 24, button: 10, prompt: 110, confirm: 42 };
  const fields = Object.entries(limit).map(([key, size]) => [
    key, (typeof settings?.[key] === 'string' && settings[key].trim().slice(0, size)) || defaultOutro[key],
  ]);
  return { enabled: settings?.enabled !== false, ...Object.fromEntries(fields) };
}

export function outroMarkup(settings, { timing = '', freeze = null } = {}) {
  const { handle, name, button, prompt, confirm } = normalizeOutro(settings);
  const still = freeze ? '<img src="' + freeze + '" alt="">' : gridMarkup;
  const backdrop = freeze === false
    ? '<div class="outro-glass"></div>'
    : '<div class="outro-still">' + still + '</div><div class="outro-blur">' + still + '</div>';
  return '<section class="clip follow-outro"' + timing + '>' + backdrop + '<div class="outro-shade"></div>' +
    '<p class="follow-prompt">' + escape(prompt) + '</p>' +
    '<div class="follow-card"><span class="follow-avatar"><img src="lapzone-logo.svg" alt=""></span>' +
    '<div class="follow-account"><strong>' + escape(name) + '</strong><span class="follow-handle">' + escape(handle) + '</span>' +
    '<span class="follow-confirm">' + escape(confirm) + '</span></div>' +
    '<div class="follow-action"><span class="follow-pill"></span><span class="follow-round"></span>' +
    '<span class="follow-label">' + escape(button) + '</span>' +
    '<svg class="follow-glyph" viewBox="0 0 24 24" aria-hidden="true"><path class="follow-stroke" d="M6 12L12 12L18 12"/>' +
    '<path class="follow-cross" d="M12 6V18"/></svg>' +
    '<span class="follow-ripple"></span><span class="follow-tap"></span></div></div></section>';
}

export function addOutroAnimation(tl, root, start) {
  const target = name => root.querySelector('.' + name);
  const click = start + 1.07;
  const blur = target('outro-blur') || target('outro-glass');
  tl.fromTo(blur, { opacity: 0 }, { opacity: 1, duration: .48, ease: 'power2.out' }, start);
  tl.fromTo(target('outro-shade'), { opacity: 0 }, { opacity: 1, duration: .42 }, start);
  tl.fromTo(target('follow-prompt'), { opacity: 0, yPercent: 22 },
    { opacity: 1, yPercent: 0, duration: .42, ease: 'power3.out' }, start + .16);
  tl.fromTo(target('follow-card'), { opacity: 0, yPercent: 30, scale: .96 },
    { opacity: 1, yPercent: 0, scale: 1, duration: .46, ease: 'back.out(1.15)' }, start + .22);
  tl.fromTo(target('follow-tap'), { opacity: 0, xPercent: 100, yPercent: 120, scale: 1.15 },
    { opacity: 1, xPercent: 0, yPercent: 0, scale: 1, duration: .34, ease: 'power2.out' }, start + .65);
  tl.to(target('follow-tap'), { scale: .68, duration: .09, ease: 'power2.in' }, click - .09);
  tl.to(target('follow-tap'), { opacity: 0, scale: 1.25, duration: .24, ease: 'power2.out' }, click);
  tl.fromTo(target('follow-ripple'), { opacity: .76, scale: .55 },
    { opacity: 0, scale: 1.9, duration: .42, ease: 'power2.out', immediateRender: false }, click);
  tl.to(target('follow-pill'), { scaleX: .43, opacity: 0, duration: .28, ease: 'power2.inOut' }, click);
  tl.to(target('follow-label'), { opacity: 0, xPercent: 18, duration: .16 }, click);
  tl.fromTo(target('follow-round'), { opacity: 0, scale: .7 },
    { opacity: 1, scale: 1, duration: .35, ease: 'back.out(1.8)' }, click + .11);
  tl.to(target('follow-cross'), { opacity: 0, scaleY: 0, transformOrigin: 'center', duration: .17 }, click + .05);
  tl.to(target('follow-stroke'), { attr: { d: 'M6 12L10 16L19 7' }, duration: .31, ease: 'power2.inOut' }, click + .09);
  tl.to(target('follow-glyph'), { xPercent: -30, color: '#148455', duration: .26, ease: 'power2.out' }, click + .1);
  tl.to(target('follow-handle'), { opacity: 0, yPercent: -28, duration: .17 }, click + .03);
  tl.fromTo(target('follow-confirm'), { opacity: 0, yPercent: 28 },
    { opacity: 1, yPercent: 0, duration: .26, ease: 'power2.out' }, click + .19);
}
