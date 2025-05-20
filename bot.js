import axios from 'axios';
import crypto from 'crypto';
import dotenv from 'dotenv';
import fs from 'fs';
import readline from 'readline';
dotenv.config();

const API_KEY = process.env.BINANCE_API_KEY;
const API_SECRET = process.env.BINANCE_API_SECRET;
const BASE_URL = 'https://api.binance.com';
const MIN_USDT = 11;
const MONITORED_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];

let LUCRO_ESPERADO = 0.025;
let PROFIT_TARGET = 1 + LUCRO_ESPERADO;
let STOP_LOSS = 1 - (LUCRO_ESPERADO / 2);
const TRADE_HISTORY_FILE = 'tradeHistory.json';

let tradeHistory = {};
if (fs.existsSync(TRADE_HISTORY_FILE)) {
    tradeHistory = JSON.parse(fs.readFileSync(TRADE_HISTORY_FILE));
}

const saveHistory = () => {
    fs.writeFileSync(TRADE_HISTORY_FILE, JSON.stringify(tradeHistory, null, 2));
};

const fetchHistoricalKlines = async (symbol, interval = '1h', limit = 1000) => {
    const { data } = await axios.get(`${BASE_URL}/api/v3/klines`, {
        params: {
            symbol,
            interval,
            limit
        }
    });
    return data.map(([time, open, high, low, close]) => ({
        time,
        open: +open,
        high: +high,
        low: +low,
        close: +close
    }));
};

const getPriceDrop = (klines) => {
    const maxClose = Math.max(...klines.map(k => k.close));
    const latest = klines[klines.length - 1].close;
    const dropPercent = ((maxClose - latest) / maxClose) * 100;
    return { dropPercent, latest };
};

const hasRecoveredBefore = (klines) => {
    let count = 0;
    for (let i = 0; i < klines.length - 6; i++) {
        const drop = klines[i].close * (1 - LUCRO_ESPERADO);
        const recovery = klines.slice(i + 1, i + 6).some(k => k.close >= klines[i].close);
        if (klines[i + 1].close <= drop && recovery) count++;
    }
    return count >= 2;
};

const calculateMetrics = (trades) => {
    const total = trades.length;
    const profits = trades.filter(t => t.result === 'profit').length;
    const losses = trades.filter(t => t.result === 'loss').length;
    const avgReturn = trades.reduce((acc, t) => acc + (t.exit / t.entry - 1), 0) / total;

    let peak = 0, drawdown = 0, balance = 1;
    for (const t of trades) {
        balance *= t.exit / t.entry;
        if (balance > peak) peak = balance;
        const dd = (peak - balance) / peak;
        if (dd > drawdown) drawdown = dd;
    }

    return {
        total,
        profits,
        losses,
        winRate: (profits / total) * 100,
        avgReturn: avgReturn * 100,
        finalBalance: balance,
        maxDrawdown: drawdown * 100
    };
};

const exportBacktest = (results, trades, symbol) => {
    const dir = `backtest_results/${symbol}`;
    if (!fs.existsSync('backtest_results')) fs.mkdirSync('backtest_results');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
    fs.writeFileSync(`${dir}/results.json`, JSON.stringify({ results, trades }, null, 2));
    const csv = trades.map(t => `${t.entry},${t.exit},${t.result}`).join('\n');
    fs.writeFileSync(`${dir}/trades.csv`, 'entry,exit,result\n' + csv);
};

const runBacktestFromAPI = async (symbol) => {
    const klines = await fetchHistoricalKlines(symbol, '1h', 1000);
    let position = null;
    let trades = [];

    for (let i = 48; i < klines.length; i++) {
        const window = klines.slice(i - 48, i);
        const candle = klines[i];

        if (!position) {
            const { dropPercent } = getPriceDrop(window);
            if (dropPercent >= LUCRO_ESPERADO * 100 && hasRecoveredBefore(window)) {
                position = {
                    entryPrice: candle.close,
                    entryTime: candle.time
                };
            }
        } else {
            const gain = candle.close / position.entryPrice;
            if (gain >= PROFIT_TARGET || gain <= STOP_LOSS) {
                trades.push({
                    entry: position.entryPrice,
                    exit: candle.close,
                    result: gain >= PROFIT_TARGET ? 'profit' : 'loss'
                });
                position = null;
            }
        }
    }

    const results = calculateMetrics(trades);
    console.log(`📊 Backtest de ${symbol}:`, results);
    exportBacktest(results, trades, symbol);
};

const getKlines = async (symbol, interval = '1h', limit = 48) => {
    const { data } = await axios.get(`${BASE_URL}/api/v3/klines`, {
        params: { symbol, interval, limit }
    });
    return data.map(([time, open, high, low, close]) => ({
        time, open: +open, high: +high, low: +low, close: +close
    }));
};

const getPrice = async (symbol) => {
    const { data } = await axios.get(`${BASE_URL}/api/v3/ticker/price`, {
        params: { symbol }
    });
    return parseFloat(data.price);
};

const getSignature = (query) => {
    return crypto.createHmac('sha256', API_SECRET).update(query).digest('hex');
};

