const zlib = require('zlib');

const T = { NULL: 0, BOOL: 1, BYTE: 2, SHORT: 3, INT: 4, LONG: 5, FLOAT: 6, DOUBLE: 7, STR: 8,
  BOOLA: 9, BYTEA: 10, SHORTA: 11, INTA: 12, LONGA: 13, FLOATA: 14, DOUBLEA: 15, STRA: 16,
  ARR: 17, OBJ: 18, CLASS: 19, TEXT: 20 };

const mk = (t) => (v) => ({ t, v });
const Bool = mk(T.BOOL), Byte = mk(T.BYTE), Short = mk(T.SHORT), Int = mk(T.INT), Long = mk(T.LONG),
  Float = mk(T.FLOAT), Double = mk(T.DOUBLE), Str = mk(T.STR), IntA = mk(T.INTA), StrA = mk(T.STRA),
  ByteA = mk(T.BYTEA), Null = () => ({ t: T.NULL, v: null });
const Obj = (o = {}) => ({ t: T.OBJ, v: o });
const Arr = (a = []) => ({ t: T.ARR, v: a });

class W {
  constructor() { this.b = []; }
  u8(n) { this.b.push(n & 255); }
  buf(x) { for (const c of x) this.b.push(c); }
  i16(n) { const x = Buffer.alloc(2); x.writeInt16BE(n); this.buf(x); }
  i32(n) { const x = Buffer.alloc(4); x.writeInt32BE(n); this.buf(x); }
  i64(n) { const x = Buffer.alloc(8); x.writeBigInt64BE(BigInt(n)); this.buf(x); }
  f32(n) { const x = Buffer.alloc(4); x.writeFloatBE(n); this.buf(x); }
  f64(n) { const x = Buffer.alloc(8); x.writeDoubleBE(n); this.buf(x); }
  str(s) { const x = Buffer.from(s, 'utf8'); this.i16(x.length); this.buf(x); }
  out() { return Buffer.from(this.b); }
}

function encPayload(w, tv) {
  const v = tv.v;
  switch (tv.t) {
    case T.NULL: break;
    case T.BOOL: w.u8(v ? 1 : 0); break;
    case T.BYTE: w.u8(v); break;
    case T.SHORT: w.i16(v); break;
    case T.INT: w.i32(v); break;
    case T.LONG: w.i64(v); break;
    case T.FLOAT: w.f32(v); break;
    case T.DOUBLE: w.f64(v); break;
    case T.STR: w.str(v); break;
    case T.TEXT: { const x = Buffer.from(v, 'utf8'); w.i32(x.length); w.buf(x); break; }
    case T.BYTEA: w.i32(v.length); w.buf(v); break;
    case T.INTA: w.i16(v.length); v.forEach((n) => w.i32(n)); break;
    case T.STRA: w.i16(v.length); v.forEach((s) => w.str(s)); break;
    case T.ARR: w.i16(v.length); v.forEach((e) => encVal(w, e)); break;
    case T.OBJ: {
      const keys = Object.keys(v); w.i16(keys.length);
      for (const k of keys) { w.str(k); encVal(w, v[k]); }
      break;
    }
    default: throw new Error('tipo nao suportado no encode: ' + tv.t);
  }
}
function encVal(w, tv) { w.u8(tv.t); encPayload(w, tv); }
const encodeObj = (o) => { const w = new W(); encVal(w, Obj(o)); return w.out(); };

class R {
  constructor(b) { this.b = b; this.p = 0; }
  u8() { return this.b[this.p++]; }
  i8() { const v = this.b.readInt8(this.p); this.p += 1; return v; }
  i16() { const v = this.b.readInt16BE(this.p); this.p += 2; return v; }
  i32() { const v = this.b.readInt32BE(this.p); this.p += 4; return v; }
  i64() { const v = this.b.readBigInt64BE(this.p); this.p += 8; return Number(v); }
  f32() { const v = this.b.readFloatBE(this.p); this.p += 4; return v; }
  f64() { const v = this.b.readDoubleBE(this.p); this.p += 8; return v; }
  bytes(n) { const v = this.b.subarray(this.p, this.p + n); this.p += n; return v; }
  str() { const n = this.i16(); return this.bytes(n).toString('utf8'); }
}

