const axios = require('axios');
const WebSocket = require('ws');
const crypto = require('crypto');
require('dotenv').config();

// Enhanced Configuration
const CONFIG = {
    // API Credentials
    API_KEY: process.env.OKX_API_KEY,
    SECRET_KEY: process.env.OKX_SECRET_KEY,
    PASSPHRASE: process.env.OKX_PASSPHRASE,

    // Environment
    SANDBOX: process.env.OKX_SANDBOX === 'true',

    // Trading Parameters
    SYMBOL: process.env.SYMBOL || 'ETH-USDT',
    BASE_CURRENCY_TRADE_AMOUNT: parseFloat(process.env.BASE_CURRENCY_TRADE_AMOUNT) || 0.0001, // 0.0001 ETH
    PROFIT_PERCENTAGE_PER_TRADE: parseFloat(process.env.PROFIT_PERCENTAGE_PER_TRADE) || 0.2,
    DCA_BUY_PERCENTAGE_BELOW: parseFloat(process.env.DCA_BUY_PERCENTAGE_BELOW) || 0.3,

    // Performance Settings
    IMMEDIATE_BUY_WAIT_MS: parseInt(process.env.IMMEDIATE_BUY_WAIT_MS) || 100,
    API_RETRY_DELAY_MS: parseInt(process.env.API_RETRY_DELAY_MS) || 1000,
    MAX_API_RETRIES: parseInt(process.env.MAX_API_RETRIES) || 3,
    WS_PING_INTERVAL_MS: parseInt(process.env.WS_PING_INTERVAL_MS) || 15000,
    HTTP_TIMEOUT_MS: parseInt(process.env.HTTP_TIMEOUT_MS) || 15000
};

// API URLs
const BASE_URL = CONFIG.SANDBOX ? 'https://aws.okx.com' : 'https://www.okx.com';
const WS_URL = CONFIG.SANDBOX ? 'wss://wspap.okx.com:8443/ws/v5/public' : 'wss://ws.okx.com:8443/ws/v5/public';
const WS_PRIVATE_URL = CONFIG.SANDBOX ? 'wss://wspap.okx.com:8443/ws/v5/private' : 'wss://ws.okx.com:8443/ws/v5/private';

// Enhanced OKX Trading Bot
class OKXTradingBot {
    constructor() {
        // Core State
        this.instrumentDetails = null;
        this.lastKnownPrice = null;
        this.openSellOrders = new Map();
        this.pendingDcaBuyOrder = null;
        this.totalRealizedProfit = 0;
        this.isShuttingDown = false;
        this.currentAggressiveBuyOrder = null;

        // Enhanced State Management
        this.lastSuccessfulWSMessage = Date.now();
        this.isReconnecting = false;
        this.pendingOrderOperations = new Set();

        // Event-driven Aggressive Buy State
        this.isInAggressiveBuyMode = false;
        this.aggressiveBuyRetryTimeout = null;

        // Components
        this.axiosInstance = this.createAxiosInstance();

        // WebSocket State
        this.wsPublic = null;
        this.wsPrivate = null;
        this.lastPublicPing = Date.now();
        this.lastPrivatePing = Date.now();

        // Setup
        this.setupGracefulShutdown();
        this.setupHealthMonitoring();
    }

