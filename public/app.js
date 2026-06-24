const targetPostUrl = document.querySelector("#targetPostUrl");
const maxMinutes = document.querySelector("#maxMinutes");
const maxPages = document.querySelector("#maxPages");
const openBtn = document.querySelector("#openBtn");
const startBtn = document.querySelector("#startBtn");
const serverState = document.querySelector("#serverState");
const eventsEl = document.querySelector("#events");
const notesEl = document.querySelector("#notes");
const rowsEl = document.querySelector("#candidateRows");
const metricsEl = document.querySelector("#metrics");
const csvLink = document.querySelector("#csvLink");
const jsonLink = document.querySelector("#jsonLink");
const raffleCount = document.querySelector("#raffleCount");
const raffleBtn = document.querySelector("#raffleBtn");
const raffleStatus = document.querySelector("#raffleStatus");
const winnerBox = document.querySelector("#winnerBox");
const winnerRows = document.querySelector("#winnerRows");

let pollTimer = null;
let currentCandidates = [];

openBtn.addEventListener("click", async () => {
  setState("打开中", "running");
  openBtn.disabled = true;
  try {
    const response = await fetch("/api/open-notifications", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        targetPostUrl: targetPostUrl.value.trim()
      })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "打开失败");
    renderEvents(data.events || []);
    setState("请登录币安", "warn");
    notesEl.innerHTML = "<li>请在弹出的币安窗口完成登录或地区确认，并确认能看到目标帖子。准备好以后回来点“2 读取数据”。</li>";
  } catch (error) {
    setState(error.message, "error");
  } finally {
    openBtn.disabled = false;
  }
});

startBtn.addEventListener("click", async () => {
  resetUi();
  setState("记录中", "running");
  startBtn.disabled = true;

  try {
    const response = await fetch("/api/scan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        targetPostUrl: targetPostUrl.value.trim(),
        maxSeconds: Math.max(60, Number(maxMinutes.value || 20) * 60),
        maxPages: Number(maxPages.value || 500)
      })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "启动失败");
    poll(data.scanId);
  } catch (error) {
    setState(error.message, "error");
    startBtn.disabled = false;
  }
});

raffleBtn.addEventListener("click", () => {
  if (!currentCandidates.length) {
    raffleStatus.textContent = "先读取已一键三连名单";
    return;
  }

  const requested = Math.max(1, Math.floor(Number(raffleCount.value || 1)));
  const count = Math.min(requested, currentCandidates.length);
  const winners = sampleRandom(currentCandidates, count);
  renderWinners(winners, requested);
});

function poll(scanId) {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    const response = await fetch(`/api/scan/${encodeURIComponent(scanId)}`);
    const data = await response.json();
    renderEvents(data.events || []);

    if (data.status === "running") {
      setState("记录中", "running");
      return;
    }

    clearInterval(pollTimer);
    startBtn.disabled = false;

    if (data.status === "done") {
      setState("完成", "done");
      renderResult(data.result, scanId);
    } else {
      setState(data.error || "记录失败", "error");
    }
  }, 1500);
}

function resetUi() {
  currentCandidates = [];
  eventsEl.innerHTML = "<li>开始读取数据...</li>";
  notesEl.innerHTML = "<li>等待记录完成。</li>";
  rowsEl.innerHTML = '<tr><td colspan="4" class="empty">记录中...</td></tr>';
  winnerRows.innerHTML = "";
  winnerBox.hidden = true;
  raffleStatus.textContent = "读取结果后可抽奖";
  raffleBtn.disabled = true;
  updateMetrics(0, 0, 0);
  csvLink.classList.add("disabled");
  jsonLink.classList.add("disabled");
  csvLink.removeAttribute("href");
  jsonLink.removeAttribute("href");
}

function renderEvents(events) {
  if (!events.length) return;
  eventsEl.innerHTML = events
    .slice(-12)
    .reverse()
    .map((event) => {
      const time = new Date(event.at).toLocaleTimeString("zh-CN", { hour12: false });
      const data = event.data || {};
      const extra = data.remainingSeconds
        ? `剩余 ${data.remainingSeconds} 秒`
        : data.count
          ? `${data.count} 个候选`
        : data.items !== undefined
            ? `本页 ${data.items} 条`
          : data.round
            ? `${data.round}/${data.total}`
            : "";
      return `<li><span>${escapeHtml(time)}</span>${escapeHtml(event.message)}${extra ? `<em>${escapeHtml(extra)}</em>` : ""}</li>`;
    })
    .join("");
}

