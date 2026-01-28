// Backend/googleDriveClient.js
import path from "path";
import { fileURLToPath } from "url";
import { google } from "googleapis";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Scopes de solo lectura
const SCOPES = ["https://www.googleapis.com/auth/drive.readonly"];

// Ruta al JSON de la service account
const KEYFILE_PATH = path.join(__dirname, "config", "service-account.json");

// ID de la carpeta (desde .env)
const DEFAULT_SYSTEM_FOLDER_ID = process.env.SYSTEM_FOLDER_ID;

// --------------------------
//   CLIENTE DE GOOGLE DRIVE
// --------------------------
function createDriveClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: KEYFILE_PATH,
    scopes: SCOPES,
  });
  return google.drive({ version: "v3", auth });
}

// --------------------------
//   LISTAR ARCHIVOS
// --------------------------
export async function listarArchivosSistemaGestion(limit = 20, folderId = DEFAULT_SYSTEM_FOLDER_ID) {
  const drive = createDriveClient();

  const res = await drive.files.list({
    q: `'${folderId}' in parents and trashed = false`,
    fields: "files(id, name, mimeType, webViewLink, modifiedTime)",
    pageSize: limit,
  });

  return res.data.files || [];
}

export async function buscarArchivosPorTexto(texto, limit = 5, folderId = DEFAULT_SYSTEM_FOLDER_ID) {
  const drive = createDriveClient();

  const safeText = (texto || "").replace(/'/g, "\\'");

  const q = [
    `'${folderId}' in parents`,
    "trashed = false",
    "(" + `name contains '${safeText}' or fullText contains '${safeText}'` + ")",
  ].join(" and ");

  const res = await drive.files.list({
    q,
    fields: "files(id, name, mimeType, webViewLink, modifiedTime)",
    pageSize: limit,
  });

  return res.data.files || [];
}

// --------------------------
//   DESCARGA / EXPORT
// --------------------------
async function descargarArchivoBuffer(fileId) {
  const drive = createDriveClient();

  const res = await drive.files.get(
    { fileId, alt: "media" },
    { responseType: "arraybuffer" }
  );

  return Buffer.from(res.data);
}

// Export SOLO para Google Docs/Sheets/Slides
async function exportarGoogleFileBuffer(fileId, exportMimeType) {
  const drive = createDriveClient();

  const res = await drive.files.export(
    { fileId, mimeType: exportMimeType },
    { responseType: "arraybuffer" }
  );

  return Buffer.from(res.data);
}

// --------------------------
//   PARSERS (lazy imports)
// --------------------------
let pdfParseFn = null;
async function getPdfParse() {
  if (!pdfParseFn) {
    const mod = await import("pdf-parse");
    pdfParseFn = mod.default || mod;
  }
  return pdfParseFn;
}

let mammothLib = null;
async function getMammoth() {
  if (!mammothLib) {
    const mod = await import("mammoth");
    mammothLib = mod.default || mod;
  }
  return mammothLib;
}

let ExcelJS = null;
async function getExcelJS() {
  if (!ExcelJS) {
    const mod = await import("exceljs");
    ExcelJS = mod.default || mod;
  }
  return ExcelJS;
}

// --------------------------
//   EXTRACTORES
// --------------------------
async function extraerTextoDePDFBuffer(buffer) {
  const pdfParse = await getPdfParse();
  const data = await pdfParse(buffer);
  return (data.text || "").trim();
}

async function extraerTextoDePDF(fileId) {
  const buffer = await descargarArchivoBuffer(fileId);
  return extraerTextoDePDFBuffer(buffer);
}

async function extraerTextoDeDOCX(fileId) {
  const buffer = await descargarArchivoBuffer(fileId);
  const mammoth = await getMammoth();
  const result = await mammoth.extractRawText({ buffer });
  return (result?.value || "").trim();
}

async function extraerTextoDeXLSXBuffer(buffer, { maxCells = 50000 } = {}) {
  const Excel = await getExcelJS();
  const workbook = new Excel.Workbook();

  await workbook.xlsx.load(buffer);

  let out = "";
  let cellCount = 0;

  workbook.eachSheet((ws) => {
    out += `\n\n=== SHEET: ${ws.name} ===\n`;

    ws.eachRow((row) => {
      if (cellCount >= maxCells) return;

      const values = row.values || [];
      // row.values[0] es undefined por diseño en exceljs
      const line = values
        .slice(1)
        .map((v) => {
          if (v === null || v === undefined) return "";
          if (typeof v === "object" && v?.text) return String(v.text);
          return String(v);
        })
        .join(" | ")
        .trim();

      if (line) out += line + "\n";

      cellCount += (values.length - 1);
    });
  });

  return out.trim();
}

async function extraerTextoDeXLSX(fileId) {
  const buffer = await descargarArchivoBuffer(fileId);
  return extraerTextoDeXLSXBuffer(buffer);
}

// Google Docs -> text/plain
async function extraerTextoGoogleDoc(fileId) {
  const buffer = await exportarGoogleFileBuffer(fileId, "text/plain");
  return buffer.toString("utf-8").trim();
}

// Google Sheets -> export a XLSX y parse con exceljs
async function extraerTextoGoogleSheet(fileId) {
  const buffer = await exportarGoogleFileBuffer(
    fileId,
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
  return extraerTextoDeXLSXBuffer(buffer);
}

// Google Slides -> export a PDF y parse PDF
async function extraerTextoGoogleSlides(fileId) {
  const buffer = await exportarGoogleFileBuffer(fileId, "application/pdf");
  return extraerTextoDePDFBuffer(buffer);
}

// TXT/JSON/etc descargables como texto
async function extraerTextoPlano(fileId) {
  const buffer = await descargarArchivoBuffer(fileId);
  return buffer.toString("utf-8").trim();
}

// --------------------------
//   API PRINCIPAL
// --------------------------
export async function obtenerTextoArchivo(file) {
  const mime = file?.mimeType || "";
  const fileId = file?.id;

  if (!fileId) return "";

  // PDFs
  if (mime === "application/pdf") {
    return await extraerTextoDePDF(fileId);
  }

  // DOCX
  if (mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    return await extraerTextoDeDOCX(fileId);
  }

  // XLSX
  if (mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") {
    return await extraerTextoDeXLSX(fileId);
  }

  // Google Workspace
  if (mime === "application/vnd.google-apps.document") {
    return await extraerTextoGoogleDoc(fileId);
  }

  if (mime === "application/vnd.google-apps.spreadsheet") {
    return await extraerTextoGoogleSheet(fileId);
  }

  if (mime === "application/vnd.google-apps.presentation") {
    return await extraerTextoGoogleSlides(fileId);
  }

  // Texto plano
  if (mime.startsWith("text/") || mime === "application/json") {
    return await extraerTextoPlano(fileId);
  }

  // PPTX (subido como archivo Office) -> NO soportado aquí (recomendación: convertir a Google Slides o PDF)
  // application/vnd.openxmlformats-officedocument.presentationml.presentation

  return "";
}
