// 棋牌室麻将服务器 v1（简化规则）
// 108 张（万/条/筒），无定缺、无风牌，碰/杠/胡，胡牌即结算；无换三张、无血战、无查叫、无番数。
// 同一个座位协议服务三种玩家：真人（网页点牌）、机器人（本地规则）、agent（WebSocket API）。
// agent 接入协议见 docs/SKILL.md。

const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const SUITS = ['万', '条', '筒'];
const BOT_NAMES = ['阿强', '阿珍', '阿伟'];
const HUMAN_TIMEOUT_MS = 60000; // agent/真人单步超时 60 秒：超时自动过牌或打安全牌
const CLAIM_TIMEOUT_MS = 15000;

const tileName = (t) => `${(t % 9) + 1}${SUITS[Math.floor(t / 9)]}`;
const suitOf = (t) => Math.floor(t / 9);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 账号与授权码 ----------
// 优先 Postgres（DATABASE_URL 环境变量，如 Supabase）；无则回落服务器本地 data/users.json。
// 两种后端共用内存 Map；DB 模式下每次 save 全量 upsert（用户量小，简单可靠）。
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
// users: username -> { salt, hash, code, createdAt }（密码只存 scrypt 哈希，不存明文）
const users = new Map();
let dbPool = null;
let storeKind = 'json'; // 'json' | 'db'
function loadUsersFromJson() {
  try {
    const obj = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    for (const [name, u] of Object.entries(obj)) {
      if (u && typeof u.salt === 'string' && typeof u.hash === 'string' && typeof u.code === 'string') users.set(name, { ...u, points: u.points || 0 });
    }
  } catch { /* 无文件或损坏：从空开始 */ }
}
async function initStore() {
  const url = process.env.DATABASE_URL;
  if (!url) { loadUsersFromJson(); console.log('[store] 账号存储：本地 JSON'); return; }
  try {
    const { Pool } = require('pg');
    dbPool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
    await dbPool.query(`CREATE TABLE IF NOT EXISTS users (
      username TEXT PRIMARY KEY,
      salt TEXT NOT NULL,
      hash TEXT NOT NULL,
      code TEXT NOT NULL UNIQUE,
      created_at BIGINT NOT NULL DEFAULT 0
    )`);
    // 老库迁移：积分列不存在时补上（新库建表时没有它）
    await dbPool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS points INT NOT NULL DEFAULT 0');
    const r = await dbPool.query('SELECT username, salt, hash, code, created_at, points FROM users');
    for (const row of r.rows) {
      users.set(row.username, { salt: row.salt, hash: row.hash, code: row.code, createdAt: row.created_at, points: row.points || 0 });
    }
    storeKind = 'db';
    console.log('[store] 账号存储：Postgres');
  } catch (e) {
    console.error('[store] 数据库连接失败，回落本地 JSON：', e.message);
    dbPool = null;
    loadUsersFromJson();
  }
}
async function saveUsers() {
  if (storeKind === 'db' && dbPool) {
    try {
      for (const [name, u] of users) {
        await dbPool.query(
          'INSERT INTO users (username, salt, hash, code, created_at, points) VALUES ($1,$2,$3,$4,$5,$6) ' +
          'ON CONFLICT (username) DO UPDATE SET salt = EXCLUDED.salt, hash = EXCLUDED.hash, code = EXCLUDED.code, points = EXCLUDED.points',
          [name, u.salt, u.hash, u.code, u.createdAt || 0, u.points || 0]);
      }
    } catch (e) { console.error('save users to db failed', e.message); }
    return;
  }
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(USERS_FILE, JSON.stringify(Object.fromEntries(users), null, 1), 'utf8');
  } catch (e) { console.error('save users failed', e.message); }
}
function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}
function newAuthCode() { return crypto.randomBytes(16).toString('hex'); }
function findUserByCode(code) {
  if (typeof code !== 'string' || !code) return null;
  for (const [name, u] of users) if (u.code === code) return name;
  return null;
}

// ---------- 规则引擎 ----------
function countsOf(tiles) {
  const c = new Array(27).fill(0);
  for (const t of tiles) c[t]++;
  return c;
}
function canMelds(c) {
  let i = 0;
  while (i < 27 && c[i] === 0) i++;
  if (i === 27) return true;
  if (c[i] >= 3) {
    c[i] -= 3;
    if (canMelds(c)) { c[i] += 3; return true; }
    c[i] += 3;
  }
  const rank = i % 9;
  if (rank <= 6 && c[i + 1] > 0 && c[i + 2] > 0) {
    c[i]--; c[i + 1]--; c[i + 2]--;
    if (canMelds(c)) { c[i]++; c[i + 1]++; c[i + 2]++; return true; }
    c[i]++; c[i + 1]++; c[i + 2]++;
  }
  return false;
}
// hand14：14 张牌
function canHu(hand14) {
  if (hand14.length !== 14) return false;
  const c = countsOf(hand14);
  if (c.every((x) => x % 2 === 0)) return true; // 七对子（含四张算两对）
  for (let i = 0; i < 27; i++) {
    if (c[i] >= 2) {
      c[i] -= 2;
      if (canMelds(c)) { c[i] += 2; return true; }
      c[i] += 2;
    }
  }
  return false;
}
function legalDiscards(hand) {
  return [...hand];
}
function botChooseDiscard(hand) {
  const legal = [...new Set(legalDiscards(hand))];
  const c = countsOf(hand);
  let best = legal[0];
  let bestScore = Infinity;
  for (const t of legal) {
    let s = 0;
    if (c[t] >= 2) s += 3;
    const rank = t % 9;
    if (rank > 0 && c[t - 1] > 0) s += 1;
    if (rank < 8 && c[t + 1] > 0) s += 1;
    if (s < bestScore) { bestScore = s; best = t; }
  }
  const reason = bestScore === 0 ? '孤张优先' : bestScore <= 1 ? '拆边张' : '调整搭子';
  return { tile: best, reason };
}

