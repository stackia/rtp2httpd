import assert from "node:assert/strict";
import test from "node:test";

import { findAnnexBStartCodeOffset } from "./annexb.ts";

const find = (bytes, startOffset = 0) => findAnnexBStartCodeOffset(Uint8Array.from(bytes), startOffset);

function legacyFind(data, startOffset) {
  let offset = startOffset;
  while (offset + 3 < data.byteLength) {
    const uint32 = (data[offset] << 24) | (data[offset + 1] << 16) | (data[offset + 2] << 8) | data[offset + 3];
    const uint24 = (data[offset] << 16) | (data[offset + 1] << 8) | data[offset + 2];
    if (uint32 === 1 || uint24 === 1) {
      return offset;
    }
    offset++;
  }
  return data.byteLength;
}

test("finds three-byte and four-byte Annex-B start codes", () => {
  assert.equal(find([0, 0, 1, 0x65]), 0);
  assert.equal(find([0, 0, 0, 1, 0x65]), 0);
  assert.equal(find([0xaa, 0, 0, 1, 0x65]), 1);
  assert.equal(find([0xaa, 0, 0, 0, 1, 0x65]), 1);
});

test("uses the last three zero bytes when extra leading zeros precede a start code", () => {
  assert.equal(find([0, 0, 0, 0, 1, 0x65]), 1);
  assert.equal(find([0, 0, 0, 0, 0, 1, 0x65]), 2);
});

test("never returns a start code before the requested offset", () => {
  const bytes = [0, 0, 0, 1, 0x65];
  assert.equal(find(bytes, 1), 1);
  assert.equal(find(bytes, 2), bytes.length);
});

test("preserves empty-NAL and trailing-prefix boundary behavior", () => {
  const adjacent = [0, 0, 1, 0, 0, 1, 0x65];
  assert.equal(find(adjacent), 0);
  assert.equal(find(adjacent, 3), 3);

  const trailingThreeByte = [0xaa, 0, 0, 1];
  assert.equal(find(trailingThreeByte), trailingThreeByte.length);

  const trailingFourByte = [0xaa, 0, 0, 0, 1];
  assert.equal(find(trailingFourByte), 1);
});

test("ignores an incomplete zero prefix at the end", () => {
  const bytes = [0xaa, 0, 0];
  assert.equal(find(bytes), bytes.length);
});

test("finds prefixes after transport slices have been joined across every split point", () => {
  const bytes = Uint8Array.from([0xaa, 0xbb, 0, 0, 0, 1, 0x65, 0xcc]);
  for (let split = 1; split < bytes.length; split++) {
    const joined = new Uint8Array(bytes.length);
    joined.set(bytes.subarray(0, split));
    joined.set(bytes.subarray(split), split);
    assert.equal(findAnnexBStartCodeOffset(joined, 0), 2);
  }
});

test("matches the legacy scanner for every short boundary pattern", () => {
  const alphabet = [0, 1, 2];
  for (let length = 0; length <= 8; length++) {
    const bytes = new Uint8Array(length);
    const visit = (index) => {
      if (index < length) {
        for (const value of alphabet) {
          bytes[index] = value;
          visit(index + 1);
        }
        return;
      }

      for (let startOffset = 0; startOffset <= length; startOffset++) {
        assert.equal(findAnnexBStartCodeOffset(bytes, startOffset), legacyFind(bytes, startOffset));
      }
    };
    visit(0);
  }
});
