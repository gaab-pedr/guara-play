import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';

const PORT = process.env.PORT || 3000;
const PASS = (process.env.ADMIN_PASS || 'admin').trim();
const PUB = path.join(import.meta.dirname, 'public');
const MEDIA = path.join(import.meta.dirname, 'media');
const DB = path.join(import.meta.dirname, 'data.json');
const CAPT = path.join(import.meta.dirname, 'captures');
fs.mkdirSync(MEDIA, { recursive: true }); fs.mkdirSync(CAPT, { recursive: true });
const wantCap = {}; // device -> instante em que o painel pediu uma captura

let db = fs.existsSync(DB) ? JSON.parse(fs.readFileSync(DB, 'utf8')) : { media: [], playlists: [], screens: [], devices: {} };
db.layouts ||= []; // layouts de zonas
db.activity ||= []; db.account ||= { name: '' };
// "Alterações recentes": quem fez o quê (lista curta, as mais novas primeiro)
const act = (kind, verb, noun, name, d) => { db.activity.unshift({ t: Date.now(), kind, verb, noun, name, who: db.account.name || 'Admin', d: d || [] }); if (db.activity.length > 400) db.activity.length = 400; };
const plLabel = i => i.kind === 'clock' ? 'Relógio e data' : i.kind === 'weather' ? 'Clima — ' + (i.cfg.city || '') : i.kind === 'news' ? 'Notícias' : ((db.media.find(x => x.id === i.mediaId) || {}).name || 'arquivo removido');
const diffLabels = (a, b) => { const c = {}; a.forEach(x => c[x] = (c[x] || 0) + 1); const add = [], del = [];
  b.forEach(x => { if (c[x]) c[x]--; else add.push(x); }); Object.keys(c).forEach(x => { for (let k = 0; k < c[x]; k++) del.push(x); }); return { add, del }; };
db.tags ||= [];
const save = () => fs.writeFileSync(DB, JSON.stringify(db));
const seen = {}; // device -> último contato (em memória)

// ---- relatórios de exibição ----
const STATS = path.join(import.meta.dirname, 'stats.json');
const TZ = process.env.STATS_TZ || 'America/Sao_Paulo'; // fuso usado para separar os dias
let st = { days: {}, names: {}, snames: {}, batches: {} }; // days[dia][telaId] = { online: segundos, c: { conteudoId: [segundos, exibições] } }
try { if (fs.existsSync(STATS)) st = { ...st, ...JSON.parse(fs.readFileSync(STATS, 'utf8')) }; } catch (e) { console.error('stats.json ilegível, começando vazio:', e.message); }
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const dayOf = ms => dayFmt.format(new Date(ms)); // AAAA-MM-DD no fuso configurado
const cut = dayOf(Date.now() - 800 * 864e5);
for (const d of Object.keys(st.days)) if (d < cut) delete st.days[d]; // guarda até ~2 anos
const WN = { clock: 'Relógio e data', weather: 'Clima', news: 'Notícias' };
const bucket = (day, sid) => ((st.days[day] ||= {})[sid] ||= { online: 0, c: {} });
const lastPoll = {}; let sdirty = false;
st.hist ||= []; // histórico de status: { t: início da janela, on: mínimo online, tot: total, e: esperadas (dentro do horário), o: online entre as esperadas }
const SLOT = 300000;
const schedOn = (s, d) => { const x = s.schedule; if (!x || !x.days || !x.days.length) return true;
  const hm = t => +t.slice(0, 2) * 60 + +t.slice(3), m = d.getHours() * 60 + d.getMinutes(), a = hm(x.start), b = hm(x.end), day = d.getDay(), prev = (day + 6) % 7;
  if (a === b) return x.days.includes(day);
  return a < b ? x.days.includes(day) && m >= a && m < b : (x.days.includes(day) && m >= a) || (x.days.includes(prev) && m < b); };
