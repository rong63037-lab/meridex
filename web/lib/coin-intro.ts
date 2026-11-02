// 币种 / 品种简介：本地静态内容，只做客观介绍，不含价格预测或收益承诺。
// 未列出的品种使用通用模板（见 genericIntro）。
export type Intro = { launched?: string; kind: string; body: string[]; risks?: string };

export const INTROS: Record<string, Intro> = {
  BTC: { launched: "2009", kind: "公链原生币", body: ["比特币是第一个去中心化加密资产，由化名“中本聪”的开发者在 2008 年提出白皮书、2009 年上线。", "比特币使用工作量证明（PoW）机制，由矿工竞争记账；总量上限为 2100 万枚，大约每四年区块奖励减半一次。"] },
  ETH: { launched: "2015", kind: "智能合约平台", body: ["以太坊是支持智能合约的区块链平台，ETH 是其原生币，用于支付链上交易费用（Gas）。", "以太坊在 2022 年从工作量证明转为权益证明（PoS），大量去中心化应用、稳定币和代币运行在以太坊及其二层网络上。"] },
  SOL: { launched: "2020", kind: "智能合约平台", body: ["Solana 是注重高吞吐、低手续费的公链，SOL 用于支付手续费和质押。", "Solana 历史上出现过多次网络中断，这是评估其风险时需要考虑的因素。"] },
  XRP: { launched: "2012", kind: "支付网络代币", body: ["XRP 是 XRP Ledger 的原生币，设计目标是快速、低成本的跨境价值转移。", "Ripple 公司与 XRP 关系密切，其监管诉讼曾长期影响 XRP 的市场。"] },
  BNB: { launched: "2017", kind: "交易所生态代币", body: ["BNB 最初作为币安交易所的平台代币发行，现为 BNB Chain 的原生币，用于支付手续费。", "BNB 与单一公司生态高度相关，需要关注其发行方的经营和监管情况。"] },
  ADA: { launched: "2017", kind: "智能合约平台", body: ["Cardano 是采用权益证明（Ouroboros 协议）的公链，ADA 用于支付手续费和质押。"] },
  DOGE: { launched: "2013", kind: "迷因币", body: ["狗狗币最初作为玩笑项目诞生，使用工作量证明，没有总量上限。", "价格受社交媒体和名人言论影响较大，波动剧烈。"] },
  TRX: { launched: "2017", kind: "公链原生币", body: ["TRON 是一条公链，TRX 是其原生币。大量 USDT 在 TRON 网络上流通，转账时务必确认网络一致。"] },
  AVAX: { launched: "2020", kind: "智能合约平台", body: ["Avalanche 是由多条链组成的智能合约平台，AVAX 用于支付手续费和质押。"] },
  DOT: { launched: "2020", kind: "跨链平台", body: ["Polkadot 是连接多条平行链的多链网络，DOT 用于治理、质押和平行链相关机制。"] },
  LINK: { launched: "2017", kind: "预言机代币", body: ["Chainlink 是去中心化预言机网络，为智能合约提供链外数据（如价格）。LINK 是运行在以太坊上的代币，用于支付节点服务。"] },
  TON: { launched: "2021", kind: "公链原生币", body: ["TON（The Open Network）最初由 Telegram 团队设计，后由社区继续开发，Toncoin 是其原生币。"] },
  LTC: { launched: "2011", kind: "支付型加密资产", body: ["莱特币是早期基于比特币代码修改的加密资产，出块更快，总量上限 8400 万枚。"] },
  BCH: { launched: "2017", kind: "支付型加密资产", body: ["比特币现金是 2017 年从比特币分叉出来的链，主张更大的区块以容纳更多交易。"] },
  SHIB: { launched: "2020", kind: "迷因币", body: ["柴犬币是运行在以太坊上的迷因代币，单价极低、流通量极大，价格波动非常剧烈。"] },
  USDT: { launched: "2014", kind: "美元稳定币", body: ["USDT 由 Tether 发行，声称以美元及等价资产 1:1 支持，是交易量最大的稳定币之一。", "它在多条区块链上发行（如以太坊、TRON），转账时必须选择正确网络。"], risks: "稳定币存在发行方信用、储备透明度、冻结和脱锚风险。" },
  USDC: { launched: "2018", kind: "美元稳定币", body: ["USDC 由 Circle 发行，声称以现金和短期美国国债 1:1 支持，并定期公布储备证明。"], risks: "稳定币存在发行方信用、冻结和脱锚风险。" },
  PAXG: { kind: "黄金代币", body: ["PAX Gold 由 Paxos 发行，每枚代币对应一金衡盎司存放在金库中的伦敦金条。"], risks: "价格跟随黄金，但仍存在发行方和托管风险。" },
  XAUT: { kind: "黄金代币", body: ["Tether Gold 由 Tether 发行，每枚代币对应一金衡盎司实物黄金。"], risks: "价格跟随黄金，但仍存在发行方和托管风险。" },
  XAU: { kind: "贵金属", body: ["黄金是历史最悠久的价值储存资产之一，被各国央行作为储备资产持有。", "金价受美元走势、实际利率、央行购金和避险情绪等因素影响。"] },
  XAG: { kind: "贵金属", body: ["白银兼具贵金属和工业金属属性，大量用于光伏、电子等工业领域，价格波动通常大于黄金。"] },
  XPT: { kind: "贵金属", body: ["铂金主要用于汽车尾气催化剂、珠宝和工业，供给集中在南非等少数国家。"] },
  XPD: { kind: "贵金属", body: ["钯金主要用于汽油车尾气催化剂，供给集中在俄罗斯和南非，历史波动很大。"] },
  BRENT: { kind: "能源商品", body: ["布伦特原油是国际原油定价的主要基准之一，受 OPEC+ 产量政策、全球需求和地缘政治影响。"] },
  WTI: { kind: "能源商品", body: ["WTI（西德克萨斯中质原油）是美国原油定价基准，与布伦特原油走势相关但存在价差。"] },
  EUR: { kind: "法定货币", body: ["欧元是欧元区的官方货币，汇率受欧洲央行与美联储利率政策差异、经济数据等影响。"] },
  SGD: { kind: "法定货币", body: ["新加坡元由新加坡金融管理局（MAS）以汇率为主要政策工具进行管理。"] },
};

const KIND: Record<string, string> = { metal: "贵金属", crypto: "加密资产", commodity: "大宗商品", fx: "外汇" };

export function genericIntro(name: string, category: string): Intro {
  return {
    kind: KIND[category] ?? "资产",
    body: [`${name} 属于${KIND[category] ?? "资产"}类别。本页显示的价格和涨跌来自本平台行情，仅供参考。`, "该品种的详细介绍正在整理中。"],
  };
}

export function baseOf(symbol: string): string {
  return symbol.split("/")[0].toUpperCase();
}
