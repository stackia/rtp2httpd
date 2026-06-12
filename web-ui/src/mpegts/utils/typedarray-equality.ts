function isAligned16(a: Uint8Array): boolean {
  return a.byteOffset % 2 === 0 && a.byteLength % 2 === 0;
}

function isAligned32(a: Uint8Array): boolean {
  return a.byteOffset % 4 === 0 && a.byteLength % 4 === 0;
}

function compareArray(a: Uint8Array | Uint16Array | Uint32Array, b: Uint8Array | Uint16Array | Uint32Array): boolean {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

function equal8(a: Uint8Array, b: Uint8Array): boolean {
  return compareArray(a, b);
}

function equal16(a: Uint8Array, b: Uint8Array): boolean {
  const a16 = new Uint16Array(a.buffer, a.byteOffset, a.byteLength / 2);
  const b16 = new Uint16Array(b.buffer, b.byteOffset, b.byteLength / 2);
  return compareArray(a16, b16);
}

function equal32(a: Uint8Array, b: Uint8Array): boolean {
  const a32 = new Uint32Array(a.buffer, a.byteOffset, a.byteLength / 4);
  const b32 = new Uint32Array(b.buffer, b.byteOffset, b.byteLength / 4);
  return compareArray(a32, b32);
}

function buffersAreEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) {
    return false;
  }

  if (isAligned32(a) && isAligned32(b)) {
    return equal32(a, b);
  }

  if (isAligned16(a) && isAligned16(b)) {
    return equal16(a, b);
  }

  return equal8(a, b);
}

export default buffersAreEqual;
