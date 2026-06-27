#!/usr/bin/env python
"""Shadow-run the V2 brief generator and check structural parity vs the baseline.

The Phase-3 cutover GATE: before flipping ``LOCAL_FITNESS_BRIEF_V2`` on for the
live brief, prove the new toolless generator behaves like the old monolith. This
runs the V2 path across the same golden fixtures (with ``save=False`` so it can
never touch ``briefings/``), fingerprints each brief with
``ab_brief.extract_features``, and diffs those fingerprints against the committed
``tests/evals/baseline.json`` (captured on V1).

The gate is **deterministic and judge-free** (per the design): structural parity
only. The structural checks per scenario are —
  * every brief is schema-valid (no parse/validation failures)
  * the mandated steps takeaway is present in every brief
  * takeaway count stays in [3, 5] AND within ±1 of the baseline's median
  * plan-folding matches plan_active (HARD for the plan scenario; ADVISORY for
    the others, because ab_brief's plan-keyword heuristic is noisy on the
    prompt's own "today's session" phrasing — the baseline itself recorded that)

Invention-rate (≤ baseline) is the OTHER half of the gate but needs
``grounding.flag``, which lands in Phase 4 and backfills it here. Until then this
reports structural parity only and says so.

Cost discipline (the project's "quote spend + hard cap" rule), same as
capture_baseline.py: dry-run by DEFAULT; ``--run`` guarded by a hard cap;
``--mock`` aggregates canned V2 briefs with zero model calls; auth is the Claude
Max subscription (CLAUDE_CODE_OAUTH_TOKEN), no per-token billing.

Usage:
  uv run python scripts/shadow_run.py                       # dry-run: plan + estimate
  uv run python scripts/shadow_run.py --run                 # shadow V2 + parity report
  uv run python scripts/shadow_run.py --mock canned.json    # cost-free parity check
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

import capture_baseline as cb
import eval_fixtures

_BASELINE_PATH = cb._BASELINE_PATH
_V2_ENV = "LOCAL_FITNESS_BRIEF_V2"


def _median_count(fingerprints: list[dict]) -> int | None:
    if not fingerprints:
        return None
    counts = sorted(f["n_takeaways"] for f in fingerprints)
    return counts[len(counts) // 2]


def parity_report(baseline_doc: dict, shadow: dict[str, dict]) -> dict:
    """Compare V2 shadow records against the committed V1 baseline. Pure +
    deterministic so it is unit-tested without a model."""
    base = baseline_doc.get("scenarios", {})
    scenarios: dict[str, dict] = {}
    overall = True
    for name, rec in shadow.items():
        b_fps = base.get(name, {}).get("fingerprints", [])
        s_fps = rec.get("fingerprints", [])
        plan_active = name in cb._PLAN_ACTIVE_SCENARIOS
        warnings: list[str] = []

        checks = {
            "has_success": bool(s_fps),
            "schema_valid": rec.get("schema_invalid", 0) == 0 and bool(s_fps),
            "steps_mandate": bool(s_fps) and all(f["has_steps"] for f in s_fps),
            "count_in_range": bool(s_fps) and all(3 <= f["n_takeaways"] <= 5 for f in s_fps),
        }
        b_med, s_med = _median_count(b_fps), _median_count(s_fps)
        checks["count_near_baseline"] = (
            b_med is not None and s_med is not None and abs(s_med - b_med) <= 1)

        plan_ok = bool(s_fps) and all(f["mentions_plan"] == plan_active for f in s_fps)
        if plan_active:
            checks["plan_parity"] = plan_ok          # HARD: the plan MUST fold in
        else:
            checks["plan_parity"] = True             # not gated (heuristic noise)
            if not plan_ok:
                warnings.append(
                    "mentions_plan flipped on a non-plan scenario — ab_brief "
                    "plan-keyword noise on 'today's session' phrasing (advisory)")

        parity = all(checks.values())
        overall = overall and parity
        scenarios[name] = {
            "parity": parity,
            "checks": checks,
            "warnings": warnings,
            "baseline_median_count": b_med,
            "shadow_median_count": s_med,
            "flakes": len(rec.get("flakes", [])),
        }
    return {
        "overall_parity": overall,
        "invention_rate_gate": "pending Phase 4 (grounding.flag) — structural parity only",
        "scenarios": scenarios,
    }


def _run_shadow_live(scenarios: list[str], model: str, runs: int) -> dict[str, dict]:
    """Capture V2 fingerprints by forcing the flag ON around the shared
    live-capture harness, then restoring it."""
    prior = os.environ.get(_V2_ENV)
    os.environ[_V2_ENV] = "1"
    try:
        return cb._capture_live(scenarios, model, runs)
    finally:
        if prior is None:
            os.environ.pop(_V2_ENV, None)
        else:
            os.environ[_V2_ENV] = prior


def _print_report(report: dict) -> None:
    print("\n=== V2 shadow-run structural parity vs baseline ===")
    for name, rec in report["scenarios"].items():
        verdict = "PARITY" if rec["parity"] else "MISMATCH"
        failed = [k for k, v in rec["checks"].items() if not v]
        print(f"  {name}: {verdict}  "
              f"(baseline_count={rec['baseline_median_count']} "
              f"shadow_count={rec['shadow_median_count']} flakes={rec['flakes']})")
        for f in failed:
            print(f"      FAILED CHECK: {f}")
        for w in rec["warnings"]:
            print(f"      warning: {w}")
    print(f"\n  invention-rate gate: {report['invention_rate_gate']}")
    if report["overall_parity"]:
        print("\nOVERALL: STRUCTURAL PARITY HOLDS — safe to flip the flag once "
              "invention-rate ≤ baseline is wired (Phase 4).")
    else:
        print("\nOVERALL: PARITY FAILED — keep the flag OFF; investigate the "
              "mismatched scenarios before retry.")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Shadow-run V2 and check parity vs baseline")
    ap.add_argument("--scenarios", default=",".join(eval_fixtures.SCENARIOS))
    ap.add_argument("--runs", type=int, default=cb.DEFAULT_RUNS)
    ap.add_argument("--model", default=cb.DEFAULT_MODEL)
    ap.add_argument("--baseline", default=str(_BASELINE_PATH))
    ap.add_argument("--run", action="store_true", help="call the model (default: dry-run)")
    ap.add_argument("--mock", help="JSON {scenario: [v2_brief, ...]} — parity check, no model")
    ap.add_argument("--out", help="optional path to write the parity report JSON")
    args = ap.parse_args(argv)
    scenarios = [s.strip() for s in args.scenarios.split(",") if s.strip()]
    unknown = [s for s in scenarios if s not in eval_fixtures.SCENARIOS]
    if unknown:
        print(f"REFUSED: unknown scenario(s) {unknown}; "
              f"valid: {list(eval_fixtures.SCENARIOS)}", file=sys.stderr)
        return 2

    baseline_path = Path(args.baseline)
    if not baseline_path.exists():
        print(f"REFUSED: baseline not found at {baseline_path}. Run "
              "capture_baseline.py --run first.", file=sys.stderr)
        return 2
    baseline_doc = json.loads(baseline_path.read_text())

    if args.mock:
        shadow = cb._aggregate_mock(json.loads(Path(args.mock).read_text()))
        report = parity_report(baseline_doc, shadow)
        _print_report(report)
        _maybe_write(args.out, report)
        return 0 if report["overall_parity"] else 1

    est = cb.estimate(scenarios, args.runs)
    if not args.run:
        print(f"Shadow-run plan: scenarios={scenarios} runs={args.runs} (V2 flag forced ON)")
        print(f"  -> {est['generations']} generations (hard cap {cb.MAX_GENERATIONS})")
        print(f"  -> est ~{est['est_seconds']}s wall, ~{est['est_output_tokens']:,} output tokens")
        print(f"  Compares V2 fingerprints against {baseline_path}.")
        print("  Uses the Claude Max subscription (CLAUDE_CODE_OAUTH_TOKEN) — no per-token billing.")
        print("  Re-run with --run to execute, or --mock <file> for a cost-free check.")
        return 0

    if est["generations"] > cb.MAX_GENERATIONS:
        print(f"REFUSED: {est['generations']} generations exceeds cap "
              f"{cb.MAX_GENERATIONS}. Lower --runs or --scenarios.", file=sys.stderr)
        return 2

    print(f"Shadow-running V2: {est['generations']} generations (save=False)...")
    shadow = _run_shadow_live(scenarios, args.model, args.runs)
    report = parity_report(baseline_doc, shadow)
    _print_report(report)
    _maybe_write(args.out, report)
    return 0 if report["overall_parity"] else 1


def _maybe_write(out: str | None, report: dict) -> None:
    if out:
        Path(out).parent.mkdir(parents=True, exist_ok=True)
        Path(out).write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
        print(f"\nWrote parity report -> {out}")


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    raise SystemExit(main())
