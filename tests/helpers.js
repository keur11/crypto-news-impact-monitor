import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function loadConfig() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'config/config.json'), 'utf8'));
}

export function loadLibrary() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'config/library.json'), 'utf8'));
}

/**
 * Sintetične sveče: prva sveča ob startMs s close = startPrice,
 * vsaka naslednja ima log donos returns[i]. qv je število ali funkcija (i, t) → število.
 */
export function makeCandles(startMs, stepMs, returns, { startPrice = 100, qv = 1000 } = {}) {
  const out = [];
  let c = startPrice;
  const vol = (i, t) => (typeof qv === 'function' ? qv(i, t) : qv);
  out.push({ t: startMs, o: c, h: c, l: c, c, v: 1, qv: vol(-1, startMs) });
  returns.forEach((r, i) => {
    const t = startMs + (i + 1) * stepMs;
    const prev = c;
    c = prev * Math.exp(r);
    out.push({ t, o: prev, h: Math.max(prev, c), l: Math.min(prev, c), c, v: 1, qv: vol(i, t) });
  });
  return out;
}

export function approx(actual, expected, rel = 1e-9) {
  if (actual === null || expected === null) return actual === expected;
  const tol = Math.max(Math.abs(expected) * rel, 1e-12);
  return Math.abs(actual - expected) <= tol;
}

// Najmanjši ZIP z eno datoteko (deflate), za teste branja arhivov.
export function buildZip(name, content) {
  const data = Buffer.from(content);
  const comp = deflateRawSync(data);
  const nameBuf = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(0, 14); // CRC se pri branju ne preverja (preverja se SHA-256 arhiva)
  local.writeUInt32LE(comp.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  const cen = Buffer.alloc(46);
  cen.writeUInt32LE(0x02014b50, 0);
  cen.writeUInt16LE(20, 4);
  cen.writeUInt16LE(20, 6);
  cen.writeUInt16LE(8, 10);
  cen.writeUInt32LE(comp.length, 20);
  cen.writeUInt32LE(data.length, 24);
  cen.writeUInt16LE(nameBuf.length, 28);
  cen.writeUInt32LE(0, 42);
  const cenOffset = local.length + nameBuf.length + comp.length;
  const cenSize = cen.length + nameBuf.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cenSize, 12);
  eocd.writeUInt32LE(cenOffset, 16);
  return Buffer.concat([local, nameBuf, comp, cen, nameBuf, eocd]);
}
