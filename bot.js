require('dotenv').config();
const Binance = require('binance-api-node').default;
const { RSI } = require('technicalindicators');

const client = Binance({
    apiKey: process.env.BINANCE_API_KEY,
    apiSecret: process.env.BINANCE_API_SECRET,
});

const USDT_PAIRS = [];
const MIN_DROP_PERCENT = 10;
const TARGET_PROFIT_PERCENT = 1.5;
const STOP_LOSS_PERCENT = TARGET_PROFIT_PERCENT / 2;
const CHECK_INTERVAL = 60 * 1000;
const MAX_CONCURRENT_TRADES = 2;
const TRADE_AMOUNT_USDT = 12;

const intervals = ['5m', '15m', '30m', '1h'];
let activeTrades = {};

async function loadPairs() {
    const exchangeInfo = await client.exchangeInfo();
    exchangeInfo.symbols.forEach((symbol) => {
        if (symbol.quoteAsset === 'USDT' && symbol.status === 'TRADING') {
            USDT_PAIRS.push(symbol.symbol);
        }
    });
    console.log(`Loaded ${USDT_PAIRS.length} USDT pairs.`);
}

async function checkDip(pair, interval) {
    const candles = await client.candles({ symbol: pair, interval, limit: 2 });
    const [prev] = candles;
    const drop = ((parseFloat(prev.high) - parseFloat(prev.low)) / parseFloat(prev.high)) * 100;
    return drop >= MIN_DROP_PERCENT;
}

async function checkVolume(pair, interval) {
    const candles = await client.candles({ symbol: pair, interval, limit: 11 });
    const avgVol = candles.slice(0, 10).reduce((sum, c) => sum + parseFloat(c.volume), 0) / 10;
    return parseFloat(candles[10].volume) > avgVol;
}

async function checkRSI(pair, interval) {
    const candles = await client.candles({ symbol: pair, interval, limit: 15 });
    const closes = candles.map(c => parseFloat(c.close));
    const rsi = RSI.calculate({ values: closes, period: 14 });
    return rsi[rsi.length - 1] < 30;
}

async function executeBuy(pair, amountUSDT) {
    const price = parseFloat((await client.prices({ symbol: pair }))[pair]);
    const qty = (amountUSDT / price).toFixed(8);
    await client.order({ symbol: pair, side: 'BUY', type: 'MARKET', quantity: qty });
    console.log(`Compra ${pair}: ${qty}@${price}`);
    return { price, qty };
}

async function executeSell(pair, qty, reason) {
    await client.order({ symbol: pair, side: 'SELL', type: 'MARKET', quantity: qty });
    console.log(`Venda ${pair}: ${qty} (${reason})`);
}

async function monitorTrade(pair, buyPrice, qty) {
    const tpPrice = buyPrice * (1 + TARGET_PROFIT_PERCENT / 100);
    const slPrice = buyPrice * (1 - STOP_LOSS_PERCENT / 100);
    console.log(`${pair} TP:${tpPrice} SL:${slPrice}`);

    while (true) {
        const currentPrice = parseFloat((await client.prices({ symbol: pair }))[pair]);

        if (currentPrice >= tpPrice) {
            await executeSell(pair, qty, 'Take Profit');
            break;
        } else if (currentPrice <= slPrice) {
            await executeSell(pair, qty, 'Stop Loss');
            break;
        }
        await new Promise(resolve => setTimeout(resolve, CHECK_INTERVAL));
    }
    delete activeTrades[pair];
}

async function checkBalance(amount) {
    const account = await client.accountInfo();
    const usdt = parseFloat(account.balances.find(b => b.asset === 'USDT').free);
    return usdt >= amount;
}

async function main() {
    await loadPairs();

    setInterval(async () => {
        if (Object.keys(activeTrades).length >= MAX_CONCURRENT_TRADES) return;

        for (let pair of USDT_PAIRS) {
            if (activeTrades[pair]) continue;

            for (let interval of intervals) {
                const conditionsMet = await Promise.all([
                    checkDip(pair, interval),
                    checkVolume(pair, interval),
                    checkRSI(pair, interval)
                ]);

                if (conditionsMet.every(c => c)) {
                    const hasFunds = await checkBalance(TRADE_AMOUNT_USDT);
                    if (!hasFunds) {
                        console.log('Sem saldo suficiente.');
                        return;
                    }

                    const { price, qty } = await executeBuy(pair, TRADE_AMOUNT_USDT);
                    activeTrades[pair] = { price, qty };
                    monitorTrade(pair, price, qty);
                    break;
                }
            }

            if (Object.keys(activeTrades).length >= MAX_CONCURRENT_TRADES) break;
        }
    }, CHECK_INTERVAL);
}

main().catch(console.error);
