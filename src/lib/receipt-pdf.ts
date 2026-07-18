/**
 * Deterministic, dependency-free writer for a born-digital text receipt PDF.
 *
 * Pure: the same lines always produce the same bytes. That matters for the
 * canary, because S3 sets a non-multipart object's etag to the content MD5 and
 * the pipeline folds the etag into the docId, so identical bytes re-uploaded to
 * one key stay a single document instead of extracting again on every run.
 *
 * Small on purpose. It emits one Helvetica text block that pdf-parse (the same
 * reader the ingest Lambda uses) reads straight back, so a receipt written here
 * is a receipt the pipeline can extract.
 */

// Escape the three characters that are special inside a PDF literal string.
function escapePdfText(s: string): string {
  return s.replace(/([\\()])/g, '\\$1');
}

export function makeReceiptPdf(lines: string[]): Buffer {
  // Text object: 12pt Helvetica, 16pt leading, one line per input line. The first
  // line is shown at the start point; each later line uses ' to drop a leading
  // and show, so the lines stack top to bottom.
  const body = [
    'BT',
    '/F1 12 Tf',
    '72 720 Td',
    ...lines.flatMap((line, i) =>
      i === 0 ? [`(${escapePdfText(line)}) Tj`] : ['0 -16 Td', `(${escapePdfText(line)}) Tj`],
    ),
    'ET',
  ].join('\n');

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(body, 'latin1')} >>\nstream\n${body}\nendstream`,
  ];

  // Assemble the body, recording each object's byte offset for the xref table.
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });

  // Cross-reference table, then trailer pointing the reader at object 1.
  const xrefStart = Buffer.byteLength(pdf, 'latin1');
  const size = objects.length + 1;
  let xref = `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += xref;
  pdf += `trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1');
}
