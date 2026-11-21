#!/usr/bin/env python3
"""Add synthetic cases 05-10 for each institution to the fixture folders.

Idempotent: rows and evidence files owned by cases 05-10 are replaced, and
hand-written cases 01-04 are left untouched. Run from anywhere:

    python3 synthetic-cases/generate_extra.py

The cases target what the overfitting audit found: free-text documents in
new wording, trap variants of document facts, alerts explained only in part,
prior-review scope, and the payments/FX release gate. Labels come from the
SOPs, not from runner output. All names, accounts and documents are made up.
"""
import json
import re
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent
OPENED = "2026-10-20T06:00:00Z"
WINDOW = {"from": "2026-09-20", "to": "2026-10-19"}
OWNED = re.compile(r"^SYN-(BK|EM|IV|PX)-(0[5-9]|10)-")
FOLDERS = {"BK": "bank", "EM": "emoney", "IV": "investment", "PX": "payments_fx"}
RULE_NAMES = {
    "TM01": "Activity exceeds the expected profile", "TM02": "Rapid movement of funds",
    "TM03": "Repeated transactions below a threshold", "TM04": "Many-to-one or one-to-many payments",
    "TM05": "Large or unexpected cash activity", "TM06": "Unexpected higher-risk corridor",
    "TM07": "Dormant account reactivation", "TM08": "Third-party funding or payout",
    "TM10": "Unusually early fund redemption", "TM22": "Counterparty on an internal list",
}


def long_date(iso):
    d = date.fromisoformat(iso)
    return f"{d.day} {d.strftime('%B')} {d.year}"


def gbp(amount):
    return f"£{amount:,.2f}"


class Case:
    """Collects the rows for one synthetic case."""

    def __init__(self, prefix, number):
        self.prefix, self.number = prefix, number
        self.base = f"SYN-{prefix}-{number:02d}"
        self.customer_id, self.account_id = f"{self.base}-C", f"{self.base}-A"
        self.customer = None
        self.txs, self.alerts, self.docs, self.reviews, self.entries = [], [], [], [], []
        self.held = None
        self.expected = None

    # --- builders -------------------------------------------------------
    def individual(self, name, dob, occupation, employer, income, source="Salary and savings", countries=("United Kingdom",)):
        self.customer = {
            "kind": "individual", "name": name, "date_of_birth": dob, "occupation": occupation, "employer": employer,
            "company_number": None, "incorporated_on": None, "business_activity": None,
            "address": f"{self.number} Bramble Yard, Exampleton, ZZ0 2ZZ", "onboarded_on": "2023-11-14", "risk_rating": "Low",
            "declared": {"source_of_funds": source, "account_purpose": "Everyday banking" if self.prefix != "IV" else "Long-term investing",
                         "expected_countries": list(countries), "expected_channels": ["Bank transfer", "Card"],
                         "monthly_income_gbp": income, "annual_turnover_gbp": None},
            "customer_id": self.customer_id, "account_ids": [self.account_id]}

    def business(self, name, activity, turnover, countries=("United Kingdom",)):
        declared = {"source_of_funds": "Business revenue", "account_purpose": "Business receipts and expenses",
                    "expected_countries": list(countries), "expected_channels": ["Bank transfer", "Card"],
                    "monthly_income_gbp": None, "annual_turnover_gbp": turnover}
        if self.prefix == "PX":
            declared.update(account_purpose="Paying overseas suppliers", expected_channels=["Bank transfer from own account"],
                            annual_payment_volume_gbp=turnover)
        self.customer = {
            "kind": "business", "name": name, "date_of_birth": None, "occupation": None, "employer": None,
            "company_number": None, "incorporated_on": "2019-03-18", "business_activity": activity,
            "address": f"{self.number} Bramble Yard, Exampleton, ZZ0 2ZZ", "onboarded_on": "2023-11-14", "risk_rating": "Low",
            "declared": declared, "customer_id": self.customer_id, "account_ids": [self.account_id]}

    def tx(self, when, direction, channel, amount, name=None, account=None, country="United Kingdom", reference=None,
           location=None, held=False):
        tid = f"{self.base}-T{len(self.txs) + 1:02d}"
        booked = when if "T" in when else f"{when}T10:00:00Z"
        row = {"transaction_id": tid, "customer_id": self.customer_id, "account_id": self.account_id, "booked_at": booked,
               "direction": direction, "channel": channel, "amount_gbp": amount, "counterparty_name": name,
               "counterparty_account": account, "counterparty_country": country if name else None, "reference": reference,
               "location": location, "currency": "GBP", "amount": amount}
        if held:
            row["status"] = "held"
            self.held = tid
        self.txs.append(row)
        return tid

    def alert(self, rule, message, measured, tx_ids):
        aid = f"{self.base}-AL{len(self.alerts) + 1:02d}"
        self.alerts.append({"alert_id": aid, "case_id": f"{self.base}-CS", "customer_id": self.customer_id,
                            "rule_name": RULE_NAMES[rule], "rule_id": rule, "created_at": OPENED, "message": message,
                            "measured": measured, "transaction_ids": list(tx_ids)})
        return aid

    def doc(self, doc_type, title, dated, body):
        did = f"{self.base}-D{len(self.docs) + 1:02d}"
        markdown = f"# {title}\n\n**Document ID:** {did}\n**Dated:** {long_date(dated)}\n\n{body.strip()}\n"
        self.docs.append(({"doc_id": did, "customer_id": self.customer_id, "type": doc_type, "title": title,
                           "dated": dated, "file": f"evidence/{did}.md"}, markdown))
        return did

    def review(self, reviewed_on, rule, verdict, note):
        rid = f"{self.base}-R{len(self.reviews) + 1:02d}"
        self.reviews.append({"review_id": rid, "customer_id": self.customer_id, "reviewed_on": reviewed_on,
                             "rule_id": rule, "verdict": verdict, "note": note})
        return rid

    def list_entry(self, **fields):
        eid = f"{self.base}-L{len(self.entries) + 1:02d}"
        self.entries.append({"entry_id": eid, **fields})
        return eid

    def expect(self, scenario, verdict, code, reason, evidence):
        self.expected = {"case_id": f"{self.base}-CS", "institution": FOLDERS[self.prefix], "scenario": scenario,
                         "verdict": verdict, "reason_code": code, "reason": reason, "evidence": list(evidence)}

    def case_row(self):
        return {"case_id": f"{self.base}-CS", "institution": FOLDERS[self.prefix], "customer_id": self.customer_id,
                "opened_at": OPENED, "review_window": dict(WINDOW), "alert_ids": [a["alert_id"] for a in self.alerts],
                "held_payment_id": self.held}


