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
	const cmd = normalizeCommand(text);
	const isCreditCmd = cmd === "/me" || cmd === "/list";
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

async function ensureProfilesSchema(env) {
	const table = getProfilesTable(env);
	const columnsResult = await env.DB.prepare(`PRAGMA table_info(${table})`).all();
	const existingColumns = new Set(
		(Array.isArray(columnsResult?.results) ? columnsResult.results : []).map((row) => String(row?.name || ""))
	);
	if (existingColumns.size === 0) {
		console.warn(`profiles table not found or unreadable: ${table}`);
		return;
	}

	const addColumnIfMissing = async (name, ddl) => {
		if (!existingColumns.has(name)) {
			await env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN ${ddl}`).run();
		}
	};

	await addColumnIfMissing("tg_user_id", "tg_user_id TEXT");
	await addColumnIfMissing("telegram", "telegram TEXT");
	await addColumnIfMissing("handle", "handle TEXT");
	await addColumnIfMissing("tg_msg_cnt", "tg_msg_cnt INTEGER NOT NULL DEFAULT 0");
	await addColumnIfMissing("tg_photo_cnt", "tg_photo_cnt INTEGER NOT NULL DEFAULT 0");
	await addColumnIfMissing("tg_video_cnt", "tg_video_cnt INTEGER NOT NULL DEFAULT 0");
	await addColumnIfMissing("list_star_event_cnt", "list_star_event_cnt INTEGER NOT NULL DEFAULT 0");
	await addColumnIfMissing("total_credit", "total_credit INTEGER NOT NULL DEFAULT 0");
}

async function upsertCredit(env, message) {
	const from = message?.from;
	if (!from?.id || from?.is_bot) return;

	const { msgCount, photoCount, videoCount } = buildIncrements(message);
	if (msgCount === 0 && photoCount === 0 && videoCount === 0) return;
	const table = getProfilesTable(env);
	const tgUserId = String(from.id);
	const telegram = normalizeInput(from.username).toLowerCase();

	const updateByTgUserId = await env.DB.prepare(
		`UPDATE ${table} SET ` +
			"telegram = CASE " +
			"WHEN TRIM(COALESCE(telegram, '')) = '' AND TRIM(COALESCE(?, '')) <> '' THEN ? " +
			"ELSE telegram END, " +
			"tg_user_id = ?, " +
			"tg_msg_cnt = COALESCE(tg_msg_cnt, 0) + ?, " +
			"tg_photo_cnt = COALESCE(tg_photo_cnt, 0) + ?, " +
			"tg_video_cnt = COALESCE(tg_video_cnt, 0) + ?, " +
			"total_credit = " +
			"(COALESCE(followers_count, 0) / 10.0) + " +
			"((COALESCE(tg_msg_cnt, 0) + ?) * 1) + " +
			"((COALESCE(tg_photo_cnt, 0) + ?) * 2) + " +
			"((COALESCE(tg_video_cnt, 0) + ?) * 10) + " +
			"COALESCE(list_star_event_cnt, 0) + " +
			"COALESCE(super_credit, 0) " +
			"WHERE TRIM(COALESCE(tg_user_id, '')) = ?"
	)
		.bind(telegram, telegram, tgUserId, msgCount, photoCount, videoCount, msgCount, photoCount, videoCount, tgUserId)
		.run();
	const changedByUserId = Number(updateByTgUserId?.meta?.changes || 0);
	if (changedByUserId > 0) return;

	if (!telegram) {
		console.warn(`skip credit update: no matching profile for tg_user_id=${tgUserId} and telegram is empty`);
		return;
	}

	const updateByTelegram = await env.DB.prepare(
		`UPDATE ${table} SET ` +
			"tg_user_id = CASE " +
			"WHEN TRIM(COALESCE(tg_user_id, '')) = '' THEN ? " +
			"ELSE tg_user_id END, " +
			"tg_msg_cnt = COALESCE(tg_msg_cnt, 0) + ?, " +
			"tg_photo_cnt = COALESCE(tg_photo_cnt, 0) + ?, " +
			"tg_video_cnt = COALESCE(tg_video_cnt, 0) + ?, " +
			"total_credit = " +
			"(COALESCE(followers_count, 0) / 10.0) + " +
			"((COALESCE(tg_msg_cnt, 0) + ?) * 1) + " +
			"((COALESCE(tg_photo_cnt, 0) + ?) * 2) + " +
			"((COALESCE(tg_video_cnt, 0) + ?) * 10) + " +
			"COALESCE(list_star_event_cnt, 0) + " +
			"COALESCE(super_credit, 0) " +
			"WHERE LOWER(TRIM(REPLACE(COALESCE(telegram, ''), '@', ''))) = ?"
	)
		.bind(tgUserId, msgCount, photoCount, videoCount, msgCount, photoCount, videoCount, telegram)
		.run();
	const changedByTelegram = Number(updateByTelegram?.meta?.changes || 0);
	if (changedByTelegram === 0) {
		console.warn(`skip credit update: no matching profile for tg_user_id=${tgUserId}, telegram=${telegram}`);
	}
}

function displayName(row) {
	const userHandle = String(row?.user_handle || "").trim();
	if (userHandle) return `@${userHandle}`;
	return `User ${row?.user_id || "Unknown"}`;
}

function formatCredit(rows) {
	if (!rows.length) {
		return "No activity records found in this group yet.";
	}

	const lines = ["<b>📊 Group Credit Leaderboard</b>", "━━━━━━━━━━━━"];
	for (let i = 0; i < rows.length; i += 1) {
		const row = rows[i];
		const tgHandle = escapeHtml(String(row?.user_handle || "").trim());
		const totalCredit = Number(row?.total_credit || 0);
		lines.push(`${i + 1}. 𝕏 <b>${normalizeInput(row?.x_handle) ? "(tap button)" : "(empty)"}</b>   💬 <b>${tgHandle ? `@${tgHandle}` : "(empty)"}</b>`);
		lines.push(`⭐ Total Credit: <b>${totalCredit}</b>`);
		if (i !== rows.length - 1) {
			lines.push("┈┈┈┈┈┈┈┈┈┈");
		}
	}
	lines.push("━━━━━━━━━━━━");
	return lines.join("\n");
}

function buildAllCreditKeyboard(rows) {
	const safeRows = Array.isArray(rows) ? rows : [];
	return buildAllCreditKeyboardByPage(safeRows, 0, safeRows.length, {}).reply_markup;
}

const ALL_CREDIT_PAGE_SIZE = 10;

function buildListTopButtons(env) {
	const xUrl = normalizeUrl(env?.LIST_TOP_X_URL || env?.MY_X_URL || "https://x.com/FistingGuide");
	const websiteUrl = normalizeUrl(env?.LIST_TOP_WEBSITE_URL || env?.WEBSITE_URL || "https://www.fisting.guide");
	return [
		{ text: "Ｘ Our X", url: xUrl },
		{ text: "🌐 Our Website ", url: websiteUrl },
	];
}

function buildAllCreditKeyboardByPage(rows, page, totalRows, env) {
	const safeRows = Array.isArray(rows) ? rows : [];
	const safeTotalRows = Math.max(0, Number(totalRows || 0));
	const totalPages = Math.max(1, Math.ceil(safeTotalRows / ALL_CREDIT_PAGE_SIZE));
	const safePage = Math.max(0, Math.min(Number(page || 0), totalPages - 1));

	const inline_keyboard = [buildListTopButtons(env)];
	let buttonRow = [];
	for (let i = 0; i < safeRows.length; i += 1) {
		const row = safeRows[i];
		const xHandle = normalizeInput(row?.x_handle);
		const xName = String(row?.name || "").trim();
		if (!xHandle) continue;
		buttonRow.push({
			text: `${xName || `@${xHandle}`}`,
			url: `https://x.com/${encodeURIComponent(xHandle)}`,
		});
		if (buttonRow.length === 2) {
			inline_keyboard.push(buttonRow);
			buttonRow = [];
		}
	}
	if (buttonRow.length > 0) {
		inline_keyboard.push(buttonRow);
	}

	if (totalPages > 1) {
		const navRow = [];
		if (safePage > 0) {
			navRow.push({ text: "⬅ Prev", callback_data: `credit_page:${safePage - 1}` });
		}
		navRow.push({ text: `${safePage + 1}/${totalPages}`, callback_data: "credit_page:noop" });
		if (safePage < totalPages - 1) {
			navRow.push({ text: "Next ➡", callback_data: `credit_page:${safePage + 1}` });
		}
		inline_keyboard.push(navRow);
	}

	return {
		page: safePage,
		totalPages,
		reply_markup: inline_keyboard.length > 0 ? { inline_keyboard } : undefined,
	};
}

