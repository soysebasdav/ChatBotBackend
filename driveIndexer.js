import dotenv from "dotenv";
import OpenAI from "openai";
import pool from "./db.js";
import { createDriveClient, listFolder, downloadBuffer, exportBuffer } from "./driveClient.js";

dotenv.config();

const SYSTEM_FOLDER_ID = process.env.SYSTEM_FOLDER_ID;

const EMB_MODEL = process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const DRIVE_SYNC_BATCH_FILES = Number(process.env.DRIVE_SYNC_BATCH_FILES || 10);
const MAX_TEXT_CHARS = Number(process.env.DRIVE_MAX_TEXT_CHARS || 60000);
const MAX_FILE_BYTES = Number(process.env.DRIVE_MAX_FILE_BYTES || 120000000);

const CHUNK_MAX_CHARS = Number(process.env.CHUNK_MAX_CHARS || 1800);
const CHUNK_OVERLAP_CHARS = Number(process.env.CHUNK_OVERLAP_CHARS || 250);

function embeddingToPgVectorString(emb) {
  return `[${emb.join(",")}]`;
}

function normalizeText(s) {
  const t = (s || "").replace(/\u0000/g, "").trim();
  if (!t) return "";
  return t.length > MAX_TEXT_CHARS ? t.slice(0, MAX_TEXT_CHARS) : t;
}

function chunkText(text, { maxChars = CHUNK_MAX_CHARS, overlap = CHUNK_OVERLAP_CHARS } = {}) {
  const clean = (text || "").replace(/\r/g, "").trim();
  if (!clean) return [];
  const chunks = [];
  let i = 0;
  while (i < clean.length) {
    const end = Math.min(clean.length, i + maxChars);
    const slice = clean.slice(i, end).trim();
    if (slice) chunks.push(slice);
    if (end >= clean.length) break;
    i = Math.max(0, end - overlap);
  }
  return chunks;
}

async function embedTexts(texts) {
  const r = await client.embeddings.create({ model: EMB_MODEL, input: texts });
  return r.data.map((x) => x.embedding);
}

// ---- PDF ----
let pdfParseFn = null;
async function getPdfParse() {
  if (!pdfParseFn) {
    const mod = await import("pdf-parse");
    pdfParseFn = mod.default || mod;
  }
  return pdfParseFn;
}
async function extractTextFromPdfBuffer(buffer) {
  const pdfParse = await getPdfParse();
  const data = await pdfParse(buffer);
  return (data?.text || "").trim();
}

// ---- DOCX ----
let mammothMod = null;
async function getMammoth() {
  if (!mammothMod) {
    const mod = await import("mammoth");
    mammothMod = mod.default || mod;
  }
  return mammothMod;
}
async function extractTextFromDocxBuffer(buffer) {
  const mammoth = await getMammoth();
  const r = await mammoth.extractRawText({ buffer });
  return (r?.value || "").trim();
}

// ---- XLSX ----
let excelJsMod = null;
async function getExcelJS() {
  if (!excelJsMod) {
    const mod = await import("exceljs");
    excelJsMod = mod.default || mod;
  }
  return excelJsMod;
}
async function extractTextFromXlsxBuffer(buffer) {
  const ExcelJS = await getExcelJS();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);

  const lines = [];
  wb.worksheets.forEach((ws) => {
    lines.push(`\n=== HOJA: ${ws.name} ===`);
    ws.eachRow({ includeEmpty: false }, (row) => {
      const cells = row.values
        .slice(1)
        .map((v) => {
          if (v == null) return "";
          if (typeof v === "object") {
            if (v.text) return String(v.text);
            if (v.result) return String(v.result);
            if (v.richText) return v.richText.map((t) => t.text).join("");
          }
          return String(v);
        })
        .filter(Boolean);

      if (cells.length) lines.push(cells.join(" | "));
    });
  });

  return lines.join("\n").trim();
}

