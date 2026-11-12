import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const hosts = new Set(['threads.com', 'www.threads.com', 'threads.net', 'www.threads.net']);
const postPath = /^\/@([\w.]+)\/post\/([A-Za-z0-9_-]+)\/?$/;
const maxComments = 100;
const profile = path.join(process.env.LOCALAPPDATA || os.homedir(), 'Threads-to-Video', 'Chrome');
let signedInContext;
let launching;

export function threadUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 2048) return null;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'https:' || !hosts.has(url.hostname) || url.username || url.password || url.port ||
        !postPath.test(url.pathname)) return null;
    return url.origin + url.pathname.replace(/\/$/, '');
  } catch {
    return null;
  }
}

async function persistent() {
  if (signedInContext) return signedInContext;
  if (!launching) {
    launching = chromium.launchPersistentContext(profile, { channel: 'chrome', headless: true, locale: 'en-US', serviceWorkers: 'block' })
      .then(context => {
        signedInContext = context;
        context.on('close', () => { if (signedInContext === context) signedInContext = null; });
        return context;
      }).finally(() => { launching = null; });
  }
  return launching;
}

export async function closeThreadsProfile() {
  await signedInContext?.close();
}

function count(value) {
  const raw = value.trim();
  if (/^\d+$/.test(raw)) return { likes: Number(raw) };
  if (/^\d{1,3}(,\d{3})+$/.test(raw)) return { likes: Number(raw.replaceAll(',', '')) };
  const abbreviated = /^(\d+(?:[.,]\d+)?)\s*([kmb])$/i.exec(raw);
  if (!abbreviated) return { likes: null };
  return {
    likes: Math.round(Number(abbreviated[1].replace(',', '.')) * { k: 1000, m: 1e6, b: 1e9 }[abbreviated[2].toLowerCase()]),
    approximate: true,
  };
}

async function readPage(page, rootCode) {
  return page.evaluate(code => {
    const pattern = /^\/@([\w.]+)\/post\/([A-Za-z0-9_-]+)\/?$/;
    let media;
    function findRoot(value) {
      if (!value || typeof value !== 'object' || media) return;
      if (value.data?.media?.code === code) {
        media = value.data.media;
        return;
      }
      Object.values(value).forEach(findRoot);
    }
    for (const script of document.querySelectorAll('script[type="application/json"]')) {
      if (!script.textContent.includes(code)) continue;
      try { findRoot(JSON.parse(script.textContent)); } catch { /* Other page scripts can use a different format. */ }
    }

    const direct = new Map();
    const info = media?.text_post_app_info;
    for (const edge of info?.direct_replies?.edges ?? []) {
      const post = edge.node?.posts?.edges?.[0]?.node;
      if (post?.code && (post.text_post_app_info?.reply_level ?? 1) === 1) direct.set(post.code, post);
    }

    const result = [];
    let root;
    const pagelets = document.querySelectorAll('[data-pagelet^="threads_post_page"]');
    for (const pagelet of pagelets) {
      for (const card of pagelet.querySelectorAll('[data-interactive-id]')) {
        if (card.closest('[data-pagelet]') !== pagelet) continue;
        const titles = [...card.querySelectorAll('svg title')];
        const action = title => titles.find(node => node.textContent === title)?.closest('[role="button"],button');
        const like = action('Like') || action('Unlike') || action('Thích') || action('Bỏ thích');
        if (!like) continue;
        const link = [...card.querySelectorAll('a[href]')].find(anchor => pattern.test(anchor.pathname));
        if (!link) continue;
        const [, author, id] = pattern.exec(link.pathname);
        const structured = id === code ? media : direct.get(id);
        // Direct replies on the thread page each occupy a virtualized row. A card
        // nested in another card is a quote or a child reply, not a direct reply.
        if (card.parentElement?.closest('[data-interactive-id]')) continue;
        if (id !== code && !direct.has(id) && !card.closest('[data-virtualized]')) continue;
        const textNode = [...card.querySelectorAll('span[dir="auto"],div[dir="auto"]')].find(node =>
          link.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING &&
          !node.contains(link) && !link.contains(node) &&
          !node.closest('[role="button"],button') && node.innerText?.trim() &&
          !node.parentElement?.closest('[dir="auto"]'));
        const copy = textNode?.cloneNode(true);
        copy?.querySelectorAll('button,[role="button"]').forEach(node => node.remove());
        const text = structured?.caption?.text?.trim() || copy?.textContent?.trim() || '';
        const row = {
          id, author, text,
          label: like.innerText.trim(),
          metrics: {
            likes: like.innerText.trim(),
            replies: (action('Comment') || action('Reply') || action('Bình luận') || action('Trả lời'))?.innerText.trim() || '',
            reposts: (action('Repost') || action('Đăng lại'))?.innerText.trim() || '',
            shares: (action('Share') || action('Chia sẻ'))?.innerText.trim() || '',
          },
          exactLikes: structured?.like_and_view_counts_disabled === false ? structured.like_count : null,
        };
        if (id === code) root = row;
        else if (text) result.push(row);
      }
    }

    const body = document.body.innerText;
    return {
      root,
      replies: result,
      expected: info?.direct_reply_count,
      loginWall: /log in to see more replies|sign up to see more replies|đăng nhập để xem thêm (?:câu trả lời|phản hồi|bình luận)/i.test(body),
      canLoadMore: Boolean(info?.direct_replies?.page_info?.has_next_page),
    };
  }, rootCode);
}

