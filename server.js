/**
 * Yarig.aiTheGame — Proxy server
 *
 * Serves the game and proxies Yarig.ai API calls with session management.
 * Handles PHP session cookie rotation automatically.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URLSearchParams } = require('url');
const { execFile } = require('child_process');

// yarig.ai has an incomplete SSL certificate chain
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// Load .env
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const [key, ...val] = line.split('=');
    if (key && !key.startsWith('#')) process.env[key.trim()] = val.join('=').trim();
  });
}

const PORT = parseInt(process.env.PORT || '9124');
const YARIG_EMAIL = process.env.YARIG_EMAIL || '';
const YARIG_PASSWORD = process.env.YARIG_PASSWORD || '';
const YARIG_HOST = 'yarig.ai';
const XAI_API_KEY = process.env.XAI_API_KEY || process.env.GROK_API_KEY || '';
const XAI_MODEL = process.env.XAI_MODEL || 'grok-4.20-beta-latest-non-reasoning';
const DIARIO_REPO = 'csilvasantin/18.-diario';

// ── Roster de equipo (gemelo digital) ──────────────────────
const GAME_REPO = 'csilvasantin/10.-Yarig.aiTheGame';
const MEMBERS_FILE = path.join(__dirname, 'members.json');
const ROLE_LABELS = ['cajero', 'repositor', 'azafata', 'manager', 'dj'];
const ROLE_IDS = {
  cajero: 0, cajera: 0, cashier: 0,
  repositor: 1, repositora: 1, reponedor: 1, stocker: 1,
  azafata: 2, hostess: 2,
  manager: 3, encargado: 3, 'store manager': 3,
  dj: 4,
};
function resolveRole(r) {
  if (typeof r === 'number' && r >= 0 && r <= 4) return r;
  const n = ROLE_IDS[String(r || '').trim().toLowerCase()];
  return n === undefined ? -1 : n;
}
function readMembers() {
  try { const a = JSON.parse(fs.readFileSync(MEMBERS_FILE, 'utf8')); return Array.isArray(a) ? a : []; }
  catch { return []; }
}
function writeMembers(list) {
  fs.writeFileSync(MEMBERS_FILE, JSON.stringify(list, null, 2) + '\n');
}
async function pushMembersToGitHub(list) {
  let sha = null;
  try { const r = await ghGet(`/repos/${GAME_REPO}/contents/members.json`); sha = r.sha; } catch { /* no existe aun */ }
  const body = {
    message: 'chore: roster de equipo actualizado [Yarig.ai] [skip ci]',
    content: Buffer.from(JSON.stringify(list, null, 2) + '\n').toString('base64'),
  };
  if (sha) body.sha = sha;
  try { await ghPut(`/repos/${GAME_REPO}/contents/members.json`, body); return true; }
  catch (e) { console.error('[members] push failed:', e.message); return false; }
}

// ── Philips Hue ────────────────────────────────────────────
const HUE_BRIDGE_IP = process.env.HUE_BRIDGE_IP || '';
const HUE_API_KEY = process.env.HUE_API_KEY || '';
let hueSessionOwner = ''; // tab ID of the active controller

function hueRequest(method, endpoint, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: HUE_BRIDGE_IP,
      port: 443,
      path: `/api/${HUE_API_KEY}${endpoint}`,
      method,
      rejectAuthorized: false,
      headers: { 'Content-Type': 'application/json' },
    };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
    });
    if (body) {
      const bodyStr = JSON.stringify(body);
      opts.headers['Content-Length'] = Buffer.byteLength(bodyStr);
      req.on('error', reject);
      req.write(bodyStr);
    } else {
      req.on('error', reject);
    }
    req.end();
  });
}

// ── Aforo / People-counting (cámara Hikvision vía ieu.ai) ──
// La cámara hace POST a ieu.ai, que expone la ocupación en /api/ocuppancy.
// El navegador no puede leer ieu.ai directo (sin CORS), así que el gemelo
// hace de proxy mismo-origen y de paso acumula el pico del día para el diario.
const OCC_URL = process.env.OCC_URL || 'https://ieu.ai/api/ocuppancy';
let occCache = { ts: 0, data: null };
const occDay = { date: '', peak: 0, samples: 0, sum: 0, enter: 0, leave: 0 };

function fetchOccupancyRaw() {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(OCC_URL); } catch (e) { return reject(e); }
    const req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: 'GET',
      headers: { 'User-Agent': 'YarigTheGame/1.0', 'Accept': 'application/json' },
    }, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error('bad JSON from ' + u.hostname)); } });
    });
    req.on('error', reject);
    req.setTimeout(6000, () => req.destroy(new Error('occupancy timeout')));
    req.end();
  });
}

