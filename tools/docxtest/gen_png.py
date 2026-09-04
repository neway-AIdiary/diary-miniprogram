"""生成 3x2 红色 PNG 测试图片"""
import struct, zlib

def chunk(t, d):
    return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)

w, h = 3, 2
raw = b''
for y in range(h):
    raw += b'\x00' + b'\xff\x00\x00' * w
png = (b'\x89PNG\r\n\x1a\n' +
       chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) +
       chunk(b'IDAT', zlib.compress(raw)) +
       chunk(b'IEND', b''))
open('tmp_img.png', 'wb').write(png)
print('PNG OK', w, 'x', h)