function sampleHist() {
  const now = Date.now(), t = Math.floor(now / SLOT) * SLOT, scs = db.screens, isOn = s => seen[s.device] && now - seen[s.device] < 60000;
  const on = scs.filter(isOn).length, exp = scs.filter(s => schedOn(s, new Date(now))), o = exp.filter(isOn).length; let h = st.hist[st.hist.length - 1];
  if (!h || h.t !== t) st.hist.push({ t, on, tot: scs.length, e: exp.length, o }); else { h.on = Math.min(h.on, on); h.o = Math.min(h.o, o); h.tot = scs.length; h.e = exp.length; }
  if (st.hist.length > 2300) st.hist.splice(0, st.hist.length - 2300); sdirty = true;
}
setTimeout(() => { sampleHist(); setInterval(sampleHist, 60000).unref(); }, 2000).unref();
const flushStats = () => { if (!sdirty) return; try { fs.writeFileSync(STATS + '.tmp', JSON.stringify(st)); fs.renameSync(STATS + '.tmp', STATS); sdirty = false; } catch (e) { console.error('Falha ao salvar stats:', e.message); } };
setInterval(flushStats, 30000).unref();
for (const sg of ['SIGINT', 'SIGTERM']) process.on(sg, () => { flushStats(); process.exit(0); });
const tokens = new Set();
const fails = {}; // ip -> { n, t }: bloqueia quem erra a senha muitas vezes
const ipOf = req => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
const vt = (arr, scope) => (Array.isArray(arr) ? arr : []).filter(id => db.tags.some(t => t.id === id && t.scope === scope));
// grade de um layout: cols x rows, zonas em unidades da grade (x, y, w, h) e a playlist de cada uma
const vg = g => { const cols = Math.min(48, Math.max(4, parseInt(g?.cols) || 24)), rows = Math.min(48, Math.max(4, parseInt(g?.rows) || 24));
  const zones = (Array.isArray(g?.zones) ? g.zones : []).slice(0, 20).map(z => {
    const x = Math.min(cols - 1, Math.max(0, parseInt(z.x) || 0)), y = Math.min(rows - 1, Math.max(0, parseInt(z.y) || 0));
    return { id: /^\w{1,20}$/.test(z.id || '') ? z.id : rid(), x, y, w: Math.min(cols - x, Math.max(1, parseInt(z.w) || 1)), h: Math.min(rows - y, Math.max(1, parseInt(z.h) || 1)),
      playlistId: z.playlistId || null, content: vc(z.content), rot: [0, 90, 180, 270].includes(+z.rot) ? +z.rot : 0, fit: ['contain', 'cover', 'fill'].includes(z.fit) ? z.fit : '' }; });
  return { cols, rows, zones }; };
// conteúdo direto da zona: um arquivo (com zoom e posição) ou um widget, sem precisar de lista
const vc = c => { if (!c || typeof c !== 'object') return null;
  if (c.type === 'file') return { type: 'file', mediaId: String(c.mediaId || '').slice(0, 40), zoom: vnum(c.zoom, 20, 400, 100), ax: vnum(c.ax, 0, 100, 50), ay: vnum(c.ay, 0, 100, 50) };
  if (c.type === 'widget' && c.item) { const k = c.item.kind, seconds = Math.max(1, Math.round(vnum(c.item.seconds, 1, 3600, 15)));
    if (k === 'clock') return { type: 'widget', item: { kind: 'clock', seconds } };
    if (k === 'weather') return { type: 'widget', item: { kind: 'weather', seconds, cfg: vWeather(c.item.cfg) } };
    if (k === 'news') return { type: 'widget', item: { kind: 'news', seconds, cfg: vNews(c.item.cfg) } }; }
  return null; };
const clean = b => { const o = {};
  if ('rotation' in b) o.rotation = [0, 90, 180, 270].includes(+b.rotation) ? +b.rotation : 0;
  if ('fit' in b) o.fit = ['contain', 'cover', 'fill'].includes(b.fit) ? b.fit : 'contain';
  if ('sound' in b) o.sound = !!b.sound;
  if ('tags' in b) o.tags = vt(b.tags, 'screens');
  if ('schedule' in b) { const x = b.schedule; // horário de funcionamento (null = sempre ligada)
    o.schedule = x && /^\d\d:\d\d$/.test(x.start) && /^\d\d:\d\d$/.test(x.end) && Array.isArray(x.days) && x.days.length
      ? { days: [...new Set(x.days.map(Number).filter(d => d >= 0 && d <= 6))], start: x.start, end: x.end } : null; }
  return o; };
const rid = () => crypto.randomBytes(6).toString('hex');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.mp4': 'video/mp4', '.webm': 'video/webm' };
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
const readBody = async req => { const c = []; for await (const d of req) c.push(d); return JSON.parse(Buffer.concat(c).toString() || '{}'); };

