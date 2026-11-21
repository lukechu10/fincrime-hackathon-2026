# Local development labels

`dev-labels.jsonl` holds one reviewed verdict and reason code for each of the 4,000 development cases: `case_id`, `institution`, `family`, `verdict`, `reason_code`.

These are **our own review judgments, not organizer ground truth**. The development bundle has no answer labels. They were produced on 2026-11-21 by reviewing every scenario family against the institution's `POLICY.md`: rules present in the case plus the non-baseline document types on file for the customer, with a held-payment marker at payments/FX. Each family was reviewed by reading several cases in full and checking the deciding facts (amounts, parties, accounts, dates, references, registers) across every case in the family. Each institution came out at 500 CLOSE, 250 RFI and 250 ESCALATE.

Known soft spots:
- **Reason codes are less certain than verdicts.** This applies especially to escalations driven by support chats, dormant accounts with no documents (`RFI_SOURCE_OF_FUNDS` vs `RFI_PURPOSE_DOCUMENTS`), and TM08 plus TM01 requests.
- **Bank `TM01+TM05 | support_chat`.** The cash re-deposit variant (CLOSE `WITHIN_PROFILE`) is the least certain CLOSE.
- **Bank fraud-report family (`TM01+TM02+TM04 | sending_bank_fraud_report,support_chat`).** This family was not re-audited; it keeps the engine's `ESC_MULE_ACTIVITY`.
- **Payments/FX freight and freelancer families with no documents.** These are labelled RFI; ESCALATE and CLOSE respectively are the alternatives.

## Rules

- Never read these files from `system/` or embed anything from them in decision logic. The decision logic must work on the 800 unseen cases from the evidence alone.
- When tuning, check changes family by family against the evidence, not just against the score, so the engine doesn't overfit to the labels.
- If review shows a label is wrong, fix it here and record the change in the AGENTS.md work log.

## Scoring

From the repository root, after regenerating `output/*.jsonl`:

```sh
python labels/score.py      # cost-matrix total, wrongful closes, verdict and code accuracy per institution
python labels/score.py -v   # plus the largest disagreement groups by family
```
