"""Verify traces.json: paths exist, ranges are in the file, symbol appears in range. Stdlib only.

Default reads the working tree. With --head it reads files from git HEAD (the commit
named in source_commit), which is the reference for the line numbers.
"""
import json
import subprocess
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[2]
doc = json.loads((Path(__file__).parent / "traces.json").read_text(encoding="utf-8"))
head = "--head" in sys.argv


def read(rel):
    if head:
        r = subprocess.run(["git", "show", f"HEAD:{rel}"], cwd=root, capture_output=True,
                           text=True, encoding="utf-8")
        return r.stdout.splitlines() if r.returncode == 0 else None
    p = root / rel
    return p.read_text(encoding="utf-8").splitlines() if p.is_file() else None


bad = 0
n = 0
for t in doc["traces"]:
    for s in t["steps"]:
        n += 1
        lines = read(s["path"])
        if lines is None:
            print(f"MISSING {t['id']}: {s['path']}")
            bad += 1
            continue
        a, b = s["start"], s["end"]
        if not (1 <= a <= b <= len(lines)):
            print(f"RANGE {t['id']}: {s['path']}:{a}-{b} (file has {len(lines)})")
            bad += 1
            continue
        if s["symbol"] not in "\n".join(lines[a - 1:b]):
            print(f"SYMBOL {t['id']}: {s['symbol']!r} not in {s['path']}:{a}-{b}")
            bad += 1
print(f"{n} steps checked, {bad} problems ({'HEAD' if head else 'working tree'})")
sys.exit(1 if bad else 0)