// ---- widgets (clima e notícias): o servidor busca os dados e guarda em cache; as telas pegam daqui ----
const OM = process.env.OPEN_METEO_URL || 'https://api.open-meteo.com', OMG = process.env.OPEN_METEO_GEO_URL || 'https://geocoding-api.open-meteo.com';
const vcol = (c, d) => /^(#[0-9a-fA-F]{3,8}|rgba?\([\d\s.,%]{3,30}\))$/.test(c || '') ? c : d;
const vnum = (n, a, b, d) => { n = parseFloat(n); return Math.min(b, Math.max(a, Number.isFinite(n) ? n : d)); };
const wStyle = (c, d) => ({ bg: vcol(c.bg, d.bg), color: vcol(c.color, d.color), accent: vcol(c.accent, d.accent), scale: vnum(c.scale, 50, 250, 100), font: ['sans', 'serif', 'mono', 'cond'].includes(c.font) ? c.font : 'sans' });
const vWeather = c => ({ ...wStyle(c || {}, { bg: '#0b3d91', color: '#ffffff', accent: '#ffd54a' }), city: String(c?.city || '').slice(0, 60), lat: vnum(c?.lat, -90, 90, 0), lon: vnum(c?.lon, -180, 180, 0), forecast: c?.forecast !== false, credit: c?.credit !== false });
const feedOk = u => { try { const x = new URL(u); return x.protocol === 'http:' || x.protocol === 'https:'; } catch { return false; } };
const vNews = c => ({ ...wStyle(c || {}, { bg: '#111111', color: '#ffffff', accent: '#ff7a00' }), feeds: (Array.isArray(c?.feeds) ? c.feeds : []).map(x => String(x).trim()).filter(feedOk).slice(0, 5),
  count: Math.round(vnum(c?.count, 3, 30, 10)), mode: c?.mode === 'slides' ? 'slides' : 'ticker', speed: vnum(c?.speed, 20, 200, 70), interval: vnum(c?.interval, 3, 60, 8), label: String(c?.label ?? 'NOTÍCIAS').slice(0, 24) });
const wkOf = i => crypto.createHash('sha1').update(i.kind + JSON.stringify(i.kind === 'weather' ? [i.cfg.lat, i.cfg.lon] : [i.cfg.feeds, i.cfg.count])).digest('hex').slice(0, 12);
const screenWidgets = sc => { const ids = new Set([sc.playlistId]), l = sc.layoutId && db.layouts.find(x => x.id === sc.layoutId);
  const inline = []; if (l) [l.h, l.v].forEach(g => g.zones.forEach(z => { ids.add(z.playlistId); if (z.content && z.content.type === 'widget' && z.content.item.kind !== 'clock') inline.push(z.content.item); }));
  return db.playlists.filter(x => ids.has(x.id)).flatMap(x => x.items.filter(i => i.kind === 'weather' || i.kind === 'news')).concat(inline); };
const wCache = new Map(), wBusy = new Map();
function cached(key, ttl, fn) { // cache em memória; se a busca falhar, entrega o último valor bom (marcado como antigo)
  const c = wCache.get(key); if (c && Date.now() - c.at < ttl) return Promise.resolve(c);
  if (!wBusy.has(key)) wBusy.set(key, fn().then(data => { const e = { at: Date.now(), data }; wCache.set(key, e); return e; }).catch(err => { if (c) return { ...c, stale: true }; throw err; }).finally(() => wBusy.delete(key)));
  return wBusy.get(key);
}
const getJ = async url => { const r = await fetch(url, { signal: AbortSignal.timeout(12000), headers: { 'user-agent': 'GuaraPlay/1.0', accept: 'application/json' } }); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); };
const weather = c => cached(`w:${c.lat.toFixed(2)},${c.lon.toFixed(2)}`, 15 * 60e3, async () => {
  const j = await getJ(`${OM}/v1/forecast?latitude=${c.lat}&longitude=${c.lon}&current=temperature_2m,weather_code,is_day&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=4`);
  if (!j.current || !j.daily?.time) throw new Error('Resposta inesperada do serviço de clima');
  const dn = d => new Date(d + 'T12:00:00Z').toLocaleDateString('pt-BR', { weekday: 'short', timeZone: 'UTC' }).replace('.', ''), D = j.daily;
  return { temp: Math.round(j.current.temperature_2m), code: j.current.weather_code, day: !!j.current.is_day, max: Math.round(D.temperature_2m_max[0]), min: Math.round(D.temperature_2m_min[0]), rain: D.precipitation_probability_max?.[0] ?? null,
    next: D.time.slice(1, 4).map((d, k) => ({ d: dn(d), code: D.weather_code[k + 1], max: Math.round(D.temperature_2m_max[k + 1]), min: Math.round(D.temperature_2m_min[k + 1]) })) };
});
const unesc = s => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ' ').replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos|nbsp);/gi, (m, e) => {
  const t = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }[e.toLowerCase()]; if (t) return t;
  try { return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)); } catch { return ''; } }).replace(/\s+/g, ' ').trim();
