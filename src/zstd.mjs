/**
 * DSH 会话工件的 Zstandard 帧工具。
 *
 * DSH 的 `.zstd` 会话日志是**多帧拼接**（每个持久批一帧），因此必须先按帧头
 * 算出边界，再逐帧解压；直接用 magic 扫描会切坏数据。这里按 Zstandard 帧格式
 * 保守扫描：任何保留位、保留块类型、截断帧都视为损坏，绝不把损坏的前缀当成
 * 完整日志发布。
 */
import { promisify } from 'node:util';
import { zstdCompress, zstdDecompress } from 'node:zlib';

const decompressAsync = promisify(zstdDecompress);
const compressAsync = promisify(zstdCompress);
const ZSTD_MAGIC = 0xfd2fb528;

/** 一个会话工件允许的最大解压后字节数，防御解压炸弹。 */
const MAX_DECODED_BYTES = 512 * 1024 * 1024;

/**
 * 扫描完整帧边界。
 * @param {Buffer} buffer
 * @param {number} [maxFrames]
 * @returns {{frames: {start: number, end: number}[], tornStart?: number}}
 */
export function scanZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`会话日志损坏：字节 ${offset} 处不是 Zstandard 帧魔数`);
    }
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset++);
    if ((descriptor & 0x18) !== 0) {
      throw new Error(`会话日志损坏：字节 ${offset - 1} 处帧头保留位非零`);
    }
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 0x20) !== 0;
    const checksum = (descriptor & 0x04) !== 0;
    const dictionaryFlag = descriptor & 0x03;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 0x03;
      const blockSize = blockHeader >>> 3;
      if (blockType === 0x03) {
        throw new Error(`会话日志损坏：字节 ${offset - 3} 处块类型为保留值`);
      }
      const payloadBytes = blockType === 0x01 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
    if (frames.length === maxFrames) return { frames };
  }
  return { frames };
}

/** 解压单帧。 */
export async function decompressZstdFrame(frame) {
  return await decompressAsync(frame, { maxOutputLength: MAX_DECODED_BYTES });
}

/**
 * 解压全部帧并拼接。
 * @param {Buffer} buffer
 * @returns {Promise<{content: Buffer, frameCount: number, torn: boolean}>}
 */
export async function decompressAllZstdFrames(buffer) {
  const scan = scanZstdFrames(buffer);
  if (scan.frames.length === 0) throw new Error('会话日志是空的或缺少 Zstandard 帧头');
  const decoded = [];
  let total = 0;
  for (const frame of scan.frames) {
    const chunk = await decompressZstdFrame(buffer.subarray(frame.start, frame.end));
    total += chunk.length;
    if (total > MAX_DECODED_BYTES) throw new Error('会话日志解压后超过允许的大小上限');
    decoded.push(chunk);
  }
  return { content: Buffer.concat(decoded), frameCount: decoded.length, torn: scan.tornStart !== undefined };
}

/**
 * 按 DSH 的写法压缩成「头一帧 + 正文一帧」。
 * @param {string} headerLine
 * @param {string} rest
 * @returns {Promise<Buffer>}
 */
export async function compressArtifact(headerLine, rest) {
  const headerFrame = await compressAsync(Buffer.from(`${headerLine}\n`, 'utf8'));
  if (rest === '') return headerFrame;
  const bodyFrame = await compressAsync(Buffer.from(rest, 'utf8'));
  return Buffer.concat([headerFrame, bodyFrame]);
}
