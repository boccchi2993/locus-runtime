#!/usr/bin/env python3
"""Deterministically regenerate the synthetic pure-Python wheel fixture.

TEST ONLY. Produces a REAL wheel (correct zip layout, dist-info METADATA /
WHEEL / RECORD with hash+size rows, fixed timestamps, deterministic member
order) for the capability-package fixtures:

    tests/fixtures/capability-package/minimal/plugins/locus-test-plugin/
        artifacts/locus_test_plugin-1.0.0-py3-none-any.whl

The wheel is pure-Python, dependency-free, network-free and exposes exactly
one deterministic function: locus_test_plugin.answer() == 42. The Trusted
Plugin Runtime milestone reuses these bytes directly.

Stdlib only: no pip, no build backend, no network. Byte-identical across
runs (fixed date_time, fixed member order, fixed external attrs).
"""
import base64
import hashlib
import io
import zipfile
from pathlib import Path

MODULE = "locus_test_plugin"
DIST_NAME = "locus-test-plugin"
VERSION = "1.0.0"
DIST = f"{MODULE}-{VERSION}.dist-info"
FIXED_DATE = (2020, 1, 1, 0, 0, 0)
WHEEL_FILENAME = f"{MODULE}-{VERSION}-py3-none-any.whl"

INIT_PY = '''"""Locus synthetic test plugin (TEST fixture only)."""

__version__ = "1.0.0"


def answer():
    """Deterministic smoke-test value for the plugin package boundary."""
    return 42
'''

METADATA = (
    "Metadata-Version: 2.1\n"
    f"Name: {DIST_NAME}\n"
    f"Version: {VERSION}\n"
    "Summary: Locus synthetic pure-Python wheel fixture (TEST ONLY)\n"
    "Description-Content-Type: text/markdown\n"
    "\n"
    "# locus-test-plugin\n"
    "\n"
    "TEST ONLY fixture wheel for the Locus capability package core.\n"
    "Provides exactly one deterministic function: answer() == 42.\n"
)

WHEEL = (
    "Wheel-Version: 1.0\n"
    "Generator: locus-fixture-build-wheel-1\n"
    "Root-Is-Purelib: true\n"
    "Tag: py3-none-any\n"
)


def record_digest(data: bytes) -> str:
    sha = base64.urlsafe_b64encode(hashlib.sha256(data).digest())
    return "sha256=" + sha.rstrip(b"=").decode("ascii")


def main() -> None:
    members = [
        (f"{MODULE}/__init__.py", INIT_PY.encode("utf-8")),
        (f"{DIST}/METADATA", METADATA.encode("utf-8")),
        (f"{DIST}/WHEEL", WHEEL.encode("utf-8")),
    ]
    record_rows = [f"{name},{record_digest(data)},{len(data)}" for name, data in members]
    record_rows.append(f"{DIST}/RECORD,,")
    record = ("\n".join(record_rows) + "\n").encode("utf-8")

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for name, data in members + [(f"{DIST}/RECORD", record)]:
            info = zipfile.ZipInfo(name, date_time=FIXED_DATE)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 3  # unix, pinned for determinism
            info.external_attr = 0o644 << 16
            zf.writestr(info, data)

    out_dir = (Path(__file__).resolve().parent.parent
               / "minimal" / "plugins" / "locus-test-plugin" / "artifacts")
    out_dir.mkdir(parents=True, exist_ok=True)
    out_file = out_dir / WHEEL_FILENAME
    out_file.write_bytes(buf.getvalue())
    print(f"wrote {out_file} ({out_file.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
