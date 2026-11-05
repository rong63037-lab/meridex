# 测试环境密钥

Binance 演示和 Saxo 模拟的密钥只放在本机家目录，不进仓库，不进数据库，不进聊天。后台只显示「已配置」或「未配置」。

默认三个来源都是关闭。影子模式只记录打算走的路由，不发送。拨到「测试环境」才会把订单发到演示或模拟主机，而且要所有者验证器。生产地址会被拒绝。

Coinbase Exchange 沙盒还没有密钥，适配器是空的，不会发起连接。

## 放密钥

```bash
mkdir -p ~/.meridex-secrets
chmod 700 ~/.meridex-secrets

cat > ~/.meridex-secrets/binance-demo.env <<'EOF'
BINANCE_DEMO_API_KEY=粘贴 demo.binance.com 的 API Key
BINANCE_DEMO_API_SECRET=粘贴对应的 Secret
EOF

cat > ~/.meridex-secrets/saxo-sim.env <<'EOF'
SAXO_SIM_TOKEN=粘贴 24 小时 SIM 令牌
SAXO_SIM_ACCOUNT_KEY=粘贴模拟账户的 AccountKey
EOF

chmod 600 ~/.meridex-secrets/binance-demo.env ~/.meridex-secrets/saxo-sim.env
```

改完文件后重启网关，让进程重新读文件。然后在主后台「流动性」点「测试连接」。这一步只读余额和报价，不需要验证器，也不发订单。

Saxo 令牌大约 24 小时失效。没有自动刷新。过期后后台连接状态写成「令牌已过期」。换掉 `SAXO_SIM_TOKEN` 那一行，再重启，再点测试连接。

Binance 演示的 USDS-M 合约默认地址是 `https://demo-fapi.binance.com`（demo.binance.com 的演示交易，不是已经停用的 `testnet.binancefuture.com`，也不是生产 `https://fapi.binance.com`）。所有者可以在弹窗里改测试地址。只接受 `demo-fapi.binance.com`、`demo-*.binance.com`，或本机测试端口。生产主机和旧测试网会被拒绝。

Saxo 默认 `https://gateway.saxobank.com/sim/openapi`。不带 `/sim` 的实盘网关会被拒绝。

品种映射里的 `EUR/USD` → `FxSpot:21` 是常见样例，所有者应在 Saxo 模拟里核对 UIC，再在后台改映射。不要把生产密钥写进这两个文件。

`MERIDEX_SECRETS_DIR` 只给自动化测试改目录。不要用它把密钥放进仓库。

## Keys

Keys for Binance demo trading and the Saxo simulator live only under the home directory. They are not committed, not stored in the database, and not shown in the admin. The Liquidity page shows Present or Missing.

All three providers stay off. Shadow logs the route it would send and sends nothing. Test venue sends an order only to the demo or simulator host, and only after the owner's authenticator. Production hosts are refused.

The Coinbase Exchange sandbox adapter is a stub. It does not open a connection.

```bash
mkdir -p ~/.meridex-secrets
chmod 700 ~/.meridex-secrets
# binance-demo.env: BINANCE_DEMO_API_KEY and BINANCE_DEMO_API_SECRET
# saxo-sim.env: SAXO_SIM_TOKEN and SAXO_SIM_ACCOUNT_KEY
chmod 600 ~/.meridex-secrets/binance-demo.env ~/.meridex-secrets/saxo-sim.env
```

Restart the gateway after editing a file. Test connection on the Liquidity page is a read-only balance and price call. It does not need an authenticator and it does not send an order.

The Saxo token lasts about 24 hours. There is no refresh. When it lapses, the page says Token expired. Replace `SAXO_SIM_TOKEN`, restart, and test again.

Binance USDS-M demo REST defaults to `https://demo-fapi.binance.com`. The retired `testnet.binancefuture.com` host and production `https://fapi.binance.com` are refused. Allowed hosts are `demo-fapi.binance.com`, `demo-*.binance.com`, and a local test port.

Saxo defaults to `https://gateway.saxobank.com/sim/openapi`. The live gateway without `/sim` is refused.

`EUR/USD` → `FxSpot:21` is a sample map. Confirm the UIC in the Saxo simulator before relying on it. `MERIDEX_SECRETS_DIR` is a test hook only.
