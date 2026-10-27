// 机器人对局自动化测试：1 个脚本真人 + 3 个服务器机器人，打满一局。
// 用法：先起服务（PORT=3100 node server.js），再跑：node test-bot-game.js
// 脚本会先注册/登录测试账号（测试员），再以该账号开局（开局要求登录）。
const WebSocket = require('ws');

const URL = process.env.WS_URL || 'ws://localhost:3100';
const HTTP = URL.replace('ws://', 'http://').replace('wss://', 'https://');
async function getTestCode() {
  const creds = { username: '测试员', password: 'test1234' };
  const post = (p) => fetch(HTTP + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(creds) });
  let r = await post('/api/register');
  if (r.status === 409) r = await post('/api/login');
  const data = await r.json();
  if (!data.ok) throw new Error('测试账号准备失败: ' + (data.error || r.status));
  return data.code;
}

const ws = new WebSocket(URL);
let you = -1;
let lastState = null;
let actions = 0;
let done = false;
let seatChecked = false;

const timer = setTimeout(() => {
  console.log('TIMEOUT: 90 秒内未打完一局，actions =', actions);
  process.exit(1);
}, 90000);

function legalFromState() {
  return lastState.hand;
}
function send(o) { ws.send(JSON.stringify(o)); }

ws.on('open', async () => {
  try {
    const code = await getTestCode();
    send({ type: 'auth', code });
    send({ type: 'join', name: '测试员', kind: 'human', authCode: code });
  } catch (e) { console.log('SETUP FAIL', e.message); process.exit(1); }
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
    if (you >= 0 && msg.players[you] && !seatChecked) {
      seatChecked = true;
      const p = msg.players[you];
      console.log('SEAT name =', p.name, 'account =', p.account);
      if (p.name !== '测试员' || p.account !== '测试员') { console.log('SEAT MISMATCH'); process.exit(1); }
    }
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