async function getOccupancy() {
  const now = Date.now();
  if (occCache.data && now - occCache.ts < 2000) return occCache.data;
  let raw;
  try { raw = await fetchOccupancyRaw(); }
  catch (e) {
    const stale = occCache.data;
    return { ok: false, connected: false, error: e.message,
      occupancy: stale ? stale.occupancy : 0, enter: stale ? stale.enter : 0,
      leave: stale ? stale.leave : 0, peak: occDay.peak };
  }
  const num = (...keys) => {
    for (const k of keys) { const v = parseInt(raw[k], 10); if (Number.isFinite(v)) return v; }
    return 0;
  };
  const occupancy = Math.max(0, num('current_occupancy', 'occupancy'));
  const enter = num('total_enter', 'camera_total_enter');
  const leave = num('total_leave', 'total_exit', 'camera_total_leave');
  const recent = Array.isArray(raw.events) ? raw.events.slice(0, 8).map(e => ({
    reg: e.registration || null, at: e.received_at || e.camera_time || null,
  })) : [];

  const date = todayMadrid();
  if (occDay.date !== date) { occDay.date = date; occDay.peak = 0; occDay.samples = 0; occDay.sum = 0; }
  if (occupancy > occDay.peak) occDay.peak = occupancy;
  occDay.samples++; occDay.sum += occupancy; occDay.enter = enter; occDay.leave = leave;

  const data = {
    ok: true,
    connected: raw.connection ? raw.connection === 'receiving' : true,
    occupancy, enter, leave,
    camera: raw.channel_name || null,
    cameraIp: raw.camera_ip || null,
    lastEventAt: raw.last_event_at || raw.last_camera_time || null,
    peak: occDay.peak,
    avg: occDay.samples ? Math.round(occDay.sum / occDay.samples) : occupancy,
    recent,
    ts: new Date().toISOString(),
  };
  occCache = { ts: now, data };
  return data;
}

// ── Session management ─────────────────────────────────────

let yarigCookies = {};
let loggedIn = false;

function cookieHeader() {
  return Object.entries(yarigCookies).map(([k, v]) => `${k}=${v}`).join('; ');
}

function parseCookies(headers) {
  const setCookies = headers['set-cookie'] || [];
  (Array.isArray(setCookies) ? setCookies : [setCookies]).forEach(sc => {
    const [pair] = sc.split(';');
    const [name, ...valParts] = pair.split('=');
    if (name) yarigCookies[name.trim()] = valParts.join('=').trim();
  });
}

function yarigRequest(method, urlPath, postData) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: YARIG_HOST,
      port: 443,
      path: urlPath,
      method,
      rejectAuthorized: false,
      headers: {
        'Cookie': cookieHeader(),
        'User-Agent': 'YarigTheGame/1.0',
      },
    };

    if (postData) {
      const body = typeof postData === 'string' ? postData : new URLSearchParams(postData).toString();
      opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
      opts.headers['Content-Length'] = Buffer.byteLength(body);
    }

    const req = https.request(opts, res => {
      parseCookies(res.headers);
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, data, headers: res.headers }));
    });

    req.on('error', reject);
    if (postData) {
      const body = typeof postData === 'string' ? postData : new URLSearchParams(postData).toString();
      req.write(body);
    }
    req.end();
  });
}

async function yarigLogin() {
  if (!YARIG_EMAIL || !YARIG_PASSWORD) {
    console.error('[yarig] No credentials configured');
    return false;
  }
  try {
    // Get login page first (establish session)
    await yarigRequest('GET', '/registration/login');
    // POST login
    const res = await yarigRequest('POST', '/registration/login', {
      email: YARIG_EMAIL,
      password: YARIG_PASSWORD,
      submit: 'Entrar',
    });
    // Check redirect to /tasks (login successful)
    if (res.status === 302 || res.status === 301) {
      const loc = res.headers.location || '';
      if (loc.includes('/tasks') || loc.includes('/dashboard')) {
        // Follow redirect to complete session
        await yarigRequest('GET', loc.replace('https://yarig.ai', ''));
        loggedIn = true;
        console.log('[yarig] Login successful');
        return true;
      }
    }
    // Some servers return 200 with the tasks page directly
    if (res.status === 200 && (res.data.includes('Mis tareas') || res.data.includes('task-day-resume'))) {
      loggedIn = true;
      console.log('[yarig] Login successful (200)');
      return true;
    }
    console.error('[yarig] Login failed:', res.status, res.headers.location || '');
    return false;
  } catch (e) {
    console.error('[yarig] Login error:', e.message);
    return false;
  }
}

async function yarigAPI(urlPath, postData) {
  if (!loggedIn) {
    if (!await yarigLogin()) return null;
  }

  try {
    const res = await yarigRequest('POST', urlPath, postData);
    if (res.status === 200) {
      try { return JSON.parse(res.data); } catch { return res.data; }
    }
    // Session expired — retry login
    loggedIn = false;
    if (await yarigLogin()) {
      const retry = await yarigRequest('POST', urlPath, postData);
      if (retry.status === 200) {
        try { return JSON.parse(retry.data); } catch { return retry.data; }
      }
    }
    return null;
  } catch (e) {
    console.error('[yarig] API error:', e.message);
    return null;
  }
}

// ── Diario (GitHub) integration ────────────────────────────

function ghGet(apiPath) {
  return new Promise((resolve, reject) => {
    execFile('gh', ['api', apiPath], (err, stdout) => {
      if (err) reject(err);
      else { try { resolve(JSON.parse(stdout)); } catch { resolve(stdout); } }
    });
  });
}

