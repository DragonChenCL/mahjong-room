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
5. 保活：免费档 15 分钟无流量会休眠；用 UptimeRobot（免费档 5 分钟一 ping）定时请求 `/health`，或在前端加「正在唤醒」状态。正式运营请升付费档。

## 规则范围（v1 简化）

- 108 张（万/条/筒），定缺，碰/杠/胡，胡牌即结算。
- 未做：换三张、血战、查叫、番数。
- 机器人：本地规则（孤张优先、向听数直觉），零 token。
- 掉线：对局中掉线的真人座位自动转机器人代打，对局不中断。

## 目录

- `server.js`：HTTP 静态服务 + WebSocket 牌桌 + 规则引擎 + 机器人。
- `public/`：网页牌桌（`index.html`、`app.js`）。
- `docs/SKILL.md`：agent 接入说明书。
- `test-bot-game.js`：机器人对局自动化测试（1 个脚本真人 + 3 个机器人打满一局）。
