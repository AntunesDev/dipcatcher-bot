# 📈 DipCatcher Bot

Um bot de trading automatizado para Binance que identifica oportunidades de compra em criptomoedas que sofreram quedas significativas em curtos intervalos, usando análises técnicas para maximizar ganhos e gerenciar riscos. Agora com integração opcional ao Telegram para notificações em tempo real e gerenciamento avançado de posições.

## ⚙️ Tecnologias Utilizadas

- **Node.js**
- **Binance API Node** (`binance-api-node`)
- **Technical Indicators** (`technicalindicators`)
- **Telegram Bot API** (`node-telegram-bot-api`)
- **Dotenv** para gerenciamento de variáveis de ambiente

## 🚀 Funcionalidades

- **Monitoramento de mercado:** verifica múltiplos pares USDT em diferentes intervalos (5m, 15m, 30m e 1h).
- **Validação técnica:** usa RSI (Relative Strength Index), volume acima da média e quedas acentuadas como critérios de entrada.
- **Gerenciamento de trades:** realiza operações simultâneas limitadas com controle de saldo disponível.
- **Gerenciamento de risco:** aplica stop loss e take profit pré-configurados automaticamente.
- **Notificações via Telegram:** avisos detalhados em tempo real sobre operações executadas, saldo insuficiente e detecção de ações manuais ou problemas nas operações.

## 📌 Pré-requisitos

- Conta na Binance com saldo em USDT
- API Key e API Secret configuradas com permissão para trading na Binance
- Node.js instalado
- Conta e bot configurado no Telegram (opcional)

## 🛠️ Instalação

Clone o repositório:

```bash
git clone https://github.com/AntunesDev/dipcatcher-bot.git
cd dipcatcher-bot
```

Instale as dependências:

```bash
npm install binance-api-node technicalindicators node-telegram-bot-api dotenv
```

Crie um arquivo `.env` na raiz do projeto:

```env
BINANCE_API_KEY=SuaAPIKey
BINANCE_API_SECRET=SuaAPISecret
USE_TESTNET=true # ou false para produção
ENABLE_TELEGRAM=true # ou false
TELEGRAM_TOKEN=TokenDoSeuBot
TELEGRAM_CHAT_ID=IdDoSeuChat
```

## ▶️ Execução

Inicie o bot com o seguinte comando:

```bash
node index.js
```

## 🔄 Configurações

Edite os seguintes parâmetros diretamente no script para ajustar seu bot:

- `MIN_DROP_PERCENT`: Percentual mínimo de queda para considerar compra.
- `TARGET_PROFIT_PERCENT`: Percentual de lucro alvo para vendas.
- `STOP_LOSS_PERCENT`: Percentual máximo aceitável para perda.
- `TRADE_AMOUNT_USDT`: Quantidade em USDT para cada operação.
- `MAX_CONCURRENT_TRADES`: Número máximo de trades simultâneos.

## ⚠️ Aviso de Risco

Este bot automatiza operações financeiras e pode resultar em perdas substanciais. Utilize com responsabilidade e faça testes adequados antes de operar com valores significativos. O uso deste software é inteiramente sob sua responsabilidade.

## 📜 Licença

Este projeto é de código aberto e pode ser utilizado conforme a licença MIT.
