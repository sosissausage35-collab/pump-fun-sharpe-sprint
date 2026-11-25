// pump-fun-sharpe-sprint: a paper-trading bot for the make.fun
// "Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins" competition.
//
// Strategy (designed for hourly Sharpe ratio, not max PnL):
//   * Quick momentum scalps on new pump.fun curves. A coin is entered
//     once, early, and only while it is still drawing real buy flow:
//     real SOL reserves >= 1 SOL, price still within +10% of its creation
//     price, and >= 3 SOL of buys in the last ~60 s. The bonding curve
//     price is a deterministic function of real reserves, so a low entry
//     price and a usable size (1% of real reserves per order) only meet
//     in this narrow early window; chasing higher costs the trade.
//   * Take profit at +12% over the entry fill, and never hold longer than
//     ~40 s (100 slots). Backtests on the dev window show the burst that
//     triggers entry is usually over within seconds and the price then
//     mean-reverts to its creation floor, so a short hold cuts the bleed
//     while the take-profit still catches the follow-through. No tight
//     stop-loss: the tape whipsaws +-15% in seconds and a small stop just
//     locks in noise; the curve cannot print below its creation price,
//     which bounds the downside.
//   * Small, diversified, one entry per mint; at most 5 open positions
//     (the harness cap); a drawdown brake stops new entries while equity
//     is >8% below its peak.
//
// Protocol: agent-fun/replay/v2, newline-delimited JSON on stdin/stdout.
// The harness sends `hello`, then `batch` messages (each with a `seq` and
// a `slot`), then `done`. This bot answers every `batch` with one `reply`
// carrying its `orders` for that `slot`. Fully deterministic: no clock,
// no randomness, no network, no environment reads; every decision is a
// pure function of the messages received so far.

type U64 = string;

interface HelloMsg {
  type: "hello";
  protocol: string;
  seed: string;
  capital: { lamports: U64 };
  caps: {
    max_open_positions: number;
    max_order_bps_of_real_reserve: number;
    max_orders_per_batch: number;
    shorts: boolean;
    leverage: boolean;
  };
  latency_slots: number;
  fees: {
    protocol_bps_fallback: number;
    creator_bps_fallback: number;
    base_fee_lamports: U64;
    priority_fee_lamports: U64;
    failed_tx_bps: number;
  };
}

interface TradeEvent {
  event: "TradeEvent";
  mint: string;
  sol_amount: U64;
  token_amount: U64;
  is_buy: boolean;
  virtual_sol_reserves: U64;
  virtual_token_reserves: U64;
  real_sol_reserves: U64;
  real_token_reserves: U64;
  slot: number;
}

interface CreateEvent {
  event: "CreateEvent";
  mint: string;
  virtual_sol_reserves: U64;
  virtual_token_reserves: U64;
  real_token_reserves: U64;
  slot: number;
}

interface CompleteEvent {
  event: "CompleteEvent";
  mint: string;
  slot: number;
}

type ChainEvent = TradeEvent | CreateEvent | CompleteEvent;

interface Mark {
  mint: string;
  slot: number;
  virtual_token_reserves: U64;
  virtual_quote_reserves: U64;
  real_token_reserves: U64;
  real_quote_reserves: U64;
}

interface Fill {
  client_id: string;
  mint: string;
  side: "buy" | "sell";
  status: "filled" | "rejected" | "failed";
  reason: string | null;
  decided_slot: number;
  slot: number;
  quote_lamports: U64;
  token_amount: U64;
  fee_lamports: U64;
  tx_fee_lamports: U64;
}

interface Position {
  mint: string;
  token_amount: U64;
  cost_lamports: U64;
}

interface BatchMsg {
  type: "batch";
  seq: number;
  slot: number;
  events: ChainEvent[];
  marks: Mark[];
  fills: Fill[];
  account: { cash_lamports: U64; positions: Position[] };
}

interface DoneMsg {
  type: "done";
  seq: number;
  reason: string;
  account: { cash_lamports: U64; positions: Position[] };
}

