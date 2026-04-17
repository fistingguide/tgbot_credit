"use strict";
import { maybeHandleVidCommands, runScheduledVidPush } from "./addvid.js";

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

const SUPPORTED_LANGS = ["en", "zh-Hans", "zh-Hant", "ja", "ko", "es"];

const I18N = {
	choose_query_method: {
		en: "Choose a query method:",
		"zh-Hans": "请选择查询方式：",
		"zh-Hant": "請選擇查詢方式：",
		ja: "検索方法を選択してください：",
		ko: "조회 방식을 선택하세요:",
		es: "Elige un método de consulta:",
	},
	search_by_x: { en: "Search by X", "zh-Hans": "按X查询", "zh-Hant": "按X查詢", ja: "Xで検索", ko: "X로 조회", es: "Buscar por X" },
	search_by_tg: {
		en: "Search by Telegram",
		"zh-Hans": "按Telegram查询",
		"zh-Hant": "按Telegram查詢",
		ja: "Telegramで検索",
		ko: "Telegram으로 조회",
		es: "Buscar por Telegram",
	},
	prompt_x: {
		en: "[QUERY_MODE:x] Enter an X handle (e.g. @demo or demo)",
		"zh-Hans": "[QUERY_MODE:x] 请输入X句柄（例如 @demo 或 demo）",
		"zh-Hant": "[QUERY_MODE:x] 請輸入X句柄（例如 @demo 或 demo）",
		ja: "[QUERY_MODE:x] Xハンドルを入力してください（例: @demo または demo）",
		ko: "[QUERY_MODE:x] X 핸들을 입력하세요 (예: @demo 또는 demo)",
		es: "[QUERY_MODE:x] Ingresa un handle de X (ej. @demo o demo)",
	},
	prompt_tg: {
		en: "[QUERY_MODE:tg] Enter a Telegram username (e.g. @demo or demo)",
		"zh-Hans": "[QUERY_MODE:tg] 请输入Telegram用户名（例如 @demo 或 demo）",
		"zh-Hant": "[QUERY_MODE:tg] 請輸入Telegram用戶名（例如 @demo 或 demo）",
		ja: "[QUERY_MODE:tg] Telegramユーザー名を入力してください（例: @demo または demo）",
		ko: "[QUERY_MODE:tg] Telegram 사용자명을 입력하세요 (예: @demo 또는 demo)",
		es: "[QUERY_MODE:tg] Ingresa un usuario de Telegram (ej. @demo o demo)",
	},
	profile_x_check_prompt: {
		en: "[PROFILE_X_CHECK] Please reply with your X handle (e.g. @demo or demo)",
		"zh-Hans": "[PROFILE_X_CHECK] 请回复你的X句柄（例如 @demo 或 demo）",
		"zh-Hant": "[PROFILE_X_CHECK] 請回覆你的X句柄（例如 @demo 或 demo）",
		ja: "[PROFILE_X_CHECK] あなたのXハンドルを返信してください（例: @demo または demo）",
		ko: "[PROFILE_X_CHECK] 본인 X 핸들을 답장으로 입력하세요 (예: @demo 또는 demo)",
		es: "[PROFILE_X_CHECK] Responde con tu handle de X (ej. @demo o demo)",
	},
	type_x_handle: { en: "Type your X handle", "zh-Hans": "输入你的X句柄", "zh-Hant": "輸入你的X句柄", ja: "Xハンドルを入力", ko: "X 핸들 입력", es: "Escribe tu handle de X" },
	type_tg_username: { en: "Type Telegram username", "zh-Hans": "输入Telegram用户名", "zh-Hant": "輸入Telegram用戶名", ja: "Telegramユーザー名を入力", ko: "Telegram 사용자명 입력", es: "Escribe usuario de Telegram" },
	send_me_to_start: { en: "Send /me to start searching.", "zh-Hans": "发送 /me 开始查询。", "zh-Hant": "發送 /me 開始查詢。", ja: "/me を送信して開始。", ko: "/me 를 보내 시작하세요.", es: "Envía /me para empezar." },
	switch_x: { en: "Switched to X search", "zh-Hans": "已切换到X查询", "zh-Hant": "已切換到X查詢", ja: "X検索に切り替えました", ko: "X 조회로 전환됨", es: "Cambiado a búsqueda por X" },
	switch_tg: { en: "Switched to Telegram search", "zh-Hans": "已切换到Telegram查询", "zh-Hant": "已切換到Telegram查詢", ja: "Telegram検索に切り替えました", ko: "Telegram 조회로 전환됨", es: "Cambiado a búsqueda por Telegram" },
	usage_x: { en: "Usage: /x <handle>", "zh-Hans": "用法: /x <handle>", "zh-Hant": "用法: /x <handle>", ja: "使い方: /x <handle>", ko: "사용법: /x <handle>", es: "Uso: /x <handle>" },
	usage_tg: { en: "Usage: /tg <username>", "zh-Hans": "用法: /tg <username>", "zh-Hant": "用法: /tg <username>", ja: "使い方: /tg <username>", ko: "사용법: /tg <username>", es: "Uso: /tg <username>" },
	no_matching_account: { en: "No matching account found.", "zh-Hans": "未找到匹配账号。", "zh-Hant": "未找到匹配帳號。", ja: "一致するアカウントが見つかりません。", ko: "일치하는 계정을 찾을 수 없습니다.", es: "No se encontró una cuenta coincidente." },
	multiple_matches: {
		en: "Multiple matches found. Please provide a more specific account.",
		"zh-Hans": "找到多个匹配，请提供更具体的账号。",
		"zh-Hant": "找到多個匹配，請提供更具體的帳號。",
		ja: "複数の候補が見つかりました。より具体的に指定してください。",
		ko: "여러 결과가 있습니다. 더 구체적으로 입력하세요.",
		es: "Se encontraron múltiples coincidencias. Proporciona una cuenta más específica.",
	},
	multiple_profiles_tg: {
		en: "Multiple profiles found for your Telegram username. Please contact admin.",
		"zh-Hans": "你的Telegram用户名匹配到多个档案，请联系管理员。",
		"zh-Hant": "你的Telegram用戶名匹配到多個檔案，請聯繫管理員。",
		ja: "Telegramユーザー名に複数のプロフィールが見つかりました。管理者に連絡してください。",
		ko: "Telegram 사용자명으로 여러 프로필이 발견되었습니다. 관리자에게 문의하세요.",
		es: "Se encontraron varios perfiles para tu usuario de Telegram. Contacta al administrador.",
	},
	multiple_profiles_x: {
		en: "Multiple profiles found for this X handle. Please provide a more specific handle.",
		"zh-Hans": "这个X句柄匹配到多个档案，请提供更具体的句柄。",
		"zh-Hant": "這個X句柄匹配到多個檔案，請提供更具體的句柄。",
		ja: "このXハンドルに複数のプロフィールが見つかりました。より具体的に入力してください。",
		ko: "이 X 핸들로 여러 프로필이 발견되었습니다. 더 구체적으로 입력하세요.",
		es: "Se encontraron varios perfiles para este handle de X. Proporciona uno más específico.",
	},
	no_profile_found_create: {
		en: "No profile found. Please create your profile first.",
		"zh-Hans": "未找到档案，请先创建档案。",
		"zh-Hant": "未找到檔案，請先建立檔案。",
		ja: "プロフィールが見つかりません。先にプロフィールを作成してください。",
		ko: "프로필이 없습니다. 먼저 프로필을 생성하세요.",
		es: "No se encontró perfil. Crea tu perfil primero.",
	},
	profile_exists_edit: {
		en: "Your profile exists. Please update your profile information here.",
		"zh-Hans": "你的档案已存在，请在这里更新档案信息。",
		"zh-Hant": "你的檔案已存在，請在這裡更新檔案資訊。",
		ja: "プロフィールは存在します。こちらでプロフィール情報を更新してください。",
		ko: "프로필이 이미 있습니다. 여기서 프로필 정보를 수정하세요.",
		es: "Tu perfil existe. Actualiza aquí la información de tu perfil.",
	},
	profile_exists_missing_tg: {
		en: "Your profile exists, but Telegram username is missing. Please add your Telegram first.",
		"zh-Hans": "你的档案已存在，但缺少Telegram用户名，请先补充。",
		"zh-Hant": "你的檔案已存在，但缺少Telegram用戶名，請先補充。",
		ja: "プロフィールは存在しますが、Telegramユーザー名がありません。先に追加してください。",
		ko: "프로필은 있지만 Telegram 사용자명이 없습니다. 먼저 추가하세요.",
		es: "Tu perfil existe, pero falta el usuario de Telegram. Agrégalo primero.",
	},
	create_my_profile: { en: "create my profile", "zh-Hans": "创建我的档案", "zh-Hant": "建立我的檔案", ja: "プロフィールを作成", ko: "프로필 만들기", es: "crear mi perfil" },
	edit_my_profile: { en: "edit my profile", "zh-Hans": "编辑我的档案", "zh-Hant": "編輯我的檔案", ja: "プロフィールを編集", ko: "프로필 수정", es: "editar mi perfil" },
	add_my_telegram: { en: "add my telegram", "zh-Hans": "添加我的Telegram", "zh-Hant": "添加我的Telegram", ja: "Telegramを追加", ko: "내 Telegram 추가", es: "agregar mi telegram" },
	no_x_profiles_credit: {
		en: "No X profiles with total credit found.",
		"zh-Hans": "未找到有总积分的X档案。",
		"zh-Hant": "未找到有總積分的X檔案。",
		ja: "総クレジットのあるXプロフィールが見つかりません。",
		ko: "총 크레딧이 있는 X 프로필이 없습니다.",
		es: "No se encontraron perfiles de X con crédito total.",
	},
	fglist_title: { en: "FGList ({page}/{totalPages}):", "zh-Hans": "FGList ({page}/{totalPages})：", "zh-Hant": "FGList ({page}/{totalPages})：", ja: "FGList ({page}/{totalPages})：", ko: "FGList ({page}/{totalPages}):", es: "FGList ({page}/{totalPages}):" },
	list_top_x: { en: "Ｘ Our X", "zh-Hans": "Ｘ 官方X", "zh-Hant": "Ｘ 官方X", ja: "Ｘ 公式X", ko: "Ｘ 공식 X", es: "Ｘ Nuestro X" },
	list_top_website: { en: "🌐 Our Website", "zh-Hans": "🌐 官方网站", "zh-Hant": "🌐 官方網站", ja: "🌐 公式サイト", ko: "🌐 웹사이트", es: "🌐 Nuestro sitio web" },
	prev: { en: "⬅ Prev", "zh-Hans": "⬅ 上一页", "zh-Hant": "⬅ 上一頁", ja: "⬅ 前へ", ko: "⬅ 이전", es: "⬅ Anterior" },
	next: { en: "Next ➡", "zh-Hans": "下一页 ➡", "zh-Hant": "下一頁 ➡", ja: "次へ ➡", ko: "다음 ➡", es: "Siguiente ➡" },
	profile_title: { en: "<b>🔎FistingGuide Profile</b>", "zh-Hans": "<b>🔎FistingGuide Profile</b>", "zh-Hant": "<b>🔎FistingGuide Profile</b>", ja: "<b>🔎FistingGuide Profile</b>", ko: "<b>🔎FistingGuide Profile</b>", es: "<b>🔎FistingGuide Profile</b>" },
	daily_updates: { en: "<b>Daily updates</b>", "zh-Hans": "<b>每日更新</b>", "zh-Hant": "<b>每日更新</b>", ja: "<b>毎日更新</b>", ko: "<b>매일 업데이트</b>", es: "<b>Actualizaciones diarias</b>" },
	credit_guide_line: {
		en: "You can earn credits by increasing your X followers, chatting in tg groups, sending images and videos, joining campaigns, or becoming an admin. Leaderboard ranking is based on your total credit.",
		"zh-Hans": "你可以通过提升X的粉丝数量、在tg群里聊天、发送图片和视频、参加campaign，或者成为管理员来获取积分。榜单排名的依据是你的总积分。",
		"zh-Hant": "你可以透過提升X的粉絲數量、在tg群裡聊天、發送圖片和影片、參加campaign，或成為管理員來獲取積分。榜單排名依據你的總積分。",
		ja: "Xのフォロワー数を増やすこと、tgグループでのチャット、画像や動画の送信、campaignへの参加、または管理者になることでクレジットを獲得できます。ランキングは総クレジットに基づきます。",
		ko: "X 팔로워 수를 늘리고, tg 그룹에서 채팅하고, 이미지와 영상을 보내고, campaign에 참여하거나, 관리자가 되어 크레딧을 획득할 수 있습니다. 랭킹은 총 크레딧을 기준으로 합니다.",
		es: "Puedes obtener créditos aumentando tus seguidores en X, chateando en grupos de tg, enviando imágenes y videos, participando en campañas o convirtiéndote en administrador. La clasificación del leaderboard se basa en tu crédito total.",
	},
	x_empty: { en: "𝕏 <b>X</b>: (empty)", "zh-Hans": "𝕏 <b>X</b>: （空）", "zh-Hant": "𝕏 <b>X</b>: （空）", ja: "𝕏 <b>X</b>: （空）", ko: "𝕏 <b>X</b>: (없음)", es: "𝕏 <b>X</b>: (vacío)" },
	tg_empty: { en: "💬 <b>Telegram</b>: (empty)", "zh-Hans": "💬 <b>Telegram</b>: （空）", "zh-Hant": "💬 <b>Telegram</b>: （空）", ja: "💬 <b>Telegram</b>: （空）", ko: "💬 <b>Telegram</b>: (없음)", es: "💬 <b>Telegram</b>: (vacío)" },
	location_label: { en: "Location", "zh-Hans": "地点", "zh-Hant": "地點", ja: "場所", ko: "위치", es: "Ubicación" },
	bio_label: { en: "Bio", "zh-Hans": "简介", "zh-Hant": "簡介", ja: "自己紹介", ko: "소개", es: "Bio" },
	profile_link_label: { en: "Profile", "zh-Hans": "档案", "zh-Hant": "檔案", ja: "プロフィール", ko: "프로필", es: "Perfil" },
	credit_title: { en: "<b>⭐FistingGuide Credit</b>", "zh-Hans": "<b>⭐FistingGuide Credit</b>", "zh-Hant": "<b>⭐FistingGuide Credit</b>", ja: "<b>⭐FistingGuide Credit</b>", ko: "<b>⭐FistingGuide Credit</b>", es: "<b>⭐FistingGuide Credit</b>" },
	liststar_event_credit: { en: "ListStar Event Credit", "zh-Hans": "ListStar活动积分", "zh-Hant": "ListStar活動積分", ja: "ListStarイベントクレジット", ko: "ListStar 이벤트 크레딧", es: "Crédito de evento ListStar" },
	super_credit: { en: "Super Credit", "zh-Hans": "超级积分", "zh-Hant": "超級積分", ja: "スーパークレジット", ko: "슈퍼 크레딧", es: "Súper crédito" },
	current_rank: { en: "Current Rank", "zh-Hans": "当前排名", "zh-Hant": "當前排名", ja: "現在の順位", ko: "현재 순위", es: "Rango actual" },
	total_credit: { en: "Total Credit", "zh-Hans": "总积分", "zh-Hant": "總積分", ja: "総クレジット", ko: "총 크레딧", es: "Crédito total" },
	website_btn: { en: "🌐 Website", "zh-Hans": "🌐 网站", "zh-Hant": "🌐 網站", ja: "🌐 サイト", ko: "🌐 웹사이트", es: "🌐 Sitio web" },
	query_failed: { en: "Query failed. Please try again later.", "zh-Hans": "查询失败，请稍后再试。", "zh-Hant": "查詢失敗，請稍後再試。", ja: "検索に失敗しました。後でもう一度お試しください。", ko: "조회에 실패했습니다. 잠시 후 다시 시도하세요.", es: "La consulta falló. Inténtalo más tarde." },
	campaign_menu_title: {
		en: "Campaign Center",
		"zh-Hans": "活动中心",
		"zh-Hant": "活動中心",
		ja: "キャンペーンセンター",
		ko: "캠페인 센터",
		es: "Centro de campañas",
	},
	campaign_btn_list_star: { en: "List Star ⭐1000", "zh-Hans": "List Star ⭐1000", "zh-Hant": "List Star ⭐1000", ja: "List Star ⭐1000", ko: "List Star ⭐1000", es: "List Star ⭐1000" },
	campaign_btn_authors: { en: "Call For Authors ⭐2000", "zh-Hans": "Call For Authors ⭐2000", "zh-Hant": "Call For Authors ⭐2000", ja: "Call For Authors ⭐2000", ko: "Call For Authors ⭐2000", es: "Call For Authors ⭐2000" },
	campaign_list_star_text: {
		en: `📣

List Star Project is live! 🚀 For one month, we will promote outstanding fisting enthusiasts for free on the website and X! 🌐𝕏 As a List Star, you will receive ✨
1. Official List top placement 🏆
2. One exclusive poster 🖼️
3. Promotion on the official X account 📢
4. 1000 FG credit ⭐1000

How to join? 🙌
1. A photo of the upper body with the face hidden, 📸
2. A fisting video, 🎬
3. A caption/copy about the video. ✍️
4. send those to our X or tg 📩`,
		"zh-Hans": `📣

List Star 项目现已上线！🚀 在一个月内，我们将在网站和 X 上免费推广优秀的 fisting 爱好者！🌐𝕏 作为 List Star 你将获得 ✨
1. 官方榜单置顶展示 🏆
2. 一张专属海报 🖼️
3. 官方 X 账号推广 📢
4. 1000 FG credit ⭐1000

如何参与？🙌
1. 一张上半身且遮挡面部的照片，📸
2. 一段 fisting 视频，🎬
3. 与视频相关的文案说明。✍️
4. 发送到我们的 X 或 tg 📩`,
		"zh-Hant": `📣

List Star 專案現已上線！🚀 在一個月內，我們將在網站和 X 上免費推廣優秀的 fisting 愛好者！🌐𝕏 作為 List Star 你將獲得 ✨
1. 官方榜單置頂展示 🏆
2. 一張專屬海報 🖼️
3. 官方 X 帳號推廣 📢
4. 1000 FG credit ⭐1000

如何參與？🙌
1. 一張上半身且遮擋面部的照片，📸
2. 一段 fisting 影片，🎬
3. 與影片相關的文案說明。✍️
4. 發送到我們的 X 或 tg 📩`,
		ja: `📣

List Starプロジェクトが開始しました！🚀 1か月間、優れた fisting 愛好者をWebサイトとXで無料プロモーションします！🌐𝕏 List Starになると以下を獲得できます ✨
1. 公式リスト上位掲載 🏆
2. 専用ポスター1枚 🖼️
3. 公式Xアカウントでの紹介 📢
4. 1000 FG credit ⭐1000

参加方法 🙌
1. 顔を隠した上半身写真、📸
2. fisting 動画、🎬
3. 動画の説明文（キャプション）。✍️
4. これらを私たちの X または tg に送信 📩`,
		ko: `📣

List Star 프로젝트가 시작되었습니다! 🚀 한 달 동안 뛰어난 fisting 애호가를 웹사이트와 X에서 무료로 홍보합니다! 🌐𝕏 List Star가 되면 다음을 받게 됩니다 ✨
1. 공식 리스트 상단 노출 🏆
2. 전용 포스터 1장 🖼️
3. 공식 X 계정 홍보 📢
4. 1000 FG credit ⭐1000

참여 방법 🙌
1. 얼굴을 가린 상반신 사진, 📸
2. fisting 영상, 🎬
3. 영상에 대한 캡션/설명 문구. ✍️
4. 위 자료를 우리의 X 또는 tg 로 전송 📩`,
		es: `📣

¡El proyecto List Star ya está activo! 🚀 Durante un mes, promocionaremos gratis en el sitio web y en X a entusiastas destacados del fisting. 🌐𝕏 Como List Star recibirás ✨
1. Posición destacada en la lista oficial 🏆
2. Un póster exclusivo 🖼️
3. Promoción en la cuenta oficial de X 📢
4. 1000 FG credit ⭐1000

¿Cómo participar? 🙌
1. Una foto del torso superior con el rostro oculto, 📸
2. Un video de fisting, 🎬
3. Un texto/copy sobre el video. ✍️
4. Envíalo a nuestro X o tg 📩`,
	},
	campaign_authors_text: {
		en: `Hey everyone! 👋
We are launching a long-term event for sharing fisting experiences and collecting fisting stories. If you are interested, you are welcome to join.Anonymous submissions are supported and both short and long stories are welcome . ✨

What We Are Collecting 🧩
1. Beginner-friendly guidance on how to start fisting safely 🛡️
2. Enema methods, precautions, and practical tips 💡
3. Safety techniques during fisting, lubricant choices, and common problems with solutions 🧴
4. Real personal stories (solo or with a partner), feelings, and insights ❤️
5. Toy recommendations, usage experiences, and maintenance tips 🧸

Reward: Every valid submission receives 2000 FG credits ⭐2000`,
		"zh-Hans": `大家好！👋
我们正在发起一个长期活动，用于分享 fisting 经验并征集 fisting 故事。如果你感兴趣，欢迎参与。支持匿名投稿，长文和短文都欢迎。✨

征集内容 🧩
1. 适合新手的安全开始 fisting 指南 🛡️
2. Enema 的方法、注意事项和实用技巧 💡
3. fisting 过程中的安全技巧、润滑剂选择，以及常见问题与解决方案 🧴
4. 真实个人故事（单人或与伴侣）、感受和心得 ❤️
5. 玩具推荐、使用体验和维护技巧 🧸

奖励：每份有效投稿可获得 2000 FG credits ⭐2000`,
		"zh-Hant": `大家好！👋
我們正在發起一個長期活動，用於分享 fisting 經驗並徵集 fisting 故事。如果你有興趣，歡迎參與。支援匿名投稿，長文和短文都歡迎。✨

徵集內容 🧩
1. 適合新手的安全開始 fisting 指南 🛡️
2. Enema 的方法、注意事項和實用技巧 💡
3. fisting 過程中的安全技巧、潤滑劑選擇，以及常見問題與解決方案 🧴
4. 真實個人故事（單人或與伴侶）、感受和心得 ❤️
5. 玩具推薦、使用體驗和維護技巧 🧸

獎勵：每份有效投稿可獲得 2000 FG credits ⭐2000`,
		ja: `みなさん、こんにちは！👋
fisting の体験共有と fisting ストーリー収集のための長期イベントを開始します。興味のある方はぜひご参加ください。匿名投稿OK、短文・長文どちらも歓迎です。✨

募集内容 🧩
1. 初心者向けの安全な fisting の始め方 🛡️
2. Enema の方法、注意点、実践的なコツ 💡
3. fisting 中の安全テクニック、潤滑剤の選び方、よくある問題と解決策 🧴
4. 実際の個人ストーリー（ソロまたはパートナー）、感想や気づき ❤️
5. トイのおすすめ、使用体験、メンテナンスのコツ 🧸

報酬：有効な投稿ごとに 2000 FG credits ⭐2000`,
		ko: `안녕하세요! 👋
fisting 경험 공유와 fisting 스토리 수집을 위한 장기 이벤트를 시작합니다. 관심 있는 분들은 누구나 환영합니다. 익명 제출 가능, 짧은 글/긴 글 모두 환영합니다. ✨

모집 내용 🧩
1. 초보자를 위한 안전한 fisting 시작 가이드 🛡️
2. Enema 방법, 주의사항, 실전 팁 💡
3. fisting 중 안전 테크닉, 윤활제 선택, 자주 발생하는 문제와 해결법 🧴
4. 실제 개인 스토리(혼자 또는 파트너와), 느낌과 인사이트 ❤️
5. 토이 추천, 사용 경험, 관리 팁 🧸

보상: 유효한 제출 1건당 2000 FG credits ⭐2000`,
		es: `¡Hola a todos! 👋
Estamos lanzando un evento a largo plazo para compartir experiencias de fisting y recopilar historias de fisting. Si te interesa, eres bienvenido a participar. Se aceptan envíos anónimos y textos largos o cortos. ✨

Qué estamos recopilando 🧩
1. Guía para principiantes sobre cómo empezar fisting de forma segura 🛡️
2. Métodos de Enema, precauciones y consejos prácticos 💡
3. Técnicas de seguridad durante fisting, elección de lubricantes y soluciones a problemas comunes 🧴
4. Historias personales reales (solo o con pareja), sensaciones e ideas ❤️
5. Recomendaciones de toys, experiencias de uso y consejos de mantenimiento 🧸

Recompensa: Cada envío válido recibe 2000 FG credits ⭐2000`,
	},
};