    createAxiosInstance() {
        return axios.create({
            timeout: CONFIG.HTTP_TIMEOUT_MS,
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'OKX-Enhanced-Bot/3.0',
                'Connection': 'keep-alive'
            }
        });
    }

    setupGracefulShutdown() {
        const shutdown = () => this.gracefulShutdown();
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
    }

    setupHealthMonitoring() {
        setInterval(() => {
            this.checkWebSocketHealth();
        }, CONFIG.WS_PING_INTERVAL_MS);
    }

    log(message) {
        console.log(`[${new Date().toISOString()}] ${message}`);
    }

    error(message, error = null) {
        console.error(`[${new Date().toISOString()}] ERROR: ${message}`, error || '');
    }

    // Enhanced signature generation
    sign(timestamp, method, requestPath, body = '') {
        const message = timestamp + method + requestPath + body;
        return crypto.createHmac('sha256', CONFIG.SECRET_KEY).update(message).digest('base64');
    }

    generateClientOrderId() {
        const timestamp = Date.now().toString();
        const randomSuffix = Math.random().toString(36).substring(2, 8);
        return `bot${timestamp}${randomSuffix}`.substring(0, 32);
    }

    // Price/Size calculations
    roundPrice(price) {
        if (!this.instrumentDetails?.tickSz) return price;
        const tickSize = parseFloat(this.instrumentDetails.tickSz);
        return Math.round(price / tickSize) * tickSize;
    }

    roundSize(size) {
        if (!this.instrumentDetails?.lotSz) return size;
        const lotSize = parseFloat(this.instrumentDetails.lotSz);
        return Math.round(size / lotSize) * lotSize;
    }

    // ✅ Updated to use fixed BASE_CURRENCY_TRADE_AMOUNT
    calculateTradeSize(price) {
        return this.roundSize(CONFIG.BASE_CURRENCY_TRADE_AMOUNT);
    }

    // Enhanced API request with better error handling
    async apiRequest(method, endpoint, body = null, isPrivate = true) {
        for (let attempt = 1; attempt <= CONFIG.MAX_API_RETRIES; attempt++) {
            try {
                const timestamp = new Date().toISOString();
                const requestPath = endpoint;
                const bodyStr = body ? JSON.stringify(body) : '';

                const headers = {};

                if (isPrivate) {
                    const signature = this.sign(timestamp, method, requestPath, bodyStr);
                    headers['OK-ACCESS-KEY'] = CONFIG.API_KEY;
                    headers['OK-ACCESS-SIGN'] = signature;
                    headers['OK-ACCESS-TIMESTAMP'] = timestamp;
                    headers['OK-ACCESS-PASSPHRASE'] = CONFIG.PASSPHRASE;
                }

                const config = {
                    method,
                    url: `${BASE_URL}${endpoint}`,
                    headers,
                    validateStatus: (status) => status < 500
                };

                if (body && (method === 'POST' || method === 'PUT')) {
                    config.data = body;
                }

                const response = await this.axiosInstance(config);

                if (response.status >= 400) {
                    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                }

                if (response.data.code !== '0') {
                    throw new Error(`API Error: ${response.data.msg} (Code: ${response.data.code})`);
                }

                return response.data;
            } catch (error) {
                this.error(`API request failed (attempt ${attempt}/${CONFIG.MAX_API_RETRIES}): ${error.message}`);

                if (attempt === CONFIG.MAX_API_RETRIES) {
                    throw error;
                }

                await new Promise(resolve => setTimeout(resolve, CONFIG.API_RETRY_DELAY_MS * attempt));
            }
        }
    }

    updatePrice(price) {
        this.lastKnownPrice = price;
    }

    // Enhanced WebSocket setup
    async setupWebSockets() {
        this.log('Setting up WebSocket connections...');

        await Promise.all([
            this.setupPublicWebSocket(),
            this.setupPrivateWebSocket()
        ]);

        await new Promise(resolve => setTimeout(resolve, 2000));
    }

    setupPublicWebSocket() {
        return new Promise((resolve) => {
            this.wsPublic = new WebSocket(WS_URL);

            this.wsPublic.on('open', () => {
                this.log('Public WebSocket connected');
                this.lastPublicPing = Date.now();

                this.wsPublic.send(JSON.stringify({
                    op: 'subscribe',
                    args: [{
                        channel: 'tickers',
                        instId: CONFIG.SYMBOL
                    }]
                }));

                resolve();
            });

            this.wsPublic.on('message', (data) => {
                this.lastPublicPing = Date.now();
                try {
                    const message = JSON.parse(data.toString());
                    if (message.data?.[0]?.last) {
                        this.updatePrice(parseFloat(message.data[0].last));
                    }
                } catch (error) {
                    this.error('Error parsing public WebSocket message:', error.message);
                }
            });

            this.wsPublic.on('error', (error) => {
                this.error('Public WebSocket error:', error.message);
            });

            this.wsPublic.on('close', (code, reason) => {
                this.log(`Public WebSocket disconnected: Code=${code}, Reason=${reason}`);
                if (!this.isShuttingDown) {
                    setTimeout(() => this.reconnectPublicWebSocket(), 5000);
                }
            });
        });
    }

    setupPrivateWebSocket() {
        return new Promise((resolve) => {
            this.wsPrivate = new WebSocket(WS_PRIVATE_URL);

            this.wsPrivate.on('open', () => {
                this.log('Private WebSocket connected, logging in...');
                this.lastPrivatePing = Date.now();
                this.loginPrivateWebSocket();
            });

            this.wsPrivate.on('message', (data) => {
                this.lastPrivatePing = Date.now();
                this.lastSuccessfulWSMessage = Date.now(); // Track successful messages

                try {
                    const message = JSON.parse(data.toString());

                    if (message.event === 'login' && message.code === '0') {
                        this.log('Private WebSocket login successful');
                        this.wsPrivate.send(JSON.stringify({
                            op: 'subscribe',
                            args: [{
                                channel: 'orders',
                                instType: 'SPOT'
                            }]
                        }));
                        resolve();
                    } else if (message.data?.length > 0) {
                        for (const orderUpdate of message.data) {
                            this.handleOrderUpdate(orderUpdate);
                        }
                    }
                } catch (error) {
                    this.error('Error parsing private WebSocket message:', error.message);
                }
            });

            this.wsPrivate.on('error', (error) => {
                this.error('Private WebSocket error:', error.message);
            });

            // Enhanced disconnect handling with reconciliation
            this.wsPrivate.on('close', (code, reason) => {
                this.log(`Private WebSocket disconnected: Code=${code}, Reason=${reason}`);

                if (!this.isShuttingDown) {
                    // Check for missed orders during disconnect
                    this.handleWebSocketDisconnect();
                }
            });
        });
    }

    loginPrivateWebSocket() {
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const message = timestamp + 'GET' + '/users/self/verify';
        const signature = crypto.createHmac('sha256', CONFIG.SECRET_KEY).update(message).digest('base64');

        this.wsPrivate.send(JSON.stringify({
            op: 'login',
            args: [{
                apiKey: CONFIG.API_KEY,
                passphrase: CONFIG.PASSPHRASE,
                timestamp: timestamp,
                sign: signature
            }]
        }));
    }

    // Enhanced disconnect handling with reconciliation
    async handleWebSocketDisconnect() {
        if (this.isReconnecting || this.isShuttingDown) return;

        try {
            this.isReconnecting = true;

            const disconnectDuration = Date.now() - this.lastSuccessfulWSMessage;
            this.log(`🚨 Private WebSocket disconnected for ${disconnectDuration}ms - checking for missed orders...`);

            // Check for missed orders immediately
            await this.checkMissedOrdersDuringDisconnect();

            // Reconnect after checking
            setTimeout(() => {
                this.reconnectPrivateWebSocket();
            }, 1000);

        } catch (error) {
            this.error('Error handling WebSocket disconnect:', error.message);
            setTimeout(() => {
                this.reconnectPrivateWebSocket();
            }, 2000);
        }
    }

    // Check for missed orders during disconnect
    async checkMissedOrdersDuringDisconnect() {
        try {
            this.log('🔍 Reconciling order state after disconnect...');

            // Get current state from server
            const [openOrders, recentTrades] = await Promise.all([
                this.getOpenOrders(),
                this.getRecentTradesSince(this.lastSuccessfulWSMessage)
            ]);

            // Process missed fills
            await this.processMissedFills(recentTrades);

            // Process missed cancellations
            await this.processMissedCancellations(openOrders);

            // Process orphaned orders
            await this.processMissedOrphanedOrders(openOrders);

        } catch (error) {
            this.error('Failed to reconcile order state:', error.message);
        } finally {
            this.isReconnecting = false;
        }
    }

    // Get trades since specific timestamp
    async getRecentTradesSince(sinceTimestamp) {
        try {
            const after = Math.floor(sinceTimestamp / 1000).toString();
            const response = await this.apiRequest(
                'GET',
                `/api/v5/trade/fills?instId=${CONFIG.SYMBOL}&after=${after}&limit=100`
            );
            return response.data || [];
        } catch (error) {
            this.error('Failed to get recent trades:', error.message);
            return [];
        }
    }

    // Process missed fills
    async processMissedFills(recentTrades) {
        if (recentTrades.length === 0) {
            this.log('✅ No missed fills detected');
            return;
        }

        this.log(`🔍 Checking ${recentTrades.length} recent trades for missed fills...`);

        for (const trade of recentTrades) {
            const orderId = trade.ordId;
            const side = trade.side;
            const tradeTime = parseInt(trade.ts);

            // Only process trades during disconnect period
            if (tradeTime <= this.lastSuccessfulWSMessage) continue;

            // Check if this fill was already processed
            const wasProcessed = this.wasOrderFillProcessed(orderId, side);

            if (!wasProcessed) {
                this.log(`🚨 MISSED FILL: ${orderId} (${side}) @ ${trade.fillPx}`);

                // Create synthetic order update
                const syntheticUpdate = {
                    ordId: orderId,
                    instId: trade.instId,
                    side: side,
                    state: 'filled',
                    fillPx: trade.fillPx,
                    fillSz: trade.fillSz,
                    ts: trade.ts
                };

                // Process as normal order update
                await this.handleOrderUpdate(syntheticUpdate);
            }
        }
    }

    // Check if order fill was already processed
    wasOrderFillProcessed(orderId, side) {
        if (side === 'buy') {
            // Check if there's a corresponding sell order
            for (const [sellOrderId, sellInfo] of this.openSellOrders) {
                if (sellInfo.buyOrderId === orderId) {
                    return true;
                }
            }

            // Check if still tracking as aggressive buy
            if (this.currentAggressiveBuyOrder?.orderId === orderId) {
                return false;
            }

            return false;

        } else if (side === 'sell') {
            // Sell processed = removed from tracking
            return !this.openSellOrders.has(orderId);
        }

        return false;
    }

    // Process missed cancellations
    async processMissedCancellations(openOrders) {
        const serverOrderIds = new Set(openOrders.map(o => o.ordId));

        // Check sell orders
        for (const [sellOrderId] of this.openSellOrders) {
            if (!serverOrderIds.has(sellOrderId)) {
                this.log(`🚨 MISSED CANCELLATION: Sell ${sellOrderId}`);
                this.openSellOrders.delete(sellOrderId);
            }
        }

        // Check DCA buy order
        if (this.pendingDcaBuyOrder && !serverOrderIds.has(this.pendingDcaBuyOrder.orderId)) {
            this.log(`🚨 MISSED CANCELLATION: DCA ${this.pendingDcaBuyOrder.orderId}`);
            this.pendingDcaBuyOrder = null;
        }

        // Check aggressive buy order
        if (this.currentAggressiveBuyOrder && !serverOrderIds.has(this.currentAggressiveBuyOrder.orderId)) {
            this.log(`🚨 MISSED CANCELLATION: Aggressive ${this.currentAggressiveBuyOrder.orderId}`);
            this.currentAggressiveBuyOrder = null;
        }
    }

    // Process orphaned orders
    async processMissedOrphanedOrders(openOrders) {
        const trackedOrderIds = new Set();

        // Collect tracked orders
        for (const [sellOrderId] of this.openSellOrders) {
            trackedOrderIds.add(sellOrderId);
        }

        if (this.pendingDcaBuyOrder) {
            trackedOrderIds.add(this.pendingDcaBuyOrder.orderId);
        }

        if (this.currentAggressiveBuyOrder) {
            trackedOrderIds.add(this.currentAggressiveBuyOrder.orderId);
        }

        // Find orphaned orders
        for (const serverOrder of openOrders) {
            if (!trackedOrderIds.has(serverOrder.ordId)) {
                this.log(`🚨 ORPHANED ORDER: ${serverOrder.ordId} (${serverOrder.side})`);
                await this.cancelOrder(serverOrder.ordId);
            }
        }
    }

    checkWebSocketHealth() {
        const now = Date.now();
        const timeout = CONFIG.WS_PING_INTERVAL_MS * 2;

        if (this.wsPublic?.readyState === WebSocket.OPEN) {
            if (now - this.lastPublicPing > timeout) {
                this.reconnectPublicWebSocket();
            } else {
                this.wsPublic.ping();
            }
        }

        if (this.wsPrivate?.readyState === WebSocket.OPEN) {
            if (now - this.lastPrivatePing > timeout) {
                this.reconnectPrivateWebSocket();
            } else {
                this.wsPrivate.ping();
            }
        }
    }

    async reconnectPublicWebSocket() {
        if (this.isShuttingDown) return;
        try {
            if (this.wsPublic) {
                this.wsPublic.removeAllListeners();
                this.wsPublic.close();
            }
            await this.setupPublicWebSocket();
        } catch (error) {
            this.error('Failed to reconnect public WebSocket:', error.message);
        }
    }

    async reconnectPrivateWebSocket() {
        if (this.isShuttingDown) return;
        try {
            this.log('🔄 Reconnecting private WebSocket...');

            if (this.wsPrivate) {
                this.wsPrivate.removeAllListeners();
                this.wsPrivate.close();
            }

            await this.setupPrivateWebSocket();
            this.log('✅ Private WebSocket reconnected successfully');

        } catch (error) {
            this.error('Failed to reconnect private WebSocket:', error.message);
            setTimeout(() => {
                this.reconnectPrivateWebSocket();
            }, 5000);
        }
    }

    // Enhanced order placement
    async placeOrder(side, price, size, orderType = 'limit', clientOrderId = null) {
        try {
            const roundedPrice = this.roundPrice(price);
            const roundedSize = this.roundSize(size);

            const orderData = {
                instId: CONFIG.SYMBOL,
                tdMode: 'cash',
                side: side,
                ordType: orderType,
                sz: roundedSize.toString(),
                px: roundedPrice.toString(),
                clOrdId: clientOrderId || this.generateClientOrderId()
            };

            this.log(`Placing ${side} order: ${roundedSize} @ ${roundedPrice}`);

            const response = await this.apiRequest('POST', '/api/v5/trade/order', orderData);

            if (response.data?.[0]?.sCode === '0') {
                const orderResult = response.data[0];
                this.log(`Order placed successfully: ID=${orderResult.ordId}`);
                return {
                    orderId: orderResult.ordId,
                    clientOrderId: orderData.clOrdId,
                    side: side,
                    price: roundedPrice,
                    size: roundedSize
                };
            } else {
                const orderResult = response.data[0];
                throw new Error(`Order placement failed: ${orderResult.sMsg} (Code: ${orderResult.sCode})`);
            }
        } catch (error) {
            this.error(`Failed to place ${side} order:`, error.message);
            throw error;
        }
    }

    // Enhanced order cancellation
    async cancelOrder(orderId, clientOrderId = null) {
        try {
            this.pendingOrderOperations.add(orderId);

            const cancelData = {
                instId: CONFIG.SYMBOL,
                ordId: orderId
            };

            if (clientOrderId) {
                cancelData.clOrdId = clientOrderId;
            }

            const response = await this.apiRequest('POST', '/api/v5/trade/cancel-order', cancelData);

            if (response.data?.[0]?.sCode === '0') {
                this.log(`Order cancelled successfully: ${orderId}`);
                return true;
            } else {
                const errorMsg = response.data?.[0]?.sMsg || 'Unknown error';
                this.log(`Cancel failed for ${orderId}: ${errorMsg}`);
                return false;
            }
        } catch (error) {
            this.error(`Failed to cancel order ${orderId}:`, error.message);
            return false;
        } finally {
            this.pendingOrderOperations.delete(orderId);
        }
    }

    // API helpers
    async fetchInstrumentDetails() {
        try {
            this.log('Fetching instrument details...');
            const response = await this.apiRequest('GET', `/api/v5/public/instruments?instType=SPOT&instId=${CONFIG.SYMBOL}`, null, false);

            if (!response.data?.length) {
                throw new Error(`Instrument ${CONFIG.SYMBOL} not found`);
            }

            this.instrumentDetails = response.data[0];
            this.log(`Instrument details loaded: tickSz=${this.instrumentDetails.tickSz}, lotSz=${this.instrumentDetails.lotSz}`);
        } catch (error) {
            this.error('Failed to fetch instrument details:', error.message);
            throw error;
        }
    }

    async getCurrentPrice() {
        try {
            const response = await this.apiRequest('GET', `/api/v5/market/ticker?instId=${CONFIG.SYMBOL}`, null, false);
            if (response.data?.[0]?.last) {
                return parseFloat(response.data[0].last);
            }
            throw new Error('No ticker data received');
        } catch (error) {
            this.error('Failed to get current price:', error.message);
            throw error;
        }
    }

    async getOpenOrders() {
        try {
            const response = await this.apiRequest('GET', `/api/v5/trade/orders-pending?instId=${CONFIG.SYMBOL}`);
            return response.data || [];
        } catch (error) {
            this.error('Failed to get open orders:', error.message);
            throw error;
        }
    }

    // Enhanced order processing
    async handleOrderUpdate(orderUpdate) {
        try {
            if (orderUpdate.instId !== CONFIG.SYMBOL) return;

            const orderId = orderUpdate.ordId;
            const state = orderUpdate.state;
            const side = orderUpdate.side;

            this.log(`Order update: ${orderId} (${side}) -> ${state}`);

            if (state === 'filled') {
                if (side === 'buy') {
                    await this.processAfterBuyFill(orderUpdate);
                } else if (side === 'sell') {
                    await this.processAfterSellFill(orderUpdate);
                }
            } else if (state === 'cancelled') {
                this.handleOrderCancellation(orderUpdate);
            }
        } catch (error) {
            this.error('Error handling order update:', error.message);
        }
    }

    async processAfterBuyFill(orderUpdate) {
        const fillPrice = parseFloat(orderUpdate.fillPx);
        const fillSize = parseFloat(orderUpdate.fillSz);

        this.log(`Buy filled: ${fillSize} @ ${fillPrice}`);

        // ✅ Clear aggressive buy state
        if (this.currentAggressiveBuyOrder?.orderId === orderUpdate.ordId) {
            this.currentAggressiveBuyOrder = null;
            this.isInAggressiveBuyMode = false;

            // Clear retry timeout
            if (this.aggressiveBuyRetryTimeout) {
                clearTimeout(this.aggressiveBuyRetryTimeout);
                this.aggressiveBuyRetryTimeout = null;
            }

            this.log('Aggressive buy cycle completed - order filled');
        }

        try {
            // 1. Place profit sell order
            const profitPrice = fillPrice * (1 + CONFIG.PROFIT_PERCENTAGE_PER_TRADE / 100);
            const sellOrder = await this.placeOrder('sell', profitPrice, fillSize);

            this.openSellOrders.set(sellOrder.orderId, {
                ...sellOrder,
                buyPrice: fillPrice,
                buyOrderId: orderUpdate.ordId
            });

            this.log(`Profit sell order placed: ${fillSize} @ ${profitPrice} (${CONFIG.PROFIT_PERCENTAGE_PER_TRADE}% profit)`);

            // 2. Cancel previous DCA buy order if exists
            if (this.pendingDcaBuyOrder) {
                await this.cancelOrder(this.pendingDcaBuyOrder.orderId, this.pendingDcaBuyOrder.clientOrderId);
                this.pendingDcaBuyOrder = null;
            }

            // 3. Place new DCA buy order
            const dcaPrice = fillPrice * (1 - CONFIG.DCA_BUY_PERCENTAGE_BELOW / 100);
            const dcaBuyOrder = await this.placeOrder('buy', dcaPrice, fillSize);
            this.pendingDcaBuyOrder = dcaBuyOrder;

            this.log(`DCA buy order placed: ${fillSize} @ ${dcaPrice} (${CONFIG.DCA_BUY_PERCENTAGE_BELOW}% below)`);
        } catch (error) {
            this.error('Failed to process after buy fill:', error.message);
        }
    }

    async processAfterSellFill(orderUpdate) {
        const fillPrice = parseFloat(orderUpdate.fillPx);
        const fillSize = parseFloat(orderUpdate.fillSz);
        const orderId = orderUpdate.ordId;

        this.log(`Sell filled: ${fillSize} @ ${fillPrice}`);

        // Calculate and track profit
        const sellOrderInfo = this.openSellOrders.get(orderId);
        if (sellOrderInfo) {
            const profit = (fillPrice - sellOrderInfo.buyPrice) * fillSize;
            this.totalRealizedProfit += profit;
            this.openSellOrders.delete(orderId); // Remove filled order first
            this.log(`Profit realized: ${profit.toFixed(8)} (Total: ${this.totalRealizedProfit.toFixed(8)})`);
        }

        try {
            // ✅ Check if all sell orders are filled
            if (this.openSellOrders.size === 0) {
                this.log('🎯 All sell orders filled! Returning to aggressive buy cycle...');

                // ✅ Start aggressive buy immediately
                this.startAggressiveBuyCycle();

            } else {
                // Still have sell orders - just log status
                const remainingSells = Array.from(this.openSellOrders.values())
                    .map(order => order.price)
                    .sort((a, b) => b - a);

                this.log(`💰 Sell order filled at ${fillPrice}, but ${this.openSellOrders.size} higher sell orders remain`);
                this.log(`📊 Remaining sell orders: [${remainingSells.join(', ')}]`);
                this.log(`⏳ Waiting for higher sells to fill before returning to aggressive buying...`);
            }

        } catch (error) {
            this.error('Failed to process sell fill logic:', error.message);
        }
    }

    handleOrderCancellation(orderUpdate) {
        const orderId = orderUpdate.ordId;

        // Remove from tracking
        if (this.openSellOrders.has(orderId)) {
            this.openSellOrders.delete(orderId);
            this.log(`Cancelled sell order removed from tracking: ${orderId}`);
        }

        if (this.pendingDcaBuyOrder?.orderId === orderId) {
            this.pendingDcaBuyOrder = null;
            this.log(`Cancelled DCA buy order cleared: ${orderId}`);
        }

        if (this.currentAggressiveBuyOrder?.orderId === orderId) {
            this.currentAggressiveBuyOrder = null;
            this.log(`Cancelled aggressive buy order cleared: ${orderId}`);
        }
    }

    // ✅ Event-driven aggressive buy cycle
    async startAggressiveBuyCycle() {
        if (this.isShuttingDown || this.isInAggressiveBuyMode) return;

        this.log('Starting aggressive buy cycle...');
        this.isInAggressiveBuyMode = true;

        await this.attemptAggressiveBuy();
    }

    async attemptAggressiveBuy() {
        if (this.isShuttingDown || !this.isInAggressiveBuyMode) return;

        try {
            // ✅ Get current price với immediate fallback
            let currentPrice = this.lastKnownPrice;

            if (!currentPrice) {
                this.log('No WebSocket price available, fetching from API...');
                try {
                    currentPrice = await this.getCurrentPrice();
                    this.updatePrice(currentPrice);
                } catch (error) {
                    this.error('Failed to get current price:', error.message);
                    this.scheduleAggressiveBuyRetry(1000);
                    return;
                }
            }

            const tradeSize = this.calculateTradeSize(currentPrice);
            const buyOrder = await this.placeOrder('buy', currentPrice, tradeSize);
            this.currentAggressiveBuyOrder = buyOrder;

            this.log(`Aggressive buy order placed: ${tradeSize} @ ${currentPrice}`);

            // ✅ Schedule timeout check
            this.aggressiveBuyRetryTimeout = setTimeout(() => {
                this.handleAggressiveBuyTimeout();
            }, CONFIG.IMMEDIATE_BUY_WAIT_MS);

        } catch (error) {
            this.error('Error in aggressive buy attempt:', error.message);
            this.scheduleAggressiveBuyRetry(1000);
        }
    }

    async handleAggressiveBuyTimeout() {
        if (this.isShuttingDown || !this.isInAggressiveBuyMode) return;

        // ✅ Check internal state instead of REST API
        if (this.currentAggressiveBuyOrder) {
            this.log('Aggressive buy order timeout, cancelling and retrying...');

            try {
                await this.cancelOrder(
                    this.currentAggressiveBuyOrder.orderId,
                    this.currentAggressiveBuyOrder.clientOrderId
                );
                this.currentAggressiveBuyOrder = null;

                // ✅ Quick retry
                this.scheduleAggressiveBuyRetry(50);
            } catch (error) {
                this.error('Error cancelling aggressive buy order:', error.message);
                this.scheduleAggressiveBuyRetry(1000);
            }
        } else {
            // Order already filled via WebSocket
            this.log('Aggressive buy order filled via WebSocket during timeout period');
            this.isInAggressiveBuyMode = false;
        }
    }

    scheduleAggressiveBuyRetry(delayMs) {
        if (this.isShuttingDown || !this.isInAggressiveBuyMode) return;

        this.aggressiveBuyRetryTimeout = setTimeout(() => {
            this.attemptAggressiveBuy();
        }, delayMs);
    }

    // Enhanced cancel all orders
    async cancelAllOrdersAndStartFresh() {
        try {
            this.log('Cancelling all open orders and starting fresh...');
            const openOrders = await this.getOpenOrders();

            if (openOrders.length > 0) {
                this.log(`Found ${openOrders.length} open orders, cancelling all...`);

                const cancelPromises = openOrders.map(order =>
                    this.cancelOrder(order.ordId).catch(err =>
                        this.error(`Failed to cancel order ${order.ordId}:`, err.message)
                    )
                );

                await Promise.all(cancelPromises);

                // Wait for cancellations to be processed
                await new Promise(resolve => setTimeout(resolve, 1000));
            }

            // Clear internal state
            this.openSellOrders.clear();
            this.pendingDcaBuyOrder = null;
            this.currentAggressiveBuyOrder = null;
            this.totalRealizedProfit = 0;
            this.pendingOrderOperations.clear();
            this.isInAggressiveBuyMode = false;

            // Clear any pending timeouts
            if (this.aggressiveBuyRetryTimeout) {
                clearTimeout(this.aggressiveBuyRetryTimeout);
                this.aggressiveBuyRetryTimeout = null;
            }

            this.log('All orders cancelled, starting aggressive buy cycle...');
            this.startAggressiveBuyCycle();
        } catch (error) {
            this.error('Failed to cancel orders and start fresh:', error.message);
        }
    }

    async gracefulShutdown() {
        if (this.isShuttingDown) return;

        this.log('Initiating graceful shutdown...');
        this.isShuttingDown = true;
        this.isInAggressiveBuyMode = false;

        // Clear aggressive buy timeout
        if (this.aggressiveBuyRetryTimeout) {
            clearTimeout(this.aggressiveBuyRetryTimeout);
            this.aggressiveBuyRetryTimeout = null;
        }

        try {
            // Wait for pending operations
            let waitCount = 0;
            while (this.pendingOrderOperations.size > 0 && waitCount < 10) {
                this.log(`Waiting for ${this.pendingOrderOperations.size} pending operations...`);
                await new Promise(resolve => setTimeout(resolve, 500));
                waitCount++;
            }

            // Cancel all open orders
            const openOrders = await this.getOpenOrders();
            if (openOrders.length > 0) {
                this.log(`Cancelling ${openOrders.length} open orders...`);
                for (const order of openOrders) {
                    await this.cancelOrder(order.ordId);
                }
            }

            // Close WebSocket connections
            if (this.wsPublic) {
                this.wsPublic.removeAllListeners();
                this.wsPublic.close();
            }
            if (this.wsPrivate) {
                this.wsPrivate.removeAllListeners();
                this.wsPrivate.close();
            }

            this.log(`Graceful shutdown completed. Total profit: ${this.totalRealizedProfit.toFixed(8)}`);
            process.exit(0);
        } catch (error) {
            this.error('Error during graceful shutdown:', error.message);
            process.exit(1);
        }
    }

    // Enhanced startup
    async start() {
        try {
            this.log('=== OKX Enhanced Grid Trading Bot v3.0 Starting ===');
            this.log(`Trading pair: ${CONFIG.SYMBOL}`);
            this.log(`Trade amount: ${CONFIG.BASE_CURRENCY_TRADE_AMOUNT} ETH (base currency)`);
            this.log(`Profit target: ${CONFIG.PROFIT_PERCENTAGE_PER_TRADE}%`);
            this.log(`DCA percentage: ${CONFIG.DCA_BUY_PERCENTAGE_BELOW}%`);

            // Validate credentials
            if (!CONFIG.API_KEY || !CONFIG.SECRET_KEY || !CONFIG.PASSPHRASE) {
                throw new Error('Missing required API credentials in environment variables');
            }

            // Test API credentials
            this.log('Testing API credentials...');
            await this.apiRequest('GET', '/api/v5/account/balance');
            this.log('API credentials test passed');

            // Fetch instrument details
            await this.fetchInstrumentDetails();

            // Get initial price
            this.lastKnownPrice = await this.getCurrentPrice();
            this.log(`Current ${CONFIG.SYMBOL} price: ${this.lastKnownPrice}`);

            // Log estimated order value
            const estimatedValue = CONFIG.BASE_CURRENCY_TRADE_AMOUNT * this.lastKnownPrice;
            this.log(`Estimated order value: ${estimatedValue.toFixed(2)} USDT per trade`);

            // Setup WebSockets
            await this.setupWebSockets();

            // Cancel all existing orders and start fresh
            await this.cancelAllOrdersAndStartFresh();

            this.log('=== Enhanced Bot startup completed successfully ===');

        } catch (error) {
            this.error('Failed to start bot:', error.message);
            process.exit(1);
        }
    }
}

// Create and start enhanced bot instance
const bot = new OKXTradingBot();
bot.start().catch(error => {
    console.error('Unhandled startup error:', error);
    process.exit(1);
});