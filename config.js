// 所有可调参数集中在这里，均可用同名环境变量覆盖。
const env = (k, d) => (process.env[k] !== undefined ? process.env[k] : d);

module.exports = {
  PORT: Number(env('PORT', 3000)),

  // ---- 空投参数 ----
  TOTAL_POINTS: Number(env('TOTAL_POINTS', 4_680_000)),   // 全网总积分 4.68M
  AIRDROP_TOKENS: Number(env('AIRDROP_TOKENS', 70_000_000)), // 空投总量 7000 万
  UNLOCK_RATIO: Number(env('UNLOCK_RATIO', 0.35)),          // 开盘解锁 35%

  // ---- 数据源 ----
  GRAPHQL_URL: env('GRAPHQL_URL', 'https://graphql.predict.fun/graphql'),
  SEASON_ID: Number(env('SEASON_ID', 1)),
  BINANCE_SYMBOL: env('BINANCE_SYMBOL', 'PREDICTUSDT'),

  // ---- 积分榜缓存 ----
  LEADERBOARD_LIMIT: Number(env('LEADERBOARD_LIMIT', 10_000)), // 缓存前 N 名
  PAGE_SIZE: Number(env('PAGE_SIZE', 100)),
  REFRESH_MINUTES: Number(env('REFRESH_MINUTES', 30)),
  REQUEST_DELAY_MS: Number(env('REQUEST_DELAY_MS', 200)),    // 翻页间隔，避免被限流

  // ---- 积分榜 GraphQL 查询 ----
  // ⚠️ 下面的查询是按常见写法猜的。请打开 predict.fun 积分榜页面 → DevTools → Network，
  // 找到 graphql 请求里查询榜单的那条，把 query 原样粘贴到这里，并在 leaderboardVariables 里
  // 按它的变量名填写分页参数。返回结构不用管：程序会自动在响应里找到榜单数组，
  // 并识别 地址/积分/排名 字段；若返回里有 pageInfo.endCursor 会自动用游标翻页。
  LEADERBOARD_QUERY: `query GetLeaderboard($seasonId: Int, $first: Int, $after: String, $skip: Int) {
  leaderboard(seasonId: $seasonId, first: $first, after: $after, skip: $skip) {
    pageInfo { hasNextPage endCursor }
    edges { node { rank address points } }
  }
}`,
  // page 从 0 开始；cursor 为上一页的 endCursor（首页为 null）
  leaderboardVariables: ({ page, pageSize, cursor, seasonId }) => ({
    seasonId,
    first: pageSize,
    after: cursor,
    skip: page * pageSize,
  }),
};