function parseGroupIds(raw) {
	return new Set(
		String(raw || "")
			.split(/[,\s;|，]+/)
			.map((s) => s.trim())
			.filter(Boolean)
	);
}

function getChatLang(env, chatId) {
	const id = String(chatId || "").trim();
	if (!id) return "en";
	const mapping = [
		["zh-Hans", env.LANG_GROUPS_ZH_HANS],
		["zh-Hant", env.LANG_GROUPS_ZH_HANT],
		["ja", env.LANG_GROUPS_JA],
		["ko", env.LANG_GROUPS_KO],
		["es", env.LANG_GROUPS_ES],
		["en", env.LANG_GROUPS_EN],
	];
	for (const [lang, raw] of mapping) {
		if (parseGroupIds(raw).has(id)) return lang;
	}
	return "en";
}

function t(lang, key, vars = {}) {
	const safeLang = SUPPORTED_LANGS.includes(lang) ? lang : "en";
	const msg = I18N[key]?.[safeLang] || I18N[key]?.en || key;
	return String(msg).replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ""));
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

function isPrivateChat(chat) {
	return String(chat?.type || "") === "private";
}

function isUpdaterankAdmin(env, userId) {
	const adminId = String(env.UPDATERANK_ADMIN_TG_USER_ID || env.ADMIN_TG_USER_ID || "").trim();
	if (!adminId) return false;
	return String(userId || "").trim() === adminId;
}

