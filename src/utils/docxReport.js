// src/utils/docxReport.js
// Παραγωγή πραγματικού .docx για τις αναφορές, ΧΩΡΙΣ νέα dependency.
// Χρησιμοποιεί το pizzip που υπάρχει ήδη στο project (ένα .docx είναι zip με OOXML).
//
// Χρήση:
//   const { buildReportDocx } = require('../utils/docxReport');
//   const buf = buildReportDocx({
//     title: 'Προσεχείς Δικάσιμοι',
//     subtitle: 'Δικηγορικό Γραφείο Μαύρου',
//     filters: ['Δικηγόρος: Παπαδόπουλος Ι.', 'Από: 01/01/2026'],
//     columns: [{ key: 'date', label: 'Ημ/νία', width: 1400 }, ...],
//     rows: [...],
//     landscape: true,
//   });
//   res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
//   res.setHeader('Content-Disposition', 'attachment; filename="report.docx"');
//   res.send(buf);

const PizZip = require('pizzip');

// ---------- helpers ----------

function esc(v) {
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // Αφαίρεση χαρακτήρων ελέγχου που ακυρώνουν το XML
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

function fmtDate(v) {
  if (!v) return '';
  const d = v instanceof Date ? v : new Date(v);
  if (isNaN(d.getTime())) return String(v);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
}

function para(text, { bold = false, size = 20, align = 'left', spaceAfter = 0, color = '000000' } = {}) {
  return `<w:p>
    <w:pPr>
      <w:jc w:val="${align}"/>
      <w:spacing w:after="${spaceAfter}"/>
    </w:pPr>
    <w:r>
      <w:rPr>${bold ? '<w:b/>' : ''}<w:sz w:val="${size}"/><w:szCs w:val="${size}"/><w:color w:val="${color}"/></w:rPr>
      <w:t xml:space="preserve">${esc(text)}</w:t>
    </w:r>
  </w:p>`;
}

function cell(text, width, { bold = false, shade = null, size = 18 } = {}) {
  return `<w:tc>
    <w:tcPr>
      <w:tcW w:w="${width}" w:type="dxa"/>
      ${shade ? `<w:shd w:val="clear" w:color="auto" w:fill="${shade}"/>` : ''}
      <w:vAlign w:val="center"/>
    </w:tcPr>
    <w:p>
      <w:pPr><w:spacing w:after="0"/></w:pPr>
      <w:r>
        <w:rPr>${bold ? '<w:b/>' : ''}<w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr>
        <w:t xml:space="preserve">${esc(text)}</w:t>
      </w:r>
    </w:p>
  </w:tc>`;
}

// ---------- κύρια συνάρτηση ----------

function buildReportDocx({
  title = 'Αναφορά',
  subtitle = '',
  filters = [],
  columns = [],
  rows = [],
  landscape = true,
} = {}) {
  // A4: 11906 x 16838 twips. Σε landscape ανταλλάσσονται.
  const pageW = landscape ? 16838 : 11906;
  const pageH = landscape ? 11906 : 16838;
  const margin = 1134; // 2 cm
  const usable = pageW - margin * 2;

  // Κανονικοποίηση πλατών ώστε να αθροίζουν στο usable
  const declared = columns.reduce((s, c) => s + (c.width || 0), 0) || columns.length;
  const widths = columns.map((c) => Math.max(500, Math.round(((c.width || 1) / declared) * usable)));
  const drift = usable - widths.reduce((a, b) => a + b, 0);
  if (widths.length) widths[widths.length - 1] += drift;

  const headerRow = `<w:tr>
    <w:trPr><w:tblHeader/></w:trPr>
    ${columns.map((c, k) => cell(c.label, widths[k], { bold: true, shade: '1E293B' })).join('')}
  </w:tr>`.replace(/<w:t xml:space="preserve">/g, '<w:t xml:space="preserve">');

  // Λευκά γράμματα στην κεφαλίδα
  const headerRowWhite = `<w:tr>
    <w:trPr><w:tblHeader/></w:trPr>
    ${columns.map((c, k) => `<w:tc>
      <w:tcPr>
        <w:tcW w:w="${widths[k]}" w:type="dxa"/>
        <w:shd w:val="clear" w:color="auto" w:fill="1E293B"/>
        <w:vAlign w:val="center"/>
      </w:tcPr>
      <w:p>
        <w:pPr><w:spacing w:after="0"/></w:pPr>
        <w:r>
          <w:rPr><w:b/><w:sz w:val="18"/><w:szCs w:val="18"/><w:color w:val="FFFFFF"/></w:rPr>
          <w:t xml:space="preserve">${esc(c.label)}</w:t>
        </w:r>
      </w:p>
    </w:tc>`).join('')}
  </w:tr>`;

  const bodyRows = rows.map((r, ri) => `<w:tr>
    ${columns.map((c, k) => {
      let v = r[c.key];
      if (c.type === 'date') v = fmtDate(v);
      if (v === null || v === undefined || v === '') v = '—';
      return cell(v, widths[k], { shade: ri % 2 === 1 ? 'F1F5F9' : null });
    }).join('')}
  </w:tr>`).join('');

  const table = `<w:tbl>
    <w:tblPr>
      <w:tblW w:w="${usable}" w:type="dxa"/>
      <w:tblBorders>
        <w:top    w:val="single" w:sz="4" w:color="CBD5E1"/>
        <w:left   w:val="single" w:sz="4" w:color="CBD5E1"/>
        <w:bottom w:val="single" w:sz="4" w:color="CBD5E1"/>
        <w:right  w:val="single" w:sz="4" w:color="CBD5E1"/>
        <w:insideH w:val="single" w:sz="4" w:color="E2E8F0"/>
        <w:insideV w:val="single" w:sz="4" w:color="E2E8F0"/>
      </w:tblBorders>
      <w:tblLayout w:type="fixed"/>
    </w:tblPr>
    <w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>
    ${headerRowWhite}
    ${bodyRows}
  </w:tbl>`;

  const now = new Date();
  const stamp = `${String(now.getDate()).padStart(2, '0')}/${String(now.getMonth() + 1).padStart(2, '0')}/${now.getFullYear()} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  const head = [
    subtitle ? para(subtitle, { size: 20, color: '64748B', spaceAfter: 40 }) : '',
    para(title, { bold: true, size: 32, spaceAfter: 80 }),
    filters.length ? para('Κριτήρια: ' + filters.join('  ·  '), { size: 18, color: '475569', spaceAfter: 40 }) : '',
    para(`Ημερομηνία έκδοσης: ${stamp}    ·    Εγγραφές: ${rows.length}`, { size: 18, color: '475569', spaceAfter: 160 }),
  ].join('');

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${head}
    ${table}
    <w:p><w:pPr><w:spacing w:before="200"/></w:pPr><w:r><w:rPr><w:sz w:val="16"/><w:color w:val="94A3B8"/></w:rPr><w:t xml:space="preserve">Thesis — Σύστημα Διαχείρισης Νομικών Υποθέσεων</w:t></w:r></w:p>
    <w:sectPr>
      <w:pgSz w:w="${pageW}" w:h="${pageH}"${landscape ? ' w:orient="landscape"' : ''}/>
      <w:pgMar w:top="${margin}" w:right="${margin}" w:bottom="${margin}" w:left="${margin}" w:header="708" w:footer="708" w:gutter="0"/>
    </w:sectPr>
  </w:body>
</w:document>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;

  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

  const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault>
      <w:rPr>
        <w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/>
        <w:sz w:val="20"/>
        <w:szCs w:val="20"/>
        <w:lang w:val="el-GR"/>
      </w:rPr>
    </w:rPrDefault>
    <w:pPrDefault>
      <w:pPr><w:spacing w:after="60" w:line="240" w:lineRule="auto"/></w:pPr>
    </w:pPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/>
    <w:qFormat/>
  </w:style>
</w:styles>`;

  const zip = new PizZip();
  zip.file('[Content_Types].xml', contentTypes);
  zip.folder('_rels').file('.rels', rootRels);
  const word = zip.folder('word');
  word.file('document.xml', documentXml);
  word.file('styles.xml', stylesXml);
  word.folder('_rels').file('document.xml.rels', docRels);

  return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}

// Καθαρίζει το όνομα αρχείου από χαρακτήρες που δεν επιτρέπονται σε HTTP header
function safeFilename(name) {
  return String(name).replace(/[^A-Za-z0-9._-]/g, '_');
}

// Στέλνει το docx στον client
function sendDocx(res, buffer, filename) {
  res.setHeader('Content-Type',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.setHeader('Content-Disposition',
    `attachment; filename="${safeFilename(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.setHeader('Content-Length', buffer.length);
  return res.send(buffer);
}

module.exports = { buildReportDocx, sendDocx, fmtDate };
