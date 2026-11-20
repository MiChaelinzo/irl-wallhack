"""Minimal QR Code generator for the pairing URL (byte mode, error correction level M, versions 1-6).

Written for this repository from ISO/IEC 18004 (no third-party code, no network, no CDN). It only has
to encode one short URL, so it covers versions 1 to 6 (up to 106 bytes) and refuses anything longer.
The browser draws the module matrix it returns; nothing is encoded in JavaScript.
"""
from typing import List

# version -> (data codewords per block, EC codewords per block, number of blocks), level M
_BLOCKS = {1: (16, 10, 1), 2: (28, 16, 1), 3: (44, 26, 1), 4: (32, 18, 2), 5: (43, 24, 2), 6: (27, 16, 4)}
_ALIGNMENT = {1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34]}
_REMAINDER_BITS = {1: 0, 2: 7, 3: 7, 4: 7, 5: 7, 6: 7}
_FORMAT_LEVEL_M = 0b00
_FORMAT_GENERATOR = 0x537
_FORMAT_XOR = 0x5412
_PAD_BYTES = (0xEC, 0x11)
_PENALTY_RUN, _PENALTY_BLOCK, _PENALTY_FINDER, _PENALTY_BALANCE = 3, 3, 40, 10
_FINDER_LIKE = ((1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0), (0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1))
MAX_BYTES = max(b[0] * b[2] for b in _BLOCKS.values()) - 2   # mode and length take two bytes in effect


def _gf_tables():
    exp, log, x = [0] * 512, [0] * 256, 1
    for i in range(255):
        exp[i], log[x] = x, i
        x <<= 1
        if x & 0x100:
            x ^= 0x11D
    for i in range(255, 512):
        exp[i] = exp[i - 255]
    return exp, log


_EXP, _LOG = _gf_tables()


def _gf_mul(a: int, b: int) -> int:
    return 0 if a == 0 or b == 0 else _EXP[_LOG[a] + _LOG[b]]


def _reed_solomon(data: List[int], degree: int) -> List[int]:
    gen = [1]
    for i in range(degree):
        nxt = [0] * (len(gen) + 1)
        for j, coef in enumerate(gen):
            nxt[j] ^= coef
            nxt[j + 1] ^= _gf_mul(coef, _EXP[i])
        gen = nxt
    rem = [0] * degree
    for byte in data:
        factor = byte ^ rem[0]
        rem = rem[1:] + [0]
        for i in range(degree):
            rem[i] ^= _gf_mul(gen[i + 1], factor)
    return rem


def _choose_version(length: int) -> int:
    for version, (per_block, _ec, blocks) in _BLOCKS.items():
        if length + 2 <= per_block * blocks:     # 4 mode bits + 8 length bits + data fit in the data codewords
            return version
    raise ValueError("text of %d bytes does not fit a QR code of version 6 (limit %d bytes)" % (length, MAX_BYTES))


def _codewords(payload: bytes, version: int) -> List[int]:
    per_block, ec_len, blocks = _BLOCKS[version]
    capacity = per_block * blocks
    bits = "0100" + format(len(payload), "08b") + "".join(format(b, "08b") for b in payload)
    bits += "0" * min(4, capacity * 8 - len(bits))
    bits += "0" * (-len(bits) % 8)
    data = [int(bits[i:i + 8], 2) for i in range(0, len(bits), 8)]
    i = 0
    while len(data) < capacity:
        data.append(_PAD_BYTES[i % 2])
        i += 1
    chunks = [data[k * per_block:(k + 1) * per_block] for k in range(blocks)]
    ecs = [_reed_solomon(c, ec_len) for c in chunks]
    out = [chunk[i] for i in range(per_block) for chunk in chunks]
    out += [ec[i] for i in range(ec_len) for ec in ecs]
    return out


