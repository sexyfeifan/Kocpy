const PRIME1 = 0x9e3779b1;
const PRIME2 = 0x85ebca77;
const PRIME3 = 0xc2b2ae3d;
const PRIME4 = 0x27d4eb2f;
const PRIME5 = 0x165667b1;

const rotateLeft = (value: number, bits: number) =>
  ((value << bits) | (value >>> (32 - bits))) >>> 0;

const round = (accumulator: number, input: number) => {
  accumulator = (accumulator + Math.imul(input, PRIME2)) >>> 0;
  accumulator = rotateLeft(accumulator, 13);
  return Math.imul(accumulator, PRIME1) >>> 0;
};

/** Streaming xxHash32 with seed 0, used by Kocard-style MHL files. */
export class XxHash32 {
  private totalLength = 0;
  private memory = Buffer.allocUnsafe(16);
  private memorySize = 0;
  private v1 = (PRIME1 + PRIME2) >>> 0;
  private v2 = PRIME2 >>> 0;
  private v3 = 0;
  private v4 = (0 - PRIME1) >>> 0;

  update(input: Uint8Array) {
    const chunk = Buffer.isBuffer(input)
      ? input
      : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
    let offset = 0;
    this.totalLength += chunk.length;
    if (this.memorySize + chunk.length < 16) {
      chunk.copy(this.memory, this.memorySize);
      this.memorySize += chunk.length;
      return this;
    }
    if (this.memorySize) {
      const needed = 16 - this.memorySize;
      chunk.copy(this.memory, this.memorySize, 0, needed);
      this.consume(this.memory, 0);
      offset = needed;
      this.memorySize = 0;
    }
    const limit = chunk.length - 16;
    while (offset <= limit) {
      this.consume(chunk, offset);
      offset += 16;
    }
    if (offset < chunk.length) {
      chunk.copy(this.memory, 0, offset);
      this.memorySize = chunk.length - offset;
    }
    return this;
  }

  private consume(buffer: Buffer, offset: number) {
    this.v1 = round(this.v1, buffer.readUInt32LE(offset));
    this.v2 = round(this.v2, buffer.readUInt32LE(offset + 4));
    this.v3 = round(this.v3, buffer.readUInt32LE(offset + 8));
    this.v4 = round(this.v4, buffer.readUInt32LE(offset + 12));
  }

  digestNumber() {
    let hash =
      this.totalLength >= 16
        ? (rotateLeft(this.v1, 1) +
            rotateLeft(this.v2, 7) +
            rotateLeft(this.v3, 12) +
            rotateLeft(this.v4, 18)) >>>
          0
        : PRIME5;
    hash = (hash + this.totalLength) >>> 0;
    let offset = 0;
    while (offset + 4 <= this.memorySize) {
      hash =
        Math.imul(
          rotateLeft(
            (hash +
              Math.imul(this.memory.readUInt32LE(offset), PRIME3)) >>>
              0,
            17,
          ),
          PRIME4,
        ) >>> 0;
      offset += 4;
    }
    while (offset < this.memorySize) {
      hash =
        Math.imul(
          rotateLeft((hash + this.memory[offset] * PRIME5) >>> 0, 11),
          PRIME1,
        ) >>> 0;
      offset++;
    }
    hash ^= hash >>> 15;
    hash = Math.imul(hash, PRIME2) >>> 0;
    hash ^= hash >>> 13;
    hash = Math.imul(hash, PRIME3) >>> 0;
    hash ^= hash >>> 16;
    return hash >>> 0;
  }

  digestDecimal() {
    return String(this.digestNumber());
  }
}
