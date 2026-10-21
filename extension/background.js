// background.js —— 队列调度：逐条按知网「篇名」检索，抓结果，存起来
// 状态持久化到 chrome.storage，service worker 被回收也不会丢。

const CNKI_HOME = "https://kns.cnki.net/kns8s/AdvSearch";
const clean = (s) =>
  String(s || "")
    .replace(/[《》〈〉“”"'‘’【】\[\]]/g, "")
    .replace(/^\s*(?:\[?\d{1,3}[\]\.、)）])\s*/, "")
    .replace(/[.。，,；;：:]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

const CNKI_URL = (kw) =>
  "https://kns.cnki.net/kns8s/defaultresult/index?kw=" + encodeURIComponent(clean(kw)) + "&korder=TI";
const WF_URL = (kw) => "https://s.wanfangdata.com.cn/paper?q=" + encodeURIComponent(clean(kw));

let state = {
  running: false, stopped: false, blockedAt: null, blockedUrl: "",
  index: 0, total: 0, results: [], queue: [], source: "cnki", foreground: false
};
let keepTimer = null;

function save() {
  chrome.storage.local.set({ state });
  try { chrome.runtime.sendMessage({ type: "STATE", state }).catch(() => {}); } catch (e) {}
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// 让 service worker 在跑批期间别被回收（每 20 秒碰一次扩展 API）
function keepAlive(on) {
  if (on && !keepTimer) {
    keepTimer = setInterval(() => { try { chrome.runtime.getPlatformInfo(() => {}); } catch (e) {} }, 20000);
  } else if (!on && keepTimer) {
    clearInterval(keepTimer); keepTimer = null;
  }
}

const JUNK = /^(充值中心|登录|注册|首页|高级检索|帮助|我的知网|读者服务|机构用户|个人用户|购买|下载|收藏)$/;

// 题名归一化，用来判断“检索结果里有没有跟它一模一样的”
function normTitle(s) {
  return String(s || "").toLowerCase().replace(/[^0-9a-z\u4e00-\u9fff]+/g, "").slice(0, 90);
}

// 判定：命中 / 部分命中 / 疑似虚假（命中过多）/ 未命中
function decide(query, data, threshold) {
  if (data.blocked) return "被验证拦截";
  if (data.redirect) return "未登录或被重定向";
  const q = normTitle(query);
  const rows = data.rows || [];
  const exact = rows.some((r) => {
    const t = normTitle(r.title);
    return t && (t === q || (t.length > 6 && t.includes(q)) || (q.length > 6 && q.includes(t)));
  });
  const hits = data.hits || 0;
  if (exact) return "命中";
  if (hits > threshold) return "疑似虚假（命中过多，题名太泛或不存在）";
  if (hits >= 1) return "部分命中（有近似条，需人工看）";
  return "未命中（可能虚构）";
}

// 把结果推给打开着的核验器网页
async function pushToPages(payload) {
  try {
    const tabs = await chrome.tabs.query({ url: ["http://127.0.0.1:8799/*", "http://localhost:8799/*"] });
    for (const t of tabs) {
      try { await chrome.tabs.sendMessage(t.id, payload); } catch (e) {}
    }
  } catch (e) {}
}

function collectInPage() {
  const textOf = (el) => (el && el.innerText ? el.innerText : "").replace(/\s+/g, " ").trim();
  const bodyText = document.body ? document.body.innerText : "";
  const JUNK = /^(充值中心|登录|注册|首页|高级检索|帮助|我的知网|读者服务|机构用户|个人用户|购买|下载|收藏|退出|购买知网卡|知网卡|会员|充值)$/;

  const rows = document.querySelectorAll(".result-table-list tbody tr, #gridTable tbody tr, .list-item").length;

  // 只有“整页就是验证”或“验证框真的显示出来”才算被挡；
  // 知网页面里到处都有“验证码/安全验证”字样，不能只靠关键词判断。
  let visibleCaptcha = false;
  const box = document.querySelector(".nc-container, .nc_wrapper, .geetest_panel, #captcha, .verifybox, iframe[src*='captcha'], .verify-wrap");
  if (box && (box.offsetWidth > 0 || box.offsetHeight > 0)) visibleCaptcha = true;
  const blocked = rows === 0 && (visibleCaptcha || (/请完成安全验证|拖动滑块|滑动验证/.test(bodyText) && bodyText.length < 1500));

  if (blocked) return { blocked: true, hits: 0, rows: [], debug: { rows, len: bodyText.length, visibleCaptcha } };

  const out = [];
  document.querySelectorAll(".result-table-list tbody tr, #gridTable tbody tr, .list-item, .normal-list .title").forEach((tr) => {
    const link = tr.querySelector ? tr.querySelector("td.name a, .name a, a.fz14, a") : null;
    const title = textOf(link) || textOf(tr.querySelector ? tr.querySelector("td.name, .name") : tr);
    if (!title || title.length < 4) return;
    if (JUNK.test(title)) return;
    out.push({
      title,
      author: textOf(tr.querySelector ? tr.querySelector("td.author, .author") : null),
      source: textOf(tr.querySelector ? tr.querySelector("td.source, .source") : null),
      date: textOf(tr.querySelector ? tr.querySelector("td.date, .date") : null),
      url: link && link.href ? link.href : ""
    });
  });
  const m = bodyText.match(/(?:找到|共)\s*([\d,]+)\s*条/);
  return { blocked: false, hits: m ? Number(m[1].replace(/,/g, "")) : out.length, rows: out, debug: { rows, len: bodyText.length } };
}

async function queryOnce(title, source, foreground) {  const url = source === "wanfang" ? WF_URL(title) : CNKI_URL(title);
  let tabId = null;
  try {
    const tab = await chrome.tabs.create({ url, active: !!foreground });
    tabId = tab.id;
    // 最多等 20 秒加载
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      const t = await chrome.tabs.get(tabId).catch(() => null);
      if (!t) return { data: { blocked: false, hits: 0, rows: [], error: "标签页被关闭" }, tabId: null, url };
      if (t.status === "complete") break;
    }
    await sleep(1800);
    // 关键：先看最后停在哪。被重定向到充值/登录页，说明没有登录或无权限
    const cur = await chrome.tabs.get(tabId).catch(() => null);
    const curUrl = (cur && cur.url) || "";
    const host = (() => { try { return new URL(curUrl).host; } catch (e) { return ""; } })();
    const paywalled = /zhifu\.cnki\.net|login|passport|my\.cnki\.net/.test(curUrl) || (source === "cnki" && host && !host.includes("cnki.net"));
    if (paywalled) {
      // 登录态可能还在生效中：等 5 秒重开一次
      try { if (tabId != null) await chrome.tabs.remove(tabId); } catch (e) {}
      await sleep(5000);
      const tab2 = await chrome.tabs.create({ url, active: !!foreground });
      const tabId2 = tab2.id;
      for (let i = 0; i < 40; i++) {
        await sleep(500);
        const t = await chrome.tabs.get(tabId2).catch(() => null);
        if (!t) break;
        if (t.status === "complete") break;
      }
      await sleep(1800);
      const cur2 = await chrome.tabs.get(tabId2).catch(() => null);
      const curUrl2 = (cur2 && cur2.url) || "";
      if (/zhifu\.cnki\.net|login|passport|my\.cnki\.net/.test(curUrl2)) {
        return { data: { blocked: false, redirect: true, hits: 0, rows: [], url: curUrl2 }, tabId: tabId2, url: curUrl2 };
      }
      const [res2] = await chrome.scripting.executeScript({ target: { tabId: tabId2 }, func: collectInPage });
      return { data: (res2 && res2.result) || { blocked: false, hits: 0, rows: [] }, tabId: tabId2, url: curUrl2 };
    }
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: collectInPage });
    return { data: (res && res.result) || { blocked: false, hits: 0, rows: [] }, tabId, url: curUrl };
  } catch (e) {
    return { data: { blocked: false, hits: 0, rows: [], error: String((e && e.message) || e) }, tabId, url };
  }
}

