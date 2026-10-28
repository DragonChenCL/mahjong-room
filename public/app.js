// 棋牌室麻将网页客户端 v1：与 server.js 的 WebSocket 协议对接。
const SUITS = ['万', '条', '筒'];
const SUIT_CLS = ['suit-wan', 'suit-tiao', 'suit-tong'];
const tileName = (t) => `${(t % 9) + 1}${SUITS[Math.floor(t / 9)]}`;
const suitOf = (t) => Math.floor(t / 9);

let ws = null;
let you = -1;
let state = null;
let awaiting = null; // {kind, actions?, canWin?, canKong?, legal?}
let thoughts = {};
let joined = false;
let authCode = localStorage.getItem('mahjong-auth-code') || '';
let authUser = localStorage.getItem('mahjong-username') || '';
// 多桌：邀请链接 / 大厅点进来带 ?table=<id>（&spectate=1 则只观战）；不带则走默认主桌
const urlParams = new URLSearchParams(location.search);
const urlTableId = urlParams.get('table') || '';
const urlSpectate = urlParams.get('spectate') === '1';
let currentTableId = urlTableId || '';
let currentTableName = '';

const $ = (id) => document.getElementById(id);

function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(proto + '//' + location.host);
  ws.onopen = () => {
    $('status').textContent = urlTableId ? '正在加入牌桌…' : '已连接，点击快速开始';
    if (authCode) send({ type: 'auth', code: authCode });
    // 邀请链接 / 大厅点进来：直接加入指定桌（spectate=1 则只观战）；访客也可加入观战
    if (urlTableId) {
      setTimeout(() => send({ type: 'join', name: authUser || '访客', kind: 'human', authCode: authCode || undefined, tableId: urlTableId, spectate: urlSpectate || undefined }), 100);
    }
  };
  ws.onclose = () => { $('status').textContent = '连接断开，请刷新页面'; };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    onMessage(msg);
  };
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function tileHTML(t, small) {
  const rank = (t % 9) + 1;
  const s = Math.floor(t / 9);
  return `<div class="tile ${small ? 'small' : ''}"><span class="r ${SUIT_CLS[s]}">${rank}</span><span class="s ${SUIT_CLS[s]}">${SUITS[s]}</span></div>`;
}
function backHTML(small) {
  return `<div class="tile back ${small ? 'small' : ''}"></div>`;
}
function meldHTML(m) {
  const n = m.type === 'kong' ? 4 : 3;
  let h = '';
  for (let i = 0; i < n; i++) h += tileHTML(m.tile, true);
  return h;
}
function legalSet() {
  if (!state || you < 0) return new Set();
  if (awaiting && awaiting.legal) return new Set(awaiting.legal);
  return new Set(state.hand);
}

