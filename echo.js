"use strict";

/**
 * Simple Telegram echo test worker.
 *
 * Required env vars:
 * - CREDIT_TG_BOT_TOKEN
 *
 * Optional env vars:
 * - WEBHOOK_PATH (default: /webhook)
 * - TELEGRAM_WEBHOOK_SECRET
 */

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

function isWebhookAuthorized(env, request) {
	const expected = String(env.TELEGRAM_WEBHOOK_SECRET || "").trim();
	if (!expected) return true;
	const provided = request.headers.get("x-telegram-bot-api-secret-token") || "";
	return provided === expected;
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

async function handleMessage(env, message) {
	const chatId = message?.chat?.id;
	const text = String(message?.text || "").trim();
	if (!chatId || !text) return;

	const command = text.split(/\s+/)[0].toLowerCase();
	const isEchoCmd = command === "/echo" || command.startsWith("/echo@");
	if (!isEchoCmd) return;

	await tg(env, "sendMessage", {
		chat_id: chatId,
		text: "你好",
	});
}

export default {
	async fetch(request, env) {
		try {
			requireEnv(env, "CREDIT_TG_BOT_TOKEN");
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
			if (update.message) {
				await handleMessage(env, update.message);
			}
		} catch (err) {
			console.error("Update handling failed:", err);
		}

		return new Response("ok", { status: 200 });
	},
};
