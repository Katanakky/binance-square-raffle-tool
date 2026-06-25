import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractCandidatesFromJson,
  extractPostId,
  mergeCandidates,
  normalizeEndpoint,
  SCAN_KEYWORD_RE,
  toCsv
} from "./extract.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const RUNTIME_DIR = path.join(ROOT, ".runtime");
const DEFAULT_PROFILE_DIR = path.join(RUNTIME_DIR, "chrome-profile");
const DEFAULT_NOTIFICATION_URL = "https://www.binance.com/en/square/notifications";
const DEFAULT_POST_URL = "https://www.binance.com/zh-CN/square";
const QUOTE_PAGE_SIZE = 20;
// Binance currently rejects comment/list requests with pageSize above 20.
const COMMENT_PAGE_SIZE = 20;

let activeContext = null;
let activePage = null;

export async function openPostWindow(options = {}, onEvent = () => {}) {
  const targetPostUrl = normalizeOptionalBinanceUrl(options.targetPostUrl || "") || DEFAULT_POST_URL;
  const profileDir = options.profileDir || DEFAULT_PROFILE_DIR;
  await fs.mkdir(profileDir, { recursive: true });

  emit(onEvent, "正在打开币安帖子窗口", { targetPostUrl });
  const { context, page } = await ensureBrowser(profileDir);
  activeContext = context;
  activePage = page;

  await page.goto(targetPostUrl, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch((error) => {
    emit(onEvent, "帖子页未完全打开，可在弹出的窗口里手动刷新", { error: error.message });
  });
  await page.bringToFront().catch(() => {});
  emit(onEvent, "币安帖子窗口已打开，请先完成登录或地区确认", { currentUrl: page.url() });

  return {
    targetPostUrl,
    currentUrl: page.url()
  };
}

export async function openNotificationWindow(options = {}, onEvent = () => {}) {
  const notificationUrl = normalizeOptionalBinanceUrl(options.notificationUrl || "") || DEFAULT_NOTIFICATION_URL;
  const profileDir = options.profileDir || DEFAULT_PROFILE_DIR;
  await fs.mkdir(profileDir, { recursive: true });

  emit(onEvent, "正在打开币安通知窗口", { notificationUrl });
  const { context, page } = await ensureBrowser(profileDir);
  activeContext = context;
  activePage = page;

  await page.goto(notificationUrl, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch((error) => {
    emit(onEvent, "通知页未完全打开，可在弹出的窗口里手动刷新", { error: error.message });
  });
  await page.bringToFront().catch(() => {});
  emit(onEvent, "币安通知窗口已打开，请先在该窗口登录", { currentUrl: page.url() });

  return {
    notificationUrl,
    currentUrl: page.url()
  };
}

export async function closeNotificationWindow() {
  if (activeContext) {
    await activeContext.close().catch(() => {});
  }
  activeContext = null;
  activePage = null;
}

export async function runScan(options, onEvent = () => {}) {
  const startedAt = new Date();
  const targetPostUrl = normalizeOptionalBinanceUrl(options.targetPostUrl || options.url || "");
  const maxSeconds = clamp(Number(options.maxSeconds || options.seconds || 900), 60, 3600);
  const maxPages = clamp(Number(options.maxPages || options.maxScrollRounds || 500), 1, 5000);
  const postId = extractPostId(targetPostUrl);
  const runId = formatRunId(startedAt);
  const runDir = path.join(RUNTIME_DIR, "runs", runId);
  const profileDir = options.profileDir || DEFAULT_PROFILE_DIR;
  const endpoints = new Map();
  const errors = [];

  if (!postId) {
    throw new Error("请先填写币安广场帖子链接，例如 https://www.binance.com/zh-CN/square/post/337499240611281");
  }

  await fs.mkdir(runDir, { recursive: true });
  await fs.mkdir(profileDir, { recursive: true });

  emit(onEvent, "准备读取数据", { maxSeconds, postId, maxPages });
  const { context, page } = await ensureBrowser(profileDir);
  activeContext = context;
  activePage = page;

  page.on("pageerror", (error) => {
    errors.push(error.message);
  });

  try {
    if (!page.url().includes(postId)) {
      emit(onEvent, "打开目标帖子页面", { targetPostUrl });
      await page.goto(targetPostUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    } else {
      emit(onEvent, "沿用已打开的目标帖子窗口", { currentUrl: page.url() });
      await page.bringToFront().catch(() => {});
    }
  } catch (error) {
    errors.push(`打开目标帖子时遇到问题：${error.message}`);
    emit(onEvent, "帖子页未完全打开，可在弹出的窗口里手动登录或刷新", { error: error.message });
  }

  const quoteResult = await runQuoteApiScan(page, {
    postId,
    targetPostUrl,
    maxSeconds,
    maxPages,
    endpoints,
    onEvent
  });
  emit(onEvent, "引用列表接口读取结束", quoteResult.summary);

  const commentResult = await runCommentApiScan(page, {
    postId,
    quoteCandidates: quoteResult.candidates,
    maxSeconds,
    maxPages,
    endpoints,
    onEvent
  });
  emit(onEvent, "评论列表接口读取结束", commentResult.summary);

  const candidates = mergeCandidates([buildQuoteCommentCandidates(quoteResult.candidates, commentResult.users)]);
  const highConfidence = candidates;
  const result = {
    runId,
    targetPostUrl,
    postId,
    currentUrl: page.url(),
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    summary: {
      totalCandidates: candidates.length,
      likelyRepostCandidates: highConfidence.length,
      endpointsSeen: endpoints.size,
      maxSeconds,
      maxPages,
      quoteCount: quoteResult.quoteCount,
      quoteUsers: quoteResult.candidates.length,
      commentUsers: commentResult.totalUsersSeen,
      matchedCommentUsers: commentResult.users.length,
      quotePagesFetched: quoteResult.pagesFetched,
      commentPagesFetched: commentResult.pagesFetched,
      pagesFetched: quoteResult.pagesFetched + commentResult.pagesFetched,
      quoteStopReason: quoteResult.stopReason,
      commentStopReason: commentResult.stopReason,
      stopReason: `引用：${quoteResult.stopReason}；评论：${commentResult.stopReason}`
    },
    candidates,
    likelyRepostCandidates: highConfidence,
    endpoints: [...endpoints.values()].sort((a, b) => b.candidates - a.candidates),
    notes: buildQuoteCommentNotes(candidates, quoteResult, commentResult, postId, page.url()),
    errors
  };

  const jsonPath = path.join(runDir, "result.json");
  const csvPath = path.join(runDir, "candidates.csv");
  await fs.writeFile(jsonPath, JSON.stringify(result, null, 2), "utf8");
  await fs.writeFile(csvPath, toCsv(candidates), "utf8");

  emit(onEvent, "记录完成，币安窗口会继续保留用于下次记录", {
    totalCandidates: candidates.length,
    likelyRepostCandidates: highConfidence.length,
    jsonPath,
    csvPath
  });

  return { ...result, files: { jsonPath, csvPath } };
}

async function runQuoteApiScan(page, { postId, targetPostUrl, maxSeconds, maxPages, endpoints, onEvent }) {
  const started = Date.now();
  const detailEndpoint = `/bapi/composite/v3/friendly/pgc/special/content/detail/${postId}`;
  emit(onEvent, "读取帖子详情，确认引用数量和作者 UID", { postId });
  const detail = await fetchJsonFromPage(page, {
    method: "GET",
    url: new URL(detailEndpoint, "https://www.binance.com").toString(),
    headers: { accept: "application/json, text/plain, */*" },
    body: ""
  });
  const detailUrl = detail.url || new URL(detailEndpoint, "https://www.binance.com").toString();
  endpoints.set(normalizeEndpoint(detailUrl), {
    endpoint: normalizeEndpoint(detailUrl),
    status: detail.status,
    contentType: "application/json",
    resourceType: "quote-detail",
    keywordHit: true,
    candidates: 0
  });
  if (!detail.json?.success || !detail.json?.data) {
    throw new Error(`读取帖子详情失败：HTTP ${detail.status} ${detail.json?.message || ""}`.trim());
  }

  const post = detail.json.data;
  const targetSquareUid = post.squareUid || post.squareAuthorUid || post.contentAuthor?.squareUid || "";
  const quoteCount = Number(post.quoteCount || 0);
  if (!targetSquareUid) {
    throw new Error("帖子详情里没有找到作者 Square UID，暂时不能调用引用列表接口。");
  }
  emit(onEvent, "已确认帖子引用数量", {
    quoteCount,
    targetSquareUid,
    shareCount: post.shareCount || 0
  });

  const candidates = [];
  const seenKeys = new Set();
  let pagesFetched = 0;
  let stopReason = "达到最多接口页";

  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
    const elapsedSeconds = Math.round((Date.now() - started) / 1000);
    if (elapsedSeconds >= maxSeconds) {
      stopReason = "达到最长运行时间";
      break;
    }

    const response = await fetchQuotePage(page, {
      postId,
      targetSquareUid,
      pageNumber,
      pageSize: QUOTE_PAGE_SIZE
    });
    const endpoint = normalizeEndpoint(response.url);
    endpoints.set(endpoint, {
      endpoint,
      status: response.status,
      contentType: "application/json",
      resourceType: "quote-list",
      keywordHit: true,
      candidates: Array.isArray(response.json?.data) ? response.json.data.length : 0
    });

    if (!response.json?.success) {
      stopReason = `引用列表接口返回异常：HTTP ${response.status} ${response.json?.message || ""}`.trim();
      break;
    }

    const items = Array.isArray(response.json.data) ? response.json.data : [];
    for (const item of items) {
      const candidate = quoteItemToCandidate(item, {
        endpoint,
        postId,
        targetPostUrl
      });
      if (!candidate || seenKeys.has(candidate.key)) continue;
      seenKeys.add(candidate.key);
      candidates.push(candidate);
    }

    pagesFetched += 1;
    emit(onEvent, "高速读取引用列表分页", {
      round: pagesFetched,
      total: maxPages,
      count: candidates.length,
      items: items.length,
      quoteCount,
      endpoint
    });

    if (!items.length) {
      stopReason = "接口没有更多引用条目";
      break;
    }
    if (items.length < QUOTE_PAGE_SIZE) {
      stopReason = "最后一页数量小于分页大小";
      break;
    }
    if (quoteCount && candidates.length >= quoteCount) {
      stopReason = "已读取到帖子显示的引用数量";
      break;
    }
  }

  return {
    candidates,
    quoteCount,
    pagesFetched,
    stopReason,
    targetSquareUid,
    summary: {
      mode: "quote-content-api",
      quoteCount,
      pagesFetched,
      stopReason,
      candidates: candidates.length
    }
  };
}

async function fetchQuotePage(page, { postId, targetSquareUid, pageNumber, pageSize }) {
  const body = {
    contentId: Number(postId),
    pageNumber,
    pageIndex: pageNumber,
    pageSize,
    targetSquareUid
  };
  return fetchJsonFromPage(page, {
    method: "POST",
    url: "https://www.binance.com/bapi/composite/v3/friendly/pgc/content/queryQuoteContents",
    headers: {
      accept: "application/json, text/plain, */*",
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
}

function quoteItemToCandidate(item, { endpoint, postId, targetPostUrl }) {
  const name = item.displayName || item.nickname || item.username || "";
  const username = item.username || "";
  const squareUid = item.squareUid || item.squareAuthorUid || "";
  if (!name && !username && !squareUid) return null;

  const quotePostUrl = normalizeBinanceWebLink(item.webLink || item.quotedContentWebLink || "");
  const profileUrl = buildSquareProfileUrl(username, squareUid);
  const evidenceText = compactText(item.bodyTextOnly || item.title || "");
  const key = squareUid ? `square:${String(squareUid).toLowerCase()}` : profileUrl ? `url:${profileUrl.toLowerCase()}` : `name:${name.toLowerCase()}`;

  return {
    key,
    name: name || username || squareUid,
    userId: squareUid,
    profileUrl,
    profileUrlSource: username ? "按用户名生成" : squareUid ? "按 Square UID 生成" : "",
    avatarUrl: item.avatar || "",
    confidence: String(item.quotedContentId || item.quoteContent?.id || "").includes(postId) ? 100 : 95,
    relations: ["帖子引用列表"],
    evidence: [
      {
        endpoint,
        path: "data[]",
        relation: "引用了目标帖子",
        status: 200,
        keywordHit: true,
        targetPostMatch: String(item.quotedContentId || item.quoteContent?.id || "").includes(postId),
        text: evidenceText,
        quotePostUrl
      }
    ]
  };
}

async function runCommentApiScan(page, { postId, quoteCandidates, maxSeconds, maxPages, endpoints, onEvent }) {
  const started = Date.now();
  const quoteLookup = buildQuoteIdentityLookup(quoteCandidates);
  const usersByKey = new Map();
  const allCommentUserKeys = new Set();
  const matchedQuoteKeys = new Set();
  const seenPages = new Set();
  let pagesFetched = 0;
  let offset = 0;
  let stopReason = "达到最多接口页";

  if (!quoteLookup.quoteKeys.size) {
    return {
      users: [],
      totalUsersSeen: 0,
      matchedQuoteUsers: 0,
      pagesFetched: 0,
      stopReason: "没有引用用户，跳过评论读取",
      summary: {
        mode: "comment-list-api",
        optimized: true,
        pagesFetched: 0,
        stopReason: "没有引用用户，跳过评论读取",
        users: 0,
        totalUsersSeen: 0,
        matchedQuoteUsers: 0
      }
    };
  }

  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
    const elapsedSeconds = Math.round((Date.now() - started) / 1000);
    if (elapsedSeconds >= maxSeconds) {
      stopReason = "达到最长运行时间";
      break;
    }

    const response = await fetchCommentPage(page, {
      postId,
      pageNumber,
      pageSize: COMMENT_PAGE_SIZE,
      offset
    });
    const endpoint = normalizeEndpoint(response.url);
    const items = extractCommentItems(response.json);
    endpoints.set(endpoint, {
      endpoint,
      status: response.status,
      contentType: "application/json",
      resourceType: "comment-list",
      keywordHit: true,
      candidates: items.length
    });

    if (!response.json?.success) {
      stopReason = `评论列表接口返回异常：HTTP ${response.status} ${response.json?.message || ""}`.trim();
      break;
    }

    const pageSignature = `${pageNumber}|${offset}|${items.map((item) => item.commentId || item.id || "").join(",")}`;
    if (seenPages.has(pageSignature)) {
      stopReason = "评论接口返回了重复页面";
      break;
    }
    seenPages.add(pageSignature);

    for (const item of items) {
      const user = commentItemToUser(item, { endpoint, postId });
      if (!user) continue;
      allCommentUserKeys.add(user.key);

      const matchedQuoteKey = candidateIdentityKeys(user).map((key) => quoteLookup.identityToQuoteKey.get(key)).find(Boolean);
      if (!matchedQuoteKey) continue;

      matchedQuoteKeys.add(matchedQuoteKey);
      const current = usersByKey.get(user.key);
      if (current) {
        current.commentCount += 1;
        current.evidence.push(...user.evidence);
        continue;
      }
      usersByKey.set(user.key, user);
    }

    pagesFetched += 1;
    offset = Number(response.json?.data?.offset || 0);
    emit(onEvent, "高速读取评论列表分页", {
      round: pagesFetched,
      total: maxPages,
      count: matchedQuoteKeys.size,
      items: items.length,
      commentUsersSeen: allCommentUserKeys.size,
      quoteUsers: quoteLookup.quoteKeys.size,
      endpoint
    });

    if (matchedQuoteKeys.size >= quoteLookup.quoteKeys.size) {
      stopReason = "已找到全部引用用户的评论记录";
      break;
    }
    if (!items.length) {
      stopReason = "接口没有更多评论条目";
      break;
    }
  }

  const users = [...usersByKey.values()].map((user) => ({
    ...user,
    evidence: user.evidence.slice(0, 5)
  }));

  return {
    users,
    totalUsersSeen: allCommentUserKeys.size,
    matchedQuoteUsers: matchedQuoteKeys.size,
    pagesFetched,
    stopReason,
    summary: {
      mode: "comment-list-api",
      optimized: true,
      pagesFetched,
      stopReason,
      users: users.length,
      totalUsersSeen: allCommentUserKeys.size,
      matchedQuoteUsers: matchedQuoteKeys.size,
      quoteUsers: quoteLookup.quoteKeys.size
    }
  };
}

async function fetchCommentPage(page, { postId, pageNumber, pageSize, offset }) {
  const body = {
    contentId: Number(postId),
    pageNumber,
    pageIndex: pageNumber,
    pageSize,
    sort: 2,
    orderBy: 2,
    offset
  };
  return fetchJsonFromPage(page, {
    method: "POST",
    url: "https://www.binance.com/bapi/composite/v4/friendly/pgc/comment/list",
    headers: {
      accept: "application/json, text/plain, */*",
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
}

function extractCommentItems(json) {
  const data = json?.data;
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.list)) return data.list;
  if (Array.isArray(data?.rows)) return data.rows;
  return [];
}

function commentItemToUser(item, { endpoint, postId }) {
  const username = item.username || item.userName || "";
  const squareUid = item.squareUid || item.userId || item.uid || "";
  const name = item.nickName || item.nickname || item.displayName || item.authorName || username || squareUid;
  if (!name && !squareUid) return null;

  const profileUrl = buildSquareProfileUrl(username, squareUid);
  const key = makeUserKey({ squareUid, profileUrl, name });
  const text = compactText(item.comment || item.content || item.bodyTextOnly || item.text || "");
  return {
    key,
    name,
    userId: squareUid ? String(squareUid) : "",
    profileUrl,
    profileUrlSource: username ? "按用户名生成" : squareUid ? "按 Square UID 生成" : "",
    avatarUrl: item.userIcon || item.avatar || item.avatarUrl || "",
    commentCount: 1,
    evidence: [
      {
        endpoint,
        path: "data.data[]",
        relation: "评论了目标帖子",
        status: 200,
        keywordHit: true,
        targetPostMatch: String(item.contentId || "").includes(postId),
        text,
        commentId: item.commentId || item.id || ""
      }
    ]
  };
}

function buildQuoteCommentCandidates(quoteCandidates, commentUsers) {
  const commentsByKey = new Map();
  for (const user of commentUsers) {
    for (const key of candidateIdentityKeys(user)) {
      if (!commentsByKey.has(key)) commentsByKey.set(key, user);
    }
  }

  const matched = [];
  for (const quote of quoteCandidates) {
    const comment = candidateIdentityKeys(quote).map((key) => commentsByKey.get(key)).find(Boolean);
    if (!comment) continue;

    matched.push({
      ...quote,
      name: quote.name || comment.name,
      userId: quote.userId || comment.userId,
      profileUrl: quote.profileUrl || comment.profileUrl,
      profileUrlSource: quote.profileUrlSource || comment.profileUrlSource,
      avatarUrl: quote.avatarUrl || comment.avatarUrl,
      confidence: 100,
      conditions: {
        quoted: true,
        commented: true,
        liked: false
      },
      commentCount: comment.commentCount,
      relations: ["已引用", "已评论"],
      evidence: quote.evidence.concat(comment.evidence).slice(0, 5)
    });
  }
  return matched;
}

function candidateIdentityKeys(item) {
  const keys = [];
  const userId = String(item.userId || item.squareUid || "").trim().toLowerCase();
  const profileUrl = String(item.profileUrl || "").trim().toLowerCase();
  const name = String(item.name || item.nickName || item.nickname || item.username || "").trim().toLowerCase();
  if (userId) keys.push(`uid:${userId}`);
  if (profileUrl) keys.push(`profile:${profileUrl}`);
  if (name) keys.push(`name:${name}`);
  return keys;
}

function buildQuoteIdentityLookup(quoteCandidates = []) {
  const identityToQuoteKey = new Map();
  const quoteKeys = new Set();
  for (const quote of quoteCandidates) {
    const quoteKey = quote.key || candidateIdentityKeys(quote)[0];
    if (!quoteKey) continue;
    quoteKeys.add(quoteKey);
    for (const identityKey of candidateIdentityKeys(quote)) {
      if (!identityToQuoteKey.has(identityKey)) identityToQuoteKey.set(identityKey, quoteKey);
    }
  }
  return { identityToQuoteKey, quoteKeys };
}

function makeUserKey({ squareUid, profileUrl, name }) {
  if (squareUid) return `square:${String(squareUid).toLowerCase()}`;
  if (profileUrl) return `url:${profileUrl.toLowerCase()}`;
  return `name:${String(name || "").toLowerCase()}`;
}

function buildSquareProfileUrl(username, squareUid) {
  const slug = String(username || squareUid || "").trim();
  if (!slug) return "";
  return `https://www.binance.com/zh-CN/square/profile/${encodeURIComponent(slug.toLowerCase())}`;
}

function normalizeBinanceWebLink(value) {
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) {
    return value.replace("https://www.binance.com/en/", "https://www.binance.com/zh-CN/");
  }
  if (String(value).startsWith("/")) return `https://www.binance.com${value}`;
  return String(value);
}

function compactText(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 500);
}

function createResponseHandler({ candidateGroups, endpoints, postId, onEvent }) {
  return async (response) => {
    const request = response.request();
    const type = request.resourceType();
    if (type !== "fetch" && type !== "xhr") return;

    const responseUrl = response.url();
    const status = response.status();
    const headers = response.headers();
    const contentType = headers["content-type"] || "";
    const endpoint = normalizeEndpoint(responseUrl);
    const endpointInfo = {
      endpoint,
      status,
      contentType: contentType.split(";")[0],
      resourceType: type,
      keywordHit: SCAN_KEYWORD_RE.test(endpoint),
      candidates: 0
    };
    endpoints.set(endpoint, endpointInfo);

    if (!/json|text|javascript/i.test(contentType)) return;
    if (status >= 400) return;

    let body = "";
    try {
      body = await response.text();
    } catch {
      return;
    }

    if (!body || body.length > 2_500_000) return;
    const relevant = endpointInfo.keywordHit || SCAN_KEYWORD_RE.test(body) || (postId && body.includes(postId));
    if (!relevant) return;

    const parsed = parseJsonLike(body);
    if (parsed === undefined) return;

    const found = extractCandidatesFromJson(parsed, {
      url: responseUrl,
      status,
      postId,
      onlyQuoteNotifications: true
    });
    endpointInfo.candidates += found.length;
    if (found.length) {
      candidateGroups.push(found);
      emit(onEvent, "发现通知接口候选用户", {
        endpoint,
        count: found.length
      });
    }
  };
}

async function runFastApiScan(page, context, { postId, maxSeconds, maxPages, candidateGroups, endpoints, onEvent }) {
  const started = Date.now();
  const records = await discoverNotificationApis(page, context, { postId, onEvent });
  const base = records[0];
  if (!base) {
    return {
      summary: {
        mode: "fast-api",
        endpointFound: false,
        pagesFetched: 0,
        stopReason: "没有发现可分页的通知接口"
      }
    };
  }

  emit(onEvent, "已选中通知接口，开始直接分页读取", {
    endpoint: normalizeEndpoint(base.url),
    score: base.score
  });

  const seenRequests = new Set();
  const seenPageSignatures = new Set();
  let previousMeta = extractPagingMeta(base.json, base.listInfo, null);
  let pagesFetched = 0;
  let stopReason = "达到最多页数";

  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    const elapsedSeconds = Math.round((Date.now() - started) / 1000);
    if (elapsedSeconds >= maxSeconds) {
      stopReason = "达到最长运行时间";
      break;
    }

    const spec = buildPagedRequest(base, pageIndex, previousMeta);
    const requestKey = `${spec.method} ${spec.url} ${spec.body || ""}`;
    if (seenRequests.has(requestKey)) {
      stopReason = "下一页请求和已请求页面重复";
      break;
    }
    seenRequests.add(requestKey);

    const response = pageIndex === 0 ? {
      status: base.status,
      url: base.url,
      json: base.json
    } : await fetchJsonFromPage(page, spec);

    const endpoint = normalizeEndpoint(response.url || spec.url);
    endpoints.set(endpoint, {
      endpoint,
      status: response.status,
      contentType: "application/json",
      resourceType: "fast-fetch",
      keywordHit: SCAN_KEYWORD_RE.test(endpoint),
      candidates: 0
    });

    if (!response.json || response.status >= 400) {
      stopReason = `接口返回异常：HTTP ${response.status}`;
      break;
    }

    const found = extractCandidatesFromJson(response.json, {
      url: response.url || spec.url,
      status: response.status,
      postId,
      onlyQuoteNotifications: true
    });
    if (found.length) {
      candidateGroups.push(found);
      const info = endpoints.get(endpoint);
      if (info) info.candidates += found.length;
    }

    const listInfo = findBestListArray(response.json, postId);
    const pageSignature = makePageSignature(listInfo, response.json);
    if (seenPageSignatures.has(pageSignature)) {
      stopReason = "接口返回了重复页面";
      break;
    }
    seenPageSignatures.add(pageSignature);

    pagesFetched += 1;
    previousMeta = extractPagingMeta(response.json, listInfo, previousMeta);

    emit(onEvent, "高速读取通知接口分页", {
      round: pagesFetched,
      total: maxPages,
      count: found.length,
      items: listInfo.length,
      hasMore: previousMeta.hasMore,
      endpoint
    });

    if (!listInfo.length) {
      stopReason = "接口没有更多通知条目";
      break;
    }
    if (previousMeta.hasMore === false) {
      stopReason = "接口返回没有下一页";
      break;
    }
    if (!previousMeta.nextCursor && !previousMeta.hasKnownPagination && listInfo.length < previousMeta.pageSize) {
      stopReason = "列表数量小于分页大小，视为结束";
      break;
    }
  }

  return {
    summary: {
      mode: "fast-api",
      endpointFound: true,
      endpoint: normalizeEndpoint(base.url),
      pagesFetched,
      stopReason,
      discoveredEndpoints: records.length
    }
  };
}

async function discoverNotificationApis(page, context, { postId, onEvent }) {
  const records = [];
  const listener = async (response) => {
    const request = response.request();
    const type = request.resourceType();
    if (type !== "fetch" && type !== "xhr") return;
    if (response.status() >= 400) return;

    const headers = response.headers();
    const contentType = headers["content-type"] || "";
    if (!/json|text|javascript/i.test(contentType)) return;

    let body = "";
    try {
      body = await response.text();
    } catch {
      return;
    }
    if (!body || body.length > 5_000_000) return;

    const json = parseJsonLike(body);
    if (json === undefined) return;

    const listInfo = findBestListArray(json, postId);
    const score = scoreApiRecord({
      url: response.url(),
      json,
      body,
      listInfo,
      postId
    });
    if (score < 35) return;

    records.push({
      url: response.url(),
      method: request.method(),
      postData: request.postData() || "",
      headers: pickReplayHeaders(request.headers()),
      status: response.status(),
      json,
      listInfo,
      score
    });
  };

  context.on("response", listener);
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 }).catch((error) => {
    emit(onEvent, "刷新通知页时遇到问题，继续使用已捕获接口", { error: error.message });
  });
  await wait(12_000);
  context.off("response", listener);

  const deduped = dedupeRecords(records)
    .sort((a, b) => b.score - a.score)
    .slice(0, 20);
  emit(onEvent, "通知接口发现完成", {
    endpoints: deduped.length,
    best: deduped[0] ? normalizeEndpoint(deduped[0].url) : ""
  });
  return deduped;
}