function normalize(row) {
  const displayed = count(row.label);
  const precise = displayed.approximate && Number.isSafeInteger(row.exactLikes);
  const zero = !row.label && row.exactLikes === 0;
  return {
    id: row.id, author: row.author, text: row.text.slice(0, 5000), metrics: row.metrics,
    ...(precise || zero ? { likes: row.exactLikes } : displayed),
  };
}

export async function getThread(url) {
  let browser;
  let context;
  let page;
  const saved = Boolean(signedInContext || launching || existsSync(profile));
  try {
    if (saved) context = await persistent();
    else {
      browser = await chromium.launch({ channel: 'chrome', headless: true });
      context = await browser.newContext({ locale: 'en-US', serviceWorkers: 'block' });
    }
    page = await context.newPage();
    await page.route('**/*', async route => {
      const request = route.request();
      const target = new URL(request.url());
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        if (!threadUrl(target.href)) return route.abort();
      }
      const meta = /(^|\.)(threads\.(com|net)|fbcdn\.net|cdninstagram\.com|facebook\.com|instagram\.com)$/.test(target.hostname);
      if (target.protocol !== 'https:' || !meta || ['image', 'media', 'font'].includes(request.resourceType())) {
        return route.abort();
      }
      return route.continue();
    });

    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(error => {
      if (String(error).includes('ERR_FAILED') || String(error).includes('ERR_BLOCKED_BY_CLIENT')) return null;
      throw error;
    });
    if (response) {
      await page.locator('[data-pagelet^="threads_post_page"] [data-interactive-id]').first()
        .waitFor({ timeout: 4500 }).catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 3500 }).catch(() => {});
    }

    const code = new URL(url).pathname.match(postPath)[2];
    const rows = new Map();
    let snapshot;
    let root;
    let stalled = 0;
    for (let step = 0; response?.ok() && step < 15 && rows.size < maxComments; step++) {
      snapshot = await readPage(page, code);
      root = snapshot.root || root;
      const before = rows.size;
      for (const row of snapshot.replies) {
        if (rows.size >= maxComments) break;
        rows.set(row.id, normalize(row));
      }
      if (!root || snapshot.loginWall || rows.size === maxComments ||
          (Number.isInteger(snapshot.expected) && rows.size >= snapshot.expected)) break;
      stalled = rows.size === before ? stalled + 1 : 0;
      if (stalled === 3) break;
      const more = page.getByRole('button', { name: /^(show|load|see|view) more replies$|^xem thêm (?:câu trả lời|phản hồi|bình luận)$/i })
        .filter({ visible: true }).first();
      if (await more.count() && await more.evaluate(node => !node.closest('[data-interactive-id]'))) {
        await more.click({ timeout: 1200 }).catch(() => {});
      }
      await page.locator('[data-pagelet^="threads_post_page"]').last()
        .locator('[data-interactive-id]').last().scrollIntoViewIfNeeded({ timeout: 1400 }).catch(() => {});
      await page.mouse.move(650, 650);
      await page.mouse.wheel(0, 660);
      await page.waitForTimeout(550);
    }
    if (!root) {
      return { post: null, comments: [], warning: 'Trang không hiển thị bài viết. Hãy kiểm tra link hoặc nhập nội dung thủ công.' };
    }

    const comments = [...rows.values()];
    const notes = [];
    if (snapshot.loginWall) notes.push('Threads chỉ hiển thị một phần bình luận. Bạn có thể nhập bổ sung bên dưới.');
    else if (comments.length === maxComments) notes.push('Đã lấy tối đa 100 bình luận trực tiếp.');
    else if (snapshot.expected > comments.length || snapshot.canLoadMore) notes.push('Trang chỉ tải một phần bình luận dạng chữ. Bạn có thể nhập bổ sung.');
    if (comments.some(comment => comment.likes == null)) notes.push('Một số bình luận chưa rõ số tim.');
    if (!root.text) notes.push('Bài này chưa có phần chữ để dựng. Hãy nhập nội dung bài viết.');
    return {
      post: { ...normalize(root), text: root.text.slice(0, 5000) },
      comments,
      warning: notes.join(' '),
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
    else await page?.close().catch(() => {});
    if (saved && context && context === signedInContext) {
      await context.close().catch(() => {});
    }
  }
}
