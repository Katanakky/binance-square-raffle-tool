const USER_NAME_KEYS = [
  "nickName",
  "nickname",
  "userName",
  "username",
  "displayName",
  "name",
  "authorName",
  "creatorName",
  "screenName",
  "handle"
];

const USER_ID_KEYS = [
  "userId",
  "uid",
  "authorId",
  "creatorId",
  "profileId",
  "accountId",
  "userNo",
  "id"
];

const PROFILE_KEYS = [
  "profileUrl",
  "profileLink",
  "homepage",
  "homePage",
  "jumpUrl",
  "url"
];

const AVATAR_KEYS = ["avatar", "avatarUrl", "headImg", "image", "portrait"];
const RELATION_RE = /(repost|reshare|share|forward|retweet|quote|reference|引用|转发|分享|转载)/i;
const COMMENT_RE = /(comment|reply|评论|回复)/i;
const AUTHOR_RE = /(author|creator|publisher|owner|作者|发布者)/i;
const USERISH_RE = /(user|author|creator|profile|member|account|用户|作者)/i;
const NOTIFICATION_RE = /(notification|notice|inbox|message|notify|通知|消息|提醒)/i;
const QUOTE_NOTIFICATION_RE = /(quoted your post|quote(d)?\s+your\s+post|引用了你的帖子|引用了你|引用你的帖子|引用你)/i;
const REPOST_NOTIFICATION_RE =
  /(reposted your|shared your|quoted your|reshared your|forwarded your|repost(ed)?\s+.*post|share(d)?\s+.*post|quote(d)?\s+.*post|转发了你的|轉發了你的|分享了你的|引用了你的|转发了你|轉發了你|分享了你|引用了你)/i;

export const SCAN_KEYWORD_RE =
  /(repost|reshare|share|forward|retweet|quote|reference|comment|reply|interaction|engage|notification|notice|inbox|message|notify|引用|转发|轉發|分享|转载|評論|评论|回复|互动|通知|消息|提醒)/i;

export function extractPostId(input) {
  if (!input) return "";
  const match = String(input).match(/(?:post|feed|square)\/(?:detail\/)?(\d{6,})/i);
  if (match) return match[1];
  const anyLongId = String(input).match(/\b\d{9,}\b/);
  return anyLongId ? anyLongId[0] : "";
}

export function normalizeEndpoint(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    const blocked = /token|secret|signature|csrf|cookie|session|auth|key|password/i;
    for (const key of [...parsed.searchParams.keys()]) {
      if (blocked.test(key)) parsed.searchParams.set(key, "[redacted]");
    }
    return `${parsed.origin}${parsed.pathname}${parsed.search}`;
  } catch {
    return String(rawUrl || "").slice(0, 300);
  }
}

export function extractCandidatesFromJson(payload, source) {
  const candidates = new Map();
  const endpoint = normalizeEndpoint(source.url || "");
  const endpointRelevant = SCAN_KEYWORD_RE.test(endpoint);
  const postId = source.postId || "";
  const onlyQuoteNotifications = source.onlyQuoteNotifications !== false;

  walk(payload, [], null, "");
  return [...candidates.values()].sort((a, b) => b.confidence - a.confidence);

  function walk(value, path, parentKey, contextText) {
    if (!value || typeof value !== "object") return;

    if (Array.isArray(value)) {
      const limit = Math.min(value.length, 800);
      for (let i = 0; i < limit; i += 1) walk(value[i], path.concat(String(i)), parentKey, contextText);
      return;
    }

    const keys = Object.keys(value);
    const pathText = path.join(".");
    const pathRelevant = SCAN_KEYWORD_RE.test(pathText) || SCAN_KEYWORD_RE.test(String(parentKey || ""));
    const objectText = [contextText, previewObjectText(value)].filter(Boolean).join(" ");
    const rawObjectText = JSON.stringify(value);
    const postRelevant = postId && (rawObjectText.includes(postId) || objectText.includes(postId));
    const notificationRelevant = NOTIFICATION_RE.test(pathText) || NOTIFICATION_RE.test(endpoint) || NOTIFICATION_RE.test(objectText);
    const quoteNotification = QUOTE_NOTIFICATION_RE.test(objectText) || QUOTE_NOTIFICATION_RE.test(pathText);
    const repostNotification = REPOST_NOTIFICATION_RE.test(objectText) || REPOST_NOTIFICATION_RE.test(pathText);
    const userish = USERISH_RE.test(pathText) || keys.some((key) => USERISH_RE.test(key));
    const name = pickString(value, USER_NAME_KEYS);
    const userId = pickScalar(value, USER_ID_KEYS);
    const profileUrl = pickString(value, PROFILE_KEYS);
    const avatarUrl = pickString(value, AVATAR_KEYS);

    if (
      name &&
      (userId || profileUrl || avatarUrl || userish) &&
      (!onlyQuoteNotifications || quoteNotification) &&
      (!onlyQuoteNotifications || !isSecondaryMessageUser(pathText))
    ) {
      const relation = inferRelation(pathText, endpoint, objectText);
      let confidence = 25;
      if (endpointRelevant) confidence += 20;
      if (pathRelevant) confidence += 25;
      if (notificationRelevant) confidence += 15;
      if (repostNotification) confidence += 30;
      if (postRelevant) confidence += 25;
      if (userId) confidence += 10;
      if (profileUrl) confidence += 8;
      if (avatarUrl) confidence += 5;
      if (relation === "通知：引用了你的帖子") confidence += 35;
      if (relation === "通知：转发/分享了你的帖子") confidence += 20;
      if (relation === "转发/分享相关响应") confidence += 15;
      if (relation === "评论/回复相关响应") confidence -= 20;
      if (relation === "作者/发布者") confidence -= 25;
      confidence = Math.max(5, Math.min(100, confidence));

      const resolvedProfileUrl = absolutizeProfile(profileUrl) || deriveSquareProfileUrl(name);
      const id = stableKey({ userId, name, profileUrl: resolvedProfileUrl });
      const evidence = {
        endpoint,
        path: pathText || "(root)",
        relation,
        status: source.status || 0,
        keywordHit: endpointRelevant || pathRelevant || notificationRelevant || Boolean(postRelevant),
        targetPostMatch: Boolean(postRelevant),
        text: extractQuoteEvidenceText(objectText)
      };

      const current = candidates.get(id);
      if (current) {
        current.confidence = Math.max(current.confidence, confidence);
        if (!current.evidence.some((item) => item.endpoint === evidence.endpoint && item.path === evidence.path)) {
          current.evidence.push(evidence);
        }
        current.relations = [...new Set(current.relations.concat(relation))];
      } else {
        candidates.set(id, {
          key: id,
          name,
          userId: userId ? String(userId) : "",
          profileUrl: resolvedProfileUrl,
          profileUrlSource: profileUrl ? "接口返回" : resolvedProfileUrl ? "按用户名推测" : "",
          avatarUrl: avatarUrl || "",
          confidence,
          relations: [relation],
          evidence: [evidence]
        });
      }
    }

    for (const key of keys) {
      const next = value[key];
      if (next && typeof next === "object") walk(next, path.concat(key), key, objectText.slice(0, 3000));
    }
  }
}