function scoreApiRecord({ url, json, body, listInfo, postId }) {
  let score = 0;
  if (/notification|notify|notice|inbox|message/i.test(url)) score += 45;
  if (/square|pgc|feed|social/i.test(url)) score += 20;
  if (/\/bapi\//i.test(url)) score += 10;
  if (/authcenter|compliance|i18n|cookie|sentry|google|analytics|falcon|antibot|country|market/i.test(url)) score -= 80;
  if (SCAN_KEYWORD_RE.test(body.slice(0, 200_000))) score += 25;
  if (postId && body.includes(postId)) score += 40;
  if (listInfo.length) score += Math.min(60, listInfo.length * 2);
  if (/notification|notice|message|notify|通知|消息|提醒/i.test(listInfo.path)) score += 25;
  if (/repost|share|quote|转发|分享|引用/i.test(JSON.stringify(json).slice(0, 200_000))) score += 20;
  return score;
}

function dedupeRecords(records) {
  const seen = new Set();
  const out = [];
  for (const record of records) {
    const key = `${record.method} ${normalizeEndpoint(record.url)} ${record.postData}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(record);
  }
  return out;
}

function findBestListArray(json, postId) {
  const best = { path: "", value: [], length: 0, score: 0 };
  walk(json, []);
  return best;

  function walk(value, pathParts) {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      if (value.length && value.some((item) => item && typeof item === "object")) {
        const sample = JSON.stringify(value.slice(0, 5));
        let score = Math.min(80, value.length * 3);
        const pathText = pathParts.join(".");
        if (/list|rows|data|items|notifications|notices|messages|records|result/i.test(pathText)) score += 30;
        if (/notification|notice|message|notify|通知|消息|提醒/i.test(sample)) score += 35;
        if (/user|nick|name|avatar|profile|uid|author/i.test(sample)) score += 20;
        if (/post|article|feed|content|comment|reply|repost|share|quote/i.test(sample)) score += 20;
        if (postId && sample.includes(postId)) score += 60;
        if (score > best.score) {
          best.path = pathText;
          best.value = value;
          best.length = value.length;
          best.score = score;
        }
      }
      for (const item of value.slice(0, 50)) walk(item, pathParts);
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (child && typeof child === "object") walk(child, pathParts.concat(key));
    }
  }
}

function extractPagingMeta(json, listInfo, previousMeta) {
  const cursor = findFirstValueByKey(json, /^(nextCursor|next_cursor|nextPageCursor|nextToken|nextPageToken|cursor|lastId|last_id|lastReadId)$/i);
  const hasMoreValue = findFirstValueByKey(json, /^(hasMore|has_more|hasNext|has_next|more|isLast|last)$/i);
  let hasMore = undefined;
  if (typeof hasMoreValue === "boolean") hasMore = /isLast|last/i.test(String(hasMoreValue.key || "")) ? !hasMoreValue.value : hasMoreValue.value;
  if (typeof hasMoreValue?.value === "boolean") hasMore = /isLast|last/i.test(hasMoreValue.key) ? !hasMoreValue.value : hasMoreValue.value;

  const requestPageSize = previousMeta?.pageSize || listInfo.length || 20;
  return {
    nextCursor: cursor?.value ? String(cursor.value) : "",
    hasMore,
    pageSize: requestPageSize,
    hasKnownPagination: Boolean(cursor?.value || previousMeta?.hasKnownPagination)
  };
}

function findFirstValueByKey(value, keyRe) {
  const stack = [{ value, key: "" }];
  while (stack.length) {
    const current = stack.pop();
    if (!current.value || typeof current.value !== "object") continue;
    if (!Array.isArray(current.value)) {
      for (const [key, child] of Object.entries(current.value)) {
        if (keyRe.test(key) && child !== null && child !== "" && typeof child !== "object") {
          return { key, value: child };
        }
        if (child && typeof child === "object") stack.push({ value: child, key });
      }
    } else {
      for (const child of current.value.slice(0, 20)) {
        if (child && typeof child === "object") stack.push({ value: child, key: current.key });
      }
    }
  }
  return null;
}

function buildPagedRequest(base, pageIndex, previousMeta) {
  const method = (base.method || "GET").toUpperCase();
  const url = new URL(base.url);
  const bodyJson = parseJsonBody(base.postData);
  let body = base.postData || "";
  let changed = pageIndex === 0;

  if (pageIndex > 0) {
    const pageSize = previousMeta?.pageSize || 20;
    const nextCursor = previousMeta?.nextCursor || "";
    changed = mutatePagination(url.searchParams, pageIndex, pageSize, nextCursor);
    if (bodyJson && typeof bodyJson === "object") {
      changed = mutatePaginationObject(bodyJson, pageIndex, pageSize, nextCursor) || changed;
      body = JSON.stringify(bodyJson);
    }
    if (!changed) {
      url.searchParams.set(nextCursor ? "cursor" : "page", nextCursor || String(pageIndex + 1));
    }
  }

  return {
    method,
    url: url.toString(),
    headers: base.headers || {},
    body: method === "GET" ? "" : body
  };
}

function mutatePagination(params, pageIndex, pageSize, nextCursor) {
  let changed = false;
  for (const key of [...params.keys()]) {
    const value = params.get(key);
    if (nextCursor && /cursor|token|lastId|last_id/i.test(key)) {
      params.set(key, nextCursor);
      changed = true;
    } else if (/^(page|pageNo|pageNum|pageIndex|current|currentPage)$/i.test(key) && Number.isFinite(Number(value))) {
      params.set(key, String(Number(value) + pageIndex));
      changed = true;
    } else if (/^(offset|start|from)$/i.test(key) && Number.isFinite(Number(value))) {
      params.set(key, String(Number(value) + pageIndex * pageSize));
      changed = true;
    }
  }
  return changed;
}

function mutatePaginationObject(object, pageIndex, pageSize, nextCursor) {
  let changed = false;
  for (const [key, value] of Object.entries(object)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      changed = mutatePaginationObject(value, pageIndex, pageSize, nextCursor) || changed;
      continue;
    }
    if (nextCursor && /cursor|token|lastId|last_id/i.test(key)) {
      object[key] = nextCursor;
      changed = true;
    } else if (/^(page|pageNo|pageNum|pageIndex|current|currentPage)$/i.test(key) && Number.isFinite(Number(value))) {
      object[key] = Number(value) + pageIndex;
      changed = true;
    } else if (/^(offset|start|from)$/i.test(key) && Number.isFinite(Number(value))) {
      object[key] = Number(value) + pageIndex * pageSize;
      changed = true;
    }
  }
  return changed;
}

async function fetchJsonFromPage(page, spec) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await page.evaluate(async ({ url, method, headers, body, timeoutMs }) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs || 30_000);
        const init = {
          method,
          credentials: "include",
          headers,
          signal: controller.signal
        };
        try {
          if (method !== "GET" && body) init.body = body;
          const response = await fetch(url, init);
          const text = await response.text();
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
          return {
            status: response.status,
            url: response.url,
            json,
            textLength: text.length
          };
        } finally {
          clearTimeout(timer);
        }
      }, { timeoutMs: 30_000, ...spec });
    } catch (error) {
      lastError = error;
      if (!/Execution context was destroyed|navigation|Target page|closed/i.test(error.message || "")) break;
      await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {});
      await wait(1200 * attempt);
    }
  }
  throw lastError;
}

function pickReplayHeaders(headers) {
  const allowed = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (/^(accept|content-type|clienttype|lang|csrftoken|bnc-uuid|x-ui-request-trace|x-trace-id|device-info)$/i.test(key)) {
      allowed[key] = value;
    }
  }
  if (!allowed.accept) allowed.accept = "application/json, text/plain, */*";
  return allowed;
}

function parseJsonBody(body) {
  if (!body || typeof body !== "string") return null;
  const trimmed = body.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function makePageSignature(listInfo, json) {
  if (listInfo.length) {
    const sample = listInfo.value.slice(0, 3).concat(listInfo.value.slice(-3));
    return `${listInfo.path}|${listInfo.length}|${JSON.stringify(sample).slice(0, 2000)}`;
  }
  return JSON.stringify(json).slice(0, 2000);
}

async function ensureBrowser(profileDir) {
  if (activeContext && activePage && !activePage.isClosed()) {
    return { context: activeContext, page: activePage };
  }

  activeContext = await launchContext(profileDir);
  activePage = activeContext.pages()[0] || (await activeContext.newPage());
  activePage.on("close", () => {
    if (activePage?.isClosed()) activePage = null;
  });
  activeContext.on("close", () => {
    activeContext = null;
    activePage = null;
  });
  return { context: activeContext, page: activePage };
}

function normalizeOptionalBinanceUrl(input) {
  if (!input || typeof input !== "string" || !input.trim()) return "";
  const parsed = new URL(input.trim());
  const host = parsed.hostname.toLowerCase();
  if (host !== "binance.com" && host !== "www.binance.com" && !host.endsWith(".binance.com")) {
    throw new Error("为了避免误扫其他网站，当前工具只接受 binance.com 链接。");
  }
  return parsed.toString();
}

async function launchContext(profileDir) {
  try {
    return await chromium.launchPersistentContext(profileDir, {
      channel: "chrome",
      headless: false,
      viewport: { width: 1365, height: 850 },
      locale: "zh-CN"
    });
  } catch (firstError) {
    try {
      return await chromium.launchPersistentContext(profileDir, {
        headless: false,
        viewport: { width: 1365, height: 850 },
        locale: "zh-CN"
      });
    } catch (secondError) {
      throw new Error(
        `无法启动浏览器。Chrome 错误：${firstError.message}\nPlaywright Chromium 错误：${secondError.message}\n可尝试运行：npx playwright install chromium`
      );
    }
  }
}

function parseJsonLike(body) {
  const trimmed = body.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return undefined;
    }
  }
  const jsonMatch = trimmed.match(/^[^(]*\(([\s\S]*)\);?$/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[1]);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

async function autoScrollNotificationPage(page, { maxSeconds, maxScrollRounds, idleRounds, onEvent }) {
  const started = Date.now();
  let previousContentSignature = "";
  let stableRounds = 0;
  let round = 0;
  let lastInfo = null;

  for (; round < maxScrollRounds; round += 1) {
    const elapsedSeconds = Math.round((Date.now() - started) / 1000);
    if (elapsedSeconds >= maxSeconds) {
      return { rounds: round, stableRounds, elapsedSeconds, stopReason: "达到最长记录时间" };
    }

    const info = await page.evaluate(() => {
      const candidates = [
        document.scrollingElement,
        document.documentElement,
        document.body,
        document.querySelector("[data-bn-type='scroll-view']"),
        ...document.querySelectorAll("main, [role='main'], [class*='scroll'], [class*='list'], [class*='List'], [class*='container']")
      ].filter(Boolean);

      const unique = [...new Set(candidates)];
      const scrollables = unique
        .map((target) => ({
          target,
          scrollTop: Number(target.scrollTop || window.scrollY || 0),
          scrollHeight: Number(target.scrollHeight || document.body.scrollHeight || 0),
          clientHeight: Number(target.clientHeight || window.innerHeight || 0)
        }))
        .filter((item) => item.scrollHeight > item.clientHeight + 10)
        .sort((a, b) => b.scrollHeight - b.clientHeight - (a.scrollHeight - a.clientHeight));

      const chosen = scrollables[0] || {
        target: document.scrollingElement || document.documentElement,
        scrollTop: window.scrollY,
        scrollHeight: document.body.scrollHeight,
        clientHeight: window.innerHeight
      };

      const beforeTop = Number(chosen.target.scrollTop || window.scrollY || 0);
      const step = Math.max(500, Math.floor((chosen.clientHeight || window.innerHeight || 800) * 0.85));
      if (chosen.target === document.scrollingElement || chosen.target === document.documentElement || chosen.target === document.body) {
        window.scrollBy(0, step);
      } else {
        chosen.target.scrollTop = beforeTop + step;
      }

      const afterTop = Number(chosen.target.scrollTop || window.scrollY || 0);
      const bodyText = document.body?.innerText || "";
      const contentSignature = [
        location.href,
        bodyText.length,
        document.querySelectorAll("li, article, a, [role='listitem']").length,
        Number(chosen.target.scrollHeight || document.body.scrollHeight || 0),
        bodyText.slice(-500)
      ].join("|");

      return {
        url: location.href,
        beforeTop,
        afterTop,
        scrollHeight: Number(chosen.target.scrollHeight || document.body.scrollHeight || 0),
        clientHeight: Number(chosen.target.clientHeight || window.innerHeight || 0),
        textLength: bodyText.length,
        itemCount: document.querySelectorAll("li, article, a, [role='listitem']").length,
        atBottom: afterTop + Number(chosen.target.clientHeight || window.innerHeight || 0) >= Number(chosen.target.scrollHeight || document.body.scrollHeight || 0) - 20,
        contentSignature
      };
    });

    lastInfo = info;
    if (info.contentSignature === previousContentSignature && info.atBottom) {
      stableRounds += 1;
    } else {
      stableRounds = 0;
      previousContentSignature = info.contentSignature;
    }

    emit(onEvent, "自动滚动通知列表", {
      round: round + 1,
      total: maxScrollRounds,
      stableRounds,
      idleRounds,
      itemCount: info.itemCount,
      textLength: info.textLength
    });

    if (stableRounds >= idleRounds) {
      return {
        rounds: round + 1,
        stableRounds,
        elapsedSeconds: Math.round((Date.now() - started) / 1000),
        stopReason: "连续多轮没有新通知内容",
        lastInfo
      };
    }

    await wait(1400);
  }

  return {
    rounds: round,
    stableRounds,
    elapsedSeconds: Math.round((Date.now() - started) / 1000),
    stopReason: "达到最多滚动次数",
    lastInfo
  };
}

async function extractVisibleNotificationUsers(page, { postId, targetPostUrl }) {
  return page.evaluate(
    ({ postId, targetPostUrl }) => {
      const repostRe =
        /(quoted your post|quote(d)?\s+your\s+post|引用了你的帖子|引用了你|引用你的帖子|引用你)/i;
      const nameBeforeRe = /^(.{1,80}?)(?:\s+)?(?:quoted your post|引用了你的帖子|引用了你|引用你的帖子|引用你)/i;
      const seen = new Set();
      const all = [...document.querySelectorAll("li, article, section, div, a")];
      const matchingItems = all.filter((el) => {
        const text = compact(el.textContent || "");
        if (text.length < 4 || text.length > 600 || !repostRe.test(text)) return false;
        return ![...el.children].some((child) => {
          const childText = compact(child.textContent || "");
          return childText.length >= 4 && childText.length < text.length && repostRe.test(childText);
        });
      });

      return matchingItems
        .map((el) => {
          const text = compact(el.textContent || "");
          const links = [...el.querySelectorAll("a[href]")].map((a) => ({
            text: compact(a.textContent || ""),
            href: a.href || ""
          }));
          const profileLink =
            links.find((link) => /\/square\/profile|\/profile\//i.test(link.href)) ||
            links.find((link) => link.text && !/post|帖子|通知|notification/i.test(link.text));
          const targetLink = links.find((link) => {
            if (postId && link.href.includes(postId)) return true;
            return targetPostUrl && link.href && normalizeUrl(link.href) === normalizeUrl(targetPostUrl);
          });
          const inferred = text.match(nameBeforeRe);
          const name = profileLink?.text || cleanName(inferred?.[1] || "");
          const targetPostMatch = Boolean(targetLink || (postId && (text.includes(postId) || el.innerHTML.includes(postId))));
          return {
            name,
            profileUrl: profileLink?.href || "",
            targetPostMatch,
            text: text.slice(0, 500)
          };
        })
        .filter((item) => {
          if (!item.name || item.name.length > 100) return false;
          const key = `${item.name}|${item.profileUrl}|${item.text}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .slice(0, 500);

      function compact(value) {
        return String(value || "").replace(/\s+/g, " ").trim();
      }

      function cleanName(value) {
        return compact(value)
          .replace(/^[·•\-\s]+/, "")
          .replace(/[：:，,。]+$/, "")
          .slice(0, 100);
      }

      function normalizeUrl(value) {
        try {
          const url = new URL(value);
          url.hash = "";
          return url.toString();
        } catch {
          return value || "";
        }
      }
    },
    { postId, targetPostUrl }
  );
}