async function queryAllCreditCount(env) {
	const table = getProfilesTable(env);
	const row = await env.DB.prepare(
		`SELECT COUNT(1) AS cnt FROM ${table} WHERE COALESCE(total_credit, 0) > 0 AND TRIM(COALESCE(handle, '')) <> ''`
	).first();
	return Number(row?.cnt || 0);
}

async function queryAllCreditRowsByPage(env, page) {
	const table = getProfilesTable(env);
	const safePage = Math.max(0, Number(page || 0));
	const offset = safePage * ALL_CREDIT_PAGE_SIZE;
	const sql =
		`SELECT ` +
		"NULLIF(TRIM(COALESCE(name, '')), '') AS name, " +
		"NULLIF(TRIM(COALESCE(handle, '')), '') AS x_handle, " +
		"COALESCE(total_credit, 0) AS total_credit " +
		`FROM ${table} ` +
		"WHERE COALESCE(total_credit, 0) > 0 AND TRIM(COALESCE(handle, '')) <> '' " +
		"ORDER BY COALESCE(total_credit, 0) DESC, COALESCE(list_star_event_cnt, 0) DESC " +
		"LIMIT ? OFFSET ?";
	const result = await env.DB.prepare(sql).bind(ALL_CREDIT_PAGE_SIZE, offset).all();
	return Array.isArray(result?.results) ? result.results : [];
}