function ghPut(apiPath, body) {
  return new Promise((resolve, reject) => {
    const proc = execFile('gh', ['api', apiPath, '--method', 'PUT', '--input', '-'], (err, stdout) => {
      if (err) reject(err);
      else { try { resolve(JSON.parse(stdout)); } catch { resolve(stdout); } }
    });
    proc.stdin.write(JSON.stringify(body));
    proc.stdin.end();
  });
}

let diaryPushTimer = null;
function scheduleDiaryPush() {
  if (diaryPushTimer) clearTimeout(diaryPushTimer);
  diaryPushTimer = setTimeout(async () => {
    diaryPushTimer = null;
    const todayData = await yarigAPI('/tasks/json_get_current_day_tasks_and_journey_info');
    if (!todayData) return;
    const tasks = Array.isArray(todayData.tasks) ? todayData.tasks
      : Array.isArray(todayData) ? todayData : [];
    const clocking = Array.isArray(todayData.clocking) ? todayData.clocking : [];
    const score = await yarigAPI('/score/json_user_score');
    await pushDiaryEntry(tasks, YARIG_EMAIL, score, clocking);
  }, 5 * 60 * 1000);
  console.log('[diario] Diary push scheduled in 5 min');
}

function todayMadrid() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' });
}

function monthNameES(isoDate) {
  const months = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
  const [, m, d] = isoDate.split('-');
  return `${parseInt(d)} de ${months[parseInt(m) - 1]}`;
}

function taskDuration(t) {
  if (!t.start_time || !t.end_time) return null;
  const s = new Date(t.start_time.replace(' ', 'T'));
  const e = new Date(t.end_time.replace(' ', 'T'));
  if (isNaN(s) || isNaN(e)) return null;
  let sec = Math.max(0, Math.round((e - s) / 1000));
  if (Array.isArray(t.interruptions)) {
    for (const i of t.interruptions) {
      const d = parseInt(i.duration ?? i.seconds ?? 0, 10);
      if (Number.isFinite(d) && d > 0) sec -= d;
    }
  }
  if (sec <= 0) return null;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s2 = sec % 60;
  const pad = n => String(n).padStart(2, '0');
  if (h) return `${h}h ${pad(m)}m ${pad(s2)}s`;
  return `${pad(m)}m ${pad(s2)}s`;
}

function taskText(t) {
  const base = t.description || t.name || t.text || t.title || JSON.stringify(t);
  const dur = taskDuration(t);
  return dur ? `${base} (${dur})` : base;
}

function computeJourney(clocking) {
  const list = Array.isArray(clocking) ? clocking.slice() : [];
  list.sort((a, b) => String(a.datetime || '').localeCompare(String(b.datetime || '')));
  const last = list[list.length - 1];
  const open = last ? String(last.type) === '0' : false;
  const hhmm = dt => {
    if (!dt) return null;
    // Yarig returns "YYYY-MM-DD HH:MM:SS" in UTC (without TZ suffix);
    // format as Europe/Madrid wall-clock time.
    const d = new Date(String(dt).replace(' ', 'T') + 'Z');
    if (isNaN(d)) return null;
    return d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Madrid', hour12: false });
  };
  const firstIn = list.find(c => String(c.type) === '0');
  const lastOut = [...list].reverse().find(c => String(c.type) === '1');
  return {
    open,
    startTime: hhmm(firstIn && firstIn.datetime),
    endTime:   open ? null : hhmm(lastOut && lastOut.datetime),
  };
}

