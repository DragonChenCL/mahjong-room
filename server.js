// 棋牌室麻将服务器 v1（简化规则）
// 108 张（万/条/筒），定缺，碰/杠/胡，胡牌即结算；无换三张、无血战、无查叫、无番数。
// 同一个座位协议服务三种玩家：真人（网页点牌）、机器人（本地规则）、agent（WebSocket API）。
// agent 接入协议见 docs/SKILL.md。

const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;
const SUITS = ['万', '条', '筒'];
const BOT_NAMES = ['阿强', '阿珍', '阿伟'];
const HUMAN_TIMEOUT_MS = 30000; // agent/真人单步超时：超时自动过牌或打安全牌
const CLAIM_TIMEOUT_MS = 15000;

const tileName = (t) => `${(t % 9) + 1}${SUITS[Math.floor(t / 9)]}`;
const suitOf = (t) => Math.floor(t / 9);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

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
// hand14：14 张牌；dingque：定缺花色（0 万 1 条 2 筒），胡牌时手牌不能剩定缺花色
function canHu(hand14, dingque) {
  if (hand14.length !== 14) return false;
  if (dingque !== null && hand14.some((t) => suitOf(t) === dingque)) return false;
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
function legalDiscards(hand, dingque) {
  if (dingque === null) return [...hand];
  const dq = hand.filter((t) => suitOf(t) === dingque);
  return dq.length ? dq : [...hand];
}
function botChooseDiscard(hand, dingque) {
  const legal = [...new Set(legalDiscards(hand, dingque))];
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
function botChooseDingque(hand) {
  const counts = [0, 1, 2].map((s) => hand.filter((t) => suitOf(t) === s).length);
  let suit = 0;
  for (let s = 1; s < 3; s++) if (counts[s] < counts[suit]) suit = s;
  return suit;
}

// ---------- 牌桌 ----------
class Table {
  constructor() {
    this.reset();
  }
  reset() {
    this.seats = [null, null, null, null]; // {kind,name,ws,hand,melds,discards,dingque,won}
    this.spectators = new Set();
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
      melds: s.melds, discards: s.discards, dingque: s.dingque, won: s.won,
    } : null);
    return {
      type: 'state',
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
    if (p.kind === 'dingque' && msg.type === 'dingque' && [0, 1, 2].includes(msg.suit)) {
      p.resolve(msg.suit);
      return true;
    }
    if (p.kind === 'discard' && msg.type === 'discard') {
      const legal = legalDiscards(this.seats[seat].hand, this.seats[seat].dingque);
      if (legal.includes(msg.tile)) { p.resolve({ action: 'discard', tile: msg.tile }); return true; }
      return false;
    }
    if (p.kind === 'draw_choice' && msg.type === 'draw_choice') {
      if (['win', 'kong', 'discard'].includes(msg.action)) {
        if (msg.action === 'discard') {
          const legal = legalDiscards(this.seats[seat].hand, this.seats[seat].dingque);
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

  addPlayer(ws, name, kind) {
    this.spectators.delete(ws);
    const idx = this.seats.findIndex((s) => s === null);
    if (idx < 0) { this.spectators.add(ws); this.send(ws, this.stateFor(-1)); return -1; }
    this.seats[idx] = {
      kind, name: name || (kind === 'human' ? '你' : 'Agent'),
      ws, hand: [], melds: [], discards: [], dingque: null, won: false,
    };
    this.send(ws, { type: 'joined', seat: idx });
    this.broadcastState();
    return idx;
  }
  removePlayer(ws) {
    const seat = this.seatOf(ws);
    if (seat < 0) { this.spectators.delete(ws); return; }
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
        p.resolve(p.kind === 'dingque' ? botChooseDingque(s.hand)
          : p.kind === 'claim' ? 'pass'
          : p.kind === 'discard' ? { action: 'discard', tile: botChooseDiscard(s.hand, s.dingque).tile }
          : { action: 'discard', tile: botChooseDiscard(s.hand, s.dingque).tile });
      }
    } else {
      this.seats[seat] = null;
    }
    this.broadcastState();
  }

  async start() {
    if (this.phase !== 'waiting') return;
    const humans = this.seats.filter((s) => s && s.kind === 'human').length;
    if (humans === 0) return;
    let botIdx = 0;
    for (let i = 0; i < 4; i++) {
      if (!this.seats[i]) {
        this.seats[i] = {
          kind: 'bot', name: BOT_NAMES[botIdx++ % BOT_NAMES.length], ws: null,
          hand: [], melds: [], discards: [], dingque: null, won: false,
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
      s.melds = []; s.discards = []; s.dingque = null; s.won = false;
    });
    this.turn = 0;
    this.winner = null;
    this.winTile = null;
    this.winKind = null;
    this.logLines = [];
    this.phase = 'dingque';
    this.log('开局：108 张（万/条/筒），请定缺');
    this.broadcastState();
    // 定缺：真人选，机器人自动选最少花色，agent 也按消息选
    const picks = this.seats.map(async (s, i) => {
      if (s.kind === 'bot') {
        await delay(400 + Math.random() * 600);
        return botChooseDingque(s.hand);
      }
      this.send(s.ws, { type: 'dingque_prompt' });
      return this.waitFor(i, 'dingque', HUMAN_TIMEOUT_MS, botChooseDingque(s.hand));
    });
    const suits = await Promise.all(picks);
    suits.forEach((suit, i) => {
      this.seats[i].dingque = suit;
      this.log(`${this.seats[i].name} 定缺 ${SUITS[suit]}`);
    });
    this.phase = 'playing';
    this.broadcastState();
    this.dealerTurn().catch((e) => console.error('dealerTurn error', e));
  }

  async dealerTurn() {
    // 庄家（0 号座）14 张先出；先判天胡
    const s = this.seats[0];
    this.turn = 0;
    if (canHu([...s.hand], s.dingque)) {
      if (s.kind === 'bot') return this.win(0, null, 'zimo');
      this.send(s.ws, { type: 'draw_prompt', canWin: true, canKong: false });
      const r = await this.waitFor(0, 'draw_choice', HUMAN_TIMEOUT_MS, { action: 'discard', tile: legalDiscards(s.hand, s.dingque)[0] });
      if (r.action === 'win') return this.win(0, null, 'zimo');
      return this.afterDiscard(0, r.tile);
    }
    await this.discardStep(0);
  }

  async discardStep(seat) {
    const s = this.seats[seat];
    this.turn = seat;
    this.broadcastState();
    if (s.kind === 'bot') {
      await delay(700 + Math.random() * 500);
      const { tile, reason } = botChooseDiscard(s.hand, s.dingque);
      this.thought(seat, `${reason}，打 ${tileName(tile)}`);
      return this.afterDiscard(seat, tile);
    }
    if (s.kind === 'agent') {
      this.send(s.ws, { type: 'your_turn', hand: [...s.hand], legalDiscards: legalDiscards(s.hand, s.dingque) });
      const r = await this.waitFor(seat, 'discard', HUMAN_TIMEOUT_MS, null);
      let tile;
      if (r && legalDiscards(s.hand, s.dingque).includes(r.tile)) tile = r.tile;
      else tile = botChooseDiscard(s.hand, s.dingque).tile;
      return this.afterDiscard(seat, tile);
    }
    // human：出牌不限时（timeout 传 0 表示不限时）
    this.send(s.ws, { type: 'your_turn', legalDiscards: legalDiscards(s.hand, s.dingque) });
    const r = await this.waitFor(seat, 'discard', 0, null);
    return this.afterDiscard(seat, r ? r.tile : legalDiscards(s.hand, s.dingque)[0]);
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
      if (canHu([...s.hand, tile], s.dingque)) canWinList.push(i);
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
      if (canHu([...s.hand], s.dingque)) {
        if (s.kind === 'bot') return this.win(seat, null, 'zimo');
        this.send(s.ws, { type: 'draw_prompt', canWin: true, canKong: false });
        const r = await this.waitFor(seat, 'draw_choice', HUMAN_TIMEOUT_MS, { action: 'discard', tile: legalDiscards(s.hand, s.dingque)[0] });
        if (r.action === 'win') return this.win(seat, null, 'zimo');
        const legal = legalDiscards(s.hand, s.dingque);
        return this.afterDiscard(seat, legal.includes(r.tile) ? r.tile : legal[0]);
      }
      return this.discardStep(seat);
    }
    return this.discardStep(seat);
  }

  async drawStep(seat) {
    if (this.wall.length === 0) return this.liuju();
    const s = this.seats[seat];
    const tile = this.wall.shift();
    s.hand.push(tile);
    this.turn = seat;
    this.log(`${s.name} 摸牌`);
    this.broadcastState();
    const win = canHu([...s.hand], s.dingque);
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
        if (canHu([...s.hand], s.dingque)) return this.win(seat, null, 'zimo');
        return this.discardStep(seat);
      }
      const { tile: d, reason } = botChooseDiscard(s.hand, s.dingque);
      this.thought(seat, `${reason}，打 ${tileName(d)}`);
      return this.afterDiscard(seat, d);
    }
    if (s.kind === 'agent') {
      this.send(s.ws, { type: 'draw_prompt', drawn: tile, canWin: win, canKong: kongTile !== undefined, kongTile });
      const r = await this.waitFor(seat, 'draw_choice', HUMAN_TIMEOUT_MS, { action: 'discard', tile: legalDiscards(s.hand, s.dingque)[0] });
      if (r.action === 'win') return this.win(seat, null, 'zimo');
      if (r.action === 'kong' && kongTile !== undefined) {
        for (let k = 0; k < 4; k++) s.hand.splice(s.hand.indexOf(kongTile), 1);
        s.melds.push({ type: 'kong', tile: kongTile, from: 'self' });
        this.log(`${s.name} 暗杠 ${tileName(kongTile)}`);
        this.broadcastState();
        if (this.wall.length === 0) return this.liuju();
        const rep = this.wall.pop();
        s.hand.push(rep);
        if (canHu([...s.hand], s.dingque)) return this.win(seat, null, 'zimo');
        return this.discardStep(seat);
      }
      return this.afterDiscard(seat, r.tile);
    }
    // human
    this.send(s.ws, { type: 'draw_prompt', drawn: tile, canWin: win, canKong: kongTile !== undefined, kongTile });
    const r = await this.waitFor(seat, 'draw_choice', HUMAN_TIMEOUT_MS, { action: 'discard', tile: legalDiscards(s.hand, s.dingque)[0] });
    if (r.action === 'win') return this.win(seat, null, 'zimo');
    if (r.action === 'kong' && kongTile !== undefined) {
      for (let k = 0; k < 4; k++) s.hand.splice(s.hand.indexOf(kongTile), 1);
      s.melds.push({ type: 'kong', tile: kongTile, from: 'self' });
      this.log(`${s.name} 暗杠 ${tileName(kongTile)}`);
      this.broadcastState();
      if (this.wall.length === 0) return this.liuju();
      const rep = this.wall.pop();
      s.hand.push(rep);
      if (canHu([...s.hand], s.dingque)) return this.win(seat, null, 'zimo');
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
    this.broadcastState();
    this.broadcast({
      type: 'gameover',
      winner: seat,
      winnerName: s.name,
      winTile: tile,
      winKind: kind,
      hands: this.seats.map((p) => [...p.hand]),
    });
  }
  liuju() {
    this.phase = 'over';
    this.winner = null;
    this.log('流局：牌墙摸空');
    this.broadcastState();
    this.broadcast({ type: 'gameover', winner: null, hands: this.seats.map((p) => [...p.hand]) });
  }
}

// ---------- HTTP + WebSocket ----------
const table = new Table();
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json' };

const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200); res.end('ok'); return; }
  let file = req.url === '/' ? '/index.html' : req.url.split('?')[0];
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
    if (msg.type === 'join') {
      if (table.seatOf(ws) >= 0) return;
      const seat = table.addPlayer(ws, msg.name, msg.kind === 'agent' ? 'agent' : 'human');
      if (seat >= 0) table.log(`${table.seats[seat].name} 加入牌桌`);
      return;
    }
    if (msg.type === 'start') {
      if (table.phase === 'waiting') table.start().catch((e) => console.error('start error', e));
      return;
    }
    if (msg.type === 'restart') {
      if (table.phase === 'over') {
        const keep = table.seats.map((s) => s);
        table.reset();
        keep.forEach((s, i) => { if (s) table.seats[i] = s; });
        table.phase = 'waiting';
        table.start().catch((e) => console.error('restart error', e));
      }
      return;
    }
    // agent 的思考文本：随动作一起广播（展示用，不影响规则）
    if (msg.type === 'thought') {
      const seat = table.seatOf(ws);
      if (seat >= 0 && typeof msg.text === 'string' && msg.text.length < 200) table.thought(seat, msg.text);
      return;
    }
    // agent 动作消息与真人消息走同一 pending 路由
    if (msg.type === 'action' && table.pending) {
      const seat = table.seatOf(ws);
      if (seat < 0 || table.pending.seat !== seat) return;
      const p = table.pending;
      if (p.kind === 'discard' && msg.action === 'discard') {
        table.handleMessage(ws, { type: 'discard', tile: msg.tile });
      } else if (p.kind === 'draw_choice' && ['win', 'kong', 'discard'].includes(msg.action)) {
        table.handleMessage(ws, { type: 'draw_choice', action: msg.action, tile: msg.tile });
      } else if (p.kind === 'claim' && ['win', 'pong', 'kong', 'pass'].includes(msg.action)) {
        table.handleMessage(ws, { type: 'claim', action: msg.action });
      } else if (p.kind === 'dingque' && [0, 1, 2].includes(msg.suit)) {
        table.handleMessage(ws, { type: 'dingque', suit: msg.suit });
      }
      return;
    }
    table.handleMessage(ws, msg);
  });
  ws.on('close', () => table.removePlayer(ws));
  ws.on('error', () => table.removePlayer(ws));
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`mahjong-room listening on ${PORT}`));
}
module.exports = { canHu, countsOf, legalDiscards, botChooseDiscard, botChooseDingque, tileName };
