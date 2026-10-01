import fs from "node:fs";
import path from "node:path";

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getDatabase } from "firebase-admin/database";

const BACKUP_PATH = "/api/backup";

function requireEnv(name) {
    const value = process.env[name];

    if (!value) {
        throw new Error(`${name} is not configured`);
    }

    return value;
}

function parseServiceAccount(raw) {
    let account;

    try {
        account = JSON.parse(raw);

        if (typeof account === "string") {
            account = JSON.parse(account);
        }
    } catch {
        throw new Error("Firebase service account is not valid JSON");
    }

    const { project_id, client_email, private_key } = account ?? {};

    if (!project_id || !client_email || !private_key) {
        throw new Error("Firebase service account is missing required fields");
    }

    return { ...account, private_key: private_key.replace(/\\n/g, "\n") };
}

function loadServiceAccount() {
    const {
        FIREBASE_SERVICE_ACCOUNT_JSON: json,
        FIREBASE_SERVICE_ACCOUNT_FILE: file
    } = process.env;

    if (!json && !file) {
        throw new Error(
            "Set FIREBASE_SERVICE_ACCOUNT_JSON or FIREBASE_SERVICE_ACCOUNT_FILE"
        );
    }

    return parseServiceAccount(
        json ?? fs.readFileSync(path.resolve(file), "utf8")
    );
}

function getDB() {
    const app =
        getApps()[0] ??
        initializeApp({
            credential: cert(loadServiceAccount()),
            databaseURL: requireEnv("FIREBASE_DATABASE_URL")
        });

    return getDatabase(app);
}

async function sendToTelegram(fileName, content) {
    const token = requireEnv("TELEGRAM_BOT_TOKEN");
    const chatId = requireEnv("TELEGRAM_CHAT_ID");

    const form = new FormData();
    form.append("chat_id", chatId);
    form.append(
        "document",
        new Blob([content], { type: "application/json" }),
        fileName
    );

    const response = await fetch(
        `https://api.telegram.org/bot${token}/sendDocument`,
        { method: "POST", body: form }
    );
    const result = await response.json().catch(() => null);

    if (!response.ok || !result?.ok) {
        throw new Error(
            `Telegram API error (HTTP ${response.status}): ${
                result?.description ?? "unexpected response"
            }`
        );
    }
}

async function createBackup() {
    const snapshot = await getDB().ref("/").once("value");

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const fileName = `firebase-backup-${timestamp}.json`;

    await sendToTelegram(fileName, JSON.stringify(snapshot.val(), null, 2));

    return {
        success: true,
        message: "Firebase RTDB backup sent to Telegram",
        file: fileName
    };
}

async function handleBackup(request) {
    const { pathname } = new URL(request.url);

    if (pathname.replace(/\/+$/, "") !== BACKUP_PATH) {
        return Response.json(
            { success: false, error: "Not found" },
            { status: 404 }
        );
    }

    try {
        return Response.json(await createBackup());
    } catch (error) {
        console.error("Backup failed:", error);

        return Response.json(
            { success: false, error: error.message },
            { status: 500 }
        );
    }
}

export const GET = handleBackup;
export const POST = handleBackup;