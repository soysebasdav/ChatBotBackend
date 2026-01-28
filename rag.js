import dotenv from "dotenv";
import OpenAI from "openai";
import pool from "./db.js";

dotenv.config();

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const EMB_MODEL = process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";
const TOP_K = Number(process.env.RAG_TOP_K || 10);
const MIN_SIM = Number(process.env.RAG_MIN_SIMILARITY || 0.25);

function vectorString(v) {
  return `[${v.join(",")}]`;
}

export async function embed(text) {
  const r = await client.embeddings.create({
    model: EMB_MODEL,
    input: text,
  });
  return r.data[0].embedding;
}

/**
 * Recupera contexto + fuentes desde drive_chunks.
 * Filtro opcional por regex en nombre del archivo (blocklist).
 */
export async function retrieveContext({ folderId, query, blocklistRegex = null }) {
  const qEmb = await embed(query);
  const v = vectorString(qEmb);

  // Si hay blocklistRegex, filtramos en SQL por nombre (case-insensitive)
  const hasBlock = !!blocklistRegex;

  const sql = `
    select
      c.drive_file_id,
      c.chunk_index,
      c.content,
      f.name as file_name,
      f.web_view_link,
      f.modified_time,
      (1 - (c.embedding <=> ($1)::vector)) as similarity
    from public.drive_chunks c
    join public.drive_files f
      on f.folder_id = c.folder_id
     and f.drive_file_id = c.drive_file_id
    where c.folder_id = $2
      ${hasBlock ? "and coalesce(f.name,'') !~* $4" : ""}
    order by c.embedding <=> ($1)::vector asc
    limit $3
  `;

  const params = hasBlock
    ? [v, folderId, TOP_K, blocklistRegex]
    : [v, folderId, TOP_K];

  const r = await pool.query(sql, params);
  const rows = r.rows || [];
  const best = rows?.[0]?.similarity ?? 0;

  if (!rows.length || best < MIN_SIM) {
    return { context: "", sources: [], bestSimilarity: best };
  }

  let ctx = "";
  const sources = [];

  const MAX_CTX_CHARS = 9000;

  for (const row of rows) {
    const header = `\n\n=== ${row.file_name || row.drive_file_id} | chunk ${
      row.chunk_index
    } | sim ${Number(row.similarity || 0).toFixed(3)} ===\n`;

    const piece = (row.content || "").trim();

    const remaining = MAX_CTX_CHARS - ctx.length;
    if (remaining <= 0) break;

    ctx += header + piece.slice(0, Math.max(0, remaining - header.length));

    sources.push({
      drive_file_id: row.drive_file_id,
      name: row.file_name,
      web_view_link: row.web_view_link,
      modified_time: row.modified_time,
      similarity: row.similarity,
      chunk_index: row.chunk_index,
    });
  }

  return { context: ctx.trim(), sources, bestSimilarity: best };
}
