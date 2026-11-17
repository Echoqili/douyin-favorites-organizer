import { cli, Strategy } from "@jackwener/opencli/registry";
import {
  ArgumentError,
  AuthRequiredError,
  CommandExecutionError,
  EmptyResultError,
} from "@jackwener/opencli/errors";
import {
  extractSelfUser,
  limits,
  mapSavedAweme,
  mergeCapturedSavedPages,
  normalizeLimit,
  savedCaptureCoverage,
  unwrapEvaluateResult,
} from "./lib/saved-core.mjs";

const SAVED_PAGE_URL = "https://www.douyin.com/user/self?showSubTab=favorite_folder&showTab=favorite_collection";
const CAPTURE_KEY = "__dok_saved_capture_v1";

function parseLimit(value) {
  try {
    return normalizeLimit(value);
  } catch (error) {
    throw new ArgumentError(`douyin saved ${String(error?.message || error)}`);
  }
}

async function resolveSelfUser(page) {
  const payload = unwrapEvaluateResult(await page.evaluate(`
    (() => {
      const raw = document.getElementById('RENDER_DATA')?.textContent || '';
      try {
        const decoded = new URL('https://x.invalid/?v=' + raw).searchParams.get('v') || '';
        const data = JSON.parse(decoded);
        const user = data?.app?.user?.info || null;
        return user ? {
          uid: String(user.uid || ''),
          secUid: String(user.secUid || ''),
          nickname: String(user.nickname || '')
        } : null;
      } catch (error) {
        return null;
      }
    })()
  `));
  const user = extractSelfUser({ app: { user: { info: payload } } });
  if (!user) {
    throw new AuthRequiredError(
      "www.douyin.com",
      "Could not resolve the logged-in Douyin account from the self profile page."
    );
  }
  return user;
}

async function waitForVideoTab(page) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const exists = unwrapEvaluateResult(await page.evaluate(
      `() => !!document.querySelector('#semiTabvideo')`
    ));
    if (exists) return;
    await page.wait(0.5);
  }
  throw new CommandExecutionError(
    "Douyin saved video tab was not found. The favorites page may have changed."
  );
}

