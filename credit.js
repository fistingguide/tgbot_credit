"use strict";

/**
 * Group activity credit bot on Cloudflare Workers (webhook mode).
 *
 * Required env vars:
 * - TG_BOT_TOKEN or CREDIT_TG_BOT_TOKEN
 * - DB (D1 binding)
 *
 * Optional env vars:
 * - WEBHOOK_PATH (default accepts /webhook and /telegram)
 * - TELEGRAM_WEBHOOK_SECRET
 * - CREDIT_TABLE (default: group_user_credit)
 */

function escapeHtml(value) {
	return String(value || "")
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

function getBotToken(env) {
	const token = String(env.TG_BOT_TOKEN || env.CREDIT_TG_BOT_TOKEN || "").trim();
	if (!token) {
		throw new Error("Missing TG_BOT_TOKEN/CREDIT_TG_BOT_TOKEN in Worker env");
	}
	return token;
}

function getWebhookPaths(env) {
	const configured = String(env.WEBHOOK_PATH || "").trim();
	const normalizedConfigured = configured ? (configured.startsWith("/") ? configured : `/${configured}`) : "";
	const paths = ["/webhook", "/telegram"];
	if (normalizedConfigured && !paths.includes(normalizedConfigured)) {
		paths.push(normalizedConfigured);
	}
	return paths;
}

function getCreditTable(env) {
	const table = String(env.CREDIT_TABLE || "group_user_credit").trim();
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
		throw new Error("Invalid CREDIT_TABLE");
	}
	return table;
}

function isWebhookAuthorized(env, request) {
	const expected = String(env.TELEGRAM_WEBHOOK_SECRET || "").trim();
	if (!expected) return true;
	const provided = request.headers.get("x-telegram-bot-api-secret-token") || "";
	return expected === provided;
}

function normalizeCommand(text) {
	if (!text.startsWith("/")) return "";
	const firstToken = text.split(/\s+/, 1)[0].toLowerCase();
	const atIndex = firstToken.indexOf("@");
	return atIndex === -1 ? firstToken : firstToken.slice(0, atIndex);
}

function isGroupChat(chat) {
	const t = String(chat?.type || "");
	return t === "group" || t === "supergroup";
}

function buildIncrements(message) {
	const text = String(message?.text || "").trim();
	const isCreditCmd = normalizeCommand(text) === "/credit";

	const msgCount = text && !isCreditCmd ? 1 : 0;
	const photoCount = Array.isArray(message?.photo) && message.photo.length > 0 ? 1 : 0;
	const videoCount = message?.video ? 1 : 0;
	return { msgCount, photoCount, videoCount };
}

async function ensureSchema(env) {
	const table = getCreditTable(env);
	await env.DB.prepare(
		`CREATE TABLE IF NOT EXISTS ${table} (` +
			"chat_id TEXT NOT NULL," +
			"user_id TEXT NOT NULL," +
			"username TEXT," +
			"first_name TEXT," +
			"last_name TEXT," +
			"msg_count INTEGER NOT NULL DEFAULT 0," +
			"photo_count INTEGER NOT NULL DEFAULT 0," +
			"video_count INTEGER NOT NULL DEFAULT 0," +
			"updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP," +
			"PRIMARY KEY (chat_id, user_id)" +
			")"
	).run();
}

