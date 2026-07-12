import { IllegalStateException, InvalidArgumentException } from "../utils/exception";

// Exponential-Golomb buffer decoder
class ExpGolomb {
  private _buffer: Uint8Array | null;
  private _buffer_index: number;
  private _total_bytes: number;
  private _current_word: number;
  private _current_word_bits_left: number;

  constructor(uint8array: Uint8Array) {
    this._buffer = uint8array;
    this._buffer_index = 0;
    this._total_bytes = uint8array.byteLength;
    this._current_word = 0;
    this._current_word_bits_left = 0;
  }

  destroy(): void {
    this._buffer = null;
  }

  private _fillCurrentWord(): void {
    const buffer_bytes_left: number = this._total_bytes - this._buffer_index;
    if (buffer_bytes_left <= 0) throw new IllegalStateException("ExpGolomb: _fillCurrentWord() but no bytes available");

    const bytes_read: number = Math.min(4, buffer_bytes_left);
    const word: Uint8Array = new Uint8Array(4);
    word.set((this._buffer as Uint8Array).subarray(this._buffer_index, this._buffer_index + bytes_read));
    this._current_word = new DataView(word.buffer).getUint32(0, false);

    this._buffer_index += bytes_read;
    this._current_word_bits_left = bytes_read * 8;
  }

  readBits(bits: number): number {
    if (bits > 32) throw new InvalidArgumentException("ExpGolomb: readBits() bits exceeded max 32bits!");

    if (bits <= this._current_word_bits_left) {
      const result: number = this._current_word >>> (32 - bits);
      this._current_word <<= bits;
      this._current_word_bits_left -= bits;
      return result;
    }

    let result: number = this._current_word_bits_left ? this._current_word : 0;
    result = result >>> (32 - this._current_word_bits_left);
    const bits_need_left: number = bits - this._current_word_bits_left;

    this._fillCurrentWord();
    const bits_read_next: number = Math.min(bits_need_left, this._current_word_bits_left);

    const result2: number = this._current_word >>> (32 - bits_read_next);
    this._current_word <<= bits_read_next;
    this._current_word_bits_left -= bits_read_next;

    result = (result << bits_read_next) | result2;
    return result;
  }

  readBool(): boolean {
    return this.readBits(1) === 1;
  }

  readByte(): number {
    return this.readBits(8);
  }

  private _skipLeadingZero(): number {
    let zero_count: number;
    for (zero_count = 0; zero_count < this._current_word_bits_left; zero_count++) {
      if (0 !== (this._current_word & (0x80000000 >>> zero_count))) {
        this._current_word <<= zero_count;
        this._current_word_bits_left -= zero_count;
        return zero_count;
      }
    }
    this._fillCurrentWord();
    return zero_count + this._skipLeadingZero();
  }

  readUEG(): number {
    // unsigned exponential golomb
    const leading_zeros: number = this._skipLeadingZero();
    return this.readBits(leading_zeros + 1) - 1;
  }

  readSEG(): number {
    // signed exponential golomb
    const value: number = this.readUEG();
    if (value & 0x01) {
      return (value + 1) >>> 1;
    } else {
      return -1 * (value >>> 1);
    }
  }
}

export default ExpGolomb;
