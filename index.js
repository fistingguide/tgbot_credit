"use strict";

/**
 * Telegram query bot (read-only, no create/update).
 *
 * Env:
 * - CREDIT_TG_BOT_TOKEN: Telegram bot token (required)
 * - CREDIT_PROFILE_API_BASE: e.g. https://your-domain.com (required)
 * - POLL_TIMEOUT_SEC: long polling timeout seconds (optional, default 30)
 */

const TG_BOT_TOKEN = process.env.CREDIT_TG_BOT_TOKEN || "";
const PROFILE_API_BASE = (process.env.CREDIT_PROFILE_API_BASE || "").replace(/\/+$/, "");
const POLL_TIMEOUT_SEC = Number(process.env.POLL_TIMEOUT_SEC || 30);

if (!TG_BOT_TOKEN) {
	console.error("Missing CREDIT_TG_BOT_TOKEN");
	process.exit(1);
}
if (!PROFILE_API_BASE) {
	console.error("Missing CREDIT_PROFILE_API_BASE");
	process.exit(1);
}

const TELEGRAM_API = `https://api.telegram.org/bot${TG_BOT_TOKEN}`;
const chatModes = new Map(); // chatId -> "x" | "tg"

function normalizeInput(value) {
	return String(value || "").trim().replace(/^@+/, "");
}

function escapeHtml(value) {
	return String(value || "")
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

async function tg(method, payload) {
	const res = await fetch(`${TELEGRAM_API}/${method}`, {
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

async function sendModeButtons(chatId) {
	return tg("sendMessage", {
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

async function queryByX(handleInput) {
	const handle = normalizeInput(handleInput);
	if (!handle) return [];
	const res = await fetch(`${PROFILE_API_BASE}/api/profiles?handle=${encodeURIComponent("@" + handle)}`);
	if (!res.ok) throw new Error("Profile API request failed");
	const data = await res.json();
	const rows = Array.isArray(data.results) ? data.results : [];
	return rows.filter((row) => normalizeInput(row.handle).toLowerCase() === handle.toLowerCase());
}

async function queryByTelegram(tgInput) {
	const target = normalizeInput(tgInput).toLowerCase();
	if (!target) return [];
	// No dedicated tg query endpoint; fetch all and filter in bot.
	const res = await fetch(`${PROFILE_API_BASE}/api/profiles`);
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

async function handleStart(chatId) {
	chatModes.delete(chatId);
	await tg("sendMessage", {
		chat_id: chatId,
		text: "发送 /query 开始查询。",
	});
}

async function handleQuery(chatId) {
	chatModes.delete(chatId);
	await sendModeButtons(chatId);
}

async function handleCallback(callbackQuery) {
	const chatId = callbackQuery?.message?.chat?.id;
	const data = String(callbackQuery?.data || "");
	if (!chatId) return;

	if (data === "mode_x") {
		chatModes.set(chatId, "x");
		await tg("answerCallbackQuery", { callback_query_id: callbackQuery.id, text: "已切换到 X 查询" });
		await tg("sendMessage", { chat_id: chatId, text: "请输入 X 账号（例如 @demo 或 demo）" });
		return;
	}

	if (data === "mode_tg") {
		chatModes.set(chatId, "tg");
		await tg("answerCallbackQuery", { callback_query_id: callbackQuery.id, text: "已切换到 Telegram 查询" });
		await tg("sendMessage", { chat_id: chatId, text: "请输入 Telegram 账号（例如 @demo 或 demo）" });
		return;
	}

	await tg("answerCallbackQuery", { callback_query_id: callbackQuery.id });
}

async function handleMessage(message) {
	const chatId = message?.chat?.id;
	const text = String(message?.text || "").trim();
	const command = text.split(/\s+/)[0].toLowerCase();
	const isStartCmd = command === "/start" || command.startsWith("/start@");
	const isHelpCmd = command === "/help" || command.startsWith("/help@");
	const isQueryCmd = command === "/query" || command.startsWith("/query@");
	if (!chatId || !text) return;

	if (isStartCmd || isHelpCmd) {
		await handleStart(chatId);
		return;
	}
	if (isQueryCmd) {
		await handleQuery(chatId);
		return;
	}

	const mode = chatModes.get(chatId);
	if (!mode) {
		await tg("sendMessage", { chat_id: chatId, text: "请先发送 /query 并点击查询方式。" });
		return;
	}

	try {
		const rows = mode === "x" ? await queryByX(text) : await queryByTelegram(text);
		if (rows.length === 0) {
			await tg("sendMessage", { chat_id: chatId, text: "没有找到对应账号。" });
			return;
		}
		if (rows.length > 1) {
			await tg("sendMessage", { chat_id: chatId, text: "匹配到多个账号，请输入更精确的账号。" });
			return;
		}
		await tg("sendMessage", {
			chat_id: chatId,
			text: formatRow(rows[0]),
			parse_mode: "HTML",
			disable_web_page_preview: true,
		});
	} catch (err) {
		console.error(err);
		await tg("sendMessage", { chat_id: chatId, text: "查询失败，请稍后重试。" });
	}
}

async function run() {
	let offset = 0;
	console.log("credit.js bot started");
	while (true) {
		try {
			const res = await fetch(`${TELEGRAM_API}/getUpdates`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					offset,
					timeout: POLL_TIMEOUT_SEC,
					allowed_updates: ["message", "callback_query"],
				}),
			});
			const data = await res.json();
			if (!res.ok || !data?.ok) {
				await new Promise((r) => setTimeout(r, 1200));
				continue;
			}
			const updates = Array.isArray(data.result) ? data.result : [];
			for (const upd of updates) {
				offset = Math.max(offset, Number(upd.update_id) + 1);
				if (upd.callback_query) await handleCallback(upd.callback_query);
				if (upd.message) await handleMessage(upd.message);
			}
		} catch (err) {
			console.error("polling error", err);
			await new Promise((r) => setTimeout(r, 1200));
		}
	}
}

run().catch((err) => {
	console.error(err);
	process.exit(1);
});