async function tg(env, method, payload) {
	const token = getBotToken(env);
	const api = `https://api.telegram.org/bot${token}`;
	const res = await fetch(`${api}/${method}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(payload),
	});
	const data = await res.json().catch(() => null);
	if (!res.ok || !data || data.ok !== true) {
		throw new Error(`Telegram API failed: ${method}; status=${res.status}; body=${JSON.stringify(data)}`);
	}
	return data.result;
}

async function upsertCredit(env, message) {
	const chatId = message?.chat?.id;
	const from = message?.from;
	if (!chatId || !from?.id || from?.is_bot) return;

	const { msgCount, photoCount, videoCount } = buildIncrements(message);
	if (msgCount === 0 && photoCount === 0 && videoCount === 0) return;

	const table = getCreditTable(env);
	const sql =
		`INSERT INTO ${table} ` +
		"(chat_id, user_id, username, first_name, last_name, msg_count, photo_count, video_count, updated_at) " +
		"VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP) " +
		"ON CONFLICT(chat_id, user_id) DO UPDATE SET " +
		"username = excluded.username, " +
		"first_name = excluded.first_name, " +
		"last_name = excluded.last_name, " +
		"msg_count = msg_count + excluded.msg_count, " +
		"photo_count = photo_count + excluded.photo_count, " +
		"video_count = video_count + excluded.video_count, " +
		"updated_at = CURRENT_TIMESTAMP";

	await env.DB.prepare(sql)
		.bind(
			String(chatId),
			String(from.id),
			from.username || "",
			from.first_name || "",
			from.last_name || "",
			msgCount,
			photoCount,
			videoCount
		)
		.run();
}

function displayName(row) {
	const first = String(row?.first_name || "").trim();
	const last = String(row?.last_name || "").trim();
	const full = `${first} ${last}`.trim();
	if (full) return full;
	const username = String(row?.username || "").trim();
	if (username) return `@${username}`;
	return `User ${row?.user_id || "Unknown"}`;
}

function formatCredit(rows) {
	if (!rows.length) {
		return "No activity records found in this group yet.";
	}

	const lines = [
		"<b>📊 Group Credit Leaderboard</b>",
		"━━━━━━━━━━━━",
	];

	for (let i = 0; i < rows.length; i += 1) {
		const row = rows[i];
		const name = escapeHtml(displayName(row));
		const username = escapeHtml(String(row?.username || ""));
		const msg = Number(row?.msg_count || 0);
		const photo = Number(row?.photo_count || 0);
		const video = Number(row?.video_count || 0);
		const total = msg + photo + video;

		lines.push(`${i + 1}. 👤 <b>${name}</b>${username ? ` (@${username})` : ""}`);
		lines.push(`   💬 Msg: <b>${msg}</b>   🖼️ Photo: <b>${photo}</b>   🎬 Video: <b>${video}</b>   ⭐ Total: <b>${total}</b>`);
	}

	lines.push("━━━━━━━━━━━━");
	return lines.join("\n");
}

async function sendCredit(env, chatId) {
	const table = getCreditTable(env);
	const sql =
		`SELECT user_id, username, first_name, last_name, msg_count, photo_count, video_count FROM ${table} ` +
		"WHERE chat_id = ? " +
		"ORDER BY (msg_count + photo_count + video_count) DESC, updated_at DESC " +
		"LIMIT 50";
	const result = await env.DB.prepare(sql).bind(String(chatId)).all();
	const rows = Array.isArray(result?.results) ? result.results : [];

	await tg(env, "sendMessage", {
		chat_id: chatId,
		text: formatCredit(rows),
		parse_mode: "HTML",
	});
}

async function handleMessage(update, env) {
	const message = update?.message;
	if (!message) return;

	const chat = message?.chat;
	if (!isGroupChat(chat)) return;

	await upsertCredit(env, message);

	const text = String(message?.text || "").trim();
	const cmd = normalizeCommand(text);
	if (cmd === "/credit") {
		await sendCredit(env, chat.id);
	}
}

export default {
	async fetch(request, env) {
		try {
			getBotToken(env);
			if (!env.DB) {
				throw new Error("Missing D1 binding: DB");
			}
			getCreditTable(env);
			await ensureSchema(env);
		} catch (err) {
			console.error(err);
			return new Response(`Config error: ${String(err?.message || err)}`, { status: 500 });
		}

		const url = new URL(request.url);
		const webhookPaths = getWebhookPaths(env);

		if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/healthz")) {
			return new Response("ok", { status: 200 });
		}

		if (request.method !== "POST" || !webhookPaths.includes(url.pathname)) {
			return new Response("Not found", { status: 404 });
		}

		if (!isWebhookAuthorized(env, request)) {
			return new Response("Unauthorized", { status: 401 });
		}

		const update = await request.json().catch(() => null);
		if (!update) {
			return new Response("Bad request", { status: 400 });
		}

		try {
			await handleMessage(update, env);
		} catch (err) {
			console.error("Update handling failed:", err);
			return new Response(`Update handling failed: ${String(err?.message || err)}`, { status: 500 });
		}

		return new Response("ok", { status: 200 });
	},
};