// ---------- 牌桌 ----------
class Table {
  constructor(opts = {}) {
    // 桌设置（跨对局保留，reset 不动它们）：id、名字、计划机器人位、是否等待手动开局
    this.id = opts.id || 'main';
    this.name = opts.name || '主桌';
    this.bots = Number.isInteger(opts.bots) && opts.bots >= 0 && opts.bots <= 3 ? opts.bots : 3;
    this.wait = opts.wait === true;
    this.creator = opts.creator || null;
    this.createdAt = Date.now();
    this.registry = opts.registry || null;
    this.spectators = new Set();
    this.emptyTimer = null;
    this.dead = false; // 被解散后为 true：对局循环在下一个出牌/摸牌步骤干净退出
    this.reset();
  }
  reset() {
    this.seats = [null, null, null, null]; // {kind,name,ws,hand,melds,discards,won}
    // 观战者跟随牌桌跨对局：reset 不清空 spectators，restart 后他们继续看新局
    this.phase = 'waiting';
    this.wall = [];
    this.turn = 0;
    this.lastDiscard = null; // {tile, from}
    this.pending = null; // {seat, kind, resolve, timer}
    this.winner = null;
    this.winTile = null;
    this.winKind = null;
    this.logLines = [];
  }
  send(ws, obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }
  broadcast(obj, exceptWs = null) {
    for (const s of this.seats) if (s && s.ws && s.ws !== exceptWs) this.send(s.ws, obj);
    for (const ws of this.spectators) if (ws !== exceptWs) this.send(ws, obj);
  }
  log(text) {
    this.logLines.push(text);
    if (this.logLines.length > 200) this.logLines.shift();
    this.broadcast({ type: 'log', text });
    console.log('[log]', text);
  }
  thought(seat, text) {
    this.broadcast({ type: 'thought', seat, name: this.seats[seat].name, text });
  }
  // 发给某个座位的公开局面 + 自己的手牌
  stateFor(seat) {
    const players = this.seats.map((s) => s ? {
      name: s.name, kind: s.kind, handCount: s.hand.length,
      melds: s.melds, discards: s.discards, won: s.won,
      account: s.account || null,
    } : null);
    return {
      type: 'state',
      tableId: this.id,
      tableName: this.name,
      creator: this.creator,
      you: seat,
      phase: this.phase,
      turn: this.turn,
      wallLeft: this.wall.length,
      players,
      hand: seat >= 0 && this.seats[seat] ? [...this.seats[seat].hand] : [],
      lastDiscard: this.lastDiscard,
      winner: this.winner,
      winTile: this.winTile,
      winKind: this.winKind,
    };
  }
  broadcastState() {
    this.seats.forEach((s, i) => { if (s) this.send(s.ws, this.stateFor(i)); });
    for (const ws of this.spectators) this.send(ws, this.stateFor(-1));
  }
  seatOf(ws) {
    return this.seats.findIndex((s) => s && s.ws === ws);
  }
  // 等待某个座位的回应；超时返回 fallback。同一时间只会有一个 pending。
  waitFor(seat, kind, timeoutMs, fallback) {
    return new Promise((resolve) => {
      let timer = null;
      if (timeoutMs && timeoutMs > 0) {
        timer = setTimeout(() => {
          if (this.pending && this.pending.seat === seat) this.pending = null;
          resolve(fallback);
        }, timeoutMs);
      }
      this.pending = {
        seat, kind,
        resolve: (v) => { if (timer) clearTimeout(timer); this.pending = null; resolve(v); },
      };
    });
  }
  // 路由客户端消息到当前 pending；返回是否命中
  handleMessage(ws, msg) {
    const seat = this.seatOf(ws);
    if (seat < 0) return false;
    const p = this.pending;
    if (!p || p.seat !== seat) return false;
    if (p.kind === 'discard' && msg.type === 'discard') {
      const legal = legalDiscards(this.seats[seat].hand);
      if (legal.includes(msg.tile)) { p.resolve({ action: 'discard', tile: msg.tile }); return true; }
      return false;
    }
    if (p.kind === 'draw_choice' && msg.type === 'draw_choice') {
      if (['win', 'kong', 'discard'].includes(msg.action)) {
        if (msg.action === 'discard') {
          const legal = legalDiscards(this.seats[seat].hand);
          if (!legal.includes(msg.tile)) return false;
        }
        p.resolve(msg);
        return true;
      }
      return false;
    }
    if (p.kind === 'claim' && msg.type === 'claim') {
      if (['win', 'pong', 'kong', 'pass'].includes(msg.action)) { p.resolve(msg.action); return true; }
      return false;
    }
    return false;
  }