interface BuyOrder {
  side: "buy";
  client_id: string;
  mint: string;
  quote_lamports: U64;
  max_slippage_bps: number;
}

interface SellOrder {
  side: "sell";
  client_id: string;
  mint: string;
  token_amount: U64;
  max_slippage_bps: number;
}

type Order = BuyOrder | SellOrder;

// ---------------------------------------------------------------------------
// Strategy parameters (all in lamports / slots; 1 slot ~= 0.4 s).
// ---------------------------------------------------------------------------
const LAMPORTS_PER_SOL = 1_000_000_000n;
const MIN_REAL_SOL_LAMPORTS = 1_000_000_000n; // entry needs >= 1 SOL real reserves
const MAX_BUY_LAMPORTS = 50_000_000n; // 0.05 SOL ceiling per entry
const MIN_BUY_LAMPORTS = 10_000_000n; // 0.01 SOL floor per entry
const MAX_PRICE_VS_CREATE = 1.1; // never chase a coin already +10% over creation
const TAKE_PROFIT = 0.12; // sell at +12% over our entry price
// No tight stop-loss: the tape whipsaws +-15% in seconds, so a small stop
// just locks in noise. The bonding curve cannot print below its creation
// price, which bounds the downside; this 25% guard only fires on a
// genuine collapse far past the floor.
const STOP_LOSS = 0.25;
const MAX_HOLD_SLOTS = 100; // ~40 s, then exit at market
const MAX_SLIPPAGE_BPS = 500;
const SELL_SLIPPAGE_BPS = 2000; // sells tolerate a bigger drop vs decision time:
// the tape falls fast, so a fill a few percent below the decision mark
// still beats holding into the time exit.
const DRAWDOWN_BRAKE = 0.08; // stop new entries while equity is >8% off its peak
const MIN_TRADES_BEFORE_ENTRY = 3; // need a little tape before trusting a curve
const ENTRY_FRESH_SLOTS = 900; // enter only within ~6 min of the demand wave starting
const MAX_COIN_AGE_SLOTS = 14400; // never enter a curve older than ~96 min
// Volume filter: only enter a burst that is still drawing real buy flow.
const VOLUME_WINDOW_SLOTS = 150; // ~60 s of tape for the volume filter
const MIN_BUY_VOLUME_LAMPORTS = 3_000_000_000n; // >= 3 SOL of buys in the window

interface Curve {
  mint: string;
  createdSlot: number;
  createPrice: number; // lamports of SOL per token unit at creation
  price: number; // latest known price (virtual SOL / virtual token)
  realSol: bigint; // latest real SOL reserves
  trades: number;
  complete: boolean;
  /** First slot the curve showed proven demand (real SOL >= entry bar). */
  eligibleSlot: number | null;
  /** Recent buy trades: [slot, sol_amount_lamports], for the volume filter. */
  recentBuys: Array<[number, bigint]>;
  /** Insertion order, for deterministic tie-breaking. */
  index: number;
}

let curveCounter = 0;

/** Mark a curve eligible the first time it clears the demand bar. */
function refreshEligibility(c: Curve, slot: number): void {
  if (c.eligibleSlot === null && c.realSol >= MIN_REAL_SOL_LAMPORTS && c.trades >= MIN_TRADES_BEFORE_ENTRY) {
    c.eligibleSlot = slot;
  }
}

interface OpenTrade {
  entryPrice: number; // lamports of SOL per token unit actually paid (fill)
  entrySlot: number; // slot the buy was decided on
  tokens: bigint;
}

const curves = new Map<string, Curve>();
const openTrades = new Map<string, OpenTrade>(); // by mint, for positions we hold
const pendingBuys = new Map<string, { clientId: string; slot: number; mint: string }>();
const pendingSells = new Map<string, number>(); // mint -> slot the sell was decided on
const tradedMints = new Set<string>(); // mints we already entered once
let hello: HelloMsg | null = null;
let cash = 0n;
let orderCounter = 0;
let peakEquity = 0n; // lamports, marked

