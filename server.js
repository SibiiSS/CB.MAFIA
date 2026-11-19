const http = require('http'), fs = require('fs'), path = require('path');
const { Server } = require('socket.io');
const PAGE = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
const server = http.createServer((req, res) => {
  if (req.url === '/ads.txt') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('google.com, pub-4787504381562454, DIRECT, f08c47fec0942fa0\n'); return; }
  if (req.url === '/health') { res.end('ok'); return; }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(PAGE);
});
const io = new Server(server);
const rooms = new Map();
const MIN_PLAYERS = 5, ROLE_MS = 10000, MORNING_MS = 30000, RESULT_MS = 8000, GRACE_MS = 60000, EARN = 10, SALARY = 2;
const GAME = ['night', 'morning', 'vote', 'voteResult'];
const uid = () => Math.random().toString(36).slice(2, 10);
const price = r => Math.max(5, Math.round((2.5 * r.n0 * Math.pow(1.25, r.revives)) / 5) * 5);

function setTimer(room, ms, fn) { clearTimeout(room.timer); room.deadline = Date.now() + ms; room.timer = setTimeout(fn, ms); }
const alive = r => r.players.filter(p => !p.out && p.alive);
const inGame = r => r.players.filter(p => !p.out);
const owner = r => inGame(r).reduce((a, p) => (!a || p.order < a.order ? p : a), null);
const nameOf = (r, id) => (id === 'skip' ? 'Skip' : (r.players.find(p => p.id === id) || {}).name || 'Skip');

