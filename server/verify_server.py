#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
AI 文献核验器（最小可用原型）
纯标准库，无需安装任何依赖。

用法：
    python verify_server.py
    然后浏览器打开 http://127.0.0.1:8799

功能：把 AI 生成的一段参考文献粘进去，逐条核验：
  - 有 DOI 的：直接查 Crossref，判断 DOI 是否真实存在
  - 没 DOI 的：拿条目文字做 Crossref 书目检索，给出匹配度
输出：每条的真伪判定 + 匹配度 + 统计（虚构率 / DOI 可解析率），可导出 CSV。
"""
import csv
import difflib
import io
import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

UA = "ai-ref-checker/0.1 (mailto:student@example.com)"
CROSSREF = "https://api.crossref.org/works"
PORT = 8799

DOI_RE = re.compile(r"10\.\d{4,9}/[^\s,;\"'）)】\]]+", re.I)
ENTRY_START = re.compile(r"^\s*(?:\[?\d{1,3}[\]\.、)）]|\[\d+\])")


def http_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.load(resp)


def lookup_doi(doi):
    try:
        msg = http_json(f"{CROSSREF}/{urllib.parse.quote(doi, safe='')}")["message"]
        return {
            "found": True,
            "title": (msg.get("title") or [""])[0],
            "container": (msg.get("container-title") or [""])[0],
            "year": (msg.get("issued", {}).get("date-parts") or [[None]])[0][0],
        }
    except urllib.error.HTTPError as e:
        return {"found": False, "error": f"HTTP {e.code}"}
    except Exception as e:  # noqa: BLE001
        return {"found": False, "error": type(e).__name__}


def search_biblio(text):
    query = urllib.parse.urlencode({"query.bibliographic": text[:300], "rows": 1})
    try:
        items = http_json(f"{CROSSREF}?{query}")["message"]["items"]
        if not items:
            return {"found": False, "score": 0.0}
        it = items[0]
        return {
            "found": True,
            "title": (it.get("title") or [""])[0],
            "container": (it.get("container-title") or [""])[0],
            "year": (it.get("issued", {}).get("date-parts") or [[None]])[0][0],
            "score": float(it.get("score") or 0),
        }
    except Exception as e:  # noqa: BLE001
        return {"found": False, "error": type(e).__name__}


def split_entries(text):
    lines = [ln.rstrip() for ln in text.splitlines()]
    entries, buf = [], []
    for ln in lines:
        if not ln.strip():
            if buf:
                entries.append(" ".join(buf).strip())
                buf = []
            continue
        if ENTRY_START.match(ln) and buf:
            entries.append(" ".join(buf).strip())
            buf = [ln]
        else:
            buf.append(ln)
    if buf:
        entries.append(" ".join(buf).strip())
    return [e for e in entries if len(e) > 12]


def title_similarity(entry, hit_title):
    """条目文字与命中标题的相似度（0~1），先做小写和标点归一。"""
    def norm(s):
        s = (s or "").lower()
        s = re.sub(r"[^0-9a-z\u4e00-\u9fff]+", " ", s)
        return re.sub(r"\s+", " ", s).strip()

    a, b = norm(entry), norm(hit_title)
    if not a or not b:
        return 0.0
    matcher = difflib.SequenceMatcher(None, a, b)
    if matcher.real_quick_ratio() < 0.3:
        return matcher.real_quick_ratio()
    longest = matcher.find_longest_match(0, len(a), 0, len(b)).size
    coverage = longest / len(b)
    ratio = matcher.ratio()
    return max(ratio, coverage * 0.9)


def classify(entry):
    doi_match = DOI_RE.search(entry)
    if doi_match:
        doi = doi_match.group(0).rstrip(".")
        res = lookup_doi(doi)
        if res.get("found"):
            return {
                "kind": "doi", "doi": doi, "verdict": "属实（DOI 可解析）",
                "match": 100.0, "detail": res,
            }
        return {
            "kind": "doi", "doi": doi, "verdict": "虚构（DOI 无效）",
            "match": 0.0, "detail": res,
        }
    res = search_biblio(entry)
    score = round(res.get("score", 0.0), 1)
    hit_title = res.get("title") or ""
    similarity = round(title_similarity(entry, hit_title) * 100, 1) if hit_title else 0.0
    zh = cjk_ratio(entry)
    if not res.get("found"):
        verdict = "查无（检索无结果）"
    elif zh > 0.3 and similarity < 55:
        verdict = "中文条目（Crossref 覆盖有限，需知网核验）"
    elif similarity >= 55:
        verdict = "疑似属实（标题高度相似）"
    elif similarity >= 35:
        verdict = "存疑（标题部分相似，需人工判断）"
    else:
        verdict = "疑似虚构（标题对不上）"
    return {"kind": "zh" if zh > 0.3 else "text", "doi": "", "verdict": verdict, "match": similarity,
            "detail": {**res, "similarity": similarity, "crossref_score": score}}


def cjk_ratio(text):
    cjk = len(re.findall(r"[\u4e00-\u9fff]", text))
    word = len(re.findall(r"[0-9A-Za-z]", text))
    if not cjk:
        return 0.0
    return cjk / (cjk + word + 1e-9)


def verify_text(text):
    entries = split_entries(text)
    rows = []
    for i, entry in enumerate(entries, 1):
        r = classify(entry)
        rows.append({"index": i, "entry": entry[:400], **r})
    total = len(rows)
    fake = sum(1 for r in rows if "虚构" in r["verdict"] or "查无" in r["verdict"])
    zh_rows = [r for r in rows if r["kind"] == "zh"]
    doi_rows = [r for r in rows if r["kind"] == "doi"]
    doi_ok = sum(1 for r in doi_rows if r["match"] == 100.0)
    summary = {
        "total": total,
        "fake": fake,
        "zh": len(zh_rows),
        "fake_rate": round(fake / total * 100, 1) if total else 0.0,
        "doi_count": len(doi_rows),
        "doi_ok": doi_ok,
        "doi_rate": round(doi_ok / len(doi_rows) * 100, 1) if doi_rows else 0.0,
    }
    return {"rows": rows, "summary": summary}


PAGE = r"""<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<title>AI 文献核验器</title>
<style>
  body{font-family:-apple-system,"Microsoft YaHei",sans-serif;max-width:980px;margin:32px auto;padding:0 16px;color:#222}
  h1{font-size:20px;margin:0 0 4px}
  .sub{color:#666;font-size:13px;margin-bottom:16px}
  textarea{width:100%;height:200px;padding:10px;font-family:Consolas,monospace;font-size:13px;border:1px solid #ccc;border-radius:8px}
  button{margin-top:10px;padding:8px 18px;border:0;border-radius:8px;background:#2563eb;color:#fff;font-size:14px;cursor:pointer}
  button:disabled{opacity:.5;cursor:default}
  table{width:100%;border-collapse:collapse;margin-top:18px;font-size:13px}
  th,td{border-bottom:1px solid #eee;padding:8px 6px;vertical-align:top;text-align:left}
  th{background:#f7f9fc}
  .ok{color:#15803d}.bad{color:#b91c1c}.warn{color:#b45309}
  .stat{margin-top:16px;padding:12px 14px;background:#f7f9fc;border-radius:8px;font-size:14px}
  .stat b{font-size:18px}
</style>
<h1>AI 文献核验器</h1>
<div class="sub">把 AI 生成的一段参考文献粘进来，逐条核验真伪（有 DOI 查 DOI，没 DOI 走书目检索）。</div>
<textarea id="t" placeholder="[1] Zhang, Y. et al. Stability of perovskite solar cells. Nature Energy, 2023. DOI: 10.1038/s41560-023-01234-5
[2] ...
"></textarea>
<div><button id="b" onclick="run()">开始核验</button></div>
<div id="out"></div>
<script>
async function run(){
  const b=document.getElementById('b'), out=document.getElementById('out');
  b.disabled=true; b.textContent='核验中…'; out.innerHTML='';
  try{
    const r=await fetch('/api/check',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:document.getElementById('t').value})});
    const d=await r.json();
    if(d.error){out.innerHTML='<p class="bad">'+d.error+'</p>';return}
    const s=d.summary;
    let html='<div class="stat">共 <b>'+s.total+'</b> 条 ｜ 疑似虚构 <b class="bad">'+s.fake+'</b> 条（'+s.fake_rate+'%）｜ 含 DOI '+s.doi_count+' 条，可解析 <b class="ok">'+s.doi_ok+'</b> 条（'+s.doi_rate+'%）</div>';
    html+='<table><tr><th>#</th><th>原文</th><th>判定</th><th>匹配度</th><th>Crossref 命中</th></tr>';
    for(const r of d.rows){
      const cls = /虚构|查无/.test(r.verdict)?'bad':(/存疑/.test(r.verdict)?'warn':'ok');
      const hit = r.detail && r.detail.found ? (r.detail.title||'')+(r.detail.year?(' · '+r.detail.year):'') : (r.detail&&r.detail.error?'错误：'+r.detail.error:'—');
      html+='<tr><td>'+r.index+'</td><td>'+esc(r.entry)+'</td><td class="'+cls+'">'+r.verdict+'</td><td>'+r.match+'</td><td>'+esc(hit)+'</td></tr>';
    }
    html+='</table><div style="margin-top:12px"><a href="/api/csv?cache=1">导出 CSV</a> ｜ <a href="/report" target="_blank">生成核验报告</a></div>';
    out.innerHTML=html;
  }catch(e){out.innerHTML='<p class="bad">请求失败：'+e+'</p>'}
  finally{b.disabled=false; b.textContent='开始核验'}
}
function esc(s){return (s||'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}
</script>
</html>
"""

LAST = {"rows": [], "summary": {}}


def render_report():
    """把最近一次核验结果渲染成一页可打印的 HTML 报告。"""
    import datetime
    import html as htmllib

    rows = LAST.get("rows") or []
    s = LAST.get("summary") or {}
    if not rows:
        return "<html><meta charset='utf-8'><body style='font-family:sans-serif;padding:40px'>" \
               "<p>还没有核验结果，先回去跑一次。</p></body></html>"

    tr = []
    for r in rows:
        d = r.get("detail") or {}
        cls = "#b91c1c" if ("虚构" in r["verdict"] or "查无" in r["verdict"]) else (
            "#b45309" if "存疑" in r["verdict"] else "#15803d")
        hit = d.get("title") or ""
        if d.get("year"):
            hit = f"{hit}（{d['year']}）"
        if not hit:
            hit = d.get("error") or "—"
        tr.append(
            "<tr>"
            f"<td>{r['index']}</td>"
            f"<td>{htmllib.escape(r['entry'])}</td>"
            f"<td style='color:{cls};white-space:nowrap'>{htmllib.escape(r['verdict'])}</td>"
            f"<td style='text-align:right'>{r['match']}</td>"
            f"<td>{htmllib.escape(hit)}</td>"
            "</tr>"
        )

    now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
    return f"""<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<title>AI 文献核验报告</title>
<style>
 body{{font-family:-apple-system,"Microsoft YaHei",sans-serif;max-width:1000px;margin:36px auto;padding:0 18px;color:#222;line-height:1.6}}
 h1{{font-size:22px;margin:0 0 6px}} .meta{{color:#777;font-size:13px;margin-bottom:22px}}
 .cards{{display:flex;gap:14px;margin:18px 0}}
 .card{{flex:1;border:1px solid #e5e7eb;border-radius:10px;padding:12px 14px}}
 .card b{{display:block;font-size:26px;margin-top:4px}}
 table{{width:100%;border-collapse:collapse;font-size:13px;margin-top:10px}}
 th,td{{border-bottom:1px solid #eee;padding:8px 6px;vertical-align:top;text-align:left}}
 th{{background:#f7f9fc}}
 .note{{margin-top:20px;font-size:12px;color:#666;border-top:1px dashed #ddd;padding-top:10px}}
 @media print{{body{{margin:0}} a{{color:inherit;text-decoration:none}}}}
</style>
<h1>AI 生成参考文献 · 核验报告</h1>
<div class="meta">生成时间：{now} ｜ 工具：AI 文献核验器 v0.1 ｜ 核验源：Crossref</div>
<div class="cards">
  <div class="card">文献条数<b>{s.get('total', 0)}</b></div>
  <div class="card">疑似虚构<b style="color:#b91c1c">{s.get('fake', 0)}</b>占 {s.get('fake_rate', 0)}%</div>
  <div class="card">含 DOI 条目<b>{s.get('doi_count', 0)}</b></div>
  <div class="card">DOI 可解析<b style="color:#15803d">{s.get('doi_ok', 0)}</b>占 {s.get('doi_rate', 0)}%</div>
</div>
<table>
<tr><th>#</th><th>条目原文</th><th>判定</th><th>匹配度</th><th>Crossref 命中</th></tr>
{''.join(tr)}
</table>
<div class="note">
判定口径：DOI 可解析记为属实；无 DOI 时按标题相似度，≥55% 疑似属实、35%~55% 存疑需人工复核、&lt;35% 疑似虚构。<br>
Crossref 对任何查询都会返回最相近的一条，因此“存疑”条目必须由人工判断后再下结论——这正是人机协同环节。<br>
中文文献多数无 DOI，Crossref 覆盖有限，需配合知网等中文库人工检索。
</div>
</html>"""



class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body, content_type="application/json; charset=utf-8"):
        data = body if isinstance(body, bytes) else body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path in ("/", "/index.html"):
            # 依次找：同目录的网页版-单文件.html / ../web/index.html / ./index.html
            import os
            here = os.path.dirname(os.path.abspath(__file__))
            candidates = [
                os.path.join(here, "网页版-单文件.html"),
                os.path.join(here, "..", "web", "index.html"),
                os.path.join(here, "web", "index.html"),
                os.path.join(here, "..", "litcheck-web", "index.html"),
                os.path.join(here, "index.html"),
            ]
            for page_path in candidates:
                if os.path.exists(page_path):
                    try:
                        with open(page_path, "r", encoding="utf-8") as f:
                            self._send(200, f.read(), "text/html; charset=utf-8")
                        return
                    except Exception:
                        pass
            self._send(200, PAGE, "text/html; charset=utf-8")
        elif self.path.startswith("/report"):
            self._send(200, render_report(), "text/html; charset=utf-8")
        elif self.path.startswith("/api/csv"):
            buf = io.StringIO()
            w = csv.writer(buf)
            w.writerow(["序号", "原文", "判定", "匹配度", "DOI", "命中标题", "命中年份"])
            for r in LAST["rows"]:
                d = r.get("detail") or {}
                w.writerow([r["index"], r["entry"], r["verdict"], r["match"], r.get("doi", ""),
                            d.get("title", ""), d.get("year", "")])
            self._send(200, ("\ufeff" + buf.getvalue()).encode("utf-8"), "text/csv; charset=utf-8")
        else:
            self._send(404, json.dumps({"error": "not found"}))

    def do_POST(self):
        if self.path != "/api/check":
            self._send(404, json.dumps({"error": "not found"}))
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            text = (payload.get("text") or "").strip()
            if len(text) < 10:
                self._send(400, json.dumps({"error": "内容太短，粘一段参考文献进来"}, ensure_ascii=False))
                return
            result = verify_text(text)
            LAST["rows"] = result["rows"]
            LAST["summary"] = result["summary"]
            self._send(200, json.dumps(result, ensure_ascii=False))
        except Exception as e:  # noqa: BLE001
            self._send(500, json.dumps({"error": f"{type(e).__name__}: {e}"}, ensure_ascii=False))

    def log_message(self, fmt, *args):
        # pythonw 下 sys.stderr 可能是 None，直接写会抛异常、把连接掐断
        try:
            if sys.stderr:
                sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))
        except Exception:
            pass


def main():
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"AI 文献核验器已启动：http://127.0.0.1:{PORT}")
    print("按 Ctrl+C 停止。")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")


if __name__ == "__main__":
    main()