class _Grid:
    def __init__(self, version: int):
        self.size = 17 + 4 * version
        self.dark = [[False] * self.size for _ in range(self.size)]
        self.is_function = [[False] * self.size for _ in range(self.size)]
        self._draw_function_patterns(version)

    def set_function(self, x: int, y: int, dark: bool) -> None:
        self.dark[y][x] = dark
        self.is_function[y][x] = True

    def _draw_function_patterns(self, version: int) -> None:
        n = self.size
        for i in range(n):                                   # timing patterns
            self.set_function(6, i, i % 2 == 0)
            self.set_function(i, 6, i % 2 == 0)
        for cx, cy in ((3, 3), (n - 4, 3), (3, n - 4)):      # finder patterns with separators
            for dy in range(-4, 5):
                for dx in range(-4, 5):
                    x, y = cx + dx, cy + dy
                    if 0 <= x < n and 0 <= y < n:
                        self.set_function(x, y, max(abs(dx), abs(dy)) not in (2, 4))
        centres = _ALIGNMENT[version]
        for cx in centres:
            for cy in centres:
                if (cx, cy) in ((6, 6), (6, centres[-1]), (centres[-1], 6)):
                    continue                                 # would overlap a finder pattern
                for dy in range(-2, 3):
                    for dx in range(-2, 3):
                        self.set_function(cx + dx, cy + dy, max(abs(dx), abs(dy)) != 1)
        self.draw_format(0)                                  # reserve the format areas
        self.set_function(8, n - 8, True)                    # the always-dark module

    def draw_format(self, mask: int) -> None:
        data = _FORMAT_LEVEL_M << 3 | mask
        rem = data
        for _ in range(10):
            rem = (rem << 1) ^ ((rem >> 9) * _FORMAT_GENERATOR)
        bits = (data << 10 | rem) ^ _FORMAT_XOR
        n = self.size

        def bit(i): return (bits >> i) & 1 == 1
        for i in range(6):
            self.set_function(8, i, bit(i))
        self.set_function(8, 7, bit(6)); self.set_function(8, 8, bit(7)); self.set_function(7, 8, bit(8))
        for i in range(9, 15):
            self.set_function(14 - i, 8, bit(i))
        for i in range(8):
            self.set_function(n - 1 - i, 8, bit(i))
        for i in range(8, 15):
            self.set_function(8, n - 15 + i, bit(i))

    def place(self, codewords: List[int], remainder_bits: int) -> None:
        bits = [(cw >> (7 - k)) & 1 for cw in codewords for k in range(8)] + [0] * remainder_bits
        n, idx, upward, x = self.size, 0, True, self.size - 1
        while x > 0:
            if x == 6:
                x -= 1                                        # the vertical timing column is skipped
            rows = range(n - 1, -1, -1) if upward else range(n)
            for y in rows:
                for dx in (0, 1):
                    xx = x - dx
                    if not self.is_function[y][xx] and idx < len(bits):
                        self.dark[y][xx] = bits[idx] == 1
                        idx += 1
            upward = not upward
            x -= 2

    def apply_mask(self, mask: int) -> None:
        for y in range(self.size):
            for x in range(self.size):
                if not self.is_function[y][x] and _mask_hit(mask, x, y):
                    self.dark[y][x] = not self.dark[y][x]

    def penalty(self) -> int:
        n, total = self.size, 0
        lines = [row[:] for row in self.dark] + [[self.dark[y][x] for y in range(n)] for x in range(n)]
        for line in lines:
            run = 1
            for i in range(1, n):
                run = run + 1 if line[i] == line[i - 1] else 1
                if run == 5:
                    total += _PENALTY_RUN
                elif run > 5:
                    total += 1
            as_bits = tuple(int(v) for v in line)
            for i in range(n - 10):
                if as_bits[i:i + 11] in _FINDER_LIKE:
                    total += _PENALTY_FINDER
        for y in range(n - 1):
            for x in range(n - 1):
                if self.dark[y][x] == self.dark[y][x + 1] == self.dark[y + 1][x] == self.dark[y + 1][x + 1]:
                    total += _PENALTY_BLOCK
        dark = sum(sum(row) for row in self.dark)
        total += _PENALTY_BALANCE * (abs(dark * 20 - n * n * 10) // (n * n))   # steps of 5 % away from 50 %
        return total


def _mask_hit(mask: int, x: int, y: int) -> bool:
    return [(x + y) % 2 == 0, y % 2 == 0, x % 3 == 0, (x + y) % 3 == 0, (y // 2 + x // 3) % 2 == 0,
            x * y % 2 + x * y % 3 == 0, (x * y % 2 + x * y % 3) % 2 == 0, ((x + y) % 2 + x * y % 3) % 2 == 0][mask]


def encode(text: str) -> List[str]:
    """Module matrix for `text` (quiet zone not included). One string per row, '1' dark and '0' light.
    Raises ValueError when the text is longer than a version 6 code holds."""
    payload = text.encode("utf-8")
    version = _choose_version(len(payload))
    words = _codewords(payload, version)
    best = None
    for mask in range(8):
        grid = _Grid(version)
        grid.place(words, _REMAINDER_BITS[version])
        grid.apply_mask(mask)
        grid.draw_format(mask)
        score = grid.penalty()
        if best is None or score < best[0]:
            best = (score, grid)
    return ["".join("1" if v else "0" for v in row) for row in best[1].dark]
