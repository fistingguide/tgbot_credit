# tgbot_credit (Cloudflare Workers + D1)

一个 Telegram 查询机器人：

1. 用户发送 `/query`
2. 机器人让用户选择按 `X` 或 `Telegram` 查询
3. 机器人弹出输入窗口（`force_reply`）
4. 用户输入账号后，Worker 直接查询 D1 的 `profiles` 表并返回信息

## 1. Install & login

```bash
npm i -g wrangler
wrangler login
```

## 2. Configure D1 binding

`wrangler.toml` 绑定 D1:

```toml
d1_databases = [
  { binding = "DB", database_id = "...", database_name = "..." }
]
```

## 3. Set secrets/env

```bash
wrangler secret put CREDIT_TG_BOT_TOKEN
wrangler secret put TELEGRAM_WEBHOOK_SECRET
```

可选变量（写在 `wrangler.toml` 的 `[vars]` 下）：

```toml
[vars]
WEBHOOK_PATH = "/webhook"
PROFILE_TABLE = "profiles"
```

## 4. Deploy worker

```bash
npx wrangler deploy
```

## 5. Set Telegram webhook

```bash
curl -X POST "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -d "url=https://<your-worker-domain>/webhook" \
  -d "secret_token=<YOUR_WEBHOOK_SECRET>" \
  -d "allowed_updates=[\"message\",\"callback_query\"]"
```

## 6. Health check

```bash
curl "https://<your-worker-domain>/healthz"
```

## profiles 表字段（至少）

建议包含：

- `name`
- `handle`（X 账号）
- `telegram`（Telegram 账号）
- `district`
- `region`
- `country`
- `bio`
- `profile_url`

查询逻辑是精确匹配（忽略 `@` 和大小写）。