function renderSeats() {
  if (!state) return;
  const order = you >= 0 ? [you, (you + 1) % 4, (you + 2) % 4, (you + 3) % 4] : [0, 1, 2, 3];
  const pos = ['seat-bottom', 'seat-right', 'seat-top', 'seat-left'];
  order.forEach((seatIdx, k) => {
    const el = document.querySelector('.' + pos[k]);
    const p = state.players[seatIdx];
    if (!p) { el.innerHTML = '<div class="seat-head">空座位</div>'; el.classList.remove('turn'); return; }
    const isMe = seatIdx === you;
    const turnCls = state.turn === seatIdx && state.phase === 'playing' ? 'turn' : '';
    el.className = 'seat ' + pos[k] + ' ' + turnCls + (p.kind === 'agent' ? ' seat-agent' : '');
    let html = `<div class="seat-head">${p.name} ${p.kind === 'bot' ? '· 机器人' : p.kind === 'agent' ? '· Agent' : ''}${p.account ? ' · 已认证' : ''}</div>`;
    if (p.melds.length) html += `<div class="tiles">${p.melds.map(meldHTML).join('')}</div>`;
    html += `<div class="tiles">${p.discards.map((t) => tileHTML(t, true)).join('')}</div>`;
    if (isMe) {
      const sorted = [...state.hand].sort((a, b) => a - b);
      const legal = (awaiting && (awaiting.kind === 'discard' || awaiting.kind === 'draw_choice')) ? legalSet() : new Set();
      const canClick = awaiting && (awaiting.kind === 'discard' || awaiting.kind === 'draw_choice');
      html += `<div class="tiles hand">${sorted.map((t) => {
        const ok = canClick && legal.has(t);
        return `<div class="tile ${ok ? 'playable' : ''}" data-tile="${t}" onclick="onTileClick(${t})"><span class="r ${SUIT_CLS[Math.floor(t / 9)]}">${(t % 9) + 1}</span><span class="s ${SUIT_CLS[Math.floor(t / 9)]}">${SUITS[Math.floor(t / 9)]}</span></div>`;
      }).join('')}</div>`;
    } else {
      let backs = '';
      for (let i = 0; i < p.handCount; i++) backs += backHTML(true);
      html += `<div class="tiles">${backs}</div>`;
    }
    if (thoughts[seatIdx]) {
      const tag = p.kind === 'agent' ? '<span class="thought-tag ai">AI</span>' : p.kind === 'bot' ? '<span class="thought-tag bot">BOT</span>' : '';
      html += `<div class="thought">${tag}${thoughts[seatIdx]}</div>`;
    }
    el.innerHTML = html;
  });
  // 中央：最后一张弃牌
  const c = $('centerTile');
  if (state.lastDiscard) {
    const from = state.players[state.lastDiscard.from];
    c.innerHTML = tileHTML(state.lastDiscard.tile, false) + `<div class="hint">${from ? from.name : ''} 打出</div>`;
  } else {
    c.innerHTML = '';
  }
  $('wall').textContent = `牌墙剩 ${state.wallLeft} 张`;
  const phaseText = { waiting: '等待开始', playing: '进行中', over: '已结算' }[state.phase] || state.phase;
  const turnName = state.phase === 'playing' && state.players[state.turn] ? ` · 轮到 ${state.players[state.turn].name}` : '';
  $('centerHint').textContent = phaseText + turnName;
  // Agent 视角
  const summary = {
    turn: state.turn,
    wallLeft: state.wallLeft,
    lastDiscard: state.lastDiscard,
    players: state.players.map((p) => p ? { name: p.name, kind: p.kind, handCount: p.handCount, melds: p.melds, discards: p.discards } : null),
    hand: state.hand,
  };
  $('agentState').textContent = JSON.stringify(summary, null, 1);
}

function renderActions() {
  const bar = document.createElement('div');
  const bottom = document.querySelector('.seat-bottom');
  const old = bottom.querySelector('.actions');
  if (old) old.remove();
  const div = document.createElement('div');
  div.className = 'actions';
  if (!awaiting) {
    if (state && state.phase === 'playing') div.innerHTML = '<span class="hint">等待其他玩家…</span>';
  } else if (awaiting.kind === 'draw_choice') {
    if (awaiting.canWin) div.innerHTML += '<button onclick="sendDrawChoice(\'win\')">胡</button>';
    if (awaiting.canKong) div.innerHTML += '<button onclick="sendDrawChoice(\'kong\')">杠</button>';
    div.innerHTML += '<span class="hint">或点击手牌出牌</span>';
  } else if (awaiting.kind === 'discard') {
    div.innerHTML = '<span class="hint">轮到你出牌，点击手牌</span>';
  } else if (awaiting.kind === 'claim') {
    const label = { win: '胡', pong: '碰', kong: '杠', pass: '过' };
    div.innerHTML = awaiting.actions.map((a) => `<button onclick="sendClaim('${a}')">${label[a]}</button>`).join('');
  }
  bottom.appendChild(div);
}