function formatMyCredit(row) {
	if (!row) {
		return "No credit record found for you yet.";
	}
	const name = escapeHtml(normalizeInput(row?.user_handle) || `User ${row?.user_id || "Unknown"}`);
	const xHandle = escapeHtml(normalizeInput(row?.x_handle));
	const followersCount = Number(row?.followers_count || 0);
	const msg = Number(row?.msg_count || 0);
	const photo = Number(row?.photo_count || 0);
	const video = Number(row?.video_count || 0);
	const listStarEventCnt = Number(row?.list_star_event_cnt || 0);
	const superCredit = Number(row?.super_credit || 0);
	const rank = Number(row?.rank_value || 0);
	const totalRows = Number(row?.total_rows || 0);
	const total = Number(row?.star || 0);
	return [
		"<b>⭐FistingGuide Credit</b>",
		"━━━━━━━━━━━━",
		`👤 <b>${name}</b>${xHandle ? `   𝕏<b>${xHandle}</b>` : ""}`,
		`🐦<b>${followersCount}</b> 💬<b>${msg}</b> 🖼️<b>${photo}</b> 🎬<b>${video}</b>`,
		`🎯ListStar Event Credit <b>${listStarEventCnt}</b> ⚡Super Credit <b>${superCredit}</b>`,
		`🏆Current Rank <b>${rank}</b>/<b>${totalRows}</b>   ⭐Total Credit <b>${total}</b>`,
		"━━━━━━━━━━━━",
	].join("\n");
}