// ---- PPTX ----
let admZipMod = null;
async function getAdmZip() {
  if (!admZipMod) {
    const mod = await import("adm-zip");
    admZipMod = mod.default || mod;
  }
  return admZipMod;
}
function extractTextFromXml(xml) {
  const out = [];
  const re = /<a:t>([\s\S]*?)<\/a:t>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const t = m[1]
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
    if (t.trim()) out.push(t.trim());
  }
  return out.join("\n").trim();
}
async function extractTextFromPptxBuffer(buffer) {
  const AdmZip = await getAdmZip();
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries();
  const slideEntries = entries
    .filter((e) => e.entryName.startsWith("ppt/slides/slide") && e.entryName.endsWith(".xml"))
    .sort((a, b) => a.entryName.localeCompare(b.entryName));

  const parts = [];
  for (const e of slideEntries) {
    const xml = e.getData().toString("utf8");
    const t = extractTextFromXml(xml);
    if (t) parts.push(t);
  }
  return parts.join("\n\n").trim();
}

async function extractTextFromDriveFile(drive, file) {
  const mimeType = file.mimeType || "";
  const fileId = file.id;

  if (mimeType === "application/vnd.google-apps.document") {
    const buf = await exportBuffer(drive, fileId, "text/plain");
    return normalizeText(buf.toString("utf8"));
  }

  if (mimeType === "application/vnd.google-apps.spreadsheet") {
    const buf = await exportBuffer(drive, fileId, "text/csv");
    return normalizeText(buf.toString("utf8"));
  }

  if (mimeType === "application/vnd.google-apps.presentation") {
    const buf = await exportBuffer(drive, fileId, "application/pdf");
    const txt = await extractTextFromPdfBuffer(buf);
    return normalizeText(txt);
  }

  if (mimeType === "application/pdf") {
    const buf = await downloadBuffer(drive, fileId);
    const txt = await extractTextFromPdfBuffer(buf);
    return normalizeText(txt);
  }

  if (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    const buf = await downloadBuffer(drive, fileId);
    const txt = await extractTextFromDocxBuffer(buf);
    return normalizeText(txt);
  }

  if (mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") {
    const buf = await downloadBuffer(drive, fileId);
    const txt = await extractTextFromXlsxBuffer(buf);
    return normalizeText(txt);
  }

  if (mimeType === "application/vnd.openxmlformats-officedocument.presentationml.presentation") {
    const buf = await downloadBuffer(drive, fileId);
    const txt = await extractTextFromPptxBuffer(buf);
    return normalizeText(txt);
  }

  if (mimeType.startsWith("text/") || mimeType === "application/json") {
    const buf = await downloadBuffer(drive, fileId);
    return normalizeText(buf.toString("utf8"));
  }

  return "";
}

// ---- State ----
function normalizeQueue(queue, folderId) {
  if (!Array.isArray(queue) || queue.length === 0) return [{ id: folderId, pageToken: null }];
  if (typeof queue[0] === "string") return queue.map((id) => ({ id, pageToken: null }));
  return queue.map((x) => ({ id: x?.id, pageToken: x?.pageToken ?? null }));
}

async function getOrInitState(folderId) {
  const q = await pool.query(
    `select folder_id, state from public.drive_sync_state where folder_id = $1 limit 1`,
    [folderId]
  );

  if (q.rows.length) {
    const st = q.rows[0].state || {};
    st.queue = normalizeQueue(st.queue, folderId);
    st.done = !!st.done;
    st.scannedFolders = st.scannedFolders || 0;
    st.scannedFiles = st.scannedFiles || 0;
    st.indexed = st.indexed || 0;
    st.skipped = st.skipped || 0;
    st.errors = st.errors || 0;
    return st;
  }

  const initState = {
    queue: [{ id: folderId, pageToken: null }],
    done: false,
    scannedFolders: 0,
    scannedFiles: 0,
    indexed: 0,
    skipped: 0,
    errors: 0,
  };

  await pool.query(
    `insert into public.drive_sync_state(folder_id, state) values ($1, $2::jsonb)`,
    [folderId, JSON.stringify(initState)]
  );

  return initState;
}

async function saveState(folderId, state) {
  await pool.query(
    `update public.drive_sync_state set state = $2::jsonb, updated_at = now() where folder_id = $1`,
    [folderId, JSON.stringify(state)]
  );
}

