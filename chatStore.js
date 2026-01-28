// Backend/chatStore.js
import pool from "./db.js";

export async function createChat({
  id_persona,
  tipo_chat = "texto",
  titulo = null,
  modelo_llm = null,
  chat_json,
  favorito = false,
}) {
  const r = await pool.query(
    `insert into public.chat (id_persona, tipo_chat, titulo, modelo_llm, chat_json, favorito)
     values ($1,$2,$3,$4,$5::jsonb,$6)
     returning id_chat, created_at`,
    [id_persona, tipo_chat, titulo, modelo_llm, JSON.stringify(chat_json), favorito]
  );
  return r.rows[0];
}

export async function listChats({ id_persona, limit = 20 }) {
  const r = await pool.query(
    `select id_chat, tipo_chat, titulo, modelo_llm, favorito, created_at
     from public.chat
     where id_persona = $1
     order by created_at desc
     limit $2`,
    [id_persona, limit]
  );
  return r.rows || [];
}

export async function getChat({ id_persona, id_chat }) {
  const r = await pool.query(
    `select id_chat, tipo_chat, titulo, modelo_llm, chat_json, favorito, created_at
     from public.chat
     where id_persona = $1 and id_chat = $2
     limit 1`,
    [id_persona, id_chat]
  );
  return r.rows[0] || null;
}

export async function setChatFavorite({ id_persona, id_chat, favorito }) {
  const r = await pool.query(
    `update public.chat
     set favorito = $3
     where id_persona = $1 and id_chat = $2
     returning id_chat, favorito, created_at`,
    [id_persona, id_chat, !!favorito]
  );
  return r.rows[0] || null;
}

export async function deleteChat({ id_persona, id_chat }) {
  const r = await pool.query(
    `delete from public.chat
     where id_persona = $1 and id_chat = $2
     returning id_chat`,
    [id_persona, id_chat]
  );
  return r.rows[0] || null;
}
