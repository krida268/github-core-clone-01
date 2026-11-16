/** Panjang maksimum satu pkt-line termasuk 4 byte header panjangnya. */
export const PKT_LINE_MAX = 65520;

export interface PktLine {
  kind: 'data' | 'flush' | 'delim' | 'end';
  data: Buffer;
}

function lengthPrefix(totalLength: number): Buffer {
  return Buffer.from(totalLength.toString(16).padStart(4, '0'), 'ascii');
}

/**
 * Bungkus data menjadi satu pkt-line: 4 digit hex panjang (termasuk header)
 * diikuti datanya. Throw bila data terlalu besar untuk satu pkt-line.
 */
export function encodePktLine(data: Buffer | string): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const total = payload.length + 4;
  if (total > PKT_LINE_MAX) {
    throw new Error(`encodePktLine: payload ${payload.length} byte melebihi batas pkt-line`);
  }
  return Buffer.concat([lengthPrefix(total), payload]);
}

/** Pkt-line flush: "0000". */
export function encodeFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

/** Pkt-line delimiter (v2): "0001". */
export function encodeDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

/** Pkt-line end (v2): "0002". */
export function encodeEnd(): Buffer {
  return Buffer.from('0002', 'ascii');
}

/**
 * Urai buffer pkt-line menjadi daftar baris. Throw bila framing rusak
 * (header terpotong, panjang tidak valid, atau data terpotong).
 */
export function decodePktLines(buf: Buffer): PktLine[] {
  const out: PktLine[] = [];
  let pos = 0;
  while (pos < buf.length) {
    if (pos + 4 > buf.length) throw new Error('decodePktLines: header panjang terpotong');
    const text = buf.subarray(pos, pos + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(text)) {
      throw new Error(`decodePktLines: panjang pkt-line tidak valid: ${JSON.stringify(text)}`);
    }
    const length = parseInt(text, 16);
    if (length === 0) {
      out.push({ kind: 'flush', data: Buffer.alloc(0) });
      pos += 4;
    } else if (length === 1) {
      out.push({ kind: 'delim', data: Buffer.alloc(0) });
      pos += 4;
    } else if (length === 2) {
      out.push({ kind: 'end', data: Buffer.alloc(0) });
      pos += 4;
    } else {
      if (length < 4) throw new Error('decodePktLines: panjang pkt-line < 4');
      if (pos + length > buf.length) throw new Error('decodePktLines: data pkt-line terpotong');
      out.push({ kind: 'data', data: Buffer.from(buf.subarray(pos + 4, pos + length)) });
      pos += length;
    }
  }
  return out;
}

/**
 * Bungkus data sebagai side-band: tiap pkt-line diawali 1 byte nomor channel
 * (1 = data, 2 = progress, 3 = error), dipotong agar tiap pkt-line tetap
 * di bawah batas 65520 byte (1 byte channel + 4 byte header + data).
 */
export function sideBand(channel: 1 | 2 | 3, data: Buffer): Buffer {
  const maxChunk = PKT_LINE_MAX - 4 - 1;
  const parts: Buffer[] = [];
  if (data.length === 0) {
    parts.push(encodePktLine(Buffer.from([channel])));
    return Buffer.concat(parts);
  }
  for (let offset = 0; offset < data.length; offset += maxChunk) {
    const chunk = data.subarray(offset, Math.min(offset + maxChunk, data.length));
    parts.push(encodePktLine(Buffer.concat([Buffer.from([channel]), chunk])));
  }
  return Buffer.concat(parts);
}
