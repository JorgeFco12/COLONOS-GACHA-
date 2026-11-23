'use strict';
// Colonos - servidor multijugador (sin dependencias). Uso: node server.js  (PORT=3000 por defecto)
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const acct = require('./auth.js');
const R = ['wood', 'brick', 'sheep', 'wheat', 'ore'];
const NAME = { wood: 'madera', brick: 'ladrillo', sheep: 'oveja', wheat: 'trigo', ore: 'mineral' };
const COST = { road: { wood: 1, brick: 1 }, settle: { wood: 1, brick: 1, sheep: 1, wheat: 1 }, city: { wheat: 2, ore: 3 }, dev: { sheep: 1, wheat: 1, ore: 1 } };
const COLORS = ['#d62828', '#1d6fd6', '#f4f4f4', '#f08a24', '#2a9d3f', '#8a3ffc', '#f2d00f', '#e84fa3'];
const mapOf = room => (room.players.length >= 5 || room.forceBig ? 'big' : 'std'); // 5+ jugadores => mapa grande
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const mk = (k, n) => Array(n).fill(k);
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, -1], [-1, 1]];

// ---------- TABLERO ----------
function buildBoard(big) {
  const rad = big ? 3 : 2, hexes = [];
  for (let q = -rad; q <= rad; q++) for (let r = -rad; r <= rad; r++) if (Math.abs(q + r) <= rad) hexes.push({ q, r });
  const kinds = big
    ? [...mk('wood', 8), ...mk('sheep', 8), ...mk('wheat', 7), ...mk('brick', 6), ...mk('ore', 6), ...mk('desert', 2)]
    : [...mk('wood', 4), ...mk('sheep', 4), ...mk('wheat', 4), ...mk('brick', 3), ...mk('ore', 3), 'desert'];
  const base = [2, 3, 3, 4, 4, 5, 5, 6, 6, 8, 8, 9, 9, 10, 10, 11, 11, 12];
  const nd = kinds.filter(k => k !== 'desert').length;
  let nums = []; while (nums.length < nd) nums.push(...base); nums = nums.slice(0, nd);
  let tries = 0, ok;
  do {
    shuffle(kinds); shuffle(nums); let k = 0;
    hexes.forEach((h, i) => { h.kind = kinds[i]; h.num = h.kind === 'desert' ? 0 : nums[k++]; });
    const at = {}; hexes.forEach(h => at[h.q + ',' + h.r] = h);
    const red = n => n === 6 || n === 8;
    ok = !hexes.some(h => red(h.num) && DIRS.some(([a, b]) => { const o = at[(h.q + a) + ',' + (h.r + b)]; return o && red(o.num); }));
  } while (!ok && ++tries < 500);
  const V = [], E = [], vk = {}, ek = {};
  const vid = (x, y) => { const k = Math.round(x * 100) + ',' + Math.round(y * 100); if (vk[k] === undefined) { vk[k] = V.length; V.push({ x, y, adj: [], port: null }); } return vk[k]; };
  hexes.forEach((h, hi) => {
    h.x = Math.sqrt(3) * (h.q + h.r / 2); h.y = 1.5 * h.r; h.v = [];
    for (let i = 0; i < 6; i++) { const a = (60 * i - 30) * Math.PI / 180; h.v.push(vid(h.x + Math.cos(a), h.y + Math.sin(a))); }
    for (let i = 0; i < 6; i++) {
      const a = h.v[i], b = h.v[(i + 1) % 6], k = Math.min(a, b) + '-' + Math.max(a, b);
      if (ek[k] === undefined) { ek[k] = E.length; E.push({ a, b, hexes: [] }); V[a].adj.push([b, ek[k]]); V[b].adj.push([a, ek[k]]); }
      E[ek[k]].hexes.push(hi);
    }
  });
  const ang = i => Math.atan2((V[E[i].a].y + V[E[i].b].y) / 2, (V[E[i].a].x + V[E[i].b].x) / 2);
  const coast = E.map((e, i) => i).filter(i => E[i].hexes.length === 1).sort((i, j) => ang(i) - ang(j));
  const cnt = big ? 14 : 9;
  const types = shuffle([...mk('any', cnt - 5), ...R]);
  const ports = types.map((t, i) => { const e = coast[Math.floor(i * coast.length / cnt)]; V[E[e].a].port = t; V[E[e].b].port = t; return { e, type: t }; });
  return { hexes, V, E, ports };
}

