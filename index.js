"use strict";

/**
 * Telegram query bot on Cloudflare Workers (webhook mode).
 *
 * Required env vars:
 * - CREDIT_TG_BOT_TOKEN
 * - CREDIT_PROFILE_API_BASE
 * - DB (D1 binding)
 *
 * Optional env vars:
 * - WEBHOOK_PATH (default: /webhook)
 * - TELEGRAM_WEBHOOK_SECRET (validate header x-telegram-bot-api-secret-token)
 * - CHAT_MODE_TTL_SEC (default: 3600)
 */

function normalizeInput(value) {
	return String(value || "").trim().replace(/^@+/, "");
}

function escapeHtml(value) {
	return String(value || "")
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

function requireEnv(env, key) {
	const value = String(env[key] || "").trim();
	if (!value) {
		throw new Error(`Missing env: ${key}`);
	}
	return value;
}

function getWebhookPath(env) {
	const path = String(env.WEBHOOK_PATH || "/webhook").trim();
	return path.startsWith("/") ? path : `/${path}`;
}

async function getChatMode(env, chatId) {
	const now = Math.floor(Date.now() / 1000);
	const row = await env.DB.prepare("SELECT mode, expires_at FROM chat_modes WHERE chat_id = ?")
		.bind(String(chatId))
		.first();
	if (!row) return null;
	if (Number(row.expires_at || 0) <= now) {
		await env.DB.prepare("DELETE FROM chat_modes WHERE chat_id = ?").bind(String(chatId)).run();
		return null;
	}
	return String(row.mode || "");
}

async function setChatMode(env, chatId, mode) {
	const ttl = Number(env.CHAT_MODE_TTL_SEC || 3600);
	const expiresAt = Math.floor(Date.now() / 1000) + ttl;
	await env.DB.prepare(
		"INSERT INTO chat_modes (chat_id, mode, expires_at, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP) " +
			"ON CONFLICT(chat_id) DO UPDATE SET mode = excluded.mode, expires_at = excluded.expires_at, updated_at = CURRENT_TIMESTAMP"
	)
		.bind(String(chatId), String(mode), expiresAt)
		.run();
}

async function clearChatMode(env, chatId) {
	await env.DB.prepare("DELETE FROM chat_modes WHERE chat_id = ?").bind(String(chatId)).run();
}

async function ensureSchema(env) {
	await env.DB.prepare(
		"CREATE TABLE IF NOT EXISTS chat_modes (" +
			"chat_id TEXT PRIMARY KEY," +
			"mode TEXT NOT NULL," +
			"expires_at INTEGER NOT NULL," +
			"updated_at TEXT NOT NULL" +
			")"
	).run();
}

async function tg(env, method, payload) {
	const token = requireEnv(env, "CREDIT_TG_BOT_TOKEN");
	const api = `https://api.telegram.org/bot${token}`;

	const res = await fetch(`${api}/${method}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(payload),
	});
	const data = await res.json().catch(() => null);
	if (!res.ok || !data || data.ok !== true) {
		throw new Error(`Telegram API failed: ${method}`);
	}
	return data.result;
}

async function sendModeButtons(env, chatId) {
	return tg(env, "sendMessage", {
		chat_id: chatId,
		text: "请选择查询方式：",
		reply_markup: {
			inline_keyboard: [
				[
					{ text: "根据 X 查询", callback_data: "mode_x" },
					{ text: "根据 Telegram 查询", callback_data: "mode_tg" },
				],
			],
		},
	});
}

async function queryByX(env, handleInput) {
	const handle = normalizeInput(handleInput);
	if (!handle) return [];

	const base = requireEnv(env, "CREDIT_PROFILE_API_BASE").replace(/\/+$/, "");
	const url = `${base}/api/profiles?handle=${encodeURIComponent("@" + handle)}`;
	const res = await fetch(url);
	if (!res.ok) throw new Error("Profile API request failed");
	const data = await res.json();
	const rows = Array.isArray(data.results) ? data.results : [];
	return rows.filter((row) => normalizeInput(row.handle).toLowerCase() === handle.toLowerCase());
}

async function queryByTelegram(env, tgInput) {
	const target = normalizeInput(tgInput).toLowerCase();
	if (!target) return [];

	const base = requireEnv(env, "CREDIT_PROFILE_API_BASE").replace(/\/+$/, "");
	const res = await fetch(`${base}/api/profiles`);
	if (!res.ok) throw new Error("Profile API request failed");
	const data = await res.json();
	const rows = Array.isArray(data.results) ? data.results : [];
	return rows.filter((row) => normalizeInput(row.telegram).toLowerCase() === target);
}

function formatRow(row) {
	const name = escapeHtml(row.name || "Unnamed");
	const handle = escapeHtml(row.handle || "");
	const telegram = escapeHtml(row.telegram || "");
	const district = escapeHtml(row.district || row.city || "Unknown");
	const region = escapeHtml(row.region || row.province || "Unknown");
	const country = escapeHtml(row.country || "Unknown");
	const bio = escapeHtml(row.bio || "");
	const profileUrl = escapeHtml(row.profile_url || "");

	const lines = [
		`<b>${name}</b>`,
		handle ? `X: ${handle}` : "",
		telegram ? `Telegram: @${telegram}` : "Telegram: (empty)",
		`Location: ${district} / ${region} / ${country}`,
		profileUrl ? `Profile: ${profileUrl}` : "",
		bio ? `Bio: ${bio}` : "",
	].filter(Boolean);
	return lines.join("\n");
}

async function handleStart(env, chatId) {
	await clearChatMode(env, chatId);
	await tg(env, "sendMessage", {
		chat_id: chatId,
		text: "发送 /query 开始查询。",
	});
}

async function handleQuery(env, chatId) {
	await clearChatMode(env, chatId);
	await sendModeButtons(env, chatId);
}

async function handleCallback(env, callbackQuery) {
	const chatId = callbackQuery?.message?.chat?.id;
	const data = String(callbackQuery?.data || "");
	if (!chatId) return;

	if (data === "mode_x") {
		await setChatMode(env, chatId, "x");
		await tg(env, "answerCallbackQuery", { callback_query_id: callbackQuery.id, text: "已切换到 X 查询" });
		await tg(env, "sendMessage", { chat_id: chatId, text: "请输入 X 账号（例如 @demo 或 demo）" });
		return;
	}

	if (data === "mode_tg") {
		await setChatMode(env, chatId, "tg");
		await tg(env, "answerCallbackQuery", { callback_query_id: callbackQuery.id, text: "已切换到 Telegram 查询" });
		await tg(env, "sendMessage", { chat_id: chatId, text: "请输入 Telegram 账号（例如 @demo 或 demo）" });
		return;
	}

	await tg(env, "answerCallbackQuery", { callback_query_id: callbackQuery.id });
}

async function handleMessage(env, message) {
	const chatId = message?.chat?.id;
	const text = String(message?.text || "").trim();
	const command = text.split(/\s+/)[0].toLowerCase();
	const isStartCmd = command === "/start" || command.startsWith("/start@");
	const isHelpCmd = command === "/help" || command.startsWith("/help@");
	const isQueryCmd = command === "/query" || command.startsWith("/query@");
	if (!chatId || !text) return;

	if (isStartCmd || isHelpCmd) {
		await handleStart(env, chatId);
		return;
	}
	if (isQueryCmd) {
		await handleQuery(env, chatId);
		return;
	}

	const mode = await getChatMode(env, chatId);
	if (!mode) {
		await tg(env, "sendMessage", { chat_id: chatId, text: "请先发送 /query 并点击查询方式。" });
		return;
	}

	try {
		const rows = mode === "x" ? await queryByX(env, text) : await queryByTelegram(env, text);
		if (rows.length === 0) {
			await tg(env, "sendMessage", { chat_id: chatId, text: "没有找到对应账号。" });
			return;
		}
		if (rows.length > 1) {
			await tg(env, "sendMessage", { chat_id: chatId, text: "匹配到多个账号，请输入更精确的账号。" });
			return;
		}
		await tg(env, "sendMessage", {
			chat_id: chatId,
			text: formatRow(rows[0]),
			parse_mode: "HTML",
			disable_web_page_preview: true,
		});
	} catch (err) {
		console.error(err);
		await tg(env, "sendMessage", { chat_id: chatId, text: "查询失败，请稍后重试。" });
	}
}

function isWebhookAuthorized(env, request) {
	const expected = String(env.TELEGRAM_WEBHOOK_SECRET || "").trim();
	if (!expected) return true;
	const provided = request.headers.get("x-telegram-bot-api-secret-token") || "";
	return expected === provided;
}

export default {
	async fetch(request, env) {
		try {
			requireEnv(env, "CREDIT_TG_BOT_TOKEN");
			requireEnv(env, "CREDIT_PROFILE_API_BASE");
			if (!env.DB) {
				throw new Error("Missing D1 binding: DB");
			}
			await ensureSchema(env);
		} catch (err) {
			console.error(err);
			return new Response("Config error", { status: 500 });
		}

		const url = new URL(request.url);
		const webhookPath = getWebhookPath(env);

		if (request.method === "GET" && url.pathname === "/healthz") {
			return new Response("ok", { status: 200 });
		}

		if (request.method !== "POST" || url.pathname !== webhookPath) {
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
			if (update.callback_query) {
				await handleCallback(env, update.callback_query);
			}
			if (update.message) {
				await handleMessage(env, update.message);
			}
		} catch (err) {
			console.error("Update handling failed:", err);
		}

		return new Response("ok", { status: 200 });
	},
};
