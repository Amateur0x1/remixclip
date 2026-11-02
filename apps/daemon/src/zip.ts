/**
 * [INPUT]: in-memory file entries (relative name + bytes).
 * [OUTPUT]: a valid ZIP archive (STORE method) as one Buffer.
 * [POS]: the daemon's dependency-free archive writer, used to hand out the browser companion.
 *
 * Why hand-rolled: the Linux and Windows builds do not ship the `zip` binary, and pulling a
 * zip dependency into the daemon for one download button is not worth it. Entries are stored
 * uncompressed (the extension build is a few hundred KB of JS/PNG), and the only tricky part —
 * CRC-32 — is implemented below with the standard table algorithm.
 */

/** Standard CRC-32 (IEEE 802.3) table, built once. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** MS-DOS date/time pair used by both the local header and the central directory. */
function dosStamp(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

export interface ZipEntry {
  /** Path inside the archive, always with forward slashes. */
  name: string;
  data: Buffer;
  /** File timestamp; defaults to now, which keeps the archive reproducible enough for a download. */
  mtime?: Date;
}

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL = 0x06054b50;
/** Bit 11: file names are UTF-8 (only relevant if a future entry name is not ASCII). */
const UTF8_FLAG = 0x0800;
/** Version 2.0: the lowest that understands the STORE method and the UTF-8 flag. */
const VERSION = 20;

export function createZip(entries: ZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const { data } = entry;
    const crc = crc32(data);
    const stamp = dosStamp(entry.mtime ?? new Date());

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_HEADER, 0);
    local.writeUInt16LE(VERSION, 4);
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(0, 8); // method: STORE
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); // compressed size == size for STORE
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra field length
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_HEADER, 0);
    central.writeUInt16LE(VERSION, 4); // version made by
    central.writeUInt16LE(VERSION, 6); // version needed to extract
    central.writeUInt16LE(UTF8_FLAG, 8);
    central.writeUInt16LE(0, 10); // method: STORE
    central.writeUInt16LE(stamp.time, 12);
    central.writeUInt16LE(stamp.date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra field length
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk number start
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE(0, 38); // external attributes
    central.writeUInt32LE(offset, 42); // relative offset of the local header
    centralParts.push(central, name);

    offset += local.length + name.length + data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_CENTRAL, 0);
  end.writeUInt16LE(0, 4); // this disk
  end.writeUInt16LE(0, 6); // disk with the central directory
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localParts, centralDirectory, end]);
}
