#!/usr/bin/env python3
"""Losslessly re-encode docs/*.png with Pillow (maximum zlib effort, no colour change).

Needs the dev-only `pillow` package. Prints the total size before and after.
Usage: python tools/optimize_pngs.py [folder]
"""
import io
import sys
from pathlib import Path

from PIL import Image


def optimise(path: Path) -> None:
    """Rewrite the file only when the re-encoded PNG is smaller."""
    with Image.open(path) as img:
        img.load()
        if img.mode == "RGBA" and img.getextrema()[3] == (255, 255):
            img = img.convert("RGB")  # an opaque alpha channel carries no information
        buf = io.BytesIO()
        img.save(buf, format="PNG", optimize=True, compress_level=9)
    if len(buf.getvalue()) < path.stat().st_size:
        path.write_bytes(buf.getvalue())


def main() -> int:
    folder = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent / "docs"
    files = sorted(folder.glob("*.png"))
    before = sum(f.stat().st_size for f in files)
    for f in files:
        optimise(f)
    after = sum(f.stat().st_size for f in files)
    print("%d files: %.2f MB -> %.2f MB" % (len(files), before / 1e6, after / 1e6))
    return 0


if __name__ == "__main__":
    sys.exit(main())
