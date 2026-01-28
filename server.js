// Backend/server.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";

import { login } from "./auth.js";
import { retrieveContext } from "./rag.js";
import { syncDriveBatch, resetDriveSyncState } from "./driveIndexer.js";
import { createChat, listChats, getChat, setChatFavorite, deleteChat } from "./chatStore.js";
import { getDriveSyncState } from "./driveIndexer.js";

dotenv.config();

const app = express();

const allowedOrigin = process.env.CORS_ORIGIN || "*";
app.use(
  cors({
    origin: allowedOrigin === "*" ? "*" : [allowedOrigin],
  })
);

app.use(express.json({ limit: "2mb" }));

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const SYSTEM_FOLDER_ID = process.env.SYSTEM_FOLDER_ID;

// --------------------
// LOGIN
// --------------------
app.post("/api/login", async (req, res) => {
  try {
    const { usuario, password } = req.body || {};
    const user = await login(usuario, password);
    if (!user) return res.status(401).json({ ok: false, error: "Credenciales inválidas" });
    return res.json({ ok: true, user });
  } catch (e) {
    console.error("LOGIN error:", e);
    return res.status(500).json({ ok: false, error: "Error interno en login" });
  }
});

// --------------------
// DRIVE SYNC
// --------------------
let DRIVE_SYNC_RUNNING = false;

function compactStateForApi(state) {
  if (!state) return state;
  const q = Array.isArray(state.queue) ? state.queue : [];
  return {
    done: !!state.done,
    scannedFolders: state.scannedFolders || 0,
    scannedFiles: state.scannedFiles || 0,
    indexed: state.indexed || 0,
    skipped: state.skipped || 0,
    errors: state.errors || 0,
    queueRemaining: q.length,
  };
}