export async function getDriveSyncState(folderId = SYSTEM_FOLDER_ID) {
  if (!folderId) throw new Error("SYSTEM_FOLDER_ID no configurado");
  const st = await getOrInitState(folderId);
  return st;
}

export async function resetDriveSyncState(folderId = SYSTEM_FOLDER_ID) {
  if (!folderId) throw new Error("SYSTEM_FOLDER_ID no configurado");

  const state = {
    queue: [{ id: folderId, pageToken: null }],
    done: false,
    scannedFolders: 0,
    scannedFiles: 0,
    indexed: 0,
    skipped: 0,
    errors: 0,
  };

  await pool.query(
    `insert into public.drive_sync_state(folder_id, state)
     values ($1, $2::jsonb)
     on conflict (folder_id) do update
     set state = excluded.state, updated_at = now()`,
    [folderId, JSON.stringify(state)]
  );

  return { ok: true, folderId, state };
}

// Bulk insert chunks
function buildBulkInsertChunks({ folderId, driveFileId, chunks, embeddings, meta }) {
  const values = [];
  const params = [];
  let p = 1;

  for (let i = 0; i < chunks.length; i++) {
    params.push(
      folderId,
      driveFileId,
      i,
      chunks[i],
      embeddingToPgVectorString(embeddings[i]),
      JSON.stringify(meta)
    );
    values.push(`($${p++},$${p++},$${p++},$${p++},($${p++})::vector,$${p++}::jsonb)`);
  }

  const sql = `
    insert into public.drive_chunks
      (folder_id, drive_file_id, chunk_index, content, embedding, metadata)
    values ${values.join(",")}
  `;

  return { sql, params };
}

