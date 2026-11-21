# FinCrime Hackathon 2026 — Stop suspicious payments

We built a transaction-monitoring triage tool for financial crime analysts. It reviews alerts that have already been raised, checks the transactions and supporting documents against the institution’s policy, and recommends **Close**, **Request for Information (RFI)**, or **Escalate**. Every recommendation cites the decisive evidence so the analyst can verify it and make the final decision.

[Watch the demo](demo/demo.mp4) · [Runner documentation](system/README.md) · [Development outputs](output/)

## How it works

1. **Assemble the case.** Join the alerts to the customer, transactions, relevant history, and supporting documents.
2. **Reconcile the evidence.** Match documents to transactions by party, amount, date, and account or reference where applicable. An optional language-model reader handles unfamiliar wording; the runner checks its quotes against the source before using any facts. The model never chooses a verdict.
3. **Decide and explain.** Assess each alert on its own. Evidence of suspicion takes priority: the tool recommends escalation to the Money Laundering Reporting Officer (MLRO). If there’s no suspicion and a specific answer can resolve the gap, it recommends what to ask for. Close only when all alerts are explained and any held payment meets the release requirements.

The tool does not release payments, contact customers, or file reports.

## Quick start

With Node.js 24+ installed, run from the repository root:

```sh
make dataset  # Skip if you already have the organizer’s data
system/run institutions/bank output/bank.jsonl
```

The same executable handles bank, e-money, investment, and payments/FX cases. It runs offline by default, with no install or build step, and writes one JSONL verdict per case.
