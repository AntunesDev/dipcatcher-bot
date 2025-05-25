require('dotenv').config();
const Binance = require('binance-api-node').default;
const TelegramBot = require('node-telegram-bot-api');
const { RSI } = require('technicalindicators');

const {
    BINANCE_API_KEY,
    BINANCE_API_SECRET,
    USE_TESTNET,
    ENABLE_TELEGRAM,
    TELEGRAM_TOKEN,
    TELEGRAM_CHAT_ID,
} = process.env;

const client = Binance({
    apiKey: BINANCE_API_KEY,
    apiSecret: BINANCE_API_SECRET,
    testnet: USE_TESTNET === 'true',
});

const bot = ENABLE_TELEGRAM === 'true' ? new TelegramBot(TELEGRAM_TOKEN, { polling: false }) : null;

const notify = (msg) => {
    console.log(msg);
    if (bot) bot.sendMessage(TELEGRAM_CHAT_ID, msg).catch(console.error);
};

const USDT_PAIRS = [];
const MIN_DROP_PERCENT = 10;
const TARGET_PROFIT_PERCENT = 1.5;
const STOP_LOSS_PERCENT = TARGET_PROFIT_PERCENT / 2;
const CHECK_INTERVAL = 5 * 60 * 1000; // 5 minutos
const MAX_CONCURRENT_TRADES = 5;
const TRADE_AMOUNT_USDT = 12;
const PAIRS_PER_CYCLE = 10;
const INTERVALS = ['15m', '30m'];
let activeTrades = {};
let wsPriceWatchers = {};

let lastHeartbeat = 0;
const HEARTBEAT_INTERVAL = 10 * 60 * 1000;

function getRandomPairs(pairs, n) {
    const shuffled = pairs.slice().sort(() => 0.5 - Math.random());
    return shuffled.slice(0, n);
}

async function loadPairs() {
    const exchangeInfo = await client.exchangeInfo();
    exchangeInfo.symbols.forEach((symbol) => {
        if (symbol.quoteAsset === 'USDT' && symbol.status === 'TRADING') {
            USDT_PAIRS.push(symbol.symbol);
        }
    });
    notify(`Loaded ${USDT_PAIRS.length} USDT pairs.`);
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
    const prices = await client.prices();
    const price = parseFloat(prices[pair]);
    const qty = (amountUSDT / price).toFixed(8);
    await client.order({ symbol: pair, side: 'BUY', type: 'MARKET', quantity: qty });
    notify(`🟢 Compra executada: ${pair}\nQuantidade: ${qty}\nPreço: ${price}`);
    return { price, qty };
}

async function executeSell(pair, qty, reason, buyPrice) {
    const prices = await client.prices();
    const sellPrice = parseFloat(prices[pair]);
    await client.order({ symbol: pair, side: 'SELL', type: 'MARKET', quantity: qty });
    const profit = ((sellPrice - buyPrice) / buyPrice * 100).toFixed(2);
    const result = profit >= 0 ? 'Lucro ✅' : 'Prejuízo ❌';
    notify(`🔴 Venda executada (${reason}): ${pair}\nQuantidade: ${qty}\nPreço Venda: ${sellPrice}\nResultado: ${result} (${profit}%)`);
}

async function checkBalance(amount) {
    const account = await client.accountInfo();
    const usdt = parseFloat(account.balances.find(b => b.asset === 'USDT').free);
    if (usdt < amount) notify(`⚠️ Saldo insuficiente (USDT: ${usdt.toFixed(2)}).`);
    return usdt >= amount;
}

async function stillHolding(pair, qty) {
    const account = await client.accountInfo();
    const asset = pair.replace('USDT', '');
    const assetBalance = account.balances.find(b => b.asset === asset);
    return assetBalance && parseFloat(assetBalance.free) >= qty * 0.95;
}

