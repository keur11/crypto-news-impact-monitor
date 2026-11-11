// Minimalno branje ZIP arhiva (Binance arhivi vsebujejo eno CSV datoteko).
// Podpira metodi 0 (stored) in 8 (deflate). Brez zunanjih odvisnosti.

import { inflateRawSync } from 'node:zlib';

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

export function readZipEntries(buf) {
  let eocd = -1;
  const minPos = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error('ZIP: ni zapisa konca centralnega imenika');

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== CEN_SIG) throw new Error('ZIP: pokvarjen centralni imenik');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.push({ name, method, compSize, size, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }

  return entries.map((e) => ({
    name: e.name,
    read() {
      const o = e.localOffset;
      if (buf.readUInt32LE(o) !== LOC_SIG) throw new Error(`ZIP: pokvarjena lokalna glava za ${e.name}`);
      const start = o + 30 + buf.readUInt16LE(o + 26) + buf.readUInt16LE(o + 28);
      const raw = buf.subarray(start, start + e.compSize);
      let data;
      if (e.method === 0) data = Buffer.from(raw);
      else if (e.method === 8) data = inflateRawSync(raw);
      else throw new Error(`ZIP: nepodprta metoda stiskanja ${e.method}`);
      if (data.length !== e.size) throw new Error(`ZIP: napačna velikost za ${e.name}`);
      return data;
    },
  }));
}

export function extractSingleFile(buf) {
  const files = readZipEntries(buf).filter((e) => !e.name.endsWith('/'));
  if (files.length !== 1) throw new Error(`ZIP: pričakovana ena datoteka, najdenih ${files.length}`);
  return { name: files[0].name, data: files[0].read() };
}
