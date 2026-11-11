/**
 * [INPUT]: an Electron `app.asar` archive.
 * [OUTPUT]: its JSON header, entry lookup, and individual file reads without extracting the archive.
 * [POS]: Lets verification prove the shell's main entry and package metadata actually shipped.
 */
import { closeSync, openSync, readSync } from 'node:fs';

interface AsarNode {
  files?: Record<string, AsarNode>;
  size?: number;
  /** Byte offset of the file contents, relative to the end of the header pickle. */
  offset?: string;
}

export interface AsarHeader {
  files: Record<string, AsarNode>;
}

export interface AsarArchive {
  header: AsarHeader;
  contentOffset: number;
}

const PICKLE_HEADER_SIZE = 8;

export function readAsarHeader(archive: string): AsarArchive {
  const fd = openSync(archive, 'r');
  try {
    const sizeBuffer = Buffer.alloc(PICKLE_HEADER_SIZE);
    readSync(fd, sizeBuffer, 0, PICKLE_HEADER_SIZE, 0);
    const pickleSize = sizeBuffer.readUInt32LE(4);
    const headerBuffer = Buffer.alloc(pickleSize);
    readSync(fd, headerBuffer, 0, pickleSize, PICKLE_HEADER_SIZE);
    const jsonSize = headerBuffer.readUInt32LE(4);
    const header = JSON.parse(headerBuffer.toString('utf8', 8, 8 + jsonSize)) as AsarHeader;
    return { header, contentOffset: PICKLE_HEADER_SIZE + pickleSize };
  } finally {
    closeSync(fd);
  }
}

function findNode(header: AsarHeader, entry: string): AsarNode | undefined {
  let node: AsarNode | undefined = { files: header.files };
  for (const part of entry.split('/').filter(Boolean)) {
    node = node?.files?.[part];
    if (!node) return undefined;
  }
  return node;
}

/** True when `entry` names a file (not a directory) inside the archive. */
export function hasAsarEntry(archive: AsarArchive, entry: string): boolean {
  const node = findNode(archive.header, entry);
  return node !== undefined && node.files === undefined;
}

export function readAsarFile(archive: AsarArchive, entry: string): Buffer | null {
  const node = findNode(archive.header, entry);
  if (!node || node.files !== undefined) return null;
  if (node.offset === undefined || node.size === undefined) return null;

  const fd = openSync(archivePath(archive), 'r');
  try {
    const buffer = Buffer.alloc(node.size);
    readSync(fd, buffer, 0, node.size, archive.contentOffset + Number(node.offset));
    return buffer;
  } finally {
    closeSync(fd);
  }
}

// The archive path is needed for reads; keep it on the returned object instead of a global.
const PATHS = new WeakMap<AsarArchive, string>();

function archivePath(archive: AsarArchive): string {
  const value = PATHS.get(archive);
  if (!value) throw new Error('asar archive handle is missing its path');
  return value;
}

export function openAsar(archive: string): AsarArchive {
  const handle = readAsarHeader(archive);
  PATHS.set(handle, archive);
  return handle;
}