app.post("/api/drive/sync", async (req, res) => {
  try {
    const folderId = req.body?.folderId || SYSTEM_FOLDER_ID;
    const batchFiles = Number(req.body?.batchFiles || process.env.DRIVE_SYNC_BATCH_FILES || 10);

    if (DRIVE_SYNC_RUNNING) {
      return res.status(409).json({ ok: false, error: "Sync ya está corriendo" });
    }

    DRIVE_SYNC_RUNNING = true;

    // ✅ Responde inmediato (PowerShell ya no se corta)
    res.status(202).json({
      ok: true,
      started: true,
      folderId,
      batchFiles,
      message: "Sync started",
    });

    // ✅ Background
    setImmediate(async () => {
      try {
        const out = await syncDriveBatch({ folderId, batchFiles });
        console.log("✅ Drive sync batch terminado:", {
          done: out?.done,
          queueRemaining: out?.queueRemaining,
          result: out?.result,
          state: compactStateForApi(out?.state),
        });
      } catch (e) {
        console.error("🔥 SYNC background error:", e);
      } finally {
        DRIVE_SYNC_RUNNING = false;
      }
    });
  } catch (e) {
    DRIVE_SYNC_RUNNING = false;
    console.error("SYNC error:", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});


app.post("/api/drive/sync/reset", async (req, res) => {
  try {
    const folderId = req.body?.folderId || SYSTEM_FOLDER_ID;
    const out = await resetDriveSyncState(folderId);
    return res.json(out);
  } catch (e) {
    console.error("RESET error:", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/api/drive/sync/state", async (req, res) => {
  try {
    const folderId = req.query?.folderId || SYSTEM_FOLDER_ID;
    const st = await getDriveSyncState(folderId);

    // compactado para no devolver queue gigante
    const q = Array.isArray(st.queue) ? st.queue : [];
    return res.json({
      ok: true,
      folderId,
      state: {
        done: !!st.done,
        scannedFolders: st.scannedFolders || 0,
        scannedFiles: st.scannedFiles || 0,
        indexed: st.indexed || 0,
        skipped: st.skipped || 0,
        errors: st.errors || 0,
        queueRemaining: q.length,
      },
    });
  } catch (e) {
    console.error("STATE error:", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});


// --------------------
// CHAT (RAG + OpenAI)
// --------------------
app.post("/api/chat", async (req, res) => {
  try {
    const { message, id_persona, tipo_chat = "texto", titulo = null, save = false } = req.body || {};

    if (!message || typeof message !== "string") {
      return res.status(400).json({ ok: false, error: "Falta 'message' (string) en el body" });
    }

    // -------- RAG gating (casuales vs documentales) --------
    let context = "";
    let sources = [];
    let bestSimilarity = null;

    const DISABLE_FOR_SMALL = (process.env.RAG_DISABLE_FOR_SMALL_QUERIES || "true") === "true";
    const MIN_QUERY_CHARS = Number(process.env.RAG_MIN_QUERY_CHARS || 25);

    // regex para bloquear docs sensibles (se aplica en SQL via rag.js)
    const BLOCKLIST_REGEX =
      process.env.RAG_BLOCKLIST_REGEX || "contrasen|password|clave|secret|api[_-]?key|token";

    const msg = (message || "").trim();
    const looksCasual =
      msg.length < MIN_QUERY_CHARS ||
      /^(hola|buenas|hey|gracias|ok|listo|dale|perfecto|bien|qué tal)\b/i.test(msg);

    const shouldUseRag = !!SYSTEM_FOLDER_ID && !(DISABLE_FOR_SMALL && looksCasual);

    if (shouldUseRag) {
      const out = await retrieveContext({
        folderId: SYSTEM_FOLDER_ID,
        query: msg,
        blocklistRegex: BLOCKLIST_REGEX,
      });

      context = out.context;
      sources = out.sources;
      bestSimilarity = out.bestSimilarity;
    }

    // -------- Prompt --------
    const messages = [
      {
        role: "system",
        content:
          "Eres RinkBot 🐯. Responde claro y profesional. " +
          "Si hay CONTEXTO DOCUMENTAL, responde SOLO con base en él y menciona el nombre del documento cuando afirmes datos. " +
          "Si el contexto no trae la info suficiente, dilo explícitamente y NO inventes.",
      },
      ...(context
        ? [{ role: "system", content: "CONTEXTO DOCUMENTAL (prioritario):\n" + context }]
        : []),
      { role: "user", content: msg },
    ];

    const r = await client.chat.completions.create({
      model: MODEL,
      messages,
    });

    const reply = r.choices?.[0]?.message?.content || "";

    // -------- Guardar chat --------
let saved = null;

if (save === true) {
  if (!id_persona) {
    return res
      .status(400)
      .json({ ok: false, error: "Para guardar chat necesitas 'id_persona'." });
  }

  // ✅ si el frontend manda chat_json (historial), guardamos eso tal cual
  const incomingChatJson = req.body?.chat_json;

  // Si no viene chat_json, caemos al formato antiguo (question/answer)
  const payloadToSave = incomingChatJson ?? {
    question: msg,
    answer: reply,
    sources,
    bestSimilarity,
    createdAt: new Date().toISOString(),
  };

  saved = await createChat({
    id_persona,
    tipo_chat,
    titulo,
    modelo_llm: MODEL,
    chat_json: payloadToSave,
    favorito: false,
  });
}


    // -------- Append fuentes al reply (opcional) --------
    const appendSources = (process.env.CHAT_APPEND_SOURCES || "false") === "true";
    const maxSourcesToShow = Number(process.env.CHAT_MAX_SOURCES_TO_SHOW || 3);

    let finalReply = reply;

    if (appendSources && sources?.length) {
      const top = sources.slice(0, maxSourcesToShow);
      const srcLines = top
        .map((s, i) => {
          const name = s?.name || s?.drive_file_id;
          const sim = Number(s?.similarity || 0).toFixed(2);
          const link = s?.web_view_link || "";
          return `${i + 1}) ${name} (sim ${sim})${link ? ` — ${link}` : ""}`;
        })
        .join("\n");

      finalReply = `${reply}\n\nFuentes:\n${srcLines}`;
    }

    return res.json({
      ok: true,
      reply: finalReply,
      sources, // útil para frontend/depuración
      bestSourceSimilarity: sources?.[0]?.similarity ?? null,
      bestSimilarity,
      saved,
    });
  } catch (e) {
    console.error("CHAT error:", e);
    return res.status(500).json({ ok: false, error: "Error al conectar con OpenAI" });
  }
});


// --------------------
// CHATS (LIST/GET)
// --------------------
app.get("/api/chats", async (req, res) => {
  try {
    const id_persona = Number(req.query?.id_persona);
    const limit = Number(req.query?.limit || 20);
    if (!id_persona) return res.status(400).json({ ok: false, error: "Falta id_persona" });

    const chats = await listChats({ id_persona, limit });
    return res.json({ ok: true, chats });
  } catch (e) {
    console.error("LIST CHATS error:", e);
    return res.status(500).json({ ok: false, error: "Error listando chats" });
  }
});

app.get("/api/chats/:id_chat", async (req, res) => {
  try {
    const id_persona = Number(req.query?.id_persona);
    const id_chat = Number(req.params?.id_chat);
    if (!id_persona || !id_chat) return res.status(400).json({ ok: false, error: "Falta id_persona o id_chat" });

    const chat = await getChat({ id_persona, id_chat });
    if (!chat) return res.status(404).json({ ok: false, error: "Chat no encontrado" });

    return res.json({ ok: true, chat });
  } catch (e) {
    console.error("GET CHAT error:", e);
    return res.status(500).json({ ok: false, error: "Error obteniendo chat" });
  }
});

app.patch("/api/chats/:id_chat/favorite", async (req, res) => {
  try {
    const id_persona = Number(req.body?.id_persona);
    const id_chat = Number(req.params?.id_chat);
    const favorito = req.body?.favorito;

    if (!id_persona || !id_chat || typeof favorito !== "boolean") {
      return res.status(400).json({
        ok: false,
        error: "Body requerido: { id_persona: number, favorito: boolean }",
      });
    }

    const out = await setChatFavorite({ id_persona, id_chat, favorito });
    if (!out) return res.status(404).json({ ok: false, error: "Chat no encontrado" });

    return res.json({ ok: true, chat: out });
  } catch (e) {
    console.error("FAVORITE CHAT error:", e);
    return res.status(500).json({ ok: false, error: "Error actualizando favorito" });
  }
});

// --------------------
// CHATS (CREATE - SIN OPENAI)
// --------------------
app.post("/api/chats", async (req, res) => {
  try {
    const {
      id_persona,
      tipo_chat = "texto",
      titulo = null,
      modelo_llm = null,
      chat_json,
      favorito = false,
    } = req.body || {};

    if (!id_persona) {
      return res.status(400).json({ ok: false, error: "Falta id_persona" });
    }
    if (!chat_json) {
      return res.status(400).json({ ok: false, error: "Falta chat_json" });
    }

    const saved = await createChat({
      id_persona,
      tipo_chat,
      titulo,
      modelo_llm,
      chat_json,
      favorito: !!favorito,
    });

    return res.json({ ok: true, saved });
  } catch (e) {
    console.error("CREATE CHAT error:", e);
    return res.status(500).json({ ok: false, error: "Error creando chat" });
  }
});

app.delete("/api/chats/:id_chat", async (req, res) => {
  try {
    const id_persona = Number(req.query?.id_persona); // 👈 igual que GET detail
    const id_chat = Number(req.params?.id_chat);

    if (!id_persona || !id_chat) {
      return res.status(400).json({ ok: false, error: "Falta id_persona o id_chat" });
    }

    const out = await deleteChat({ id_persona, id_chat });
    if (!out) return res.status(404).json({ ok: false, error: "Chat no encontrado" });

    return res.json({ ok: true, deleted: out });
  } catch (e) {
    console.error("DELETE CHAT error:", e);
    return res.status(500).json({ ok: false, error: "Error eliminando chat" });
  }
});

// --------------------
// SETTINGS
// --------------------
app.get("/api/settings", (req, res) => {
  res.json({
    provider: "openai",
    model: MODEL,
    embeddingModel: process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small",
    folderIdConfigured: !!SYSTEM_FOLDER_ID,
  });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Backend listening on port ${PORT}`);
  console.log(`Model: ${MODEL}`);
  console.log(`SYSTEM_FOLDER_ID: ${SYSTEM_FOLDER_ID ? "OK" : "NO CONFIGURADO"}`);
});