function parseFeed(xml) { // RSS e Atom: pega o título do canal e os títulos dos itens
  const t = (xml.match(/<channel[^>]*>[\s\S]*?<title[^>]*>([\s\S]*?)<\/title>/i) || xml.match(/<feed[^>]*>[\s\S]*?<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
  const blocks = xml.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi) || [];
  return { src: unesc(t), items: blocks.map(b => unesc((b.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '')).filter(Boolean) };
}
const getFeed = async u => {
  const r = await fetch(u, { signal: AbortSignal.timeout(12000), headers: { 'user-agent': 'Mozilla/5.0 GuaraPlay', accept: 'application/rss+xml,application/atom+xml,application/xml,text/xml,*/*' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const buf = Buffer.from(await r.arrayBuffer()).subarray(0, 3e6), cs = (/encoding=["']([\w-]+)/i.exec(buf.subarray(0, 200).toString('latin1')) || [])[1] || 'utf-8';
  let txt; try { txt = new TextDecoder(cs.toLowerCase()).decode(buf); } catch { txt = buf.toString('utf8'); }
  const f = parseFeed(txt); return { ...f, src: f.src || new URL(u).hostname };
};
const news = c => cached(`n:${c.feeds.join('|')}:${c.count}`, 10 * 60e3, async () => {
  if (!c.feeds.length) throw new Error('Nenhum feed configurado');
  const lists = (await Promise.allSettled(c.feeds.map(getFeed))).filter(x => x.status === 'fulfilled').map(x => x.value);
  if (!lists.length) throw new Error('Nenhum feed respondeu');
  const out = [], seen = new Set(); // intercala os feeds: 1º de cada, 2º de cada...
  for (let i = 0; out.length < c.count; i++) { let any = false;
    for (const l of lists) { const t = l.items[i]; if (!t) continue; any = true; if (!seen.has(t) && out.length < c.count) { seen.add(t); out.push({ t, s: l.src }); } }
    if (!any) break; }
  if (!out.length) throw new Error('Os feeds não trazem títulos');
  return { items: out };
});

function serve(req, res, file) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('Não encontrado'); }
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    if (m) { // suporte a Range (vídeo)
      let start = m[1] ? +m[1] : 0, end = m[2] ? Math.min(+m[2], st.size - 1) : st.size - 1;
      if (!m[1] && m[2]) { start = Math.max(0, st.size - +m[2]); end = st.size - 1; } // "últimos N bytes"
      if (!(start <= end) || start >= st.size) { res.writeHead(416, { 'content-range': `bytes */${st.size}` }); return res.end(); }
      res.writeHead(206, { 'content-type': type, 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${st.size}`, 'content-length': end - start + 1 });
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { 'content-type': type, 'content-length': st.size, 'accept-ranges': 'bytes', 'cache-control': file.startsWith(MEDIA) ? 'public, max-age=31536000, immutable' : 'no-cache' });
    fs.createReadStream(file).pipe(res);
  });
}

function manifest(dev, plat) {
  let d = db.devices[dev];
  if (!d) {
    let code;
    do code = String(100000 + crypto.randomInt(900000)); while (Object.values(db.devices).some(x => x.code === code));
    for (const k of Object.keys(db.devices)) // limpa códigos de players que nunca foram pareados
      if (!db.screens.some(x => x.device === k) && (seen[k] || 0) < Date.now() - 30 * 60000) delete db.devices[k];
    d = db.devices[dev] = { code }; save();
  }
  seen[dev] = Date.now();
  const s = db.screens.find(s => s.device === dev);
  if (!s) return { paired: false, code: d.code };
  { const now = Date.now(), prev = lastPoll[dev]; lastPoll[dev] = now; st.snames[s.id] = s.name; // horas "online": soma o intervalo entre contatos (máx. 30s cada)
    if (prev) { const g = Math.min((now - prev) / 1000, 30); if (g > 0) { bucket(dayOf(now), s.id).online += g; sdirty = true; } } }
  if (['Android', 'Windows', 'Apple', 'Outro'].includes(plat) && s.platform !== plat) { s.platform = plat; save(); }
  const mapItems = pl => (pl?.items || []).map(i => {
    if (i.kind === 'clock') return { id: 'clock', type: 'clock', seconds: i.seconds };
    if (i.kind === 'weather' || i.kind === 'news') return { id: i.kind, type: i.kind, seconds: i.seconds, wk: wkOf(i), cfg: i.cfg };
    const m = db.media.find(x => x.id === i.mediaId);
    return m && { id: m.id, type: m.type, url: '/media/' + m.file, seconds: i.seconds };
  }).filter(Boolean);
  const man = { paired: true, name: s.name, rotation: s.rotation || 0, fit: s.fit || 'contain', sound: !!s.sound, items: mapItems(db.playlists.find(p => p.id === s.playlistId)) };
  const lay = s.layoutId && db.layouts.find(l => l.id === s.layoutId);
  if (lay) { // tela com zonas: usa o desenho da orientação da tela, em porcentagem
    const zItems = z => !z.content ? mapItems(db.playlists.find(p => p.id === z.playlistId)) : z.content.type === 'file' ? mapItems({ items: [{ kind: 'media', mediaId: z.content.mediaId, seconds: 10 }] }) : mapItems({ items: [z.content.item] });
    const pc = n => Math.round(n * 10000) / 100, mk = g => g.zones.map(z => ({ x: pc(z.x / g.cols), y: pc(z.y / g.rows), w: pc(z.w / g.cols), h: pc(z.h / g.rows), rot: z.rot, fit: z.fit, view: z.content && z.content.type === 'file' ? { zoom: z.content.zoom, ax: z.content.ax, ay: z.content.ay } : null, items: zItems(z) }));
    man.zh = mk(lay.h); man.zv = mk(lay.v); // o player escolhe pelo formato real da tela (em pé ou deitada)
    man.zones = (s.rotation || 0) % 180 ? man.zv : man.zh;
    const seen = new Set(); // 'items' leva a união de tudo: apps antigos só baixam o que está em 'items'
    man.items = [...man.zh, ...man.zv].reduce((a, z) => a.concat(z.items), []).filter(i => { const k = i.url || i.wk || i.id; if (seen.has(k)) return false; seen.add(k); return true; });
  }
  man.version = crypto.createHash('sha1').update(JSON.stringify(man)).digest('hex').slice(0, 12);
  if (wantCap[dev] && Date.now() - wantCap[dev] < 60000) man.capture = true; // fora do hash: não reinicia a lista
  return man;
}

process.on('uncaughtException', e => console.error('Erro não tratado:', e));
process.on('unhandledRejection', e => console.error('Promessa rejeitada:', e));
http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x'), p = u.pathname, m = req.method;
    if (p === '/api/login' && m === 'POST') {
      const { pass } = await readBody(req);
      const ip = ipOf(req), f = fails[ip], recent = f && Date.now() - f.t < 15 * 60000;
      if (recent && f.n >= 8) return json(res, 429, { error: 'Muitas tentativas erradas. Aguarde 15 minutos.' });
      if (!pass) return json(res, 401, { error: 'Informe a senha' });
      if (String(pass).trim() !== PASS) { fails[ip] = { n: (recent ? f.n : 0) + 1, t: Date.now() }; return json(res, 401, { error: 'Senha incorreta' }); }
      delete fails[ip];
      const t = crypto.randomBytes(24).toString('hex'); tokens.add(t); return json(res, 200, { token: t });
    }
    if (p === '/api/player/capture' && m === 'POST') {
      const dev = u.searchParams.get('device') || '', sc = db.screens.find(x => x.device === dev);
      if (!sc) { req.resume(); return json(res, 403, { error: 'Tela não pareada' }); }
      const ch = []; let n = 0;
      for await (const c of req) { n += c.length; if (n > 3e6) return json(res, 413, { error: 'Imagem grande demais' }); ch.push(c); }
      const buf = Buffer.concat(ch);
      if (buf[0] !== 0xff || buf[1] !== 0xd8) return json(res, 400, { error: 'Imagem inválida' });
      fs.writeFileSync(path.join(CAPT, sc.id + '.jpg'), buf); sc.captureAt = Date.now(); delete wantCap[dev]; save();
      return json(res, 200, {});
    }
    if (p === '/api/player/log' && m === 'POST') {
      const dev = u.searchParams.get('device') || '', sc = db.screens.find(x => x.device === dev);
      if (!sc) { req.resume(); return json(res, 403, { error: 'Tela não pareada' }); }
      const ch = []; let n = 0;
      for await (const c of req) { n += c.length; if (n > 1e6) return json(res, 413, { error: 'Grande demais' }); ch.push(c); }
      let b; try { b = JSON.parse(Buffer.concat(ch).toString()); } catch { return json(res, 400, { error: 'JSON inválido' }); }
      const seenB = (st.batches[dev] ||= []);
      if (typeof b.b === 'string' && seenB.includes(b.b)) return json(res, 200, { dup: true }); // reenvio de um lote já recebido
      const now = Date.now(); let ok = 0;
      for (const r of (Array.isArray(b.rows) ? b.rows.slice(0, 5000) : [])) {
        if (!r || !/^\d{4}-\d\d-\d\dT\d\d$/.test(r.h || '') || !/^[\w-]{1,40}$/.test(r.c || '')) continue;
        const t = Date.parse(r.h + ':30:00Z'); if (!(t > now - 400 * 864e5 && t < now + 864e5)) continue;
        const secs = Math.min(Math.max(+r.s || 0, 0), 3600), plays = Math.min(Math.max(+r.n || 0, 0), 3600); if (!secs) continue;
        const cell = (bucket(dayOf(t), sc.id).c[r.c] ||= [0, 0]); cell[0] += secs; cell[1] += plays; ok++;
        const mm = db.media.find(x => x.id === r.c); if (mm) st.names[r.c] = mm.name; else if (WN[r.c]) st.names[r.c] = WN[r.c];
      }
      if (typeof b.b === 'string') { seenB.push(b.b.slice(0, 40)); if (seenB.length > 50) seenB.shift(); }
      st.snames[sc.id] = sc.name; sdirty = true; return json(res, 200, { ok });
    }
    if (p === '/api/player/widget' && m === 'GET') { // dados de clima/notícias para a tela (só dos widgets que ela realmente usa)
      const sc = db.screens.find(x => x.device === (u.searchParams.get('device') || '')), k = u.searchParams.get('k') || '';
      if (!sc) return json(res, 403, { error: 'Tela não pareada' });
      const it = screenWidgets(sc).find(i => wkOf(i) === k); if (!it) return json(res, 404, { error: 'Widget não encontrado' });
      try { const e = await (it.kind === 'weather' ? weather(it.cfg) : news(it.cfg)); return json(res, 200, { at: e.at, stale: !!e.stale, data: e.data }); }
      catch (e) { return json(res, 502, { error: e.message }); }
    }
    if (p === '/api/player') {
      const dev = u.searchParams.get('device') || '';
      if (!/^[\w-]{8,64}$/.test(dev)) return json(res, 400, { error: 'device inválido' });
      return json(res, 200, manifest(dev, u.searchParams.get('p')));
    }
    if (p.startsWith('/media/')) return serve(req, res, path.join(MEDIA, path.basename(p)));
    if (p.startsWith('/api/')) {
      if (!tokens.has((req.headers.authorization || '').slice(7))) return json(res, 401, { error: 'Não autorizado' });
      let r;
      if (p === '/api/stats' && m === 'GET') {
        const from = u.searchParams.get('from') || '', to = u.searchParams.get('to') || '', ok = /^\d{4}-\d\d-\d\d$/;
        if (!ok.test(from) || !ok.test(to) || to < from || Date.parse(to) - Date.parse(from) > 800 * 864e5) return json(res, 400, { error: 'Período inválido' });
        const days = {}; for (const d of Object.keys(st.days)) if (d >= from && d <= to) days[d] = st.days[d];
        const names = { ...st.names, ...WN }; for (const x of db.media) names[x.id] = x.name;
        const screens = { ...st.snames }; for (const x of db.screens) screens[x.id] = x.name;
        return json(res, 200, { tz: TZ, today: dayOf(Date.now()), days, names, screens });
      }
      if (p === '/api/state') {
        return json(res, 200, { now: Date.now(), tags: db.tags, media: db.media, playlists: db.playlists, layouts: db.layouts, account: db.account,
          screens: db.screens.map(s => ({ ...s, seen: seen[s.device] || 0 })) });
      }
      if (p === '/api/tags' && m === 'POST') {
        const b = await readBody(req); let t = b.id && db.tags.find(x => x.id === b.id);
        if (!t) {
          if (!['screens', 'files', 'lists'].includes(b.scope) || !String(b.name || '').trim()) return json(res, 400, { error: 'Informe o nome da etiqueta.' });
          t = { id: rid(), scope: b.scope, name: '', color: '#f2a900' }; db.tags.push(t);
        }
        if (b.name !== undefined) { const n = String(b.name).trim().slice(0, 40); if (!n) return json(res, 400, { error: 'O nome não pode ficar vazio.' }); t.name = n; }
        if (/^#[0-9a-f]{6}$/i.test(b.color || '')) t.color = b.color;
        save(); return json(res, 200, t);
      }
      if ((r = p.match(/^\/api\/tags\/(\w+)$/)) && m === 'DELETE') {
        db.tags = db.tags.filter(x => x.id !== r[1]);
        for (const l of [db.screens, db.media, db.playlists]) l.forEach(e => { if (e.tags) e.tags = e.tags.filter(i => i !== r[1]); });
        save(); return json(res, 200, {});
      }
      if (p === '/api/media' && m === 'POST') {
        const name = u.searchParams.get('name') || 'arquivo', ext = path.extname(name).toLowerCase().replace(/[^.\w]/g, '');
        const IMG = ['.jpg', '.jpeg', '.png', '.gif', '.webp'], VID = ['.mp4', '.webm', '.mov', '.m4v'];
        const type = IMG.includes(ext) ? 'image' : VID.includes(ext) ? 'video' : null;
        const size = +req.headers['content-length'] || 0;
        if (!type) { req.resume(); return json(res, 400, { error: 'Tipo não aceito. Use JPG, PNG, GIF, WEBP, MP4, WEBM, MOV ou M4V.' }); }
        if (size > 1024 ** 3) { req.resume(); return json(res, 400, { error: 'O arquivo passa do limite de 1 GB.' }); }
        const id = rid(), file = id + ext;
        await pipeline(req, fs.createWriteStream(path.join(MEDIA, file)));
        db.media.push({ id, name, type, kind: ext === '.gif' ? 'gif' : type, file, size, duration: Math.round((+u.searchParams.get('dur') || 0) * 10) / 10, created: Date.now() });
        act('add', 'adicionou', 'o arquivo', name); save(); return json(res, 200, { id });
      }
      if ((r = p.match(/^\/api\/media\/(\w+)$/)) && m === 'PATCH') {
        const x = db.media.find(a => a.id === r[1]); if (!x) return json(res, 404, { error: 'Arquivo não encontrado' });
        const b = await readBody(req);
        if (b.name && String(b.name).slice(0, 120) !== x.name) act('edit', 'alterou', 'o arquivo', String(b.name).slice(0, 120), [{ k: 'Nome do Arquivo', from: x.name, to: String(b.name).slice(0, 120) }]);
        if (b.name) x.name = String(b.name).slice(0, 120);
        if ('tags' in b) x.tags = vt(b.tags, 'files');
        if (+b.duration > 0) x.duration = Math.round(+b.duration * 10) / 10;
        save(); return json(res, 200, {});
      }
      if ((r = p.match(/^\/api\/media\/(\w+)$/)) && m === 'DELETE') {
        const x = db.media.find(a => a.id === r[1]);
        if (x) { act('del', 'removeu', 'o arquivo', x.name); fs.rmSync(path.join(MEDIA, x.file), { force: true }); db.media = db.media.filter(a => a !== x);
          db.playlists.forEach(pl => pl.items = pl.items.filter(i => i.mediaId !== x.id)); save(); }
        return json(res, 200, {});
      }
      if (p === '/api/playlists' && m === 'POST') {
        const b = await readBody(req);
        const pl = { id: b.id || rid(), name: String(b.name || 'Sem nome').slice(0, 80), orientation: b.orientation === 'v' ? 'v' : 'h',
          items: (b.items || []).map(i => { const seconds = Math.max(1, +i.seconds || 10);
            if (i.kind === 'clock') return { kind: 'clock', seconds };
            if (i.kind === 'weather') return { kind: 'weather', seconds, cfg: vWeather(i.cfg) };
            if (i.kind === 'news') return { kind: 'news', seconds, cfg: vNews(i.cfg) };
            return { kind: 'media', mediaId: i.mediaId, seconds }; }) };
        const k = db.playlists.findIndex(x => x.id === pl.id);
        if (k < 0) act('add', 'criou', 'a lista de reprodução', pl.name);
        else { const old = db.playlists[k], df = diffLabels(old.items.map(plLabel), pl.items.map(plLabel)), d = [];
          if (old.name !== pl.name) d.push({ k: 'Nome', from: old.name, to: pl.name }); if (df.add.length || df.del.length) d.push({ k: 'Itens', add: df.add, del: df.del });
          if (d.length) act('edit', 'alterou', 'a lista de reprodução', pl.name, d); }
        pl.created = k < 0 ? Date.now() : db.playlists[k].created || Date.now();
        pl.tags = 'tags' in b ? vt(b.tags, 'lists') : (k < 0 ? [] : db.playlists[k].tags || []);
        k < 0 ? db.playlists.push(pl) : (db.playlists[k] = pl); save(); return json(res, 200, pl);
      }
      if ((r = p.match(/^\/api\/playlists\/(\w+)$/)) && m === 'DELETE') {
        { const gone = db.playlists.find(x => x.id === r[1]); if (gone) act('del', 'removeu', 'a lista de reprodução', gone.name); }
        db.playlists = db.playlists.filter(x => x.id !== r[1]); db.screens.forEach(s => { if (s.playlistId === r[1]) s.playlistId = null; });
        db.layouts.forEach(l => [l.h, l.v].forEach(g => g.zones.forEach(z => { if (z.playlistId === r[1]) z.playlistId = null; })));
        save(); return json(res, 200, {});
      }
      if (p === '/api/activity' && m === 'GET') return json(res, 200, db.activity.slice(0, Math.min(200, +u.searchParams.get('limit') || 40)));
      if (p === '/api/history' && m === 'GET') { const hrs = Math.min(168, Math.max(1, +u.searchParams.get('hours') || 24)), now = Date.now();
        return json(res, 200, { now, slot: SLOT, slots: st.hist.filter(h => h.t >= now - hrs * 3600e3) }); }
      if (p === '/api/account' && m === 'POST') { const b = await readBody(req); db.account.name = String(b.name || '').trim().slice(0, 60); save(); return json(res, 200, db.account); }
      if (p === '/api/geocode' && m === 'GET') {
        const q = (u.searchParams.get('q') || '').trim().slice(0, 80); if (q.length < 2) return json(res, 200, []);
        try { const j = await getJ(`${OMG}/v1/search?name=${encodeURIComponent(q)}&count=6&language=pt&format=json`);
          return json(res, 200, (j.results || []).map(x => ({ name: x.name, region: x.admin1 || '', country: x.country || '', lat: x.latitude, lon: x.longitude }))); }
        catch (e) { return json(res, 502, { error: 'Não foi possível buscar a cidade: ' + e.message }); }
      }
      if (p === '/api/widget/test' && m === 'POST') {
        const b = await readBody(req);
        try { const e = b.kind === 'weather' ? await weather(vWeather(b.cfg)) : await news(vNews(b.cfg)); return json(res, 200, e.data); }
        catch (e) { return json(res, 502, { error: e.message }); }
      }
      if (p === '/api/layouts' && m === 'POST') {
        const b = await readBody(req), k = db.layouts.findIndex(x => x.id === b.id);
        const l = { id: k < 0 ? rid() : b.id, name: String(b.name || 'Layout sem nome').slice(0, 80), h: vg(b.h), v: vg(b.v), created: k < 0 ? Date.now() : db.layouts[k].created };
        act(k < 0 ? 'add' : 'edit', k < 0 ? 'criou' : 'alterou', 'o layout de zonas', l.name); k < 0 ? db.layouts.push(l) : (db.layouts[k] = l); save(); return json(res, 200, l);
      }
      if ((r = p.match(/^\/api\/layouts\/(\w+)$/)) && m === 'DELETE') {
        { const gone = db.layouts.find(x => x.id === r[1]); if (gone) act('del', 'removeu', 'o layout de zonas', gone.name); }
        db.layouts = db.layouts.filter(x => x.id !== r[1]); db.screens.forEach(s => { if (s.layoutId === r[1]) s.layoutId = null; });
        save(); return json(res, 200, {});
      }
      if (p === '/api/screens' && m === 'POST') {
        const b = await readBody(req);
        const dev = Object.keys(db.devices).find(k => db.devices[k].code === String(b.code).trim());
        if (!dev) return json(res, 404, { error: 'Código não encontrado. Confira o código exibido na tela.' });
        if (db.screens.some(s => s.device === dev)) return json(res, 409, { error: 'Esta tela já está pareada.' });
        db.screens.push({ id: rid(), device: dev, name: String(b.name || 'Nova tela').slice(0, 80), playlistId: b.playlistId || null, layoutId: db.layouts.some(l => l.id === b.layoutId) ? b.layoutId : null, rotation: 0, fit: 'contain', sound: false, created: Date.now(), ...clean(b) });
        act('add', 'vinculou', 'a tela', db.screens[db.screens.length - 1].name); save(); return json(res, 200, {});
      }
      if ((r = p.match(/^\/api\/screens\/(\w+)\/capture$/)) && m === 'POST') {
        const sc = db.screens.find(x => x.id === r[1]); if (!sc) return json(res, 404, { error: 'Tela não encontrada' });
        wantCap[sc.device] = Date.now(); return json(res, 200, {});
      }
      if ((r = p.match(/^\/api\/captures\/(\w+)$/)) && m === 'GET') return serve(req, res, path.join(CAPT, r[1] + '.jpg'));
      if ((r = p.match(/^\/api\/screens\/(\w+)$/))) {
        const s = db.screens.find(x => x.id === r[1]); if (!s) return json(res, 404, { error: 'Tela não encontrada' });
        if (m === 'PATCH') { const b = await readBody(req), before = JSON.stringify(s), oldPl = (db.playlists.find(x => x.id === s.playlistId) || {}).name || '—', oldLy = (db.layouts.find(x => x.id === s.layoutId) || {}).name || '—', oldName = s.name; if ('playlistId' in b) s.playlistId = b.playlistId || null; if ('layoutId' in b) s.layoutId = db.layouts.some(l => l.id === b.layoutId) ? b.layoutId : null; if (b.name) s.name = String(b.name).slice(0, 80); Object.assign(s, clean(b));
          if (JSON.stringify(s) !== before) { const d = [], npl = (db.playlists.find(x => x.id === s.playlistId) || {}).name || '—', nly = (db.layouts.find(x => x.id === s.layoutId) || {}).name || '—';
            if (oldName !== s.name) d.push({ k: 'Nome', from: oldName, to: s.name }); if (oldPl !== npl) d.push({ k: 'Lista de reprodução', from: oldPl, to: npl }); if (oldLy !== nly) d.push({ k: 'Layout de zonas', from: oldLy, to: nly });
            if (!d.length) d.push({ k: 'Configurações', from: '', to: 'atualizadas' }); act('edit', 'alterou', 'a tela', s.name, d); } }
        if (m === 'DELETE') { act('del', 'removeu', 'a tela', s.name); fs.rmSync(path.join(CAPT, s.id + '.jpg'), { force: true }); db.screens = db.screens.filter(x => x !== s); delete db.devices[s.device]; }
        save(); return json(res, 200, {});
      }
      return json(res, 404, { error: 'Rota não encontrada' });
    }
    const f = path.join(PUB, p === '/' ? 'index.html' : p);
    if (!f.startsWith(PUB)) { res.writeHead(403); return res.end(); }
    serve(req, res, f);
  } catch (e) { json(res, 500, { error: String(e.message || e) }); }
}).listen(PORT, process.env.HOST || '0.0.0.0', () => {
  console.log(process.env.ADMIN_PASS ? `Senha de admin definida (${PASS.length} caracteres)` : 'ADMIN_PASS não definida: a senha é "admin"');
  console.log(`Painel: http://localhost:${PORT}  |  Player: http://localhost:${PORT}/player.html`);
});