// ---------- PARTIDA ----------
function startGame(room) {
  room.map = mapOf(room); const big = room.map === 'big', n = room.players.length;
  const board = buildBoard(big), ids = [...Array(n).keys()];
  const g = {
    board, b: { v: {}, e: {} }, bank: {}, deck: [], turn: 0, rolled: false, pend: null, phase: 'setup',
    setup: { i: 0, step: 's', v: null }, order: [...ids, ...ids.slice().reverse()], log: [], turnNo: 0,
    robber: board.hexes.findIndex(h => h.kind === 'desert'), longest: null, army: null, offer: null, dice: null, devPlayed: false, vpWin: room.settings.vp, lens: mk(0, n), winner: null, deadline: 0, chat: [],
  };
  R.forEach(r => g.bank[r] = big ? 30 : 19);
  const D = { knight: 14, vp: 5, rb: 2, yop: 2, mono: 2 };
  for (const k in D) for (let i = 0; i < D[k] * (big ? 2 : 1); i++) g.deck.push(k);
  shuffle(g.deck);
  room.players.forEach(p => { p.res = Object.fromEntries(R.map(r => [r, 0])); p.dev = []; p.knights = 0; });
  room.g = g; g.turn = g.order[0];
  log(g, `¡Empieza la partida! Mapa ${big ? 'Grande (5-8 jugadores)' : 'Clásico'} · ${g.vpWin} puntos para ganar. ${room.players[g.turn].name} coloca primero.`);
  setDeadline(room);
}
const log = (g, t) => { g.log.push(t); if (g.log.length > 80) g.log.shift(); };
const cardCount = p => R.reduce((s, r) => s + p.res[r], 0);
const has = (p, c) => Object.keys(c).every(r => p.res[r] >= c[r]);
const pay = (g, p, c) => { for (const r in c) { p.res[r] -= c[r]; g.bank[r] += c[r]; } };
const count = (g, pi, city) => Object.values(g.b.v).filter(b => b.p === pi && !!b.city === city).length;
const roadsOf = (g, pi) => Object.values(g.b.e).filter(p => p === pi).length;

function canSettle(g, pi, v, setup) {
  if (g.b.v[v]) return false;
  if (g.board.V[v].adj.some(([n]) => g.b.v[n])) return false;
  return setup || g.board.V[v].adj.some(([, e]) => g.b.e[e] === pi);
}
function canRoad(g, pi, e, from) {
  if (g.b.e[e] !== undefined) return false;
  const E = g.board.E[e];
  if (from !== undefined && from !== null) return E.a === from || E.b === from;
  return [E.a, E.b].some(v => { const o = g.b.v[v]; if (o) return o.p === pi; return g.board.V[v].adj.some(([, e2]) => e2 !== e && g.b.e[e2] === pi); });
}
function roadLen(g, pi) {
  const adj = {}; let best = 0;
  Object.keys(g.b.e).filter(e => g.b.e[e] === pi).forEach(e => { const E = g.board.E[e]; (adj[E.a] ??= []).push([+e, E.b]); (adj[E.b] ??= []).push([+e, E.a]); });
  const dfs = (v, used, len) => {
    best = Math.max(best, len);
    for (const [e, n] of adj[v] || []) {
      if (used.has(e)) continue; used.add(e);
      const o = g.b.v[n];
      if (o && o.p !== pi) best = Math.max(best, len + 1); else dfs(n, used, len + 1);
      used.delete(e);
    }
  };
  Object.keys(adj).forEach(v => dfs(+v, new Set(), 0));
  return best;
}
function awards(g, room) {
  g.lens = room.players.map((_, i) => roadLen(g, i));
  const mx = Math.max(...g.lens);
  if (mx >= 5) {
    const top = g.lens.map((l, i) => l === mx ? i : -1).filter(i => i >= 0);
    if (!(g.longest !== null && top.includes(g.longest))) {
      const prev = g.longest; g.longest = top.length === 1 ? top[0] : null;
      if (g.longest !== null && g.longest !== prev) log(g, `${room.players[g.longest].name} tiene la Ruta más larga (${mx}).`);
    }
  } else g.longest = null;
}
const pubVP = (g, i) => Object.values(g.b.v).filter(b => b.p === i).reduce((s, b) => s + (b.city ? 2 : 1), 0) + (g.longest === i ? 2 : 0) + (g.army === i ? 2 : 0);
const totVP = (g, room, i) => pubVP(g, i) + room.players[i].dev.filter(c => c.t === 'vp').length;
const ratio = (g, pi, r) => {
  let best = 4;
  for (const [v, b] of Object.entries(g.b.v)) if (b.p === pi) { const pt = g.board.V[v].port; if (pt === r) best = Math.min(best, 2); else if (pt === 'any') best = Math.min(best, 3); }
  return best;
};