export function mergeCandidates(candidateGroups) {
  const merged = new Map();
  for (const group of candidateGroups) {
    for (const item of group) {
      const existing = merged.get(item.key);
      if (!existing) {
        merged.set(item.key, { ...item, evidence: [...item.evidence], relations: [...item.relations] });
        continue;
      }
      existing.confidence = Math.max(existing.confidence, item.confidence);
      existing.relations = [...new Set(existing.relations.concat(item.relations))];
      for (const ev of item.evidence) {
        if (!existing.evidence.some((old) => old.endpoint === ev.endpoint && old.path === ev.path)) {
          existing.evidence.push(ev);
        }
      }
    }
  }
  return [...merged.values()]
    .map((item) => ({ ...item, evidence: item.evidence.slice(0, 5) }))
    .sort((a, b) => b.confidence - a.confidence || a.name.localeCompare(b.name));
}

export function toCsv(rows) {
  const header = [
    "name",
    "userId",
    "profileUrl",
    "profileUrlSource",
    "quotePostUrl",
    "quoted",
    "commented",
    "commentCount",
    "confidence",
    "relations",
    "evidence"
  ];
  const lines = [header.join(",")];
  for (const row of rows) {
    const quotePostUrl = row.evidence.find((ev) => ev.quotePostUrl)?.quotePostUrl || "";
    lines.push(
      [
        row.name,
        row.userId,
        row.profileUrl,
        row.profileUrlSource || "",
        quotePostUrl,
        row.conditions?.quoted ? "yes" : "",
        row.conditions?.commented ? "yes" : "",
        row.commentCount || "",
        row.confidence,
        row.relations.join(" | "),
        row.evidence.map((ev) => `${ev.relation} ${ev.endpoint} ${ev.path}`).join(" | ")
      ]
        .map(csvEscape)
        .join(",")
    );
  }
  return `${lines.join("\n")}\n`;
}

function pickString(object, keys) {
  for (const key of keys) {
    const value = object[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function pickScalar(object, keys) {
  for (const key of keys) {
    const value = object[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return "";
}

function stableKey({ userId, name, profileUrl }) {
  if (userId) return `id:${String(userId).toLowerCase()}`;
  if (profileUrl) return `url:${String(profileUrl).toLowerCase()}`;
  return `name:${String(name || "").toLowerCase()}`;
}

function inferRelation(pathText, endpoint, objectText = "") {
  const text = `${pathText} ${endpoint} ${objectText}`;
  if (QUOTE_NOTIFICATION_RE.test(text)) return "通知：引用了你的帖子";
  if (REPOST_NOTIFICATION_RE.test(text)) return "通知：转发/分享了你的帖子";
  if (RELATION_RE.test(text)) return "转发/分享相关响应";
  if (COMMENT_RE.test(text)) return "评论/回复相关响应";
  if (AUTHOR_RE.test(text)) return "作者/发布者";
  return "其他页面响应";
}

function isSecondaryMessageUser(pathText) {
  const match = String(pathText || "").match(/(?:^|\.)users\.(\d+)(?:\.|$)/);
  return match ? Number(match[1]) > 0 : false;
}

function extractQuoteEvidenceText(text) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (!value) return "";
  const match = value.match(/[^.。!?！？]{0,120}(?:quoted your post|quote(?:d)?\s+your\s+post|引用了你的帖子|引用了你|引用你的帖子|引用你)[^.。!?！？]{0,180}[.。!?！？]?/i);
  return match ? match[0].trim() : "";
}

function previewObjectText(value) {
  const parts = [];
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
      parts.push(`${key}:${item}`);
    }
    if (parts.join(" ").length > 2000) break;
  }
  return parts.join(" ");
}

function absolutizeProfile(value) {
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith("/")) return `https://www.binance.com${value}`;
  return value;
}

export function deriveSquareProfileUrl(name) {
  const raw = String(name || "").trim();
  if (!raw) return "";
  if (!/^[A-Za-z0-9_.-]{3,80}$/.test(raw)) return "";
  if (/followers?|following|blockchain|research|independent|creator$/i.test(raw)) return "";
  const slug = raw.toLowerCase();
  return `https://www.binance.com/zh-CN/square/profile/${encodeURIComponent(slug)}`;
}

function csvEscape(value) {
  const text = String(value ?? "");
  if (!/[",\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}
