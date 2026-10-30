// 所有可调参数集中在这里，均可用同名环境变量覆盖。
const env = (k, d) => (process.env[k] !== undefined ? process.env[k] : d);

module.exports = {
  PORT: Number(env('PORT', 3000)),

  // ---- 空投参数 ----
  TOTAL_POINTS: Number(env('TOTAL_POINTS', 468_000_000)), // 全网总积分 4.68 亿（totalPoints 合计）
  AIRDROP_TOKENS: Number(env('AIRDROP_TOKENS', 70_000_000)), // 空投总量 7000 万
  UNLOCK_RATIO: Number(env('UNLOCK_RATIO', 0.35)),          // 开盘解锁 35%

  // ---- 数据源 ----
  GRAPHQL_URL: env('GRAPHQL_URL', 'https://graphql.predict.fun/graphql'),
  SEASON_ID: Number(env('SEASON_ID', 1)),
  BINANCE_SYMBOL: env('BINANCE_SYMBOL', 'PREDICTUSDT'),

  // ---- 积分榜缓存 ----
  LEADERBOARD_LIMIT: Number(env('LEADERBOARD_LIMIT', 10_000)), // 缓存前 N 名
  PAGE_SIZE: Number(env('PAGE_SIZE', 25)),          // 官网每页 25，保持一致避免超限
  REFRESH_MINUTES: Number(env('REFRESH_MINUTES', 30)),
  REQUEST_DELAY_MS: Number(env('REQUEST_DELAY_MS', 200)),    // 翻页间隔，避免被限流

  // ---- 积分榜 GraphQL 查询 ----
  // 返回结构已按官网实际响应对齐（edges.node.{rank,totalPoints,allocationRoundPoints,account{...}} + pageInfo）。
  // ⚠️ 但 leaderboard(...) 的参数名是猜的（first/after）。如果启动日志报错，请在 DevTools 里复制
  // 官网榜单请求的 query 粘到这里，并按它的变量名改 leaderboardVariables。
  LEADERBOARD_QUERY: `query GetLeaderboard($seasonId: Int, $first: Int, $after: String) {
  leaderboard(seasonId: $seasonId, first: $first, after: $after) {
    edges {
      node {
        rank
        rankChange
        totalPoints
        allocationRoundPoints
        account { name address imageUrl imageStatus twitterUsername }
      }
      cursor
    }
    pageInfo { hasNextPage endCursor }
  }
}`,
  // cursor 为上一页的 pageInfo.endCursor（首页为 null）
  leaderboardVariables: ({ pageSize, cursor, seasonId }) => ({ seasonId, first: pageSize, after: cursor }),
};
