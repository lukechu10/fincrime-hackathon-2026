import { loadBankCases } from "./bank-cases.js";
import { routeBankCase } from "./bank-routing.js";

const [directory, caseId, ...extra] = process.argv.slice(2);
if (!directory || extra.length) {
  console.error("Usage: npm run bank:routes -- <bank-institution-directory> [case-id]");
  process.exit(2);
}

const bank = loadBankCases(directory);
if (caseId) {
  console.log(JSON.stringify({ caseId, ...routeBankCase(bank.get(caseId)) }, null, 2));
} else {
  const routes = { llm_review: 0, continue_policy: 0 };
  let casesWithFraudReport = 0;
  let casesWithInvoiceMatch = 0;
  let casesWithInvoiceMatchAndFraudReport = 0;
  for (const id of bank.caseIds) {
    const result = routeBankCase(bank.get(id));
    routes[result.route]++;
    if (result.fraudReportIds.length) casesWithFraudReport++;
    if (result.invoiceMatches.length) casesWithInvoiceMatch++;
    if (result.fraudReportIds.length && result.invoiceMatches.length) casesWithInvoiceMatchAndFraudReport++;
  }
  console.log(JSON.stringify({ cases: bank.caseIds.length, routes, casesWithFraudReport,
    casesWithInvoiceMatch, casesWithInvoiceMatchAndFraudReport }, null, 2));
}