def tm01(c, received, baseline, tx_ids, business=False, px=False, to="19 October 2026"):
    multiple = round(received / baseline, 2)
    what = ("the monthly share of the expected annual payment volume" if px
            else "the declared monthly turnover" if business else "the declared monthly income")
    limit = 2 if (px or business) else 3
    c.alert("TM01", f"In the 30 days to {to}, the account received {gbp(received)}, {multiple:.1f} times {what} of "
            f"{gbp(baseline)}. The limit is {limit} times.",
            {"received_gbp": received, "baseline_gbp": baseline, "multiple": multiple, "limit_multiple": limit, "window_days": 30},
            tx_ids)


def tm02(c, received, paid, tx_ids, to, third_party=False):
    share = round(paid / received, 2)
    source = " from parties other than the client" if third_party else ""
    c.alert("TM02", f"In the 10 days to {to}, the account received {gbp(received)}{source} and paid out {gbp(paid)} within "
            f"48 hours of money arriving, {round(share * 100)}% of what came in. The limit is 80%.",
            {"received_gbp": received, "paid_out_gbp": paid, "share": share, "invested_gbp": 0, "limit_share": 0.8,
             "window_days": 10}, tx_ids)


def tm08(c, payer, amount, day, tx_ids):
    c.alert("TM08", f"{payer} paid {gbp(amount)} into the account on {long_date(day)}. The account holder name does not "
            f"match the customer, {c.customer['name']}.", {"flows": 1, "total_gbp": amount, "limit_gbp": 1000}, tx_ids)


def chat(*turns):
    return "\n\n".join(f"**{who}:** {text}" for who, text in turns)


