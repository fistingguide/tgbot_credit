# tgbot_credit (Cloudflare Workers)

## 1. Install & login

```bash
npm i -g wrangler
wrangler login
```

## 2. Create KV namespace

```bash
wrangler kv namespace create CHAT_MODE_KV
```

Copy the returned `id` into `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "CHAT_MODE_KV"
id = "<your_kv_namespace_id>"
```

## 3. Set secrets/env

```bash
wrangler secret put CREDIT_TG_BOT_TOKEN
wrangler secret put TELEGRAM_WEBHOOK_SECRET
```

In `wrangler.toml` add plain env vars:

```toml
[vars]
CREDIT_PROFILE_API_BASE = "https://your-domain.com"
WEBHOOK_PATH = "/webhook"
CHAT_MODE_TTL_SEC = "3600"
```

## 4. Deploy worker

```bash
wrangler deploy
```

## 5. Set Telegram webhook

Assume worker URL is `https://tgbot-credit.<subdomain>.workers.dev`:

```bash
curl -X POST "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -d "url=https://tgbot-credit.<subdomain>.workers.dev/webhook" \
  -d "secret_token=<YOUR_WEBHOOK_SECRET>" \
  -d "allowed_updates=[\"message\",\"callback_query\"]"
```

## 6. Health check

```bash
curl "https://tgbot-credit.<subdomain>.workers.dev/healthz"
```