const placeOrder = async (symbol, quantity) => {
    const timestamp = Date.now();
    const query = `symbol=${symbol}&side=BUY&type=MARKET&quantity=${quantity}&timestamp=${timestamp}`;
    const signature = getSignature(query);
    const finalQuery = `${query}&signature=${signature}`;

    try {
        const { data } = await axios.post(`${BASE_URL}/api/v3/order?${finalQuery}`, null, {
            headers: { 'X-MBX-APIKEY': API_KEY }
        });
        const price = parseFloat(data.fills[0].price);
        tradeHistory[symbol] = {
            buyPrice: price,
            quantity: parseFloat(quantity),
            timestamp,
            status: 'bought'
        };
        saveHistory();
        console.log(`[${symbol}] Compra realizada a $${price}`);
    } catch (err) {
        console.error(`[${symbol}] Falha ao comprar:`, err.response?.data);
    }
};

const checkSellConditions = async () => {
    for (const symbol in tradeHistory) {
        const trade = tradeHistory[symbol];
        if (trade.status !== 'bought') continue;

        const currentPrice = await getPrice(symbol);
        const gain = currentPrice / trade.buyPrice;

        if (gain >= PROFIT_TARGET || gain <= STOP_LOSS) {
            const timestamp = Date.now();
            const query = `symbol=${symbol}&side=SELL&type=MARKET&quantity=${trade.quantity}&timestamp=${timestamp}`;
            const signature = getSignature(query);
            const finalQuery = `${query}&signature=${signature}`;

            try {
                const { data } = await axios.post(`${BASE_URL}/api/v3/order?${finalQuery}`, null, {
                    headers: { 'X-MBX-APIKEY': API_KEY }
                });
                trade.status = gain >= PROFIT_TARGET ? 'sold_profit' : 'sold_loss';
                trade.sellPrice = parseFloat(data.fills[0].price);
                trade.sellTime = timestamp;
                saveHistory();
                console.log(`[${symbol}] Venda realizada a $${trade.sellPrice} (${trade.status})`);
            } catch (err) {
                console.error(`[${symbol}] Erro na venda:`, err.response?.data);
            }
        } else {
            console.log(`[${symbol}] Mantendo posição. Preço atual: $${currentPrice.toFixed(2)}`);
        }
    }
};

const checkAndTrade = async () => {
    for (const symbol of MONITORED_SYMBOLS) {
        if (tradeHistory[symbol]?.status === 'bought') continue;

        try {
            const klines = await getKlines(symbol);
            const { dropPercent, latest } = getPriceDrop(klines);

            if (dropPercent >= 10 && hasRecoveredBefore(klines)) {
                const quantity = (MIN_USDT / latest).toFixed(6);
                await placeOrder(symbol, quantity);
            } else {
                console.log(`[${symbol}] Nenhum sinal válido: queda ${dropPercent.toFixed(2)}%`);
            }
        } catch (err) {
            console.error(`[${symbol}] Erro ao analisar:`, err.message);
        }
    }
};

const runRealtimeBot = async (symbol) => {
    console.log(`🤖 Rodando bot em tempo real para ${symbol}...`);

    let position = null;
    const check = async () => {
        try {
            const klines = await fetchHistoricalKlines(symbol, '1h', 50);
            const window = klines.slice(0, 48);
            const candle = klines[klines.length - 1];

            if (!position) {
                const { dropPercent } = getPriceDrop(window);
                if (dropPercent >= LUCRO_ESPERADO * 100 && hasRecoveredBefore(window)) {
                    position = { entryPrice: candle.close };
                    console.log(`[${symbol}] COMPRA em $${candle.close}`);
                }
            } else {
                const gain = candle.close / position.entryPrice;
                if (gain >= PROFIT_TARGET || gain <= STOP_LOSS) {
                    console.log(`[${symbol}] ${gain >= PROFIT_TARGET ? 'LUCRO' : 'STOP'} em $${candle.close}`);
                    position = null;
                }
            }
        } catch (e) {
            console.error('Erro no bot realtime:', e.message);
        }
    };

    setInterval(check, 60 * 60 * 1000);
};

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
console.log('📈 Modo Interativo Iniciado');
rl.question('Digite o modo desejado (backtest | realtime): ', (modo) => {
    if (modo === 'backtest') {
        rl.question('Símbolo da moeda (ex: BTCUSDT): ', (symbol) => {
            rl.question('Lucro desejado em % (ex: 2.5): ', (lucro) => {
                const parsedLucro = parseFloat(lucro);
                if (!isNaN(parsedLucro)) {
                    LUCRO_ESPERADO = parsedLucro / 100;
                    PROFIT_TARGET = 1 + LUCRO_ESPERADO;
                    STOP_LOSS = 1 - (LUCRO_ESPERADO / 2);
                    runBacktestFromAPI(symbol.toUpperCase());
                } else {
                    console.log('❌ Lucro inválido. Encerrando.');
                }
                rl.close();
            });
        });
    } else if (modo === 'realtime') {
        rl.question('Símbolo da moeda (ex: BTCUSDT): ', (symbol) => {
            rl.question('Lucro desejado em % (ex: 2.5): ', (lucro) => {
                const parsedLucro = parseFloat(lucro);
                if (!isNaN(parsedLucro)) {
                    LUCRO_ESPERADO = parsedLucro / 100;
                    PROFIT_TARGET = 1 + LUCRO_ESPERADO;
                    STOP_LOSS = 1 - (LUCRO_ESPERADO / 2);
                    runRealtimeBot(symbol.toUpperCase());
                } else {
                    console.log('❌ Lucro inválido. Encerrando.');
                }
                rl.close();
            });
        });
    } else {
        console.log('❌ Modo inválido. Use "backtest" ou "realtime".');
        rl.close();
    }
});