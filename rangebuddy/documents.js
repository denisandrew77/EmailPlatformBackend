import { randomUUID } from "node:crypto";
import { RangeBuddyError, checkDatabaseError } from "./errors.js";

const bucketName = "rangebuddy-van-documents";
const tableName = "RangeBuddyVanDocuments";

function fileFormat(buffer) {
    if (!Buffer.isBuffer(buffer) || !buffer.length) return null;
    if (buffer.subarray(0, 5).toString() === "%PDF-") return { mime: "application/pdf", extension: "pdf" };
    if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
        return { mime: "image/png", extension: "png" };
    }
    if (buffer.length >= 3 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) {
        return { mime: "image/jpeg", extension: "jpg" };
    }
    return null;
}

function originalName(header, extension) {
    if (typeof header !== "string" || !header) return `document.${extension}`;
    let name;
    try { name = decodeURIComponent(header); }
    catch { throw new RangeBuddyError(400, "Invalid file name"); }
    name = name.replace(/[\\/\u0000-\u001f\u007f]/g, "_").trim();
    if (!name || name.length > 180) throw new RangeBuddyError(400, "Invalid file name");
    return name;
}

export const createRangeBuddyDocumentService = (database) => ({
    async list(vanId) {
        const { data, error } = await database.from(tableName)
            .select("document_type,original_name,mime_type,uploaded_at").eq("van_id", vanId);
        checkDatabaseError(error);
        return data;
    },

    async upload(vanId, type, body, declaredType, nameHeader) {
        const format = fileFormat(body);
        if (!format || body.length > 5 * 1024 * 1024) {
            throw new RangeBuddyError(415, "Upload a PDF, PNG or JPEG file up to 5 MB");
        }
        const mime = String(declaredType || "").split(";")[0].toLowerCase();
        if (mime && mime !== "application/octet-stream" && mime !== format.mime) {
            throw new RangeBuddyError(415, "File content does not match its type");
        }
        const name = originalName(nameHeader, format.extension);
        const { data: van, error: vanError } = await database.from("Vans")
            .select("id").eq("id", vanId).maybeSingle();
        checkDatabaseError(vanError);
        if (!van) throw new RangeBuddyError(404, "Van not found", "RB_VAN_NOT_FOUND");

        const { data: previous, error: readError } = await database.from(tableName)
            .select("storage_path").eq("van_id", vanId).eq("document_type", type).maybeSingle();
        checkDatabaseError(readError);

        const path = `${vanId}/${type}/${randomUUID()}.${format.extension}`;
        const storage = database.storage.from(bucketName);
        const { error: uploadError } = await storage.upload(path, body, {
            contentType: format.mime, upsert: false,
        });
        if (uploadError) throw new RangeBuddyError(502, "Unable to upload the document");

        const { data, error } = await database.from(tableName).upsert({
            van_id: vanId, document_type: type, storage_path: path,
            original_name: name, mime_type: format.mime, uploaded_at: new Date().toISOString(),
        }, { onConflict: "van_id,document_type" })
            .select("document_type,original_name,mime_type,uploaded_at").single();
        if (error) {
            await storage.remove([path]);
            checkDatabaseError(error);
        }
        if (previous?.storage_path) {
            const { error: removeError } = await storage.remove([previous.storage_path]);
            if (removeError) console.error("Unable to remove replaced RangeBuddy document");
        }
        return data;
    },

    async signedUrl(vanId, type) {
        const { data, error } = await database.from(tableName)
            .select("storage_path").eq("van_id", vanId).eq("document_type", type).maybeSingle();
        checkDatabaseError(error);
        if (!data) throw new RangeBuddyError(404, "Document not found", "RB_DOCUMENT_NOT_FOUND");
        const { data: signed, error: signError } = await database.storage.from(bucketName)
            .createSignedUrl(data.storage_path, 60);
        if (signError || !signed?.signedUrl) throw new RangeBuddyError(502, "Unable to open the document");
        return { url: signed.signedUrl };
    },
});
