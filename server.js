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
let board = { rows: [], byWeek: [], byAddress: new Map(), updatedAt: null, refreshing: false, error: null };

function toNum(v) {
  const n = typeof v === 'string' ? Number(v.replace(/,/g, '')) : Number(v);
  return Number.isFinite(n) ? n : 0;
}

// 官网结构：leaderboard.edges[].node.{rank,rankChange,totalPoints,allocationRoundPoints,account{...}}
function normalizeRow(n) {
  const acc = n.account || n;
  if (!acc.address) return null;
  return {
    address: acc.address.toLowerCase(),
    displayAddress: acc.address,
    name: acc.name || null,
    twitter: acc.twitterUsername || null,
    imageUrl: acc.imageStatus === 'PUBLIC' ? acc.imageUrl || null : null,
    rank: n.rank != null ? toNum(n.rank) : null,       // 总榜排名（官方）
    rankChange: n.rankChange != null ? toNum(n.rankChange) : 0,
    totalPoints: toNum(n.totalPoints),
    weekPoints: toNum(n.allocationRoundPoints),          // 本轮（本周）积分 → 用来算空投
  };
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
      const lb = data && data.leaderboard;
      const edges = (lb && (lb.edges || lb.items || lb.list)) || [];
      let added = 0;
      for (const e of edges) {
        const n = normalizeRow(e.node || e);
        if (n && !seen.has(n.address)) { seen.add(n.address); rows.push(n); added++; }
      }
      const pi = lb && lb.pageInfo;
      if (!added || !pi || !pi.hasNextPage || !pi.endCursor) break;
      cursor = pi.endCursor;
      if (page % 20 === 0) console.log(`[leaderboard] 已抓取 ${rows.length} 条`);
      await sleep(cfg.REQUEST_DELAY_MS);
    }
    if (!rows.length) throw new Error('积分榜查询没有返回任何地址，请检查 config.js 里的 LEADERBOARD_QUERY');
    rows.length = Math.min(rows.length, cfg.LEADERBOARD_LIMIT);
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
  // 周榜排名：缓存内按本周积分排序（只覆盖总榜前 N 名里的人）
  [...rows].sort((a, b) => b.weekPoints - a.weekPoints).forEach((r, i) => { r.weekRank = i + 1; });
  board.rows = rows;
  board.byWeek = [...rows].sort((a, b) => a.weekRank - b.weekRank);
  board.byAddress = new Map(rows.map((r) => [r.address, r]));
  board.updatedAt = updatedAt;
}

function loadCache() {
  try {
    const j = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if ((j.rows || [])[0] && 'weekPoints' in j.rows[0]) setBoard(j.rows, j.updatedAt);
    console.log(`[leaderboard] 从缓存载入 ${board.rows.length} 条`);
  } catch (_) {}
}

// ---------------- 单地址实时查询（含每周积分） ----------------
const USER_QUERY = `query GetLeaderboardUserStats($address: Address!, $seasonId: Int) {
  account(address: $address) {
    name
    address
    imageUrl
    imageStatus
    twitterUsername
    leaderboard(seasonId: $seasonId) {
      allocationRoundPoints
      totalPoints
      rank
      rankChange
    }
    weeklyPointsHistory(seasonId: $seasonId) {
      week
      totalPoints
      referralPoints
      calculated
    }
  }
}`;
const userCache = new Map(); // address -> { at, data }

async function fetchUser(address) {
  const hit = userCache.get(address);
  if (hit && Date.now() - hit.at < 60_000) return hit.data;
  const data = await gql(USER_QUERY, { address, seasonId: cfg.SEASON_ID }, 'GetLeaderboardUserStats');
  const acc = data && data.account;
  let user = null;
  if (acc) {
    user = normalizeRow({ ...(acc.leaderboard || {}), account: acc });
    user.weekly = (acc.weeklyPointsHistory || [])
      .map((w) => ({ week: toNum(w.week), points: toNum(w.totalPoints), referral: toNum(w.referralPoints), calculated: !!w.calculated }))
      .sort((a, b) => a.week - b.week);
  }
  if (userCache.size > 5000) userCache.clear();
  userCache.set(address, { at: Date.now(), data: user });
  return user;
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
          cachedWeekPointsSum: board.rows.reduce((s, r) => s + r.weekPoints, 0),
        },
      });
    }

    if (url.pathname === '/api/lookup') {
      const address = (url.searchParams.get('address') || '').trim().toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(address)) return send(res, 400, { error: '地址格式不正确' });
      const cached = board.byAddress.get(address);
      let user = null, source = 'live', liveError = null;
      try { user = await fetchUser(address); } catch (e) { liveError = e.message; }
      if (!user && cached) { user = cached; source = 'cache'; }
      if (!user) return send(res, 404, { error: liveError ? `实时查询失败（${liveError}），且该地址不在缓存中` : '该地址没有积分记录' });
      const p = (await getPrice()).value;
      return send(res, 200, {
        ...user,
        weekRank: cached ? cached.weekRank : null,
        source,
        ...calc(user.weekPoints, economics(), p),
        price: p,
      });
    }

    if (url.pathname === '/api/leaderboard') {
      const page = Math.max(0, Number(url.searchParams.get('page')) || 0);
      const size = Math.min(200, Math.max(1, Number(url.searchParams.get('size')) || 50));
      const q = (url.searchParams.get('q') || '').toLowerCase();
      const base = url.searchParams.get('sort') === 'total' ? board.rows : board.byWeek;
      const list = q ? base.filter((r) => r.address.includes(q) || (r.name || '').toLowerCase().includes(q)) : base;
      const p = price.value;
      const eco = economics();
      return send(res, 200, {
        total: list.length,
        page,
        size,
        rows: list.slice(page * size, page * size + size).map((r) => ({ ...r, ...calc(r.weekPoints, eco, p) })),
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