function nextClientId(prefix: string): string {
  orderCounter += 1;
  return `${prefix}${orderCounter}`;
}

function priceOf(vsol: bigint, vtok: bigint): number {
  if (vtok === 0n) return 0;
  return Number(vsol) / Number(vtok);
}

function txFeeLamports(): bigint {
  if (hello === null) return 0n;
  return BigInt(hello.fees.base_fee_lamports) + BigInt(hello.fees.priority_fee_lamports);
}

function curveFeeBps(): number {
  if (hello === null) return 125;
  return hello.fees.protocol_bps_fallback + hello.fees.creator_bps_fallback;
}

/** Current mark price for a mint: prefer the batch's marks, else the curve tape. */
function currentPrice(mint: string, marksByMint: Map<string, Mark>): number {
  const m = marksByMint.get(mint);
  if (m !== undefined) {
    return priceOf(BigInt(m.virtual_quote_reserves), BigInt(m.virtual_token_reserves));
  }
  const c = curves.get(mint);
  return c !== undefined ? c.price : 0;
}

/** Marked equity: cash + positions valued at current prices, net of sell fees. */
function markedEquity(marksByMint: Map<string, Mark>, positions: Position[]): bigint {
  let equity = cash;
  const feeBps = BigInt(curveFeeBps());
  for (const p of positions) {
    const price = currentPrice(p.mint, marksByMint);
    if (price <= 0) continue;
    const tokens = BigInt(p.token_amount);
    // gross SOL value of the tokens at the mark price, minus curve fees and one tx fee
    const gross = BigInt(Math.floor(Number(tokens) * price));
    const net = (gross * (10000n - feeBps)) / 10000n - txFeeLamports();
    if (net > 0n) equity += net;
  }
  return equity;
}

function applyBatch(batch: BatchMsg): void {
  // 1. Resolve pending buys from fills: record the actual entry price paid.
  for (const f of batch.fills) {
    if (f.side === "buy" && f.status === "filled") {
      const pending = pendingBuys.get(f.client_id);
      const tokens = BigInt(f.token_amount);
      const quote = BigInt(f.quote_lamports);
      if (tokens > 0n && quote > 0n) {
        openTrades.set(f.mint, {
          entryPrice: Number(quote) / Number(tokens),
          entrySlot: pending !== undefined ? pending.slot : batch.slot,
          tokens,
        });
        tradedMints.add(f.mint);
      }
      pendingBuys.delete(f.client_id);
    } else if (f.side === "buy") {
      pendingBuys.delete(f.client_id);
    } else if (f.side === "sell") {
      // Any resolution of a sell (filled, rejected or failed) clears the
      // in-flight flag: a rejected sell may be sent again next batch.
      pendingSells.delete(f.mint);
      if (f.status === "filled") openTrades.delete(f.mint);
    }
  }
  // Prune stale pending buys: a buy decided more than 20 slots ago whose
  // fill never arrived is not coming (rejected/failed fills are reported,
  // so this only covers a fill that will never be delivered). Never wipe
  // the whole map: orders fill latency_slots after decision, so a buy sent
  // on the previous batch is still legitimately in flight.
  for (const [id, pb] of pendingBuys) {
    if (batch.slot - pb.slot > 20) pendingBuys.delete(id);
  }
  // Same for sells: a sell unreported after 20 slots is stale.
  for (const [mint, slot] of pendingSells) {
    if (batch.slot - slot > 20) pendingSells.delete(mint);
  }

  // 2. Account snapshot.
  cash = BigInt(batch.account.cash_lamports);

  // 3. Marks refresh curve prices.
  for (const m of batch.marks) {
    const c = curves.get(m.mint);
    if (c === undefined) continue;
    if (m.slot < c.createdSlot) continue;
    c.price = priceOf(BigInt(m.virtual_quote_reserves), BigInt(m.virtual_token_reserves));
    c.realSol = BigInt(m.real_quote_reserves);
    refreshEligibility(c, m.slot);
  }

  // 4. Events: new curves, trades, completions.
  for (const e of batch.events) {
    if (e.event === "CreateEvent") {
      const price = priceOf(BigInt(e.virtual_sol_reserves), BigInt(e.virtual_token_reserves));
      curves.set(e.mint, {
        mint: e.mint,
        createdSlot: e.slot,
        createPrice: price,
        price,
        realSol: 0n,
        trades: 0,
        complete: false,
        eligibleSlot: null,
        recentBuys: [],
        index: curveCounter++,
      });
    } else if (e.event === "TradeEvent") {
      let c = curves.get(e.mint);
      if (c === undefined) {
        const price = priceOf(BigInt(e.virtual_sol_reserves), BigInt(e.virtual_token_reserves));
        c = {
          mint: e.mint,
          createdSlot: e.slot,
          createPrice: price,
          price,
          realSol: BigInt(e.real_sol_reserves),
          trades: 0,
          complete: false,
          eligibleSlot: null,
          recentBuys: [],
          index: curveCounter++,
        };
        curves.set(e.mint, c);
      }
      c.price = priceOf(BigInt(e.virtual_sol_reserves), BigInt(e.virtual_token_reserves));
      c.realSol = BigInt(e.real_sol_reserves);
      c.trades += 1;
      if (e.is_buy) {
        c.recentBuys.push([e.slot, BigInt(e.sol_amount)]);
        // Drop trades older than the volume window; the list stays short.
        while (c.recentBuys.length > 0 && c.recentBuys[0][0] < e.slot - VOLUME_WINDOW_SLOTS) {
          c.recentBuys.shift();
        }
      }
      refreshEligibility(c, e.slot);
    } else {
      const c = curves.get(e.mint);
      if (c !== undefined) c.complete = true;
    }
  }
}