  // 空桌管理：无人连接（无真人/AI 座位、无观战者）的桌子 5 分钟后从列表删除（主桌除外）
  isEmpty() {
    const hasHuman = this.seats.some((s) => s && s.kind !== 'bot' && s.ws);
    return !hasHuman && this.spectators.size === 0;
  }
  cancelCleanup() {
    if (this.emptyTimer) { clearTimeout(this.emptyTimer); this.emptyTimer = null; }
  }
  checkEmpty() {
    if (this.id === 'main' || !this.registry) return;
    if (!this.isEmpty() || this.emptyTimer) return;
    this.emptyTimer = setTimeout(() => {
      this.emptyTimer = null;
      if (this.isEmpty()) this.registry.delete(this.id);
    }, 5 * 60 * 1000);
    if (this.emptyTimer.unref) this.emptyTimer.unref();
  }
  // 桌主解散：先广播通知（此时连接还在），再断开所有座位连接、删桌；
  // 对局循环在下一个 discardStep/drawStep 的 dead 检查处干净退出，不会崩。
  dissolve() {
    this.dead = true;
    this.broadcast({ type: 'table_dissolved', tableId: this.id, by: this.creator });
    this.cancelCleanup();
    for (const s of this.seats) if (s) s.ws = null;
    this.spectators.clear();
    if (this.registry) this.registry.delete(this.id);
  }
  addPlayer(ws, name, kind, spectate = false) {
    this.spectators.delete(ws);
    this.cancelCleanup();
    const toSpectator = () => {
      this.spectators.add(ws);
      this.send(ws, { type: 'joined', seat: -1, tableId: this.id });
      this.send(ws, this.stateFor(-1));
      return -1;
    };
    // 显式观战，或满座：都变观战者（观战者收不到手牌）
    if (spectate) return toSpectator();
    const idx = this.seats.findIndex((s) => s === null);
    if (idx < 0) return toSpectator();
    this.seats[idx] = {
      kind, name: name || (kind === 'human' ? '你' : 'Agent'),
      account: ws.user || null,
      ws, hand: [], melds: [], discards: [], won: false,
    };
    this.send(ws, { type: 'joined', seat: idx, tableId: this.id });
    this.broadcastState();
    // 等待模式关闭时：人满（4 - 机器人位）即自动开局；主桌（3 机器人、不等待）第一个加入即开局
    if (this.phase === 'waiting' && !this.wait) {
      const humans = this.seats.filter((s) => s && s.kind !== 'bot').length;
      if (humans >= 4 - this.bots) this.start().catch((e) => console.error('auto start error', e));
    }
    return idx;
  }
  removePlayer(ws) {
    const seat = this.seatOf(ws);
    if (seat < 0) { this.spectators.delete(ws); this.checkEmpty(); return; }
    if (this.phase === 'waiting') {
      this.seats[seat] = null;
    } else if (this.phase !== 'over') {
      // 对局中掉线：座位转机器人，对局不中断
      const s = this.seats[seat];
      s.kind = 'bot';
      s.ws = null;
      s.name = `${s.name}(机器人代打)`;
      this.log(`${s.name} 掉线，转机器人代打`);
      if (this.pending && this.pending.seat === seat) {
        const p = this.pending;
        this.pending = null;
        p.resolve(p.kind === 'claim' ? 'pass'
          : { action: 'discard', tile: botChooseDiscard(s.hand).tile });
      }
    } else {
      this.seats[seat] = null;
    }
    this.broadcastState();
    this.checkEmpty();
  }

