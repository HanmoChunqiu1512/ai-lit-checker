// content.js —— 跑在知网 / 万方页面上，判断状态并把结果读出来
(() => {
  const isCNKI = location.hostname.includes("cnki.net");
  const isWF = location.hostname.includes("wanfangdata.com.cn");

  const textOf = (el) => (el && el.innerText ? el.innerText : "").replace(/\s+/g, " ").trim();

  // 只有整页就是验证、或验证框真的显示出来，才算被挡
  function captchaBlocked() {
    const body = document.body ? document.body.innerText : "";
    const rows = document.querySelectorAll(".result-table-list tbody tr, #gridTable tbody tr, .list-item").length;
    if (rows > 0) return false;
    const box = document.querySelector(".nc-container, .nc_wrapper, .geetest_panel, #captcha, .verifybox, iframe[src*='captcha'], .verify-wrap");
    if (box && (box.offsetWidth > 0 || box.offsetHeight > 0)) return true;
    return /请完成安全验证|拖动滑块|滑动验证/.test(body) && body.length < 1500;
  }

  function parseCNKI() {
    const out = [];
    document.querySelectorAll(".result-table-list tbody tr, #gridTable tbody tr, .list-item").forEach((tr) => {
      const link = tr.querySelector("td.name a, .name a, a.fz14");
      const title = textOf(link) || textOf(tr.querySelector("td.name, .name"));
      if (!title || title.length < 4) return;
      out.push({
        title,
        author: textOf(tr.querySelector("td.author, .author")),
        source: textOf(tr.querySelector("td.source, .source")),
        date: textOf(tr.querySelector("td.date, .date")),
        url: link && link.href ? link.href : ""
      });
    });
    const m = (document.body.innerText || "").match(/(?:找到|共)\s*([\d,]+)\s*条/);
    return { hits: m ? Number(m[1].replace(/,/g, "")) : out.length, rows: out };
  }

  function parseWF() {
    const out = [];
    document.querySelectorAll(".normal-list .title, .wf-list .title, .list-item").forEach((el) => {
      const a = el.tagName === "A" ? el : el.querySelector("a");
      const title = textOf(a || el);
      if (title && title.length >= 4) out.push({ title, url: a && a.href ? a.href : "" });
    });
    const m = (document.body.innerText || "").match(/(?:共|找到)\s*([\d,]+)\s*条/);
    return { hits: m ? Number(m[1].replace(/,/g, "")) : out.length, rows: out };
  }

  function collect() {
    const blocked = captchaBlocked();
    if (blocked) return { blocked: true, hits: 0, rows: [], url: location.href };
    const data = isCNKI ? parseCNKI() : (isWF ? parseWF() : { hits: 0, rows: [] });
    return { blocked: false, host: location.hostname, url: location.href, ...data };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === "COLLECT") { sendResponse(collect()); return true; }
    if (msg && msg.type === "PING") { sendResponse({ ok: true, host: location.hostname }); return true; }
  });

  if (document.readyState === "complete" || document.readyState === "interactive") {
    setTimeout(() => {
      try { chrome.runtime.sendMessage({ type: "PAGE_READY", data: collect() }).catch(() => {}); } catch (e) {}
    }, 1200);
  }
})();
