# tgbot_credit (Cloudflare Workers + D1)

## 1. Install & login

```bash
npm i -g wrangler
wrangler login
```

## 2. Configure D1 binding

`wrangler.toml` uses your D1 database:

```toml
d1_databases = [
  { binding = "DB", database_id = "d6f69b40-6768-431d-a2a4-2233aa802bc7", database_name = "japs" }
]
```

The Worker will auto-create table `chat_modes` on first request.

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
npx wrangler deploy
```

## 5. Set Telegram webhook

Assume worker URL is `https://tgbotcredit.<subdomain>.workers.dev`:

```bash
curl -X POST "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -d "url=https://tgbotcredit.<subdomain>.workers.dev/webhook" \
  -d "secret_token=<YOUR_WEBHOOK_SECRET>" \
  -d "allowed_updates=[\"message\",\"callback_query\"]"
```

## 6. Health check

```bash
curl "https://tgbotcredit.<subdomain>.workers.dev/healthz"
```