function renderCreatorPanel() {
  const panel = $('creatorPanel');
  if (!state || !authUser || state.creator !== authUser || state.tableId === 'main') {
    panel.classList.add('hidden');
    return;
  }
  panel.classList.remove('hidden');
  let html = '';
  state.players.forEach((p, i) => {
    if (!p || p.kind === 'bot') return;
    const isMe = i === you;
    const safeName = p.name.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    html += `<div class="row" style="margin:4px 0"><span style="font-size:13px">${safeName}${p.kind === 'agent' ? ' · Agent' : ''}${isMe ? '（你）' : ''}</span>${isMe ? '' : `<button class="small ghost" onclick="sendKick(${i})">踢出</button>`}</div>`;
  });
  if (!html) html = '<p style="margin:0">本桌暂无其他真人或 AI 玩家</p>';
  $('creatorSeats').innerHTML = html;
}

function render() {
  renderSeats();
  renderActions();
  renderCreatorPanel();
}

function sendKick(seat) {
  send({ type: 'kick', seat });
}
$('btnDissolve').onclick = () => {
  if (!confirm('确定解散本桌吗？所有人都会离开。')) return;
  send({ type: 'dissolve' });
};

function onTileClick(t) {
  if (!awaiting || (awaiting.kind !== 'discard' && awaiting.kind !== 'draw_choice')) return;
  if (!legalSet().has(t)) return;
  if (awaiting.kind === 'discard') send({ type: 'discard', tile: t });
  else send({ type: 'draw_choice', action: 'discard', tile: t });
  awaiting = null;
  renderActions();
}
function sendDrawChoice(action) {
  send({ type: 'draw_choice', action });
  awaiting = null;
  renderActions();
}
function sendClaim(action) {
  send({ type: 'claim', action });
  awaiting = null;
  renderActions();
}
function appendChat(name, text) {
  const el = $('chatList');
  const div = document.createElement('div');
  const b = document.createElement('b');
  b.textContent = name;
  div.appendChild(b);
  div.appendChild(document.createTextNode('：' + text));
  el.appendChild(div);
  while (el.children.length > 100) el.removeChild(el.firstChild);
  el.scrollTop = el.scrollHeight;
}
function sendChat() {
  const input = $('chatInput');
  const text = input.value.trim();
  if (!text) return;
  if (!authCode) { $('chatMsg').textContent = '请先登录再发言'; $('chatMsg').classList.remove('ok'); return; }
  send({ type: 'chat', text: text.slice(0, 200) });
  input.value = '';
}
$('btnChatSend').onclick = sendChat;
$('chatInput').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') sendChat(); });
function updateChatInput() {
  const input = $('chatInput');
  input.disabled = !authCode;
  input.placeholder = authCode ? '发言（200 字内）' : '登录后可发言';
}
async function refreshPoints() {
  if (!authCode) return;
  try {
    const r = await fetch('/api/me?code=' + encodeURIComponent(authCode));
    const data = await r.json();
    if (data.ok && typeof data.points === 'number') $('authPoints').textContent = data.points;
  } catch {}
}

