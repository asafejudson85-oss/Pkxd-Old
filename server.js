const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const S = require('./sfs');

const PORT = parseInt(process.env.PORT || '8080', 10);
const ON_RENDER = !!process.env.RENDER;
const PUBLIC_HOST = process.env.PUBLIC_HOST || process.env.RENDER_EXTERNAL_HOSTNAME || '';
const PUBLIC_PORT = parseInt(process.env.PUBLIC_PORT || (ON_RENDER ? '443' : String(PORT)), 10);
const DEFAULT_ROOM = process.env.DEFAULT_ROOM || 'world';
const MAX_USERS = 200;

fs.mkdirSync(path.join(__dirname, 'logs'), { recursive: true });
const logFile = fs.createWriteStream(path.join(__dirname, 'logs', 'packets.log'), { flags: 'a' });
function log(...a) {
  const line = `[${new Date().toISOString()}] ` + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  console.log(line); logFile.write(line + '\n');
}

const A = { HANDSHAKE: 0, LOGIN: 1, LOGOUT: 2, GET_ROOM_LIST: 3, JOIN_ROOM: 4, AUTO_JOIN: 5, CREATE_ROOM: 6,
  PUBLIC_MSG: 7, OBJECT_MSG: 10, SET_ROOM_VARS: 11, SET_USER_VARS: 12, EXTENSION: 13, LEAVE_ROOM: 14,
  PRIVATE_MSG: 21, MANUAL_DISCONNECT: 26, PING: 29, USER_ENTER_ROOM: 1000, USER_COUNT: 1001,
  USER_LOST: 1002, USER_EXIT_ROOM: 1004 };

let nextUserId = 1, nextRoomId = 1;
const users = new Map();
const byName = new Map();
const rooms = new Map();
const roomByName = new Map();

function getRoom(name) {
  let r = roomByName.get(name);
  if (!r) {
    r = { id: nextRoomId++, name, users: new Set(), vars: [] };
    rooms.set(r.id, r); roomByName.set(name, r);
  }
  return r;
}
const send = (u, action, params, ctrl = 0) => { if (u.ws.readyState === 1) u.ws.send(S.buildMessage(ctrl, action, params)); };
const toRoom = (room, action, params, except) => {
  for (const uid of room.users) { const u = users.get(uid); if (u && u !== except) send(u, action, params); }
};

const varArr = (v) => v;
const roomArr = (r) => S.Arr([S.Int(r.id), S.Str(r.name), S.Str('default'), S.Bool(false), S.Bool(false), S.Bool(false),
  S.Short(r.users.size), S.Short(MAX_USERS), S.Arr(r.vars)]);
const userArr = (u) => S.Arr([S.Int(u.id), S.Str(u.name), S.Short(0), S.Short(0), S.Arr([...u.vars.values()].map(varArr))]);

function joinRoom(u, room) {
  leaveAll(u, room);
  if (room.users.has(u.id)) return;
  room.users.add(u.id); u.room = room;
  send(u, A.JOIN_ROOM, { r: roomArr(room), ul: S.Arr([...room.users].map((id) => userArr(users.get(id)))) });
  toRoom(room, A.USER_ENTER_ROOM, { r: S.Int(room.id), u: userArr(u) }, u);
  toRoom(room, A.USER_COUNT, { r: S.Int(room.id), uc: S.Short(room.users.size), sc: S.Short(0) });
  log(`+ ${u.name} entrou em "${room.name}" (${room.users.size} na sala)`);
}
function leaveRoom(u, room, notifySelf = true) {
  if (!room.users.delete(u.id)) return;
  if (u.room === room) u.room = null;
  const p = { r: S.Int(room.id), u: S.Int(u.id) };
  toRoom(room, A.USER_EXIT_ROOM, p);
  if (notifySelf) send(u, A.USER_EXIT_ROOM, p);
  toRoom(room, A.USER_COUNT, { r: S.Int(room.id), uc: S.Short(room.users.size), sc: S.Short(0) });
  if (room.users.size === 0 && room.name !== DEFAULT_ROOM) { rooms.delete(room.id); roomByName.delete(room.name); }
}
function leaveAll(u, except) { for (const r of [...rooms.values()]) if (r !== except && r.users.has(u.id)) leaveRoom(u, r); }
function dropUser(u) {
  if (!users.delete(u.id)) return;
  if (byName.get(u.name) === u) byName.delete(u.name);
  for (const r of [...rooms.values()]) if (r.users.has(u.id)) leaveRoom(u, r, false);
  log(`- ${u.name} saiu (${users.size} online)`);
}

