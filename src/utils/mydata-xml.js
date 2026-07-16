// src/utils/mydata-xml.js
// XML builders for myDATA SendInvoices and cancellation, plus response parser.
//
// Reference: AADE myDATA REST API v1.0.6+ (https://www.aade.gr/mydata)
// Schema:  http://www.aade.gr/myDATA/invoice/v1.0
//
// Supported types: 1.1 (Τιμολόγιο Πώλησης), 2.1 (Τιμολόγιο Παροχής Υπηρεσιών)

// ---------- Helpers ----------

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function num(n, digits = 2) {
  const v = Number(n || 0);
  return v.toFixed(digits);
}

// AADE VAT category codes (integer)
//   1 → 24%,  2 → 13%,  3 → 6%,  4 → 17%,  5 → 9%,  6 → 4%,  7 → 0%,  8 → w/o VAT (art. 43)
function vatCategoryFromRate(rate) {
  const r = Number(rate);
  if (r === 24) return 1;
  if (r === 13) return 2;
  if (r === 6)  return 3;
  if (r === 17) return 4;
  if (r === 9)  return 5;
  if (r === 4)  return 6;
  if (r === 0)  return 7;
  return 8; // ανευ ΦΠΑ
}

// AADE withhold category code for 20% φόρος δικηγόρου
// Πηγή: Παράρτημα myDATA — «Κατηγορίες Φόρου Παρακράτησης»
//   1 = 20%, 2 = 3%, ... κτλ. Χρησιμοποιούμε 1 για 20% withhold.
function withholdCategory() { return 1; }

// AADE stamp duty code
//   1 = 3.6%, 2 = 2.4%
function stampCategory() { return 2; }

// AADE ΤΝ code (Ταμείο Νομικών 12%)
//   OtherTaxes categories — 3 συνήθως αντιστοιχεί σε "Ταμείο Νομικών".
// Το exact code μπορεί να θέλει tweak μετά από πρώτο real submit — αφήνουμε παραμετροποίηση.
function otherTaxesCategoryTN() { return 3; }

// Income classification defaults για δικηγόρο (παροχή υπηρεσιών)
//   E3_561_001 = Πωλήσεις υπόχρεου, category1_3 = Έσοδα από παροχή υπηρεσιών
const DEFAULT_CLASSIFICATION_TYPE     = 'E3_561_001';
const DEFAULT_CLASSIFICATION_CATEGORY = 'category1_3';

// ---------- Public: build SendInvoices XML ----------

/**
 * @param {Object} args
 *   invoice           — invoices row (with lines)
 *   lines             — array of invoice_lines
 *   issuer            — { vatNumber, country='GR', branch=0, name?, address? }
 *   counterpart       — { vatNumber, country='GR', branch=0, name?, address? }
 *   invoiceType       — '1.1' | '2.1'   (default '2.1' for lawyer services)
 *   classificationType     — override (defaults to E3_561_001)
 *   classificationCategory — override (defaults to category1_3)
 */
