"""Build a synthetic TTF with no dependencies.

Its square covers sampled emoji scalars so reference fonts cannot silently
fall back to the system emoji font. Never used for the default sample.
"""
import base64
import math
from pathlib import Path
import struct


def pack(fmt, *values):
    return struct.pack('>' + fmt, *values)


def padded(data):
    return data + bytes(-len(data) % 4)


def checksum(data):
    return sum(struct.unpack('>' + 'I' * (len(padded(data)) // 4), padded(data))) & 0xffffffff


def build():
    glyph = padded(pack('hhhhhHH', 1, 100, 0, 800, 700, 3, 0) + bytes([1] * 4)
                   + pack('hhhhhhhh', 100, 700, 0, -700, 0, 0, 700, 0))
    points = {ord(char): 1 for text in ['😀', '🍎', '🚀', '❤️', '👩‍💻', '🏳️‍🌈'] for char in text}
    points.update({0x200d: 2, 0xfe0f: 2})
    groups = sorted(points.items())
    cmap12 = pack('HHIII', 12, 0, 16 + 12 * len(groups), 0, len(groups))
    cmap12 += b''.join(pack('III', point, point, glyph_id) for point, glyph_id in groups)
    bmp = [(point, glyph_id) for point, glyph_id in groups if point <= 0xffff] + [(0xffff, 0)]
    count = len(bmp)
    power = 2 ** int(math.log2(count))
    cmap4 = pack('HHHHHHH', 4, 16 + 8 * count, 0, 2 * count, 2 * power, int(math.log2(count)), 2 * (count - power))
    cmap4 += b''.join(pack('H', point) for point, _ in bmp) + pack('H', 0)
    cmap4 += b''.join(pack('H', point) for point, _ in bmp)
    cmap4 += b''.join(pack('H', (glyph_id - point) & 0xffff) for point, glyph_id in bmp) + bytes(2 * count)
    # Explicit VS16 coverage keeps color-emoji selection from skipping the trap.
    cmap14 = pack('HII', 14, 33, 1) + bytes([0, 0xfe, 0x0f]) + pack('II', 21, 0)
    cmap14 += pack('I', 2) + bytes([0, 0x27, 0x64, 0, 1, 0xf3, 0xf3, 0])
    cmap = pack('HH', 0, 3) + pack('HHI', 3, 1, 28) + pack('HHI', 3, 10, 28 + len(cmap4))
    cmap += pack('HHI', 0, 5, 28 + len(cmap4) + len(cmap12)) + cmap4 + cmap12 + cmap14
    names = [(1, 'EnvGuard Emoji Fallback'), (2, 'Regular'), (3, 'EnvGuardEmojiFallback1'), (4, 'EnvGuard Emoji Fallback'), (6, 'EnvGuardEmojiFallback')]
    strings, records = b'', b''
    for key, value in names:
        value = value.encode('utf-16be')
        records += pack('HHHHHH', 3, 1, 0x409, key, len(value), len(strings))
        strings += value
    os2 = bytearray(78)
    struct.pack_into('>HhHH', os2, 0, 0, 1000, 400, 5)
    os2[58:62] = b'EGCC'
    struct.pack_into('>HHHhhhHH', os2, 62, 0x40, 0x200d, 0xffff, 800, -200, 0, 800, 200)
    tables = {
        'OS/2': bytes(os2), 'cmap': cmap, 'glyf': glyph,
        'head': pack('IIIIHHQQhhhhHHhhh', 0x10000, 0x10000, 0, 0x5f0f3cf5, 3, 1000, 0, 0, 0, 0, 800, 700, 0, 8, 2, 1, 0),
        'hhea': pack('IhhhH' + 'h' * 11 + 'H', 0x10000, 800, -200, 0, 1000, 0, 0, 800, 1, 0, 0, 0, 0, 0, 0, 0, 3),
        'hmtx': pack('HhHhHh', 1000, 0, 1000, 0, 0, 0),
        'loca': pack('IIII', 0, 0, len(glyph), len(glyph)),
        'maxp': pack('IH' + 'H' * 13, 0x10000, 3, 4, 1, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0),
        'name': pack('HHH', 0, len(names), 6 + len(records)) + records + strings,
        'post': pack('IihhIIIII', 0x30000, 0, -100, 50, 0, 0, 0, 0, 0),
    }
    count = len(tables)
    power = 2 ** int(math.log2(count))
    directory = pack('IHHHH', 0x10000, count, 16 * power, int(math.log2(count)), 16 * (count - power))
    payload, offsets = b'', {}
    for tag, data in sorted(tables.items()):
        offset = 12 + 16 * count + len(payload)
        offsets[tag] = offset
        directory += tag.encode() + pack('III', checksum(data), offset, len(data))
        payload += padded(data)
    font = bytearray(directory + payload)
    struct.pack_into('>I', font, offsets['head'] + 8, (0xb1b0afba - checksum(font)) & 0xffffffff)
    assert checksum(font) == 0xb1b0afba
    return bytes(font)


if __name__ == '__main__':
    font = base64.b64encode(build()).decode()
    target = Path(__file__).resolve().parents[1] / 'src/detection/emoji-fallback-font.ts'
    target.write_text('// Synthetic glyph trap; regenerate with python3 scripts/build-emoji-fallback.py.\n'
                      + "export const EMOJI_FALLBACK_FONT = 'data:font/ttf;base64," + font + "';\n")