function buildNotes(candidates, highConfidence, postId, currentUrl) {
  const notes = [];
  if (/accounts\.binance\.com|\/login/i.test(currentUrl || "")) {
    notes.push("当前币安窗口仍像是在登录页。请先在弹出的币安窗口完成登录，然后回到本工具点“开始记录通知”。");
  }
  if (highConfidence.length) {
    notes.push("已从通知中心发现“quoted your post / 引用了你的帖子”候选用户。");
  } else {
    notes.push("未发现高置信引用通知。请确认通知中心已登录，并且通知里确实有“quoted your post.”这类提醒。");
  }
  if (postId) {
    notes.push("已使用目标帖子 ID 过滤；能在通知条目或接口里匹配到该 ID 的结果置信度更高。");
  } else {
    notes.push("没有填写目标帖子链接时，结果会包含通知中心里所有“quoted your post / 引用了你的帖子”的候选项。");
  }
  if (candidates.some((item) => item.relations.join(" ").includes("需核对目标帖子"))) {
    notes.push("部分通知只说明有人引用了你的帖子，但页面文本里没暴露帖子 ID，需要人工打开证据核对是哪一条帖子。");
  }
  notes.push("工具只分析浏览器已经收到的通知数据，不绕过币安广场限制。");
  return notes;
}