function view(room, p) {
  const base = { now: Date.now(), room: room.id, me: { id: p.id, name: p.name }, final: room.last };
  if (p.out) return { ...base, phase: 'gameover', me: { ...base.me, out: true } };
  const hidden = room.phase === 'role' && p.acked;
  const v = {
    ...base, phase: room.phase, deadline: room.deadline, round: room.round, settings: room.settings, minPlayers: MIN_PLAYERS,
    me: { id: p.id, name: p.name, role: hidden ? undefined : p.role, alive: p.alive, isOwner: owner(room) === p, acked: p.acked },
    players: inGame(room).sort((a, b) => a.order - b.order).map(x => ({ id: x.id, name: x.name, alive: x.alive, connected: x.connected, owner: x === owner(room) })),
  };
  if (room.phase !== 'lobby' && room.phase !== 'role' && room.phase !== 'gameover') {
    v.pts = p.role === 'mafia' ? room.mafiaPts : p.pts;
    v.gain = (room.gain && room.gain[p.id]) || 0;
    v.history = room.log.filter(l => l.done);
  }
  if (room.phase === 'night' && p.alive) {
    v.pick = p.pick || null;
    v.rv = { price: price(room), left: room.maxRevive - room.revives, mine: p.revive || null, opts: inGame(room).filter(x => !x.alive && x.outBy === 'vote').map(x => ({ id: x.id, name: x.name })) };
    if (p.role === 'mafia') v.mates = inGame(room).filter(x => x.role === 'mafia' && x.alive).map(x => ({ name: x.name, pick: x.pick || null }));
  }
  if (p.role === 'mafia' && !hidden && room.phase !== 'lobby') v.mafiaNames = inGame(room).filter(x => x.role === 'mafia').map(x => x.name);
  if (!p.alive && GAME.includes(room.phase)) v.chat = room.chat;
  if (room.phase === 'morning') { v.died = room.died; v.revived = room.revived; v.investigation = room.investigations[p.id] || null; }
  if (room.phase === 'vote' || room.phase === 'voteResult') v.votes = room.votes;
  if (room.phase === 'voteResult') v.eliminated = room.eliminated;
  return v;
}
function push(room) { for (const p of room.players) if (p.sid && p.connected) io.to(p.sid).emit('state', view(room, p)); }
function checkWin(room) {
  const a = alive(room), m = a.filter(p => p.role === 'mafia').length, o = a.length - m;
  const winner = m === 0 ? 'Villagers' : m >= o ? 'Mafia' : null;
  if (!winner) return false;
  clearTimeout(room.timer); room.phase = 'gameover'; room.deadline = null;
  room.last = { winner, players: inGame(room).sort((a, b) => a.order - b.order).map(p => ({ name: p.name, role: p.role, alive: p.alive })), log: room.log };
  return true;
}
function startGame(room) {
  const ps = inGame(room), n = ps.length;
  const mafia = Math.max(1, Math.floor(n / 5)), police = Math.max(1, Math.floor(n / 10)), doctor = Math.max(1, Math.floor(n / 10));
  const roles = [...Array(mafia).fill('mafia'), ...Array(police).fill('police'), ...Array(doctor).fill('doctor')];
  while (roles.length < n) roles.push('villager');
  for (let i = roles.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [roles[i], roles[j]] = [roles[j], roles[i]]; }
  ps.forEach((p, i) => Object.assign(p, { role: roles[i], alive: true, acked: false, pick: null, revive: null, vote: null, left: false, pts: 0, outBy: null }));
  Object.assign(room, { n0: n, maxRevive: mafia, revives: 0, mafiaPts: 0, round: 0, log: [], chat: [], last: null, gain: {}, phase: 'role' });
  setTimer(room, ROLE_MS, () => startNight(room)); push(room);
}
function startNight(room) {
  room.round++; room.phase = 'night'; room.gain = {}; alive(room).forEach(p => { p.pick = null; p.revive = null; });
  room.log.push({ round: room.round, died: null, revived: null, eliminated: null, votes: null, done: false });
  setTimer(room, room.settings.nightSec * 1000, () => resolveNight(room)); push(room);
}
function resolveNight(room) {
  const a = alive(room), isAlive = id => a.some(p => p.id === id);
  const picks = a.filter(p => p.role === 'mafia').map(p => p.pick);
  const target = picks.length && picks.every(x => x && x !== 'skip' && x === picks[0]) ? a.find(p => p.id === picks[0]) : null;
  const saved = target && a.some(p => p.role === 'doctor' && p.pick === target.id);
  let pool = 0;
  a.filter(p => p.role === 'villager' && p.pick && p.pick !== 'skip' && isAlive(p.pick)).forEach(p => { p.pts += EARN - SALARY; pool += SALARY; room.gain[p.id] = EARN - SALARY; });
  const staff = a.filter(p => p.role === 'doctor' || p.role === 'police');
  if (pool && staff.length) { const share = Math.floor(pool / staff.length); staff.forEach(p => { p.pts += share; room.gain[p.id] = share; }); }
  room.investigations = {};
  a.filter(p => p.role === 'police' && p.pick && p.pick !== 'skip').forEach(p => {
    const t = room.players.find(x => x.id === p.pick);
    if (t) room.investigations[p.id] = { name: t.name, mafia: t.role === 'mafia' };
  });
  room.died = null; room.revived = null;
  if (target && !saved) { target.alive = false; target.outBy = 'kill'; room.mafiaPts += target.pts; target.pts = 0; room.died = target.name; }
  if (room.revives < room.maxRevive) {
    const cost = price(room);
    for (const p of a.filter(x => x.alive && x.revive).sort((x, y) => x.reviveAt - y.reviveAt)) {
      const t = room.players.find(x => x.id === p.revive), bal = p.role === 'mafia' ? room.mafiaPts : p.pts;
      if (!t || t.out || t.alive || t.outBy !== 'vote' || bal < cost) continue;
      if (p.role === 'mafia') room.mafiaPts -= cost; else p.pts -= cost;
      t.alive = true; t.outBy = null; room.revives++; room.revived = t.name; break;
    }
  }
  const e = room.log[room.log.length - 1]; e.died = room.died; e.revived = room.revived;
  if (!checkWin(room)) { room.phase = 'morning'; setTimer(room, MORNING_MS, () => startVote(room)); }
  push(room);
}
function startVote(room) {
  room.phase = 'vote'; room.votes = {}; alive(room).forEach(p => (room.votes[p.id] = null));
  setTimer(room, room.settings.voteMin * 60000, () => resolveVote(room)); push(room);
}
function resolveVote(room) {
  const a = alive(room), tally = {};
  a.forEach(p => { const v = room.votes[p.id] || 'skip'; room.votes[p.id] = v; tally[v] = (tally[v] || 0) + 1; });
  const top = Math.max(...Object.values(tally)), leaders = Object.keys(tally).filter(k => tally[k] === top);
  const out = leaders.length === 1 && leaders[0] !== 'skip' ? a.find(p => p.id === leaders[0]) : null;
  room.eliminated = out ? out.name : null;
  if (out) { out.alive = false; out.outBy = 'vote'; }
  const e = room.log[room.log.length - 1];
  e.eliminated = room.eliminated; e.votes = a.map(p => ({ voter: p.name, target: nameOf(room, room.votes[p.id]) })); e.done = true;
  if (!checkWin(room)) { room.phase = 'voteResult'; setTimer(room, RESULT_MS, () => startNight(room)); }
  push(room);
}
function removePlayer(room, p) {
  clearTimeout(p.dc);
  if (room.phase === 'lobby' || room.phase === 'gameover' || p.out) room.players = room.players.filter(x => x !== p);
  else { p.alive = false; p.outBy = 'left'; p.left = true; p.connected = false; if (!checkWin(room) && room.phase === 'vote' && alive(room).every(x => room.votes[x.id])) return resolveVote(room); }
  if (!room.players.some(x => x.connected)) { clearTimeout(room.timer); rooms.delete(room.id); return; }
  push(room);
}
function newPlayer(room, name, sid) {
  const p = { id: uid(), token: uid() + uid(), name, sid, connected: true, order: room.nextOrder++, alive: true, out: false, pts: 0 };
  room.players.push(p); return p;
}
const cleanName = s => String(s || '').trim().replace(/\s+/g, ' ').slice(0, 20);
const cleanRoom = s => String(s || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 20);
const nameTaken = (room, n) => room.players.some(p => p.name.toLowerCase() === n.toLowerCase());

