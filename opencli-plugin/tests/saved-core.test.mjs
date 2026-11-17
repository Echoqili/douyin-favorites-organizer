import test from "node:test";
import assert from "node:assert/strict";
import {
  extractSelfUser,
  firstHttpUrl,
  mapSavedAweme,
  mergeCapturedSavedPages,
  normalizeLimit,
  pageSizeFor,
  savedCaptureCoverage,
} from "../lib/saved-core.mjs";

test("normalizes limits and page sizes", () => {
  assert.equal(normalizeLimit(undefined), 5000);
  assert.equal(normalizeLimit(200), 200);
  assert.equal(normalizeLimit(201), 201);
  assert.equal(normalizeLimit(216), 216);
  assert.equal(normalizeLimit(500), 500);
  assert.equal(normalizeLimit(5000), 5000);
  assert.equal(pageSizeFor(50), 18);
  assert.equal(pageSizeFor(4), 4);
  assert.throws(() => normalizeLimit(0), /between 1 and 5000/u);
  assert.throws(() => normalizeLimit(5001), /between 1 and 5000/u);
});

test("extracts the logged-in self user only from the expected render path", () => {
  assert.deepEqual(extractSelfUser({
    app: { user: { info: { uid: "1", secUid: "MS4wLjABAAAAfixture", nickname: "Me" } } },
  }), { uid: "1", secUid: "MS4wLjABAAAAfixture", nickname: "Me" });
  assert.equal(extractSelfUser({ app: { user: { info: { secUid: "bad" } } } }), null);
});

test("maps saved aweme metadata and keeps signed URLs opt-in", () => {
  const fixture = {
    aweme_id: "7000000000000000001",
    desc: "Example",
    create_time: 123,
    author: { nickname: "Author", sec_uid: "MS4wLjABauthor" },
    statistics: { digg_count: 5, collect_count: 6, comment_count: 7, share_count: 8 },
    video: {
      duration: 221216,
      cover: { url_list: ["https://img.example/cover.jpg"] },
      play_addr: { url_list: ["https://video.example/signed.mp4?token=secret"] },
    },
  };
  const safe = mapSavedAweme(fixture, 1);
  assert.equal(safe.duration, 221);
  assert.equal(safe.source_url, "https://www.douyin.com/video/7000000000000000001");
  assert.equal("play_url" in safe, false);
  const download = mapSavedAweme(fixture, 1, { includePlayUrl: true });
  assert.match(download.play_url, /^https:\/\/video\.example/u);
  assert.equal(firstHttpUrl([{ src: "https://a.example/x" }]), "https://a.example/x");
});

test("merges only saved-video collection responses across pages", () => {
  const pages = [
    { endpoint: "/aweme/v1/web/aweme/favorite/", items: [{ aweme_id: "999" }] },
    { endpoint: "/aweme/v1/web/aweme/listcollection/", items: [{ aweme_id: "101" }, { aweme_id: "102" }] },
    { endpoint: "/aweme/v1/web/aweme/listcollection/", items: [{ aweme_id: "102" }, { aweme_id: "103" }] },
    { endpoint: "/aweme/v1/web/collects/video/list/", items: [{ aweme_id: "104" }] },
  ];
  assert.deepEqual(mergeCapturedSavedPages(pages, 10).map(item => item.aweme_id), ["101", "102", "103", "104"]);
});

test("does not truncate a captured collection above 200 items", () => {
  const pages = Array.from({ length: 12 }, (_, pageIndex) => ({
    endpoint: "/aweme/v1/web/aweme/listcollection/",
    has_more: pageIndex < 11,
    cursor: pageIndex + 1,
    items: Array.from({ length: 18 }, (_, itemIndex) => ({
      aweme_id: String(pageIndex * 18 + itemIndex + 1),
    })),
  }));
  assert.equal(mergeCapturedSavedPages(pages, 5000).length, 216);
});

test("marks capture complete only with terminal pagination evidence and full DOM coverage", () => {
  const pages = [
    { endpoint: "/aweme/v1/web/aweme/listcollection/", has_more: true, cursor: 18, items: [{ aweme_id: "101" }] },
    { endpoint: "/aweme/v1/web/aweme/listcollection/", has_more: false, cursor: 19, items: [{ aweme_id: "102" }] },
  ];
  assert.deepEqual(savedCaptureCoverage({ pages, errors: [], pending: 0, domIds: ["101", "102"] }, 5000), {
    complete: true,
    reason: "source_exhausted",
    count: 2,
    missing_dom_ids: [],
    capture_errors: 0,
    pending: 0,
    source_exhausted: true,
    budget_exhausted: false,
  });
  assert.equal(savedCaptureCoverage({ pages: [pages[0]], errors: [], pending: 0, domIds: ["101"] }, 5000).reason, "pagination_not_exhausted");
  assert.equal(savedCaptureCoverage({ pages: [pages[1]], errors: [], pending: 0, domIds: ["101", "102"] }, 5000).reason, "visible_items_missing");
  assert.equal(savedCaptureCoverage({ pages: [pages[1]], errors: [{}], pending: 0, domIds: ["102"] }, 5000).reason, "capture_errors");
});