# ============================================================ Bank
def bank():
    cases = []

    c = Case("BK", 5)  # Inheritance letter in wording the dev letters never use.
    c.individual("Tamsin Quillon", "1990-06-12", "Dental nurse", "Larkspur Dental Group", 2850)
    t1 = c.tx("2026-09-26", "in", "faster_payment", 2850, "Larkspur Dental Group", "00-97-01 00050001", reference="SALARY SEPTEMBER")
    t2 = c.tx("2026-10-07", "in", "faster_payment", 48215.60, "Pellow Harcastle Solicitors LLP client account",
              "00-97-01 00050002", reference="TILBURY ESTATE")
    tm01(c, 51065.60, 2850, [t1, t2])
    d1 = c.doc("solicitor_letter", "Letter from Pellow Harcastle Solicitors LLP", "2026-10-02", """
Dear Ms Quillon,

We act for the personal representatives administering the estate of Rowan Tilbury, deceased, who died on 3 May 2026. Probate has now been granted and the estate accounts have been approved by the executors.

Your legacy under clause 4 of the will comes to £48,215.60. We will send it by bank transfer from our client account within five working days.

Yours sincerely,

Pellow Harcastle Solicitors LLP
""")
    c.expect("inheritance-letter-reworded", "CLOSE", "DOCUMENTED_EVENT",
             "Pellow Harcastle Solicitors LLP confirms Tamsin Quillon's £48,215.60 legacy from the estate of Rowan Tilbury, "
             "and the £48,215.60 credit came from the firm's client account five days later. The only other inflow is her "
             "declared salary from Larkspur Dental Group.", [d1, t2])
    cases.append(c)

    c = Case("BK", 6)  # One alert explained by a sale; the other alert's third-party money is not.
    c.individual("Idris Callowmere", "1983-11-02", "Plumber", "Self-employed", 3000, source="Self-employment income")
    t1 = c.tx("2026-10-04", "in", "cash_deposit", 12400, location="Exampleton High Street branch", reference="CASH DEPOSIT")
    t2 = c.tx("2026-10-09", "in", "faster_payment", 6000, "Corin Vashti", "00-97-01 00060002", reference="FOR YOU")
    tm01(c, 18400, 3000, [t1, t2])
    c.alert("TM05", f"A cash deposit of £12,400.00 on 4 October 2026 at Exampleton High Street branch is at or above the "
            "£10,000.00 limit for individual customers.", {"amount_gbp": 12400, "limit_gbp": 10000}, [t1])
    c.doc("vehicle_sale_receipt", "Private vehicle sale receipt", "2026-10-03", """
Received from Hollis Brandt the sum of £12,400.00 in cash for a 2018 estate car, registration EX18 KVL, 52,000 miles, sold as seen.

**Seller:** Idris Callowmere, 6 Bramble Yard, Exampleton, ZZ0 2ZZ
**Buyer:** Hollis Brandt
Signed by both parties.
""")
    c.expect("sale-explains-cash-not-third-party-credit", "RFI", "RFI_SOURCE_OF_FUNDS",
             "The vehicle sale receipt matches the £12,400 cash deposit, which settles TM05. The £6,000 from Corin Vashti "
             "also counts towards TM01 and nothing explains it. Ask Idris Callowmere who Corin Vashti is and for proof of "
             "why the money was paid.", [t2])
    cases.append(c)

    c = Case("BK", 7)  # Prior review closed a smaller, different movement.
    c.individual("Esme Thackwray", "1979-03-30", "Teaching assistant", "Exampleton Primary Academy", 2600)
    t1 = c.tx("2026-06-02", "out", "cash_withdrawal", 10500, location="Exampleton High Street branch", reference="CASH WITHDRAWAL")
    t2 = c.tx("2026-10-08", "in", "cash_deposit", 14800, location="Exampleton High Street branch", reference="CASH DEPOSIT")
    c.review("2026-06-10", "TM05", "CLOSE", "Closed. £10,500.00 cash withdrawal on 2 June 2026 for a private car purchase; "
             "the seller's receipt was seen. This review covers the withdrawal only.")
    c.alert("TM05", "A cash deposit of £14,800.00 on 8 October 2026 at Exampleton High Street branch is at or above the "
            "£10,000.00 limit for individual customers.", {"amount_gbp": 14800, "limit_gbp": 10000}, [t2])
    c.doc("support_chat", "Chat with the customer", "2026-10-10", chat(
        ("Customer", "Why was my deposit flagged? It's just the money I took out in June for the car. The sale fell through so I'm putting it back."),
        ("Agent", "Thanks for explaining. The deposit is larger than the June withdrawal. Where did the rest come from?"),
        ("Customer", "I had some cash saved at home as well.")))
    c.expect("prior-review-smaller-different-activity", "RFI", "RFI_SOURCE_OF_FUNDS",
             "The June review closed a £10,500 withdrawal only, so it does not cover the £14,800 cash deposit on 8 October. "
             "Esme Thackwray says it is the returned car money plus savings, but £4,300 more came in than went out and "
             "nothing documents it. Ask for evidence of the source of the full deposit.", [t2])
    cases.append(c)

    c = Case("BK", 8)  # Someone else operates the account, said in new wording.
    c.individual("Nadia Pembrook", "1996-08-19", "Retail assistant", "Brightmarket Stores", 2400)
    ids = [c.tx("2026-10-01", "in", "faster_payment", 1950, "Ollie Farrant", "00-97-01 00080001", reference="PARTS"),
           c.tx("2026-10-03", "in", "faster_payment", 2300, "Sana Whitlock", "00-97-01 00080002", reference="INVOICE 22"),
           c.tx("2026-10-06", "in", "faster_payment", 2750, "Baz Kettering", "00-97-01 00080003", reference="GEARBOX"),
           c.tx("2026-10-10", "in", "faster_payment", 1400, "Ollie Farrant", "00-97-01 00080001", reference="PARTS 2")]
    tm01(c, 8400, 2400, ids)
    d1 = c.doc("support_chat", "Chat with the customer", "2026-10-12", chat(
        ("Customer", "Why can't I log in? My cousin Rafe looks after the app for me. He has my login and takes payments for his car-parts business on it because his own account got closed."),
        ("Agent", "For security, only the account holder should use the account."),
        ("Customer", "It's fine, he gives me the money back when I need it.")))
    c.expect("third-party-operates-account-reworded", "ESCALATE", "ESC_ACCOUNT_MISUSE",
             "Nadia Pembrook says in the chat that her cousin holds her login and takes payments for his car-parts business "
             "through her account after his own was closed. The £8,400 from three unrelated payers fits that.", [d1, ids[2]])
    cases.append(c)

    c = Case("BK", 9)  # A matching invoice does not cure control by the listed person.
    c.business("Grebe Lantern Interiors Ltd", "Commercial interior fit-out", 480000)
    t1 = c.tx("2026-10-06", "out", "faster_payment", 8400, "Fennick Shopfitting Ltd", "00-97-01 00090001", reference="INV 4471")
    l1 = c.list_entry(kind="individual", name="Orla Fennick", date_of_birth="1979-04-14", identifiers={"internal_case": "IC-2025-901"},
                      address="18 Weir Close, Sampleford, ZZ9 4ZZ",
                      reason="Subject of an unresolved specialist investigation. Do not deal with this person or companies they control.",
                      added_on="2025-09-03")
    c.alert("TM22", f"The payment of £8,400.00 to Fennick Shopfitting Ltd on 6 October 2026 matched internal list entry {l1} on "
            "company officer name and month and year of birth. Matched party: Orla Fennick, controlling shareholder of Fennick Shopfitting Ltd.",
            {"list_entry": l1, "matched_on": "company officer name and month and year of birth",
             "matched_party": "Orla Fennick, controlling shareholder of Fennick Shopfitting Ltd"}, [t1])
    d1 = c.doc("significant_control_register", "Register of people with significant control for Fennick Shopfitting Ltd", "2026-10-01", """
| Person | Born | Control | Notified | Ceased |
|---|---|---|---|---|
| Orla Fennick | April 1979 | Owns 75% or more of shares | 12 March 2019 | |
""")
    c.doc("invoice", "Invoice INV 4471 from Fennick Shopfitting Ltd", "2026-09-29", """
**Supplier:** Fennick Shopfitting Ltd
**Bill to:** Grebe Lantern Interiors Ltd
**Amount due:** £8,400.00
**Pay to:** Fennick Shopfitting Ltd, account 00-97-01 00090001

Shop counters and display joinery for the Market Row unit.
""")
    c.expect("listed-person-controls-invoiced-payee", "ESCALATE", "ESC_LISTED_PARTY",
             "The register shows Orla Fennick, born April 1979, owns 75% or more of Fennick Shopfitting Ltd, matching the "
             "listed person's name and birth month and year. The £8,400 payment matches an invoice, but it goes to a company "
             "the listed party controls.", [d1, l1, t1])
    cases.append(c)

    c = Case("BK", 10)  # Re-verified three weeks before reactivation, outside a 14-day habit.
    c.individual("Wilf Arkenshaw", "1975-01-22", "Signalling technician", "Halcyon Rail Services Ltd", 3100, source="Salary")
    c.tx("2026-01-12", "out", "card", 42.80, "Exampleton Hardware", reference="CARD PURCHASE")
    t2 = c.tx("2026-09-25", "in", "faster_payment", 3100, "Halcyon Rail Services Ltd", "00-97-01 00100002", reference="SALARY SEPTEMBER")
    t3 = c.tx("2026-10-16", "in", "faster_payment", 3100, "Halcyon Rail Services Ltd", "00-97-01 00100002", reference="SALARY OCTOBER")
    c.alert("TM07", "The account had no activity between 12 January 2026 and 25 September 2026, 256 days. Since then £6,200.00 "
            "has moved in and out. The limit is £5,000.00 after 180 days.",
            {"dormant_days": 256, "moved_gbp": 6200, "limit_gbp": 5000, "limit_days": 180}, [t2, t3])
    d1 = c.doc("reverification_record", "Identity re-verification record", "2026-09-04", """
Identity re-verified on 4 September 2026 with a passport check at the Exampleton High Street branch. Address confirmed. The customer said they had been on a career break abroad and were returning to their previous role at Halcyon Rail Services Ltd.
""")
    c.expect("reverified-three-weeks-before-reactivation", "CLOSE", "RETURNING_CUSTOMER",
             "Wilf Arkenshaw's identity was re-verified in branch on 4 September 2026, before the account reactivated. The "
             "£6,200 since then is two £3,100 salary payments from the declared employer, Halcyon Rail Services Ltd.", [d1, t2])
    cases.append(c)
    return cases