function appendLog(text) {
  const el = $('log');
  const div = document.createElement('div');
  div.textContent = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${text}`;
  el.appendChild(div);
  while (el.children.length > 100) el.removeChild(el.firstChild);
  el.scrollTop = el.scrollHeight;
}

function onMessage(msg) {
  if (msg.type === 'authed') {
    authUser = msg.username;
    localStorage.setItem('mahjong-username', authUser);
    showAuthInfo();
    return;
  }
  if (msg.type === 'auth_error') {
    authCode = '';
    authUser = '';
    localStorage.removeItem('mahjong-auth-code');
    localStorage.removeItem('mahjong-username');
    showAuthForm('授权码已失效，请重新登录');
    return;
  }
  if (msg.type === 'error') {
    $('status').textContent = msg.message || '操作失败';
    appendLog(msg.message || '操作失败');
    return;
  }
  if (msg.type === 'chat') { appendChat(msg.name || '未知', msg.text || ''); return; }
  if (msg.type === 'kicked') {
    $('status').innerHTML = '你已被桌主请出本桌，<a href="/lobby.html">去大厅</a>';
    appendLog('你已被桌主请出本桌');
    return;
  }
  if (msg.type === 'table_dissolved') {
    $('status').innerHTML = '牌桌已被桌主解散，<a href="/lobby.html">去大厅</a>';
    appendLog('牌桌已被桌主解散');
    state = null;
    awaiting = null;
    render();
    return;
  }
  if (msg.type === 'joined') {
    you = msg.seat;
    joined = true;
    if (msg.tableId) currentTableId = msg.tableId;
    $('status').textContent = msg.seat >= 0 ? '已加入牌桌' : '正在观战';
    return;
  }
  if (msg.type === 'state') {
    state = msg;
    if (msg.tableId) currentTableId = msg.tableId;
    if (msg.tableName) {
      currentTableName = msg.tableName;
      $('tableName').textContent = `牌桌：${msg.tableName}（${msg.tableId}）`;
    }
    if (msg.phase === 'over') awaiting = null;
    render();
    return;
  }
  if (msg.type === 'your_turn') {
    awaiting = { kind: 'discard', legal: msg.legalDiscards || null };
    renderActions();
    return;
  }
  if (msg.type === 'draw_prompt') {
    awaiting = { kind: 'draw_choice', canWin: !!msg.canWin, canKong: !!msg.canKong };
    renderActions();
    return;
  }
  if (msg.type === 'claim_prompt') {
    awaiting = { kind: 'claim', actions: msg.actions };
    renderActions();
    return;
  }
  if (msg.type === 'thought') {
    thoughts[msg.seat] = msg.text;
    renderSeats();
    return;
  }
  if (msg.type === 'log') { appendLog(msg.text); return; }
  if (msg.type === 'gameover') {
    awaiting = null;
    const title = msg.winner === null ? '流局' : `${msg.winnerName} ${msg.winKind === 'zimo' ? '自摸' : '胡牌'}！`;
    $('modalTitle').textContent = title;
    $('modalPoints').textContent = (msg.winnerPoints !== null && msg.winnerPoints !== undefined)
      ? `${msg.winnerName} +${msg.pointsDelta} 分（总分 ${msg.winnerPoints}）`
      : '';
    let h = '';
    if (state) {
      state.players.forEach((p, i) => {
        if (!p) return;
        const hand = msg.hands && msg.hands[i] ? [...msg.hands[i]].sort((a, b) => a - b) : [];
        h += `<div style="margin:6px 0"><b>${p.name}</b> <span class="tiles" style="display:inline-flex">${hand.map((t) => tileHTML(t, true)).join('')}</span></div>`;
      });
    }
    $('modalHands').innerHTML = h;
    $('modal').classList.add('show');
    refreshPoints();
    return;
  }
}

$('quickStart').onclick = () => {
  if (!ws || ws.readyState !== WebSocket.OPEN) { connect(); setTimeout(doStart, 300); }
  else doStart();
};
function doStart() {
  if (!authCode) { openAuthMenu(); $('status').textContent = '请先登录再开局'; return; }
  if (joined) { send({ type: 'start' }); return; }
  send({ type: 'join', name: authUser, kind: 'human', authCode, tableId: currentTableId || undefined });
  setTimeout(() => send({ type: 'start' }), 200);
  $('quickStart').disabled = true;
  $('quickStart').textContent = '已开局';
}
$('again').onclick = () => {
  $('modal').classList.remove('show');
  $('modalPoints').textContent = '';
  if (!authCode) { openAuthMenu(); $('status').textContent = '请先登录再开局'; return; }
  send({ type: 'restart' });
};

connect();

// ---------- 账号面板 ----------
function showAuthForm(msg) {
  $('authForm').classList.remove('hidden');
  $('authInfo').classList.add('hidden');
  $('authToggle').textContent = '登录 / 注册';
  if (msg !== undefined) { $('authMsg').textContent = msg; $('authMsg').classList.remove('ok'); }
  updateChatInput();
  renderCreatorPanel();
}
function showAuthInfo() {
  $('authForm').classList.add('hidden');
  $('authInfo').classList.remove('hidden');
  $('authName').textContent = authUser;
  $('authCode').value = authCode;
  $('authToggle').textContent = authUser;
  updateChatInput();
  refreshPoints();
  renderCreatorPanel();
}
function sendAuthIfReady() {
  if (authCode) send({ type: 'auth', code: authCode });
}
async function authPost(path, body) {
  const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}
async function doAuth(path) {
  const username = $('authUser').value.trim();
  const password = $('authPass').value;
  const { data } = await authPost(path, { username, password });
  if (!data.ok) { $('authMsg').textContent = data.error || '失败'; $('authMsg').classList.remove('ok'); return; }
  authUser = data.username; authCode = data.code;
  localStorage.setItem('mahjong-username', authUser);
  localStorage.setItem('mahjong-auth-code', authCode);
  sendAuthIfReady();
  showAuthInfo();
}
$('btnRegister').onclick = () => doAuth('/api/register');
$('btnLogin').onclick = () => doAuth('/api/login');
$('btnLogout').onclick = () => {
  send({ type: 'logout' });
  authCode = ''; authUser = '';
  localStorage.removeItem('mahjong-auth-code');
  localStorage.removeItem('mahjong-username');
  showAuthForm('已退出登录');
};
$('btnCopyCode').onclick = async () => {
  const code = $('authCode').value;
  try { await navigator.clipboard.writeText(code); }
  catch {
    $('authCode').select();
    document.execCommand('copy');
  }
  $('authInfoMsg').textContent = '已复制';
  $('authInfoMsg').classList.add('ok');
};
$('btnRotateCode').onclick = async () => {
  const { data } = await authPost('/api/rotate', { code: authCode });
  if (!data.ok) { $('authInfoMsg').textContent = data.error || '更换失败'; $('authInfoMsg').classList.remove('ok'); return; }
  authCode = data.code;
  localStorage.setItem('mahjong-auth-code', authCode);
  $('authCode').value = authCode;
  sendAuthIfReady();
  $('authInfoMsg').textContent = '授权码已更换，旧的立即失效';
  $('authInfoMsg').classList.add('ok');
};
function openAuthMenu() { $('authMenu').classList.remove('hidden'); }
$('authToggle').onclick = (ev) => { ev.stopPropagation(); $('authMenu').classList.toggle('hidden'); };
document.addEventListener('click', (ev) => {
  const wrap = $('authWrap');
  if (wrap && !wrap.contains(ev.target)) $('authMenu').classList.add('hidden');
});
// 页面加载时校验已存授权码
(async () => {
  if (!authCode) { showAuthForm(); return; }
  try {
    const r = await fetch('/api/me?code=' + encodeURIComponent(authCode));
    const data = await r.json();
    if (data.ok) { authUser = data.username; localStorage.setItem('mahjong-username', authUser); showAuthInfo(); }
    else { authCode = ''; authUser = ''; localStorage.removeItem('mahjong-auth-code'); localStorage.removeItem('mahjong-username'); showAuthForm(); }
  } catch { showAuthForm(); }
})();

// ---------- 邀请链接 ----------
$('btnInvite').onclick = async () => {
  const id = currentTableId || urlTableId || 'main';
  const link = location.origin + '/?table=' + encodeURIComponent(id);
  try { await navigator.clipboard.writeText(link); }
  catch {
    const ta = document.createElement('textarea');
    ta.value = link;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  $('status').textContent = '邀请链接已复制：' + link;
};

// ---------- 复制给 AI 的话 ----------
$('btnCopyPrompt').onclick = async () => {
  const text = $('aiPrompt').textContent.trim();
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  $('promptMsg').textContent = '已复制，发给 AI 时记得附上你的授权码';
  $('promptMsg').classList.add('ok');
};
