// Minimal ZIP writer (STORE / no compression) — zero dependencies.
// Enough to bundle an audio blob + certificate.json into one uploadable file.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d) {
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f);
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
  return { time, date };
}

// files: [{ name: string, data: Uint8Array }]
export function makeZip(files) {
  const enc = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;
  const { time, date } = dosDateTime(new Date());

  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const crc = crc32(f.data);
    const size = f.data.length;

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);   // local file header sig
    local.setUint16(4, 20, true);           // version needed
    local.setUint16(6, 0, true);            // flags
    local.setUint16(8, 0, true);            // method 0 = store
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);        // compressed size
    local.setUint32(22, size, true);        // uncompressed size
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);           // extra len
    chunks.push(new Uint8Array(local.buffer), nameBytes, f.data);

    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);      // central dir sig
    cd.setUint16(4, 20, true);              // version made by
    cd.setUint16(6, 20, true);              // version needed
    cd.setUint16(8, 0, true);
    cd.setUint16(10, 0, true);
    cd.setUint16(12, time, true);
    cd.setUint16(14, date, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, size, true);
    cd.setUint32(24, size, true);
    cd.setUint16(28, nameBytes.length, true);
    cd.setUint16(30, 0, true);              // extra
    cd.setUint16(32, 0, true);              // comment
    cd.setUint16(34, 0, true);              // disk number
    cd.setUint16(36, 0, true);              // internal attrs
    cd.setUint32(38, 0, true);              // external attrs
    cd.setUint32(42, offset, true);         // local header offset
    central.push({ header: new Uint8Array(cd.buffer), name: nameBytes });

    offset += 30 + nameBytes.length + size;
  }

  const cdStart = offset;
  let cdSize = 0;
  for (const c of central) {
    chunks.push(c.header, c.name);
    cdSize += c.header.length + c.name.length;
  }

  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, central.length, true);
  eocd.setUint16(10, central.length, true);
  eocd.setUint32(12, cdSize, true);
  eocd.setUint32(16, cdStart, true);
  chunks.push(new Uint8Array(eocd.buffer));

  return new Blob(chunks, { type: 'application/zip' });
}