# ============================================================ E-money
def emoney():
    cases = []

    c = Case("EM", 5)  # Takings book reconciles three of four top-ups.
    c.business("Thistledown Bakehouse Ltd", "Bakery stall at weekend markets", 96000)
    ids = [c.tx("2026-10-03", "in", "cash_topup", 860, location="PayPoint, Market Row", reference="CASH TOP-UP"),
           c.tx("2026-10-04", "in", "cash_topup", 915, location="PayPoint, Market Row", reference="CASH TOP-UP"),
           c.tx("2026-10-10", "in", "cash_topup", 842, location="Post office, Sampleford Square", reference="CASH TOP-UP"),
           c.tx("2026-10-11", "in", "cash_topup", 978, location="PayPoint, Market Row", reference="CASH TOP-UP")]
    c.alert("TM03", "In the 10 days to 11 October 2026, there were 4 cash top-ups each between £800.00 and £999.99, totalling "
            "£3,595.00, at 2 different locations. The limit is 3.",
            {"count": 4, "total_gbp": 3595, "locations": 2, "limit_count": 3, "window_days": 10}, ids)
    c.doc("takings_book", "Daily takings book", "2026-10-11", """
| Date | Market | Takings | Cash topped up |
|---|---|---|---|
| 3 October 2026 | Exampleton Saturday market | £1,180.00 | £860.00 |
| 4 October 2026 | Sampleford farmers' market | £1,240.00 | £915.00 |
| 11 October 2026 | Sampleford farmers' market | £1,310.00 | £978.00 |
""")
    c.expect("takings-book-missing-one-top-up", "RFI", "RFI_BUSINESS_RECORDS",
             "The takings book reconciles the top-ups of 3, 4 and 11 October, but has no entry for the £842 cash top-up on "
             "10 October at Sampleford Square. Ask Thistledown Bakehouse for the takings record behind that top-up.", [ids[2]])
    cases.append(c)

    c = Case("EM", 6)  # Structuring admitted in a chat, in new wording.
    c.individual("Rory Tellwright", "1993-05-07", "Warehouse operative", "Northfold Logistics", 2200)
    spots = ["PayPoint, Canal Street", "Post office, Sampleford Square"]
    ids = [c.tx(day, "in", "cash_topup", amount, location=spots[i % 2], reference="CASH TOP-UP")
           for i, (day, amount) in enumerate([("2026-10-01", 950), ("2026-10-03", 980), ("2026-10-04", 960),
                                              ("2026-10-07", 990), ("2026-10-09", 970)])]
    c.alert("TM03", "In the 10 days to 9 October 2026, there were 5 cash top-ups each between £800.00 and £999.99, totalling "
            "£4,850.00, at 2 different locations. The limit is 3.",
            {"count": 5, "total_gbp": 4850, "locations": 2, "limit_count": 3, "window_days": 10}, ids)
    d1 = c.doc("support_chat", "Chat with the customer", "2026-10-09", chat(
        ("Customer", "I've been loading cash in bits, each one under a grand, so the app doesn't ask me for ID or where it came from. Can I do two a day?"),
        ("Agent", "All cash top-ups are monitored whatever the amount."),
        ("Customer", "Fine, I'll use a different shop then.")))
    c.expect("structuring-admitted-in-chat", "ESCALATE", "ESC_STRUCTURING",
             "Rory Tellwright made five cash top-ups of £950 to £990 in nine days. In the chat they say they keep each one "
             "under £1,000 so the app does not ask for ID or the source of the cash.", [d1, *ids])
    cases.append(c)

    c = Case("EM", 7)  # Pooled third-party money sent to a crypto platform whose name has no crypto keyword.
    c.individual("Lena Marwick", "1999-12-01", "Barista", "Copperpot Coffee", 2500)
    ids = [c.tx("2026-10-02T09:12:00Z", "in", "faster_payment", 1800, "Joss Penhallow", "00-97-02 00070001", reference="THANKS"),
           c.tx("2026-10-02T14:40:00Z", "in", "faster_payment", 1650, "Amara Steed", "00-97-02 00070002", reference="AS AGREED"),
           c.tx("2026-10-02T18:05:00Z", "out", "faster_payment", 3400, "Ferrowind Digital Assets Ltd", "00-97-02 00070003",
                reference="BTC PURCHASE 8812")]
    tm02(c, 3450, 3400, ids, "11 October 2026")
    c.expect("pooled-payers-to-crypto-no-keyword", "ESCALATE", "ESC_MULE_ACTIVITY",
             "Two unrelated people paid Lena Marwick £1,800 and £1,650 on 2 October, and within hours £3,400 went to "
             "Ferrowind Digital Assets Ltd with the reference BTC PURCHASE. Nothing on file explains either payer.", ids)
    cases.append(c)

    c = Case("EM", 8)  # Ownership proven for the destination only.
    c.individual("Pia Rendlesham", "1988-02-14", "Physiotherapist", "Exampleton Health Trust", 2700)
    t1 = c.tx("2026-10-05", "in", "faster_payment", 3200, "P Rendlesham", "00-97-02 00080081", reference="TRANSFER")
    t2 = c.tx("2026-10-06", "out", "faster_payment", 3050, "Pia Rendlesham", "00-97-02 00080082", reference="SAVINGS")
    tm02(c, 3200, 3050, [t1, t2], "12 October 2026")
    c.doc("bank_statement", "Statement from Kestrel Basin Bank", "2026-10-08", """
**Account holder:** Pia Rendlesham
**Account:** 00-97-02 00080082

6 October 2026: Credit £3,050.00 from Pia Rendlesham
""")
    c.expect("ownership-proven-one-end-only", "RFI", "RFI_SOURCE_OF_FUNDS",
             "The Kestrel Basin statement proves Pia Rendlesham holds the account that received £3,050. Nothing shows who "
             "holds account 00080081, which sent the £3,200 under the name P Rendlesham. Ask for a statement for that "
             "account showing she holds it.", [t1])
    cases.append(c)

    c = Case("EM", 9)  # Settlement letter in new wording, with a reference that does not say "settlement".
    c.individual("Jory Castellan", "1985-09-09", "Logistics coordinator", "Ferncastle Logistics Ltd", 2900, source="Salary")
    t1 = c.tx("2026-10-08", "in", "faster_payment", 11250, "Ferncastle Logistics Ltd", "00-97-02 00090001", reference="FERNCASTLE COMP 2209")
    tm01(c, 11250, 2900, [t1])
    d1 = c.doc("settlement_letter", "Settlement agreement letter from Ferncastle Logistics Ltd", "2026-09-30", """
Dear Jory Castellan,

Following the agreement we both signed on 22 September 2026, Ferncastle Logistics Ltd will pay you £11,250.00 in full and final settlement of your employment tribunal claim. The money will be transferred to your nominated account within ten working days under the reference FERNCASTLE COMP 2209.
""")
    c.expect("settlement-letter-reworded-own-reference", "CLOSE", "DOCUMENTED_EVENT",
             "Ferncastle Logistics Ltd's letter of 30 September commits to pay Jory Castellan £11,250 in settlement of a "
             "tribunal claim under reference FERNCASTLE COMP 2209. The £11,250 credit on 8 October matches the payer, "
             "amount and reference.", [d1, t1])
    cases.append(c)

    c = Case("EM", 10)  # Insurer letter stating gross, excess and net amounts.
    c.individual("Bea Lindqvist-Hale", "1991-07-23", "Graphic designer", "Inkwell Studio", 2000)
    t1 = c.tx("2026-10-12", "in", "faster_payment", 6690, "Harrowgate Mutual Insurance plc", "00-97-02 00100001", reference="CLAIM 61207")
    tm01(c, 6690, 2000, [t1])
    d1 = c.doc("insurer_letter", "Claim settlement letter from Harrowgate Mutual Insurance plc", "2026-10-09", """
Dear Bea Lindqvist-Hale,

Thank you for your patience while we assessed CLAIM 61207 for water damage at your flat. We have approved the claim at £6,940.00. After deducting the £250.00 policy excess, we will pay £6,690.00 to you by bank transfer within five working days.
""")
    c.expect("insurer-payout-net-of-excess", "CLOSE", "DOCUMENTED_EVENT",
             "Harrowgate Mutual approved CLAIM 61207 at £6,940 and will pay £6,690 after the £250 excess. The £6,690 "
             "credit on 12 October matches the insurer, the claim reference and the net amount.", [d1, t1])
    cases.append(c)
    return cases