function decPayload(r, t) {
  switch (t) {
    case T.NULL: return null;
    case T.BOOL: return r.u8() !== 0;
    case T.BYTE: return r.i8();
    case T.SHORT: return r.i16();
    case T.INT: return r.i32();
    case T.LONG: return r.i64();
    case T.FLOAT: return r.f32();
    case T.DOUBLE: return r.f64();
    case T.STR: return r.str();
    case T.TEXT: { const n = r.i32(); return r.bytes(n).toString('utf8'); }
    case T.BYTEA: { const n = r.i32(); return Buffer.from(r.bytes(n)); }
    case T.BOOLA: { const n = r.i16(); return Array.from({ length: n }, () => r.u8() !== 0); }
    case T.SHORTA: { const n = r.i16(); return Array.from({ length: n }, () => r.i16()); }
    case T.INTA: { const n = r.i16(); return Array.from({ length: n }, () => r.i32()); }
    case T.LONGA: { const n = r.i16(); return Array.from({ length: n }, () => r.i64()); }
    case T.FLOATA: { const n = r.i16(); return Array.from({ length: n }, () => r.f32()); }
    case T.DOUBLEA: { const n = r.i16(); return Array.from({ length: n }, () => r.f64()); }
    case T.STRA: { const n = r.i16(); return Array.from({ length: n }, () => r.str()); }
    case T.ARR: { const n = r.i16(); return Array.from({ length: n }, () => decVal(r)); }
    case T.OBJ: {
      const n = r.i16(); const o = {};
      for (let i = 0; i < n; i++) { const k = r.str(); o[k] = decVal(r); }
      return o;
    }
    default: throw new Error('tipo desconhecido no decode: ' + t);
  }
}
function decVal(r) { const t = r.u8(); return { t, v: decPayload(r, t) }; }
const decodeObj = (buf) => { const r = new R(buf); const t = r.u8(); if (t !== T.OBJ) throw new Error('esperava SFSObject'); return decPayload(r, t); };

function plain(tv) {
  if (!tv) return tv;
  switch (tv.t) {
    case T.OBJ: { const o = {}; for (const k of Object.keys(tv.v)) o[k] = plain(tv.v[k]); return o; }
    case T.ARR: return tv.v.map(plain);
    case T.BYTEA: return `<bytes ${tv.v.length}>`;
    default: return tv.v;
  }
}

function framePacket(payload) {
  if (payload.length > 65535) {
    const h = Buffer.alloc(5); h[0] = 0x80 | 0x10; h.writeUInt32BE(payload.length, 1);
    return Buffer.concat([h, payload]);
  }
  const h = Buffer.alloc(3); h[0] = 0x80; h.writeUInt16BE(payload.length, 1);
  return Buffer.concat([h, payload]);
}

function parsePackets(buf) {
  const packets = [];
  let p = 0;
  while (p < buf.length) {
    const hb = buf[p];
    const big = (hb & 0x10) !== 0, enc = (hb & 0x40) !== 0, comp = (hb & 0x20) !== 0;
    const hlen = big ? 5 : 3;
    if (buf.length - p < hlen) break;
    const size = big ? buf.readUInt32BE(p + 1) : buf.readUInt16BE(p + 1);
    if (buf.length - p - hlen < size) break;
    let body = buf.subarray(p + hlen, p + hlen + size);
    if (enc) throw new Error('pacote criptografado nao suportado');
    if (comp) body = zlib.inflateSync(body);
    packets.push(body);
    p += hlen + size;
  }
  return { packets, rest: buf.subarray(p) };
}

const buildMessage = (c, a, p = {}) => framePacket(encodeObj({ c: Byte(c), a: Short(a), p: Obj(p) }));

module.exports = { T, Bool, Byte, Short, Int, Long, Float, Double, Str, IntA, StrA, ByteA, Null, Obj, Arr,
  encodeObj, decodeObj, plain, framePacket, parsePackets, buildMessage };