function produce(g, room, roll) {
  const gain = {};
  g.board.hexes.forEach((h, hi) => {
    if (h.num !== roll || hi === g.robber) return;
    h.v.forEach(v => { const b = g.b.v[v]; if (!b) return; ((gain[b.p] ??= {})[h.kind] ??= 0); gain[b.p][h.kind] += b.city ? 2 : 1; });
  });
  for (const r of R) {
    const ps = Object.keys(gain).filter(p => gain[p][r]), tot = ps.reduce((s, p) => s + gain[p][r], 0);
    if (!ps.length) continue;
    if (tot <= g.bank[r]) ps.forEach(p => { room.players[p].res[r] += gain[p][r]; g.bank[r] -= gain[p][r]; log(g, `${room.players[p].name} recibe ${gain[p][r]} ${NAME[r]}.`); });
    else if (ps.length === 1) { const x = g.bank[r]; room.players[ps[0]].res[r] += x; g.bank[r] = 0; if (x) log(g, `${room.players[ps[0]].name} recibe ${x} ${NAME[r]} (banco agotado).`); }
    else log(g, `Banco sin ${NAME[r]} suficiente: nadie recibe.`);
  }
}
function steal(g, room, thief, victim) {
  const V = room.players[victim], cards = R.flatMap(r => mk(r, V.res[r]));
  if (cards.length) { const r = cards[Math.floor(Math.random() * cards.length)]; V.res[r]--; room.players[thief].res[r]++; log(g, `${room.players[thief].name} roba una carta a ${V.name}.`); }
  g.pend = null;
}
function afterRobber(g, room, pi) {
  const vs = new Set();
  g.board.hexes[g.robber].v.forEach(v => { const b = g.b.v[v]; if (b && b.p !== pi && cardCount(room.players[b.p]) > 0) vs.add(b.p); });
  const l = [...vs];
  if (l.length === 0) g.pend = null; else if (l.length === 1) steal(g, room, pi, l[0]); else g.pend = { t: 'steal', victims: l };
}