async function pushDiaryEntry(taskList, userEmail, score, clocking) {
  const date = todayMadrid();
  const year = date.split('-')[0];
  const titleDate = `${monthNameES(date)} de ${year}`;
  const journey = computeJourney(clocking);

  let indexRes;
  try { indexRes = await ghGet(`/repos/${DIARIO_REPO}/contents/index.html`); }
  catch (e) { console.error('[diario] Could not fetch index.html:', e.message); return false; }
  const indexSha = indexRes.sha;
  let indexContent = Buffer.from(indexRes.content, 'base64').toString('utf8');

  const isDone = t => {
    const v = t.finished ?? t.completed ?? t.done;
    const finishedFlag = v === true || v === 1 || v === '1';
    if (!finishedFlag) return false;
    // Yarig keeps finished='1' even after a task is re-opened (play pressed
    // again). When that happens start_time is bumped past end_time → treat
    // the task as active/pending until it's closed again.
    if (t.start_time && t.end_time) {
      const s = new Date(String(t.start_time).replace(' ', 'T'));
      const e = new Date(String(t.end_time).replace(' ', 'T'));
      if (!isNaN(s) && !isNaN(e) && s > e) return false;
    }
    return true;
  };
  const completed = taskList.filter(isDone);
  const pending   = taskList.filter(t => !isDone(t));
  // score comes from /score/json_user_score — either a bare string like "10"
  // or an object; normalize to a number when possible.
  const pts = typeof score === 'string' ? parseInt(score, 10)
            : typeof score === 'number' ? score
            : (score && (score.score ?? score.points)) ?? null;
  const total = completed.length + pending.length;
  const completedHeading = `Tareas completadas (${completed.length}/${total})` +
    (Number.isFinite(pts) ? ` · ${pts} puntos` : '');
  // Emit items as {id, text} objects so the Diario can render bidirectional
  // controls (Completar) on pending Yarig tasks.
  const toItem = t => ({ id: String(t.id), text: taskText(t) });
  const sections  = [];
  if (completed.length) sections.push({ heading: completedHeading, items: completed.map(toItem) });
  if (pending.length)   sections.push({ heading: 'Tareas pendientes',  items: pending.map(toItem) });
  // Altas de equipo dadas hoy desde el gemelo digital
  const altasHoy = readMembers().filter(m => m && m.date === date);
  if (altasHoy.length) sections.push({
    heading: `Altas de equipo (${altasHoy.length})`,
    items: altasHoy.map(m => {
      const rl = m.roleLabel || ROLE_LABELS[m.role] || ('rol ' + m.role);
      const loc = m.location && m.location !== 'default' ? ` — ${m.location.charAt(0).toUpperCase() + m.location.slice(1)}` : '';
      return `Nuevo miembro: ${m.name} (${rl})${loc}`;
    }),
  });
  // Aforo del local (cámara Hikvision) — nunca debe romper el diario
  try {
    const occ = await getOccupancy();
    if (occ && occ.ok) sections.push({
      heading: 'Aforo del local (cámara)',
      items: [
        `Ocupación al cierre: ${occ.occupancy} · pico de hoy: ${occ.peak}`,
        `Entradas: ${occ.enter} · Salidas: ${occ.leave}`,
      ],
    });
  } catch (e) { console.error('[diario] aforo skip:', e.message); }
  if (!sections.length) sections.push({ heading: 'Actividad', items: [`Sin tareas registradas por ${userEmail}`] });

  const sectionsJs = sections.map(s =>
    `      {\n        heading: ${JSON.stringify(s.heading)},\n        items: [\n${s.items.map(i => `          ${JSON.stringify(i)}`).join(',\n')}\n        ]\n      }`
  ).join(',\n');
  const timeFields =
    (journey.startTime ? `\n    startTime: ${JSON.stringify(journey.startTime)},` : '') +
    (journey.endTime   ? `\n    updateTime: ${JSON.stringify(journey.endTime)},`   : '') +
    (Number.isFinite(pts) ? `\n    points: ${pts},` : '');
  const newEntry = `  {\n    date: "${date}",\n    title: "${titleDate}",\n    author: "Yarig.ai",${timeFields}\n    sections: [\n${sectionsJs}\n    ]\n  },`;

  // Replace the existing Yarig.ai entry for today (matching date AND author),
  // preserving entries from other authors (Claude/Codex). Otherwise prepend.
  let scan = 0, loc = null;
  while (true) {
    const di = indexContent.indexOf(`date: "${date}"`, scan);
    if (di === -1) break;
    const start = indexContent.lastIndexOf('\n  {\n', di) + 1;
    const closeIdx = indexContent.indexOf('\n  },\n', di);
    if (start > 0 && closeIdx !== -1) {
      const end = closeIdx + '\n  },'.length + 1;
      if (indexContent.substring(start, end).includes('author: "Yarig.ai"')) { loc = { start, end }; break; }
      scan = end;
    } else { scan = di + 1; }
  }
  if (loc) {
    indexContent = indexContent.substring(0, loc.start) + newEntry + '\n' + indexContent.substring(loc.end);
  } else {
    indexContent = indexContent.replace('const entries = [', `const entries = [\n${newEntry}`);
  }

  try {
    await ghPut(`/repos/${DIARIO_REPO}/contents/index.html`, {
      message: `Diario ${date} [Yarig.ai] — ${userEmail}`,
      content: Buffer.from(indexContent).toString('base64'),
      sha: indexSha,
    });
  } catch (e) { console.error('[diario] Push index.html failed:', e.message); return false; }

  // Build and push .md — MERGE the Yarig.ai block, preserving other authors
  const yarigBlock = [
    `# Diario - ${titleDate} [Yarig.ai]`, '',
    ...sections.flatMap((s, si) => [
      `${si + 1}. ${s.heading}`,
      ...s.items.map((item, ii) => `   ${String.fromCharCode(97 + ii)}. ${typeof item === 'string' ? item : (item.text || '')}`),
    ]),
  ].join('\n');

  let existingMd = '', mdSha = null;
  try {
    const mdRes = await ghGet(`/repos/${DIARIO_REPO}/contents/${date}.md`);
    mdSha = mdRes.sha || null;
    existingMd = mdRes.content ? Buffer.from(mdRes.content, 'base64').toString('utf8') : '';
  } catch { /* no existe aun */ }

  let mergedMd;
  const yIdx = existingMd.indexOf('[Yarig.ai]');
  if (yIdx !== -1) {
    // Reemplazar el bloque Yarig.ai (de su '# Diario' al siguiente '---' o EOF)
    const blockStart = existingMd.lastIndexOf('# Diario', yIdx);
    const sepIdx = existingMd.indexOf('\n---\n', yIdx);
    const before = existingMd.substring(0, blockStart).replace(/\s+$/, '');
    const after = sepIdx !== -1 ? existingMd.substring(sepIdx + 5).replace(/^\s+/, '') : '';
    mergedMd = [before, yarigBlock, after].filter(s => s && s.trim()).join('\n\n---\n\n');
  } else if (existingMd.trim()) {
    mergedMd = existingMd.replace(/\s+$/, '') + '\n\n---\n\n' + yarigBlock;
  } else {
    mergedMd = yarigBlock;
  }
  const mdBody = {
    message: `Diario ${date} [Yarig.ai] — ${userEmail}`,
    content: Buffer.from(mergedMd + '\n').toString('base64'),
  };
  if (mdSha) mdBody.sha = mdSha;
  try { await ghPut(`/repos/${DIARIO_REPO}/contents/${date}.md`, mdBody); }
  catch (e) { console.error('[diario] Push .md failed:', e.message); }

  console.log(`[diario] Entry ${date} pushed for ${userEmail}`);
  return true;
}