# ============================================================ Investment
def investment():
    cases = []

    c = Case("IV", 5)  # Gift letter names the recipient before the relationship.
    c.individual("Saskia Penhaligon", "1994-03-03", "Architect", "Tidewater Design", 3400)
    t1 = c.tx("2026-10-06", "in", "faster_payment", 22000, "Gideon Penhaligon", "00-97-03 00050001", reference="GIFT")
    tm01(c, 22000, 3400, [t1])
    tm08(c, "Gideon Penhaligon", 22000, "2026-10-06", [t1])
    d1 = c.doc("gift_letter", "Gift letter from Gideon Penhaligon", "2026-10-01", """
I, Gideon Penhaligon, of 9 Marten Rise, Exampleton, confirm that the £22,000.00 I am transferring to Saskia Penhaligon, my child, is an unconditional gift from my savings. It does not have to be repaid, and I will have no interest in any investments bought with it.
""")
    c.expect("gift-letter-recipient-before-relation", "CLOSE", "THIRD_PARTY_DOCUMENTED",
             "Gideon Penhaligon's signed letter gives £22,000 to Saskia Penhaligon as a non-repayable gift. The £22,000 "
             "deposit on 6 October came from Gideon five days after the letter.", [d1, t1])
    cases.append(c)

    c = Case("IV", 6)  # Gift letter for a smaller amount than was paid.
    c.individual("Bram Oakenfold", "1989-10-10", "Software tester", "Quayside Systems", 3800)
    t1 = c.tx("2026-10-08", "in", "faster_payment", 22500, "Petra Oakenfold", "00-97-03 00060001", reference="GIFT")
    tm01(c, 22500, 3800, [t1])
    tm08(c, "Petra Oakenfold", 22500, "2026-10-08", [t1])
    d1 = c.doc("gift_letter", "Gift letter from Petra Oakenfold", "2026-10-02", """
I, Petra Oakenfold, hereby confirm that I am gifting the sum of £20,000.00 to my sibling, Bram Oakenfold. This is a non-repayable gift and I will retain no legal or beneficial interest in the funds.
""")
    c.expect("gift-letter-amount-short", "RFI", "RFI_SOURCE_OF_FUNDS",
             "Petra Oakenfold's gift letter covers £20,000, but she paid £22,500 into Bram Oakenfold's account. Ask for "
             "a gift letter or other evidence covering the full £22,500.", [d1, t1])
    cases.append(c)

    c = Case("IV", 7)  # A stale redundancy letter does not explain a later purchase and early sale.
    c.individual("Corin Halberd", "1972-12-05", "Freight planner", "Mistral Freight Ltd", 3900)
    c.tx("2026-08-18", "in", "faster_payment", 9000, "Corin Halberd", "00-97-03 00070001", reference="TOP UP")
    t2 = c.tx("2026-08-19", "out", "fund_subscription", 8950, "Brightwater Global Equity Fund", reference="FUND BUY BGE")
    t3 = c.tx("2026-09-30", "in", "fund_redemption", 8810.40, "Brightwater Global Equity Fund", reference="FUND SELL BGE")
    c.tx("2026-10-02", "out", "faster_payment", 8800, "Corin Halberd", "00-97-03 00070001", reference="WITHDRAWAL")
    c.alert("TM10", "Units in Brightwater Global Equity Fund bought on 19 August 2026 for £8,950.00 were sold back on "
            "30 September 2026 for £8,810.40, 42 days later. The limit is 90 days.",
            {"fund": "Brightwater Global Equity Fund", "held_days": 42, "bought_gbp": 8950, "redeemed_gbp": 8810.40,
             "limit_days": 90}, [t2, t3])
    c.doc("redundancy_letter", "Letter from Mistral Freight Ltd", "2025-07-03", """
Mistral Freight Ltd

Dear Employee,

We are writing to formally confirm that your role at Mistral Freight Ltd has been made redundant.

Please be advised that your last working day will be 31 July 2025.
""")
    c.expect("redundancy-letter-predates-purchase", "RFI", "RFI_PURPOSE_DOCUMENTS",
             "The only document is a July 2025 redundancy letter, over a year before Corin Halberd bought the Brightwater "
             "units on 19 August 2026, so it does not explain selling them 42 days later. Ask why the units were sold early "
             "and for a document supporting that reason.", [t2, t3])
    cases.append(c)

    c = Case("IV", 8)  # Withdrawal to a joint account the customer holds.
    c.individual("Nell Arbery", "1981-04-27", "Pharmacist", "Greenway Pharmacy", 4200)
    t1 = c.tx("2026-10-09", "out", "faster_payment", 6500, "Cass Arbery", "00-97-03 00080081", reference="WITHDRAWAL")
    c.alert("TM08", "A withdrawal of £6,500.00 on 9 October 2026 went to an account held by Cass Arbery. The account holder "
            "name does not match the customer, Nell Arbery.", {"flows": 1, "total_gbp": 6500, "limit_gbp": 1000}, [t1])
    d1 = c.doc("bank_statement", "Statement from Juniper Mutual", "2026-10-12", """
**Account holders:** Nell Arbery and Cass Arbery
**Account name:** N and C Arbery
**Account:** 00-97-03 00080081

9 October 2026: Credit £6,500.00 from Brightwater Invest
""")
    c.expect("withdrawal-to-joint-account", "CLOSE", "OWN_ACCOUNT",
             "The Juniper Mutual statement shows account 00080081 is held jointly by Nell Arbery and Cass Arbery and "
             "received the £6,500 withdrawal on 9 October. The money went to an account the customer holds.", [d1, t1])
    cases.append(c)

    c = Case("IV", 9)  # Several third parties fund the account and a fourth receives the money.
    c.individual("Tobin Ashgrove", "1997-06-30", "Delivery driver", "Swiftline Couriers", 3000)
    ids = [c.tx("2026-10-01", "in", "faster_payment", 1650, "Mirela Dancey", "00-97-03 00090001", reference="INVEST"),
           c.tx("2026-10-02", "in", "faster_payment", 1500, "Kofi Brandreth", "00-97-03 00090002", reference="INVEST"),
           c.tx("2026-10-03", "in", "faster_payment", 1350, "Ilse Vantongeren", "00-97-03 00090003", reference="INVEST"),
           c.tx("2026-10-06", "out", "faster_payment", 4400, "Dario Spellman", "00-97-03 00090004", reference="WITHDRAWAL")]
    c.alert("TM08", "Three deposits came from accounts not in the customer's name and one withdrawal went to one, totalling "
            "£8,900.00. The account holder names do not match the customer, Tobin Ashgrove.",
            {"flows": 4, "total_gbp": 8900, "limit_gbp": 1000}, ids)
    c.alert("TM02", "In the 10 days to 10 October 2026, £4,500.00 was deposited and £4,400.00 (98%) was withdrawn within 10 "
            "days of arriving, while £0.00 was invested. The limits are 80% withdrawn and 20% invested.",
            {"received_gbp": 4500, "paid_out_gbp": 4400, "share": 0.98, "invested_gbp": 0, "limit_share": 0.8, "window_days": 10}, ids)
    c.expect("third-parties-fund-and-receive", "ESCALATE", "ESC_THIRD_PARTY_FUNDING",
             "Three unrelated people deposited £4,500 in three days, nothing was invested, and £4,400 was withdrawn to a "
             "fourth person, Dario Spellman. No relationship to any of them is documented.", ids)
    cases.append(c)

    c = Case("IV", 10)  # Refusal to explain a Russian payment, in new wording and naming only the city.
    c.individual("Alys Wren-Hadley", "1980-02-18", "Management consultant", "Self-employed", 5200, source="Consulting income")
    t1 = c.tx("2026-10-02", "in", "swift", 7800, "Severny Bereg LLC", "IBAN ending 4471", country="Russia", reference="CONSULTING")
    c.alert("TM06", "In the 30 days to 19 October 2026, £7,800.00 moved to or from Russia, rated higher risk and not among the "
            "countries the customer declared. The limit is £5,000.00.",
            {"total_gbp": 7800, "countries": "Russia", "limit_gbp": 5000, "window_days": 30}, [t1])
    tm08(c, "Severny Bereg LLC", 7800, "2026-10-02", [t1])
    d1 = c.doc("staff_note", "Note from client services", "2026-10-09", """
I called Alys Wren-Hadley about the £7,800.00 received from Severny Bereg LLC in Moscow. Each time I asked what the payment was for, the client changed the subject, and eventually ended the call saying it was nobody's business. No invoice or contract has been provided.
""")
    c.expect("refusal-to-explain-russia-reworded", "ESCALATE", "ESC_HIGH_RISK_CORRIDOR",
             "£7,800 came from Severny Bereg LLC in Russia, a higher-risk country Alys Wren-Hadley did not declare. When "
             "asked about it, the client avoided the question and ended the call, and no invoice or contract is on file.", [d1, t1])
    cases.append(c)
    return cases