  async start() {
    if (this.phase !== 'waiting') return;
    const real = this.seats.filter((s) => s && s.kind !== 'bot').length;
    if (real === 0) { this.log('开局失败：桌上没有真人或 AI 玩家'); return; }
    let botIdx = 0;
    for (let i = 0; i < 4; i++) {
      if (!this.seats[i]) {
        this.seats[i] = {
          kind: 'bot', name: BOT_NAMES[botIdx++ % BOT_NAMES.length], ws: null,
          hand: [], melds: [], discards: [], won: false,
        };
      }
    }
    this.wall = [];
    for (let t = 0; t < 27; t++) for (let k = 0; k < 4; k++) this.wall.push(t);
    for (let i = this.wall.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.wall[i], this.wall[j]] = [this.wall[j], this.wall[i]];
    }
    this.seats.forEach((s, i) => {
      s.hand = this.wall.splice(0, i === 0 ? 14 : 13);
      s.melds = []; s.discards = []; s.won = false;
    });
    this.turn = 0;
    this.winner = null;
    this.winTile = null;
    this.winKind = null;
    this.logLines = [];
    this.phase = 'playing';
    this.log('开局：108 张（万/条/筒），无定缺、无风牌');
    this.broadcastState();
    this.dealerTurn().catch((e) => console.error('dealerTurn error', e));
  }

  async dealerTurn() {
    // 庄家（0 号座）14 张先出；先判天胡
    const s = this.seats[0];
    this.turn = 0;
    if (canHu([...s.hand])) {
      if (s.kind === 'bot') return this.win(0, null, 'zimo');
      this.send(s.ws, { type: 'draw_prompt', canWin: true, canKong: false });
      const r = await this.waitFor(0, 'draw_choice', HUMAN_TIMEOUT_MS, { action: 'discard', tile: legalDiscards(s.hand)[0] });
      if (r.action === 'win') return this.win(0, null, 'zimo');
      return this.afterDiscard(0, r.tile);
    }
    await this.discardStep(0);
  }

  async discardStep(seat) {
    if (this.dead) return; // 桌子已解散：干净退出，不碰座位
    const s = this.seats[seat];
    this.turn = seat;
    this.broadcastState();
    if (s.kind === 'bot') {
      await delay(700 + Math.random() * 500);
      const { tile, reason } = botChooseDiscard(s.hand);
      this.thought(seat, `${reason}，打 ${tileName(tile)}`);
      return this.afterDiscard(seat, tile);
    }
    if (s.kind === 'agent') {
      this.send(s.ws, { type: 'your_turn', hand: [...s.hand], legalDiscards: legalDiscards(s.hand) });
      const r = await this.waitFor(seat, 'discard', HUMAN_TIMEOUT_MS, null);
      let tile;
      if (r && legalDiscards(s.hand).includes(r.tile)) tile = r.tile;
      else tile = botChooseDiscard(s.hand).tile;
      return this.afterDiscard(seat, tile);
    }
    // human：出牌不限时（timeout 传 0 表示不限时）
    this.send(s.ws, { type: 'your_turn', legalDiscards: legalDiscards(s.hand) });
    const r = await this.waitFor(seat, 'discard', 0, null);
    return this.afterDiscard(seat, r ? r.tile : legalDiscards(s.hand)[0]);
  }

  async afterDiscard(seat, tile) {
    const s = this.seats[seat];
    const idx = s.hand.indexOf(tile);
    if (idx < 0) { console.error('discard not in hand', seat, tile); return; }
    s.hand.splice(idx, 1);
    s.discards.push(tile);
    this.lastDiscard = { tile, from: seat };
    this.log(`${s.name} 打 ${tileName(tile)}`);
    this.broadcastState();
    await this.resolveClaims(tile, seat);
  }

  async resolveClaims(tile, from) {
    const order = [1, 2, 3].map((d) => (from + d) % 4);
    const canWinList = [];
    const canClaimList = [];
    for (const i of order) {
      const s = this.seats[i];
      if (s.won) continue;
      const c = countsOf(s.hand);
      if (canHu([...s.hand, tile])) canWinList.push(i);
      else if (c[tile] >= 3) canClaimList.push({ seat: i, actions: ['kong', 'pong'] });
      else if (c[tile] >= 2) canClaimList.push({ seat: i, actions: ['pong'] });
    }
    // 胡优先：按离放炮者最近的顺序问
    for (const i of canWinList) {
      const s = this.seats[i];
      if (s.kind === 'bot') return this.win(i, tile, 'hu', from);
      if (s.kind === 'agent') {
        this.send(s.ws, { type: 'claim_prompt', tile, actions: ['win', 'pass'] });
        const r = await this.waitFor(i, 'claim', CLAIM_TIMEOUT_MS, 'pass');
        if (r === 'win') return this.win(i, tile, 'hu', from);
        continue;
      }
      this.send(s.ws, { type: 'claim_prompt', tile, actions: ['win', 'pong', 'kong', 'pass'] });
      const r = await this.waitFor(i, 'claim', CLAIM_TIMEOUT_MS, 'pass');
      if (r === 'win') return this.win(i, tile, 'hu', from);
      if (r === 'pong' || r === 'kong') return this.doMeld(i, tile, r, from);
      // pass：继续问下一个能胡的人
    }
    // 碰/杠：按顺序问
    for (const c of canClaimList) {
      const i = c.seat;
      const s = this.seats[i];
      if (s.kind === 'bot') {
        const act = c.actions.includes('kong') ? 'kong' : 'pong';
        return this.doMeld(i, tile, act, from);
      }
      if (s.kind === 'agent') {
        this.send(s.ws, { type: 'claim_prompt', tile, actions: [...c.actions, 'pass'] });
        const r = await this.waitFor(i, 'claim', CLAIM_TIMEOUT_MS, 'pass');
        if (r === 'pong' || r === 'kong') return this.doMeld(i, tile, r, from);
        continue;
      }
      this.send(s.ws, { type: 'claim_prompt', tile, actions: [...c.actions, 'pass'] });
      const r = await this.waitFor(i, 'claim', CLAIM_TIMEOUT_MS, 'pass');
      if (r === 'pong' || r === 'kong') return this.doMeld(i, tile, r, from);
    }
    // 无人要：下家摸牌
    const next = (from + 1) % 4;
    await this.drawStep(next);
  }

  async doMeld(seat, tile, act, from) {
    const s = this.seats[seat];
    const need = act === 'kong' ? 3 : 2;
    for (let k = 0; k < need; k++) s.hand.splice(s.hand.indexOf(tile), 1);
    s.melds.push({ type: act, tile, from });
    this.log(`${s.name} ${act === 'kong' ? '杠' : '碰'} ${tileName(tile)}`);
    // 从牌河移除这张被碰/杠的牌
    const fromSeat = this.seats[from];
    const di = fromSeat.discards.lastIndexOf(tile);
    if (di >= 0) fromSeat.discards.splice(di, 1);
    this.lastDiscard = null;
    this.broadcastState();
    if (act === 'kong') {
      if (this.wall.length === 0) return this.liuju();
      const rep = this.wall.pop();
      s.hand.push(rep);
      this.log(`${s.name} 杠后补牌`);
      this.broadcastState();
      if (canHu([...s.hand])) {
        if (s.kind === 'bot') return this.win(seat, null, 'zimo');
        this.send(s.ws, { type: 'draw_prompt', canWin: true, canKong: false });
        const r = await this.waitFor(seat, 'draw_choice', HUMAN_TIMEOUT_MS, { action: 'discard', tile: legalDiscards(s.hand)[0] });
        if (r.action === 'win') return this.win(seat, null, 'zimo');
        const legal = legalDiscards(s.hand);
        return this.afterDiscard(seat, legal.includes(r.tile) ? r.tile : legal[0]);
      }
      return this.discardStep(seat);
    }
    return this.discardStep(seat);
  }

  async drawStep(seat) {
    if (this.dead) return; // 桌子已解散：干净退出，不碰座位
    if (this.wall.length === 0) return this.liuju();
    const s = this.seats[seat];
    const tile = this.wall.shift();
    s.hand.push(tile);
    this.turn = seat;
    this.log(`${s.name} 摸牌`);
    this.broadcastState();
    const win = canHu([...s.hand]);
    const kongTile = [...new Set(s.hand)].find((t) => countsOf(s.hand)[t] === 4);
    if (s.kind === 'bot') {
      await delay(700 + Math.random() * 500);
      if (win) return this.win(seat, null, 'zimo');
      if (kongTile !== undefined) {
        for (let k = 0; k < 4; k++) s.hand.splice(s.hand.indexOf(kongTile), 1);
        s.melds.push({ type: 'kong', tile: kongTile, from: 'self' });
        this.log(`${s.name} 暗杠 ${tileName(kongTile)}`);
        this.broadcastState();
        if (this.wall.length === 0) return this.liuju();
        const rep = this.wall.pop();
        s.hand.push(rep);
        if (canHu([...s.hand])) return this.win(seat, null, 'zimo');
        return this.discardStep(seat);
      }
      const { tile: d, reason } = botChooseDiscard(s.hand);
      this.thought(seat, `${reason}，打 ${tileName(d)}`);
      return this.afterDiscard(seat, d);
    }
    if (s.kind === 'agent') {
      this.send(s.ws, { type: 'draw_prompt', drawn: tile, canWin: win, canKong: kongTile !== undefined, kongTile });
      const r = await this.waitFor(seat, 'draw_choice', HUMAN_TIMEOUT_MS, { action: 'discard', tile: legalDiscards(s.hand)[0] });
      if (r.action === 'win') return this.win(seat, null, 'zimo');
      if (r.action === 'kong' && kongTile !== undefined) {
        for (let k = 0; k < 4; k++) s.hand.splice(s.hand.indexOf(kongTile), 1);
        s.melds.push({ type: 'kong', tile: kongTile, from: 'self' });
        this.log(`${s.name} 暗杠 ${tileName(kongTile)}`);
        this.broadcastState();
        if (this.wall.length === 0) return this.liuju();
        const rep = this.wall.pop();
        s.hand.push(rep);
        if (canHu([...s.hand])) return this.win(seat, null, 'zimo');
        return this.discardStep(seat);
      }
      return this.afterDiscard(seat, r.tile);
    }
    // human
    this.send(s.ws, { type: 'draw_prompt', drawn: tile, canWin: win, canKong: kongTile !== undefined, kongTile });
    const r = await this.waitFor(seat, 'draw_choice', HUMAN_TIMEOUT_MS, { action: 'discard', tile: legalDiscards(s.hand)[0] });
    if (r.action === 'win') return this.win(seat, null, 'zimo');
    if (r.action === 'kong' && kongTile !== undefined) {
      for (let k = 0; k < 4; k++) s.hand.splice(s.hand.indexOf(kongTile), 1);
      s.melds.push({ type: 'kong', tile: kongTile, from: 'self' });
      this.log(`${s.name} 暗杠 ${tileName(kongTile)}`);
      this.broadcastState();
      if (this.wall.length === 0) return this.liuju();
      const rep = this.wall.pop();
      s.hand.push(rep);
      if (canHu([...s.hand])) return this.win(seat, null, 'zimo');
      return this.discardStep(seat);
    }
    return this.afterDiscard(seat, r.tile);
  }

  win(seat, tile, kind, from = null) {
    const s = this.seats[seat];
    if (tile !== null) {
      s.hand.push(tile);
      if (from !== null) {
        const di = this.seats[from].discards.lastIndexOf(tile);
        if (di >= 0) this.seats[from].discards.splice(di, 1);
      }
    }
    s.won = true;
    this.winner = seat;
    this.winTile = tile;
    this.winKind = kind;
    this.phase = 'over';
    const label = kind === 'zimo' ? '自摸' : `胡 ${this.seats[from].name} 的 ${tileName(tile)}`;
    this.log(`${s.name} ${label}！`);
    // 娱乐积分：只记到有账号的胜者名下（机器人与访客不记）；胡牌 +2，自摸 +3
    let pointsDelta = 0;
    let winnerPoints = null;
    if (s.account && users.has(s.account)) {
      pointsDelta = kind === 'zimo' ? 3 : 2;
      const u = users.get(s.account);
      u.points = (u.points || 0) + pointsDelta;
      winnerPoints = u.points;
      saveUsers();
    }
    this.broadcastState();
    this.broadcast({
      type: 'gameover',
      winner: seat,
      winnerName: s.name,
      winTile: tile,
      winKind: kind,
      hands: this.seats.map((p) => [...p.hand]),
      pointsDelta,
      winnerPoints,
    });
    this.checkEmpty();
  }
  liuju() {
    this.phase = 'over';
    this.winner = null;
    this.log('流局：牌墙摸空');
    this.broadcastState();
    this.broadcast({ type: 'gameover', winner: null, hands: this.seats.map((p) => [...p.hand]) });
    this.checkEmpty();
  }
}