// Reporte de jornada de UN miembro del equipo (desde el gemelo: /report <nombre>).
// Escribe una entrada propia (author = "<miembro> · <tienda>") en el diario, con
// sus labores. Merge por autor: re-reportar actualiza su entrada, sin pisar otras.
async function pushMemberReport({ member, store, role, lines }) {
  const date = todayMadrid();
  const year = date.split('-')[0];
  const titleDate = `${monthNameES(date)} de ${year}`;
  const name = String(member || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  if (!name) return false;
  const xpacio = store ? String(store).slice(0, 60) : '';
  const author = name + (xpacio ? ` · ${xpacio}` : '');
  const items = (Array.isArray(lines) ? lines : []).map(s => String(s)).filter(Boolean).slice(0, 20);
  if (!items.length) items.push('Jornada completada.');
  const heading = `Jornada${role ? ` · ${role}` : ''}${store ? ` · ${store}` : ''}`;

  let indexRes;
  try { indexRes = await ghGet(`/repos/${DIARIO_REPO}/contents/index.html`); }
  catch (e) { console.error('[report] index.html:', e.message); return false; }
  const indexSha = indexRes.sha;
  let indexContent = Buffer.from(indexRes.content, 'base64').toString('utf8');

  const now = new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Madrid', hour12: false });
  const sectionsJs = `      {\n        heading: ${JSON.stringify(heading)},\n        items: [\n${items.map(i => `          ${JSON.stringify(i)}`).join(',\n')}\n        ]\n      }`;
  const xpacioField = xpacio ? `\n    xpacio: ${JSON.stringify(xpacio)},` : '';
  const newEntry = `  {\n    date: "${date}",\n    title: "${titleDate}",\n    author: ${JSON.stringify(author)},${xpacioField}\n    updateTime: ${JSON.stringify(now)},\n    sections: [\n${sectionsJs}\n    ]\n  },`;

  const authorMarker = `author: ${JSON.stringify(author)}`;
  let scan = 0, loc = null;
  while (true) {
    const di = indexContent.indexOf(`date: "${date}"`, scan);
    if (di === -1) break;
    const start = indexContent.lastIndexOf('\n  {\n', di) + 1;
    const closeIdx = indexContent.indexOf('\n  },\n', di);
    if (start > 0 && closeIdx !== -1) {
      const end = closeIdx + '\n  },'.length + 1;
      if (indexContent.substring(start, end).includes(authorMarker)) { loc = { start, end }; break; }
      scan = end;
    } else { scan = di + 1; }
  }
  if (loc) indexContent = indexContent.substring(0, loc.start) + newEntry + '\n' + indexContent.substring(loc.end);
  else indexContent = indexContent.replace('const entries = [', `const entries = [\n${newEntry}`);

  try {
    await ghPut(`/repos/${DIARIO_REPO}/contents/index.html`, {
      message: `Diario ${date} [${author}]`,
      content: Buffer.from(indexContent).toString('base64'), sha: indexSha,
    });
  } catch (e) { console.error('[report] push index:', e.message); return false; }

  // .md — merge del bloque del miembro por su marcador [author].
  const block = [`# Diario - ${titleDate} [${author}]`, '', `1. ${heading}`,
    ...items.map((it, i) => `   ${String.fromCharCode(97 + i)}. ${it}`)].join('\n');
  let existingMd = '', mdSha = null;
  try { const m = await ghGet(`/repos/${DIARIO_REPO}/contents/${date}.md`); mdSha = m.sha || null; existingMd = m.content ? Buffer.from(m.content, 'base64').toString('utf8') : ''; } catch {}
  const marker = `[${author}]`;
  let mergedMd;
  const yIdx = existingMd.indexOf(marker);
  if (yIdx !== -1) {
    const blockStart = existingMd.lastIndexOf('# Diario', yIdx);
    const sepIdx = existingMd.indexOf('\n---\n', yIdx);
    const before = existingMd.substring(0, blockStart).replace(/\s+$/, '');
    const after = sepIdx !== -1 ? existingMd.substring(sepIdx + 5).replace(/^\s+/, '') : '';
    mergedMd = [before, block, after].filter(s => s && s.trim()).join('\n\n---\n\n');
  } else if (existingMd.trim()) { mergedMd = existingMd.replace(/\s+$/, '') + '\n\n---\n\n' + block; }
  else { mergedMd = block; }
  const mdBody = { message: `Diario ${date} [${author}]`, content: Buffer.from(mergedMd + '\n').toString('base64') };
  if (mdSha) mdBody.sha = mdSha;
  try { await ghPut(`/repos/${DIARIO_REPO}/contents/${date}.md`, mdBody); } catch (e) { console.error('[report] push md:', e.message); }
  console.log(`[report] ${author} → diario ${date}`);
  return author;
}

// ── HTTP Server ─────────────────────────────────────────────

const MIME = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.mp4': 'video/mp4', '.ico': 'image/x-icon',
};

