'use strict';
// Cuentas de Colonos: registro con código por correo, login usuario/correo + contraseña, Google y sesiones.
// Sin dependencias. Variables de entorno (todas opcionales):
//   SMTP_HOST, SMTP_PORT (465 por defecto), SMTP_USER, SMTP_PASS, SMTP_FROM   -> envío real de correos
//   GOOGLE_CLIENT_ID                                                          -> botón "Continuar con Google"
//   YT_PLAYLIST                                                               -> enlace o ID de lista de YouTube
//   DATA_DIR                                                                  -> carpeta de users.json (por defecto ./data)
//   UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN                          -> guardar cuentas en Upstash (gratis) en vez de archivo
const { isBad } = require('./badwords.js');
const fs = require('fs'), path = require('path'), crypto = require('crypto'), tls = require('tls'), net = require('net'), { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);
const DIR = process.env.DATA_DIR || path.join(__dirname, 'data'), FILE = path.join(DIR, 'users.json');
const UP = process.env.UPSTASH_REDIS_REST_URL, UPT = process.env.UPSTASH_REDIS_REST_TOKEN;
let DB = { users: {}, sessions: {} };

// ---------- almacenamiento ----------
async function up(cmd) { const r = await fetch(UP, { method: 'POST', headers: { Authorization: 'Bearer ' + UPT }, body: JSON.stringify(cmd) }); return (await r.json()).result; }
const ready = (async () => {
  try {
    if (UP) { const s = await up(['GET', 'colonos_db']); if (s) DB = JSON.parse(s); }
    else DB = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch { }
  DB.users ||= {}; DB.sessions ||= {};
})();
let saveT = null, dirty = false;
function save() { dirty = true; if (saveT) return; saveT = setTimeout(flushAsync, 400); }
async function flushAsync() {
  saveT = null; if (!dirty) return; dirty = false;
  try {
    if (UP) await up(['SET', 'colonos_db', JSON.stringify(DB)]);
    else { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(FILE + '.tmp', JSON.stringify(DB)); fs.renameSync(FILE + '.tmp', FILE); }
  } catch (e) { console.error('No se pudieron guardar las cuentas:', e.message); }
}
function flushSync() { if (!dirty || UP) return; try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(DB)); } catch { } }
['SIGTERM', 'SIGINT'].forEach(s => process.on(s, () => { flushSync(); process.exit(0); }));

// ---------- utilidades ----------
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const normEmail = e => String(e || '').trim().toLowerCase();
// Devuelve un mensaje de error o null si el correo es válido
function emailError(e) {
  if (!e) return 'Escribe tu correo';
  if (/\s/.test(e)) return 'El correo no puede tener espacios';
  if (e.length > 254) return 'El correo es demasiado largo (máx. 254 caracteres)';
  if (e.length < 6) return 'El correo es demasiado corto';
  const at = e.split('@').length - 1;
  if (at === 0) return 'El correo debe incluir @';
  if (at > 1) return 'El correo solo puede tener un @';
  const [local, domain] = e.split('@');
  if (!local) return 'Falta lo que va antes del @';
  if (local.length > 64) return 'La parte antes del @ es demasiado larga (máx. 64)';
  if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)) return 'El correo tiene caracteres no permitidos';
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) return 'Los puntos del correo están mal colocados';
  if (!domain) return 'Falta el dominio después del @ (ejemplo: gmail.com)';
  if (!domain.includes('.')) return 'El dominio debe incluir un punto (ejemplo: gmail.com)';
  const labels = domain.split('.');
  if (labels.some(l => !l || l.length > 63 || !/^[a-z0-9-]+$/.test(l) || l.startsWith('-') || l.endsWith('-'))) return 'El dominio del correo no es válido';
  if (!/^([a-z]{2,24}|xn--[a-z0-9-]{2,})$/.test(labels[labels.length - 1])) return 'La terminación del correo no es válida (ejemplo: .com)';
  return null;
}
const okEmail = e => !emailError(e);
const okName = n => /^[\p{L}\p{N}_-]{3,16}$/u.test(n) && !/^bot\d*$/i.test(n);
const byEmail = e => Object.values(DB.users).find(u => u.email === e);
const byName = n => Object.values(DB.users).find(u => u.username.toLowerCase() === String(n).toLowerCase());
const pub = u => ({ id: u.id, username: u.username, email: u.email });
async function hashPw(pw, salt) { return (await scrypt(pw, salt, 32)).toString('hex'); }
async function checkPw(u, pw) {
  if (!u || !u.hash) return false;
  const h = await hashPw(String(pw), u.salt);
  return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(u.hash, 'hex'));
}
function newSession(uid) { const t = crypto.randomBytes(24).toString('hex'); DB.sessions[sha(t)] = { uid, exp: Date.now() + 30 * 864e5 }; save(); return t; }
function userFromToken(t) {
  if (!t) return null; const s = DB.sessions[sha(String(t))];
  if (!s || s.exp < Date.now()) return null; return DB.users[s.uid] || null;
}
const hits = new Map();
function limit(key, max, ms) { const n = Date.now(), h = hits.get(key); if (!h || n > h.t) { hits.set(key, { n: 1, t: n + ms }); return true; } return ++h.n <= max; }
setInterval(() => { const n = Date.now(); for (const [k, v] of hits) if (n > v.t) hits.delete(k); for (const [k, v] of codes) if (n > v.exp) codes.delete(k); for (const [k, v] of regs) if (n > v.exp) regs.delete(k); for (const [k, v] of rcodes) if (n > v.exp) rcodes.delete(k); for (const [k, v] of rlast) if (n - v > 3600e3) rlast.delete(k); for (const k in DB.sessions) if (DB.sessions[k].exp < n) delete DB.sessions[k]; }, 600e3).unref();