async function runQueue(startIndex) {
  state.running = true;
  state.stopped = false;
  state.blockedAt = null;
  state.blockedUrl = "";
  state.needLogin = false;
  save();
  keepAlive(true);
  for (let i = startIndex; i < state.queue.length; i++) {
    if (state.stopped) break;
    state.index = i;
    save();
    const title = state.queue[i];
    const { data, tabId, url } = await queryOnce(title, state.source, state.foreground);
    state.results.push({
      query: title, blocked: !!data.blocked, redirect: !!data.redirect, hits: data.hits || 0,
      top: (data.rows || [])[0] || null, rows: (data.rows || []).slice(0, 3),
      verdict: decide(title, data, state.threshold || 20),
      error: data.error || "", debug: data.debug || null, landedUrl: data.url || ""
    });
    pushToPages({ type: "RESULT", result: state.results[state.results.length - 1] });
    if (data.redirect) {
      state.stopped = true;
      state.needLogin = true;
      state.blockedAt = i;
      state.blockedUrl = data.url || url;
      try { if (tabId != null) await chrome.tabs.update(tabId, { active: true }); } catch (e) {}
      save();
      break;
    }
    if (data.blocked) {
      state.stopped = true;
      state.blockedAt = i;
      state.blockedUrl = url;
      try { if (tabId != null) await chrome.tabs.update(tabId, { active: true }); } catch (e) {}
      save();
      break;
    }
    try { if (tabId != null) await chrome.tabs.remove(tabId); } catch (e) {}
    save();
    await sleep(600);
  }
  state.running = false;
  keepAlive(false);
  save();
  pushToPages({ type: "DONE", state });
}

