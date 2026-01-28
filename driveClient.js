import path from "path";
import { fileURLToPath } from "url";
import { google } from "googleapis";
import dotenv from "dotenv";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SCOPES = ["https://www.googleapis.com/auth/drive.readonly"];
const KEYFILE_PATH = path.join(__dirname, "config", "service-account.json");

export function createDriveClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: KEYFILE_PATH,
    scopes: SCOPES,
  });
  return google.drive({ version: "v3", auth });
}

export async function listFolder(drive, folderId, pageToken = null) {
  const res = await drive.files.list({
    q: `'${folderId}' in parents and trashed = false`,
    pageSize: 200,
    pageToken: pageToken || undefined,
    fields:
      "nextPageToken, files(id,name,mimeType,webViewLink,modifiedTime,md5Checksum,size)",
  });

  return {
    files: res.data.files || [],
    nextPageToken: res.data.nextPageToken || null,
  };
}

export async function downloadBuffer(drive, fileId) {
  const res = await drive.files.get(
    { fileId, alt: "media" },
    { responseType: "arraybuffer" }
  );
  return Buffer.from(res.data);
}

export async function exportBuffer(drive, fileId, mimeType) {
  const res = await drive.files.export(
    { fileId, mimeType },
    { responseType: "arraybuffer" }
  );
  return Buffer.from(res.data);
}