function handle(u, msg) {
  const c = msg.c ? msg.c.v : 0, a = msg.a ? msg.a.v : -1, p = msg.p ? msg.p.v : {};
  const pl = S.plain({ t: S.T.OBJ, v: p });
  if (a !== A.PING) log(`< ${u.name || '#' + u.id} c=${c} a=${a}`, pl);

  if (c === 0) {
    switch (a) {
      case A.HANDSHAKE:
        u.token = crypto.randomUUID();
        return send(u, A.HANDSHAKE, { tk: S.Str(u.token), ct: S.Int(1000000), ms: S.Int(1000000) });

      case A.LOGIN: {
        const name = (p.un && p.un.v) || `player${u.id}`;
        const zone = (p.zn && p.zn.v) || 'PKXD';
        const old = byName.get(name);
        if (old && old !== u) { try { old.ws.close(); } catch (e) {} dropUser(old); }
        u.name = name; u.zone = zone; byName.set(name, u);
        u.loginParams = pl.p || {};
        send(u, A.LOGIN, { zn: S.Str(zone), un: S.Str(name), pi: S.Short(0), id: S.Int(u.id), rs: S.Short(0),
          rl: S.Arr([...rooms.values()].map(roomArr)), p: S.Obj({}) });
        log(`* login: ${name} zona=${zone} (${users.size} online)`);
        return joinRoom(u, getRoom(DEFAULT_ROOM));
      }
      case A.LOGOUT:
      case A.MANUAL_DISCONNECT:
        return u.ws.close();

      case A.GET_ROOM_LIST:
        return send(u, A.GET_ROOM_LIST, { rl: S.Arr([...rooms.values()].map(roomArr)) });

      case A.JOIN_ROOM:
      case A.AUTO_JOIN: {
        let room = null;
        if (p.r) room = p.r.t === S.T.STR ? getRoom(p.r.v) : rooms.get(p.r.v);
        if (!room) room = getRoom(DEFAULT_ROOM);
        return joinRoom(u, room);
      }
      case A.LEAVE_ROOM: {
        const room = p.r ? rooms.get(p.r.v) : u.room;
        if (room) leaveRoom(u, room);
        return;
      }
      case A.PUBLIC_MSG: {
        const room = (p.r && rooms.get(p.r.v)) || u.room; if (!room) return;
        return toRoom(room, A.PUBLIC_MSG, { t: S.Short(0), r: S.Int(room.id), u: S.Int(u.id),
          m: p.m || S.Str(''), p: p.p || S.Obj({}) });
      }
      case A.OBJECT_MSG: {
        const room = (p.r && rooms.get(p.r.v)) || u.room; if (!room) return;
        return toRoom(room, A.OBJECT_MSG, { r: S.Int(room.id), u: S.Int(u.id), p: p.p || S.Obj({}) }, u);
      }
      case A.SET_USER_VARS: {
        const list = p.vl ? p.vl.v : [];
        for (const v of list) u.vars.set(v.v[0].v, v);
        const room = u.room; if (!room) return;
        return toRoom(room, A.SET_USER_VARS, { u: S.Int(u.id), vl: S.Arr(list) });
      }
      case A.PING:
        return send(u, A.PING, {});
      default:
        return;
    }
  }

  if (c === 1 && a === A.EXTENSION) {
    const cmd = p.c ? p.c.v : '';
    const room = (p.r && p.r.v >= 0 && rooms.get(p.r.v)) || u.room;
    if (cmd === 'p') {
      return send(u, A.EXTENSION, { c: S.Str('p'), p: p.p || S.Obj({}), r: S.Int(room ? room.id : -1) }, 1);
    }
    return;
  }
}

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/lobby/allocation') {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      log(`lobby ${req.method}`, body.slice(0, 300));
      const host = PUBLIC_HOST || (req.headers.host || 'localhost').split(':')[0];
      const out = { successful: true, failureReason: '', failureDescription: '',
        gameServerId: 'pkxd-1', gameServerAddress: host, gameServerPort: PUBLIC_PORT };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    });
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end(`PKXD server ok - ${users.size} online\n`);
});

const wss = new WebSocketServer({ server, path: '/websocket' });
wss.on('connection', (ws, req) => {
  const u = { id: nextUserId++, name: '', ws, buf: Buffer.alloc(0), vars: new Map(), room: null };
  users.set(u.id, u);
  log(`conexao #${u.id} de ${req.socket.remoteAddress}`);
  ws.on('message', (data) => {
    try {
      u.buf = Buffer.concat([u.buf, Buffer.from(data)]);
      const { packets, rest } = S.parsePackets(u.buf);
      u.buf = rest;
      for (const pk of packets) handle(u, S.decodeObj(pk));
    } catch (e) { log('erro ao tratar pacote:', String(e.stack || e)); }
  });
  ws.on('close', () => dropUser(u));
  ws.on('error', () => dropUser(u));
});

server.listen(PORT, () => log(`PKXD server ouvindo na porta ${PORT} (sala padrao "${DEFAULT_ROOM}")`));
