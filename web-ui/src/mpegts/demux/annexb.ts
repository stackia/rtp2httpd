/**
 * Find the next Annex-B start code at or after `startOffset`.
 *
 * This preserves the parsers' existing boundary semantics: a three-byte start
 * code must have a following NAL header byte, while a four-byte start code can
 * end at the end of the buffer. The latter is retained for compatibility with
 * the previous scanner, even though such an empty trailing NAL is malformed.
 */
export function findAnnexBStartCodeOffset(data: Uint8Array, startOffset: number): number {
  const length = data.byteLength;
  let oneOffset = Math.max(2, startOffset + 2);

  while (oneOffset < length) {
    oneOffset = data.indexOf(1, oneOffset);
    if (oneOffset === -1) {
      break;
    }

    if (data[oneOffset - 1] !== 0 || data[oneOffset - 2] !== 0) {
      oneOffset++;
      continue;
    }

    const fourByteOffset = oneOffset - 3;
    const startCodeOffset =
      fourByteOffset >= startOffset && data[fourByteOffset] === 0 ? fourByteOffset : oneOffset - 2;

    if (startCodeOffset >= startOffset && startCodeOffset + 3 < length) {
      return startCodeOffset;
    }

    oneOffset++;
  }

  return length;
}