function buildQuoteNotes(candidates, quoteResult, postId, currentUrl) {
  const notes = [];
  if (/accounts\.binance\.com|\/login/i.test(currentUrl || "")) {
    notes.push("当前币安窗口仍像是在登录页。请先在弹出的币安窗口完成登录，然后回到本工具重新开始。");
  }
  if (candidates.length) {
    notes.push(`已从帖子引用列表接口发现 ${candidates.length} 个引用用户。`);
  } else {
    notes.push("没有从引用列表接口拿到用户。请确认帖子链接正确，且币安窗口已完成登录或地区确认。");
  }
  if (quoteResult.quoteCount) {
    notes.push(`帖子页面显示引用数量为 ${quoteResult.quoteCount}；工具读取到 ${candidates.length} 个。`);
  }
  if (quoteResult.stopReason) {
    notes.push(`停止原因：${quoteResult.stopReason}。`);
  }
  if (postId) {
    notes.push("结果来自帖子本身的 queryQuoteContents 接口，不再依赖通知中心，所以不会漏掉没进通知的引用。");
  }
  return notes;
}

function buildQuoteCommentNotes(candidates, quoteResult, commentResult, postId, currentUrl) {
  const notes = [];
  if (/accounts\.binance\.com|\/login/i.test(currentUrl || "")) {
    notes.push("当前币安窗口仍像是在登录页。请先在弹出的币安窗口完成登录，然后回到本工具重新开始。");
  }
  notes.push(
    `已读取引用用户 ${quoteResult.candidates.length} 个；扫描评论用户 ${commentResult.totalUsersSeen || 0} 个，匹配到 ${commentResult.users.length} 个。`
  );
  if (candidates.length) {
    notes.push(`已一键三连用户 ${candidates.length} 个；抽奖只会从这些用户里抽。`);
  } else {
    notes.push("没有发现已一键三连用户。请确认帖子链接正确，并且评论区已对外可读。");
  }
  if (quoteResult.quoteCount) {
    notes.push(`帖子页面显示引用数量为 ${quoteResult.quoteCount}；工具按用户去重后再和评论名单匹配。`);
  }
  if (quoteResult.stopReason) {
    notes.push(`引用读取停止原因：${quoteResult.stopReason}。`);
  }
  if (commentResult.stopReason) {
    notes.push(`评论读取停止原因：${commentResult.stopReason}。`);
  }
  return notes;
}

function isBinanceNotificationUrl(url) {
  return /binance\.com\/.+square\/notifications/i.test(url || "");
}

function formatRunId(date) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitWithTicks(seconds, onTick) {
  let remaining = seconds;
  while (remaining > 0) {
    onTick(remaining);
    const step = Math.min(10, remaining);
    await wait(step * 1000);
    remaining -= step;
  }
}

function emit(onEvent, message, data = {}) {
  onEvent({
    at: new Date().toISOString(),
    message,
    data
  });
}
