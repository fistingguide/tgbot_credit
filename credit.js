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
	const star = msgCount + photoCount + videoCount;
	return { msgCount, photoCount, videoCount, star };
}

async function ensureSchema(env) {
	const table = getCreditTable(env);
	await env.DB.prepare(
		`CREATE TABLE IF NOT EXISTS ${table} (` +
			"user_id TEXT NOT NULL PRIMARY KEY," +
			"user_handle TEXT," +
			"x_handle TEXT," +
			"msg_count INTEGER NOT NULL DEFAULT 0," +
			"photo_count INTEGER NOT NULL DEFAULT 0," +
			"video_count INTEGER NOT NULL DEFAULT 0," +
			"star INTEGER NOT NULL DEFAULT 0," +
			"updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP" +
			")"
	).run();

	const columnsResult = await env.DB.prepare(`PRAGMA table_info(${table})`).all();
	const existingColumns = new Set(
		(Array.isArray(columnsResult?.results) ? columnsResult.results : []).map((row) => String(row?.name || ""))
	);
	const hasUsername = existingColumns.has("username");

	if (!existingColumns.has("user_handle")) {
		await env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN user_handle TEXT`).run();
	}
	if (!existingColumns.has("x_handle")) {
		await env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN x_handle TEXT`).run();
	}
	if (!existingColumns.has("star")) {
		await env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN star INTEGER NOT NULL DEFAULT 0`).run();
	}

	if (hasUsername) {
		await env.DB.prepare(
			`UPDATE ${table} SET user_handle = TRIM(COALESCE(username, '')) ` +
				"WHERE (user_handle IS NULL OR TRIM(user_handle) = '') AND TRIM(COALESCE(username, '')) <> ''"
		).run();
	}

	if (existingColumns.has("list_star")) {
		await env.DB.prepare(
			`UPDATE ${table} SET star = COALESCE(list_star, COALESCE(msg_count, 0) + COALESCE(photo_count, 0) + COALESCE(video_count, 0)) ` +
				"WHERE COALESCE(star, 0) = 0"
		).run();
	} else {
		await env.DB.prepare(
			`UPDATE ${table} SET star = COALESCE(msg_count, 0) + COALESCE(photo_count, 0) + COALESCE(video_count, 0) ` +
				"WHERE COALESCE(star, 0) = 0"
		).run();
	}
}

async function getCreditSchema(env) {
	const table = getCreditTable(env);
	const columnsResult = await env.DB.prepare(`PRAGMA table_info(${table})`).all();
	const columns = new Set((Array.isArray(columnsResult?.results) ? columnsResult.results : []).map((row) => String(row?.name || "")));
	return {
		table,
		hasChatId: columns.has("chat_id"),
		hasUsername: columns.has("username"),
		hasListStar: columns.has("list_star"),
	};
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
	const from = message?.from;
	if (!from?.id || from?.is_bot) return;

	const { msgCount, photoCount, videoCount, star } = buildIncrements(message);
	if (msgCount === 0 && photoCount === 0 && videoCount === 0 && star === 0) return;

	const schema = await getCreditSchema(env);
	if (schema.hasChatId) {
		const chatId = message?.chat?.id;
		if (!chatId) return;
		const sql =
			`INSERT INTO ${schema.table} ` +
			"(chat_id, user_id, user_handle, x_handle, msg_count, photo_count, video_count, star, updated_at) " +
			"VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP) " +
			"ON CONFLICT(chat_id, user_id) DO UPDATE SET " +
			"user_handle = excluded.user_handle, " +
			"x_handle = CASE WHEN TRIM(COALESCE(excluded.x_handle, '')) <> '' THEN excluded.x_handle ELSE x_handle END, " +
			"msg_count = msg_count + excluded.msg_count, " +
			"photo_count = photo_count + excluded.photo_count, " +
			"video_count = video_count + excluded.video_count, " +
			"star = star + excluded.star, " +
			"updated_at = CURRENT_TIMESTAMP";
		await env.DB.prepare(sql)
			.bind(String(chatId), String(from.id), String(from.username || "").trim(), "", msgCount, photoCount, videoCount, star)
			.run();
		return;
	}

	const sql =
		`INSERT INTO ${schema.table} ` +
		"(user_id, user_handle, x_handle, msg_count, photo_count, video_count, star, updated_at) " +
		"VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP) " +
		"ON CONFLICT(user_id) DO UPDATE SET " +
		"user_handle = excluded.user_handle, " +
		"x_handle = CASE WHEN TRIM(COALESCE(excluded.x_handle, '')) <> '' THEN excluded.x_handle ELSE x_handle END, " +
		"msg_count = msg_count + excluded.msg_count, " +
		"photo_count = photo_count + excluded.photo_count, " +
		"video_count = video_count + excluded.video_count, " +
		"star = star + excluded.star, " +
		"updated_at = CURRENT_TIMESTAMP";
	await env.DB.prepare(sql)
		.bind(String(from.id), String(from.username || "").trim(), "", msgCount, photoCount, videoCount, star)
		.run();
}

function displayName(row) {
	const userHandle = String(row?.user_handle || "").trim();
	if (userHandle) return `@${userHandle}`;
	return `User ${row?.user_id || "Unknown"}`;
}

function formatCredit(rows) {
	if (!rows.length) {
		return "No activity records found yet.";
	}

	const lines = ["<b>Group Credit Leaderboard</b>", "--------------------"];
	for (let i = 0; i < rows.length; i += 1) {
		const row = rows[i];
		const name = escapeHtml(displayName(row));
		const msg = Number(row?.msg_count || 0);
		const photo = Number(row?.photo_count || 0);
		const video = Number(row?.video_count || 0);
		const xHandle = escapeHtml(String(row?.x_handle || "").trim());
		const total = Number(row?.star || 0);
		lines.push(`${i + 1}. <b>${name}</b>`);
		lines.push(`Msg: <b>${msg}</b>  Photo: <b>${photo}</b>  Video: <b>${video}</b>  Star: <b>${total}</b>${xHandle ? `  X: <b>@${xHandle}</b>` : ""}`);
	}
	lines.push("--------------------");
	return lines.join("\n");
}

async function sendCredit(env, chatId) {
	const schema = await getCreditSchema(env);
	const handleExpr = schema.hasUsername
		? "COALESCE(MAX(NULLIF(TRIM(COALESCE(user_handle, '')), '')), MAX(NULLIF(TRIM(COALESCE(username, '')), '')))"
		: "MAX(NULLIF(TRIM(COALESCE(user_handle, '')), ''))";
	const starExpr = schema.hasListStar ? "COALESCE(star, list_star, 0)" : "COALESCE(star, 0)";
	const sql =
		`SELECT user_id, ${handleExpr} AS user_handle, MAX(NULLIF(TRIM(COALESCE(x_handle, '')), '')) AS x_handle, ` +
		`SUM(COALESCE(msg_count, 0)) AS msg_count, SUM(COALESCE(photo_count, 0)) AS photo_count, ` +
		`SUM(COALESCE(video_count, 0)) AS video_count, SUM(${starExpr}) AS star, MAX(updated_at) AS updated_at ` +
		`FROM ${schema.table} GROUP BY user_id ` +
		"ORDER BY star DESC, updated_at DESC " +
		"LIMIT 50";
	const result = await env.DB.prepare(sql).all();
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

	try {
		await upsertCredit(env, message);
	} catch (err) {
		console.error("upsertCredit failed:", err);
	}

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