# ============================================================ Payments/FX
CONTRACTORS = ["Arlo Vence", "Bianca Moreth", "Cyrus Dalloway", "Dafne Ruelle", "Emil Sarkany", "Farah Quenby",
               "Gael Ostrander", "Hana Pelletier", "Ivo Brandauer", "Jolene Marsh", "Kasimir Teale", "Liesl Ambrose",
               "Mateo Graveny", "Nadia Okonkwo-Reed", "Orrin Haverly", "Paz Ellingham", "Quillon Abara", "Rosa Lindahl",
               "Soren Vackley", "Tamar Iveson", "Ulla Brenninkmeyer", "Vikram Sotheby", "Wanda Kessling", "Xavi Penrose",
               "Yara Bellweather", "Zeno Albright"]
COUNTRIES = ["Spain", "Portugal", "Poland", "India", "United States"]


def payments_fx():
    cases = []

    c = Case("PX", 5)  # Contract milestones in prose explain three sub-£10,000 payments.
    c.business("Corvid Joinery Ltd", "Bespoke joinery manufacture", 900000)
    c.tx("2026-10-01", "in", "faster_payment", 30000, "Corvid Joinery Ltd", None, reference="FUNDING")
    pay = [("2026-10-03", 9420.00, "CJ-0921 M1"), ("2026-10-07", 9615.50, "CJ-0921 M2"), ("2026-10-11", 9250.75, "CJ-0921 M3")]
    ids = [c.tx(day, "out", "swift", amount, "Valdemar Holz GmbH", "IBAN ending 5521", country="Germany", reference=ref,
                held=i == 2) for i, (day, amount, ref) in enumerate(pay)]
    c.alert("TM03", "In the 10 days to 11 October 2026, the client made 3 payments to Valdemar Holz GmbH, each between "
            "£9,000.00 and £9,999.99, totalling £28,286.25. The limit is 2. Payments of £10,000.00 or more need an invoice on file.",
            {"payments": 3, "beneficiary": "Valdemar Holz GmbH", "total_gbp": 28286.25, "limit_count": 2, "window_days": 10}, ids)
    d1 = c.doc("supply_contract", "Contract CJ-0921 with Valdemar Holz GmbH", "2026-09-15", """
This contract between Corvid Joinery Ltd and Valdemar Holz GmbH, Germany, covers the supply of quarter-sawn oak panelling for the Harbour Hotel refit.

Corvid Joinery Ltd will pay Valdemar Holz GmbH, IBAN ending 5521, in three milestones: £9,420.00 on 3 October 2026 when the timber is cut, £9,615.50 on 7 October 2026 after kiln drying, and £9,250.75 on 11 October 2026 on dispatch. Each payment must quote the contract number and milestone, for example CJ-0921 M1.

Signed for both parties on 15 September 2026.
""")
    c.expect("prose-contract-milestones", "CLOSE", "INVOICE_MATCHES",
             "Contract CJ-0921 sets three payments to Valdemar Holz GmbH, IBAN ending 5521, of £9,420.00, £9,615.50 and "
             "£9,250.75 on 3, 7 and 11 October. The three payments match the payee, amounts, dates and milestone references, "
             "so the held £9,250.75 can be released.", [d1, *ids])
    cases.append(c)

    c = Case("PX", 6)  # Held transfer to an own-name account abroad with no proof of ownership.
    c.business("Halvard Optics Ltd", "Imports lenses and optical parts", 600000, countries=("United Kingdom", "Sweden", "Germany"))
    c.tx("2026-01-10", "out", "swift", 4200, "Lindqvist Glas AB", "IBAN ending 2201", country="Sweden", reference="LG-118")
    t2 = c.tx("2026-10-13", "in", "faster_payment", 24000, "Halvard Optics Ltd", "00-97-04 00060001", reference="TREASURY")
    t3 = c.tx("2026-10-14", "out", "swift", 24000, "Halvard Optics Ltd", "IBAN ending 3307", country="Germany",
              reference="TREASURY SWEEP", held=True)
    c.alert("TM07", "The account had no activity between 10 January 2026 and 13 October 2026, 276 days. Since then £48,000.00 "
            "has moved in and out. The limit is £5,000.00 after 180 days.",
            {"dormant_days": 276, "moved_gbp": 48000, "limit_gbp": 5000, "limit_days": 180}, [t2, t3])
    c.doc("bank_statement", "Statement from Juniper Mutual", "2026-10-13", """
**Account holder:** Halvard Optics Ltd
**Account:** 00-97-04 00060001

13 October 2026: Debit £24,000.00 to Halvard Optics Ltd
""")
    c.expect("own-name-destination-unproven", "RFI", "RFI_COUNTERPARTY_DETAILS",
             "The statement proves Halvard Optics Ltd owns the UK account that funded £24,000, but nothing shows it holds "
             "the German account ending 3307 that would receive the held £24,000. Ask for a statement or bank letter showing "
             "the client holds that account before release.", [t3])
    cases.append(c)

    c = Case("PX", 7)  # Parent-company funding shown in prose, onward payment invoiced.
    c.business("Calder Pumps Ltd", "Distributes industrial pumps and valves", 1200000, countries=("United Kingdom", "Denmark"))
    t1 = c.tx("2026-10-06", "in", "faster_payment", 18000, "Brisa Holdings Ltd", "00-97-04 00070001", reference="INTRA-GROUP FUNDING")
    t2 = c.tx("2026-10-07", "out", "swift", 17500, "Nordhavn Valves A/S", "IBAN ending 6610", country="Denmark",
              reference="NV-20931", held=True)
    tm08(c, "Brisa Holdings Ltd", 18000, "2026-10-06", [t1])
    tm02(c, 18000, 17500, [t1, t2], "10 October 2026", third_party=True)
    d1 = c.doc("group_structure", "Group ownership confirmation", "2026-06-30", """
Prepared by Fenwright & Co, chartered accountants, for the year ended 31 March 2026.

Brisa Holdings Ltd holds the entire issued share capital of Calder Pumps Ltd. Brisa Holdings Ltd provides working capital to its subsidiaries by intra-group transfer.
""")
    d2 = c.doc("invoice", "Invoice NV-20931 from Nordhavn Valves A/S", "2026-09-28", """
**Supplier:** Nordhavn Valves A/S, Denmark
**Bill to:** Calder Pumps Ltd
**Invoice number:** NV-20931
**Due date:** 7 October 2026
**Amount due:** £17,500.00
**Pay to:** Nordhavn Valves A/S, IBAN ending 6610

Twenty stainless gate valves, DN150.
""")
    c.expect("parent-funding-prose-plus-invoice", "CLOSE", "GROUP_COMPANY",
             "The accountants' confirmation shows Brisa Holdings Ltd owns all of Calder Pumps Ltd, which explains its "
             "£18,000 funding. Invoice NV-20931 matches the held £17,500 to Nordhavn Valves A/S, account and due date, so "
             "the release condition is met.", [d1, t1, d2, t2])
    cases.append(c)

    c = Case("PX", 8)  # Private individuals' money passed to one person abroad.
    c.business("Mardle Trading Ltd", "Wholesale homeware imports", 480000)
    ids = [c.tx("2026-10-05", "in", "faster_payment", 3200, "Yusuf Arkwright", "00-97-04 00080001", reference="PAYMENT"),
           c.tx("2026-10-05", "in", "faster_payment", 4100, "Greta Solberg", "00-97-04 00080002", reference="ORDER"),
           c.tx("2026-10-06", "in", "faster_payment", 2950, "Mehmet Calloway", "00-97-04 00080003", reference="PAYMENT"),
           c.tx("2026-10-06", "in", "faster_payment", 2200, "Ines Ferraby", "00-97-04 00080004", reference="MARDLE")]
    ids.append(c.tx("2026-10-07", "out", "swift", 12000, "Karim Haddad", "IBAN ending 9044", country="United Arab Emirates",
                    reference="SETTLEMENT", held=True))
    tm02(c, 12450, 12000, ids, "10 October 2026", third_party=True)
    c.alert("TM08", "Four payers whose account names do not match the client, Mardle Trading Ltd, paid £12,450.00 into the account.",
            {"flows": 4, "total_gbp": 12450, "limit_gbp": 1000}, ids[:4])
    c.expect("individuals-pooled-to-person-abroad", "ESCALATE", "ESC_PASS_THROUGH",
             "Four private individuals paid Mardle Trading Ltd £12,450 over two days, and the client then instructed £12,000 "
             "to Karim Haddad, a private individual in the United Arab Emirates. No invoice or relationship explains either side.", ids)
    cases.append(c)

    c = Case("PX", 9)  # Invoice on file is for a different amount from the held payment.
    c.business("Sorrel Ceramics Ltd", "Imports glazes and kiln supplies", 360000, countries=("United Kingdom", "Czech Republic"))
    c.tx("2026-10-09", "in", "faster_payment", 15250, "Sorrel Ceramics Ltd", None, reference="FUNDING")
    t2 = c.tx("2026-10-12", "out", "swift", 15250, "Vitebsk Glaze OOO", "IBAN ending 4418", country="Belarus",
              reference="VG-7781", held=True)
    c.alert("TM06", "In the 30 days to 12 October 2026, £15,250.00 moved to or from Belarus, rated higher risk and not among "
            "the countries the customer declared. The limit is £5,000.00.",
            {"total_gbp": 15250, "countries": "Belarus", "limit_gbp": 5000, "window_days": 30}, [t2])
    d1 = c.doc("invoice", "Invoice VG-7781 from Vitebsk Glaze OOO", "2026-10-05", """
**Supplier:** Vitebsk Glaze OOO, Belarus
**Bill to:** Sorrel Ceramics Ltd
**Invoice number:** VG-7781
**Due date:** 12 October 2026
**Amount due:** £12,500.00
**Pay to:** Vitebsk Glaze OOO, IBAN ending 4418

Forty sacks of tin glaze and twelve kiln shelves.
""")
    c.expect("invoice-amount-differs-from-held", "ESCALATE", "ESC_INVOICE_MISMATCH",
             "Invoice VG-7781 is for £12,500.00, but the held payment to Vitebsk Glaze OOO in undeclared Belarus under that "
             "invoice number is £15,250.00. The invoice does not support the payment.", [d1, t2])
    cases.append(c)

    c = Case("PX", 10)  # Contractor file covers 26 of 27 payees; the held payment is the one missing.
    c.business("Lumen Atlas Studio Ltd", "Animation studio paying overseas freelance contractors", 720000,
               countries=("United Kingdom", *COUNTRIES))
    c.tx("2026-10-12", "in", "faster_payment", 50000, "Lumen Atlas Studio Ltd", None, reference="FUNDING")
    rows, ids = [], []
    for i, name in enumerate(CONTRACTORS):
        amount = round(880 + (i * 137.35) % 1700, 2)
        country = COUNTRIES[i % len(COUNTRIES)]
        ids.append(c.tx(f"2026-10-{13 + i % 3:02d}", "out", "swift", amount, name, f"IBAN ending {6100 + i}", country=country,
                        reference=f"LAS OCT C-{4100 + i}"))
        rows.append(f"| {name} | {country} | C-{4100 + i} | {gbp(amount)} |")
    held = c.tx("2026-10-15", "out", "swift", 1925.40, "Ines Valcourt", "IBAN ending 6199", country="Portugal",
                reference="LAS OCT C-4199", held=True)
    ids.append(held)
    total = round(sum(t["amount_gbp"] for t in c.txs if t["direction"] == "out"), 2)
    c.alert("TM04", f"In the 30 days to 15 October 2026, the account paid 27 different people or companies, more than the "
            f"limit of 25. Together they were paid {gbp(total)}.",
            {"direction": "outgoing", "distinct_counterparties": 27, "limit": 25, "total_gbp": total, "window_days": 30}, ids)
    c.doc("payment_file", "Contractor payment file", "2026-10-12",
          "| Contractor | Country | Contract | Amount |\n|---|---|---|---|\n" + "\n".join(rows))
    c.expect("contractor-file-omits-held-payee", "RFI", "RFI_PURPOSE_DOCUMENTS",
             "The contractor payment file matches 26 of the 27 payments, but has no row for Ines Valcourt, who would receive "
             "the held £1,925.40. Ask Lumen Atlas Studio for the contract or invoice for that payment.", [held])
    cases.append(c)
    return cases


