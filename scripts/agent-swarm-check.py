#!/usr/bin/env python3
"""Independent contract checks for the disposable swarm JSONL reporter."""
import json
from pathlib import Path
import subprocess
import sys

root = Path(sys.argv[1]).resolve()
cases, failures = [], []


def require(condition, detail):
    if not condition:
        failures.append(detail)


def check(name, args=(), data="", expected=None, error=False, line=None):
    try:
        result = subprocess.run([sys.executable, str(root / "report.py"), *args], cwd=root,
                                input=data, text=True, capture_output=True, timeout=5)
    except subprocess.TimeoutExpired:
        result = subprocess.CompletedProcess(args, 124, "", "timed out")
    cases.append(name)
    if error:
        require(result.returncode == 2 and not result.stdout and bool(result.stderr),
                f"{name}: expected exit 2, stderr, no stdout; got {result.returncode}: {result.stdout[:200]}")
        if line is not None:
            require(f"line {line}" in result.stderr.lower(), f"{name}: expected line {line} in stderr")
    else:
        require(result.returncode == 0 and not result.stderr,
                f"{name}: expected exit 0 and no stderr; got {result.returncode}: {result.stderr[:200]}")
        if expected is not None:
            try:
                require(json.loads(result.stdout) == expected, f"{name}: incorrect JSON counts: {result.stdout[:300]}")
            except ValueError:
                failures.append(f"{name}: stdout is not JSON")
    return result


empty = {"total": 0, "services": {}}
check("empty", ["--json"], expected=empty)
check("blanks", ["--json"], data="\n \n\t\n", expected=empty)
data = '{"service":" zeta ","level":"info"}\n{"service":"api","level":"error"}\n{"service":"api","level":"warning"}\n{"service":"東京","level":"error","extra":true}\n'
counts = lambda i, w, e: {"info": i, "warning": w, "error": e}
result = check("aggregation-trimming-unicode", ["--json"], data, {
    "total": 4, "services": {"api": counts(0, 1, 1), "zeta": counts(1, 0, 0), "東京": counts(0, 0, 1)}})
try:
    require(list(json.loads(result.stdout)["services"]) == ["api", "zeta", "東京"],
            "aggregation-trimming-unicode: JSON service names must be sorted")
    require("東京" in result.stdout, "aggregation-trimming-unicode: emit actual Unicode")
except (ValueError, KeyError, TypeError):
    failures.append("aggregation-trimming-unicode: invalid JSON result shape")
check("threshold-warning", ["--json", "--min-level", "warning"], data, {
    "total": 3, "services": {"api": counts(0, 1, 1), "東京": counts(0, 0, 1)}})
check("threshold-error", ["--json", "--min-level", "error"], data, {
    "total": 2, "services": {"api": counts(0, 0, 1), "東京": counts(0, 0, 1)}})
check("explicit-stdin", ["-", "--json"], expected=empty)
for name, record in (
    ("malformed", "{bad"), ("array", "[]"), ("null", "null"),
    ("missing-service", '{"level":"info"}'), ("service-type", '{"service":7,"level":"info"}'),
    ("blank-service", '{"service":"  ","level":"info"}'), ("missing-level", '{"service":"api"}'),
    ("level-type", '{"service":"api","level":[]}'), ("invalid-level", '{"service":"api","level":"fatal"}')
):
    check(name, ["--json"], "\n" + record, error=True, line=2)
check("validate-before-filter", ["--json", "--min-level", "error"],
      '{"service":null,"level":"info"}', error=True, line=1)
file = root / "acceptance-events.jsonl"
file.write_text(data)
check("file-input", [str(file), "--json", "--min-level", "error"], expected={
    "total": 2, "services": {"api": counts(0, 0, 1), "東京": counts(0, 0, 1)}})
check("missing-file", [str(root / "acceptance-absent.jsonl"), "--json"], error=True)
check("invalid-option", ["--min-level", "fatal", "--json"], error=True)
result = check("text-output", data=data)
require("4" in result.stdout and "api" in result.stdout, "text-output: missing total or service counts")
print(json.dumps({"status": "failed" if failures else "passed", "cases": len(cases), "names": cases, "failures": failures}))
raise SystemExit(1 if failures else 0)
