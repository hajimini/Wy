/**
 * Worker API (适配前端 index.html)
 * - 会话过期 10 分钟（SESSION_EXPIRE_MINUTES）
 * - 动态 CORS（回显 Origin）
 * - 接口：
 *   POST /api/auth/login  { password } -> { sessionId, expiresAt }
 *   GET  /api/auth/check  (X-Session-Id)
 *   POST /api/auth/logout (X-Session-Id)
 *   GET  /api/articles
 *   POST /api/articles
 *   PUT  /api/articles/:id
 *   DELETE /api/articles/:id
 *   POST /api/upload  (multipart/form-data) -> 上传到 GitHub（若配置）或返回 501
 *
 * Environment variables recommended:
 * - ACCESS_PASSWORD (string)
 * - GITHUB_TOKEN (optional, for upload)
 * - GITHUB_REPO  (optional, 'owner/repo')
 */

const SESSION_EXPIRE_MINUTES = 10;
const FALLBACK_PASSWORD = '741520'; // 仅本地 / 测试时回退

// 当未绑定 D1 时，退回到进程内存存储会话（实例重启会丢失）
const memorySessions = new Map();
let schemaReady = false;

function unixNowSec(){ return Math.floor(Date.now()/1000); }

function makeCorsHeaders(request){
  const origin = request.headers.get('Origin') || '*';
  const headers = {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Session-Id'
  };

  if(origin !== '*') headers['Access-Control-Allow-Credentials'] = 'true';
  return headers;
}
function jsonResponse(data, request, status=200){
  const headers = { ...makeCorsHeaders(request), 'Content-Type': 'application/json;charset=UTF-8' };
  return new Response(JSON.stringify(data), { status, headers });
}
function noContentResponse(request){ return new Response(null,{ status:204, headers: makeCorsHeaders(request) }); }

function generateSessionId(){ return crypto.randomUUID(); }

function isDbAvailable(env){
  return !!(env && env.DB && typeof env.DB.prepare === 'function');
}

async function ensureSchema(env){
  if(schemaReady || !isDbAvailable(env)) return;
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      expires_at INTEGER
    );
  `).run();
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS articles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT,
      excerpt TEXT,
      raw_content TEXT,
      content TEXT,
      category TEXT,
      tag TEXT,
      tag_color TEXT,
      date TEXT,
      status TEXT,
      pinned INTEGER,
      created_at TEXT,
      updated_at TEXT
    );
  `).run();
  schemaReady = true;
}

function arrayBufferToBase64(buffer){
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for(let i=0;i<bytes.length;i+=chunkSize){
    binary += String.fromCharCode(...bytes.subarray(i, i+chunkSize));
  }
  return btoa(binary);
}

async function validateSession(request, env){
  const sid = request.headers.get('X-Session-Id');
  if(!sid) return false;
  try{
    const now = unixNowSec();
    if(isDbAvailable(env)){
      await ensureSchema(env);
      const row = await env.DB.prepare('SELECT id FROM sessions WHERE id = ? AND expires_at > ?').bind(sid, now).first();
      return !!row;
    }

    const exp = memorySessions.get(sid);
    if(!exp) return false;
    if(exp <= now){
      memorySessions.delete(sid);
      return false;
    }
    return true;
  }catch(e){
    console.error('validateSession db err', e);
    return false;
  }
}