// ---------- 多桌 ----------
// 桌子只存在内存里：服务重启即清空（账号不受影响，账号走数据库/本地 JSON）。
// 主桌（id=main）常驻；用户建的桌子无人连接 5 分钟后删除；上限 20 桌（含主桌）。
const tables = new Map(); // id -> Table
const MAX_TABLES = 20;
let tableSeq = 0;
function sendWs(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}
function newTableId() {
  let id;
  do { id = crypto.randomBytes(3).toString('hex'); } while (tables.has(id));
  return id;
}
function createTable({ name, bots, wait, creator }) {
  const id = newTableId();
  const t = new Table({ id, name: name || `牌桌${++tableSeq}`, bots, wait, creator, registry: tables });
  tables.set(id, t);
  return t;
}
function defaultTable() {
  let t = tables.get('main');
  if (!t) {
    t = new Table({ id: 'main', name: '主桌', bots: 3, wait: false, creator: null, registry: tables });
    tables.set('main', t);
  }
  return t;
}
// 某个连接所在的桌（座位或观战都算）
function tableOf(ws) {
  for (const t of tables.values()) {
    if (t.seatOf(ws) >= 0 || t.spectators.has(ws)) return t;
  }
  return null;
}
// 桌列表公开信息：不含任何手牌与授权码
function tablePublicInfo(t) {
  return {
    id: t.id, name: t.name, phase: t.phase, bots: t.bots, wait: t.wait,
    seats: t.seats.map((s) => (s ? { name: s.name, kind: s.kind } : null)),
    spectators: t.spectators.size, createdAt: t.createdAt, creator: t.creator,
  };
}
defaultTable();

