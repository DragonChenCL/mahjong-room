// 机器人对局自动化测试：1 个脚本真人 + 3 个服务器机器人，打满一局。
// 用法：先起服务（PORT=3100 node server.js），再跑：node test-bot-game.js
const WebSocket = require('ws');

const URL = process.env.WS_URL || 'ws://localhost:3100';
const suitOf = (t) => Math.floor(t / 9);

const ws = new WebSocket(URL);
let you = -1;
let lastState = null;
let actions = 0;
let done = false;

const timer = setTimeout(() => {
  console.log('TIMEOUT: 90 秒内未打完一局，actions =', actions);
  process.exit(1);
}, 90000);

function legalFromState() {
  const hand = lastState.hand;
  const dq = lastState.players[you].dingque;
  if (dq === null || dq === undefined) return hand;
  const d = hand.filter((t) => suitOf(t) === dq);
  return d.length ? d : hand;
}
function send(o) { ws.send(JSON.stringify(o)); }

ws.on('open', () => {
  send({ type: 'join', name: '测试员', kind: 'human' });
});
ws.on('message', (raw) => {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  actions++;
  if (actions > 3000) {
    console.log('ABORT: 消息数超 3000，疑似死循环');
    process.exit(1);
  }
  if (msg.type === 'joined') {
    you = msg.seat;
    send({ type: 'start' });
  } else if (msg.type === 'state') {
    lastState = msg;
  } else if (msg.type === 'dingque_prompt') {
    const hand = lastState ? lastState.hand : [];
    const counts = [0, 1, 2].map((s) => hand.filter((t) => suitOf(t) === s).length);
    let suit = 0;
    for (let s = 1; s < 3; s++) if (counts[s] < counts[suit]) suit = s;
    send({ type: 'dingque', suit });
  } else if (msg.type === 'your_turn') {
    const legal = legalFromState();
    send({ type: 'discard', tile: legal[0] });
  } else if (msg.type === 'draw_prompt') {
    if (msg.canWin) send({ type: 'draw_choice', action: 'win' });
    else if (msg.canKong) send({ type: 'draw_choice', action: 'kong' });
    else {
      const legal = legalFromState();
      send({ type: 'draw_choice', action: 'discard', tile: legal[0] });
    }
  } else if (msg.type === 'claim_prompt') {
    if (msg.actions.includes('win')) send({ type: 'claim', action: 'win' });
    else send({ type: 'claim', action: 'pass' });
  } else if (msg.type === 'gameover') {
    clearTimeout(timer);
    done = true;
    console.log('GAMEOVER actions =', actions,
      'winner =', msg.winner === null ? '流局' : msg.winnerName,
      'winKind =', msg.winKind || '-');
    ws.close();
    process.exit(0);
  }
});
ws.on('error', (e) => {
  if (!done) { console.log('WS ERROR', e.message); process.exit(1); }
});