# ============================================================ write
def read_rows(path):
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def write_rows(path, rows):
    path.write_text("".join(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n" for row in rows),
                    encoding="utf-8", newline="\n")


def keep(rows, key):
    return [row for row in rows if not OWNED.match(str(row.get(key, "")))]


def main():
    expected_path = ROOT / "expected.jsonl"
    expected = keep(read_rows(expected_path), "case_id")
    for build in (bank, emoney, investment, payments_fx):
        cases = build()
        folder = ROOT / FOLDERS[cases[0].prefix]
        files = {"cases.jsonl": ("case_id", [c.case_row() for c in cases]),
                 "alerts.jsonl": ("alert_id", [a for c in cases for a in c.alerts]),
                 "customers.jsonl": ("customer_id", [c.customer for c in cases]),
                 "transactions.jsonl": ("transaction_id", [t for c in cases for t in c.txs]),
                 "evidence.jsonl": ("doc_id", [d for c in cases for d, _ in c.docs]),
                 "previous_reviews.jsonl": ("review_id", [r for c in cases for r in c.reviews]),
                 "internal_list.jsonl": ("entry_id", [e for c in cases for e in c.entries])}
        for name, (key, new) in files.items():
            write_rows(folder / name, keep(read_rows(folder / name), key) + new)
        evidence = folder / "evidence"
        for stale in evidence.glob("SYN-*.md"):
            if OWNED.match(stale.name):
                stale.unlink()
        for c in cases:
            for meta, markdown in c.docs:
                (folder / meta["file"]).write_text(markdown, encoding="utf-8", newline="\n")
        expected += [c.expected for c in cases]
    order = {name: i for i, name in enumerate(FOLDERS.values())}
    expected.sort(key=lambda row: (order[row["institution"]], row["case_id"]))
    write_rows(expected_path, expected)
    print(f"Wrote {sum(1 for row in expected if OWNED.match(row['case_id']))} generated cases; {len(expected)} cases in total.")


if __name__ == "__main__":
    main()
