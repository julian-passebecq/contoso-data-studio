"""Render TRACES.md from traces.json. Stdlib only, deterministic.

    python -I docs/datapass-react/render_traces.py          # rewrite TRACES.md
    python -I docs/datapass-react/render_traces.py --check  # exit 1 when TRACES.md is stale

traces.json is the source of truth. The hand-written closing sections (End-to-end field,
Observations, React analyzer cross-check) live in traces_appendix.md and are copied verbatim.
The comparison ignores line endings (CRLF and LF render the same).
"""
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
CONFIDENCE = ("verified", "inferred", "unresolved")
INDENT = "&nbsp;&nbsp;"


def walk(traces, depth=0):
    for t in traces:
        yield t, depth
        yield from walk(t.get("subtraces", []), depth + 1)


def counts(trace):
    c = {k: 0 for k in CONFIDENCE}
    for s in trace["steps"]:
        c[s["confidence"]] += 1
    return c


def codes(items):
    return ", ".join(f"`{i}`" for i in items)


def step_row(s):
    note = s["note"]
    if s.get("confidence_reason"):
        note = f"{note} ({s['confidence_reason']})"
    note = note.replace("|", "/")  # a bare pipe would split the table cell
    loc = f"`{s['path']}:{s['start']}-{s['end']}`"
    return f"| {s['layer']} | {loc} | `{s['symbol']}` | {s['confidence']} | {note} |"


def trace_block(t, depth):
    hashes = "#" * (depth + 2)
    out = [f"{hashes} {t['id']} ({t['status']})", t["title"], ""]
    if t.get("gold_fields"):
        out += [f"Gold fields: {codes(t['gold_fields'])}", ""]
    if t.get("models_built"):
        out += [f"Models built: {codes(t['models_built'])}", ""]
    if t.get("note"):
        out += [t["note"], ""]
    out += ["| Layer | Location | Symbol | Confidence | Note |", "|---|---|---|---|---|"]
    out += [step_row(s) for s in t["steps"]]
    out.append("")
    if t.get("unresolved"):
        out.append("UNRESOLVED / notes:")
        out += [f"- {u}" for u in t["unresolved"]]
        out.append("")
    return out


def render(doc, appendix):
    out = [
        "# DataPass React consumer traces",
        "",
        f"Source commit: `{doc['source_commit']}` (origin/main the line numbers are checked against). "
        "Machine-readable twin: `traces.json`, rendered into this file with "
        "`python -I docs/datapass-react/render_traces.py` (do not edit by hand; add `--check` to "
        "fail when this file is stale). Verify with `python -I docs/datapass-react/check_traces.py` "
        "(add `--head` to read files from git HEAD).",
        "",
        "Confidence (DataPass React analyzer vocabulary), on every step:",
        "",
    ]
    out += [f"- **{k}**: {doc['confidence_vocabulary'][k]}" for k in CONFIDENCE]
    status = doc["status_rule"]
    if doc.get("status_note"):
        status = f"{status} {doc['status_note']}"
    out += ["", f"Status: {status}", "", "## Summary", "",
            "| Trace | Status | verified | inferred | unresolved |", "|---|---|---|---|---|"]
    totals = {k: 0 for k in CONFIDENCE}
    for t, depth in walk(doc["traces"]):
        c = counts(t)
        for k in CONFIDENCE:
            totals[k] += c[k]
        name = INDENT * depth + t["id"]
        out.append(f"| {name} | {t['status']} | {c['verified']} | {c['inferred']} | {c['unresolved']} |")
    out += [f"| **total** | | {totals['verified']} | {totals['inferred']} | {totals['unresolved']} |", ""]
    for t, depth in walk(doc["traces"]):
        out += trace_block(t, depth)
    text = "\n".join(out) + "\n" + appendix.replace("\r\n", "\n").strip("\n") + "\n"
    return text


def main(argv):
    doc = json.loads((HERE / "traces.json").read_text(encoding="utf-8"))
    appendix = (HERE / "traces_appendix.md").read_text(encoding="utf-8")
    text = render(doc, appendix)
    target = HERE / "TRACES.md"
    if "--check" in argv:
        current = target.read_text(encoding="utf-8").replace("\r\n", "\n") if target.is_file() else ""
        if current != text:
            print("TRACES.md is stale: run python -I docs/datapass-react/render_traces.py")
            return 1
        print("TRACES.md is up to date with traces.json")
        return 0
    target.write_bytes(text.encode("utf-8"))
    print(f"wrote {target.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
