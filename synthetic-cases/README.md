# Synthetic unseen-style cases

40 newly authored cases: ten each for Bank, E-money, Investment and Payments/FX. Cases 01–04 were written by hand; cases 05–10 come from `generate_extra.py`. Each institution folder is a standalone runner input with the same JSONL files and Markdown evidence layout as the organizer bundle. The SOPs are copied from the organizer bundle; the records, names and evidence are fictional. No development cases were copied or relabelled.

| Institution | What the cases exercise |
| --- | --- |
| `bank` | One penny below vs. exactly 5× declared income; a refund with the original debit outside the review window; admitted cash structuring. |
| `emoney` | Till takings net of retained float; rapid movement with proven ownership at both ends; unexplained cash top-up; confirmed sending-bank fraud. |
| `investment` | Documented redundancy and early redemption; family gift with a false-positive list hit; unexplained third-party funding; early redemption paid out to an unrelated third party. |
| `payments_fx` | Documented own-account funding; £10,000 holds with and without a matching invoice; confirmed invoice diversion. |

Cases 05–10 add two CLOSE, two RFI and two ESCALATE per institution. They target the overfitting audit's findings:

| Theme | Cases |
| --- | --- |
| **Free-text documents in new wording.** The facts are complete but phrased differently from the development documents. | Solicitor letter (`BK-05`), "others use my account" chat (`BK-08`), structuring admitted in a chat rather than a staff note (`EM-06`), settlement letter with its own reference (`EM-09`), insurer letter giving gross, excess and net amounts (`EM-10`), gift letter naming the recipient before the relationship (`IV-05`), refusal note naming Moscow rather than Russia (`IV-10`), contract milestones in prose (`PX-05`), group ownership in prose (`PX-07`) |
| **Trap variants of document facts** | Gift letter for less than was paid (`IV-06`); a redundancy letter dated a year before the purchase (`IV-07`); invoice amount differs from the held payment (`PX-09`); contractor file omits the held payee (`PX-10`) |
| **Only part of the activity explained** | Sale receipt settles TM05 but not TM01's third-party credit (`BK-06`); takings book covers three of four top-ups (`EM-05`); ownership proven at one end only (`EM-08`) |
| **Policy boundaries** | Prior review covers a smaller, different movement (`BK-07`); listed person controls a payee that also sent a matching invoice (`BK-09`); identity re-verified three weeks before reactivation (`BK-10`); crypto platform whose name has no crypto keyword (`EM-07`); withdrawal to a joint account the customer holds (`IV-08`); third parties fund and receive (`IV-09`); held transfer to an own-name account with no ownership proof (`PX-06`); private individuals' money passed to a person abroad (`PX-08`) |

Reason codes are softer than verdicts for `EM-08` (`RFI_PURPOSE_DOCUMENTS` is defensible), `PX-06` (`RFI_PURPOSE_DOCUMENTS`), and `PX-08` (`ESC_MULE_ACTIVITY`). To change a generated case, edit `generate_extra.py` and rerun it: it replaces only the rows and evidence files for cases 05–10, so rerunning is safe.

`expected.jsonl` is the separate answer key: one policy-based verdict, main reason code, rationale and list of decisive IDs per case. Per institution, cases 01–04 have two CLOSE, one RFI and one ESCALATE, and cases 05–10 have two of each. These labels were authored from the case evidence, not taken from runner outputs. They are **not organizer ground truth**. The suite targets edge cases rather than estimating hidden-set accuracy. Once you tune on it, treat it as a regression suite, not an independent holdout. Never load the key or embed fixture-specific details in `system/`.

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