// ---------- ACCIONES ----------
function act(room, pi, m) {
  const g = room.g, P = room.players[pi], n = room.players.length, E = s => ({ err: s });
  if (!g) return E('La partida no ha empezado');
  if (m.type === 'chat') { const t = String(m.text || '').trim().slice(0, 200); if (t) { g.chat.push(`${P.name}: ${t}`); if (g.chat.length > 60) g.chat.shift(); } return; }
  if (g.phase === 'over') return E('Partida terminada');
  if (g.pend && g.pend.t === 'discard') {
    if (m.type !== 'discard') return E('Hay jugadores descartando');
    const need = g.pend.need[pi]; if (!need) return E('Tú no descartas');
    const d = m.res || {}; let tot = 0;
    for (const r of R) { const x = d[r] | 0; if (x < 0 || x > P.res[r]) return E('Cantidad inválida'); tot += x; }
    if (tot !== need) return E(`Descarta exactamente ${need}`);
    R.forEach(r => { P.res[r] -= d[r] | 0; g.bank[r] += d[r] | 0; });
    delete g.pend.need[pi]; log(g, `${P.name} descarta ${need} cartas.`);
    if (!Object.keys(g.pend.need).length) g.pend = { t: 'robber' };
    return;
  }
  if (m.type === 'decline') {
    const o = g.offer; if (!o || o.from === pi) return E('Sin oferta');
    if (!o.declined.includes(pi)) o.declined.push(pi);
    if (o.declined.length >= n - 1) { log(g, `Todos rechazaron la oferta de ${room.players[o.from].name}.`); g.offer = null; }
    else log(g, `${P.name} rechaza la oferta.`);
    return;
  }
  if (m.type === 'accept') {
    const o = g.offer; if (!o || o.from === pi || (o.to !== null && o.to !== pi)) return E('Sin oferta');
    const A = room.players[o.from];
    if (!has(A, o.give) || !has(P, o.get)) return E('Recursos insuficientes');
    for (const r of R) { A.res[r] += (o.get[r] || 0) - (o.give[r] || 0); P.res[r] += (o.give[r] || 0) - (o.get[r] || 0); }
    log(g, `${A.name} y ${P.name} intercambian.`); g.offer = null; return;
  }
  if (g.turn !== pi) return E('No es tu turno');

  if (g.phase === 'setup') {
    const s = g.setup;
    if (s.step === 's' && m.type === 'settle') {
      if (!canSettle(g, pi, m.v, true)) return E('Posición inválida');
      g.b.v[m.v] = { p: pi, city: false }; s.v = m.v; s.step = 'r';
      if (s.i >= n) g.board.hexes.forEach(h => { if (h.v.includes(m.v) && h.kind !== 'desert' && g.bank[h.kind] > 0) { P.res[h.kind]++; g.bank[h.kind]--; } });
      return;
    }
    if (s.step === 'r' && m.type === 'road') {
      if (!canRoad(g, pi, m.e, s.v)) return E('Debe tocar tu poblado');
      g.b.e[m.e] = pi; s.i++; awards(g, room);
      if (s.i >= g.order.length) { g.phase = 'main'; g.turn = 0; log(g, `Empieza ${room.players[0].name}.`); }
      else { g.turn = g.order[s.i]; s.step = 's'; s.v = null; }
      return;
    }
    return E('Coloca un poblado y una carretera');
  }

  if (g.pend) {
    const p = g.pend;
    if (p.t === 'robber' && m.type === 'robber') {
      const h = m.h | 0; if (h < 0 || h >= g.board.hexes.length || h === g.robber) return E('Mueve el ladrón a otra casilla');
      g.robber = h; log(g, `${P.name} mueve el ladrón.`); afterRobber(g, room, pi); return;
    }
    if (p.t === 'steal' && m.type === 'steal') { if (!p.victims.includes(m.p)) return E('Víctima inválida'); steal(g, room, pi, m.p); return; }
    if (p.t === 'rb') {
      if (m.type === 'road') {
        if (!canRoad(g, pi, m.e) || roadsOf(g, pi) >= 15) return E('Carretera inválida');
        g.b.e[m.e] = pi; awards(g, room); if (--p.left <= 0) g.pend = null; return;
      }
      if (m.type === 'skip') { g.pend = null; return; }
    }
    return E('Resuelve la acción pendiente');
  }

  switch (m.type) {
    case 'roll': {
      if (g.rolled) return E('Ya tiraste');
      const a = 1 + Math.floor(Math.random() * 6), b = 1 + Math.floor(Math.random() * 6); g.dice = [a, b]; g.rolled = true;
      log(g, `${P.name} saca ${a + b}.`);
      if (a + b === 7) {
        const need = {}; room.players.forEach((q, i) => { const c = cardCount(q); if (c > 7) need[i] = Math.floor(c / 2); });
        g.pend = Object.keys(need).length ? { t: 'discard', need } : { t: 'robber' };
      } else produce(g, room, a + b);
      return;
    }
    case 'build': {
      if (!g.rolled) return E('Tira los dados primero');
      const k = m.kind;
      if (k === 'road') {
        if (roadsOf(g, pi) >= 15) return E('Sin carreteras'); if (!has(P, COST.road)) return E('Faltan recursos'); if (!canRoad(g, pi, m.e)) return E('Posición inválida');
        pay(g, P, COST.road); g.b.e[m.e] = pi; awards(g, room);
      } else if (k === 'settle') {
        if (count(g, pi, false) >= 5) return E('Sin poblados'); if (!has(P, COST.settle)) return E('Faltan recursos'); if (!canSettle(g, pi, m.v, false)) return E('Posición inválida');
        pay(g, P, COST.settle); g.b.v[m.v] = { p: pi, city: false }; awards(g, room);
      } else if (k === 'city') {
        const b = g.b.v[m.v]; if (!b || b.p !== pi || b.city) return E('Necesitas un poblado tuyo');
        if (count(g, pi, true) >= 4) return E('Sin ciudades'); if (!has(P, COST.city)) return E('Faltan recursos');
        pay(g, P, COST.city); b.city = true;
      } else return E('Construcción desconocida');
      return;
    }
    case 'buyDev': {
      if (!g.rolled) return E('Tira los dados primero'); if (!g.deck.length) return E('Mazo vacío'); if (!has(P, COST.dev)) return E('Faltan recursos');
      pay(g, P, COST.dev); P.dev.push({ t: g.deck.pop(), turn: g.turnNo }); log(g, `${P.name} compra una carta de desarrollo.`); return;
    }
    case 'playDev': {
      const i = P.dev.findIndex(c => c.t === m.card && c.turn < g.turnNo && c.t !== 'vp');
      if (i < 0) return E('No puedes jugar esa carta'); if (g.devPlayed) return E('Solo una carta por turno');
      if (m.card !== 'knight' && !g.rolled) return E('Tira los dados primero');
      if (m.card === 'yop') { if (!R.includes(m.a) || !R.includes(m.b)) return E('Elige 2 recursos'); const need = {}; need[m.a] = (need[m.a] || 0) + 1; need[m.b] = (need[m.b] || 0) + 1; if (!Object.keys(need).every(r => g.bank[r] >= need[r])) return E('El banco no tiene eso'); R.forEach(r => { if (need[r]) { g.bank[r] -= need[r]; P.res[r] += need[r]; } }); }
      else if (m.card === 'mono') { if (!R.includes(m.a)) return E('Elige recurso'); let t = 0; room.players.forEach((q, j) => { if (j !== pi) { t += q.res[m.a]; q.res[m.a] = 0; } }); P.res[m.a] += t; log(g, `${P.name} monopoliza ${NAME[m.a]} (${t}).`); }
      else if (m.card === 'rb') { g.pend = { t: 'rb', left: Math.min(2, 15 - roadsOf(g, pi)) }; if (g.pend.left <= 0) g.pend = null; }
      else if (m.card === 'knight') { P.knights++; g.pend = { t: 'robber' }; log(g, `${P.name} juega un Caballero.`); if (P.knights >= 3 && (g.army === null || P.knights > room.players[g.army].knights) && g.army !== pi) { g.army = pi; log(g, `${P.name} tiene el Ejército más grande.`); } }
      P.dev.splice(i, 1); g.devPlayed = true; return;
    }
    case 'bank': {
      if (!g.rolled) return E('Tira los dados primero');
      if (!R.includes(m.give) || !R.includes(m.get) || m.give === m.get) return E('Intercambio inválido');
      const x = ratio(g, pi, m.give); if (P.res[m.give] < x) return E('Faltan recursos'); if (g.bank[m.get] < 1) return E('Banco vacío');
      P.res[m.give] -= x; g.bank[m.give] += x; g.bank[m.get]--; P.res[m.get]++; log(g, `${P.name} cambia ${x} ${NAME[m.give]} por 1 ${NAME[m.get]}.`); return;
    }
    case 'offer': {
      if (!g.rolled) return E('Tira los dados primero');
      const clean = o => Object.fromEntries(R.filter(r => (o?.[r] | 0) > 0).map(r => [r, o[r] | 0]));
      const give = clean(m.give), get = clean(m.get);
      if (!Object.keys(give).length || !Object.keys(get).length) return E('Oferta vacía'); if (!has(P, give)) return E('No tienes eso');
      if (R.some(r => give[r] && get[r])) return E('No puedes ofrecer y pedir lo mismo');
      g.offer = { from: pi, to: null, give, get, declined: [] }; log(g, `${P.name} propone un intercambio.`); return;
    }
    case 'cancel': g.offer = null; return;
    case 'end': {
      if (!g.rolled) return E('Tira los dados primero');
      g.offer = null; g.turn = (g.turn + 1) % n; g.rolled = false; g.devPlayed = false; g.dice = null; g.turnNo++; log(g, `Turno de ${room.players[g.turn].name}.`); return;
    }
  }
  return E('Acción desconocida');
}
function checkWin(room) {
  const g = room.g; if (!g || g.phase !== 'main') return;
  const i = g.turn, v = totVP(g, room, i);
  if (v >= g.vpWin) { g.phase = 'over'; g.winner = i; log(g, `🏆 ¡${room.players[i].name} gana con ${v} puntos!`); }
}