function normalizeUrl(value) {
	const raw = String(value || "").trim();
	if (!raw) return "";
	if (/^https?:\/\//i.test(raw)) return raw;
	return `https://${raw}`;
}

function buildMyProfileButtons(profileRow, creditRow, env) {
	const xHandle = normalizeInput(profileRow?.handle || creditRow?.x_handle);
	const xUrl = xHandle ? `https://x.com/${encodeURIComponent(xHandle)}` : "";

	const profileUrl = normalizeUrl(profileRow?.profile_url);
	const isXProfileUrl = /^(https?:\/\/)?(www\.)?(x\.com|twitter\.com)\//i.test(profileUrl);
	const fallbackWebsite = normalizeUrl(env.MY_WEBSITE_URL || env.WEBSITE_URL || "https://www.fisting.guide");
	const websiteUrl = profileUrl && !isXProfileUrl ? profileUrl : fallbackWebsite;

	const row = [];
	if (xUrl) row.push({ text: "Ｘ", url: xUrl });
	if (websiteUrl) row.push({ text: "🌐 Website", url: websiteUrl });
	return row.length > 0 ? { inline_keyboard: [row] } : undefined;
}

function formatMeCombined(profileRow, creditRow) {
	const profileName = escapeHtml(profileRow?.name || "Unnamed");
	const xHandle = escapeHtml(normalizeInput(profileRow?.handle || creditRow?.x_handle));
	const telegram = escapeHtml(normalizeInput(profileRow?.telegram || creditRow?.user_handle));
	const district = escapeHtml(profileRow?.district || profileRow?.city || "Unknown");
	const region = escapeHtml(profileRow?.region || profileRow?.province || "Unknown");
	const country = escapeHtml(profileRow?.country || "Unknown");
	const bio = escapeHtml(profileRow?.bio || "");

	const followersCount = Number(creditRow?.followers_count || 0);
	const msg = Number(creditRow?.msg_count || 0);
	const photo = Number(creditRow?.photo_count || 0);
	const video = Number(creditRow?.video_count || 0);
	const listStarEventCnt = Number(creditRow?.list_star_event_cnt || 0);
	const superCredit = Number(creditRow?.super_credit || 0);
	const rank = Number(creditRow?.rank_value || 0);
	const totalRows = Number(creditRow?.total_rows || 0);
	const total = Number(creditRow?.star || 0);

	return [
		"<b>🔎FistingGuide Profile</b>",
		"━━━━━━━━━━━━",
		`👤 <b>${profileName}</b>`,
		xHandle ? `𝕏 <b>X</b>: @${xHandle}` : "𝕏 <b>X</b>: (empty)",
		telegram ? `💬 <b>Telegram</b>: @${telegram}` : "💬 <b>Telegram</b>: (empty)",
		`📍 <b>Location</b>: ${district} / ${region} / ${country}`,
		bio ? `📝 <b>Bio</b>: ${bio}` : "",
		"━━━━━━━━━━━━",
		"<b>⭐FistingGuide Credit</b>",
		"━━━━━━━━━━━━",
		`🐦<b>${followersCount}</b> 💬<b>${msg}</b> 🖼️<b>${photo}</b> 🎬<b>${video}</b>`,
		`🎯ListStar Event Credit <b>${listStarEventCnt}</b> ⚡Super Credit <b>${superCredit}</b>`,
		`🏆Current Rank <b>${rank}</b>/<b>${totalRows}</b>   ⭐Total Credit <b>${total}</b>`,
		"━━━━━━━━━━━━",
	]
		.filter(Boolean)
		.join("\n");
}

const MISSING_TELEGRAM_PROFILE_MESSAGE = "Please add your Telegram username to your profile first.";
const PROFILE_EDIT_URL = "https://fisting.guide/admin/edit";
const PROFILE_CREATE_URL = "https://fisting.guide/admin/create";
const TOTAL_CREDIT_SQL_EXPR =
	"(COALESCE(CAST(followers_count AS REAL), 0) / 10.0) + " +
	"(COALESCE(tg_msg_cnt, 0) * 1) + " +
	"(COALESCE(tg_photo_cnt, 0) * 2) + " +
	"(COALESCE(tg_video_cnt, 0) * 10) + " +
	"COALESCE(list_star_event_cnt, 0) + " +
	"COALESCE(super_credit, 0)";

async function resolveProfileAction(env, userId, telegramUsername) {
	const table = getProfilesTable(env);
	const tgUserId = String(userId || "").trim();
	const normalizedTelegram = normalizeInput(telegramUsername).toLowerCase();

	if (tgUserId) {
		const byUserId = await env.DB.prepare(
			`SELECT NULLIF(TRIM(COALESCE(telegram, '')), '') AS telegram FROM ${table} WHERE TRIM(COALESCE(tg_user_id, '')) = ? LIMIT 1`
		)
			.bind(tgUserId)
			.first();
		if (byUserId) {
			const hasTelegram = Boolean(normalizeInput(byUserId?.telegram));
			if (!hasTelegram) {
				return {
					text: "Your profile exists, but Telegram username is missing. Please add your Telegram first.",
					buttonText: "add my telegram",
					url: PROFILE_EDIT_URL,
				};
			}
			return {
				text: "Your profile exists. Please update your profile information here.",
				buttonText: "edit my profile",
				url: PROFILE_EDIT_URL,
			};
		}
	}

	if (normalizedTelegram) {
		const byTelegram = await env.DB.prepare(
			`SELECT 1 AS found FROM ${table} WHERE LOWER(TRIM(REPLACE(COALESCE(telegram, ''), '@', ''))) = ? LIMIT 1`
		)
			.bind(normalizedTelegram)
			.first();
		if (byTelegram) {
			return {
				text: "Your profile exists. Please update your profile information here.",
				buttonText: "edit my profile",
				url: PROFILE_EDIT_URL,
			};
		}
	}

	return {
		text: "No profile found. Please create your profile first.",
		buttonText: "create my profile",
		url: PROFILE_CREATE_URL,
	};
}

async function sendMissingTelegramProfileMessage(env, chatId, userId, telegramUsername) {
	const action = await resolveProfileAction(env, userId, telegramUsername);
	return tg(env, "sendMessage", {
		chat_id: chatId,
		text: action.text || MISSING_TELEGRAM_PROFILE_MESSAGE,
		reply_markup: {
			inline_keyboard: [[{ text: action.buttonText, url: action.url }]],
		},
	});
}

async function sendAllCredit(env, chatId) {
	const totalRows = await queryAllCreditCount(env);
	if (totalRows === 0) {
		return tg(env, "sendMessage", {
			chat_id: chatId,
			text: "No X profiles with total credit found.",
		});
	}
	const rows = await queryAllCreditRowsByPage(env, 0);
	const paged = buildAllCreditKeyboardByPage(rows, 0, totalRows, env);

	return tg(env, "sendMessage", {
		chat_id: chatId,
		text: `FGList  (${paged.page + 1}/${paged.totalPages}):`,
		reply_markup: paged.reply_markup,
	});
}

async function queryMyCreditRow(env, userId, telegramUsername) {
	const table = getProfilesTable(env);
	const normalizedTelegram = normalizeInput(telegramUsername).toLowerCase();
	if (!normalizedTelegram) return null;

	let row = await env.DB.prepare(
		`SELECT ` +
			"COALESCE(NULLIF(TRIM(COALESCE(tg_user_id, '')), ''), NULLIF(TRIM(COALESCE(telegram, '')), ''), 'Unknown') AS user_id, " +
			"NULLIF(TRIM(COALESCE(telegram, '')), '') AS user_handle, " +
			"NULLIF(TRIM(COALESCE(handle, '')), '') AS x_handle, " +
			"COALESCE(followers_count, 0) AS followers_count, " +
			"COALESCE(tg_msg_cnt, 0) AS msg_count, " +
			"COALESCE(tg_photo_cnt, 0) AS photo_count, " +
			"COALESCE(tg_video_cnt, 0) AS video_count, " +
			"COALESCE(list_star_event_cnt, 0) AS list_star_event_cnt, " +
			"COALESCE(super_credit, 0) AS super_credit, " +
			'COALESCE("rank", 0) AS rank_value, ' +
			`(SELECT COUNT(1) FROM ${table}) AS total_rows, ` +
			`${TOTAL_CREDIT_SQL_EXPR} AS star ` +
			`FROM ${table} WHERE TRIM(COALESCE(tg_user_id, '')) = ? LIMIT 1`
	)
		.bind(String(userId))
		.first();

	if (!row) {
		row = await env.DB.prepare(
			`SELECT ` +
				"COALESCE(NULLIF(TRIM(COALESCE(tg_user_id, '')), ''), NULLIF(TRIM(COALESCE(telegram, '')), ''), 'Unknown') AS user_id, " +
				"NULLIF(TRIM(COALESCE(telegram, '')), '') AS user_handle, " +
				"NULLIF(TRIM(COALESCE(handle, '')), '') AS x_handle, " +
				"COALESCE(followers_count, 0) AS followers_count, " +
				"COALESCE(tg_msg_cnt, 0) AS msg_count, " +
				"COALESCE(tg_photo_cnt, 0) AS photo_count, " +
				"COALESCE(tg_video_cnt, 0) AS video_count, " +
				"COALESCE(list_star_event_cnt, 0) AS list_star_event_cnt, " +
				"COALESCE(super_credit, 0) AS super_credit, " +
				'COALESCE("rank", 0) AS rank_value, ' +
				`(SELECT COUNT(1) FROM ${table}) AS total_rows, ` +
				`${TOTAL_CREDIT_SQL_EXPR} AS star ` +
				`FROM ${table} WHERE LOWER(TRIM(REPLACE(COALESCE(telegram, ''), '@', ''))) = ? LIMIT 1`
		)
			.bind(normalizedTelegram)
			.first();
	}

	return row || null;
}

async function sendMyCredit(env, chatId, userId, telegramUsername) {
	const row = await queryMyCreditRow(env, userId, telegramUsername);
	if (!row) {
		return sendMissingTelegramProfileMessage(env, chatId, userId, telegramUsername);
	}
	return tg(env, "sendMessage", {
		chat_id: chatId,
		text: formatMyCredit(row),
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
		"<b>🔎FistingGuide Profile</b>",
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
		text: "Send /me to start searching.",
	});
}

async function handleMyProfile(env, message, ctx) {
	const chatId = message?.chat?.id;
	const chat = message?.chat;
	const telegramUsername = normalizeInput(message?.from?.username).toLowerCase();
	if (!chatId) return;

	if (!telegramUsername) {
		await sendMissingTelegramProfileMessage(env, chatId, message?.from?.id, message?.from?.username);
		return;
	}

	try {
		const rows = await queryProfilesByTelegram(env, telegramUsername);
		if (rows.length === 0) {
			await sendMissingTelegramProfileMessage(env, chatId, message?.from?.id, message?.from?.username);
			return;
		}
		if (rows.length > 1) {
			await tg(env, "sendMessage", {
				chat_id: chatId,
				text: "Multiple profiles found for your Telegram username. Please contact admin.",
			});
			return;
		}
		const creditRow = await queryMyCreditRow(env, message?.from?.id, message?.from?.username);
		const sent = await tg(env, "sendMessage", {
			chat_id: chatId,
			text: formatMeCombined(rows[0], creditRow),
			parse_mode: "HTML",
			disable_web_page_preview: true,
			reply_markup: buildMyProfileButtons(rows[0], creditRow, env),
		});
	} catch (err) {
		console.error(err);
		await tg(env, "sendMessage", { chat_id: chatId, text: "Query failed. Please try again later." });
	}
}

async function handleCallback(env, callbackQuery) {
	const chatId = callbackQuery?.message?.chat?.id;
	const messageId = callbackQuery?.message?.message_id;
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

	if (data === "credit_page:noop") {
		await tg(env, "answerCallbackQuery", { callback_query_id: callbackQuery.id });
		return;
	}

	if (data.startsWith("credit_page:")) {
		const rawPage = Number(data.split(":")[1]);
		const targetPage = Number.isFinite(rawPage) ? rawPage : 0;
		const totalRows = await queryAllCreditCount(env);
		const totalPages = Math.max(1, Math.ceil(totalRows / ALL_CREDIT_PAGE_SIZE));
		const safePage = Math.max(0, Math.min(targetPage, totalPages - 1));
		const rows = await queryAllCreditRowsByPage(env, safePage);
		const paged = buildAllCreditKeyboardByPage(rows, safePage, totalRows, env);
		if (messageId && paged.reply_markup) {
			await tg(env, "editMessageText", {
				chat_id: chatId,
				message_id: messageId,
				text: `FGList (${paged.page + 1}/${paged.totalPages}):`,
				reply_markup: paged.reply_markup,
			});
		}
		await tg(env, "answerCallbackQuery", { callback_query_id: callbackQuery.id });
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
		try {
			await upsertCredit(env, message);
		} catch (err) {
			console.error("upsertCredit failed:", err);
		}
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
				await tg(env, "sendMessage", {
					chat_id: chatId,
					text: formatRow(rows[0]),
					parse_mode: "HTML",
					disable_web_page_preview: true,
				});
			} catch (err) {
				console.error(err);
				await tg(env, "sendMessage", { chat_id: chatId, text: "Query failed. Please try again later." });
			}
			return;
	}

	const command = normalizeCommand(text);
	const isStartCmd = command === "/start" || command.startsWith("/start@");
	const isHelpCmd = command === "/help" || command.startsWith("/help@");
	const isMyprofileCmd = command === "/me" || command.startsWith("/me@");
	const isListCmd = command === "/list" || command.startsWith("/list@");

	if (isListCmd) {
		await sendAllCredit(env, chatId);
		return;
	}

	if (isStartCmd || isHelpCmd) {
		await handleStart(env, chatId);
		return;
	}
	if (isMyprofileCmd) {
		await handleMyProfile(env, message, ctx);
		return;
	}

	const mode = extractModeFromReply(message);
	if (!mode) {
		// Silent fallback: try exact lookup without sending guidance text.
		try {
			const byX = await queryProfilesByX(env, text);
				if (byX.length === 1) {
					await tg(env, "sendMessage", {
						chat_id: chatId,
						text: formatRow(byX[0]),
						parse_mode: "HTML",
						disable_web_page_preview: true,
					});
					return;
				}
				const byTg = await queryProfilesByTelegram(env, text);
				if (byTg.length === 1) {
					await tg(env, "sendMessage", {
						chat_id: chatId,
						text: formatRow(byTg[0]),
						parse_mode: "HTML",
						disable_web_page_preview: true,
					});
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
		await tg(env, "sendMessage", {
			chat_id: chatId,
			text: formatRow(rows[0]),
			parse_mode: "HTML",
			disable_web_page_preview: true,
		});
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
			await env.DB.prepare("SELECT 1").first();
			await ensureProfilesSchema(env);
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
