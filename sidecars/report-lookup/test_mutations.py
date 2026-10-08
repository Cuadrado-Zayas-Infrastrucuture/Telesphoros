"""Offline targeted defect injection. Mutates an isolated copy, never the working source; no clinical data."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
MODULE = "apps/backend/src/services/report-lookup/"
# (name, file, exact replacements, independently written oracle test name)
MUTANTS = [
    ("erase-unavailable-basis", "contracts.ts",
     [("basis: z.literal('unavailable-token'),", "basis: z.literal('unavailable-token').optional(),")],
     "erasing the unavailable basis"),
    ("admit-empty-diplotype", "lookup.ts",
     [("if (diagnostics.length > 0) return hold(diagnostics[0]!.stage, diagnostics[0]!.reasonCode);", "")],
     "empty diplotype beside a canonical"),
    ("ignore-diplotype-for-unavailable", "lookup.ts",
     [("if (diplotype.state === 'present') {", "if (diplotype.state === 'present' && state.state !== 'approved-unavailable') {"),
      ("record.type !== 'unavailable' || diplotype.state !== 'missing' ||", "record.type !== 'unavailable' ||")],
     "unavailable beside"),
    ("capture-scope-bypass", "lookup.ts",
     [("!scoped(capture, scope.data) || !scoped(capture.acceptance, scope.data) ||", "")],
     "capture is bound to"),
    ("stale-capture-acceptance", "lookup.ts",
     [("capture.acceptance.decision !== 'accepted'", "false"),
      ("capture.acceptance.id !== shell.data.captureAcceptanceId", "false")],
     "latest rejection cannot be bypassed"),
    ("context-scope-bypass", "lookup.ts",
     [(" || !scoped(contextReview, scope.data)", "")],
     "external context targets"),
    ("superseded-evidence-review", "lookup.ts",
     [("latest[0]!.reviewId !== payload.review.id", "false")],
     "record hash tampering and superseded"),
    ("combined-falls-back", "routing.ts",
     [("if (!policy.reviewedRows.some((s) => key(s) === key(selector))) return hold('out-of-review-scope');",
       "if (!policy.reviewedRows.some((s) => key(s) === key(selector))) return routeAdmitted(states.map((s) => s.gene === 'CYP2B6' ? { gene: 'CYP2B6', state: 'absent', coverageRecordId: 'mutation' } : s), policy, knowledge);")],
     "excluded combined cell never falls back"),
    ("expose-clinical-wording", "routing.ts",
     [("return { state: 'row-selected', selectedRow: selector };",
       "return { state: 'row-selected', selectedRow: selector, recommendationText: row.recommendationText };")],
     "canonical / canonical"),
]


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    originals = {name: (ROOT / MODULE / name).read_text() for name in {m[1] for m in MUTANTS}}
    before = {name: digest(ROOT / MODULE / name) for name in originals}
    results = []
    with tempfile.TemporaryDirectory(prefix="pgx-lookup-mutations-") as directory:
        clone = Path(directory) / "repo"
        shutil.copytree(ROOT, clone, ignore=shutil.ignore_patterns(
            "node_modules", ".git", "dist", "coverage", "__pycache__", ".venv", ".terraform"))
        for path in ROOT.rglob("node_modules"):
            if "node_modules" not in path.relative_to(ROOT).parts[:-1]:
                target = clone / path.relative_to(ROOT)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.symlink_to(path, target_is_directory=True)
        jobs = [("harmless-control", "routing.ts", [], "canonical / canonical"), *MUTANTS]
        for name, filename, replacements, test in jobs:
            for source, content in originals.items():
                (clone / MODULE / source).write_text(content)
            target = clone / MODULE / filename
            content = target.read_text()
            for old, new in replacements:
                if content.count(old) != 1:
                    raise ValueError("mutation anchor drift: " + name)
                content = content.replace(old, new)
            target.write_text(content + ("\n// harmless formatting control\n" if name == "harmless-control" else ""))
            report = Path(directory) / (name + ".json")
            run = subprocess.run(["node", str(ROOT / "apps/backend/node_modules/jest/bin/jest.js"),
                "--config", str(clone / "apps/backend/jest.config.js"), "--runInBand",
                "services/report-lookup/lookup.spec.ts", "-t", test, "--json", "--outputFile=" + str(report)],
                cwd=clone / "apps/backend", capture_output=True, text=True, timeout=40, env=os.environ)
            data = json.loads(report.read_text()) if report.exists() else {}
            failed = data.get("numFailedTests", 0)
            runtime = data.get("numRuntimeErrorTestSuites", 0)
            passed = data.get("numPassedTests", 0)
            good = run.returncode == 0 and passed > 0 if name == "harmless-control" else run.returncode != 0 and failed > 0 and runtime == 0
            results.append({"id": name, "oracle": test, "passedAssertions": passed, "failedAssertions": failed,
                "runtimeErrorSuites": runtime, "controlOrMutantExpectedResult": good})
    unchanged = before == {name: digest(ROOT / MODULE / name) for name in originals}
    output = {"schema": "report-lookup-mutation-results/1", "syntheticDevelopmentOnly": True,
        "workingSourcesUnchanged": unchanged, "results": results, "allExpected": unchanged and all(r["controlOrMutantExpectedResult"] for r in results)}
    Path(args.output).write_text(json.dumps(output, indent=2) + "\n")
    print(json.dumps({"allExpected": output["allExpected"], "mutants": len(MUTANTS), "controls": 1, "workingSourcesUnchanged": unchanged}))
    return 0 if output["allExpected"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