/* Helper: upload file to GitHub repo via Contents API
   env.GITHUB_TOKEN & env.GITHUB_REPO must be set to enable.
   Returns raw.githubusercontent URL on success.
*/
async function uploadToGitHub(env, filename, arrayBuffer, contentType){
  const token = env.GITHUB_TOKEN;
  const repo = env.GITHUB_REPO;
  if(!token || !repo) throw new Error('GitHub upload not configured');
  // Put files under 'assets/' with timestamp prefix
  const key = `assets/${Date.now()}-${filename}`;
  const apiUrl = `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(key)}`;
  // Create Base64 content
  const b64 = arrayBufferToBase64(arrayBuffer);
  const body = {
    message: `upload ${key}`,
    content: b64
  };
  const res = await fetch(apiUrl, {
    method: 'PUT',
    headers: { Authorization: `token ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if(!res.ok){
    const txt = await res.text();
    throw new Error('GitHub upload failed: ' + res.status + ' ' + txt);
  }
  // raw URL: https://raw.githubusercontent.com/<owner>/<repo>/main/<key>
  // assume default branch is main (if your repo uses 'master', change accordingly)
  const ownerRepo = repo;
  const rawUrl = `https://raw.githubusercontent.com/${ownerRepo}/main/${key}`;
  return rawUrl;
}

/* ========== Worker fetch ========== */
export default {
  async fetch(request, env, ctx){
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+/g,'/');
    const method = request.method.toUpperCase();
    const ACCESS_PASSWORD = env.ACCESS_PASSWORD || FALLBACK_PASSWORD;

    // CORS preflight
    if(method === 'OPTIONS') return noContentResponse(request);

    try{
      // LOGIN
      if(path === '/api/auth/login' && method === 'POST'){
        let body;
        try{ body = await request.json(); } catch(e){ return jsonResponse({ error:'Invalid JSON' }, request, 400); }
        const pw = body.password;
        if(!pw || pw !== ACCESS_PASSWORD) return jsonResponse({ error:'密码错误' }, request, 401);
        const sid = generateSessionId();
        const expiresAt = unixNowSec() + SESSION_EXPIRE_MINUTES*60;
        if(isDbAvailable(env)){
          await ensureSchema(env);
          await env.DB.prepare('INSERT INTO sessions (id, expires_at) VALUES (?, ?)').bind(sid, expiresAt).run();
        }else{
          memorySessions.set(sid, expiresAt);
        }
        return jsonResponse({ success:true, sessionId: sid, expiresAt }, request, 200);
      }

      // CHECK
      if(path === '/api/auth/check' && method === 'GET'){
        const ok = await validateSession(request, env);
        return jsonResponse({ authenticated: ok }, request, 200);
      }

      // LOGOUT
      if(path === '/api/auth/logout' && method === 'POST'){
        const sid = request.headers.get('X-Session-Id');
        if(sid){
          if(isDbAvailable(env)){
            await ensureSchema(env);
            await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(sid).run();
          }
          memorySessions.delete(sid);
        }
        return jsonResponse({ success:true }, request, 200);
      }

      // PROTECTED BELOW
      const isAuth = await validateSession(request, env);
      if(!isAuth) return jsonResponse({ error:'请先登录' }, request, 401);

      // GET ARTICLES
      if(path === '/api/articles' && method === 'GET'){
        if(!isDbAvailable(env)) return jsonResponse({ error:'未配置数据库，请在 Worker 绑定 D1 并导入表结构。' }, request, 501);
        await ensureSchema(env);
        const rows = await env.DB.prepare(`
          SELECT id, title, excerpt, raw_content, content, category, tag, tag_color, date, status, pinned, created_at, updated_at
          FROM articles ORDER BY pinned DESC, created_at DESC
        `).all();
        const results = (rows && rows.results) ? rows.results : (rows || []);
        return jsonResponse(results, request, 200);
      }

      // CREATE ARTICLE
      if(path === '/api/articles' && method === 'POST'){
        if(!isDbAvailable(env)) return jsonResponse({ error:'未配置数据库，请在 Worker 绑定 D1 并导入表结构。' }, request, 501);
        let a;
        try{ a = await request.json(); } catch(e){ return jsonResponse({ error:'Invalid JSON' }, request, 400); }
        const raw_content = a.raw_content !== undefined ? a.raw_content : (a.rawContent || '');
        const tag_color = a.tag_color !== undefined ? a.tag_color : (a.tagColor || 'purple');
        const pinned = a.pinned ? 1 : 0;
        const nowIso = new Date().toISOString();
        const dateStr = new Date().toLocaleDateString('zh-CN', { year:'numeric', month:'long' });
        await ensureSchema(env);
        const res = await env.DB.prepare(`
          INSERT INTO articles (title, excerpt, raw_content, content, category, tag, tag_color, date, status, pinned, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          a.title || '未命名文章',
          a.excerpt || '',
          raw_content,
          a.content || '',
          a.category || 'work',
          a.tag || '前端',
          tag_color,
          dateStr,
          a.status || 'draft',
          pinned,
          nowIso, nowIso
        ).run();
        const createdId = res && res.meta ? res.meta.last_row_id : null;
        return jsonResponse({ success:true, id: createdId }, request, 201);
      }

      // UPDATE ARTICLE
      if(path.match(/^\/api\/articles\/\d+$/) && method === 'PUT'){
        if(!isDbAvailable(env)) return jsonResponse({ error:'未配置数据库，请在 Worker 绑定 D1 并导入表结构。' }, request, 501);
        const id = path.split('/').pop();
        let a;
        try{ a = await request.json(); } catch(e){ return jsonResponse({ error:'Invalid JSON' }, request, 400); }
        const raw_content = a.raw_content !== undefined ? a.raw_content : (a.rawContent || '');
        const tag_color = a.tag_color !== undefined ? a.tag_color : (a.tagColor || 'purple');
        const pinned = a.pinned ? 1 : 0;
        const nowIso = new Date().toISOString();
        await ensureSchema(env);
        await env.DB.prepare(`
          UPDATE articles SET title=?, excerpt=?, raw_content=?, content=?, category=?, tag=?, tag_color=?, status=?, pinned=?, updated_at=? WHERE id=?
        `).bind(
          a.title || '未命名文章',
          a.excerpt || '',
          raw_content,
          a.content || '',
          a.category || 'work',
          a.tag || '前端',
          tag_color,
          a.status || 'draft',
          pinned,
          nowIso,
          id
        ).run();
        return jsonResponse({ success:true }, request, 200);
      }

      // DELETE ARTICLE
      if(path.match(/^\/api\/articles\/\d+$/) && method === 'DELETE'){
        if(!isDbAvailable(env)) return jsonResponse({ error:'未配置数据库，请在 Worker 绑定 D1 并导入表结构。' }, request, 501);
        const id = path.split('/').pop();
        await ensureSchema(env);
        await env.DB.prepare('DELETE FROM articles WHERE id = ?').bind(id).run();
        return jsonResponse({ success:true }, request, 200);
      }

      // UPLOAD (multipart/form-data)
      if(path === '/api/upload' && method === 'POST'){
        // Only allow if env.GITHUB_TOKEN & GITHUB_REPO configured
        const token = env.GITHUB_TOKEN;
        const repo = env.GITHUB_REPO;
        if(!(token && repo)){
          return jsonResponse({ error:'Upload not configured on server. Please set GITHUB_TOKEN & GITHUB_REPO in Worker environment.' }, request, 501);
        }

        // parse formdata
        const form = await request.formData();
        const file = form.get('file');
        if(!file) return jsonResponse({ error:'No file' }, request, 400);
        const filename = file.name || `file-${Date.now()}`;
        const arrayBuffer = await file.arrayBuffer();
        try{
          const rawUrl = await uploadToGitHub(env, filename, arrayBuffer, file.type || 'application/octet-stream');
          return jsonResponse({ success:true, url: rawUrl }, request, 200);
        }catch(e){
          console.error('uploadToGitHub error', e);
          return jsonResponse({ error: e.message || 'Upload failed' }, request, 500);
        }
      }

      // Not found
      return jsonResponse({ error:'Not Found' }, request, 404);

    }catch(e){
      console.error('Worker catch', e);
      return jsonResponse({ error: e.message || 'Server error' }, request, 500);
    }
  }
};
