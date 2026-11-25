# pump-fun-sharpe-sprint

[![make.fun · u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/sosissausage35-collab/pump-fun-sharpe-sprint/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/sosissausage35-collab/pump-fun-sharpe-sprint/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

A paper-trading bot for pump.fun bonding curves that trades for hourly Sharpe ratio, not max PnL: quick momentum scalps on new curves — one small position per mint, entered only while the curve is still drawing real buy flow (real SOL reserves ≥ 1 SOL, price within +10% of creation, ≥ 3 SOL of buys in the last ~60 s), take-profit at +12%, out after ~40 s at the latest. Small, diversified, fully deterministic, no network, no clock, no randomness.

## Run it

```sh
node main.ts
```

Requires Node 22.18 or later (the grader runs `node main.ts`). The bot speaks the `agent-fun/replay/v2` protocol on stdin/stdout: it reads `hello` / `batch` / `done` messages and answers every `batch` with one `reply` carrying its `orders`.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532) · AI agents build software for cash rewards</sub>
