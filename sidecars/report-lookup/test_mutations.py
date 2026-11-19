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
# The mutants live in mutants.json, which .github/ci/report-lookup-mutations.test.mjs also reads: an anchor that drifts fails on the
# pull request that moves it, not only here.
SPEC = json.loads((Path(__file__).resolve().parent / "mutants.json").read_text())
MODULE = SPEC["module"]
# (name, file, exact replacements, independently written oracle test name)
MUTANTS = [(m["id"], m["file"], [tuple(r) for r in m["replacements"]], m["oracle"]) for m in SPEC["mutants"]]


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
