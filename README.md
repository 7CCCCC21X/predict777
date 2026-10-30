# PREDICT 空投计算器

总积分 → 代币数量 → U 价值。后台定时缓存 predict.fun 积分榜前 1 万名（周榜/总榜），地址查询走官方 `GetLeaderboardUserStats` 实时接口（含每周积分历史）；价格取币安合约 `PREDICTUSDT`。

## 每 1 积分能领多少

| | 计算 | 结果 |
|---|---|---|
| 每积分代币总量 | 70,000,000 ÷ 468,000,000 | **≈ 0.149573 枚** |
| 每积分开盘解锁 (35%) | 0.149573 × 35% | **≈ 0.052350 枚** |
| 每 100 万积分 | | ≈ 149,573 枚（解锁 52,350 枚） |

可领代币 = 总积分 `totalPoints` × 0.149573。U 价值 = 代币数 × 币安实时价格。总积分、空投量、解锁比例、价格在页面上都可以改。

## 运行

```bash
npm install
# 国内需走代理（Clash 默认 7897）
HTTPS_PROXY=http://127.0.0.1:7897 npm start          # macOS / Linux
set HTTPS_PROXY=http://127.0.0.1:7897 && npm start    # Windows cmd
```

打开 http://localhost:3000

## ⚠️ 积分榜查询的参数名需要确认

- 地址查询（`GetLeaderboardUserStats`）、分配轮次（`GetAllocationRounds`）用的是官网原始语句。
- 积分榜返回结构已按官网实际响应对齐，但 `config.js` 里 `leaderboard(seasonId, first, after)` 的**参数名是猜的**。
  启动日志如果报 `[leaderboard] ...` 错误，请把官网榜单请求的 `query` 粘到 `LEADERBOARD_QUERY`，按变量名改 `leaderboardVariables`。
- 周榜排名是在缓存的总榜前 1 万名内按本周积分排序得出的。总榜 1 万名之外、但本周积分很高的人不会出现在周榜里（查地址不受影响）。

缓存写在 `data/leaderboard.json`，重启直接加载，每 30 分钟刷新（`REFRESH_MINUTES`）。

## 接口

- `GET /api/summary` — 每积分代币数、价格、分配轮次、缓存状态
- `GET /api/lookup?address=0x...` — 查地址积分/排名/代币/U 价值
- `GET /api/leaderboard?page=0&size=50&q=` — 缓存榜单分页/搜索
