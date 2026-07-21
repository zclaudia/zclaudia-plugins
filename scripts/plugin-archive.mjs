import { mkdir, readFile, readdir, readlink, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';

export const PLUGIN_LIMITS = Object.freeze({
  archiveSize: 128 * 1024 * 1024,
  fileCount: 20_000,
  fileSize: 32 * 1024 * 1024,
  unpackedSize: 256 * 1024 * 1024,
});

const CRC_TABLE = new Uint32Array(256);
for (let index = 0; index < CRC_TABLE.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  CRC_TABLE[index] = value >>> 0;
}

export function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

export function assertSafeArchivePath(name) {
  if (!name || name.includes('\\') || name.includes('\0') || path.posix.isAbsolute(name)) {
    throw new Error(`Unsafe archive path: ${JSON.stringify(name)}.`);
  }
  const components = name.split('/');
  if (components.some(component => component === '' || component === '.' || component === '..')) {
    throw new Error(`Unsafe archive path: ${JSON.stringify(name)}.`);
  }
  if (/^[A-Za-z]:/.test(components[0])) {
    throw new Error(`Unsafe archive path: ${JSON.stringify(name)}.`);
  }
  return name;
}

export function resolveSafeLinkTarget(entryName, target) {
  if (!target || target.includes('\0') || target.includes('\\') || path.posix.isAbsolute(target)) {
    throw new Error(`Unsafe symlink ${entryName} -> ${JSON.stringify(target)}.`);
  }

  const stack = path.posix.dirname(entryName).split('/').filter(Boolean);
  for (const component of target.split('/')) {
    if (!component || component === '.') continue;
    if (component === '..') {
      if (stack.length === 0) {
        throw new Error(`Symlink escapes the plugin root: ${entryName} -> ${target}.`);
      }
      stack.pop();
    } else {
      stack.push(component);
    }
  }
  if (stack.length === 0) throw new Error(`Symlink ${entryName} resolves to the plugin root.`);
  return stack.join('/');
}

function dosTimestamp(date) {
  const year = Math.max(1980, Math.min(2107, date.getUTCFullYear()));
  const time =
    (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1);
  const day = ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate();
  return { time, day };
}

export function deterministicTimestamp() {
  const epoch = process.env.SOURCE_DATE_EPOCH;
  if (epoch !== undefined) {
    const seconds = Number(epoch);
    if (!Number.isInteger(seconds) || seconds < 315532800) {
      throw new Error('SOURCE_DATE_EPOCH must be an integer at or after 1980-01-01.');
    }
    return new Date(seconds * 1000);
  }
  return new Date('2000-01-01T00:00:00.000Z');
}

export async function collectDirectoryEntries(rootDirectory) {
  const root = path.resolve(rootDirectory);
  const entries = [];

  async function visit(directory, relativeDirectory = '') {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const child of children) {
      const absolute = path.join(directory, child.name);
      const name = relativeDirectory ? `${relativeDirectory}/${child.name}` : child.name;
      assertSafeArchivePath(name);

      if (child.isDirectory()) {
        await visit(absolute, name);
      } else if (child.isFile()) {
        const details = await stat(absolute);
        const mode = details.mode & 0o111 ? 0o100755 : 0o100644;
        entries.push({ name, data: await readFile(absolute), mode, type: 'file' });
      } else if (child.isSymbolicLink()) {
        const target = await readlink(absolute);
        resolveSafeLinkTarget(name, target);
        entries.push({
          name,
          data: Buffer.from(target, 'utf8'),
          mode: 0o120777,
          target,
          type: 'symlink',
        });
      } else {
        throw new Error(`Unsupported filesystem entry in plugin: ${name}.`);
      }
    }
  }

  await visit(root);
  return entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
}