function monitorTradeWebSocket(pair, buyPrice, qty) {
    const tpPrice = buyPrice * (1 + TARGET_PROFIT_PERCENT / 100);
    const slPrice = buyPrice * (1 - STOP_LOSS_PERCENT / 100);
    notify(`${pair} ➡️ TP: ${tpPrice.toFixed(6)}, SL: ${slPrice.toFixed(6)}`);

    if (wsPriceWatchers[pair]) wsPriceWatchers[pair]();

    wsPriceWatchers[pair] = client.ws.ticker(pair, async (ticker) => {
        try {
            const currentPrice = parseFloat(ticker.close);

            const has = await stillHolding(pair, qty);
            if (!has) {
                notify(`⚠️ Detecção de venda manual ou saldo insuficiente: ${pair}. Trade encerrado.`);
                wsPriceWatchers[pair] && wsPriceWatchers[pair]();
                delete wsPriceWatchers[pair];
                delete activeTrades[pair];
                return;
            }

            if (currentPrice >= tpPrice) {
                await executeSell(pair, qty, 'Take Profit', buyPrice);
                wsPriceWatchers[pair] && wsPriceWatchers[pair]();
                delete wsPriceWatchers[pair];
                delete activeTrades[pair];
            } else if (currentPrice <= slPrice) {
                await executeSell(pair, qty, 'Stop Loss', buyPrice);
                wsPriceWatchers[pair] && wsPriceWatchers[pair]();
                delete wsPriceWatchers[pair];
                delete activeTrades[pair];
            }
        } catch (err) {
            notify(`🚨 Erro monitorando preço de ${pair}: ${err.message}`);
        }
    });
}

async function main() {
    await loadPairs();
    notify(`🚀 dipcatcher-bot iniciado! Pronto para operar.\nPermitindo até ${MAX_CONCURRENT_TRADES} trades simultâneos.`);

    setInterval(async () => {
        const now = Date.now();
        if (now - lastHeartbeat > HEARTBEAT_INTERVAL) {
            lastHeartbeat = now;
            notify(`🤖 dipcatcher-bot rodando...\nTrades ativos: ${Object.keys(activeTrades).length}/${MAX_CONCURRENT_TRADES}\nAguardando oportunidades...`);
        }

        if (Object.keys(activeTrades).length >= MAX_CONCURRENT_TRADES) return;

        const pairsToCheck = getRandomPairs(USDT_PAIRS, PAIRS_PER_CYCLE);

        for (let pair of pairsToCheck) {
            if (activeTrades[pair]) continue;
            for (let interval of INTERVALS) {
                const [dipped, highVolume, oversoldRSI] = await Promise.all([
                    checkDip(pair, interval),
                    checkVolume(pair, interval),
                    checkRSI(pair, interval),
                ]);

                if (dipped && highVolume && oversoldRSI) {
                    if (!(await checkBalance(TRADE_AMOUNT_USDT))) return;

                    const { price, qty } = await executeBuy(pair, TRADE_AMOUNT_USDT);
                    activeTrades[pair] = { price, qty };
                    monitorTradeWebSocket(pair, price, qty);
                    break;
                }
            }
            if (Object.keys(activeTrades).length >= MAX_CONCURRENT_TRADES) break;
        }
    }, CHECK_INTERVAL);
}

main().catch((err) => {
    const msg = `🚨 Exceção não capturada em main():\n${err.message}\n${err.stack}`;
    console.error(msg);
    if (bot) bot.sendMessage(TELEGRAM_CHAT_ID, msg).catch(console.error);
});

process.on('uncaughtException', async (err) => {
    const msg = `🚨 Exceção não capturada:\n${err.message}\n${err.stack}`;
    console.error(msg);
    if (bot && TELEGRAM_CHAT_ID) {
        try {
            await bot.sendMessage(TELEGRAM_CHAT_ID, msg);
        } catch (e) {
            console.error('Falha ao enviar exceção ao Telegram:', e.message);
        }
    }
    process.exit(1);
});

process.on('unhandledRejection', async (reason) => {
    const msg = `🚨 Rejeição não tratada:\n${reason}`;
    console.error(msg);
    if (bot && TELEGRAM_CHAT_ID) {
        try {
            await bot.sendMessage(TELEGRAM_CHAT_ID, msg);
        } catch (e) {
            console.error('Falha ao enviar rejeição ao Telegram:', e.message);
        }
    }
    process.exit(1);
});