async function installSavedResponseCapture(page, includePlayUrl) {
  const installed = unwrapEvaluateResult(await page.evaluate(`
    (() => {
      const key = ${JSON.stringify(CAPTURE_KEY)};
      const endpoints = [
        '/aweme/v1/web/aweme/listcollection/',
        '/aweme/v1/web/collects/video/list/'
      ];
      const previous = window[key];
      if (previous && typeof previous.restore === 'function') previous.restore();

      const baselineIds = Array.from(document.querySelectorAll('a[href*="/video/"]'))
        .map(link => String(link.href || '').match(/\\/video\\/(\\d{10,})/)?.[1] || '')
        .filter(Boolean);
      const state = { pages: [], errors: [], pending: 0, baselineIds, observedDomIds: [], restore: null };
      const endpointFor = (value) => {
        const url = String(value || '');
        return endpoints.find(endpoint => url.includes(endpoint)) || '';
      };
      const urls = (value) => {
        const candidates = Array.isArray(value)
          ? value
          : Array.isArray(value?.url_list)
            ? value.url_list
            : Array.isArray(value?.urlList)
              ? value.urlList
              : [];
        return candidates
          .map(candidate => typeof candidate === 'string' ? candidate : candidate?.src)
          .filter(candidate => /^https?:\\/\\//i.test(String(candidate || '')))
          .map(String);
      };
      const sanitize = (aweme) => {
        const video = aweme?.video || {};
        const item = {
          aweme_id: String(aweme?.aweme_id || aweme?.awemeId || ''),
          desc: String(aweme?.desc || ''),
          create_time: Number(aweme?.create_time || aweme?.createTime || 0),
          author: {
            nickname: String(aweme?.author?.nickname || ''),
            sec_uid: String(aweme?.author?.sec_uid || aweme?.author?.secUid || '')
          },
          statistics: {
            digg_count: Number(aweme?.statistics?.digg_count || aweme?.statistics?.diggCount || 0),
            collect_count: Number(aweme?.statistics?.collect_count || aweme?.statistics?.collectCount || 0),
            comment_count: Number(aweme?.statistics?.comment_count || aweme?.statistics?.commentCount || 0),
            share_count: Number(aweme?.statistics?.share_count || aweme?.statistics?.shareCount || 0)
          },
          video: {
            duration: Number(video?.duration || 0),
            cover: { url_list: urls(video?.cover) }
          }
        };
        if (${includePlayUrl ? "true" : "false"}) {
          item.video.play_addr = { url_list: urls(video?.play_addr || video?.playAddr) };
        }
        return item;
      };
      const itemsFrom = (data) => {
        if (Array.isArray(data?.aweme_list)) return data.aweme_list;
        if (Array.isArray(data?.awemeList)) return data.awemeList;
        if (Array.isArray(data?.data?.aweme_list)) return data.data.aweme_list;
        if (Array.isArray(data?.data?.awemeList)) return data.data.awemeList;
        return [];
      };
      const capture = (endpoint, data) => {
        const items = itemsFrom(data).map(sanitize).filter(item => item.aweme_id);
        const hasMoreValue = data?.has_more ?? data?.hasMore ?? data?.data?.has_more ?? data?.data?.hasMore;
        const hasMore = hasMoreValue === false || hasMoreValue === 0 || hasMoreValue === '0'
          ? false
          : hasMoreValue === true || hasMoreValue === 1 || hasMoreValue === '1'
            ? true
            : null;
        const cursorValue = data?.cursor ?? data?.max_cursor ?? data?.maxCursor
          ?? data?.data?.cursor ?? data?.data?.max_cursor ?? data?.data?.maxCursor ?? null;
        state.pages.push({
          endpoint,
          items,
          has_more: hasMore,
          cursor: cursorValue == null ? null : String(cursorValue).slice(0, 80)
        });
      };
      const recordError = (endpoint, error) => {
        state.errors.push({ endpoint, error: String(error?.message || error).slice(0, 240) });
      };

      const originalFetch = window.fetch;
      const xhr = XMLHttpRequest.prototype;
      const originalOpen = xhr.open;
      const originalSend = xhr.send;

      window.fetch = async function(...args) {
        const requestUrl = typeof args[0] === 'string' ? args[0] : args[0]?.url;
        const endpoint = endpointFor(requestUrl);
        if (!endpoint) return originalFetch.apply(this, args);
        state.pending += 1;
        try {
          const response = await originalFetch.apply(this, args);
          response.clone().json()
            .then(data => capture(endpoint, data))
            .catch(error => recordError(endpoint, error))
            .finally(() => { state.pending -= 1; });
          return response;
        } catch (error) {
          recordError(endpoint, error);
          state.pending -= 1;
          throw error;
        }
      };
      xhr.open = function(method, url) {
        Object.defineProperty(this, '__dokSavedEndpoint', {
          value: endpointFor(url), writable: true, configurable: true
        });
        return originalOpen.apply(this, arguments);
      };
      xhr.send = function() {
        const endpoint = this.__dokSavedEndpoint;
        if (!endpoint) return originalSend.apply(this, arguments);
        state.pending += 1;
        let settled = false;
        const settle = () => {
          if (settled) return;
          settled = true;
          state.pending -= 1;
        };
        this.addEventListener('loadend', function() {
          try {
            const data = this.responseType === 'json'
              ? this.response
              : JSON.parse(String(this.responseText || ''));
            capture(endpoint, data);
          } catch (error) {
            recordError(endpoint, error);
          } finally {
            settle();
          }
        }, { once: true });
        try {
          return originalSend.apply(this, arguments);
        } catch (error) {
          recordError(endpoint, error);
          settle();
          throw error;
        }
      };
      state.restore = () => {
        window.fetch = originalFetch;
        xhr.open = originalOpen;
        xhr.send = originalSend;
      };
      Object.defineProperty(window, key, {
        value: state, writable: true, configurable: true, enumerable: false
      });
      return true;
    })()
  `));
  if (!installed) throw new CommandExecutionError("Could not install Douyin saved response capture");
}

async function readSavedCapture(page) {
  return unwrapEvaluateResult(await page.evaluate(`
    (() => {
      const state = window[${JSON.stringify(CAPTURE_KEY)}] || {};
      const ids = [];
      const seen = new Set(Array.isArray(state.observedDomIds) ? state.observedDomIds : []);
      const baselineIds = new Set(Array.isArray(state.baselineIds) ? state.baselineIds : []);
      for (const link of document.querySelectorAll('a[href*="/video/"]')) {
        const match = String(link.href || '').match(/\\/video\\/(\\d{10,})/);
        if (match && !baselineIds.has(match[1])) seen.add(match[1]);
      }
      ids.push(...seen);
      state.observedDomIds = ids;
      return {
        pages: Array.isArray(state.pages) ? state.pages : [],
        errors: Array.isArray(state.errors) ? state.errors : [],
        pending: Number(state.pending || 0),
        domIds: ids
      };
    })()
  `));
}

