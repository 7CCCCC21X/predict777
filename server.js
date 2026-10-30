const http = require('http');
const fs = require('fs');
const path = require('path');
const cfg = require('./config');

// 走本地代理（如 Clash 127.0.0.1:7897）：设置 HTTPS_PROXY 环境变量即可
const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
if (proxy) {
  try {
    const { ProxyAgent, setGlobalDispatcher } = require('undici');
    setGlobalDispatcher(new ProxyAgent(proxy));
    console.log(`[proxy] 使用代理 ${proxy}`);
  } catch (e) {
    console.warn('[proxy] 未安装 undici，忽略代理设置（先运行 npm install）');
  }
}

const DATA_DIR = path.join(__dirname, 'data');
const CACHE_FILE = path.join(DATA_DIR, 'leaderboard.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- GraphQL ----------------
async function gql(query, variables, operationName) {
  const res = await fetch(cfg.GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      origin: 'https://predict.fun',
      referer: 'https://predict.fun/',
    },
    body: JSON.stringify({ query, variables, operationName }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json) throw new Error(`GraphQL HTTP ${res.status}`);
  if (json.errors && !json.data) throw new Error(json.errors.map((e) => e.message).join('; '));
  return json.data;
}

// ---------------- 分配轮次 ----------------
const ROUNDS_QUERY = `query GetAllocationRounds($seasonId: Int) {
  allocationRounds(seasonId: $seasonId) {
    id
    week
    startTime
    endTime
    allocationAmount
  }
}`;
let rounds = { list: [], total: 0, updatedAt: null, error: null };

async function refreshRounds() {
  try {
    const data = await gql(ROUNDS_QUERY, { seasonId: cfg.SEASON_ID }, 'GetAllocationRounds');
    const list = (data.allocationRounds || []).slice().sort((a, b) => Number(a.week) - Number(b.week));
    rounds = {
      list,
      total: list.reduce((s, r) => s + toNum(r.allocationAmount), 0),
      updatedAt: Date.now(),
      error: null,
    };
  } catch (e) {
    rounds.error = e.message;
    console.error('[rounds]', e.message);
  }
}

// ---------------- 币安价格 ----------------
let price = { value: null, source: null, updatedAt: 0, error: null };

async function getPrice() {
  if (Date.now() - price.updatedAt < 10_000) return price;
  const sym = cfg.BINANCE_SYMBOL;
  const sources = [
    ['binance-futures', `https://fapi.binance.com/fapi/v1/ticker/price?symbol=${sym}`],
    ['binance-spot', `https://api.binance.com/api/v3/ticker/price?symbol=${sym}`],
  ];
  for (const [source, url] of sources) {
    try {
      const res = await fetch(url);
      const j = await res.json();
      if (j && j.price) {
        price = { value: Number(j.price), source, updatedAt: Date.now(), error: null };
        return price;
      }
    } catch (e) {
      price.error = e.message;
    }
  }
  price.updatedAt = Date.now(); // 失败也节流，保留上一次的价格
  price.error = price.error || '币安未返回价格';
  return price;
}

// ---------------- 积分榜（前 N 名缓存） ----------------
let board = { rows: [], byAddress: new Map(), updatedAt: null, refreshing: false, error: null };

function toNum(v) {
  const n = typeof v === 'string' ? Number(v.replace(/,/g, '')) : Number(v);
  return Number.isFinite(n) ? n : 0;
}

// 在响应里找“最像榜单”的数组（兼容 list / items / edges{node} 等各种结构）
function findRows(obj) {
  let best = null;
  let pageInfo = null;
  (function walk(o) {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) {
      if (o.length && typeof o[0] === 'object' && (!best || o.length > best.length)) best = o;
      o.forEach(walk);
      return;
    }
    if (o.pageInfo && !pageInfo) pageInfo = o.pageInfo;
    Object.values(o).forEach(walk);
  })(obj);
  return { rows: (best || []).map((r) => (r && r.node ? r.node : r)), pageInfo };
}

function flatten(o, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(o || {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = v;
  }
  return out;
}

function normalizeRow(raw) {
  const f = flatten(raw);
  let address = null, points = null, rank = null, name = null;
  for (const [k, v] of Object.entries(f)) {
    const leaf = k.split('.').pop().toLowerCase();
    if (!address && typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v)) address = v;
    if (points === null && /(points|point|score|totalpoints)$/.test(leaf) && v !== null && v !== '') points = toNum(v);
    if (rank === null && /rank|position/.test(leaf)) rank = toNum(v);
    if (!name && /(username|name|handle)$/.test(leaf) && typeof v === 'string') name = v;
  }
  return address ? { address: address.toLowerCase(), points: points || 0, rank, name } : null;
}

