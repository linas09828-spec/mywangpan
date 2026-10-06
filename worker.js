/**
 * R2 网盘 - Cloudflare Workers 单文件版
 *
 * 部署前准备（Cloudflare Dashboard）：
 * 1. R2 对象存储 → 创建存储桶（例如 mypan）
 * 2. Workers 和 Pages → 创建 Worker → 把本文件全部粘贴进去 → 部署
 * 3. Worker 设置 → 绑定 → 添加 R2 存储桶绑定，变量名填 BUCKET，选你的存储桶
 * 4. Worker 设置 → 变量和机密 → 添加机密 PASSWORD，值设为你的登录密码
 * 5. Worker 设置 → 域和路由 → 添加自定义域（你的域名，如 pan.example.com）
 * 6. 打开域名，输入密码登录，开始用
 *
 * 功能：密码登录 / 文件夹浏览 / 多文件上传 / 下载 / 删除 / 新建文件夹 / 限时分享链接
 */

const COOKIE_NAME = "pan_auth";

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function authToken(env) {
  return sha256Hex("pan|" + (env.PASSWORD || ""));
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function checkAuth(request, env) {
  const pw = env.PASSWORD || "";
  if (!pw) return false;
  const cookie = request.headers.get("Cookie") || "";
  const m = cookie.match(new RegExp("(?:^|;\\s*)" + COOKIE_NAME + "=([a-f0-9]{64})"));
  if (!m) return false;
  return safeEqual(m[1], await authToken(env));
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

const LOGIN_HTML = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>登录 - 我的网盘</title>
<style>
body{background:#0f1420;color:#e8ecf4;font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.card{background:#182032;padding:32px 36px;border-radius:14px;box-shadow:0 8px 30px rgba(0,0,0,.4);width:300px;text-align:center}
h2{margin:0 0 20px}input{width:100%;box-sizing:border-box;padding:10px 12px;border-radius:8px;border:1px solid #2c3a55;background:#0f1420;color:#fff;margin-bottom:14px;font-size:15px}
button{width:100%;padding:10px;border:0;border-radius:8px;background:#3b82f6;color:#fff;font-size:15px;cursor:pointer}
button:hover{background:#2f6fe0}#msg{color:#f87171;min-height:20px;font-size:13px;margin-top:10px}
</style></head><body>
<div class="card"><h2>🗂️ 我的网盘</h2>
<input id="pw" type="password" placeholder="输入访问密码" autocomplete="current-password">
<button onclick="login()">进入</button><div id="msg"></div></div>
<script>
async function login(){
  var pw=document.getElementById("pw").value;
  var r=await fetch("/api/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({password:pw})});
  if(r.ok){location.href="/";}else{document.getElementById("msg").textContent="密码错误";}
}
document.getElementById("pw").addEventListener("keydown",function(e){if(e.key==="Enter")login();});
</script></body></html>`;

const APP_HTML = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>我的网盘</title>
<style>
*{box-sizing:border-box}body{background:#0f1420;color:#e8ecf4;font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;margin:0;padding:0}
header{display:flex;align-items:center;gap:10px;padding:14px 20px;background:#141c2e;border-bottom:1px solid #22304d;position:sticky;top:0;z-index:10;flex-wrap:wrap}
header h1{font-size:18px;margin:0 10px 0 0}
button{background:#243252;color:#e8ecf4;border:1px solid #2c3a55;border-radius:8px;padding:8px 14px;cursor:pointer;font-size:14px}
button:hover{background:#2f4066}button.primary{background:#3b82f6;border-color:#3b82f6;color:#fff}
button.primary:hover{background:#2f6fe0}button.danger{color:#f87171}
#crumb{padding:12px 20px;color:#9fb0cc;font-size:14px}#crumb a{color:#7db4ff;text-decoration:none}#crumb a:hover{text-decoration:underline}
#list{padding:0 20px 40px;max-width:1000px}
.row{display:flex;align-items:center;gap:12px;padding:10px 12px;border-bottom:1px solid #1b2540;border-radius:8px}
.row:hover{background:#16203a}.row .name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.row .meta{color:#8a99b8;font-size:12px;white-space:nowrap}.row .acts{display:flex;gap:6px}.row .acts button{padding:5px 10px;font-size:12px}
#status{padding:10px 20px;color:#8a99b8;font-size:13px;min-height:36px}
#drop{margin:0 20px 30px;max-width:960px;border:2px dashed #2c3a55;border-radius:12px;padding:30px;text-align:center;color:#8a99b8}
#drop.over{border-color:#3b82f6;color:#7db4ff;background:#14203a}
.empty{padding:40px;text-align:center;color:#5b6b8c}
</style></head><body>
<header><h1>🗂️ 我的网盘</h1>
<button class="primary" onclick="document.getElementById('file').click()">⬆️ 上传文件</button>
<input id="file" type="file" multiple style="display:none">
<button onclick="mkdir()">📁 新建文件夹</button>
<button onclick="logout()" style="margin-left:auto">退出</button>
</header>
<div id="crumb"></div><div id="status"></div>
<div id="drop">把文件拖到这里上传（或点左上角上传按钮）</div>
<div id="list"></div>
<script>
var prefix="";
function esc(s){return String(s).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];});}
function fmtSize(b){if(b<1024)return b+" B";if(b<1048576)return (b/1024).toFixed(1)+" KB";if(b<1073741824)return (b/1048576).toFixed(1)+" MB";return (b/1073741824).toFixed(2)+" GB";}
function fmtDate(s){try{return new Date(s).toLocaleString();}catch(e){return "";}}
function setStatus(t){document.getElementById("status").textContent=t;}
async function api(path,opts){
  var r=await fetch(path,opts);
  if(r.status===401){location.reload();throw new Error("unauth");}
  var d=await r.json().catch(function(){return {};});
  if(!r.ok) throw new Error(d.msg||("HTTP "+r.status));
  return d;
}
async function refresh(){
  var d=await api("/api/list?prefix="+encodeURIComponent(prefix));
  var parts=prefix.split("/").filter(Boolean),acc="",bc='<a href="#" data-p="">🏠 根目录</a>';
  parts.forEach(function(p){acc+=p+"/";bc+=' / <a href="#" data-p="'+esc(acc)+'">'+esc(p)+"</a>";});
  var crumb=document.getElementById("crumb");crumb.innerHTML=bc;
  crumb.querySelectorAll("a").forEach(function(a){a.onclick=function(e){e.preventDefault();prefix=a.getAttribute("data-p");refresh();};});
  var h="";
  d.folders.forEach(function(f){
    h+='<div class="row"><span class="name">📁 '+esc(f)+'</span><span class="meta"></span><span class="acts"><button data-act="enter" data-key="'+esc(prefix+f+"/")+'">进入</button></span></div>';
  });
  d.files.forEach(function(f){
    h+='<div class="row"><span class="name">📄 '+esc(f.name)+'</span><span class="meta">'+fmtSize(f.size)+" · "+fmtDate(f.uploaded)+'</span><span class="acts">'
      +'<button data-act="dl" data-key="'+esc(f.key)+'">下载</button>'
      +'<button data-act="share" data-key="'+esc(f.key)+'" data-name="'+esc(f.name)+'">分享</button>'
      +'<button class="danger" data-act="del" data-key="'+esc(f.key)+'" data-name="'+esc(f.name)+'">删除</button></span></div>';
  });
  if(!h) h='<div class="empty">空空如也，上传点文件吧 📤</div>';
  document.getElementById("list").innerHTML=h;
  setStatus("");
}
document.getElementById("list").addEventListener("click",async function(e){
  var b=e.target.closest("button");if(!b)return;
  var act=b.getAttribute("data-act"),key=b.getAttribute("data-key"),name=b.getAttribute("data-name")||"";
  try{
    if(act==="enter"){prefix=key;refresh();}
    else if(act==="dl"){location.href="/api/download?key="+encodeURIComponent(key);}
    else if(act==="del"){if(confirm("确定删除「"+name+"」？")){await api("/api/delete",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({key:key})});refresh();}}
    else if(act==="share"){
      var hours=prompt("分享链接有效期（小时，最长 720）：","24");if(!hours)return;
      var d=await api("/api/share?key="+encodeURIComponent(key)+"&hours="+encodeURIComponent(hours));
      if(navigator.clipboard){await navigator.clipboard.writeText(d.url);alert("分享链接已复制到剪贴板，有效期至 "+new Date(d.exp*1000).toLocaleString());}
      else{prompt("复制分享链接：",d.url);}
    }
  }catch(err){setStatus("操作失败："+err.message);}
});
async function uploadFiles(files){
  if(!files||!files.length)return;
  var fd=new FormData();for(var i=0;i<files.length;i++)fd.append("files",files[i]);
  setStatus("上传中…（"+files.length+" 个文件）");
  try{
    var r=await fetch("/api/upload?prefix="+encodeURIComponent(prefix),{method:"POST",body:fd});
    var d=await r.json();
    if(!r.ok)throw new Error(d.msg||("HTTP "+r.status));
    setStatus("✅ 上传完成 "+d.count+" 个文件");refresh();
  }catch(e){setStatus("❌ 上传失败："+e.message+"（大文件可能超出免费版限制，建议 100MB 以内）");}
}
document.getElementById("file").addEventListener("change",function(e){uploadFiles(e.target.files);e.target.value="";});
var drop=document.getElementById("drop");
["dragenter","dragover"].forEach(function(ev){drop.addEventListener(ev,function(e){e.preventDefault();drop.classList.add("over");});});
["dragleave","drop"].forEach(function(ev){drop.addEventListener(ev,function(e){e.preventDefault();drop.classList.remove("over");});});
drop.addEventListener("drop",function(e){uploadFiles(e.dataTransfer.files);});
async function mkdir(){
  var name=prompt("新文件夹名称：");if(!name)return;name=name.trim();
  if(!name||name.indexOf("/")>=0){alert("名称不能包含 /");return;}
  try{await api("/api/mkdir",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({prefix:prefix,name:name})});refresh();}
  catch(e){setStatus("创建失败："+e.message);}
}
async function logout(){await fetch("/api/logout",{method:"POST"});location.href="/";}
refresh();
</script></body></html>`;

async function handleApi(request, env, url) {
  const path = url.pathname;

  if (path === "/api/login" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    if (env.PASSWORD && body.password === env.PASSWORD) {
      const res = json({ ok: true });
      res.headers.set(
        "Set-Cookie",
        COOKIE_NAME + "=" + (await authToken(env)) +
          "; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000; Secure"
      );
      return res;
    }
    return json({ ok: false, msg: "密码错误" }, 401);
  }

  if (path === "/api/list") {
    const prefix = url.searchParams.get("prefix") || "";
    const listed = await env.BUCKET.list({ prefix, delimiter: "/" });
    const folders = (listed.delimitedPrefixes || []).map((p) =>
      p.slice(prefix.length).replace(/\/$/, "")
    );
    const files = (listed.objects || [])
      .filter((o) => o.key !== prefix)
      .map((o) => ({
        key: o.key,
        name: o.key.slice(prefix.length),
        size: o.size,
        uploaded: o.uploaded,
      }));
    return json({ folders, files, truncated: listed.truncated });
  }

  if (path === "/api/upload" && request.method === "POST") {
    const prefix = url.searchParams.get("prefix") || "";
    const form = await request.formData();
    const files = form.getAll("files");
    let count = 0;
    for (const f of files) {
      if (typeof f === "string" || !f.name) continue;
      await env.BUCKET.put(prefix + f.name, f.stream(), {
        httpMetadata: { contentType: f.type || "application/octet-stream" },
      });
      count++;
    }
    return json({ ok: true, count });
  }

  if (path === "/api/download") {
    const key = url.searchParams.get("key") || "";
    if (!key) return new Response("Bad request", { status: 400 });
    const obj = await env.BUCKET.get(key);
    if (!obj) return new Response("Not found", { status: 404 });
    const headers = new Headers();
    obj.writeHttpMetadata(headers);
    headers.set(
      "Content-Disposition",
      "attachment; filename*=UTF-8''" + encodeURIComponent(key.split("/").pop())
    );
    return new Response(obj.body, { headers });
  }

  if (path === "/api/delete" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    if (!body.key) return json({ ok: false, msg: "缺少 key" }, 400);
    await env.BUCKET.delete(body.key);
    return json({ ok: true });
  }

  if (path === "/api/mkdir" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    const name = (body.name || "").trim();
    const prefix = body.prefix || "";
    if (!name || name.includes("/")) return json({ ok: false, msg: "名称不合法" }, 400);
    await env.BUCKET.put(prefix + name + "/", new Uint8Array(0));
    return json({ ok: true });
  }

  if (path === "/api/share") {
    const key = url.searchParams.get("key") || "";
    if (!key) return json({ ok: false, msg: "缺少 key" }, 400);
    const hours = Math.min(Math.max(parseFloat(url.searchParams.get("hours") || "24"), 1), 720);
    const exp = Math.floor(Date.now() / 1000) + Math.floor(hours * 3600);
    const sig = await sha256Hex(key + "|" + exp + "|" + env.PASSWORD);
    const enc = key.split("/").map(encodeURIComponent).join("/");
    return json({ url: url.origin + "/s/" + enc + "?exp=" + exp + "&sig=" + sig, exp });
  }

  return new Response("Not found", { status: 404 });
}

async function handleShare(request, env, url) {
  const key = decodeURIComponent(url.pathname.slice(3));
  const exp = url.searchParams.get("exp") || "";
  const sig = url.searchParams.get("sig") || "";
  const expect = await sha256Hex(key + "|" + exp + "|" + env.PASSWORD);
  if (!safeEqual(sig, expect)) return new Response("分享链接无效", { status: 403 });
  if (Date.now() / 1000 > parseFloat(exp)) return new Response("分享链接已过期", { status: 403 });
  const obj = await env.BUCKET.get(key);
  if (!obj) return new Response("文件不存在", { status: 404 });
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set(
    "Content-Disposition",
    "attachment; filename*=UTF-8''" + encodeURIComponent(key.split("/").pop())
  );
  return new Response(obj.body, { headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/login") {
      const authed = await checkAuth(request, env);
      return new Response(authed ? APP_HTML : LOGIN_HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    if (url.pathname === "/api/logout" && request.method === "POST") {
      const res = json({ ok: true });
      res.headers.set("Set-Cookie", COOKIE_NAME + "=; Path=/; Max-Age=0");
      return res;
    }

    if (url.pathname.startsWith("/api/")) {
      // 登录接口本身不需要鉴权，其余接口需要
      if (url.pathname !== "/api/login" && !(await checkAuth(request, env)))
        return json({ ok: false, msg: "未登录" }, 401);
      return handleApi(request, env, url);
    }

    if (url.pathname.startsWith("/s/")) {
      return handleShare(request, env, url);
    }

    return new Response("Not found", { status: 404 });
  },
};