async function scrollSavedPage(page) {
  await page.evaluate(`
    (() => {
      const links = Array.from(document.querySelectorAll('a[href*="/video/"]'));
      const last = links.at(-1);
      if (last) last.scrollIntoView({ block: 'end', inline: 'nearest' });
      window.scrollBy(0, Math.max(500, Math.floor(window.innerHeight * 0.85)));
      document.scrollingElement?.scrollBy(0, Math.max(500, Math.floor(window.innerHeight * 0.85)));
      return links.length;
    })()
  `);
}

async function captureSavedVideos(page, limit) {
  let snapshot = { pages: [], errors: [], pending: 0, domIds: [] };
  let previousSignature = "";
  let stableRounds = 0;

  for (let attempt = 0; attempt < 80; attempt += 1) {
    await page.wait(0.75);
    snapshot = await readSavedCapture(page);
    const coverage = savedCaptureCoverage(snapshot, limits.max);
    const signature = JSON.stringify({
      count: coverage.count,
      domIds: [...snapshot.domIds].sort(),
      pages: snapshot.pages.length,
      pending: coverage.pending,
      sourceExhausted: coverage.source_exhausted,
    });
    if (coverage.pending === 0 && signature === previousSignature) stableRounds += 1;
    else stableRounds = 0;
    previousSignature = signature;

    if (coverage.complete && stableRounds >= 2) break;
    if (coverage.capture_errors > 0 || (coverage.budget_exhausted && stableRounds >= 2)) break;
    await scrollSavedPage(page);
  }

  snapshot = await readSavedCapture(page);
  const allItems = mergeCapturedSavedPages(snapshot.pages, limits.max);
  const coverage = savedCaptureCoverage(snapshot, limits.max);
  if (!coverage.complete) {
    throw new CommandExecutionError(
      `Douyin saved capture was incomplete (${coverage.reason}): `
      + `${coverage.missing_dom_ids.length} visible video(s) missing, ${snapshot.pages.length} captured page(s), `
      + `${coverage.count} captured video(s), ${coverage.capture_errors} capture error(s), ${coverage.pending} pending request(s).`
    );
  }
  if (allItems.length > limit) {
    throw new CommandExecutionError(
      `Douyin saved capture contains ${allItems.length} videos, which exceeds requested limit ${limit}. `
      + `Retry with --limit ${Math.min(limits.max, allItems.length)} or higher so the result remains complete.`
    );
  }
  return allItems;
}

async function restoreSavedResponseCapture(page) {
  await page.evaluate(`
    (() => {
      const state = window[${JSON.stringify(CAPTURE_KEY)}];
      if (state && typeof state.restore === 'function') state.restore();
      return true;
    })()
  `);
}

cli({
  site: "douyin",
  name: "saved",
  access: "read",
  description: "List videos saved by the currently logged-in Douyin account",
  domain: "www.douyin.com",
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  args: [
    {
      name: "limit",
      type: "int",
      default: limits.default,
      help: `Number of saved videos to return (1-${limits.max})`,
    },
    {
      name: "include_play_url",
      type: "bool",
      default: false,
      help: "Include a transient signed media URL for immediate local download",
    },
  ],
  columns: [
    "rank",
    "aweme_id",
    "title",
    "author",
    "duration",
    "likes",
    "collects",
    "comments",
    "shares",
    "source_url",
  ],
  func: async (page, kwargs) => {
    const limit = parseLimit(kwargs.limit);
    const includePlayUrl = kwargs.include_play_url === true;
    await page.goto(SAVED_PAGE_URL);
    await page.wait(3);
    await resolveSelfUser(page);
    await waitForVideoTab(page);
    await installSavedResponseCapture(page, includePlayUrl);

    try {
      const clicked = unwrapEvaluateResult(await page.evaluate(`
        (() => {
          const tab = document.querySelector('#semiTabvideo');
          if (!tab) return false;
          const target = tab.querySelector('span') || tab;
          const pointer = (type) => target.dispatchEvent(new PointerEvent(type, {
            bubbles: true, composed: true, pointerId: 1, isPrimary: true
          }));
          const mouse = (type) => target.dispatchEvent(new MouseEvent(type, {
            bubbles: true, composed: true, button: 0
          }));
          pointer('pointerdown');
          mouse('mousedown');
          pointer('pointerup');
          mouse('mouseup');
          mouse('click');
          return true;
        })()
      `));
      if (!clicked) {
        throw new CommandExecutionError("Could not open the Douyin saved video tab");
      }
      const items = await captureSavedVideos(page, limit);
      if (items.length === 0) {
        throw new EmptyResultError(
          "douyin saved",
          "No saved videos were captured. Confirm the account is logged in and has visible saved videos."
        );
      }
      return items.map((item, index) => mapSavedAweme(item, index + 1, { includePlayUrl }));
    } finally {
      await restoreSavedResponseCapture(page).catch(() => {});
    }
  },
});
