import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { ObjectType, Store } from '../store.ts';
import { hashObject } from '../store.ts';

export interface PackObject {
  type: ObjectType;
  data: Buffer;
  oid: string;
}

const TYPE_NUMBERS: Record<ObjectType, number> = {
  commit: 1,
  tree: 2,
  blob: 3,
  tag: 4,
};

const NUMBER_TYPES: Record<number, ObjectType> = {
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
};

/** Header objek pack: varint (type 3 bit, size) — bit MSB tiap byte = ada lanjutan. */
function encodeObjectHeader(typeNum: number, size: number): Buffer {
  const bytes: number[] = [];
  let remaining = size;
  let first = (typeNum << 4) | (remaining & 0x0f);
  remaining >>>= 4;
  if (remaining > 0) first |= 0x80;
  bytes.push(first);
  while (remaining > 0) {
    let next = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining > 0) next |= 0x80;
    bytes.push(next);
  }
  return Buffer.from(bytes);
}

function readObjectHeader(buf: Buffer, offset: number): { typeNum: number; size: number; next: number } {
  if (offset >= buf.length) throw new Error('parsePack: header objek terpotong');
  let pos = offset;
  let byte = buf[pos];
  pos += 1;
  const typeNum = (byte >> 4) & 0x07;
  let size = byte & 0x0f;
  let shift = 4;
  while (byte & 0x80) {
    if (pos >= buf.length) throw new Error('parsePack: header objek terpotong');
    byte = buf[pos];
    pos += 1;
    size |= (byte & 0x7f) << shift;
    shift += 7;
  }
  return { typeNum, size, next: pos };
}

/** Offset ofs-delta: varint dengan bias +1 per byte lanjutan (format git). */
function readOfsOffset(buf: Buffer, offset: number): { value: number; next: number } {
  if (offset >= buf.length) throw new Error('parsePack: offset ofs-delta terpotong');
  let pos = offset;
  let byte = buf[pos];
  pos += 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (pos >= buf.length) throw new Error('parsePack: offset ofs-delta terpotong');
    byte = buf[pos];
    pos += 1;
    value = ((value + 1) << 7) | (byte & 0x7f);
  }
  return { value, next: pos };
}

/** Varint ukuran delta: grup 7 bit little-endian, MSB = ada lanjutan. */
function readDeltaSize(buf: Buffer, offset: number): { value: number; next: number } {
  let pos = offset;
  let value = 0;
  let shift = 0;
  for (;;) {
    if (pos >= buf.length) throw new Error('parsePack: ukuran delta terpotong');
    const byte = buf[pos];
    pos += 1;
    value |= (byte & 0x7f) << shift;
    shift += 7;
    if ((byte & 0x80) === 0) break;
  }
  return { value, next: pos };
}

/**
 * Terapkan data delta ke objek dasar: instruksi copy (bit 7) dan insert (literal).
 * Mengembalikan byte hasil; throw bila delta rusak atau ukuran hasil tidak cocok.
 */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  const baseSize = readDeltaSize(delta, 0);
  if (baseSize.value !== base.length) {
    throw new Error('applyDelta: ukuran dasar delta tidak cocok');
  }
  const resultSize = readDeltaSize(delta, baseSize.next);
  const chunks: Buffer[] = [];
  let produced = 0;
  let pos = resultSize.next;
  while (pos < delta.length) {
    const op = delta[pos];
    pos += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (pos >= delta.length) throw new Error('applyDelta: instruksi copy terpotong');
          copyOffset |= delta[pos] << (bit * 8);
          pos += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if (op & (0x10 << bit)) {
          if (pos >= delta.length) throw new Error('applyDelta: instruksi copy terpotong');
          copySize |= delta[pos] << (bit * 8);
          pos += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) {
        throw new Error('applyDelta: instruksi copy keluar dari dasar');
      }
      chunks.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (pos + literal > delta.length) throw new Error('applyDelta: instruksi insert terpotong');
      chunks.push(delta.subarray(pos, pos + literal));
      pos += literal;
      produced += literal;
    } else {
      throw new Error('applyDelta: opcode delta 0 tidak valid');
    }
  }
  if (produced !== resultSize.value) {
    throw new Error('applyDelta: ukuran hasil delta tidak cocok');
  }
  return Buffer.concat(chunks, produced);
}

