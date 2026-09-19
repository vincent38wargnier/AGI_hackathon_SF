#!/usr/bin/env python3
import json
import pathlib
import subprocess
import sys


REPO = pathlib.Path(__file__).resolve().parents[1]
TASK_DIR = pathlib.Path("/home/vincent/vince_assistant_codex/workspace/tasks/voice-python-acceptance")
HARNESS = REPO / "test" / "python-acceptance-harness.mjs"
RAW_OUTPUT = TASK_DIR / "voice_acceptance_raw_output.txt"
JSON_OUTPUT = TASK_DIR / "voice_acceptance_results.json"


def main() -> int:
    TASK_DIR.mkdir(parents=True, exist_ok=True)
    command = ["node", str(HARNESS)]
    completed = subprocess.run(
        command,
        cwd=REPO,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    RAW_OUTPUT.write_text(completed.stdout, encoding="utf-8")
    try:
        parsed = json.loads(completed.stdout)
    except json.JSONDecodeError:
        parsed = {
            "ok": False,
            "failed": 1,
            "parse_error": "Node harness did not emit JSON",
            "raw_output": completed.stdout,
        }
    JSON_OUTPUT.write_text(json.dumps(parsed, indent=2), encoding="utf-8")

    print(f"command: {' '.join(command)}")
    print(f"exit_code: {completed.returncode}")
    print(f"raw_output: {RAW_OUTPUT}")
    print(f"json_output: {JSON_OUTPUT}")
    if isinstance(parsed, dict):
        print(f"ok: {parsed.get('ok')}")
        print(f"passed: {parsed.get('passed')}")
        print(f"failed: {parsed.get('failed')}")
        for result in parsed.get("results", []):
            status = "PASS" if result.get("ok") else "FAIL"
            print(f"{status} {result.get('name')} ({result.get('elapsedMs')}ms)")
            if not result.get("ok"):
                print(f"  {result.get('error', {}).get('message')}")
    return completed.returncode if completed.returncode else (0 if parsed.get("ok") else 1)


if __name__ == "__main__":
    sys.exit(main())
