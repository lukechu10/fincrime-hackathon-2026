#!/usr/bin/env python3
"""Compare one or more runs with the synthetic review judgments."""
import argparse
import re
from pathlib import Path
import json

ROOT = Path(__file__).resolve().parent
INSTITUTIONS = ('bank', 'emoney', 'investment', 'payments_fx')
# Rows are expected verdicts; columns are predictions.
COST = {
    'CLOSE': {'CLOSE': 0, 'RFI': 3, 'ESCALATE': 3},
    'RFI': {'CLOSE': 10, 'RFI': 0, 'ESCALATE': 2},
    'ESCALATE': {'CLOSE': 10, 'RFI': 3, 'ESCALATE': 0},
}


def indexed(path, key):
    rows = {}
    for line_no, line in enumerate(path.read_text(encoding='utf-8').splitlines(), 1):
        if not line.strip():
            continue
        row = json.loads(line)
        if not isinstance(row, dict) or not isinstance(row.get(key), str) or not row[key]:
            raise ValueError(f'{path}:{line_no}: invalid or missing {key}')
        if row[key] in rows:
            raise ValueError(f'{path}:{line_no}: duplicate {key} {row[key]}')
        rows[row[key]] = row
    return rows


def evaluate(directory, expected, verbose):
    signatures = {}
    total_cost = baseline = wrongful = verdicts = codes = complete_evidence = missing = 0
    print(directory)
    for institution in INSTITUTIONS:
        folder = ROOT / institution
        cases = indexed(folder / 'cases.jsonl', 'case_id')
        path = directory / f'{institution}.jsonl'
        outputs = indexed(path, 'case_id')
        if extra := outputs.keys() - cases.keys():
            raise ValueError(f'{path}: unknown case IDs: {", ".join(sorted(extra))}')
        entries = indexed(folder / 'internal_list.jsonl', 'entry_id')
        sources = {**indexed(folder / 'evidence.jsonl', 'doc_id'),
                   **indexed(folder / 'transactions.jsonl', 'transaction_id')}
        # The SOP table is the source of allowed verdict/reason combinations.
        allowed = set(re.findall(r'^\| (CLOSE|RFI|ESCALATE) \| `([A-Z0-9_]+)`',
                                 (folder / 'POLICY.md').read_text(encoding='utf-8'), re.M))
        cost = wrong = absent = 0
        for case_id, case in cases.items():
            label = expected[case_id]
            want, code = label['verdict'], label['reason_code']
            baseline += COST[want]['ESCALATE']
            out = outputs.get(case_id)
            got, got_code, evidence = 'ESCALATE', None, []
            if out is None:
                absent += 1  # Missing case rows count as escalations, without a reason code.
            else:
                got, got_code = out.get('verdict'), out.get('reason_code')
                evidence, reason = out.get('evidence'), out.get('reason')
                if out.get('alert_ids') != case['alert_ids']:
                    raise ValueError(f'{path}: incorrect alert IDs or order for {case_id}')
                if (not isinstance(got, str) or not isinstance(got_code, str)
                        or (got, got_code) not in allowed or not isinstance(reason, str) or not reason.strip()):
                    raise ValueError(f'{path}: invalid verdict/code/reason for {case_id}')
                if (not isinstance(evidence, list) or any(not isinstance(ref, str) for ref in evidence)
                        or len(set(evidence)) != len(evidence)):
                    raise ValueError(f'{path}: invalid or duplicate evidence IDs for {case_id}')
                for ref in evidence:
                    if ref not in entries and sources.get(ref, {}).get('customer_id') != case['customer_id']:
                        raise ValueError(f'{path}: unknown or unrelated evidence {ref} for {case_id}')
                signatures[case_id] = (got, got_code)
            missed_refs = set(label['evidence']) - set(evidence)
            verdicts += got == want
            codes += (got, got_code) == (want, code)
            complete_evidence += got == want and not missed_refs
            cost += COST[want][got]
            wrong += got == 'CLOSE' and want != 'CLOSE'
            if verbose and ((got, got_code) != (want, code) or missed_refs):
                prediction = f'{got}/{got_code}' if out else '(missing; scored as ESCALATE)'
                print(f'  {case_id} {label["scenario"]}: expected {want}/{code}, got {prediction}')
                if missed_refs:
                    print(f'    Uncited expected evidence: {", ".join(sorted(missed_refs))}')
        print(f'  {institution:12} cost={cost:2}  wrongful closes={wrong}  missing={absent}')
        total_cost += cost
        wrongful += wrong
        missing += absent
    n = len(expected)
    print(f'  Total cost: {total_cost} (escalate-all baseline: {baseline}); '
          f'verdict cost saved: {1-total_cost/baseline:.1%}; wrongful closes: {wrongful}; missing: {missing}')
    print(f'  Correct verdicts: {verdicts}/{n}; exact verdict + code: {codes}/{n}; '
          f'correct verdict with all expected evidence: {complete_evidence}/{n}')
    return signatures


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output_dirs', nargs='+', type=Path, help='each contains the four institution JSONL outputs')
    parser.add_argument('-v', '--verbose', action='store_true', help='show case-level disagreements')
    args = parser.parse_args()
    try:
        expected = indexed(ROOT / 'expected.jsonl', 'case_id')
        case_ids = {case_id: institution for institution in INSTITUTIONS
                    for case_id in indexed(ROOT / institution / 'cases.jsonl', 'case_id')}
        if case_ids != {case_id: row['institution'] for case_id, row in expected.items()}:
            raise ValueError('Expected labels do not cover the synthetic input cases')
        runs = [evaluate(directory, expected, args.verbose) for directory in args.output_dirs]
        if len(runs) > 1:
            stable = sum(case_id in runs[0] and all(run.get(case_id) == runs[0][case_id] for run in runs[1:])
                         for case_id in expected)
            print(f'Reproducibility: {stable}/{len(expected)} cases have the same verdict/code in all {len(runs)} runs')
    except (OSError, ValueError) as error:
        parser.exit(2, f'Error: {error}\n')


if __name__ == '__main__':
    main()