/**
 * Inflate satu stream zlib yang mulai di `start` dan berakhir sebelum `limit`.
 * inflateSync mengabaikan byte sisa, jadi keberhasilan bersifat monoton terhadap
 * panjang slice: pencarian biner menemukan panjang terpendek yang berhasil,
 * yaitu tepat ujung stream terkompresi.
 */
function inflateOne(buf: Buffer, start: number, limit: number): { data: Buffer; next: number } {
  let lo = start;
  let hi = limit;
  let okAt: number | null = null;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    try {
      inflateSync(buf.subarray(start, mid));
      okAt = mid;
      hi = mid - 1;
    } catch {
      lo = mid + 1;
    }
  }
  if (okAt === null) throw new Error('parsePack: data zlib objek rusak');
  return { data: inflateSync(buf.subarray(start, okAt)), next: okAt };
}

interface RawEntry {
  offset: number;
  typeNum: number;
  whole: Buffer | null;
  deltaBaseOffset: number | null;
  deltaBaseOid: string | null;
  delta: Buffer | null;
}

/**
 * Urai packfile PACK v2 menjadi objek-objek lengkap (delta sudah diterapkan).
 * Mendukung objek utuh (commit/tree/blob/tag), ofs-delta, dan ref-delta.
 * Throw Error bila pack rusak (magic, versi, jumlah, checksum, atau delta).
 */
