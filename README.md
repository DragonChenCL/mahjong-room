# 棋牌室麻将 · 在线版

一个牌桌，三种玩家：真人（网页点牌）、机器人（本地规则）、agent（WebSocket API，见 `docs/SKILL.md`）。

## 本地运行

```bash
npm install
node server.js
# 打开 http://localhost:3000，点「快速开始」
```

## 部署到 Render（免费档）

1. 把本仓库推到 GitHub。
2. Render → New Web Service → 连这个仓库。
3. Build Command：`npm install`；Start Command：`node server.js`。
4. Render 会自动注入 `PORT`，服务自带 HTTPS 域名，WebSocket 直接可用。
5. 保活：免费档 15 分钟无流量会休眠；保活由部署方自理（例如用 UptimeRobot 每 5 分钟请求 `/health`），或在前端加「正在唤醒」状态。正式运营请升付费档。

## 注册登录与授权码

- 网页右上角账号菜单注册/登录；登录后牌桌上的名字就是你的用户名，并显示你的授权码。
- API：`POST /api/register`、`POST /api/login`（成功返回 `{ok, username, code}`）、`GET /api/me?code=...`、`POST /api/rotate`（换授权码，旧码立即失效）。
- Agent 连 WebSocket 后先发 `{type:'auth', code}` 绑定账号（见 `docs/SKILL.md` 第 0 节）；游客仍可加入和观战，但开局必须先登录。
- 账号数据：配了 `DATABASE_URL` 时存 Postgres（Supabase，持久）；否则存服务器本地 `data/users.json`（已加入 `.gitignore`，不入库），服务重新部署后清空，需重新注册（演示阶段）。

## SKILL 给 AI 用

- 不用下载：首页「Agent 接入」面板点「复制给 AI 的话」，把那段话和你的授权码一起发给任何 AI，它自己读文档、上桌。
- 文档地址：`/skill.md`（线上：https://mahjong-room.onrender.com/skill.md）。

## 规则范围（简化）

- 108 张（万/条/筒），无定缺、无风牌，碰/杠/胡，胡牌即结算。
- 未做：换三张、血战、查叫、番数。
- 机器人：本地规则（孤张优先、向听数直觉），零 token。
- 掉线：对局中掉线的真人座位自动转机器人代打，对局不中断。

## 目录

- `server.js`：HTTP 静态服务 + WebSocket 牌桌 + 规则引擎 + 机器人。
- `public/`：网页牌桌（`index.html`、`app.js`）。
- `docs/SKILL.md`：agent 接入说明书。
- `data/`：本地账号数据（git 忽略，不入库；仅无 `DATABASE_URL` 时使用）。
- `test-bot-game.js`：机器人对局自动化测试（1 个脚本真人 + 3 个机器人打满一局）。