function renderResult(result, scanId) {
  currentCandidates = result.candidates || [];
  updateMetrics(result.summary.totalCandidates, result.summary.quoteUsers || 0, result.summary.commentUsers || 0);
  notesEl.innerHTML = result.notes.map((note) => `<li>${escapeHtml(note)}</li>`).join("");
  csvLink.href = `/api/download/${encodeURIComponent(scanId)}/csv`;
  jsonLink.href = `/api/download/${encodeURIComponent(scanId)}/json`;
  csvLink.classList.remove("disabled");
  jsonLink.classList.remove("disabled");

  raffleBtn.disabled = currentCandidates.length === 0;
  raffleCount.max = String(Math.max(1, currentCandidates.length));
  raffleStatus.textContent = currentCandidates.length ? `可从 ${currentCandidates.length} 个已一键三连用户中抽奖` : "没有可抽奖用户";

  if (!currentCandidates.length) {
    rowsEl.innerHTML = '<tr><td colspan="4" class="empty">没有读取到已一键三连用户。请确认币安窗口已经登录或完成地区确认，并且帖子链接正确。</td></tr>';
    return;
  }

  rowsEl.innerHTML = currentCandidates
    .map((item) => {
      const quoteEvidence = item.evidence.find((ev) => ev.quotePostUrl) || item.evidence[0] || {};
      const commentEvidence = item.evidence.find((ev) => ev.commentId || ev.relation?.includes("评论")) || {};
      const relation = item.relations.join(" / ");
      const profile = item.profileUrl ? `<a href="${escapeAttr(item.profileUrl)}" target="_blank" rel="noreferrer">${escapeHtml(item.name)}</a>` : escapeHtml(item.name);
      const source = item.profileUrlSource ? `<small>${escapeHtml(item.profileUrlSource)}</small>` : "";
      const evidenceText = commentEvidence.text ? `<small>${escapeHtml(commentEvidence.text)}</small>` : "";
      const quotePost = quoteEvidence.quotePostUrl ? `<small><a href="${escapeAttr(quoteEvidence.quotePostUrl)}" target="_blank" rel="noreferrer">打开引用帖</a></small>` : "";
      return `<tr>
        <td><strong>${profile}</strong>${source}${item.userId ? `<small>${escapeHtml(item.userId)}</small>` : ""}</td>
        <td><meter min="0" max="100" value="${item.confidence}"></meter><span>${item.confidence}</span></td>
        <td>${escapeHtml(relation)}</td>
        <td><code>${escapeHtml(quoteEvidence.endpoint || "")}</code>${quotePost}${evidenceText}<small>${escapeHtml(commentEvidence.commentId ? `评论ID ${commentEvidence.commentId}` : "")}</small></td>
      </tr>`;
    })
    .join("");
}

function renderWinners(winners, requested) {
  winnerBox.hidden = false;
  winnerRows.innerHTML = winners
    .map((item, index) => {
      const evidence = item.evidence.find((ev) => ev.quotePostUrl) || item.evidence[0] || {};
      const profile = item.profileUrl ? `<a href="${escapeAttr(item.profileUrl)}" target="_blank" rel="noreferrer">${escapeHtml(item.name)}</a>` : escapeHtml(item.name);
      const quotePost = evidence.quotePostUrl ? `<a href="${escapeAttr(evidence.quotePostUrl)}" target="_blank" rel="noreferrer">引用帖</a>` : "";
      return `<li>
        <strong>${index + 1}. ${profile}</strong>
        ${item.userId ? `<span>${escapeHtml(item.userId)}</span>` : ""}
        ${quotePost ? `<small>${quotePost}</small>` : ""}
      </li>`;
    })
    .join("");

  raffleStatus.textContent =
    requested > currentCandidates.length
      ? `已抽 ${winners.length} 人；可抽人数不足 ${requested} 人`
      : `已抽 ${winners.length} 人`;
}

function sampleRandom(items, count) {
  const copy = items.slice();
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, count);
}

function randomInt(maxExclusive) {
  if (window.crypto?.getRandomValues) {
    const values = new Uint32Array(1);
    const limit = Math.floor(0x100000000 / maxExclusive) * maxExclusive;
    do {
      window.crypto.getRandomValues(values);
    } while (values[0] >= limit);
    return values[0] % maxExclusive;
  }
  return Math.floor(Math.random() * maxExclusive);
}

function updateMetrics(total, likely, endpoints) {
  const values = [total, likely, endpoints];
  [...metricsEl.querySelectorAll("strong")].forEach((node, index) => {
    node.textContent = values[index];
  });
}

function setState(text, mode) {
  serverState.textContent = text;
  serverState.dataset.mode = mode;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/'/g, "&#39;");
}
