# 美瑞德 MERIDEX · 多资产交易所

新加坡主体 `SG-OPCO` 的多资产现货沙盒。贵金属、加密货币、大宗商品和外汇各有独立订单簿。黄金 XAU/USD 仍按毫克、美分/克撮合，只是其中一本。另外有白银、铂、钯、克/千克/盎司黄金合约、金银比，以及加密货币、大宗商品和美元外汇。现货、闪兑和定投走真实复式账本。杠杆、永续和跟单默认关闭；所有者在文案页打开后，已核验客户用自己的保证金或合约钱包对内部账本交易，页面标明尚未接入外部做市商。主后台「流动性」是外部做市的本地适配层，三家来源默认关闭；影子只记对照，实盘要对冲后才给客户成交，紧急开关立即停掉新的外部单。没有接入任何真实做市商。模拟交易仍是另一套账。没有真实资金、真实银行或真实 KYC 供应商。报价来自公开行情，断线时在参考价附近游走，页面标明参考价，不是持牌报价。美元是主结算货币。默认准入覆盖亚洲各辖区，并保留美国。未受全面制裁的居住地可以开户，贵金属、大宗商品和外汇默认开放。当地禁止居民交易加密货币的辖区（中国大陆、孟加拉国、尼泊尔、卡塔尔、科威特、阿曼、伊拉克、阿富汗）该品类默认关闭。朝鲜、伊朗、叙利亚硬关闭且不能在合规页改开。阿富汗和缅甸标记为高风险，需要加强尽职调查。杠杆、永续和跟单各地默认关闭。制裁命中一律拒绝。

界面默认中文，可以切到英文。交易终端在打开时就有做市机器人在报双边价格。

## 账号

密码和一次性密码种子是沙盒公开值，生产环境不会这样发。

| 角色 | 邮箱 | 密码 | TOTP 种子 |
|---|---|---|---|
| 客户 | `client@meridexexchange.com` | `<redacted>` | `<redacted>` |
| 合规 | `compliance@meridexexchange.com` | `<redacted>` | `<redacted>` |
| 地址池所有者 | `founder@meridexexchange.com` | `<redacted>` | `<redacted>` |
| 客服 | `support@meridexexchange.com` | `<redacted>` | `<redacted>` |

登录页不预填账号。验证码用种子在验证器里生成。

其他预置客户（密码都是 `<redacted>`）：`mei.tan@meridexexchange.com`、`harris.ong@meridexexchange.com` 新加坡已通过；`james.walker@meridexexchange.com`、`aisha.rahman@meridexexchange.com` 美国客户已通过；`hk.chen@meridexexchange.com`（`<redacted>`）香港、`jp.sato@meridexexchange.com`（`<redacted>`）日本、`th.somchai@meridexexchange.com`（`<redacted>`）泰国、`ae.nasser@meridexexchange.com`（`<redacted>`）阿联酋已通过；`wei.lin@meridexexchange.com`（`<redacted>`）中国大陆，贵金属可交易、加密货币关闭；`farah.lim@meridexexchange.com` 马来西亚居住地但核验保持待定；`nadia.karim@meridexexchange.com` 制裁命中，拒绝。

## 给投资人看的五步

1. 打开首页。看现货说明、辖区规则，以及右侧正在跳动的 XAU/USD。
2. 登录客户账号（含 MFA），进入交易终端：订单簿、深度、成交、价格路径、下单、余额。
3. 在「资金」里做一笔模拟美元入金，或登记模拟金库入库。
4. 在「持仓」里看自己的委托和成交，可以撤未成交限价单。
5. 退出后用合规账号打开「监察」：用户与 KYC、美国客户、制裁拒绝、辖区准入（允许 / 待定 / 关闭，写入审计）、地理围栏告警、账本恒等式。需要时可以暂停和恢复市场。

## 一条命令启动

需要 Docker。

```bash
docker compose up --build
```

然后打开 <http://127.0.0.1:4317>。本机预览如果没有 Docker，按下面「不用 Docker」的方式启动。