function decideOrders(batch: BatchMsg): Order[] {
  const orders: Order[] = [];
  if (hello === null) return orders;
  const marksByMint = new Map<string, Mark>();
  for (const m of batch.marks) marksByMint.set(m.mint, m);

  const positions = batch.account.positions;
  const heldMints = new Set<string>();
  for (const p of positions) {
    if (BigInt(p.token_amount) > 0n) heldMints.add(p.mint);
  }

  // --- Exits first: take profit, stop loss, max hold. ---
  for (const p of positions) {
    const tokens = BigInt(p.token_amount);
    if (tokens === 0n) continue;
    if (pendingSells.has(p.mint)) continue; // a sell is already in flight
    const trade = openTrades.get(p.mint);
    const price = currentPrice(p.mint, marksByMint);
    if (price <= 0) continue;
    let exit = false;
    if (trade !== undefined) {
      const ret = price / trade.entryPrice - 1;
      if (ret >= TAKE_PROFIT) exit = true; // bank the spike
      else if (ret <= -STOP_LOSS) exit = true; // cut the loser
      else if (batch.slot - trade.entrySlot >= MAX_HOLD_SLOTS) exit = true; // time exit
    } else {
      // Position without a recorded entry (e.g. its buy filled on a batch
      // whose fill we missed): exit on the account's cost basis, with the
      // same take-profit and stop-loss bands.
      const cost = BigInt(p.cost_lamports);
      if (cost > 0n) {
        const entryPrice = Number(cost) / Number(tokens);
        const ret = price / entryPrice - 1;
        if (ret >= TAKE_PROFIT || ret <= -STOP_LOSS) exit = true;
      }
    }
    if (exit) {
      orders.push({
        side: "sell",
        client_id: nextClientId("s"),
        mint: p.mint,
        token_amount: tokens.toString(),
        max_slippage_bps: SELL_SLIPPAGE_BPS,
      });
      pendingSells.set(p.mint, batch.slot);
    }
  }

  // --- Entries: only while we have room, cash and no drawdown brake. ---
  const pendingBuyMints = new Set<string>();
  for (const pb of pendingBuys.values()) pendingBuyMints.add(pb.mint);
  const committed = heldMints.size + pendingBuyMints.size;
  // Sells in this reply free a slot only after they fill, so count exits as still held.
  if (committed >= hello.caps.max_open_positions) return orders;

  const equity = markedEquity(marksByMint, positions);
  if (equity > peakEquity) peakEquity = equity;
  const drawdown = peakEquity > 0n ? Number(peakEquity - equity) / Number(peakEquity) : 0;
  if (drawdown > DRAWDOWN_BRAKE) return orders; // brake: protect the Sharpe

  const freeCash = cash - txFeeLamports() * BigInt(orders.length + 1);
  if (freeCash < MIN_BUY_LAMPORTS) return orders;

  const maxOrders = hello.caps.max_orders_per_batch;
  const bpsCap = BigInt(hello.caps.max_order_bps_of_real_reserve);
  // Candidates, most recently eligible first: enter during the demand
  // wave, never a stale curve whose spike already came and went.
  const candidates = [...curves.values()].sort((a, b) => {
    const ea = a.eligibleSlot ?? -1;
    const eb = b.eligibleSlot ?? -1;
    if (eb !== ea) return eb - ea;
    return a.index - b.index;
  });
  for (const curve of candidates) {
    if (orders.length >= maxOrders) break;
    if (committed + orders.filter((o) => o.side === "buy").length >= hello.caps.max_open_positions) break;
    if (curve.complete) continue;
    if (tradedMints.has(curve.mint)) continue; // one round trip per mint
    if (heldMints.has(curve.mint) || pendingBuyMints.has(curve.mint)) continue;
    if (curve.eligibleSlot === null) continue;
    // Freshness: the demand wave must have started recently; older
    // curves already had their move.
    if (batch.slot - curve.eligibleSlot > ENTRY_FRESH_SLOTS) continue;
    if (batch.slot - curve.createdSlot > MAX_COIN_AGE_SLOTS) continue;
    if (curve.trades < MIN_TRADES_BEFORE_ENTRY) continue;
    if (curve.realSol < MIN_REAL_SOL_LAMPORTS) continue; // needs proven demand
    // Volume filter: only enter a burst that is still drawing real buy
    // flow (weak bursts almost never reach take-profit).
    let buyVolume = 0n;
    for (const [slot, amount] of curve.recentBuys) {
      if (slot > batch.slot - VOLUME_WINDOW_SLOTS) buyVolume += amount;
    }
    if (buyVolume < MIN_BUY_VOLUME_LAMPORTS) continue;
    if (curve.createPrice <= 0) continue;
    if (curve.price / curve.createPrice > MAX_PRICE_VS_CREATE) continue; // never chase
    // Size: up to 1% of real reserves, clamped to [0.01, 0.05] SOL.
    let size = (curve.realSol * bpsCap) / 10000n;
    if (size > MAX_BUY_LAMPORTS) size = MAX_BUY_LAMPORTS;
    if (size < MIN_BUY_LAMPORTS) continue;
    if (size + txFeeLamports() > freeCash) continue;
    const clientId = nextClientId("b");
    orders.push({
      side: "buy",
      client_id: clientId,
      mint: curve.mint,
      quote_lamports: size.toString(),
      max_slippage_bps: MAX_SLIPPAGE_BPS,
    });
    pendingBuys.set(clientId, { clientId, slot: batch.slot, mint: curve.mint });
  }
  return orders;
}

async function main(): Promise<void> {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    buffer += chunk;
    let nl = buffer.indexOf("\n");
    while (nl !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.trim() !== "") {
        const msg = JSON.parse(line) as HelloMsg | BatchMsg | DoneMsg;
        if (msg.type === "hello") {
          hello = msg;
          cash = BigInt(msg.capital.lamports);
          peakEquity = cash;
        } else if (msg.type === "batch") {
          applyBatch(msg);
          const orders = decideOrders(msg);
          process.stdout.write(JSON.stringify({ type: "reply", seq: msg.seq, orders }) + "\n");
        } else if (msg.type === "done") {
          return; // final account already flattened by the harness
        }
      }
      nl = buffer.indexOf("\n");
    }
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
