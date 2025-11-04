// pdf-parse ships no types for its lib entry. Reuse the root package's types,
// which is why @types/pdf-parse is a dependency.
declare module 'pdf-parse/lib/pdf-parse.js' {
  import pdfParse from 'pdf-parse';
  export default pdfParse;
}