export async function createDeterministicZip(directory, outputPath, options = {}) {
  const timestamp = options.timestamp ?? deterministicTimestamp();
  const entries = await collectDirectoryEntries(directory);
  const { time, day } = dosTimestamp(timestamp);
  const chunks = [];
  const centralChunks = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    if (name.length > 0xffff) throw new Error(`Archive path is too long: ${entry.name}.`);
    // Store entries without deflate compression. Deflate output can vary between
    // Node/zlib versions even at the same level, while method 0 is byte-stable.
    const compressed = entry.data;
    const checksum = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((entry.mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralChunks.push(central, name);
    offset += local.length + name.length + compressed.length;
  }

  if (entries.length > 0xffff) throw new Error('ZIP64 archives are not supported.');
  const centralSize = centralChunks.reduce((total, chunk) => total + chunk.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, Buffer.concat([...chunks, ...centralChunks, end]));
  return entries;
}

function findEndRecord(archive) {
  const minimum = Math.max(0, archive.length - 65_557);
  for (let offset = archive.length - 22; offset >= minimum; offset -= 1) {
    if (archive.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error('Invalid ZIP: end-of-central-directory record is missing.');
}

export async function readZip(archivePath, limits = PLUGIN_LIMITS) {
  const archive = await readFile(archivePath);
  if (archive.length > limits.archiveSize) {
    throw new Error(`Archive exceeds the ${limits.archiveSize}-byte size limit.`);
  }
  const endOffset = findEndRecord(archive);
  const disk = archive.readUInt16LE(endOffset + 4);
  const centralDisk = archive.readUInt16LE(endOffset + 6);
  const diskEntries = archive.readUInt16LE(endOffset + 8);
  const entryCount = archive.readUInt16LE(endOffset + 10);
  const centralSize = archive.readUInt32LE(endOffset + 12);
  const centralOffset = archive.readUInt32LE(endOffset + 16);
  const commentLength = archive.readUInt16LE(endOffset + 20);
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== entryCount) {
    throw new Error('Multi-disk ZIP archives are not supported.');
  }
  if (entryCount > limits.fileCount) {
    throw new Error(`Archive exceeds the ${limits.fileCount}-entry limit.`);
  }
  if (endOffset + 22 + commentLength !== archive.length) {
    throw new Error('Invalid ZIP: trailing data or a truncated comment was found.');
  }
  if (centralOffset + centralSize !== endOffset || centralOffset > archive.length) {
    throw new Error('Invalid ZIP central-directory bounds.');
  }

  const entries = [];
  const names = new Set();
  const occupiedRanges = [];
  let cursor = centralOffset;
  let unpackedSize = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > endOffset || archive.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error('Invalid ZIP central-directory entry.');
    }
    const flags = archive.readUInt16LE(cursor + 8);
    const method = archive.readUInt16LE(cursor + 10);
    const checksum = archive.readUInt32LE(cursor + 16);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const size = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const entryCommentLength = archive.readUInt16LE(cursor + 32);
    const externalAttributes = archive.readUInt32LE(cursor + 38);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const recordEnd = cursor + 46 + nameLength + extraLength + entryCommentLength;
    if (recordEnd > endOffset) throw new Error('Truncated ZIP central-directory entry.');
    if (flags & 0x0001) throw new Error('Encrypted ZIP entries are not supported.');
    if (flags & ~0x0800) throw new Error(`Unsupported ZIP flags 0x${flags.toString(16)}.`);
    if (method !== 0 && method !== 8) throw new Error(`Unsupported ZIP method ${method}.`);
    if (size > limits.fileSize) {
      throw new Error(`ZIP entry exceeds the ${limits.fileSize}-byte limit.`);
    }
    unpackedSize += size;
    if (unpackedSize > limits.unpackedSize) {
      throw new Error(`Archive exceeds the ${limits.unpackedSize}-byte unpacked-size limit.`);
    }

    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    assertSafeArchivePath(name);
    if (names.has(name)) throw new Error(`Duplicate ZIP entry: ${name}.`);
    names.add(name);
    if (localOffset + 30 > centralOffset || archive.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`Invalid local ZIP header for ${name}.`);
    }
    const localFlags = archive.readUInt16LE(localOffset + 6);
    const localMethod = archive.readUInt16LE(localOffset + 8);
    const localChecksum = archive.readUInt32LE(localOffset + 14);
    const localCompressedSize = archive.readUInt32LE(localOffset + 18);
    const localSize = archive.readUInt32LE(localOffset + 22);
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > centralOffset) throw new Error(`Truncated ZIP entry: ${name}.`);
    const localName = archive
      .subarray(localOffset + 30, localOffset + 30 + localNameLength)
      .toString('utf8');
    if (
      localName !== name ||
      localFlags !== flags ||
      localMethod !== method ||
      localChecksum !== checksum ||
      localCompressedSize !== compressedSize ||
      localSize !== size
    ) {
      throw new Error(`Local and central ZIP headers disagree for ${name}.`);
    }
    const rangeStart = localOffset;
    if (occupiedRanges.some(([start, end]) => rangeStart < end && dataEnd > start)) {
      throw new Error(`Overlapping ZIP entry data found for ${name}.`);
    }
    occupiedRanges.push([rangeStart, dataEnd]);
    const compressed = archive.subarray(dataStart, dataEnd);
    const data =
      method === 0
        ? Buffer.from(compressed)
        : inflateRawSync(compressed, { maxOutputLength: limits.fileSize });
    if (data.length !== size || crc32(data) !== checksum) {
      throw new Error(`ZIP integrity check failed for ${name}.`);
    }
    const mode = externalAttributes >>> 16;
    const typeBits = mode & 0o170000;
    if (typeBits !== 0 && typeBits !== 0o100000 && typeBits !== 0o120000) {
      throw new Error(`Unsupported special filesystem entry: ${name}.`);
    }
    const type = typeBits === 0o120000 ? 'symlink' : 'file';
    const target = type === 'symlink' ? data.toString('utf8') : undefined;
    if (target !== undefined) resolveSafeLinkTarget(name, target);
    entries.push({ name, data, mode: mode || 0o100644, size, target, type });
    cursor = recordEnd;
  }
  if (cursor !== endOffset) throw new Error('Invalid ZIP central-directory size.');
  return entries;
}

export async function extractZip(archivePath, destination, limits = PLUGIN_LIMITS) {
  const entries = await readZip(archivePath, limits);
  const symlinkNames = new Set(
    entries.filter(entry => entry.type === 'symlink').map(entry => entry.name)
  );
  for (const entry of entries) {
    for (const symlinkName of symlinkNames) {
      if (entry.name.startsWith(`${symlinkName}/`)) {
        throw new Error(`ZIP entry ${entry.name} is nested below symlink ${symlinkName}.`);
      }
    }
  }

  const root = path.resolve(destination);
  await mkdir(root, { recursive: true });
  for (const entry of entries.filter(candidate => candidate.type === 'file')) {
    const output = path.join(root, ...entry.name.split('/'));
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, entry.data, { mode: entry.mode & 0o777 });
  }
  for (const entry of entries.filter(candidate => candidate.type === 'symlink')) {
    const output = path.join(root, ...entry.name.split('/'));
    await mkdir(path.dirname(output), { recursive: true });
    await symlink(entry.target, output);
  }
  return entries;
}
