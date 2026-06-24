import { runScan } from "./scanner.js";

const args = parseArgs(process.argv.slice(2));

runScan(
  {
    targetPostUrl: args.target || args.url || "",
    notificationUrl: args.notifications || "",
    maxSeconds: args.maxSeconds || args.seconds || 1200,
    maxPages: args.maxPages || args.maxScrollRounds || args.scrollRounds || 500,
    idleRounds: args.idleRounds || 6
  },
  (event) => {
    console.log(`[${event.at}] ${event.message}`);
  }
)
  .then((result) => {
    console.log(
      `完成：已一键三连用户 ${result.summary.totalCandidates} 个；引用用户 ${result.summary.quoteUsers || 0} 个，评论用户 ${result.summary.commentUsers || 0} 个`
    );
    console.log(`JSON：${result.files.jsonPath}`);
    console.log(`CSV：${result.files.csvPath}`);
  })
  .catch((error) => {
    console.error(error.message);
    console.error("用法：npm run scan -- --target https://www.binance.com/zh-CN/square/post/... --maxSeconds 1200 --maxPages 500");
    process.exit(1);
  });

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === "--target" || item === "--url") out.target = argv[++i];
    else if (item === "--notifications") out.notifications = argv[++i];
    else if (item === "--seconds") out.seconds = Number(argv[++i]);
    else if (item === "--scrollRounds") out.scrollRounds = Number(argv[++i]);
    else if (item === "--maxSeconds") out.maxSeconds = Number(argv[++i]);
    else if (item === "--maxPages") out.maxPages = Number(argv[++i]);
    else if (item === "--maxScrollRounds") out.maxScrollRounds = Number(argv[++i]);
    else if (item === "--idleRounds") out.idleRounds = Number(argv[++i]);
  }
  return out;
}
