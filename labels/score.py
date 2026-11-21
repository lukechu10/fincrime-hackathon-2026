"""Score development outputs against the local review labels.

Usage (from the repository root):
    python labels/score.py            # per-institution summary
    python labels/score.py -v         # plus the largest disagreement groups

The labels are our own review judgments, not organizer ground truth. Never read
them from the submission runner or the decision logic.
"""
import collections
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
# Brief cost matrix: (correct verdict, predicted verdict) -> cost.
COST = {("CLOSE", "RFI"): 3, ("CLOSE", "ESCALATE"): 3, ("RFI", "CLOSE"): 10,
        ("RFI", "ESCALATE"): 2, ("ESCALATE", "CLOSE"): 10, ("ESCALATE", "RFI"): 3}


def load(path):
    with open(path, encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


def main():
    verbose = "-v" in sys.argv
    labels = {row["case_id"]: row for row in load(ROOT / "labels" / "dev-labels.jsonl")}
    total = 0
    for institution in ["bank", "emoney", "investment", "payments_fx"]:
        path = ROOT / "output" / f"{institution}.jsonl"
        if not path.exists():
            print(f"{institution:12} missing {path}")
            continue
        outputs = load(path)
        cost = wrongful = verdicts = codes = 0
        errors = collections.Counter()
        examples = {}
        for out in outputs:
            label = labels[out["case_id"]]
            want, got = label["verdict"], out["verdict"]
            cost += COST.get((want, got), 0)
            wrongful += got == "CLOSE" and want != "CLOSE"
            verdicts += want == got
            codes += want == got and label["reason_code"] == out["reason_code"]
            if want != got or label["reason_code"] != out["reason_code"]:
                key = (label["family"], f"{want}/{label['reason_code']}", f"{got}/{out['reason_code']}")
                errors[key] += 1
                examples.setdefault(key, out["case_id"])
        total += cost
        n = len(outputs)
        print(f"{institution:12} cost={cost:5} wrongful_close={wrongful:3} "
              f"verdict_acc={verdicts / n:.3f} code_acc={codes / n:.3f}")
        if verbose:
            for key, count in errors.most_common(25):
                print(f"   {count:4} {key[0][:62]:62} want {key[1]:38} got {key[2]:38} e.g. {examples[key]}")
    print(f"TOTAL cost {total}")


if __name__ == "__main__":
    main()