// ---------- VISTAS ----------
function legal(g, pi) {
  const L = { s: [], c: [], r: [], h: [] };
  if (g.turn !== pi) return L;
  const B = g.board;
  if (g.phase === 'setup') {
    if (g.setup.step === 's') B.V.forEach((_, v) => canSettle(g, pi, v, true) && L.s.push(v));
    else B.E.forEach((_, e) => canRoad(g, pi, e, g.setup.v) && L.r.push(e));
    return L;
  }
  if (g.phase !== 'main') return L;
  if (g.pend?.t === 'robber') { B.hexes.forEach((_, h) => h !== g.robber && L.h.push(h)); return L; }
  if (g.pend && g.pend.t !== 'rb') return L;
  B.E.forEach((_, e) => canRoad(g, pi, e) && L.r.push(e));
  if (g.pend) return L;
  B.V.forEach((_, v) => { if (canSettle(g, pi, v, false)) L.s.push(v); const b = g.b.v[v]; if (b && b.p === pi && !b.city) L.c.push(v); });
  return L;
}
function view(room, pi, withBoard) {
  const base = { code: room.code, host: room.host, me: pi, map: room.g ? room.map : mapOf(room), forceBig: !!room.forceBig, settings: room.settings, phase: room.g ? room.g.phase : 'lobby',
    players: room.players.map((p, i) => ({ name: p.name, color: p.color, online: room.conn.has(i), ready: !!p.ready, guest: !!p.guest })) };
  const g = room.g; if (!g) return base;
  const B = g.board, me = room.players[pi];
  if (withBoard) base.board = { hexes: B.hexes.map(h => ({ x: h.x, y: h.y, kind: h.kind, num: h.num })), V: B.V.map(v => ({ x: v.x, y: v.y })), E: B.E.map(e => ({ a: e.a, b: e.b })), ports: B.ports };
  base.players = room.players.map((p, i) => ({ name: p.name, color: p.color, online: room.conn.has(i), cards: cardCount(p), dev: p.dev.length, knights: p.knights, vp: pubVP(g, i), road: g.lens[i], roads: roadsOf(g, i), set: count(g, i, false), city: count(g, i, true) }));
  Object.assign(base, {
    b: g.b, robber: g.robber, dice: g.dice, turn: g.turn, rolled: g.rolled, longest: g.longest, army: g.army, winner: g.winner, setup: g.phase === 'setup' ? g.setup.step : null,
    tn: g.phase === 'setup' ? 's' + g.setup.i : g.turnNo, left: g.deadline ? Math.max(0, g.deadline - Date.now()) : 0, turnTime: room.settings.turnTime,
    final: g.phase === 'over' ? room.players.map((p, i) => ({ name: p.name, color: p.color, pub: pubVP(g, i), hid: p.dev.filter(c => c.t === 'vp').length, total: totVP(g, room, i) })).sort((a, b) => b.total - a.total || b.pub - a.pub) : null,
    chat: g.chat.slice(-40), bank: g.bank, deckLeft: g.deck.length, log: g.log.slice(-40), offer: g.offer, vpWin: g.vpWin,
    res: me.res, devs: me.dev.map(c => ({ t: c.t, ok: c.turn < g.turnNo && c.t !== 'vp' })), myVP: totVP(g, room, pi), devPlayed: g.devPlayed,
    ratios: Object.fromEntries(R.map(r => [r, ratio(g, pi, r)])),
    pend: g.pend ? { t: g.pend.t, need: g.pend.need ? g.pend.need[pi] || 0 : undefined, waiting: g.pend.need ? Object.keys(g.pend.need).map(Number) : undefined, victims: g.pend.victims, left: g.pend.left } : null,
    legal: legal(g, pi),
  });
  return base;
}

