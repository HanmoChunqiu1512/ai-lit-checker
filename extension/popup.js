// popup.js
const $ = (id) => document.getElementById(id);
let lastState = null;

function setStatus(t) { $("status").textContent = t; }
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

function render(st) {
  lastState = st;
  const list = $("list");
  list.innerHTML = "";
  if (!st) return;
  $("captchaBox").style.display = (st.blockedAt != null && !st.running) ? "block" : "none";
  if (st.needLogin) {
    $("captchaBox").innerHTML = "知网把页面跳到了<b>充值中心/登录页</b>，说明这个浏览器还没登录（或没有权限）。<br>请在弹出的那个标签页里登录知网，能正常搜到结果后，回来点「继续」。";
    $("captchaBox").style.display = "block";
  } else {
    $("captchaBox").innerHTML = "被知网安全验证挡住了。请在已经打开的那个标签页里手动滑一下，滑完点上面的「继续」。";
  }
  $("cont").disabled = !(st.blockedAt != null && !st.running);
  $("export").disabled = !(st.results && st.results.length);
  (st.results || []).forEach((r, i) => {
    const div = document.createElement("div");
    div.className = "item";
    const top = r.top;
    const v = r.verdict || "";
    const vCls = /命中$/.test(v) ? "ok" : (/虚假|未命中|拦截|重定向/.test(v) ? "bad" : "warn");
    div.innerHTML =
      `<div class="q">${i + 1}. ${esc(r.query)}</div>` +
      (v ? `<div class="${vCls}">判定：${esc(v)}</div>` : "") +
      (r.blocked
        ? `<div class="bad">被安全验证挡住（手动过验证后点“继续”）</div>`
        : (r.redirect
          ? `<div class="bad">被重定向到 ${esc(r.landedUrl || "登录/充值页")}（先登录再继续）</div>`
          : `<div class="${top ? "ok" : "bad"}">命中 ${r.hits} 条${top ? "" : "（没抓到结果）"}</div>` +
            (top ? `<div class="t">首条：${esc(top.title)}${top.source ? " ｜ " + esc(top.source) : ""}${top.date ? " ｜ " + esc(top.date) : ""}</div>` : ""))) +
      (r.error ? `<div class="bad">错误：${esc(r.error)}</div>` : "") +
      (r.debug && !top && !r.blocked ? `<div class="t">页面诊断：表格行 ${r.debug.rows}，正文 ${r.debug.len} 字</div>` : "");
    list.appendChild(div);
  });
}

function start() {
  const titles = ($("titles").value || "").split(/\r?\n/).map((s) => s.trim()).filter((s) => s.length >= 4);
  if (!titles.length) { setStatus("先粘题名进来，一条一行"); return; }
  $("start").disabled = true;
  $("stop").disabled = false;
  setStatus(`开始检索 ${titles.length} 条…`);
  chrome.runtime.sendMessage({ type: "START", titles, source: $("source").value, foreground: $("fg").checked, threshold: Number($("thr").value) || 20 });
}

$("start").onclick = start;
$("stop").onclick = () => { chrome.runtime.sendMessage({ type: "STOP" }); setStatus("已请求停止"); };
$("cont").onclick = () => { chrome.runtime.sendMessage({ type: "CONTINUE" }); setStatus("继续检索…"); };
$("clear").onclick = () => { chrome.runtime.sendMessage({ type: "CLEAR" }); setStatus("已清空"); };
$("home").onclick = () => { chrome.runtime.sendMessage({ type: "OPEN_HOME" }); };
$("check").onclick = () => {
  setStatus("正在打开知网检测登录状态…");
  chrome.runtime.sendMessage({ type: "CHECK_LOGIN" }, (res) => {
    if (!res || !res.ok) { setStatus("检测失败，手动看一眼知网吧"); return; }
    const lc = res.loginCheck || {};
    setStatus(lc.loggedIn ? "看起来已登录（页面上有“退出/我的知网”）" : `看起来还没登录（正文 ${lc.len || 0} 字）`);
  });
};
$("export").onclick = () => {
  const st = lastState;
  if (!st || !st.results) return;
  const rows = [["题名", "判定", "是否被拦", "命中条数", "首条题名", "出处", "年份", "链接"]];
  st.results.forEach((r) => {
    const t = r.top || {};
    rows.push([r.query, r.verdict || "", r.blocked ? "是" : "否", r.hits, t.title || "", t.source || "", t.date || "", t.url || ""]);
  });
  const csv = rows.map((row) => row.map((v) => '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"').join(",")).join("\r\n");
  const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "知网检索结果.csv";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
};

function pull() {
  chrome.runtime.sendMessage({ type: "GET_STATE" }, (res) => {
    if (!res || !res.state) return;
    const st = res.state;
    render(st);
    if (st.running) {
      $("start").disabled = true; $("stop").disabled = false;
      setStatus(`进行中 ${Math.min(st.index + 1, st.total)}/${st.total}`);
    } else {
      $("start").disabled = false; $("stop").disabled = true;
      if (st.blockedAt != null) setStatus(`第 ${st.blockedAt + 1} 条被验证挡住：去滑一下，回来点「继续」`);
      else if (st.interrupted) setStatus(`上次被打断（第 ${st.index + 1} 条），点「继续」接着跑`);
      else setStatus(st.total ? `完成 ${st.results.length}/${st.total}` : "就绪");
    }
  });
}
pull();
setInterval(pull, 1000);