// ---------- 账号 API ----------
function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function readJsonBody(req, limit = 10240) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > limit) { req.destroy(); reject(new Error('body too large')); }
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}
function validUsername(name) {
  return typeof name === 'string' && name.trim().length >= 1 && name.trim().length <= 20;
}
function validPassword(pw) {
  return typeof pw === 'string' && pw.length >= 4 && pw.length <= 64;
}
async function handleApi(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    if (req.method === 'GET' && p === '/api/tables') {
      return sendJson(res, 200, { ok: true, tables: [...tables.values()].map(tablePublicInfo) });
    }
    if (req.method === 'POST' && p === '/api/register') {
      const body = await readJsonBody(req);
      const username = typeof body.username === 'string' ? body.username.trim() : '';
      if (!validUsername(username) || !validPassword(body.password)) {
        return sendJson(res, 400, { ok: false, error: '用户名 1–20 字，密码 4–64 位' });
      }
      if (users.has(username)) return sendJson(res, 409, { ok: false, error: '用户名已被注册' });
      const salt = crypto.randomBytes(16).toString('hex');
      users.set(username, { salt, hash: hashPassword(body.password, salt), code: newAuthCode(), createdAt: Date.now(), points: 0 });
      await saveUsers();
      return sendJson(res, 200, { ok: true, username, code: users.get(username).code });
    }
    if (req.method === 'POST' && p === '/api/login') {
      const body = await readJsonBody(req);
      const username = typeof body.username === 'string' ? body.username.trim() : '';
      const u = users.get(username);
      let ok = false;
      if (u) {
        try { ok = crypto.timingSafeEqual(Buffer.from(u.hash, 'hex'), Buffer.from(hashPassword(body.password || '', u.salt), 'hex')); } catch { ok = false; }
      }
      if (!ok) return sendJson(res, 401, { ok: false, error: '用户名或密码不对' });
      return sendJson(res, 200, { ok: true, username, code: u.code });
    }
    if (req.method === 'GET' && p === '/api/me') {
      const username = findUserByCode(url.searchParams.get('code'));
      if (!username) return sendJson(res, 401, { ok: false, error: '授权码无效' });
      return sendJson(res, 200, { ok: true, username, points: (users.get(username) || {}).points || 0 });
    }
    if (req.method === 'GET' && p === '/api/leaderboard') {
      // 只公开用户名与积分，不含任何密码哈希与授权码
      const top = [...users.entries()]
        .map(([username, u]) => ({ username, points: u.points || 0 }))
        .sort((a, b) => b.points - a.points)
        .slice(0, 10);
      return sendJson(res, 200, { ok: true, leaderboard: top });
    }
    if (req.method === 'POST' && p === '/api/rotate') {
      const body = await readJsonBody(req);
      const username = findUserByCode(body.code);
      if (!username) return sendJson(res, 401, { ok: false, error: '授权码无效' });
      users.get(username).code = newAuthCode();
      await saveUsers();
      return sendJson(res, 200, { ok: true, username, code: users.get(username).code });
    }
    return sendJson(res, 404, { ok: false, error: 'not found' });
  } catch (e) {
    if (e.message === 'body too large' || e.message === 'bad json') return sendJson(res, 400, { ok: false, error: '请求格式不对' });
    throw e;
  }
}