// 检测知网是否已登录：打开高级检索页，看页面上有没有“退出/我的知网”
async function checkLogin() {
  const tab = await chrome.tabs.create({ url: CNKI_HOME, active: true });
  await sleep(4500);
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const t = document.body ? document.body.innerText : "";
        const loggedIn = /退出|我的知网|个人中心|欢迎您/.test(t);
        return { loggedIn, len: t.length, head: t.replace(/\s+/g, " ").slice(0, 80) };
      }
    });
    const r = (res && res.result) || { loggedIn: false };
    state.loginCheck = { ...r, at: Date.now() };
    save();
    return state.loginCheck;
  } catch (e) {
    state.loginCheck = { loggedIn: false, error: String((e && e.message) || e), at: Date.now() };
    save();
    return state.loginCheck;
  }
}

// 重启后把状态读回来
chrome.storage.local.get(["state"]).then((r) => {
  if (r && r.state) {
    const s = r.state;
    // 上次如果还在 running，说明 worker 被回收了：标记成未运行，允许继续
    if (s.running) { s.running = false; s.interrupted = true; }
    state = { ...state, ...s };
    save();
  }
}).catch(() => {});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === "START") {
    const titles = (msg.titles || []).map(clean).filter((t) => t.length >= 4);
    state = {
      running: false, stopped: false, blockedAt: null, blockedUrl: "",
      index: 0, total: titles.length, results: [], queue: titles,
      source: msg.source || "cnki", foreground: !!msg.foreground,
      threshold: Number(msg.threshold) > 0 ? Number(msg.threshold) : 20
    };
    save();
    runQueue(0);
    sendResponse({ ok: true, total: titles.length });
    return true;
  }
  if (msg.type === "CONTINUE") {
    if (!state.queue.length) { sendResponse({ ok: false }); return true; }
    const from = state.blockedAt == null ? state.index : state.blockedAt;
    state.results = state.results.filter((_, i) => i < from);
    runQueue(from);
    sendResponse({ ok: true, from });
    return true;
  }
  if (msg.type === "STOP") { state.stopped = true; save(); sendResponse({ ok: true }); return true; }
  if (msg.type === "GET_STATE") {
    chrome.storage.local.get(["state"]).then((r) => sendResponse({ state: (r && r.state) || state }));
    return true; // 异步响应
  }
  if (msg.type === "OPEN_HOME") { chrome.tabs.create({ url: CNKI_HOME, active: true }); sendResponse({ ok: true }); return true; }
  if (msg.type === "CHECK_LOGIN") {
    checkLogin().then((r) => sendResponse({ ok: true, loginCheck: r })).catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (msg.type === "CLEAR") {
    state = { running: false, stopped: false, blockedAt: null, blockedUrl: "", index: 0, total: 0, results: [], queue: [], source: "cnki", foreground: false };
    save(); sendResponse({ ok: true }); return true;
  }
  if (msg.type === "PAGE_READY") return;
});
