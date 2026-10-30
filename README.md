# PREDICT 空投计算器

积分 → 代币数量 → U 价值。后台定时缓存 predict.fun 积分榜前 1 万名，前端输入地址秒查；价格取币安合约 `PREDICTUSDT`。

## 每 1 积分能领多少

| | 计算 | 结果 |
|---|---|---|
| 每积分代币总量 | 70,000,000 ÷ 4,680,000 | **≈ 14.9573 枚** |
| 每积分开盘解锁 (35%) | 14.9573 × 35% | **≈ 5.2350 枚** |
| 每 1 万积分 | | ≈ 149,573 枚（解锁 52,350 枚） |

U 价值 = 代币数 × 币安实时价格（页面上自动算）。总积分、空投量、解锁比例、价格在页面上都可以改。

## 运行

```bash
npm install
# 国内需走代理（Clash 默认 7897）
HTTPS_PROXY=http://127.0.0.1:7897 npm start          # macOS / Linux
set HTTPS_PROXY=http://127.0.0.1:7897 && npm start    # Windows cmd
```

打开 http://localhost:3000

## ⚠️ 需要你确认一下积分榜查询

`GetAllocationRounds` 已按你给的请求接好。**积分榜的 GraphQL 查询我拿不到原文**，`config.js` 里的
`LEADERBOARD_QUERY` 是猜的。请在 predict.fun 积分榜页面 DevTools → Network 找到查榜单的 graphql 请求，
把 `query` 粘到 `LEADERBOARD_QUERY`，分页变量填到 `leaderboardVariables`。
返回结构不用改代码：程序会自动找到榜单数组、识别地址/积分/排名字段，有 `pageInfo.endCursor` 就自动走游标翻页。

缓存写在 `data/leaderboard.json`，重启直接加载，每 30 分钟刷新（`REFRESH_MINUTES`）。

## 接口

- `GET /api/summary` — 每积分代币数、价格、分配轮次、缓存状态
- `GET /api/lookup?address=0x...` — 查地址积分/排名/代币/U 价值
- `GET /api/leaderboard?page=0&size=50&q=` — 缓存榜单分页/搜索
