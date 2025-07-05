# OKX Dynamic Grid Trading Bot

A sophisticated cryptocurrency trading bot that implements a Dynamic Grid
Trading / DCA (Dollar-Cost Averaging) & Continuous Cycle strategy on the OKX
exchange.

## Strategy Overview

This bot implements a low-margin, high-volume trading strategy that continuously
reacts to market price changes to buy low and sell high, while averaging down
positions if the price drops.

### Key Features

- **Dynamic Grid Trading**: Continuously places buy/sell orders to capture small
  price movements
- **DCA Integration**: Averages down on losing positions without hard stop-loss
- **Continuous Cycle**: Automatically re-enters positions after profitable exits
- **Real-time WebSocket Integration**: Instant order updates and market data
- **State Persistence**: Resumes operation after restarts with saved state
- **Graceful Shutdown**: Cancels all orders and saves state on exit

## Bot Operation Flow

### Step 1: Aggressive Buy Attempt

- Places limit buy orders at current market price
- Cancels and retries if not filled immediately
- Uses WebSocket ticker for real-time price updates

### Step 2: Post-Buy Processing

- Places profit sell order (+0.2% above buy price)
- Places DCA buy order (-0.3% below buy price)
- Links orders for proper tracking

### Step 3: Post-Sell Processing

- Immediate re-entry buy at sell price
- Checks for higher pending sells
- Returns to aggressive buying if no higher sells exist

### Step 4: DCA Buy Processing

- Handles price drops by averaging down
- Maintains existing higher sell orders
- Places new profit sells and DCA orders

## Setup Instructions

### 1. Prerequisites

- Node.js 16+ installed
- OKX account with API access enabled
- Sufficient balance in your OKX account

### 2. Installation

```bash
# Clone or download the bot files
cd bot

# Install dependencies
npm install
```

### 3. Configuration

Edit the `.env` file with your OKX API credentials and trading preferences:

```env
# OKX API Configuration
OKX_API_KEY=your_api_key_here
OKX_SECRET_KEY=your_secret_key_here
OKX_PASSPHRASE=your_passphrase_here
OKX_SANDBOX=false

# Trading Configuration
SYMBOL=BTC-USDT
QUOTE_CURRENCY_TRADE_AMOUNT=10
PROFIT_PERCENTAGE_PER_TRADE=0.2
DCA_BUY_PERCENTAGE_BELOW=0.3

# Bot Configuration
IMMEDIATE_BUY_WAIT_MS=100
API_RETRY_DELAY_MS=1000
MAX_API_RETRIES=3
```

### 4. OKX API Setup

1. Log into your OKX account
2. Go to API Management
3. Create a new API key with trading permissions
4. Enable IP whitelist for security
5. Copy the API Key, Secret Key, and Passphrase to your `.env` file

### 5. Configuration Parameters

| Parameter                     | Description                        | Default    |
| ----------------------------- | ---------------------------------- | ---------- |
| `SYMBOL`                      | Trading pair symbol                | `BTC-USDT` |
| `QUOTE_CURRENCY_TRADE_AMOUNT` | Amount in quote currency per trade | `10`       |
| `PROFIT_PERCENTAGE_PER_TRADE` | Profit target percentage           | `0.2`      |
| `DCA_BUY_PERCENTAGE_BELOW`    | DCA buy percentage below           | `0.3`      |
| `IMMEDIATE_BUY_WAIT_MS`       | Wait time for aggressive buy fills | `100`      |
| `API_RETRY_DELAY_MS`          | Delay between API retries          | `1000`     |
| `MAX_API_RETRIES`             | Maximum API retry attempts         | `3`        |

## Running the Bot

### Start the bot:

```bash
npm start
```

### Development mode with auto-restart:

```bash
npm run dev
```

### Stop the bot:

Press `Ctrl+C` to trigger graceful shutdown

## State Management

The bot automatically saves its state to `bot_state.json` including:

- Open sell orders
- Pending DCA buy orders
- Last known price
- Total realized profit

On restart, the bot:

1. Loads saved state
2. Reconciles with exchange orders
3. Resumes appropriate operation mode

## Safety Features

### Risk Management

- No hard stop-loss (holds positions for recovery)
- Position size validation against minimum trade amounts
- Price/size rounding according to instrument specifications
- Comprehensive error handling with retries

### Graceful Shutdown

- Cancels all open orders
- Saves final state
- Closes WebSocket connections cleanly

### API Security

- HMAC-SHA256 authentication for all requests
- Timestamp validation
- Rate limiting compliance

## Monitoring

The bot provides comprehensive logging including:

- Order placements and fills
- Balance updates
- State changes
- Error conditions
- Profit tracking

Example log output:

```
[2025-01-05T10:00:00.000Z] Aggressive buy order placed: 0.001 @ 45000
[2025-01-05T10:00:01.000Z] Buy filled: 0.001 @ 45000
[2025-01-05T10:00:02.000Z] Profit sell order placed: 0.001 @ 45090 (0.2% profit)
[2025-01-05T10:00:03.000Z] DCA buy order placed: 0.001 @ 44865 (0.3% below)
```

## File Structure

```
bot/
├── index.js          # Main bot code (single file)
├── package.json      # Node.js dependencies
├── .env             # Configuration file
├── bot_state.json   # State persistence (auto-generated)
└── README.md        # This file
```

## Troubleshooting

### Common Issues

1. **API Authentication Errors**

   - Verify API credentials in `.env`
   - Check IP whitelist settings
   - Ensure API has trading permissions

2. **Insufficient Balance**

   - Check account balance
   - Reduce `QUOTE_CURRENCY_TRADE_AMOUNT`

3. **WebSocket Disconnections**

   - Bot auto-reconnects on disconnection
   - Check network stability

4. **Order Placement Failures**
   - Verify trading pair is active
   - Check minimum trade amounts
   - Review API rate limits

### Logs Analysis

- **Order tracking**: Monitor buy/sell order IDs
- **State persistence**: Verify `bot_state.json` updates
- **Profit tracking**: Watch `totalRealizedProfit` accumulation
- **WebSocket health**: Check connection status messages

## Disclaimers

- **Risk Warning**: Cryptocurrency trading involves substantial risk
- **No Guarantees**: Past performance doesn't guarantee future results
- **Testing Recommended**: Test thoroughly with small amounts first
- **Market Conditions**: Strategy performance varies with market volatility
- **API Limits**: Respect OKX API rate limits and terms of service

## Support

For issues or questions:

1. Check the troubleshooting section
2. Review OKX API documentation
3. Verify configuration parameters
4. Monitor bot logs for error details

## Version History

- **v1.0.0**: Initial release with full Dynamic Grid/DCA strategy implementation