// ---------- CRONÓMETRO ----------
const sig = g => g.turn + '|' + g.phase + '|' + (g.setup ? g.setup.step : '') + '|' + (g.pend ? g.pend.t : '');
function setDeadline(room) { const g = room.g, t = room.settings.turnTime; g.deadline = t && g.phase !== 'over' ? Date.now() + t * 1000 : 0; }
function autoPlay(room) {
  const g = room.g; if (!g || g.phase === 'over') return;
  const rnd = a => a[Math.floor(Math.random() * a.length)];
  const resolve = () => {
    let guard = 0;
    while (g.pend && guard++ < 60) {
      const p = g.pend;
      if (p.t === 'discard') {
        for (const k of Object.keys(p.need)) {
          const P = room.players[k], d = {}; const cards = shuffle(R.flatMap(r => mk(r, P.res[r])));
          cards.slice(0, p.need[k]).forEach(r => d[r] = (d[r] || 0) + 1); act(room, +k, { type: 'discard', res: d });
        }
      } else if (p.t === 'robber') act(room, g.turn, { type: 'robber', h: rnd(legal(g, g.turn).h) });
      else if (p.t === 'steal') act(room, g.turn, { type: 'steal', p: rnd(p.victims) });
      else if (p.t === 'rb') act(room, g.turn, { type: 'skip' });
      else break;
    }
  };
  const pi = g.turn;
  if (g.phase === 'setup') {
    let L = legal(g, pi);
    if (g.setup.step === 's') { act(room, pi, { type: 'settle', v: rnd(L.s) }); L = legal(g, pi); }
    act(room, pi, { type: 'road', e: rnd(L.r) });
  } else {
    resolve();
    if (!g.rolled) act(room, pi, { type: 'roll' });
    resolve();
    if (!g.pend) act(room, pi, { type: 'end' });
  }
  log(g, `⏱ Tiempo agotado: jugada automática de ${room.players[pi].name}.`);
}
setInterval(() => {
  for (const room of Object.values(rooms)) {
    const g = room.g; if (!g || g.phase === 'over' || !g.deadline || Date.now() < g.deadline + 300) continue;
    try { autoPlay(room); checkWin(room); setDeadline(room); broadcast(room); } catch (e) { console.error(e); g.deadline = 0; }
  }
}, 1000).unref();

