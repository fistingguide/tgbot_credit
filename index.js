"use strict";

/**
 * Telegram query bot on Cloudflare Workers (webhook mode).
 *
 * Required env vars:
 * - TG_BOT_TOKEN or CREDIT_TG_BOT_TOKEN
 * - DB (D1 binding)
 *
 * Optional env vars:
 * - WEBHOOK_PATH (default: /webhook)
 * - TELEGRAM_WEBHOOK_SECRET (validate header x-telegram-bot-api-secret-token)
 * - PROFILE_TABLE (default: profiles)
 * - CREDIT_TABLE (default: group_user_credit)
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

function getProfilesTable(env) {
	const table = String(env.PROFILE_TABLE || "profiles").trim();
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
		throw new Error("Invalid PROFILE_TABLE");
	}
	return table;
}

function getCreditTable(env) {
	const table = String(env.CREDIT_TABLE || "group_user_credit").trim();
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
		throw new Error("Invalid CREDIT_TABLE");
	}
	return table;
}

function normalizeCommand(text) {
	if (!String(text || "").startsWith("/")) return "";
	const firstToken = String(text || "").split(/\s+/, 1)[0].toLowerCase();
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

function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function scheduleDeleteMessage(env, ctx, chatId, messageId, delayMs = 20000) {
	if (!ctx || !chatId || !messageId) return;
	ctx.waitUntil(
		(async () => {
			await delay(delayMs);
			try {
				await tg(env, "deleteMessage", {
					chat_id: chatId,
					message_id: messageId,
				});
			} catch (err) {
				console.error("deleteMessage failed:", err);
			}
		})()
	);
}

async function sendModeButtons(env, chatId) {
	return tg(env, "sendMessage", {
		chat_id: chatId,
		text: "Choose a query method:",
		reply_markup: {
			inline_keyboard: [
				[
					{ text: "Search by X", callback_data: "mode_x" },
					{ text: "Search by Telegram", callback_data: "mode_tg" },
				],
			],
		},
	});
}

function buildPrompt(mode) {
	if (mode === "x") {
		return "[QUERY_MODE:x] Enter an X handle (e.g. @demo or demo)";
	}
	return "[QUERY_MODE:tg] Enter a Telegram username (e.g. @demo or demo)";
}

async function askForInput(env, chatId, mode) {
	return tg(env, "sendMessage", {
		chat_id: chatId,
		text: buildPrompt(mode),
		reply_markup: {
			force_reply: true,
			input_field_placeholder: mode === "x" ? "Type X handle" : "Type Telegram username",
		},
	});
}

function extractModeFromReply(message) {
	const repliedText = String(message?.reply_to_message?.text || "");
	const match = repliedText.match(/\[QUERY_MODE:(x|tg)\]/i);
	return match ? match[1].toLowerCase() : "";
}

function parseModeCommand(text) {
	const m = String(text || "").trim().match(/^\/(x|tg)(?:@\S+)?(?:\s+(.+))?$/i);
	if (!m) return null;
	return {
		mode: m[1].toLowerCase(),
		value: String(m[2] || "").trim(),
	};
}

async function ensureCreditSchema(env) {
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

	const lines = ["<b>📊 Group Credit Leaderboard</b>", "━━━━━━━━━━━━"];
	for (let i = 0; i < rows.length; i += 1) {
		const row = rows[i];
		const name = escapeHtml(displayName(row));
		const msg = Number(row?.msg_count || 0);
		const photo = Number(row?.photo_count || 0);
		const video = Number(row?.video_count || 0);
		const total = msg + photo * 3 + video * 9;
		lines.push(`${i + 1}. 👤 <b>${name}</b>`);
		lines.push(`💬<b>${msg}</b>   🖼️<b>${photo}</b>   🎬<b>${video}</b>   ⭐<b>${total}</b>`);
		if (i !== rows.length - 1) {
			lines.push("┈┈┈┈┈┈┈┈┈┈");
		}
	}
	lines.push("━━━━━━━━━━━━");
	return lines.join("\n");
}

async function sendCredit(env, chatId) {
	const table = getCreditTable(env);
	const sql =
		`SELECT user_id, username, first_name, last_name, msg_count, photo_count, video_count FROM ${table} ` +
		"WHERE chat_id = ? " +
		"ORDER BY (msg_count + photo_count * 3 + video_count * 9) DESC, updated_at DESC " +
		"LIMIT 50";
	const result = await env.DB.prepare(sql).bind(String(chatId)).all();
	const rows = Array.isArray(result?.results) ? result.results : [];

	return tg(env, "sendMessage", {
		chat_id: chatId,
		text: formatCredit(rows),
		parse_mode: "HTML",
	});
}

async function queryProfilesByX(env, input) {
	const handle = normalizeInput(input).toLowerCase();
	if (!handle) return [];

	const table = getProfilesTable(env);
	const sql =
		`SELECT * FROM ${table} ` +
		"WHERE LOWER(TRIM(REPLACE(COALESCE(handle, ''), '@', ''))) = ? " +
		"LIMIT 5";
	const result = await env.DB.prepare(sql).bind(handle).all();
	return Array.isArray(result?.results) ? result.results : [];
}

async function queryProfilesByTelegram(env, input) {
	const telegram = normalizeInput(input).toLowerCase();
	if (!telegram) return [];

	const table = getProfilesTable(env);
	const sql =
		`SELECT * FROM ${table} ` +
		"WHERE LOWER(TRIM(REPLACE(COALESCE(telegram, ''), '@', ''))) = ? " +
		"LIMIT 5";
	const result = await env.DB.prepare(sql).bind(telegram).all();
	return Array.isArray(result?.results) ? result.results : [];
}

function formatRow(row) {
	const name = escapeHtml(row?.name || "Unnamed");
	const handle = escapeHtml(row?.handle || "");
	const telegram = escapeHtml(row?.telegram || "");
	const district = escapeHtml(row?.district || row?.city || "Unknown");
	const region = escapeHtml(row?.region || row?.province || "Unknown");
	const country = escapeHtml(row?.country || "Unknown");
	const bio = escapeHtml(row?.bio || "");
	const profileUrl = escapeHtml(row?.profile_url || "");

	const lines = [
		"<b>🔎 Profile Result</b>",
		"━━━━━━━━━━━━",
		`👤 <b>${name}</b>`,
		handle ? `𝕏 <b>X</b>: @${handle}` : "𝕏 <b>X</b>: (empty)",
		telegram ? `💬 <b>Telegram</b>: @${telegram}` : "💬 <b>Telegram</b>: (empty)",
		`📍 <b>Location</b>: ${district} / ${region} / ${country}`,
		profileUrl ? `🔗 <b>Profile</b>: ${profileUrl}` : "",
		bio ? `📝 <b>Bio</b>: ${bio}` : "",
		"━━━━━━━━━━━━",
	].filter(Boolean);
	return lines.join("\n");
}

async function handleStart(env, chatId) {
	await tg(env, "sendMessage", {
		chat_id: chatId,
		text: "Send /query to start searching.",
	});
}

async function handleQuery(env, chatId, chat, ctx, requestMessageId) {
	const sent = await sendModeButtons(env, chatId);
	if (isGroupChat(chat)) {
		scheduleDeleteMessage(env, ctx, chatId, requestMessageId, 30000);
		scheduleDeleteMessage(env, ctx, chatId, sent?.message_id, 30000);
	}
}

async function handleCallback(env, callbackQuery) {
	const chatId = callbackQuery?.message?.chat?.id;
	const data = String(callbackQuery?.data || "");
	if (!chatId) return;

	if (data === "mode_x") {
		await tg(env, "answerCallbackQuery", { callback_query_id: callbackQuery.id, text: "Switched to X search" });
		await askForInput(env, chatId, "x");
		return;
	}

	if (data === "mode_tg") {
		await tg(env, "answerCallbackQuery", { callback_query_id: callbackQuery.id, text: "Switched to Telegram search" });
		await askForInput(env, chatId, "tg");
		return;
	}

	await tg(env, "answerCallbackQuery", { callback_query_id: callbackQuery.id });
}

async function handleMessage(env, message, ctx) {
	const chatId = message?.chat?.id;
	const chat = message?.chat;
	const text = String(message?.text || "").trim();
	if (!chatId) return;

	if (isGroupChat(chat)) {
		await upsertCredit(env, message);
	}

	if (!text) return;

	const modeCommand = parseModeCommand(text);
	if (modeCommand) {
		const input = modeCommand.value;
		if (!input) {
			await tg(env, "sendMessage", {
				chat_id: chatId,
				text: modeCommand.mode === "x" ? "Usage: /x <handle>" : "Usage: /tg <username>",
			});
			return;
		}
		try {
			const rows =
				modeCommand.mode === "x" ? await queryProfilesByX(env, input) : await queryProfilesByTelegram(env, input);
			if (rows.length === 0) {
				await tg(env, "sendMessage", { chat_id: chatId, text: "No matching account found." });
				return;
			}
			if (rows.length > 1) {
				await tg(env, "sendMessage", { chat_id: chatId, text: "Multiple matches found. Please provide a more specific account." });
				return;
			}
				const sent = await tg(env, "sendMessage", {
					chat_id: chatId,
					text: formatRow(rows[0]),
					parse_mode: "HTML",
					disable_web_page_preview: true,
				});
				if (isGroupChat(chat)) {
					scheduleDeleteMessage(env, ctx, chatId, sent?.message_id, 20000);
				}
			} catch (err) {
				console.error(err);
				await tg(env, "sendMessage", { chat_id: chatId, text: "Query failed. Please try again later." });
			}
			return;
	}

	const command = normalizeCommand(text);
	const isStartCmd = command === "/start" || command.startsWith("/start@");
	const isHelpCmd = command === "/help" || command.startsWith("/help@");
	const isQueryCmd = command === "/query" || command.startsWith("/query@");
	const isCreditCmd = command === "/credit" || command.startsWith("/credit@");

	if (isCreditCmd) {
		if (!isGroupChat(chat)) {
			await tg(env, "sendMessage", { chat_id: chatId, text: "Use /credit inside a group chat." });
			return;
		}
		const sent = await sendCredit(env, chatId);
		scheduleDeleteMessage(env, ctx, chatId, message?.message_id, 20000);
		scheduleDeleteMessage(env, ctx, chatId, sent?.message_id, 20000);
		return;
	}

	if (isStartCmd || isHelpCmd) {
		await handleStart(env, chatId);
		return;
	}
	if (isQueryCmd) {
		await handleQuery(env, chatId, chat, ctx, message?.message_id);
		return;
	}

	const mode = extractModeFromReply(message);
	if (!mode) {
		// Silent fallback: try exact lookup without sending guidance text.
		try {
			const byX = await queryProfilesByX(env, text);
				if (byX.length === 1) {
					const sent = await tg(env, "sendMessage", {
						chat_id: chatId,
						text: formatRow(byX[0]),
						parse_mode: "HTML",
						disable_web_page_preview: true,
					});
					if (isGroupChat(chat)) {
						scheduleDeleteMessage(env, ctx, chatId, sent?.message_id, 20000);
					}
					return;
				}
				const byTg = await queryProfilesByTelegram(env, text);
				if (byTg.length === 1) {
					const sent = await tg(env, "sendMessage", {
						chat_id: chatId,
						text: formatRow(byTg[0]),
						parse_mode: "HTML",
						disable_web_page_preview: true,
					});
					if (isGroupChat(chat)) {
						scheduleDeleteMessage(env, ctx, chatId, sent?.message_id, 20000);
					}
					return;
				}
			} catch (err) {
				console.error(err);
		}
		return;
	}

	try {
		const rows = mode === "x" ? await queryProfilesByX(env, text) : await queryProfilesByTelegram(env, text);
		if (rows.length === 0) {
			await tg(env, "sendMessage", { chat_id: chatId, text: "No matching account found." });
			return;
		}
		if (rows.length > 1) {
			await tg(env, "sendMessage", { chat_id: chatId, text: "Multiple matches found. Please provide a more specific account." });
			return;
		}
		const sent = await tg(env, "sendMessage", {
			chat_id: chatId,
			text: formatRow(rows[0]),
			parse_mode: "HTML",
			disable_web_page_preview: true,
		});
		if (isGroupChat(chat)) {
			scheduleDeleteMessage(env, ctx, chatId, sent?.message_id, 20000);
		}
	} catch (err) {
		console.error(err);
		await tg(env, "sendMessage", { chat_id: chatId, text: "Query failed. Please try again later." });
	}
}

function isWebhookAuthorized(env, request) {
	const expected = String(env.TELEGRAM_WEBHOOK_SECRET || "").trim();
	if (!expected) return true;
	const provided = request.headers.get("x-telegram-bot-api-secret-token") || "";
	return expected === provided;
}

export default {
	async fetch(request, env, ctx) {
		try {
			getBotToken(env);
			if (!env.DB) {
				throw new Error("Missing D1 binding: DB");
			}
			getProfilesTable(env);
			getCreditTable(env);
			await env.DB.prepare("SELECT 1").first();
			await ensureCreditSchema(env);
		} catch (err) {
			console.error(err);
			return new Response(`Config error: ${String(err?.message || err)}`, { status: 500 });
		}

		const url = new URL(request.url);
		const webhookPaths = getWebhookPaths(env);

		if (request.method === "GET" && url.pathname === "/healthz") {
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
			if (update.callback_query) {
				await handleCallback(env, update.callback_query);
			}
				if (update.message) {
					await handleMessage(env, update.message, ctx);
				}
		} catch (err) {
			console.error("Update handling failed:", err);
			return new Response(`Update handling failed: ${String(err?.message || err)}`, { status: 500 });
		}

		return new Response("ok", { status: 200 });
	},
};