function serveStatic(req, res) {
  const urlPath = req.url.split('?')[0];
  let filePath = path.join(__dirname, urlPath === '/' ? 'index.html' : urlPath);
  if (!fs.existsSync(filePath)) { res.writeHead(404); res.end('Not found'); return; }
  const ext = path.extname(filePath);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
}

function readBody(req) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); } catch { resolve(Object.fromEntries(new URLSearchParams(body))); }
    });
  });
}

function jsonResponse(res, data) {
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(data));
}

function buildGrokPrompt(snapshot) {
  const stock = (snapshot.products || [])
    .map(p => `${p.name || 'Producto'} ${p.stock}/${p.max} (${p.pct}%)`)
    .join(', ');
  const staff = (snapshot.staff || [])
    .filter(s => s.hired)
    .map(s => {
      const task = s.yarigTask ? ` tarea="${s.yarigTask}" estado=${s.yarigState || 'idle'}` : '';
      return `${s.name} ${s.role} L${s.level} ENE${Math.round(s.energy)} MOR${Math.round(s.morale)}${task}`;
    })
    .join(', ');
  const yarig = snapshot.yarig
    ? `Yarig: conectado=${snapshot.yarig.connected}, score=${snapshot.yarig.score}, tareas ${snapshot.yarig.done}/${snapshot.yarig.total}, activas=${snapshot.yarig.active}.`
    : 'Yarig: sin datos.';

  return [
    'Eres Grok dentro de Yarig.ai The Game, un simulador retro de productividad y estanco digital.',
    'Da consejo táctico en castellano para los próximos 60 segundos de partida.',
    'Formato estricto: máximo 3 líneas, cada línea empieza por "· ".',
    'Sé concreto: menciona stock, personal, campañas, tareas Yarig o luces solo si ayudan.',
    '',
    `Estado: año ${snapshot.year}, semana ${snapshot.week}, caja ${Math.round(snapshot.money)} EUR, ingresos anuales ${Math.round(snapshot.yearRevenue)}/${Math.round(snapshot.yearTarget)} EUR.`,
    `Satisfacción ${Math.round(snapshot.satisfaction)}%, fama ${Math.round(snapshot.fame)}%, clientes hoy ${snapshot.customersToday}, rating ${snapshot.rating || 'sin rating'}.`,
    `Stock: ${stock || 'n/a'}.`,
    `Personal: ${staff || 'solo manager'}.`,
    yarig,
    `Eventos: ${snapshot.events || 'ninguno'}.`,
  ].join('\n');
}