// ---------- correo (SMTP mínimo) ----------
const b64 = s => Buffer.from(s, 'utf8').toString('base64');
const smtpOn = () => !!process.env.SMTP_HOST;
async function sendMail(to, subject, text) {
  const host = process.env.SMTP_HOST, port = +(process.env.SMTP_PORT || 465), user = process.env.SMTP_USER, pass = process.env.SMTP_PASS;
  const from = (process.env.SMTP_FROM || user || 'colonos@localhost').replace(/^.*<|>.*$/g, '');
  let cur = await new Promise((ok, no) => {
    const s = port === 465 ? tls.connect({ host, port, servername: host }, () => ok(s)) : net.connect({ host, port }, () => ok(s));
    s.once('error', no); s.setTimeout(20000, () => { s.destroy(); no(new Error('SMTP timeout')); });
  });
  let buf = '', waiters = [];
  const pump = () => {
    if (!waiters.length) return; const lines = buf.split('\r\n');
    for (let i = 0; i < lines.length - 1; i++) if (/^\d{3} /.test(lines[i])) { const r = lines.slice(0, i + 1).join('\n'); buf = lines.slice(i + 1).join('\r\n'); waiters.shift()(r); return pump(); }
  };
  const onData = d => { buf += d.toString(); pump(); };
  cur.on('data', onData); cur.on('error', e => { while (waiters.length) waiters.shift()('ERR ' + e.message); });
  const expect = async code => { const r = await new Promise(ok => { waiters.push(ok); pump(); }); if (!r.split('\n').pop().startsWith(String(code))) throw new Error('SMTP: ' + r.split('\n').pop()); return r; };
  const cmd = async (c, code) => { cur.write(c + '\r\n'); return expect(code); };
  try {
    await expect(220);
    let r = await cmd('EHLO colonos', 250);
    if (port !== 465 && /STARTTLS/i.test(r)) {
      await cmd('STARTTLS', 220); cur.removeListener('data', onData);
      cur = tls.connect({ socket: cur, servername: host }); await new Promise((ok, no) => { cur.once('secureConnect', ok); cur.once('error', no); });
      buf = ''; cur.on('data', onData); r = await cmd('EHLO colonos', 250);
    }
    if (user) { await cmd('AUTH LOGIN', 334); await cmd(b64(user), 334); await cmd(b64(pass || ''), 235); }
    await cmd(`MAIL FROM:<${from}>`, 250); await cmd(`RCPT TO:<${to}>`, 250); await cmd('DATA', 354);
    const msg = [`From: Colonos <${from}>`, `To: <${to}>`, `Subject: =?UTF-8?B?${b64(subject)}?=`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', b64(text).match(/.{1,76}/g).join('\r\n')].join('\r\n');
    cur.write(msg + '\r\n.\r\n'); await expect(250); cur.write('QUIT\r\n');
  } finally { cur.destroy(); }
}

// ---------- códigos y registro ----------
const codes = new Map(), regs = new Map(), rcodes = new Map(), rlast = new Map();
const mkReg = (email, google) => { const t = crypto.randomBytes(18).toString('hex'); regs.set(t, { email, google: !!google, exp: Date.now() + 15 * 60e3 }); return t; };
function afterEmailProof(email, google) {
  const u = byEmail(email);
  if (u) return { token: newSession(u.id), user: pub(u), existing: true };
  return { regToken: mkReg(email, google), email };
}
function ytId(s) { s = String(s || '').trim(); if (!s) return null; const m = s.match(/[?&]list=([\w-]+)/); return m ? m[1] : /^[\w-]{10,}$/.test(s) ? s : null; }
const YT_DEFAULT = 'https://www.youtube.com/watch?v=LtWCFVz1f5Q&list=RDLtWCFVz1f5Q&start_radio=1';
const ytVideo = s => { const m = String(s || '').match(/[?&]v=([\w-]{11})/); return m ? m[1] : null; };
const config = () => { const src = process.env.YT_PLAYLIST || YT_DEFAULT; return { google: process.env.GOOGLE_CLIENT_ID || null, playlist: ytId(src), video: ytVideo(src), mail: smtpOn() }; };

async function route(req, res, p, m, json) {
  await ready;
  const ip = ((req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '?';
  const E = (s, c = 400) => json(res, { err: s }, c);
  if (p === '/api/auth/me') { const u = userFromToken(m.token); return u ? json(res, { user: pub(u) }) : E('Sesión caducada', 401); }
  if (p === '/api/auth/logout') { if (m.token) { delete DB.sessions[sha(String(m.token))]; save(); } return json(res, {}); }
  if (!limit('a' + ip, 60, 10 * 60e3)) return E('Demasiados intentos. Espera unos minutos.', 429);

  if (p === '/api/auth/request') {
    const email = normEmail(m.email), ee = emailError(email); if (ee) return E(ee);
    if (!limit('r' + ip, 10, 3600e3)) return E('Demasiados códigos solicitados. Inténtalo más tarde.', 429);
    const old = codes.get(email); if (old && Date.now() - old.last < 60e3) return E(`Espera ${Math.ceil((60e3 - (Date.now() - old.last)) / 1000)} s para pedir otro código`);
    const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
    codes.set(email, { code, exp: Date.now() + 10 * 60e3, tries: 0, last: Date.now() });
    if (!smtpOn()) { console.log(`[MODO PRUEBAS] Código para ${email}: ${code}`); return json(res, { ok: true, dev: true }); }
    try { await sendMail(email, 'Tu código de Colonos', `Tu código de verificación es: ${code}\n\nCaduca en 10 minutos. Si no lo pediste tú, ignora este mensaje.`); }
    catch (e) { console.error('Error enviando correo:', e.message); codes.delete(email); return E('No se pudo enviar el correo. Inténtalo más tarde.', 502); }
    return json(res, { ok: true });
  }
  if (p === '/api/auth/verify') {
    const email = normEmail(m.email), c = codes.get(email);
    if (!c || Date.now() > c.exp) return E('El código caducó. Pide uno nuevo.');
    if (c.tries >= 5) { codes.delete(email); return E('Demasiados intentos. Pide un código nuevo.'); }
    const a = Buffer.from(String(m.code || '').padEnd(6).slice(0, 6)), b = Buffer.from(c.code);
    if (!crypto.timingSafeEqual(a, b)) { c.tries++; return E('Código incorrecto'); }
    codes.delete(email); return json(res, afterEmailProof(email, false));
  }
  if (p === '/api/auth/reset-request') {
    const email = normEmail(m.email), ee = emailError(email); if (ee) return E(ee);
    if (!limit('q' + ip, 10, 3600e3)) return E('Demasiados intentos. Inténtalo más tarde.', 429);
    const last = rlast.get(email); if (last && Date.now() - last < 60e3) return E(`Espera ${Math.ceil((60e3 - (Date.now() - last)) / 1000)} s para pedir otro código`);
    rlast.set(email, Date.now());
    const u = byEmail(email);
    if (u) {
      const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
      rcodes.set(email, { code, exp: Date.now() + 10 * 60e3, tries: 0 });
      if (!smtpOn()) console.log(`[MODO PRUEBAS] Código para restablecer ${email}: ${code}`);
      else try { await sendMail(email, 'Restablecer contraseña de Colonos', `Tu código para restablecer la contraseña es: ${code}\n\nCaduca en 10 minutos. Si no lo pediste tú, ignora este mensaje: tu contraseña no cambiará.`); }
      catch (e) { console.error('Error enviando correo:', e.message); rcodes.delete(email); return E('No se pudo enviar el correo. Inténtalo más tarde.', 502); }
    }
    return json(res, { ok: true, dev: !smtpOn() });   // misma respuesta exista o no la cuenta
  }
  if (p === '/api/auth/reset') {
    const email = normEmail(m.email), c = rcodes.get(email), pw = String(m.password || '');
    if (!c || Date.now() > c.exp) return E('El código no es válido o caducó. Pide uno nuevo.');
    if (c.tries >= 5) { rcodes.delete(email); return E('Demasiados intentos. Pide un código nuevo.'); }
    if (pw.length < 6) return E('La contraseña debe tener al menos 6 caracteres');
    const a = Buffer.from(String(m.code || '').padEnd(6).slice(0, 6)), b = Buffer.from(c.code);
    if (!crypto.timingSafeEqual(a, b)) { c.tries++; return E('Código incorrecto'); }
    const u = byEmail(email); if (!u) return E('El código no es válido o caducó. Pide uno nuevo.');
    rcodes.delete(email); u.salt = crypto.randomBytes(16).toString('hex'); u.hash = await hashPw(pw, u.salt);
    for (const k in DB.sessions) if (DB.sessions[k].uid === u.id) delete DB.sessions[k];
    save(); return json(res, { token: newSession(u.id), user: pub(u) });
  }
  if (p === '/api/auth/register') {
    const r = regs.get(m.regToken); if (!r || Date.now() > r.exp) return E('La verificación caducó. Empieza de nuevo.');
    const name = String(m.username || '').trim(), pw = String(m.password || '');
    if (!okName(name)) return E('Nombre: 3-16 caracteres (letras, números, _ o -) y que no sea "BOT"');
    if (isBad(name)) return E('Ese nombre no está permitido. Elige otro.');
    if (byName(name)) return E('Ese nombre ya está en uso');
    if (byEmail(r.email)) return E('Ya existe una cuenta con ese correo');
    if (pw && pw.length < 6) return E('La contraseña debe tener al menos 6 caracteres');
    if (!pw && !r.google) return E('Escribe una contraseña (mín. 6 caracteres)');
    const u = { id: crypto.randomBytes(8).toString('hex'), username: name, email: r.email, created: Date.now() };
    if (pw) { u.salt = crypto.randomBytes(16).toString('hex'); u.hash = await hashPw(pw, u.salt); }
    DB.users[u.id] = u; regs.delete(m.regToken); save();
    return json(res, { token: newSession(u.id), user: pub(u) });
  }
  if (p === '/api/auth/login') {
    const id = String(m.id || '').trim(), u = id.includes('@') ? byEmail(normEmail(id)) : byName(id);
    if (!limit('l' + id.toLowerCase(), 10, 10 * 60e3)) return E('Demasiados intentos para esta cuenta. Espera unos minutos.', 429);
    if (!u || !(await checkPw(u, m.password))) return E('Usuario o contraseña incorrectos');
    return json(res, { token: newSession(u.id), user: pub(u) });
  }
  if (p === '/api/auth/google') {
    const cid = process.env.GOOGLE_CLIENT_ID; if (!cid) return E('Google no está configurado');
    try {
      const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(String(m.credential || '')));
      const t = await r.json();
      if (!r.ok || t.aud !== cid || String(t.email_verified) !== 'true' || !/accounts\.google\.com$/.test(t.iss || '') || !t.email) return E('No se pudo verificar tu cuenta de Google');
      return json(res, afterEmailProof(normEmail(t.email), true));
    } catch { return E('Error al contactar con Google', 502); }
  }
  return E('No encontrado', 404);
}
module.exports = { route, userFromToken, config, ready, _codes: codes, _rcodes: rcodes, _db: () => DB };
