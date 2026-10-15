import * as mammoth from "mammoth";
import ExcelJS from "exceljs";

export class EvidenceExtractionError extends Error {}

const MAX_BINARY_BYTES = 10 * 1024 * 1024;
const MAX_EXTRACTED_CHARS = 2_000_000;
const MAX_PDF_PAGES = 300;
const MAX_XLSX_ROWS = 50_000;

export type SupportedDocumentKind =
  | "txt"
  | "md"
  | "csv"
  | "docx"
  | "pdf"
  | "xlsx";

const kindFromInput = (
  name: string,
  mime: string
): SupportedDocumentKind | null => {
  const extension = name.split(".").pop()?.toLowerCase();
  const normalizedMime = mime.toLowerCase().split(";")[0].trim();
  if (["txt", "md", "csv", "docx", "pdf", "xlsx"].includes(extension ?? "")) {
    return extension as SupportedDocumentKind;
  }
  if (["text/plain"].includes(normalizedMime)) return "txt";
  if (["text/markdown", "text/x-markdown"].includes(normalizedMime))
    return "md";
  if (["text/csv", "application/csv"].includes(normalizedMime)) return "csv";
  if (normalizedMime === "application/pdf") return "pdf";
  if (
    normalizedMime ===
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  )
    return "docx";
  if (
    normalizedMime ===
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  )
    return "xlsx";
  return null;
};

const decodeBase64 = (input: string): Buffer => {
  const value = input.startsWith("data:")
    ? input.slice(input.indexOf(",") + 1)
    : input;
  if (
    !value ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value) ||
    value.length % 4 === 1
  ) {
    throw new EvidenceExtractionError("Invalid base64 document.");
  }
  const buffer = Buffer.from(value, "base64");
  if (!buffer.length) throw new EvidenceExtractionError("Document is empty.");
  if (buffer.length > MAX_BINARY_BYTES)
    throw new EvidenceExtractionError(
      "Document exceeds the 10 MB import limit."
    );
  return buffer;
};

const requireText = (text: string): string => {
  const normalized = text.replace(/\u0000/g, "").trim();
  if (!normalized) {
    throw new EvidenceExtractionError(
      "Document has no extractable text; scanned documents are not supported."
    );
  }
  if (normalized.length > MAX_EXTRACTED_CHARS) {
    throw new EvidenceExtractionError(
      "Extracted text exceeds the 2,000,000 character limit."
    );
  }
  return normalized;
};

const cellText = (value: unknown): string => {
  if (value === null || value === undefined) return "";
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return String(value);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    const record = value as {
      text?: unknown;
      result?: unknown;
      richText?: Array<{ text?: unknown }>;
    };
    if (typeof record.text === "string") return record.text;
    if (record.result !== undefined) return cellText(record.result);
    if (Array.isArray(record.richText))
      return record.richText.map(part => String(part.text ?? "")).join("");
  }
  return "";
};

async function extractPdf(buffer: Buffer): Promise<string> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const document = await pdfjs.getDocument({ data: new Uint8Array(buffer) })
    .promise;
  try {
    if (document.numPages > MAX_PDF_PAGES)
      throw new EvidenceExtractionError(
        "PDF exceeds the 300-page import limit."
      );
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const pageText = content.items
        .map(item => ("str" in item ? item.str : ""))
        .filter((value): value is string => Boolean(value))
        .join(" ");
      pages.push(pageText);
    }
    return pages.join("\n\n");
  } finally {
    await document.destroy();
  }
}

async function extractXlsx(buffer: Buffer): Promise<string> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as never);
  let rowCount = 0;
  const sheets: string[] = [];
  workbook.eachSheet(sheet => {
    const rows: string[] = [`# Sheet: ${sheet.name}`];
    sheet.eachRow({ includeEmpty: false }, row => {
      rowCount += 1;
      if (rowCount > MAX_XLSX_ROWS)
        throw new EvidenceExtractionError(
          "Spreadsheet exceeds the 50,000-row import limit."
        );
      const values = Array.isArray(row.values)
        ? row.values.slice(1)
        : Object.values(row.values ?? {});
      const text = values.map(cellText).filter(Boolean).join(" | ");
      if (text) rows.push(text);
    });
    if (rows.length > 1) sheets.push(rows.join("\n"));
  });
  return sheets.join("\n\n");
}

export async function extractEvidenceText(input: {
  name: string;
  mime: string;
  base64: string;
}): Promise<string> {
  const kind = kindFromInput(input.name, input.mime);
  if (!kind)
    throw new EvidenceExtractionError(
      "Unsupported document type. Use TXT, MD, CSV, DOCX, PDF, or XLSX."
    );
  const buffer = decodeBase64(input.base64);

  let text: string;
  if (kind === "txt" || kind === "md" || kind === "csv") {
    text = buffer.toString("utf8");
  } else if (kind === "docx") {
    const result = await mammoth.extractRawText({ buffer });
    text = result.value;
  } else if (kind === "pdf") {
    text = await extractPdf(buffer);
  } else {
    text = await extractXlsx(buffer);
  }
  return requireText(text);
}