function buildIncrements(message) {
	const text = String(message?.text || "").trim();
	const cmd = normalizeCommand(text);
	const isCreditCmd = cmd === "/me" || cmd === "/list" || cmd === "/campaign" || cmd === "/updaterank";
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

function scheduleDeleteMessage(env, ctx, chatId, messageId, delayMs) {
	if (!ctx || !chatId || !messageId || !Number.isFinite(delayMs) || delayMs <= 0) return;
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

async function sendModeButtons(env, chatId, lang) {
	return tg(env, "sendMessage", {
		chat_id: chatId,
		text: t(lang, "choose_query_method"),
		reply_markup: {
			inline_keyboard: [
				[
					{ text: t(lang, "search_by_x"), callback_data: "mode_x" },
					{ text: t(lang, "search_by_tg"), callback_data: "mode_tg" },
				],
			],
		},
	});
}

function buildPrompt(mode, lang) {
	if (mode === "x") {
		return t(lang, "prompt_x");
	}
	return t(lang, "prompt_tg");
}

function buildProfileXCheckPrompt(lang) {
	return t(lang, "profile_x_check_prompt");
}

async function askForInput(env, chatId, mode, lang) {
	return tg(env, "sendMessage", {
		chat_id: chatId,
		text: buildPrompt(mode, lang),
		reply_markup: {
			force_reply: true,
			input_field_placeholder: mode === "x" ? t(lang, "type_x_handle") : t(lang, "type_tg_username"),
		},
	});
}

function extractModeFromReply(message) {
	const repliedText = String(message?.reply_to_message?.text || "");
	const match = repliedText.match(/\[QUERY_MODE:(x|tg)\]/i);
	return match ? match[1].toLowerCase() : "";
}

function isProfileXCheckReply(message) {
	const repliedText = String(message?.reply_to_message?.text || "");
	return /\[PROFILE_X_CHECK\]/i.test(repliedText);
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
	return buildAllCreditKeyboardByPage(safeRows, 0, safeRows.length, {}, "en").reply_markup;
}

const ALL_CREDIT_PAGE_SIZE = 10;

function buildListTopButtons(env, lang) {
	const xUrl = normalizeUrl(env?.LIST_TOP_X_URL || env?.MY_X_URL || "https://x.com/FistingGuide");
	const websiteUrl = normalizeUrl(env?.LIST_TOP_WEBSITE_URL || env?.WEBSITE_URL || "https://www.fisting.guide");
	return [
		{ text: t(lang, "list_top_x"), url: xUrl },
		{ text: t(lang, "list_top_website"), url: websiteUrl },
	];
}

function buildAllCreditKeyboardByPage(rows, page, totalRows, env, lang) {
	const safeRows = Array.isArray(rows) ? rows : [];
	const safeTotalRows = Math.max(0, Number(totalRows || 0));
	const totalPages = Math.max(1, Math.ceil(safeTotalRows / ALL_CREDIT_PAGE_SIZE));
	const safePage = Math.max(0, Math.min(Number(page || 0), totalPages - 1));

	const inline_keyboard = [buildListTopButtons(env, lang)];
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
			navRow.push({ text: t(lang, "prev"), callback_data: `credit_page:${safePage - 1}` });
		}
		navRow.push({ text: `${safePage + 1}/${totalPages}`, callback_data: "credit_page:noop" });
		if (safePage < totalPages - 1) {
			navRow.push({ text: t(lang, "next"), callback_data: `credit_page:${safePage + 1}` });
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

async function updateRankByTotalCredit(env) {
	const table = getProfilesTable(env);
	const sql =
		`WITH ranked AS (` +
		`SELECT rowid AS rid, ROW_NUMBER() OVER (` +
		`ORDER BY COALESCE(total_credit, 0) DESC, COALESCE(list_star_event_cnt, 0) DESC, rowid ASC` +
		`) AS new_rank FROM ${table}` +
		`) ` +
		`UPDATE ${table} SET rank = (` +
		`SELECT new_rank FROM ranked WHERE ranked.rid = ${table}.rowid` +
		`)`;
	const res = await env.DB.prepare(sql).run();
	return Number(res?.meta?.changes || 0);
}

async function recalculateAllTotalCredit(env) {
	const table = getProfilesTable(env);
	const sql =
		`UPDATE ${table} SET total_credit = ` +
		"(COALESCE(CAST(followers_count AS REAL), 0) / 10.0) + " +
		"(COALESCE(tg_msg_cnt, 0) * 1) + " +
		"(COALESCE(tg_photo_cnt, 0) * 2) + " +
		"(COALESCE(tg_video_cnt, 0) * 10) + " +
		"COALESCE(list_star_event_cnt, 0) + " +
		"COALESCE(super_credit, 0)";
	const res = await env.DB.prepare(sql).run();
	return Number(res?.meta?.changes || 0);
}

function formatMyCredit(row, lang) {
	if (!row) {
		return t(lang, "no_matching_account");
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
		t(lang, "credit_title"),
		"━━━━━━━━━━━━",
		`👤 <b>${name}</b>${xHandle ? `   𝕏<b>${xHandle}</b>` : ""}`,
		`🐦<b>${followersCount}</b> 💬<b>${msg}</b> 🖼️<b>${photo}</b> 🎬<b>${video}</b>`,
		`🎯${t(lang, "liststar_event_credit")} <b>${listStarEventCnt}</b> ⚡${t(lang, "super_credit")} <b>${superCredit}</b>`,
		`🏆${t(lang, "current_rank")} <b>${rank}</b>/<b>${totalRows}</b>   ⭐${t(lang, "total_credit")} <b>${total}</b>`,
		"━━━━━━━━━━━━",
	].join("\n");
}

function normalizeUrl(value) {
	const raw = String(value || "").trim();
	if (!raw) return "";
	if (/^https?:\/\//i.test(raw)) return raw;
	return `https://${raw}`;
}

function buildMyProfileButtons(profileRow, creditRow, env, lang) {
	const xHandle = normalizeInput(profileRow?.handle || creditRow?.x_handle);
	const xUrl = xHandle ? `https://x.com/${encodeURIComponent(xHandle)}` : "";

	const profileUrl = normalizeUrl(profileRow?.profile_url);
	const isXProfileUrl = /^(https?:\/\/)?(www\.)?(x\.com|twitter\.com)\//i.test(profileUrl);
	const fallbackWebsite = normalizeUrl(env.MY_WEBSITE_URL || env.WEBSITE_URL || "https://www.fisting.guide");
	const websiteUrl = profileUrl && !isXProfileUrl ? profileUrl : fallbackWebsite;

	const row = [];
	if (xUrl) row.push({ text: "Ｘ", url: xUrl });
	if (websiteUrl) row.push({ text: t(lang, "website_btn"), url: websiteUrl });
	return row.length > 0 ? { inline_keyboard: [row] } : undefined;
}

function formatMeCombined(profileRow, creditRow, lang) {
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
		t(lang, "profile_title"),
		t(lang, "daily_updates"),
		t(lang, "credit_guide_line"),
		"━━━━━━━━━━━━",
		`👤 <b>${profileName}</b>`,
		xHandle ? `𝕏 <b>X</b>: @${xHandle}` : t(lang, "x_empty"),
		telegram ? `💬 <b>Telegram</b>: @${telegram}` : t(lang, "tg_empty"),
		`📍 <b>${t(lang, "location_label")}</b>: ${district} / ${region} / ${country}`,
		bio ? `📝 <b>${t(lang, "bio_label")}</b>: ${bio}` : "",
		"━━━━━━━━━━━━",
		t(lang, "credit_title"),
		"━━━━━━━━━━━━",
		`🐦<b>${followersCount}</b> 💬<b>${msg}</b> 🖼️<b>${photo}</b> 🎬<b>${video}</b>`,
		`🎯${t(lang, "liststar_event_credit")} <b>${listStarEventCnt}</b> ⚡${t(lang, "super_credit")} <b>${superCredit}</b>`,
		`🏆${t(lang, "current_rank")} <b>${rank}</b>/<b>${totalRows}</b>   ⭐${t(lang, "total_credit")} <b>${total}</b>`,
		"━━━━━━━━━━━━",
	]
		.filter(Boolean)
		.join("\n");
}

const PROFILE_EDIT_URL = "https://fisting.guide/admin/edit";
const PROFILE_CREATE_URL = "https://fisting.guide/admin/create";
const GROUP_REPLY_TTL_MS = 60 * 60 * 1000;
const TOTAL_CREDIT_SQL_EXPR =
	"(COALESCE(CAST(followers_count AS REAL), 0) / 10.0) + " +
	"(COALESCE(tg_msg_cnt, 0) * 1) + " +
	"(COALESCE(tg_photo_cnt, 0) * 2) + " +
	"(COALESCE(tg_video_cnt, 0) * 10) + " +
	"COALESCE(list_star_event_cnt, 0) + " +
	"COALESCE(super_credit, 0)";

async function sendAskXHandleForProfile(env, chatId, lang) {
	return tg(env, "sendMessage", {
		chat_id: chatId,
		text: buildProfileXCheckPrompt(lang),
		reply_markup: {
			force_reply: true,
			input_field_placeholder: t(lang, "type_x_handle"),
		},
	});
}

async function sendProfileActionByXHandle(env, chatId, xHandleInput, lang) {
	const rows = await queryProfilesByX(env, xHandleInput);
	if (rows.length > 1) {
		return tg(env, "sendMessage", {
			chat_id: chatId,
			text: t(lang, "multiple_profiles_x"),
		});
	}

	if (rows.length === 0) {
		return tg(env, "sendMessage", {
			chat_id: chatId,
			text: t(lang, "no_profile_found_create"),
			reply_markup: {
				inline_keyboard: [[{ text: t(lang, "create_my_profile"), url: PROFILE_CREATE_URL }]],
			},
		});
	}

	const matched = rows[0];
	const hasTelegram = Boolean(normalizeInput(matched?.telegram));
	return tg(env, "sendMessage", {
		chat_id: chatId,
		text: hasTelegram
			? t(lang, "profile_exists_edit")
			: t(lang, "profile_exists_missing_tg"),
		reply_markup: {
			inline_keyboard: [
				[
					{
						text: hasTelegram ? t(lang, "edit_my_profile") : t(lang, "add_my_telegram"),
						url: PROFILE_EDIT_URL,
					},
				],
			],
		},
	});
}

async function sendAllCredit(env, chatId, lang) {
	const totalRows = await queryAllCreditCount(env);
	if (totalRows === 0) {
		return tg(env, "sendMessage", {
			chat_id: chatId,
			text: t(lang, "no_x_profiles_credit"),
		});
	}
	const rows = await queryAllCreditRowsByPage(env, 0);
	const paged = buildAllCreditKeyboardByPage(rows, 0, totalRows, env, lang);

	return tg(env, "sendMessage", {
		chat_id: chatId,
		text: t(lang, "fglist_title", { page: paged.page + 1, totalPages: paged.totalPages }),
		reply_markup: paged.reply_markup,
	});
}

async function sendCampaignMenu(env, chatId, lang) {
	return tg(env, "sendMessage", {
		chat_id: chatId,
		text: t(lang, "campaign_menu_title"),
		reply_markup: {
			inline_keyboard: [
				[{ text: t(lang, "campaign_btn_list_star"), callback_data: "campaign:list_star" }],
				[{ text: t(lang, "campaign_btn_authors"), callback_data: "campaign:authors" }],
			],
		},
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

async function sendMyCredit(env, chatId, userId, telegramUsername, lang) {
	const row = await queryMyCreditRow(env, userId, telegramUsername);
	if (!row) {
		return sendAskXHandleForProfile(env, chatId, lang);
	}
	return tg(env, "sendMessage", {
		chat_id: chatId,
		text: formatMyCredit(row, lang),
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

function formatRow(row, lang) {
	const name = escapeHtml(row?.name || "Unnamed");
	const handle = escapeHtml(row?.handle || "");
	const telegram = escapeHtml(row?.telegram || "");
	const district = escapeHtml(row?.district || row?.city || "Unknown");
	const region = escapeHtml(row?.region || row?.province || "Unknown");
	const country = escapeHtml(row?.country || "Unknown");
	const bio = escapeHtml(row?.bio || "");
	const profileUrl = escapeHtml(row?.profile_url || "");

	const lines = [
		t(lang, "profile_title"),
		t(lang, "daily_updates"),
		"━━━━━━━━━━━━",
		`👤 <b>${name}</b>`,
		handle ? `𝕏 <b>X</b>: @${handle}` : t(lang, "x_empty"),
		telegram ? `💬 <b>Telegram</b>: @${telegram}` : t(lang, "tg_empty"),
		`📍 <b>${t(lang, "location_label")}</b>: ${district} / ${region} / ${country}`,
		profileUrl ? `🔗 <b>${t(lang, "profile_link_label")}</b>: ${profileUrl}` : "",
		bio ? `📝 <b>${t(lang, "bio_label")}</b>: ${bio}` : "",
		"━━━━━━━━━━━━",
	].filter(Boolean);
	return lines.join("\n");
}

async function handleStart(env, chatId, lang) {
	await tg(env, "sendMessage", {
		chat_id: chatId,
		text: t(lang, "send_me_to_start"),
	});
}

async function handleMyProfile(env, message, ctx, lang) {
	const chatId = message?.chat?.id;
	const chat = message?.chat;
	const telegramUsername = normalizeInput(message?.from?.username).toLowerCase();
	if (!chatId) return;

	if (!telegramUsername) {
		return sendAskXHandleForProfile(env, chatId, lang);
	}

	try {
		const rows = await queryProfilesByTelegram(env, telegramUsername);
		if (rows.length === 0) {
			return sendAskXHandleForProfile(env, chatId, lang);
		}
		if (rows.length > 1) {
			return tg(env, "sendMessage", {
				chat_id: chatId,
				text: t(lang, "multiple_profiles_tg"),
			});
		}
		const creditRow = await queryMyCreditRow(env, message?.from?.id, message?.from?.username);
		return tg(env, "sendMessage", {
			chat_id: chatId,
			text: formatMeCombined(rows[0], creditRow, lang),
			parse_mode: "HTML",
			disable_web_page_preview: true,
			reply_markup: buildMyProfileButtons(rows[0], creditRow, env, lang),
		});
	} catch (err) {
		console.error(err);
		return tg(env, "sendMessage", { chat_id: chatId, text: t(lang, "query_failed") });
	}
}

async function handleCallback(env, callbackQuery) {
	const chatId = callbackQuery?.message?.chat?.id;
	const messageId = callbackQuery?.message?.message_id;
	const data = String(callbackQuery?.data || "");
	if (!chatId) return;
	const lang = getChatLang(env, chatId);

	if (data === "mode_x") {
		await tg(env, "answerCallbackQuery", { callback_query_id: callbackQuery.id, text: t(lang, "switch_x") });
		await askForInput(env, chatId, "x", lang);
		return;
	}

	if (data === "mode_tg") {
		await tg(env, "answerCallbackQuery", { callback_query_id: callbackQuery.id, text: t(lang, "switch_tg") });
		await askForInput(env, chatId, "tg", lang);
		return;
	}

	if (data === "credit_page:noop") {
		await tg(env, "answerCallbackQuery", { callback_query_id: callbackQuery.id });
		return;
	}

	if (data === "campaign:list_star") {
		await tg(env, "sendMessage", {
			chat_id: chatId,
			text: t(lang, "campaign_list_star_text"),
		});
		await tg(env, "answerCallbackQuery", { callback_query_id: callbackQuery.id });
		return;
	}

	if (data === "campaign:authors") {
		await tg(env, "sendMessage", {
			chat_id: chatId,
			text: t(lang, "campaign_authors_text"),
		});
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
		const paged = buildAllCreditKeyboardByPage(rows, safePage, totalRows, env, lang);
		if (messageId && paged.reply_markup) {
			await tg(env, "editMessageText", {
				chat_id: chatId,
				message_id: messageId,
				text: t(lang, "fglist_title", { page: paged.page + 1, totalPages: paged.totalPages }),
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
	const textOrCaption = String(message?.text || message?.caption || "").trim();
	if (!chatId) return;
	const lang = getChatLang(env, chatId);

	if (isGroupChat(chat)) {
		try {
			await upsertCredit(env, message);
		} catch (err) {
			console.error("upsertCredit failed:", err);
		}
	}

	const maybeVidCommand = normalizeCommand(textOrCaption);
	if (maybeVidCommand === "/addvid" || maybeVidCommand === "/vid") {
		try {
			const vidHandled = await maybeHandleVidCommands(env, message);
			if (vidHandled) return;
		} catch (err) {
			console.error("vid command failed:", err);
			await tg(env, "sendMessage", { chat_id: chatId, text: "Video command failed. Please try again later." });
			return;
		}
	}

	if (!text) return;

	// Prioritize core slash commands so they are not swallowed by reply-state branches.
	const hardCommand = normalizeCommand(text);
	const hardIsStartCmd = hardCommand === "/start" || hardCommand.startsWith("/start@");
	const hardIsHelpCmd = hardCommand === "/help" || hardCommand.startsWith("/help@");
	const hardIsMyprofileCmd = hardCommand === "/me" || hardCommand.startsWith("/me@");
	const hardIsListCmd = hardCommand === "/list" || hardCommand.startsWith("/list@");
	const hardIsCampaignCmd = hardCommand === "/campaign" || hardCommand.startsWith("/campaign@");
	const hardIsUpdateRankCmd = hardCommand === "/updaterank" || hardCommand.startsWith("/updaterank@");

	if (hardIsListCmd) {
		const sent = await sendAllCredit(env, chatId, lang);
		if (isGroupChat(chat)) {
			scheduleDeleteMessage(env, ctx, chatId, sent?.message_id, GROUP_REPLY_TTL_MS);
		}
		return;
	}

	if (hardIsCampaignCmd) {
		await sendCampaignMenu(env, chatId, lang);
		return;
	}

	if (hardIsUpdateRankCmd) {
		const isAllowed = isPrivateChat(chat) && isUpdaterankAdmin(env, message?.from?.id);
		if (!isAllowed) {
			return;
		}
		try {
			const recalculated = await recalculateAllTotalCredit(env);
			const changed = await updateRankByTotalCredit(env);
			await tg(env, "sendMessage", {
				chat_id: chatId,
				text: `Update completed. Total credit recalculated: ${recalculated}; rank updated: ${changed}`,
			});
		} catch (err) {
			console.error("updateRankByTotalCredit failed:", err);
			await tg(env, "sendMessage", {
				chat_id: chatId,
				text: "Rank update failed. Please try again later.",
			});
		}
		return;
	}

	if (hardIsStartCmd || hardIsHelpCmd) {
		await handleStart(env, chatId, lang);
		return;
	}
	if (hardIsMyprofileCmd) {
		const sent = await handleMyProfile(env, message, ctx, lang);
		if (isGroupChat(chat)) {
			scheduleDeleteMessage(env, ctx, chatId, sent?.message_id, GROUP_REPLY_TTL_MS);
		}
		return;
	}

	const modeCommand = parseModeCommand(text);
	if (modeCommand) {
		const input = modeCommand.value;
		if (!input) {
			await tg(env, "sendMessage", {
				chat_id: chatId,
				text: modeCommand.mode === "x" ? t(lang, "usage_x") : t(lang, "usage_tg"),
			});
			return;
		}
		try {
			const rows =
				modeCommand.mode === "x" ? await queryProfilesByX(env, input) : await queryProfilesByTelegram(env, input);
			if (rows.length === 0) {
				await tg(env, "sendMessage", { chat_id: chatId, text: t(lang, "no_matching_account") });
				return;
			}
			if (rows.length > 1) {
				await tg(env, "sendMessage", { chat_id: chatId, text: t(lang, "multiple_matches") });
				return;
			}
				await tg(env, "sendMessage", {
					chat_id: chatId,
					text: formatRow(rows[0], lang),
					parse_mode: "HTML",
					disable_web_page_preview: true,
				});
			} catch (err) {
				console.error(err);
				await tg(env, "sendMessage", { chat_id: chatId, text: t(lang, "query_failed") });
			}
			return;
	}

	if (isProfileXCheckReply(message)) {
		const xInput = String(text || "").trim();
		if (!xInput || xInput.startsWith("/")) {
			const sent = await sendAskXHandleForProfile(env, chatId, lang);
			if (isGroupChat(chat)) {
				scheduleDeleteMessage(env, ctx, chatId, sent?.message_id, GROUP_REPLY_TTL_MS);
			}
			return;
		}
		try {
			const sent = await sendProfileActionByXHandle(env, chatId, xInput, lang);
			if (isGroupChat(chat)) {
				scheduleDeleteMessage(env, ctx, chatId, sent?.message_id, GROUP_REPLY_TTL_MS);
			}
		} catch (err) {
			console.error(err);
			const sent = await tg(env, "sendMessage", { chat_id: chatId, text: t(lang, "query_failed") });
			if (isGroupChat(chat)) {
				scheduleDeleteMessage(env, ctx, chatId, sent?.message_id, GROUP_REPLY_TTL_MS);
			}
		}
		return;
	}

	const command = normalizeCommand(text);
	const isStartCmd = command === "/start" || command.startsWith("/start@");
	const isHelpCmd = command === "/help" || command.startsWith("/help@");
	const isMyprofileCmd = command === "/me" || command.startsWith("/me@");
	const isListCmd = command === "/list" || command.startsWith("/list@");
	const isCampaignCmd = command === "/campaign" || command.startsWith("/campaign@");
	const isUpdateRankCmd = command === "/updaterank" || command.startsWith("/updaterank@");

	if (isListCmd) {
		const sent = await sendAllCredit(env, chatId, lang);
		if (isGroupChat(chat)) {
			scheduleDeleteMessage(env, ctx, chatId, sent?.message_id, GROUP_REPLY_TTL_MS);
		}
		return;
	}

	if (isCampaignCmd) {
		await sendCampaignMenu(env, chatId, lang);
		return;
	}

	if (isUpdateRankCmd) {
		const isAllowed = isPrivateChat(chat) && isUpdaterankAdmin(env, message?.from?.id);
		if (!isAllowed) {
			return;
		}
		try {
			const recalculated = await recalculateAllTotalCredit(env);
			const changed = await updateRankByTotalCredit(env);
			await tg(env, "sendMessage", {
				chat_id: chatId,
				text: `Update completed. Total credit recalculated: ${recalculated}; rank updated: ${changed}`,
			});
		} catch (err) {
			console.error("updateRankByTotalCredit failed:", err);
			await tg(env, "sendMessage", {
				chat_id: chatId,
				text: "Rank update failed. Please try again later.",
			});
		}
		return;
	}

	if (isStartCmd || isHelpCmd) {
		await handleStart(env, chatId, lang);
		return;
	}
	if (isMyprofileCmd) {
		const sent = await handleMyProfile(env, message, ctx, lang);
		if (isGroupChat(chat)) {
			scheduleDeleteMessage(env, ctx, chatId, sent?.message_id, GROUP_REPLY_TTL_MS);
		}
		return;
	}

	const mode = extractModeFromReply(message);
	if (!mode) {
		// Do not auto-query on arbitrary text to avoid accidental triggers (e.g. @mentions).
		return;
	}

	try {
		const rows = mode === "x" ? await queryProfilesByX(env, text) : await queryProfilesByTelegram(env, text);
		if (rows.length === 0) {
			await tg(env, "sendMessage", { chat_id: chatId, text: t(lang, "no_matching_account") });
			return;
		}
		if (rows.length > 1) {
			await tg(env, "sendMessage", { chat_id: chatId, text: t(lang, "multiple_matches") });
			return;
		}
		await tg(env, "sendMessage", {
			chat_id: chatId,
			text: formatRow(rows[0], lang),
			parse_mode: "HTML",
			disable_web_page_preview: true,
		});
	} catch (err) {
		console.error(err);
		await tg(env, "sendMessage", { chat_id: chatId, text: t(lang, "query_failed") });
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
	async scheduled(event, env, ctx) {
		ctx.waitUntil(runScheduledVidPush(env));
	},
};