// ---------- SERVIDOR ----------
const rooms = {};
const renumber = room => room.players.forEach((p, i) => { if (p.guest) p.name = 'BOT' + (i + 1); });
const newCode = () => { let c; do c = Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.floor(Math.random() * 24)]).join(''); while (rooms[c]); return c; };
function broadcast(room) {
  room.t = Date.now();
  for (const [i, c] of room.conn) {
    const withBoard = !!room.g && !c.boardSent; if (withBoard) c.boardSent = true;
    try { c.res.write(`data: ${JSON.stringify(view(room, i, withBoard))}\n\n`); } catch { }
  }
}
const body = req => new Promise(ok => { let d = ''; req.on('data', c => { d += c; if (d.length > 1e5) req.destroy(); }); req.on('end', () => { try { ok(JSON.parse(d || '{}')); } catch { ok({}); } }); });
const json = (res, o, s = 200) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
const auth = (code, token) => { const room = rooms[(code || '').toUpperCase()]; if (!room) return {}; const pi = room.players.findIndex(p => p.token === token); return pi < 0 ? {} : { room, pi }; };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && url.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(fs.readFileSync(path.join(__dirname, 'public', 'index.html'))); }
    if (req.method === 'GET' && url.pathname === '/api/events') {
      const { room, pi } = auth(url.searchParams.get('code'), url.searchParams.get('token'));
      if (!room) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      const old = room.conn.get(pi); if (old) old.res.end();
      const c = { res, boardSent: false, token: room.players[pi].token }; room.conn.set(pi, c);
      const ka = setInterval(() => res.write(': ping\n\n'), 20000);
      req.on('close', () => { clearInterval(ka); if (room.conn.get(pi) === c) { room.conn.delete(pi); broadcast(room); } });
      return broadcast(room);
    }
    if (req.method === 'GET' && url.pathname === '/api/config') return json(res, acct.config());
    if (req.method === 'GET' && url.pathname === '/api/rooms') {
      return json(res, Object.values(rooms).filter(r => !r.g).map(r => ({ code: r.code, host: r.players[r.host].name, n: r.players.length, big: mapOf(r) === 'big' })));
    }
    if (req.method === 'POST') {
      const m = await body(req);
      if (url.pathname.startsWith('/api/auth/')) return await acct.route(req, res, url.pathname, m, json);
      if (url.pathname === '/api/create') {
        const who = m.guest ? null : acct.userFromToken(m.auth);
        if (!m.guest && !who) return json(res, { err: 'Inicia sesión o entra como invitado' }, 401);
        const code = newCode(), token = crypto.randomBytes(12).toString('hex');
        rooms[code] = { code, map: 'std', forceBig: false, settings: { turnTime: 60, vp: 10 }, t: Date.now(), host: 0, players: [{ name: who ? who.username : 'BOT1', guest: !who, uid: who ? who.id : null, ready: false, color: COLORS[0], token }], conn: new Map(), g: null };
        return json(res, { code, token });
      }
      if (url.pathname === '/api/join') {
        const room = rooms[(m.code || '').toUpperCase()]; if (!room) return json(res, { err: 'Sala no encontrada' }, 404);
        if (room.g) return json(res, { err: 'La partida ya empezó' }, 400);
        if (room.players.length >= 8) return json(res, { err: 'Sala llena' }, 400);
        const who = m.guest ? null : acct.userFromToken(m.auth);
        if (!m.guest && !who) return json(res, { err: 'Inicia sesión o entra como invitado' }, 401);
        if (who && room.players.some(p => p.uid === who.id)) return json(res, { err: 'Ya estás en esta sala con esa cuenta' }, 400);
        const token = crypto.randomBytes(12).toString('hex');
        room.players.push({ name: who ? who.username : 'BOT', guest: !who, uid: who ? who.id : null, ready: false, color: COLORS[room.players.length], token });
        renumber(room); broadcast(room); return json(res, { code: room.code, token });
      }
      if (url.pathname === '/api/leave') {
        const { room, pi } = auth(m.code, m.token); if (!room) return json(res, {});
        const c = room.conn.get(pi); if (c) { room.conn.delete(pi); try { c.res.end(); } catch { } }
        if (room.g && room.g.phase === 'over') { if (!room.conn.size) delete rooms[room.code]; return json(res, {}); }
        if (!room.g) {
          const hostTok = room.players[room.host].token;
          room.players.splice(pi, 1);
          if (!room.players.length) { delete rooms[room.code]; return json(res, {}); }
          room.players.forEach((p, i) => p.color = COLORS[i]); renumber(room);
          room.host = pi === room.host ? 0 : room.players.findIndex(p => p.token === hostTok);
          const old = [...room.conn.values()]; room.conn = new Map();
          old.forEach(x => { const i = room.players.findIndex(p => p.token === x.token); if (i >= 0) room.conn.set(i, x); });
        }
        broadcast(room); return json(res, {});
      }
      if (url.pathname === '/api/act') {
        const { room, pi } = auth(m.code, m.token); if (!room) return json(res, { err: 'Sesión inválida' }, 403);
        let r;
        if (m.type === 'force') { if (pi !== room.host || room.g) return json(res, { err: 'No permitido' }); room.forceBig = !!m.on; }
        else if (m.type === 'ready') { if (room.g) return json(res, {}); room.players[pi].ready = !!m.on; }
        else if (m.type === 'settings') {
          if (pi !== room.host || room.g) return json(res, { err: 'No permitido' });
          if ([0, 15, 30, 45, 60].includes(+m.turnTime) && m.turnTime !== undefined) room.settings.turnTime = +m.turnTime;
          if (m.vp !== undefined && +m.vp >= 6 && +m.vp <= 15) room.settings.vp = +m.vp | 0;
        }
        else if (m.type === 'start') {
          if (pi !== room.host || room.g) return json(res, { err: 'No permitido' });
          if (room.players.length < 2) return json(res, { err: 'Mínimo 2 jugadores' });
          if (room.players.some(p => !p.ready)) return json(res, { err: 'Todos los jugadores deben estar listos' });
          startGame(room);
        } else { const b = room.g ? sig(room.g) : ''; r = act(room, pi, m); if (!r) { checkWin(room); if (room.g && sig(room.g) !== b) setDeadline(room); } }
        broadcast(room); return json(res, r || {});
      }
    }
    res.writeHead(404); res.end();
  } catch (e) { console.error(e); res.writeHead(500); res.end(); }
});
setInterval(() => { for (const k in rooms) { const r = rooms[k], idle = Date.now() - r.t; if ((!r.conn.size && idle > 3 * 3600e3) || (r.g && r.g.phase === 'over' && idle > 1800e3)) delete rooms[k]; } }, 600e3).unref();
if (require.main === module) acct.ready.then(() => server.listen(process.env.PORT || 3000, () => console.log('Colonos en puerto ' + (process.env.PORT || 3000))));
module.exports = { server, autoPlay, setDeadline, buildBoard, startGame, act, view, rooms, canSettle, canRoad, checkWin };