充值地址来自创始人导入的地址池，不从扩展公钥派生。导入、修改、停用、删除和改分配只在地址后台 `http://127.0.0.1:4319`。登录仍是 `founder@`，每一次写入都要再验一次验证器上的新验证码。主后台只能查看。其他员工只能看打码后的地址。客户资金页和坐席发出的充值地址卡片都只读这张分配表，坐席不能在聊天里手打地址。客户发给坐席的消息不会被拦截；坐席只有在写出一张跟该客户无关的收款地址时才会被拦住。角色为 admin 的账号可以自己通过自己提交的运营变更，并写入审计。客户文案和费率在主后台的「文案与参数」里改，几秒内生效，不用重新构建。每个客户有一个稳定的资金账号 `MXF-` 加 8 位十六进制，写在客户钱包和入金附言上，也可在文案里改「资金账号」这几个字。主后台的入金和出金在「资金」一页：上面是待办，点一次确认并填写验证码。客户档案在「客户」。入账仍然只从主后台发生。

| 服务 | 端口 |
|---|---|
| 客户站点 | 4317 |
| 管理后台 | 4318 |
| 地址后台 | 4319 |
| 网关 | 7108 |
| 撮合引擎 | 7109 |
| Postgres | 仅容器内 5432 |

## 不用 Docker 时

```bash
cargo build --manifest-path engine/Cargo.toml
cd gateway && npm install
cd web && npm install

mkdir -p data
ENGINE_BIND=0.0.0.0:7109 ENGINE_JOURNAL=data/engine-journal.jsonl \
  ENGINE_REF_PRICE=13000 ENGINE_BAND_BPS=500 ENGINE_HALT_BPS=200 ENGINE_FSYNC_EVERY=25 \
  ./engine/target/debug/meridex-engine serve

cd gateway
DATABASE_URL=postgres://meridex:<redacted>@127.0.0.1:5432/meridex \
ENGINE_URL=http://127.0.0.1:7109 GATEWAY_PORT=7108 \
JWT_SECRET=<redacted> \
SEED_DEMO=1 BOTS=1 SANDBOX_MOCK_GEO=1 \
npx tsx src/index.ts

cd web
API_INTERNAL_URL=http://127.0.0.1:7108 PORT=4317 node server.mjs

cd web-admin
API_INTERNAL_URL=http://127.0.0.1:7108 PORT=4318 node server.mjs

cd web-pool
API_INTERNAL_URL=http://127.0.0.1:7108 PORT=4319 node server.mjs
```

客户站点是 4317，管理后台是 4318，地址后台是 4319。员工账号在客户登录会被拒绝（`STAFF_PORTAL`），客户账号在后台登录会被拒绝（`CUSTOMER_PORTAL`）。客户站点不代理 `/api/admin`。后台只代理 `/api/admin`。地址后台只代理 `/api/pool`。会话 cookie 分别是 `meridex_customer`（Path=/）、`meridex_staff`（Path=/api/admin）和 `meridex_pool`（Path=/api/pool）。客户站点、两个后台和网关默认只监听 `127.0.0.1`。要对网卡开放时分别设 `HOST`、`ADMIN_HOST`、`POOL_HOST`、`GATEWAY_HOST`（容器里用 `0.0.0.0`）。后台还可以设 `ADMIN_IP_ALLOWLIST=127.0.0.1`。也可以用 `./start-local.sh` 拉起五个进程，用 `python3 verify-local.py` 检查分离是否还在。

数据库需要先有角色和库 `meridex` / `meridex`。第一次启动会跑 `db/migrations`，并写入预置账户和一段开盘成交。已有的旧库不要指给网关：新建 `meridex` 角色和空库，让网关重新播种。压测库是 `meridex_test`。

## 交易模式

顶栏可以在现货、闪兑、定投、杠杆、合约、跟单之间切换，并单独打开模拟交易。

| 模式 | 路径 | 真实账户 | 说明 |
|---|---|---|---|
| 现货 | `/terminal` | 可以 | 限价 / 市价，走撮合和账本 |
| 闪兑 | `/convert` | 可以 | 对 USD 的 10 秒确定报价，10 bps 手续费，可成交 IOC 或自营补足 |
| 定投 | `/recurring` | 可以 | 日 / 周 / 月定额买入，服务器调度；可以「立即执行」，并把时钟调到 60× 或 1440× |
| 模拟 | 顶栏开关 | — | 独立的虚拟 US$100,000，表 `paper_*`，可重置，不进复式账本 |
| 杠杆 | `/margin` | 默认关闭 | 打开后：全仓 / 逐仓，做多做空，加减保证金，止盈止损，利息和强平进真实账本。关闭后只能减仓。美国客户硬拒绝 |
| 永续 | `/perps` | 默认关闭 | 打开后：XAU-PERP、BTC-PERP、ETH-PERP，市价/限价，只减仓，资金费和强平进真实账本。关闭后只能减仓 |
| 跟单 | `/copy` | 默认关闭 | 打开后只跟随已报名的真实账户，不使用虚构机器人。停止跟随会平掉已复制仓位 |