function requestGrokAdvice(snapshot) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: XAI_MODEL,
      stream: false,
      temperature: 0.4,
      max_tokens: 180,
      messages: [
        { role: 'system', content: 'Eres un copiloto táctico de videojuegos de gestión. Responde solo con acciones útiles.' },
        { role: 'user', content: buildGrokPrompt(snapshot) },
      ],
    });

    const opts = {
      hostname: 'api.x.ai',
      port: 443,
      path: '/v1/chat/completions',
      method: 'POST',
      timeout: 12000,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${XAI_API_KEY}`,
        'Content-Length': Buffer.byteLength(payload),
      },
    };

    const req = https.request(opts, apiRes => {
      let data = '';
      apiRes.on('data', chunk => data += chunk);
      apiRes.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch {}
        if (apiRes.statusCode < 200 || apiRes.statusCode >= 300) {
          reject(new Error((json && json.error && json.error.message) || `xAI HTTP ${apiRes.statusCode}`));
          return;
        }
        const text = json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
        if (!text) {
          reject(new Error('xAI returned no advice'));
          return;
        }
        resolve({
          advice: text.split('\n').map(s => s.replace(/^[-·*\s]+/, '').trim()).filter(Boolean).slice(0, 3),
          model: json.model || XAI_MODEL,
          fingerprint: json.system_fingerprint || null,
        });
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('xAI timeout'));
    });
    req.write(payload);
    req.end();
  });
}

const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  let url = req.url.split('?')[0];
  // Tailscale Funnel serves us at /yarig and strips that prefix before
  // forwarding. Re-add it so the same routes work via Funnel and localhost.
  if (url === '/today' || url === '/team' || url === '/score' ||
      url === '/notifications' || url === '/status' ||
      url.startsWith('/task/') || url === '/clocking' ||
      url === '/diary/push' || url === '/members' || url === '/member/add' ||
      url === '/report' || url === '/occupancy') {
    url = '/yarig' + url;
  }

  // ── Grok coach route ──

  if (url === '/grok/advice' && req.method === 'POST') {
    if (!XAI_API_KEY) {
      jsonResponse(res, { ok: false, error: 'Missing XAI_API_KEY or GROK_API_KEY in .env' });
      return;
    }
    try {
      const body = await readBody(req);
      const result = await requestGrokAdvice(body.snapshot || {});
      console.log(`[Grok] ${result.model} → ${result.advice.join(' | ')}`);
      jsonResponse(res, { ok: true, ...result });
    } catch (e) {
      console.error('[Grok] error:', e.message);
      jsonResponse(res, { ok: false, error: e.message });
    }
    return;
  }

  // ── Yarig API routes ──

  if (url === '/yarig/today') {
    const data = await yarigAPI('/tasks/json_get_current_day_tasks_and_journey_info');
    jsonResponse(res, data);
    return;
  }

  if (url === '/yarig/team') {
    const data = await yarigAPI('/user/json_get_customers_and_mates_like', { term: '' });
    jsonResponse(res, data);
    return;
  }

  if (url === '/yarig/score') {
    const data = await yarigAPI('/score/json_user_score');
    jsonResponse(res, data);
    return;
  }

  if (url === '/yarig/notifications') {
    const data = await yarigAPI('/system_notification/json_get_user_notifications');
    jsonResponse(res, data);
    return;
  }

  if (url === '/yarig/task/open' && req.method === 'POST') {
    const body = await readBody(req);
    const data = await yarigAPI('/tasks/json_get_and_open_task', { id: body.id });
    jsonResponse(res, data);
    return;
  }

  if (url === '/yarig/task/close' && req.method === 'POST') {
    const body = await readBody(req);
    const data = await yarigAPI('/tasks/json_close_task', {
      tid: body.tid,
      finished: body.finished || 0,
    });
    jsonResponse(res, data);
    scheduleDiaryPush();
    return;
  }

  if (url === '/yarig/task/add' && req.method === 'POST') {
    const body = await readBody(req);
    const tmpId = Date.now();
    const est = body.estimation || 1;
    const proj = body.project || 312;
    const taskStr = `${tmpId}#$#${est}#$#${body.description}#$#${proj}@$@`;
    const data = await yarigAPI('/tasks/json_add_tasks', { tasks: taskStr });
    jsonResponse(res, data);
    scheduleDiaryPush();
    return;
  }

  if (url === '/yarig/clocking' && req.method === 'POST') {
    const body = await readBody(req);
    const data = await yarigAPI('/clocking/json_add_clocking', {
      type: body.type || 0,
      todo: body.todo || '',
    });
    jsonResponse(res, data);
    return;
  }

  if (url === '/yarig/diary/push' && req.method === 'POST') {
    const todayData = await yarigAPI('/tasks/json_get_current_day_tasks_and_journey_info');
    if (!todayData) { jsonResponse(res, { ok: false, error: 'Could not fetch Yarig tasks' }); return; }
    const tasks = Array.isArray(todayData.tasks) ? todayData.tasks
      : Array.isArray(todayData) ? todayData : [];
    const clocking = Array.isArray(todayData.clocking) ? todayData.clocking : [];
    const score = await yarigAPI('/score/json_user_score');
    const ok = await pushDiaryEntry(tasks, YARIG_EMAIL, score, clocking);
    jsonResponse(res, { ok });
    return;
  }

  if (url === '/yarig/report' && req.method === 'POST') {
    const body = await readBody(req);
    const member = String(body.member || '').trim();
    if (!member) { jsonResponse(res, { ok: false, error: 'Falta el nombre del miembro' }); return; }
    const author = await pushMemberReport({
      member, store: body.store || '', role: body.role || '',
      lines: Array.isArray(body.lines) ? body.lines : [],
    });
    jsonResponse(res, author ? { ok: true, author } : { ok: false, error: 'No se pudo escribir el diario' });
    return;
  }

  if (url === '/yarig/members') {
    const q = req.url.includes('?') ? new URLSearchParams(req.url.split('?')[1]) : new URLSearchParams();
    const loc = q.get('location');
    const all = readMembers();
    const members = loc ? all.filter(m => (m.location || 'default') === loc) : all;
    jsonResponse(res, { ok: true, members });
    return;
  }

  if (url === '/yarig/member/add' && req.method === 'POST') {
    const body = await readBody(req);
    const name = String(body.name || '').trim().slice(0, 24);
    const role = resolveRole(body.role);
    const location = (String(body.location || 'default').trim().toLowerCase().slice(0, 24)) || 'default';
    if (!name) { jsonResponse(res, { ok: false, error: 'Falta el nombre del miembro' }); return; }
    if (role < 0) { jsonResponse(res, { ok: false, error: 'Rol no valido. Usa: cajero, repositor, azafata, manager o dj' }); return; }
    const list = readMembers();
    if (list.some(m => m && (m.location || 'default') === location && String(m.name).toLowerCase() === name.toLowerCase())) {
      jsonResponse(res, { ok: false, error: `Ya existe ${name} en ${location}` });
      return;
    }
    const member = { name, role, roleLabel: ROLE_LABELS[role], location, date: todayMadrid(), createdAt: new Date().toISOString() };
    list.push(member);
    writeMembers(list);
    const pushed = await pushMembersToGitHub(list);
    // Reflejar el alta en el diario de hoy (entrada Yarig.ai)
    let diary = false;
    try {
      const todayData = await yarigAPI('/tasks/json_get_current_day_tasks_and_journey_info');
      const tasks = Array.isArray(todayData && todayData.tasks) ? todayData.tasks
        : Array.isArray(todayData) ? todayData : [];
      const clocking = Array.isArray(todayData && todayData.clocking) ? todayData.clocking : [];
      const score = await yarigAPI('/score/json_user_score');
      diary = await pushDiaryEntry(tasks, YARIG_EMAIL, score, clocking);
    } catch (e) { console.error('[members] diary update failed:', e.message); }
    console.log(`[members] Alta: ${member.name} (${member.roleLabel}) — pushed=${pushed} diary=${diary}`);
    jsonResponse(res, { ok: true, member, pushed, diary, members: list });
    return;
  }

  if (url === '/yarig/status') {
    jsonResponse(res, { connected: loggedIn, email: YARIG_EMAIL });
    return;
  }

  // ── Aforo en vivo (cámara Hikvision vía ieu.ai) ──
  if (url === '/yarig/occupancy') {
    const data = await getOccupancy();
    jsonResponse(res, data);
    return;
  }

  // ── Hue session lock: last tab to claim wins ──

  if (url === '/hue/claim' && req.method === 'POST') {
    const body = await readBody(req);
    hueSessionOwner = body.tabId || '';
    console.log(`[Hue] Session claimed by tab: ${hueSessionOwner}`);
    jsonResponse(res, { ok: true, owner: hueSessionOwner });
    return;
  }

  // ── Hue API routes ──

  if (url === '/hue/lights') {
    if (!HUE_BRIDGE_IP) { jsonResponse(res, { error: 'Hue not configured' }); return; }
    try {
      const data = await hueRequest('GET', '/lights');
      jsonResponse(res, data);
    } catch (e) { jsonResponse(res, { error: e.message }); }
    return;
  }

  if (url === '/hue/groups') {
    if (!HUE_BRIDGE_IP) { jsonResponse(res, { error: 'Hue not configured' }); return; }
    try {
      const data = await hueRequest('GET', '/groups');
      jsonResponse(res, data);
    } catch (e) { jsonResponse(res, { error: e.message }); }
    return;
  }

  // PUT /hue/lights/:id/state — set light state (only from session owner)
  if (url.match(/^\/hue\/lights\/\d+\/state$/) && req.method === 'PUT') {
    if (!HUE_BRIDGE_IP) { jsonResponse(res, { error: 'Hue not configured' }); return; }
    const lightId = url.split('/')[3];
    const body = await readBody(req);
    // Check session lock — reject writes from non-owner tabs
    const tabId = req.headers['x-hue-tab'] || '';
    if (hueSessionOwner && tabId && tabId !== hueSessionOwner) {
      jsonResponse(res, [{ error: { type: 901, description: 'Not session owner' } }]);
      return;
    }
    try {
      const data = await hueRequest('PUT', `/lights/${lightId}/state`, body);
      jsonResponse(res, data);
    } catch (e) { jsonResponse(res, { error: e.message }); }
    return;
  }

  // PUT /hue/groups/:id/action — set group action
  if (url.match(/^\/hue\/groups\/\d+\/action$/) && req.method === 'PUT') {
    if (!HUE_BRIDGE_IP) { jsonResponse(res, { error: 'Hue not configured' }); return; }
    const groupId = url.split('/')[3];
    const body = await readBody(req);
    try {
      const data = await hueRequest('PUT', `/groups/${groupId}/action`, body);
      jsonResponse(res, data);
    } catch (e) { jsonResponse(res, { error: e.message }); }
    return;
  }

  if (url === '/hue/status') {
    jsonResponse(res, {
      configured: !!HUE_BRIDGE_IP,
      bridge: HUE_BRIDGE_IP || null,
    });
    return;
  }

  // ── Static files ──
  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`\n  🎮 Yarig.aiTheGame running at http://localhost:${PORT}\n`);
  console.log(`  🧠 Grok coach: ${XAI_API_KEY ? 'enabled' : 'set XAI_API_KEY in .env to enable'}\n`);
  // Pre-login to Yarig
  yarigLogin().then(ok => {
    if (ok) console.log('  ✅ Connected to Yarig.ai');
    else console.log('  ⚠️  Could not connect to Yarig.ai (check .env)');
  });
});