io.on('connection', socket => {
  let room = null, me = null;
  const attach = (r, p) => { room = r; me = p; p.sid = socket.id; p.connected = true; clearTimeout(p.dc); socket.join(r.id); };
  const fail = (ack, error) => ack && ack({ error });

  socket.on('create', (d, ack) => {
    const id = cleanRoom(d.room), name = cleanName(d.name);
    if (id.length < 3) return fail(ack, 'Room ID needs at least 3 letters or numbers.');
    if (!name) return fail(ack, 'Enter your name.');
    if (rooms.has(id)) return fail(ack, 'That room ID is already in use. Pick another.');
    const nightSec = Math.min(120, Math.max(20, Math.round(Number(d.nightSec) / 10) * 10 || 20));
    const voteMin = Math.min(60, Math.max(10, Math.round(Number(d.voteMin) / 10) * 10 || 10));
    const r = { id, players: [], nextOrder: 0, phase: 'lobby', settings: { nightSec, voteMin }, round: 0, log: [], last: null, investigations: {}, chat: [], gain: {}, n0: 0, maxRevive: 0, revives: 0, mafiaPts: 0 };
    rooms.set(id, r); const p = newPlayer(r, name, socket.id); attach(r, p);
    ack && ack({ ok: true, room: id, token: p.token }); push(r);
  });
  socket.on('join', (d, ack) => {
    const r = rooms.get(cleanRoom(d.room)), name = cleanName(d.name);
    if (!r) return fail(ack, 'No room with that ID.');
    if (!name) return fail(ack, 'Enter your name.');
    if (r.phase !== 'lobby') return fail(ack, 'This game has already started.');
    if (nameTaken(r, name)) return fail(ack, 'That name is not available. Choose another.');
    const p = newPlayer(r, name, socket.id); attach(r, p);
    ack && ack({ ok: true, room: r.id, token: p.token }); push(r);
  });
  socket.on('resume', (d, ack) => {
    const r = rooms.get(cleanRoom(d.room)), p = r && r.players.find(x => x.token === d.token && !x.left);
    if (!p) return fail(ack, 'expired');
    attach(r, p); ack && ack({ ok: true }); push(r);
  });
  socket.on('start', () => {
    if (!room || room.phase !== 'lobby' || owner(room) !== me || inGame(room).length < MIN_PLAYERS) return;
    startGame(room);
  });
  socket.on('ack', () => {
    if (!room || room.phase !== 'role' || me.out) return;
    me.acked = true;
    if (inGame(room).every(p => p.acked || !p.connected)) startNight(room); else push(room);
  });
  socket.on('night', t => {
    if (!room || room.phase !== 'night' || me.out || !me.alive) return;
    const tp = room.players.find(p => p.id === t && !p.out && p.alive);
    if (t !== 'skip' && !tp) return;
    if (t !== 'skip' && ((me.role === 'mafia' && tp.role === 'mafia') || ((me.role === 'police' || me.role === 'villager') && tp === me))) return;
    if (t === 'skip' && me.role !== 'mafia') return;
    me.pick = t; push(room);
  });
  socket.on('revive', t => {
    if (!room || room.phase !== 'night' || me.out || !me.alive) return;
    if (t === null) { me.revive = null; return push(room); }
    const tp = room.players.find(p => p.id === t && !p.out && !p.alive && p.outBy === 'vote');
    const bal = me.role === 'mafia' ? room.mafiaPts : me.pts;
    if (!tp || room.revives >= room.maxRevive || bal < price(room)) return;
    me.revive = t; me.reviveAt = Date.now(); push(room);
  });
  socket.on('vote', t => {
    if (!room || room.phase !== 'vote' || me.out || !me.alive) return;
    if (t !== 'skip' && !(t !== me.id && alive(room).some(p => p.id === t))) return;
    room.votes[me.id] = t;
    if (alive(room).every(p => room.votes[p.id])) resolveVote(room); else push(room);
  });
  socket.on('chat', t => {
    if (!room || !me || me.out || me.alive || !GAME.includes(room.phase)) return;
    t = String(t || '').trim().slice(0, 200); if (!t) return;
    room.chat.push({ name: me.name, text: t }); if (room.chat.length > 100) room.chat.shift(); push(room);
  });
  socket.on('again', () => {
    if (!room || !me) return;
    if (room.phase === 'gameover') { room.phase = 'lobby'; room.players.forEach(p => (p.out = true)); room.deadline = null; }
    if (room.phase === 'lobby' && me.out) { me.out = false; me.role = null; me.alive = true; me.pts = 0; push(room); }
  });
  socket.on('leave', () => { if (room && me) { const r = room, p = me; room = me = null; socket.leave(r.id); removePlayer(r, p); } });
  socket.on('disconnect', () => {
    if (!room || !me || me.sid !== socket.id) return;
    const r = room, p = me; p.connected = false; push(r);
    p.dc = setTimeout(() => removePlayer(r, p), GRACE_MS);
  });
});
server.listen(process.env.PORT || 3000, () => console.log('Mafia server running'));