合规页按地区列出全部亚洲辖区和美国，每一格是居住地、品类（贵金属、加密货币、大宗商品、外汇）和交易模式的开关。整区修改走运营的经办复核，通过后写入对应的审计表。单格修改立即生效并写审计。全面制裁辖区不可改。杠杆、永续、跟单各地默认关闭。美国杠杆和永续是硬拒绝，改成允许会返回 `US_RETAIL_BLOCK`。

## 架构

撮合是 Rust 单线程价格时间优先。每个品种一本订单簿，各自一份 JSONL 日志和重放哈希。XAU/USD 仍用毫克和美分/克；其他品种用各自的数量精度和价格精度。命令先写入该品种的日志，再改内存。重放必须得到同一状态哈希。引擎的 HTTP 一次只服务一个连接，由网关独占；重放校验走合规接口 `POST /api/admin/replay`，返回每一本的哈希。网关是 TypeScript（Fastify）：密码加 TOTP、限流、KYC 规则、按资产分户的复式账本、行情 WebSocket。品种登记在 `engine/instruments.json`，启动时写入表 `instruments`。品类开关在 `category_access`，修改写入 `category_audit`。账本放在 PostgreSQL。网页是 Next.js，由 `web/server.mjs` 把 `/api` 和 `/ws` 转到网关。

为什么网关用 TypeScript：KYC、账本和会话紧挨着 Postgres；确定性订单簿留在 Rust。

下单路径被同一把锁串行化：冻结资金、送进引擎、按成交做货银对付。限价单按限价冻结，市价单按价格带边缘保护价冻结。成交价更好时，差额退回买方可用余额。撤单释放剩余冻结。

## 计量

见 `docs/units.md`。黄金用毫克，价格用美分/克，美元用微美元。XAU/USD 成交金额 = 毫克 × 美分每克 × 10。盎司只用于显示。千克合约和盎司合约是单独的资产，不会记进毫克黄金余额。其他品种按各自的数量精度、价格精度和报价精度做整数成交额。

## 辖区与关键系统

- `docs/jurisdiction-policy-v0.md`
- `docs/critical-systems.md`（RPO / RTO 是设计目标，沙盒没有做过故障演练）

默认矩阵在 `gateway/src/coverage.ts`，`gateway/config/jurisdictions.json` 只列分组。运行中的开关在 `jurisdiction_access`、`category_access` 和 `mode_access`。马来西亚客户记在 `MY-ENTITY`，其余允许的居住地记在 `SG-OPCO`（美国客户的辖区标记仍是 US）。未列出的居住地关闭。来源国只有在被设成「关闭」时才拦截；来源国与居住地不一致则告警后放行。请求头 `X-Mock-Country` 模拟来源国。

## 巡检、运营、接口

`risk@meridexexchange.com` 看巡检台，`ops@meridexexchange.com` 和 `ops.checker@meridexexchange.com` 做经办与复核，`support@meridexexchange.com` 看坐席台。密码分别是 `<redacted>`、`<redacted>`、`<redacted>`。种子见 `web/lib/demo.ts`。`ops@meridexexchange.com` 的动态验证码种子是 16 位 `<redacted>`。奖励和佣金不进复式账本。开放接口文档在 `/developers`。

## 测试

```bash
make engine-test      # 撮合、重放、10 万笔随机订单
make gateway-test     # RFC 6238 TOTP 向量
make acceptance       # 对着已启动的网关：MFA、美国客户可交易、亚洲辖区、中国大陆加密货币关闭、制裁与地理围栏、账本恒等式、日志重放
make ledger-stress    # 独立库 meridex_test + 端口 7119，默认 10 万笔后检查账本为零差异
make test             # engine-test + gateway-test + acceptance
```

`ORDERS=2000 make ledger-stress` 可以缩短账本抽样。CI（`.github/workflows/m1.yml`）跑引擎测试、TOTP、HTTP 验收，以及 2,000 笔账本抽样。10 万笔账本数字以本地 `make ledger-stress` 为准。

## 沙盒边界

没有真实入金渠道、金库、制裁名单供应商或生产 GeoIP。日志刷盘频率由 `ENGINE_FSYNC_EVERY` 控制，默认不是每条都 fsync。跨实体货银对付已在账本实现，产品规则仍禁止马来西亚客户从接口下单。
