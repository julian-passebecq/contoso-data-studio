"""Verify traces.json. Stdlib only.

For every step of every trace and sub-trace: the path exists, the range is inside the file,
the symbol appears in the range, and confidence is one of verified|inferred|unresolved.
For every trace: status RESOLVED only if no step is unresolved; a trace with an unresolved
step must be PARTIAL and must list its unresolved edges. Prints counts per confidence.

Default reads the working tree. With --head it reads files from git HEAD (the commit
named in source_commit), which is the reference for the line numbers.
"""
import json
import subprocess
import sys
from pathlib import Path

CONFIDENCE = ("verified", "inferred", "unresolved")
STATUS = ("RESOLVED", "PARTIAL")

root = Path(__file__).resolve().parents[2]
doc = json.loads((Path(__file__).parent / "traces.json").read_text(encoding="utf-8"))
head = "--head" in sys.argv
cache = {}


def read(rel):
    if rel not in cache:
        if head:
            r = subprocess.run(["git", "show", f"HEAD:{rel}"], cwd=root, capture_output=True,
                               text=True, encoding="utf-8")
            cache[rel] = r.stdout.splitlines() if r.returncode == 0 else None
        else:
            p = root / rel
            cache[rel] = p.read_text(encoding="utf-8").splitlines() if p.is_file() else None
    return cache[rel]


def walk(traces):
    for t in traces:
        yield t
        yield from walk(t.get("subtraces", []))


bad = 0
n = 0
totals = {c: 0 for c in CONFIDENCE}
statuses = []
for t in walk(doc["traces"]):
    tid = t["id"]
    counts = {c: 0 for c in CONFIDENCE}
    for s in t["steps"]:
        n += 1
        conf = s.get("confidence")
        if conf not in CONFIDENCE:
            print(f"CONFIDENCE {tid}: {s['path']}:{s['start']} has {conf!r}")
            bad += 1
        else:
            counts[conf] += 1
        lines = read(s["path"])
        if lines is None:
            print(f"MISSING {tid}: {s['path']}")
            bad += 1
            continue
        a, b = s["start"], s["end"]
        if not (1 <= a <= b <= len(lines)):
            print(f"RANGE {tid}: {s['path']}:{a}-{b} (file has {len(lines)})")
            bad += 1
            continue
        if s["symbol"] not in "\n".join(lines[a - 1:b]):
            print(f"SYMBOL {tid}: {s['symbol']!r} not in {s['path']}:{a}-{b}")
            bad += 1
    status = t.get("status")
    if status not in STATUS:
        print(f"STATUS {tid}: {status!r}")
        bad += 1
    elif counts["unresolved"] and status == "RESOLVED":
        print(f"STATUS {tid}: RESOLVED with {counts['unresolved']} unresolved step(s)")
        bad += 1
    elif counts["unresolved"] and not t.get("unresolved"):
        print(f"STATUS {tid}: unresolved step(s) not listed under 'unresolved'")
        bad += 1
    elif status == "PARTIAL" and not counts["unresolved"]:
        print(f"STATUS {tid}: PARTIAL without an unresolved step")
        bad += 1
    for c in CONFIDENCE:
        totals[c] += counts[c]
    statuses.append(f"{tid}={status} (v{counts['verified']}/i{counts['inferred']}/u{counts['unresolved']})")

print("\n".join(statuses))
print("confidence: " + ", ".join(f"{c}={totals[c]}" for c in CONFIDENCE))
print(f"{len(statuses)} traces, {n} steps checked, {bad} problems ({'HEAD' if head else 'working tree'})")
sys.exit(1 if bad else 0)
