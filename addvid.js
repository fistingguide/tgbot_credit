"use strict";

function normalizeCommand(text) {
	if (!String(text || "").startsWith("/")) return "";
	const firstToken = String(text || "").split(/\s+/, 1)[0].toLowerCase();
	const atIndex = firstToken.indexOf("@");
	return atIndex === -1 ? firstToken : firstToken.slice(0, atIndex);
}

function parseIds(raw) {
	return new Set(
		String(raw || "")
			.split(/[,\s;|，]+/)
			.map((s) => s.trim())
			.filter(Boolean)
	);
}

function getTextFromMessage(message) {
	return String(message?.text || message?.caption || "").trim();
}

function parseAddVidArgs(text) {
	const parts = String(text || "").trim().split(/\s+/).filter(Boolean);
	if (parts.length < 3) return null;
	const videoUrl = String(parts[1] || "").trim();
	const durationSec = Number.parseInt(parts[2], 10);
	if (!/^https?:\/\//i.test(videoUrl)) return null;
	if (!Number.isFinite(durationSec) || durationSec <= 0 || durationSec > 24 * 60 * 60) return null;
	return { videoUrl, durationSec };
}

function pickPhotoFileId(message) {
	const currentPhotos = Array.isArray(message?.photo) ? message.photo : [];
	if (currentPhotos.length > 0) {
		return String(currentPhotos[currentPhotos.length - 1]?.file_id || "");
	}
	const repliedPhotos = Array.isArray(message?.reply_to_message?.photo) ? message.reply_to_message.photo : [];
	if (repliedPhotos.length > 0) {
		return String(repliedPhotos[repliedPhotos.length - 1]?.file_id || "");
	}
	return "";
}

function getStoreChannelId(env) {
	return String(env.VID_STORE_CHANNEL_ID || "").trim();
}

function getStateChatId(env) {
	return String(env.VID_STATE_CHAT_ID || env.VID_STORE_CHANNEL_ID || "").trim();
}

function getTargetGroups(env) {
	return parseIds(env.VID_TARGET_GROUPS);
}

function isTargetGroupAllowed(env, chatId) {
	const groups = getTargetGroups(env);
	if (groups.size === 0) return true;
	return groups.has(String(chatId || "").trim());
}

function getBotToken(env) {
	const token = String(env.TG_BOT_TOKEN || env.CREDIT_TG_BOT_TOKEN || "").trim();
	if (!token) {
		throw new Error("Missing TG_BOT_TOKEN/CREDIT_TG_BOT_TOKEN in Worker env");
	}
	return token;
}

function isAdminAllowed(env, userId) {
	const raw = String(env.ADDVID_ADMIN_IDS || env.UPDATERANK_ADMIN_TG_USER_ID || "").trim();
	if (!raw) return true;
	const allowed = new Set(
		raw
			.split(/[,\s;|，]+/)
			.map((v) => String(v || "").trim())
			.filter(Boolean)
	);
	return allowed.has(String(userId || "").trim());
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

function defaultState() {
	return {
		queue: [],
		cursors: {},
	};
}

function formatStateText(state) {
	return `VID_STATE\n${JSON.stringify(state)}`;
}

function parseStateText(text) {
	const raw = String(text || "").trim();
	const body = raw.startsWith("VID_STATE\n") ? raw.slice("VID_STATE\n".length) : raw;
	const parsed = JSON.parse(body);
	const queue = Array.isArray(parsed?.queue)
		? parsed.queue.map((v) => Number.parseInt(String(v), 10)).filter((v) => Number.isFinite(v) && v > 0)
		: [];
	const cursors = {};
	if (parsed?.cursors && typeof parsed.cursors === "object") {
		for (const [k, v] of Object.entries(parsed.cursors)) {
			const n = Number.parseInt(String(v), 10);
			if (Number.isFinite(n) && n >= 0) {
				cursors[String(k)] = n;
			}
		}
	}
	return { queue, cursors };
}

async function ensureStateMessage(env) {
	const stateChatId = getStateChatId(env);
	if (!stateChatId) {
		throw new Error("Missing VID_STATE_CHAT_ID/VID_STORE_CHANNEL_ID");
	}

	if (String(env.VID_STATE_MESSAGE_ID || "").trim()) {
		return {
			stateChatId,
			stateMessageId: Number.parseInt(String(env.VID_STATE_MESSAGE_ID), 10),
			state: defaultState(),
		};
	}

	const chat = await tg(env, "getChat", { chat_id: stateChatId });
	const pinned = chat?.pinned_message;
	if (pinned?.message_id) {
		const candidate = String(pinned?.text || pinned?.caption || "");
		try {
			const parsed = parseStateText(candidate);
			return { stateChatId, stateMessageId: pinned.message_id, state: parsed };
		} catch {
			return { stateChatId, stateMessageId: pinned.message_id, state: defaultState() };
		}
	}

	const created = await tg(env, "sendMessage", {
		chat_id: stateChatId,
		text: formatStateText(defaultState()),
		disable_notification: true,
	});
	await tg(env, "pinChatMessage", {
		chat_id: stateChatId,
		message_id: created.message_id,
		disable_notification: true,
	});
	return { stateChatId, stateMessageId: created.message_id, state: defaultState() };
}

async function loadState(env) {
	const holder = await ensureStateMessage(env);
	if (holder.stateMessageId && String(env.VID_STATE_MESSAGE_ID || "").trim()) {
		// With explicit VID_STATE_MESSAGE_ID, we cannot fetch arbitrary message by ID via Bot API.
		// Keep fallback to pinned message for reading the latest state.
		try {
			const chat = await tg(env, "getChat", { chat_id: holder.stateChatId });
			const pinned = chat?.pinned_message;
			if (pinned?.message_id && String(pinned.message_id) === String(holder.stateMessageId)) {
				const txt = String(pinned?.text || pinned?.caption || "");
				return {
					stateChatId: holder.stateChatId,
					stateMessageId: holder.stateMessageId,
					state: parseStateText(txt),
				};
			}
		} catch {
			// Ignore and fallback to holder.state.
		}
	}
	return holder;
}

async function saveState(env, loaded, state) {
	await tg(env, "editMessageText", {
		chat_id: loaded.stateChatId,
		message_id: loaded.stateMessageId,
		text: formatStateText(state),
		disable_web_page_preview: true,
	});
}

function buildStoredCaption(message, videoUrl, durationSec) {
	const fromId = String(message?.from?.id || "");
	const username = String(message?.from?.username || "");
	const addedAt = new Date().toISOString();
	return [
		"#VID_ITEM",
		`video_url: ${videoUrl}`,
		`duration_sec: ${durationSec}`,
		`added_by_id: ${fromId || "unknown"}`,
		`added_by_username: ${username ? `@${username}` : "unknown"}`,
		`added_at: ${addedAt}`,
	].join("\n");
}

function usageAddVid() {
	return [
		"Usage: /addvid <video_url> <duration_seconds>",
		"Send in one of these ways:",
		"1) Send photo with caption: /addvid ...",
		"2) Reply to a photo and send: /addvid ...",
		"Example: /addvid https://example.com/video.mp4 35",
	].join("\n");
}

async function handleAddVid(env, message) {
	const chatId = message?.chat?.id;
	if (!chatId) return true;

	if (!isAdminAllowed(env, message?.from?.id)) {
		await tg(env, "sendMessage", { chat_id: chatId, text: "You are not allowed to use /addvid." });
		return true;
	}

	const storeChannelId = getStoreChannelId(env);
	if (!storeChannelId) {
		await tg(env, "sendMessage", {
			chat_id: chatId,
			text: "Missing VID_STORE_CHANNEL_ID in wrangler.toml [vars].",
		});
		return true;
	}

	const text = getTextFromMessage(message);
	const parsed = parseAddVidArgs(text);
	if (!parsed) {
		await tg(env, "sendMessage", { chat_id: chatId, text: usageAddVid() });
		return true;
	}

	const photoFileId = pickPhotoFileId(message);
	if (!photoFileId) {
		await tg(env, "sendMessage", {
			chat_id: chatId,
			text: "Missing photo. Send photo + /addvid args, or reply to a photo with /addvid.",
		});
		return true;
	}

	const caption = buildStoredCaption(message, parsed.videoUrl, parsed.durationSec);
	const stored = await tg(env, "sendPhoto", {
		chat_id: storeChannelId,
		photo: photoFileId,
		caption,
	});

	const loaded = await loadState(env);
	const state = loaded.state || defaultState();
	const newId = Number.parseInt(String(stored?.message_id || ""), 10);
	if (Number.isFinite(newId) && newId > 0) {
		state.queue = Array.isArray(state.queue) ? state.queue : [];
		state.queue.push(newId);
	}
	await saveState(env, loaded, state);

	await tg(env, "sendMessage", {
		chat_id: chatId,
		text: `Added. Stored message_id: ${stored?.message_id}. Queue size: ${state.queue.length}`,
	});
	return true;
}

async function sendNextToChat(env, state, chatId) {
	const storeChannelId = getStoreChannelId(env);
	if (!storeChannelId) {
		throw new Error("Missing VID_STORE_CHANNEL_ID");
	}
	const queue = Array.isArray(state.queue) ? state.queue : [];
	if (queue.length === 0) {
		return { sent: false, reason: "empty_queue" };
	}
	state.cursors = state.cursors && typeof state.cursors === "object" ? state.cursors : {};
	const key = String(chatId);
	const cursorRaw = Number.parseInt(String(state.cursors[key] ?? 0), 10);
	const cursor = Number.isFinite(cursorRaw) && cursorRaw >= 0 ? cursorRaw : 0;
	const idx = cursor % queue.length;
	const messageId = queue[idx];
	await tg(env, "copyMessage", {
		chat_id: chatId,
		from_chat_id: storeChannelId,
		message_id: messageId,
	});
	state.cursors[key] = (idx + 1) % queue.length;
	return { sent: true, messageId, nextCursor: state.cursors[key] };
}

async function handleVidNow(env, message) {
	const chatId = message?.chat?.id;
	if (!chatId) return true;
	if (!isTargetGroupAllowed(env, chatId)) {
		await tg(env, "sendMessage", {
			chat_id: chatId,
			text: "This chat is not in VID_TARGET_GROUPS.",
		});
		return true;
	}
	const loaded = await loadState(env);
	const state = loaded.state || defaultState();
	const result = await sendNextToChat(env, state, chatId);
	await saveState(env, loaded, state);
	if (!result.sent) {
		await tg(env, "sendMessage", {
			chat_id: chatId,
			text: "No video items in queue. Use /addvid first.",
		});
	}
	return true;
}

export async function maybeHandleVidCommands(env, message) {
	const text = getTextFromMessage(message);
	const command = normalizeCommand(text);
	if (command === "/addvid") {
		return handleAddVid(env, message);
	}
	if (command === "/vid") {
		return handleVidNow(env, message);
	}
	return false;
}

export async function runScheduledVidPush(env) {
	const targets = Array.from(getTargetGroups(env));
	if (targets.length === 0) {
		return { ok: true, pushed: 0, skipped: 0 };
	}
	const loaded = await loadState(env);
	const state = loaded.state || defaultState();
	let pushed = 0;
	let skipped = 0;

	for (const target of targets) {
		try {
			const chatId = Number.parseInt(String(target), 10);
			if (!Number.isFinite(chatId)) {
				skipped += 1;
				continue;
			}
			const result = await sendNextToChat(env, state, chatId);
			if (result.sent) pushed += 1;
			else skipped += 1;
		} catch (err) {
			console.error(`scheduled push failed for chat ${target}:`, err);
			skipped += 1;
		}
	}

	await saveState(env, loaded, state);
	return { ok: true, pushed, skipped };
}
