# Synthetic unseen-style cases

16 newly authored cases: four each for Bank, E-money, Investment and Payments/FX. Each institution folder is a standalone runner input with the same JSONL files and Markdown evidence layout as the organizer bundle. The SOPs are copied from the organizer bundle; the records, names and evidence are fictional. No development cases were copied or relabelled.

| Institution | What the cases exercise |
| --- | --- |
| `bank` | One penny below vs. exactly 5× declared income; a refund with the original debit outside the review window; admitted cash structuring. |
| `emoney` | Till takings net of retained float; rapid movement with proven ownership at both ends; unexplained cash top-up; confirmed sending-bank fraud. |
| `investment` | Documented redundancy and early redemption; family gift with a false-positive list hit; unexplained third-party funding; early redemption paid out to an unrelated third party. |
| `payments_fx` | Documented own-account funding; £10,000 holds with and without a matching invoice; confirmed invoice diversion. |

`expected.jsonl` is the separate answer key: one policy-based verdict, main reason code, rationale and list of decisive IDs per case. Each institution has two CLOSE, one RFI and one ESCALATE. These labels were authored from the case evidence, not taken from runner outputs. They are **not organizer ground truth**. The suite targets edge cases rather than estimating hidden-set accuracy. Once you tune on it, treat it as a regression suite, not an independent holdout. Never load the key or embed fixture-specific details in `system/`.

## Run and score

From the repository root, use the runner you want to evaluate. Predictions go in a temporary directory, not in the fixtures or development `output/`.

```sh
runs=$(mktemp -d)
for run in 1 2 3 4 5; do
  mkdir -p "$runs/$run"
  for institution in bank emoney investment payments_fx; do
    system/run "synthetic-cases/$institution" "$runs/$run/$institution.jsonl" </dev/null || exit 1
  done
done
python3 synthetic-cases/score.py "$runs"/{1,2,3,4,5}
python3 synthetic-cases/score.py -v "$runs/1"
```

The scorer reports verdict cost and cost saved versus escalating everything, wrongful closes, exact verdict/reason-code agreement, decisive-evidence coverage on correct verdicts, and verdict/code reproducibility across supplied runs. A missing case row counts as ESCALATE without a reason code. The scorer rejects duplicate/unknown cases, incorrect alert IDs and invalid citations (unknown IDs or another customer's documents or transactions). It does not judge whether cited evidence is relevant within a case or whether the prose explains the facts; use the answer key for that review. This is a local diagnostic, not a reproduction of the organizer's final weighted score.