function buildSendInvoicesXml(args) {
  const {
    invoice,
    lines,
    issuer,
    counterpart,
    invoiceType = '2.1',
    correlatedMark = null,
    classificationType     = DEFAULT_CLASSIFICATION_TYPE,
    classificationCategory = DEFAULT_CLASSIFICATION_CATEGORY,
  } = args;

  // Header
  const series = invoice.series_name || 'A';
  const aa     = invoice.number != null ? String(invoice.number) : String(invoice.aa);
  const date   = (invoice.date instanceof Date)
    ? invoice.date.toISOString().slice(0, 10)
    : String(invoice.date).slice(0, 10);

  // Sanitize counterpart — for GR entities: no name, no address
  const cpIsGR = (counterpart.country || 'GR') === 'GR';

  // Lines
  let linesXml = '';
  let totalNet = 0, totalVat = 0, totalWithhold = 0;
  (lines || []).forEach((l, idx) => {
    const lineNum = idx + 1;
    const net = Number(l.subtotal || 0);
    const vat = Number(l.vat_amount || 0);
    const vatCat = vatCategoryFromRate(l.vat_rate);
    totalNet += net;
    totalVat += vat;
    linesXml += `
      <invoiceDetails>
        <lineNumber>${lineNum}</lineNumber>
        <netValue>${num(net)}</netValue>
        <vatCategory>${vatCat}</vatCategory>
        <vatAmount>${num(vat)}</vatAmount>
        <incomeClassification>
          <icls:classificationType>${classificationType}</icls:classificationType>
          <icls:classificationCategory>${classificationCategory}</icls:classificationCategory>
          <icls:amount>${num(net)}</icls:amount>
        </incomeClassification>
      </invoiceDetails>`;
  });

  // Invoice-level deductions applied to totals (not per line)
  const applyWithhold = !!invoice.apply_withhold;
  const applyStamp    = !!invoice.apply_stamp;
  const applyTn       = !!invoice.apply_tn;

  const withholdAmount = applyWithhold ? Number(invoice.withhold_total || 0) : 0;
  const stampAmount    = applyStamp    ? Number(invoice.stamp_total    || 0) : 0;
  const tnAmount       = applyTn       ? Number(invoice.tn_total       || 0) : 0;

  // Summary blocks for withholding / stamp / other taxes go inside taxesTotals + invoiceSummary
  let taxesTotalsXml = '';
  if (withholdAmount > 0) {
    taxesTotalsXml += `
      <taxes>
        <taxType>1</taxType> <!-- 1 = Παρακρατούμενος -->
        <taxCategory>${withholdCategory()}</taxCategory>
        <underlyingValue>${num(totalNet)}</underlyingValue>
        <taxAmount>${num(withholdAmount)}</taxAmount>
      </taxes>`;
  }
  if (stampAmount > 0) {
    taxesTotalsXml += `
      <taxes>
        <taxType>3</taxType> <!-- 3 = Χαρτόσημο -->
        <taxCategory>${stampCategory()}</taxCategory>
        <underlyingValue>${num(totalNet)}</underlyingValue>
        <taxAmount>${num(stampAmount)}</taxAmount>
      </taxes>`;
  }
  if (tnAmount > 0) {
    taxesTotalsXml += `
      <taxes>
        <taxType>5</taxType> <!-- 5 = Λοιποί Φόροι -->
        <taxCategory>${otherTaxesCategoryTN()}</taxCategory>
        <underlyingValue>${num(totalNet)}</underlyingValue>
        <taxAmount>${num(tnAmount)}</taxAmount>
      </taxes>`;
  }

  const totalGross = totalNet + totalVat;
  // Summary "totals" reflect net + vat — deductions are separate lines in the printed doc.
  const totalDeductions = withholdAmount + stampAmount + tnAmount;

  // Issuer block: for GR issuer, don't send name/address
  const issuerCountry = issuer.country || 'GR';
  const issuerBlock = `
      <issuer>
        <vatNumber>${esc(issuer.vatNumber)}</vatNumber>
        <country>${esc(issuerCountry)}</country>
        <branch>${issuer.branch != null ? issuer.branch : 0}</branch>
      </issuer>`;

  // Counterpart block: for GR, only vatNumber/country/branch
  let counterpartBlock = '';
  if (counterpart && counterpart.vatNumber) {
    counterpartBlock = `
      <counterpart>
        <vatNumber>${esc(counterpart.vatNumber)}</vatNumber>
        <country>${esc(counterpart.country || 'GR')}</country>
        <branch>${counterpart.branch != null ? counterpart.branch : 0}</branch>${
          !cpIsGR && counterpart.name ? `
        <name>${esc(counterpart.name)}</name>` : ''
        }${
          !cpIsGR && counterpart.address ? `
        <address>
          <street>${esc(counterpart.address.street || '')}</street>
          <number>${esc(counterpart.address.number || '')}</number>
          <postalCode>${esc(counterpart.address.postalCode || '')}</postalCode>
          <city>${esc(counterpart.address.city || '')}</city>
        </address>` : ''
        }
      </counterpart>`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<InvoicesDoc xmlns="http://www.aade.gr/myDATA/invoice/v1.0"
             xmlns:icls="https://www.aade.gr/myDATA/incomeClassificaton/v1.0"
             xmlns:ecls="https://www.aade.gr/myDATA/expensesClassificaton/v1.0">
    <invoice>${issuerBlock}${counterpartBlock}
      <invoiceHeader>
        <series>${esc(series)}</series>
        <aa>${esc(aa)}</aa>
        <issueDate>${date}</issueDate>
        <invoiceType>${esc(invoiceType)}</invoiceType>
        <currency>EUR</currency>${correlatedMark ? `
        <correlatedInvoices>${esc(correlatedMark)}</correlatedInvoices>` : ''}
      </invoiceHeader>
      <paymentMethods>
        <paymentMethodDetails>
          <type>3</type>
          <amount>${num(totalGross - totalDeductions)}</amount>
        </paymentMethodDetails>
      </paymentMethods>${linesXml}
      ${taxesTotalsXml ? `<taxesTotals>${taxesTotalsXml}
      </taxesTotals>` : ''}
      <invoiceSummary>
        <totalNetValue>${num(totalNet)}</totalNetValue>
        <totalVatAmount>${num(totalVat)}</totalVatAmount>
        <totalWithheldAmount>${num(withholdAmount)}</totalWithheldAmount>
        <totalFeesAmount>0.00</totalFeesAmount>
        <totalStampDutyAmount>${num(stampAmount)}</totalStampDutyAmount>
        <totalOtherTaxesAmount>${num(tnAmount)}</totalOtherTaxesAmount>
        <totalDeductionsAmount>0.00</totalDeductionsAmount>
        <totalGrossValue>${num(totalGross)}</totalGrossValue>
        <incomeClassification>
          <icls:classificationType>${classificationType}</icls:classificationType>
          <icls:classificationCategory>${classificationCategory}</icls:classificationCategory>
          <icls:amount>${num(totalNet)}</icls:amount>
        </incomeClassification>
      </invoiceSummary>
    </invoice>
</InvoicesDoc>`;
}

// ---------- Response parsing ----------
// AADE returns XML like:
//
// <ResponseDoc>
//   <response>
//     <index>1</index>
//     <invoiceUid>...</invoiceUid>
//     <invoiceMark>...</invoiceMark>
//     <authenticationCode>...</authenticationCode>
//     <statusCode>Success</statusCode>
//   </response>
// </ResponseDoc>
//
// On error:
//   <statusCode>ValidationError</statusCode>
//   <errors><error><message>...</message><code>...</code></error></errors>

function parseResponseXml(xml) {
  const responses = [];
  const blocks = String(xml || '').split(/<response>/i).slice(1);
  for (const raw of blocks) {
    const body = raw.split(/<\/response>/i)[0] || '';
    const pick = (tag) => {
      const m = body.match(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'i'));
      return m ? m[1].trim() : null;
    };
    const errors = [];
    const errBlocks = body.split(/<error>/i).slice(1);
    for (const eb of errBlocks) {
      const ebody = eb.split(/<\/error>/i)[0] || '';
      const em = ebody.match(/<message>([^<]*)<\/message>/i);
      const ec = ebody.match(/<code>([^<]*)<\/code>/i);
      errors.push({
        message: em ? em[1] : '',
        code:    ec ? ec[1] : '',
      });
    }
    responses.push({
      index:              pick('index'),
      invoiceUid:         pick('invoiceUid'),
      invoiceMark:        pick('invoiceMark'),
      authenticationCode: pick('authenticationCode'),
      cancellationMark:   pick('cancellationMark'),
      statusCode:         pick('statusCode'),
      errors,
    });
  }
  return responses;
}

module.exports = {
  buildSendInvoicesXml,
  parseResponseXml,
  vatCategoryFromRate,
};
