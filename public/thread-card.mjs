export const escape = text => String(text ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));

const icons = {
  likes: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1.1L12 21.3l7.8-7.8 1.1-1.1a5.5 5.5 0 0 0-.1-7.8Z"/>',
  replies: '<path d="M21 11.5a9 9 0 1 0-4 7.5l4 1-1-3.8a8.9 8.9 0 0 0 1-4.7Z"/>',
  reposts: '<path d="m16 3 4 4-4 4M4 11V9a2 2 0 0 1 2-2h14M8 21l-4-4 4-4m12 0v2a2 2 0 0 1-2 2H4"/>',
  shares: '<path d="m3 3 19 9-19 9 4-9-4-9Zm4 9h15"/>',
};

export function cardMarkup({ quote, author, edited, metrics, likes }) {
  const label = author || (edited ? 'Nội dung nhập tay' : '');
  const name = label ? '<strong>' + escape(label) + '</strong>' : '';
  const values = { ...metrics, likes: metrics?.likes || (likes == null ? '' : String(likes)) };
  const actions = Object.entries(icons).map(([key, icon]) =>
    '<span class="thread-action thread-' + key + '"><svg aria-hidden="true" viewBox="0 0 24 24">' + icon +
    '</svg>' + escape(values[key]) + '</span>').join('');
  const size = quote.length > 380 ? ' dense' : '';
  return '<article class="thread-card' + size + '"><div class="thread-header"><span class="thread-avatar" aria-hidden="true"></span>' +
    name + '<span class="thread-logo" aria-label="Threads">@</span></div><p class="thread-copy">' +
    escape(quote) + '</p><div class="thread-actions">' + actions + '</div></article>';
}

export const gridMarkup = '<svg class="thread-grid" viewBox="0 0 1080 1920" preserveAspectRatio="none" aria-hidden="true">' +
  '<path d="M114 0Q154 480 105 960T119 1920M229 0Q279 460 220 960T235 1920M348 0Q403 490 340 960T355 1920M470 0Q528 470 464 960T482 1920M590 0Q649 470 586 960T602 1920M710 0Q773 490 707 960T722 1920M834 0Q895 490 833 960T844 1920M960 0Q1018 460 960 960T966 1920M0 310Q540 281 1080 315M0 420Q540 388 1080 426M0 530Q540 500 1080 535M0 640Q540 610 1080 646M0 750Q540 720 1080 756M0 860Q540 835 1080 865M0 970Q540 945 1080 975M0 1080Q540 1052 1080 1086M0 1190Q540 1160 1080 1196M0 1300Q540 1272 1080 1306"/>' +
  '</svg>';

export function quotePages(text) {
  const pages = [];
  let remaining = text;
  while (remaining.length > 500 || remaining.split('\n').length > 12) {
    const lines = remaining.split('\n');
    const lineBreak = lines.length > 12 ? lines.slice(0, 12).join('\n').length + 1 : Infinity;
    const boundary = Math.min(500, lineBreak);
    const wordBreak = remaining.lastIndexOf(' ', boundary);
    const end = boundary === lineBreak ? boundary : wordBreak > 350 ? wordBreak + 1 : boundary;
    pages.push(remaining.slice(0, end));
    remaining = remaining.slice(end);
  }
  pages.push(remaining);
  return pages;
}
