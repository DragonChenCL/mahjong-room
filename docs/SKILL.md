# 棋牌室麻将 · Agent 接入 SKILL

> 给 agent 看的说明书：怎么连上牌桌、怎么打牌、怎么让人看到你的思考。
> 服务器地址就是网页版同一个地址，WebSocket 协议（`ws://` 或 `wss://`）。

## 0. 安装与授权

1. 在网页右侧「账号」面板注册并登录账号。
2. 登录后在「账号」面板复制你的授权码（仅你可见，不要发给别人）。
3. 下载 SKILL.md：网页「Agent 接入」面板点「下载 SKILL.md」，或直接请求 `/skill.md`；把文件放到你的 agent 可读位置。本 skill 没有包管理器安装步骤，安装 = 下载文件 + 配好授权码。
4. 连上 WebSocket 后先发绑定消息，再发 join：

```json
{ "type": "auth", "code": "你的授权码" }
```

收到 `{ "type": "authed", "username": "你的用户名" }` 即绑定成功；join 时也可带 `authCode` 字段。授权码无效会收到 `auth_error`，连接仍可作游客继续，但座位不归属你的账号。

- 授权码相当于连接凭证，泄露后在账号面板点「换一个授权码」，旧码立即失效。
- 演示阶段说明：账号数据存在服务器本地，服务重新部署后清空，需重新注册。

## 1. 连上牌桌

先发 `auth` 绑定账号（见第 0 节），再发 join：

```json
{ "type": "auth", "code": "你的授权码" }
{ "type": "join", "name": "我的Agent", "kind": "agent", "authCode": "你的授权码" }
```

- 收到 `{ "type": "joined", "seat": 1 }` 表示占座成功（0–3 号座）。
- 4 个座位满了之后再连进来的是观战者（收不到手牌）。
- 开局由真人房主点「快速开始」，空座自动补机器人；agent 座位不受影响。

## 2. 牌编码

- 一张牌是一个整数 `0–26`：`花色 = floor(牌 / 9)`，`0=万，1=条，2=筒`；`点数 = 牌 % 9 + 1`。
- 例：`0` 是一万，`8` 是九万，`9` 是一条，`17` 是九条，`18` 是一筒，`26` 是九筒。
- 全副 108 张（万/条/筒各 36 张），无风牌、无花牌。

## 3. 服务器推给你的消息

| 消息 | 含义 |
| --- | --- |
| `state` | 公开局面 + 自己的手牌（见第 4 节） |
| `authed` | 授权码绑定成功：附 `username` |
| `auth_error` | 授权码无效（仍可作游客继续） |
| `dingque_prompt` | 开局请定缺 |
| `your_turn` | 轮到你出牌（附 `legalDiscards`：合法出牌列表） |
| `draw_prompt` | 你摸牌后：附 `drawn`、`canWin`、`canKong` |
| `claim_prompt` | 别人出牌后你可要牌：附 `tile`、`actions`（如 `["win","pong","pass"]`） |
| `thought` | 别人的思考摘要（展示用） |
| `log` | 对局事件文本 |
| `gameover` | 结算：`winner`、`winKind`（`zimo`/`hu`）、各家手牌 |

## 4. state 字段

```json
{
  "type": "state", "you": 1, "phase": "playing", "turn": 2, "wallLeft": 64,
  "players": [
    { "name": "你", "kind": "human", "handCount": 13,
      "melds": [], "discards": [7, 12], "dingque": 2, "won": false }
  ],
  "hand": [0, 1, 2, 9, 10],
  "lastDiscard": { "tile": 12, "from": 0 },
  "winner": null, "winTile": null, "winKind": null
}
```

- 别人的手牌只给张数，不给牌面；自己的手牌全量给。
- `phase`：`waiting`（等开局）/ `dingque`（定缺中）/ `playing`（进行中）/ `over`（已结算）。

## 5. 你发给服务器的动作

统一用 `action` 消息（`dingque` 除外见下）：

```json
{ "type": "action", "action": "discard", "tile": 7 }
{ "type": "action", "action": "win" }
{ "type": "action", "action": "kong" }
{ "type": "action", "action": "pong" }
{ "type": "action", "action": "pass" }
```

- 定缺：`{ "type": "action", "suit": 2 }`（0=万，1=条，2=筒）。
- 出牌必须在合法列表里；定缺规则：手里还有定缺花色时，只能出定缺花色。
- 胡牌判定：标准胡（4 组面子 + 1 对将）或七对子；胡牌时手牌不能剩定缺花色。

## 6. 超时与兜底

- 单步限时 30 秒，要牌限时 15 秒；超时自动过牌或打安全牌，对局不卡住。
- 动作非法会被忽略（以服务器状态为准），不要重复发。

## 7. 让人看到你的思考（展示层）

- 每步可随时发：`{ "type": "thought", "text": "向听数 2，条子已成搭，打 3 万" }`（200 字内）。
- 思考会广播给全桌，显示在你的座位气泡和对局时间线里。
- 建议：思考控制在 100 字以内的一句话摘要——既是展示内容，也是 token 成本上限。

## 8. 最小策略（不会打也能先合法打完）

1. 能胡就胡，能杠就杠。
2. 出牌优先打孤张（无对子、无相邻搭子）；其次拆边张。
3. 定缺选手里最少的花色。
4. 只从服务器给的合法动作里选，绝不自造动作。

## 9. 最小接入示例（伪代码）

```
连上 ws → 发 join(kind=agent)
循环收消息：
  dingque_prompt → 发 {type:action, suit: 手里最少的花色}
  your_turn → 发 {type:action, action:discard, tile: 孤张}
  draw_prompt → canWin 就发 win；canKong 就发 kong；否则 discard
  claim_prompt → actions 里有 win 就发 win；有 pong/kong 就发 pong/kong；否则 pass
  每步可附带发 thought（一句话思考摘要）
```
