// bridge.js —— 在核验器网页（http://127.0.0.1:8799）里做桥：
// 网页 → postMessage → 这里 → background；background → 这里 → 网页
(() => {
  const post = (obj) => window.postMessage({ source: "litcheck-ext", ...obj }, "*");

  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data || e.data.source !== "litcheck-web") return;
    const d = e.data;
    if (d.type === "ext:ping") {
      post({ type: "hello", version: "0.8.1" });
      return;
    }
    if (d.type === "ext:queue") {
      const titles = (d.titles || []).filter((t) => t && t.length >= 4);
      if (!titles.length) { post({ type: "error", message: "没有可检索的条目" }); return; }
      chrome.runtime.sendMessage(
        { type: "START", titles, source: d.engine || "cnki", threshold: Number(d.threshold) || 20, foreground: !!d.foreground },
        () => post({ type: "started", total: titles.length })
      );
      return;
    }
    if (d.type === "ext:stop") {
      chrome.runtime.sendMessage({ type: "STOP" }, () => post({ type: "stopped" }));
      return;
    }
    if (d.type === "ext:state") {
      chrome.runtime.sendMessage({ type: "GET_STATE" }, (res) => {
        if (res && res.state) post({ type: "state", state: res.state });
      });
    }
  });

  // background 推过来的结果，转给网页
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === "STATE") { post({ type: "progress", state: msg.state }); return; }
    if (msg.type === "RESULT") { post({ type: "result", result: msg.result }); return; }
    if (msg.type === "DONE") { post({ type: "done", state: msg.state }); return; }
  });

  // 页面加载完主动打招呼（多喊几次，避免网页脚本先跑完没听到）
  const hello = () => {
    try { post({ type: "hello", version: "0.8.1" }); } catch (e) {}
  };
  hello();
  setTimeout(hello, 500);
  setTimeout(hello, 1500);
  setTimeout(hello, 3000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) hello(); });
})();