export function parsePack(buf: Buffer): PackObject[] {
  if (buf.length < 12) throw new Error('parsePack: pack terlalu pendek');
  if (buf.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('parsePack: bukan packfile (magic salah)');
  }
  const version = buf.readUInt32BE(4);
  if (version !== 2) throw new Error(`parsePack: versi pack ${version} tidak didukung (harus 2)`);
  const count = buf.readUInt32BE(8);

  const raw: RawEntry[] = [];
  let pos = 12;
  for (let i = 0; i < count; i += 1) {
    const start = pos;
    const header = readObjectHeader(buf, pos);
    pos = header.next;
    let deltaBaseOffset: number | null = null;
    let deltaBaseOid: string | null = null;
    if (header.typeNum === 6) {
      const ofs = readOfsOffset(buf, pos);
      pos = ofs.next;
      deltaBaseOffset = start - ofs.value;
      if (deltaBaseOffset < 0) throw new Error('parsePack: ofs-delta menunjuk sebelum awal pack');
    } else if (header.typeNum === 7) {
      if (pos + 20 > buf.length) throw new Error('parsePack: ref-delta terpotong');
      deltaBaseOid = buf.subarray(pos, pos + 20).toString('hex');
      pos += 20;
    } else if (NUMBER_TYPES[header.typeNum] === undefined) {
      throw new Error(`parsePack: tipe objek pack ${header.typeNum} tidak dikenal`);
    }
    // Batas akhir stream zlib: sebelum trailer checksum 20 byte bila masih ada ruang.
    const limit = buf.length - pos >= 20 ? buf.length - 20 : buf.length;
    const inflated = inflateOne(buf, pos, limit);
    pos = inflated.next;
    if (header.typeNum === 6 || header.typeNum === 7) {
      raw.push({
        offset: start,
        typeNum: header.typeNum,
        whole: null,
        deltaBaseOffset,
        deltaBaseOid,
        delta: inflated.data,
      });
    } else {
      if (inflated.data.length !== header.size) {
        throw new Error('parsePack: ukuran objek hasil inflate tidak cocok dengan header');
      }
      raw.push({
        offset: start,
        typeNum: header.typeNum,
        whole: inflated.data,
        deltaBaseOffset: null,
        deltaBaseOid: null,
        delta: null,
      });
    }
  }

  // Trailer checksum 20 byte (bila ada): SHA-1 atas semua byte sebelumnya.
  if (pos + 20 === buf.length) {
    const expect = createHash('sha1').update(buf.subarray(0, pos)).digest('hex');
    const actual = buf.subarray(pos, pos + 20).toString('hex');
    if (expect !== actual) throw new Error('parsePack: checksum pack tidak cocok');
  } else if (pos !== buf.length) {
    throw new Error('parsePack: byte sisa setelah objek terakhir');
  }

  const byOffset = new Map<number, number>();
  raw.forEach((entry, index) => byOffset.set(entry.offset, index));

  // Resolusi delta (rekursif + memo, dengan penjaga siklus). Basis ref-delta dicari
  // di antara objek pack ini; bila tidak ada, cari di store? Tidak — parsePack murni
  // pack: basis ref-delta yang tidak ada di pack adalah pack rusak.
  const resolved: Array<PackObject | null> = raw.map(() => null);
  const resolving = new Set<number>();

  function resolve(index: number): PackObject {
    const done = resolved[index];
    if (done !== null) return done;
    if (resolving.has(index)) throw new Error('parsePack: rantai delta melingkar');
    resolving.add(index);
    const entry = raw[index];
    try {
      if (entry.whole !== null) {
        const type = NUMBER_TYPES[entry.typeNum] as ObjectType;
        const out: PackObject = { type, data: entry.whole, oid: hashObject(type, entry.whole) };
        resolved[index] = out;
        return out;
      }
      let base: PackObject;
      if (entry.deltaBaseOffset !== null) {
        const baseIndex = byOffset.get(entry.deltaBaseOffset);
        if (baseIndex === undefined) throw new Error('parsePack: basis ofs-delta tidak ditemukan');
        base = resolve(baseIndex);
      } else if (entry.deltaBaseOid !== null) {
        // Basis ref-delta: objek mana pun di pack, utuh maupun hasil delta lain.
        // Coba tiap entri; entri yang gagal di-resolusi bukan basis yang dicari.
        let base: PackObject | null = null;
        for (let j = 0; j < raw.length && base === null; j += 1) {
          try {
            const candidate = resolve(j);
            if (candidate.oid === entry.deltaBaseOid) base = candidate;
          } catch {
            // Bukan basis (atau rusak) — lanjut ke entri berikutnya.
          }
        }
        if (base === null) throw new Error('parsePack: basis ref-delta tidak ada di pack');
        const data = applyDelta(base.data, entry.delta as Buffer);
        const out: PackObject = { type: base.type, data, oid: hashObject(base.type, data) };
        resolved[index] = out;
        return out;
      } else {
        throw new Error('parsePack: entri delta tanpa basis');
      }
      const data = applyDelta(base.data, entry.delta as Buffer);
      const out: PackObject = { type: base.type, data, oid: hashObject(base.type, data) };
      resolved[index] = out;
      return out;
    } finally {
      resolving.delete(index);
    }
  }

  const out: PackObject[] = [];
  for (let i = 0; i < raw.length; i += 1) out.push(resolve(i));
  return out;
}

/**
 * Bangun packfile PACK v2 dari objek-objek di store.
 * Semua objek ditulis UTUH (tanpa delta), diurutkan berdasarkan oid agar deterministik.
 * Throw bila ada oid yang tidak ada di store.
 */
export function buildPack(store: Store, oids: string[]): Buffer {
  const sorted = [...oids].sort();
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(sorted.length, 8);
  parts.push(header);
  for (const oid of sorted) {
    const obj = store.getObject(oid);
    if (obj === undefined) throw new Error(`buildPack: objek ${oid} tidak ada di store`);
    const typeNum = TYPE_NUMBERS[obj.type];
    parts.push(encodeObjectHeader(typeNum, obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}
