// Copy for the pro-style navigation, wallet overview and markets views.
const zh = {
  buyCrypto: "买币", buyConvert: "闪兑", buyConvertHint: "一键按报价兑换", buyRecurring: "定投", buyRecurringHint: "按日 / 周 / 月自动买入",
  marketsMenu: "行情", marketsAll: "全部行情", marketsAllHint: "价格、涨跌和成交额", marketsGainers: "涨幅榜",
  tradeMenu: "交易", tradeSpot: "现货交易", tradeSpotHint: "限价 / 市价，订单簿撮合", tradeMore: "更多玩法（默认关闭）",
  assetsMenu: "资产", assetsOverview: "资产总览", deposit: "充值", withdraw: "提现", history: "记录", orders: "委托与成交",
  search: "搜索币对", colorScheme: "涨跌颜色", greenUp: "绿涨红跌", redUp: "红涨绿跌",
  tabHome: "首页", tabMarkets: "行情", tabTrade: "交易", tabOrders: "委托", tabAssets: "资产",
  more: "更多", totalAssets: "总资产", spot: "现货", futures: "合约", earn: "理财",
  estPnl: "按当前持仓估算", pnlNote: "按当前持仓和历史价格估算，不代表实际盈亏",
  futuresOff: "合约默认关闭，开通后在此显示仓位。", earnEmpty: "暂无理财产品。可以使用定投按计划买入。", goRecurring: "去定投",
  favorites: "自选", gainers: "涨幅榜", pair: "币对", lastPrice: "最新价", change24: "24h 涨跌", vol24: "24h 成交额", high24: "24h 最高", low24: "24h 最低",
  noFavorites: "还没有自选，点 ☆ 添加。", chart: "图表", hideChart: "收起图表", account: "账户", chat: "客服",
};
const en: typeof zh = {
  buyCrypto: "Buy", buyConvert: "Convert", buyConvertHint: "Swap at a firm quote", buyRecurring: "Recurring buy", buyRecurringHint: "Daily / weekly / monthly",
  marketsMenu: "Markets", marketsAll: "All markets", marketsAllHint: "Prices, change and volume", marketsGainers: "Top gainers",
  tradeMenu: "Trade", tradeSpot: "Spot", tradeSpotHint: "Limit / market on the order book", tradeMore: "More (off by default)",
  assetsMenu: "Assets", assetsOverview: "Overview", deposit: "Deposit", withdraw: "Withdraw", history: "History", orders: "Orders and fills",
  search: "Search pairs", colorScheme: "Up/down colours", greenUp: "Green up, red down", redUp: "Red up, green down",
  tabHome: "Home", tabMarkets: "Markets", tabTrade: "Trade", tabOrders: "Orders", tabAssets: "Assets",
  more: "More", totalAssets: "Total assets", spot: "Spot", futures: "Futures", earn: "Earn",
  estPnl: "Estimated on current holdings", pnlNote: "Estimated from current holdings and past prices, not realised PnL",
  futuresOff: "Futures are off by default. Positions appear here once enabled.", earnEmpty: "No earn products. Use recurring buy to invest on a schedule.", goRecurring: "Recurring buy",
  favorites: "Favourites", gainers: "Gainers", pair: "Pair", lastPrice: "Last", change24: "24h change", vol24: "24h volume", high24: "24h high", low24: "24h low",
  noFavorites: "No favourites yet. Tap ☆ to add.", chart: "Chart", hideChart: "Hide chart", account: "Account", chat: "Support",
};
const ms: typeof zh = { ...en, buyCrypto: "Beli", marketsMenu: "Pasaran", tradeMenu: "Dagang", assetsMenu: "Aset", deposit: "Deposit", withdraw: "Keluarkan", history: "Sejarah", tabHome: "Utama", tabMarkets: "Pasaran", tabTrade: "Dagang", tabOrders: "Pesanan", tabAssets: "Aset", more: "Lagi", totalAssets: "Jumlah aset", favorites: "Kegemaran" };

export function proCopy(lang: string) {
  return lang === "en" ? en : lang === "ms" ? ms : zh;
}

export const SWAP_KEY = "meridex.swapColors";
export function applySwap(on: boolean) {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle("swap-updown", on);
}