async function refreshLeaderboard() {
  if (board.refreshing) return;
  board.refreshing = true;
  const started = Date.now();
  const rows = [];
  const seen = new Set();
  let cursor = null;
  try {
    for (let page = 0; rows.length < cfg.LEADERBOARD_LIMIT; page++) {
      const vars = cfg.leaderboardVariables({ page, pageSize: cfg.PAGE_SIZE, cursor, seasonId: cfg.SEASON_ID });
      const data = await gql(cfg.LEADERBOARD_QUERY, vars);
      const { rows: raw, pageInfo } = findRows(data);
      let added = 0;
      for (const r of raw) {
        const n = normalizeRow(r);
        if (n && !seen.has(n.address)) {
          seen.add(n.address);
          rows.push(n);
          added++;
        }
      }
      if (!added) break; // 没有新数据（到底了，或接口不支持分页）
      if (pageInfo) {
        if (pageInfo.hasNextPage === false || !pageInfo.endCursor) break;
        cursor = pageInfo.endCursor;
      }
      if (page % 10 === 0) console.log(`[leaderboard] 已抓取 ${rows.length} 条`);
      await sleep(cfg.REQUEST_DELAY_MS);
    }
    if (!rows.length) throw new Error('积分榜查询没有返回任何地址，请检查 config.js 里的 LEADERBOARD_QUERY');
    rows.sort((a, b) => b.points - a.points);
    rows.length = Math.min(rows.length, cfg.LEADERBOARD_LIMIT);
    rows.forEach((r, i) => { if (!r.rank) r.rank = i + 1; });
    setBoard(rows, Date.now());
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ updatedAt: board.updatedAt, rows }));
    board.error = null;
    console.log(`[leaderboard] 完成：${rows.length} 条，用时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
  } catch (e) {
    board.error = e.message;
    console.error('[leaderboard]', e.message);
  } finally {
    board.refreshing = false;
  }
}

function setBoard(rows, updatedAt) {
  board.rows = rows;
  board.byAddress = new Map(rows.map((r) => [r.address, r]));
  board.updatedAt = updatedAt;
}

function loadCache() {
  try {
    const j = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    setBoard(j.rows || [], j.updatedAt);
    console.log(`[leaderboard] 从缓存载入 ${board.rows.length} 条`);
  } catch (_) {}
}

// ---------------- 计算 ----------------
function economics() {
  const perPoint = cfg.AIRDROP_TOKENS / cfg.TOTAL_POINTS;
  return {
    totalPoints: cfg.TOTAL_POINTS,
    airdropTokens: cfg.AIRDROP_TOKENS,
    unlockRatio: cfg.UNLOCK_RATIO,
    tokensPerPoint: perPoint,
    unlockedPerPoint: perPoint * cfg.UNLOCK_RATIO,
  };
}

function calc(points, eco, p) {
  const tokens = points * eco.tokensPerPoint;
  const unlocked = tokens * eco.unlockRatio;
  return {
    tokens,
    unlocked,
    locked: tokens - unlocked,
    usd: p ? tokens * p : null,
    unlockedUsd: p ? unlocked * p : null,
    share: points / eco.totalPoints,
  };
}

// ---------------- HTTP ----------------
function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/api/summary') {
      const p = await getPrice();
      return send(res, 200, {
        economics: economics(),
        price: p,
        rounds,
        leaderboard: {
          count: board.rows.length,
          updatedAt: board.updatedAt,
          refreshing: board.refreshing,
          error: board.error,
          cachedPointsSum: board.rows.reduce((s, r) => s + r.points, 0),
        },
      });
    }

    if (url.pathname === '/api/lookup') {
      const address = (url.searchParams.get('address') || '').trim().toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(address)) return send(res, 400, { error: '地址格式不正确' });
      const row = board.byAddress.get(address);
      const p = (await getPrice()).value;
      const eco = economics();
      if (!row) return send(res, 404, { error: `该地址不在积分榜前 ${board.rows.length} 名缓存中，可在下方手动输入积分计算`, address });
      return send(res, 200, { ...row, ...calc(row.points, eco, p), price: p });
    }

    if (url.pathname === '/api/leaderboard') {
      const page = Math.max(0, Number(url.searchParams.get('page')) || 0);
      const size = Math.min(200, Math.max(1, Number(url.searchParams.get('size')) || 50));
      const q = (url.searchParams.get('q') || '').toLowerCase();
      const list = q ? board.rows.filter((r) => r.address.includes(q) || (r.name || '').toLowerCase().includes(q)) : board.rows;
      const p = price.value;
      const eco = economics();
      return send(res, 200, {
        total: list.length,
        page,
        size,
        rows: list.slice(page * size, page * size + size).map((r) => ({ ...r, ...calc(r.points, eco, p) })),
      });
    }

    // 静态文件
    const file = path.join(__dirname, 'public', url.pathname === '/' ? 'index.html' : path.normalize(url.pathname));
    if (!file.startsWith(path.join(__dirname, 'public'))) return send(res, 403, 'forbidden', 'text/plain');
    fs.readFile(file, (err, buf) => {
      if (err) return send(res, 404, 'not found', 'text/plain');
      const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[path.extname(file)] || 'application/octet-stream';
      send(res, 200, buf, `${type}; charset=utf-8`);
    });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
});

loadCache();
server.listen(cfg.PORT, () => console.log(`打开 http://localhost:${cfg.PORT}`));
refreshRounds();
getPrice();
refreshLeaderboard();
setInterval(() => { refreshRounds(); refreshLeaderboard(); }, cfg.REFRESH_MINUTES * 60_000);
