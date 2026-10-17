"""Rewrite the initial page count of a wasm module's own memory (section 5), keeping the LEB128 width unchanged.

Used for the live page's ASR runtime, which declares 512 MiB up front (it grows on demand):
  python3 -I patch_wasm_memory.py sherpa-onnx-wasm-main-asr.wasm sherpa-onnx-wasm-main-asr-m192.wasm 192
"""
import sys

source, target, mib = sys.argv[1], sys.argv[2], int(sys.argv[3])
data = bytearray(open(source, 'rb').read())
pages = mib * 1024 // 64


def leb(p):
    result = shift = 0
    start = p
    while True:
        byte = data[p]; p += 1
        result |= (byte & 0x7f) << shift
        if not byte & 0x80:
            return result, p, p - start
        shift += 7


def encode(value, width):
    out = []
    for i in range(width):
        byte = value & 0x7f
        value >>= 7
        out.append(byte | (0x80 if i < width - 1 else 0))
    if value:
        raise SystemExit('value does not fit the original LEB128 width')
    return bytes(out)


pos = 8
while pos < len(data):
    section = data[pos]; pos += 1
    size, pos, _ = leb(pos)
    if section == 5:
        count, p, _ = leb(pos)
        if count != 1:
            raise SystemExit('expected one memory')
        flags = data[p]; p += 1
        initial, end, width = leb(p)
        maximum = leb(end)[0] if flags & 1 else None
        if maximum is not None and pages > maximum:
            raise SystemExit('initial above maximum')
        data[p:end] = encode(pages, width)
        open(target, 'wb').write(data)
        print(f'initial {initial * 64 // 1024} MiB -> {mib} MiB (max {maximum and maximum * 64 // 1024} MiB)')
        break
    pos += size
else:
    raise SystemExit('no memory section')