// ---------- HTTP + WebSocket ----------
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json' };

const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200); res.end('ok'); return; }
  // SKILL 下载：首页「Agent 接入」面板的下载/在线查看入口
  if (req.url.split('?')[0] === '/skill.md') {
    fs.readFile(path.join(__dirname, 'docs', 'SKILL.md'), (err, data) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
      res.end(data);
    });
    return;
  }
  // 账号 API：注册 / 登录 / 校验 / 换授权码
  if (req.url.split('?')[0].startsWith('/api/')) {
    handleApi(req, res).catch(() => { if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'server error' }); });
    return;
  }
  // 根路径要先去掉查询串再比对：/?table=xxx 否则会被当成文件 '/' 读目录而 404
  const pathOnly = req.url.split('?')[0];
  let file = pathOnly === '/' ? '/index.html' : pathOnly;
  const full = path.normalize(path.join(__dirname, 'public', file));
  if (!full.startsWith(path.join(__dirname, 'public'))) { res.writeHead(403); res.end(); return; }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocket.Server({ server });
wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'auth') {
      const username = findUserByCode(msg.code);
      if (username) { ws.user = username; sendWs(ws, { type: 'authed', username }); }
      else sendWs(ws, { type: 'auth_error', message: '授权码无效' });
      return;
    }
    // 列桌：只回给请求者一人
    if (msg.type === 'list_tables') {
      sendWs(ws, { type: 'tables', tables: [...tables.values()].map(tablePublicInfo) });
      return;
    }
    // 建桌：要登录；建桌者自动坐 0 号座；上限 20 桌
    if (msg.type === 'create_table') {
      if (!ws.user) { sendWs(ws, { type: 'error', message: '请先登录再建桌' }); return; }
      if (tableOf(ws)) { sendWs(ws, { type: 'error', message: '你已在别的牌桌上，先发 leave 退出当前牌桌' }); return; }
      if (tables.size >= MAX_TABLES) { sendWs(ws, { type: 'error', message: '牌桌已满（上限 20 桌），请加入已有牌桌' }); return; }
      const bots = Number.isInteger(msg.bots) && msg.bots >= 0 && msg.bots <= 3 ? msg.bots : 3;
      const wait = msg.wait === true;
      const name = typeof msg.name === 'string' && msg.name.trim() ? msg.name.trim().slice(0, 20) : null;
      const t = createTable({ name, bots, wait, creator: ws.user });
      t.addPlayer(ws, ws.user, msg.kind === 'agent' ? 'agent' : 'human');
      sendWs(ws, { type: 'table_created', tableId: t.id, name: t.name, bots: t.bots, wait: t.wait });
      return;
    }
    // 离桌：waiting/over 放座位，对局中转机器人代打（与断线一致）
    if (msg.type === 'leave') {
      const cur = tableOf(ws);
      if (cur) cur.removePlayer(ws);
      return;
    }
    if (msg.type === 'join') {
      const cur = tableOf(ws);
      let t;
      if (msg.tableId) {
        t = tables.get(msg.tableId);
        if (!t) { sendWs(ws, { type: 'error', message: '牌桌不存在，请去大厅看看' }); return; }
        if (cur && cur !== t) { sendWs(ws, { type: 'error', message: '你已在别的牌桌上，先发 leave 退出当前牌桌' }); return; }
      } else {
        t = cur || defaultTable();
      }
      if (t.seatOf(ws) >= 0) return; // 已占座
      // 观战者再次 join（不带 spectate）且有空座时：addPlayer 会先将其移出观战者再占座
      const authUser = findUserByCode(msg.authCode || msg.code);
      if (authUser) ws.user = authUser;
      const seat = t.addPlayer(ws, msg.name || ws.user, msg.kind === 'agent' ? 'agent' : 'human', msg.spectate === true);
      if (seat >= 0) t.log(`${t.seats[seat].name} 加入牌桌`);
      return;
    }
    if (msg.type === 'logout') { ws.user = null; return; }
    // 以下动作均作用于发送者所在的桌
    const t = tableOf(ws);
    // 桌内聊天：要登录，1–200 字；广播给本桌所有人（含观战者）
    if (msg.type === 'chat') {
      if (!t) return;
      if (!ws.user) { sendWs(ws, { type: 'error', message: '请先登录再发言' }); return; }
      const text = typeof msg.text === 'string' ? msg.text.trim() : '';
      if (!text || text.length > 200) return;
      const seat = t.seatOf(ws);
      const name = seat >= 0 ? t.seats[seat].name : ws.user;
      t.broadcast({ type: 'chat', tableId: t.id, from: seat, name, text });
      return;
    }
    // 解散：只有建桌者能解散自己的桌（主桌没有桌主，不可解散）
    if (msg.type === 'dissolve') {
      if (!t || t.creator == null || ws.user !== t.creator) { sendWs(ws, { type: 'error', message: '只有桌主可以解散本桌' }); return; }
      t.dissolve();
      return;
    }
    // 踢人：只有建桌者能踢；waiting/over 放座位，对局中转机器人代打（与断线一致）
    if (msg.type === 'kick') {
      if (!t || t.creator == null || ws.user !== t.creator) { sendWs(ws, { type: 'error', message: '只有桌主可以踢人' }); return; }
      const seat = msg.seat;
      if (!Number.isInteger(seat) || seat < 0 || seat > 3) { sendWs(ws, { type: 'error', message: '座位号不对' }); return; }
      const target = t.seats[seat];
      if (!target || target.kind === 'bot') { sendWs(ws, { type: 'error', message: '这个座位没有真人或 AI 玩家' }); return; }
      if (target.ws === ws) { sendWs(ws, { type: 'error', message: '不能踢自己' }); return; }
      if (!target.ws) { sendWs(ws, { type: 'error', message: '该玩家已离线' }); return; }
      const targetWs = target.ws;
      const targetName = target.name;
      sendWs(targetWs, { type: 'kicked', tableId: t.id });
      t.log(`${targetName} 被桌主请出`);
      t.removePlayer(targetWs);
      return;
    }
    if (msg.type === 'start') {
      if (!ws.user) { sendWs(ws, { type: 'error', message: '请先登录再开局' }); return; }
      // 手动开局总是立即开：人座未满由机器人补齐（不受 wait 影响）
      if (t && t.phase === 'waiting') t.start().catch((e) => console.error('start error', e));
      return;
    }
    if (msg.type === 'restart') {
      if (!ws.user) { sendWs(ws, { type: 'error', message: '请先登录再开局' }); return; }
      if (t && t.phase === 'over') {
        // 只保留真人/AI 座位：机器人座位（含掉线转机器人代打的座位）一律释放，
        // 否则机器人占满座位后无人能加入、也无人能开局，桌子永久卡死。
        // 再来一局总是立即重开，不受 wait 影响；观战者保留，继续看新局。
        const keep = t.seats.map((s) => (s && s.kind !== 'bot' ? s : null));
        t.reset();
        keep.forEach((s, i) => { if (s) t.seats[i] = s; });
        t.phase = 'waiting';
        t.start().catch((e) => console.error('restart error', e));
      }
      return;
    }
    // agent 的思考文本：随动作一起广播（展示用，不影响规则）
    if (msg.type === 'thought') {
      if (!t) return;
      const seat = t.seatOf(ws);
      if (seat >= 0 && typeof msg.text === 'string' && msg.text.length < 200) t.thought(seat, msg.text);
      return;
    }
    // agent 主动索取当前局面：只回给请求者本人，内容与广播的 state 一致
    // （座位玩家含自己的手牌，观战者/未加入者无手牌）；不会泄露别人的手牌。
    if (msg.type === 'get_state') {
      const tt = t || defaultTable();
      sendWs(ws, tt.stateFor(tt.seatOf(ws)));
      return;
    }
    // agent 动作消息与真人消息走同一 pending 路由
    if (msg.type === 'action' && t && t.pending) {
      const seat = t.seatOf(ws);
      if (seat < 0 || t.pending.seat !== seat) return;
      const p = t.pending;
      if (p.kind === 'discard' && msg.action === 'discard') {
        t.handleMessage(ws, { type: 'discard', tile: msg.tile });
      } else if (p.kind === 'draw_choice' && ['win', 'kong', 'discard'].includes(msg.action)) {
        t.handleMessage(ws, { type: 'draw_choice', action: msg.action, tile: msg.tile });
      } else if (p.kind === 'claim' && ['win', 'pong', 'kong', 'pass'].includes(msg.action)) {
        t.handleMessage(ws, { type: 'claim', action: msg.action });
      }
      return;
    }
    if (t) t.handleMessage(ws, msg);
  });
  ws.on('close', () => { const t = tableOf(ws); if (t) t.removePlayer(ws); });
  ws.on('error', () => { const t = tableOf(ws); if (t) t.removePlayer(ws); });
});

if (require.main === module) {
  initStore().then(() => {
    server.listen(PORT, () => console.log(`mahjong-room listening on ${PORT} (store: ${storeKind})`));
  });
}
module.exports = { canHu, countsOf, legalDiscards, botChooseDiscard, tileName };
