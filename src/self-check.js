import assert from "node:assert/strict";
import { extractCandidatesFromJson, mergeCandidates, toCsv } from "./extract.js";

const fixture = {
  data: {
    notificationList: [
      {
        noticeType: "square_notification",
        message: "Alpha quoted your post 123456789",
        user: {
          userId: "1001",
          nickname: "Alpha",
          profileUrl: "/en/square/profile/alpha"
        },
        postId: "123456789"
      }
    ],
    repostUsers: [
      {
        userId: "1001",
        nickname: "Alpha",
        profileUrl: "/en/square/profile/alpha",
        avatarUrl: "https://example.test/a.png"
      },
      {
        userId: "1002",
        nickname: "Beta",
        profileUrl: "/en/square/profile/beta"
      }
    ],
    comments: [
      {
        userId: "2001",
        nickname: "Commenter",
        profileUrl: "/en/square/profile/commenter"
      }
    ]
  }
};

const candidates = extractCandidatesFromJson(fixture, {
  url: "https://www.binance.com/bapi/square/v1/private/square/notification/list",
  status: 200,
  postId: "123456789"
});
const merged = mergeCandidates([candidates]);
assert.equal(merged.length, 1);
assert.equal(merged[0].name, "Alpha");
assert.ok(merged[0].confidence >= 65);
assert.ok(merged[0].relations.includes("通知：引用了你的帖子"));
assert.ok(toCsv(merged).includes("Alpha"));
console.log("self-check passed");