export async function syncDriveBatch({
  folderId = SYSTEM_FOLDER_ID,
  batchFiles = DRIVE_SYNC_BATCH_FILES,
} = {}) {
  if (!folderId) throw new Error("SYSTEM_FOLDER_ID no configurado");

  const drive = createDriveClient();
  const state = await getOrInitState(folderId);

  if (state.done) {
    return { ok: true, done: true, queueRemaining: 0, state, result: { processed: 0, indexed: 0, skipped: 0, errors: 0, unchanged: 0 } };
  }

  let processed = 0;
  let indexed = 0;
  let skipped = 0;
  let errors = 0;
  let unchanged = 0;

  while (!state.done && processed < batchFiles) {
    if (!state.queue?.length) {
      state.done = true;
      break;
    }

    const current = state.queue.shift();
    const currentFolderId = current?.id;
    const pageToken = current?.pageToken || null;
    if (!currentFolderId) continue;

    state.scannedFolders += 1;

    const { files: items, nextPageToken } = await listFolder(drive, currentFolderId, pageToken);

    if (nextPageToken) state.queue.unshift({ id: currentFolderId, pageToken: nextPageToken });

    for (const file of items) {
      if (processed >= batchFiles) break;

      const isFolder = file.mimeType === "application/vnd.google-apps.folder";
      if (isFolder) {
        state.queue.push({ id: file.id, pageToken: null });
        continue;
      }

      state.scannedFiles += 1;
      processed += 1;

      const driveFileId = file.id;
      const name = file.name || "(sin nombre)";
      const mimeType = file.mimeType || "";
      const webViewLink = file.webViewLink || null;
      const modifiedTime = file.modifiedTime || null;
      const md5Checksum = file.md5Checksum || null;
      const sizeBytes = file.size ? parseInt(file.size, 10) : null;

      try {
        if (sizeBytes && sizeBytes > MAX_FILE_BYTES) {
          skipped += 1;
          state.skipped += 1;

          await pool.query(
            `insert into public.drive_files
              (folder_id, drive_file_id, name, mime_type, web_view_link, modified_time, md5_checksum, size_bytes, status, error_message)
             values ($1,$2,$3,$4,$5,$6,$7,$8,'skipped',$9)
             on conflict (folder_id, drive_file_id) do update
             set name=excluded.name,
                 mime_type=excluded.mime_type,
                 web_view_link=excluded.web_view_link,
                 modified_time=excluded.modified_time,
                 md5_checksum=excluded.md5_checksum,
                 size_bytes=excluded.size_bytes,
                 status='skipped',
                 error_message=excluded.error_message,
                 updated_at=now()`,
            [folderId, driveFileId, name, mimeType, webViewLink, modifiedTime, md5Checksum, sizeBytes, `Archivo demasiado grande (${sizeBytes} bytes)`]
          );

          continue;
        }

        const existing = await pool.query(
          `select md5_checksum, modified_time, status
           from public.drive_files
           where folder_id = $1 and drive_file_id = $2
           limit 1`,
          [folderId, driveFileId]
        );

        if (existing.rows.length) {
          const ex = existing.rows[0];
          const sameMd5 = md5Checksum && ex.md5_checksum && md5Checksum === ex.md5_checksum;
          const sameMTime =
            modifiedTime &&
            ex.modified_time &&
            new Date(modifiedTime).getTime() === new Date(ex.modified_time).getTime();

          if (ex.status === "indexed" && (sameMd5 || sameMTime)) {
            unchanged += 1;
            continue;
          }
        }

        // Upsert metadata -> processing
        await pool.query(
          `insert into public.drive_files
            (folder_id, drive_file_id, name, mime_type, web_view_link, modified_time, md5_checksum, size_bytes, status, error_message)
           values ($1,$2,$3,$4,$5,$6,$7,$8,'processing',null)
           on conflict (folder_id, drive_file_id) do update
           set name = excluded.name,
               mime_type = excluded.mime_type,
               web_view_link = excluded.web_view_link,
               modified_time = excluded.modified_time,
               md5_checksum = excluded.md5_checksum,
               size_bytes = excluded.size_bytes,
               status = 'processing',
               error_message = null,
               updated_at = now()`,
          [folderId, driveFileId, name, mimeType, webViewLink, modifiedTime, md5Checksum, sizeBytes]
        );

        const text = await extractTextFromDriveFile(drive, file);
        const trimmed = (text || "").trim();

        if (!trimmed) {
          skipped += 1;
          state.skipped += 1;

          await pool.query(
            `update public.drive_files
             set status='skipped',
                 error_message='Tipo no soportado o texto vacío',
                 updated_at=now()
             where folder_id=$1 and drive_file_id=$2`,
            [folderId, driveFileId]
          );
          continue;
        }

        const chunks = chunkText(trimmed);

        if (!chunks.length) {
          skipped += 1;
          state.skipped += 1;

          await pool.query(
            `update public.drive_files
             set status='skipped',
                 error_message='Texto vacío tras chunking',
                 updated_at=now()
             where folder_id=$1 and drive_file_id=$2`,
            [folderId, driveFileId]
          );
          continue;
        }

        const embeddings = await embedTexts(chunks);

        const meta = { fileName: name, mimeType, modifiedTime, webViewLink };

        const db = await pool.connect();
        try {
          await db.query("begin");

          await db.query(
            `delete from public.drive_chunks where folder_id=$1 and drive_file_id=$2`,
            [folderId, driveFileId]
          );

          const { sql, params } = buildBulkInsertChunks({
            folderId,
            driveFileId,
            chunks,
            embeddings,
            meta,
          });

          await db.query(sql, params);

          await db.query(
            `update public.drive_files
             set status='indexed',
                 error_message=null,
                 updated_at=now()
             where folder_id=$1 and drive_file_id=$2`,
            [folderId, driveFileId]
          );

          await db.query("commit");
        } catch (txErr) {
          await db.query("rollback");
          throw txErr;
        } finally {
          db.release();
        }

        indexed += 1;
        state.indexed += 1;
      } catch (e) {
        errors += 1;
        state.errors += 1;

        await pool.query(
          `update public.drive_files
           set status='skipped',
               error_message=$3,
               updated_at=now()
           where folder_id=$1 and drive_file_id=$2`,
          [folderId, driveFileId, `Error al procesar: ${e.message}`]
        );
      }
    }
  }

  if (!state.queue?.length) state.done = true;
  await saveState(folderId, state);

  return {
    ok: true,
    done: state.done,
    queueRemaining: state.queue?.length || 0,
    state,
    result: { processed, indexed, skipped, errors, unchanged },
  };
}
