/**
 * Extract text from a born-digital PDF. OCR is out of scope, so a scanned or
 * empty PDF is treated as unextractable rather than run through an OCR path.
 */
// Import the lib entry, not the package root. pdf-parse's index.js has a debug
// block that reads a bundled sample PDF when it thinks it is the main module,
// which throws inside a bundled Lambda. The lib entry skips that block.
import pdfParse from 'pdf-parse/lib/pdf-parse.js';

export async function extractText(pdf: Buffer): Promise<string> {
  const parsed = await pdfParse(pdf);
  const text = parsed.text.trim();
  if (!text) throw new Error('no extractable text, likely scanned or empty (OCR is out of scope)');
  return text;
}
