const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

// ============ 配置 ============
const SMALL_BLIND = 10;
const BIG_BLIND = 20;
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 8;

// ============ 数据存储 ============
const rooms = {}; // { roomId: Room }

// ============ 扑克牌工具 ============
const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const RANK_VALUES = { '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14 };

function createDeck() {
    const deck = [];
    for (const suit of SUITS) {
        for (const rank of RANKS) {
            deck.push({ suit, rank, value: RANK_VALUES[rank] });
        }
    }
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

function createRoom(hostId, hostName, initialChips) {
    const roomId = uuidv4().slice(0, 8).toUpperCase();
    rooms[roomId] = {
        id: roomId,
        players: [],
        deck: [],
        communityCards: [],
        pot: 0,
        currentBet: 0,
        phase: 'waiting',
        dealer: 0,
        currentPlayer: 0,
        phaseBets: {},
        smallBlind: SMALL_BLIND,
        bigBlind: BIG_BLIND,
        initialChips: initialChips,
        gameStarted: false,
        createdAt: Date.now()
    };
    return roomId;
}

function startNewHand(room) {
    room.deck = createDeck();
    room.communityCards = [];
    room.pot = 0;
    room.currentBet = 0;
    room.phaseBets = {};

    room.players.forEach(p => {
        p.hand = [];
        p.currentBet = 0;
        p.folded = false;
        p.allIn = false;
        p.ready = false;
    });

    room.dealer = (room.dealer + 1) % room.players.length;

    for (let i = 0; i < 2 * room.players.length; i++) {
        const playerIndex = i % room.players.length;
        room.players[playerIndex].hand.push(room.deck.pop());
    }

    const sbIndex = (room.dealer + 1) % room.players.length;
    const bbIndex = (room.dealer + 2) % room.players.length;

    room.players[sbIndex].chips -= room.smallBlind;
    room.players[sbIndex].currentBet = room.smallBlind;
    room.players[bbIndex].chips -= room.bigBlind;
    room.players[bbIndex].currentBet = room.bigBlind;

    room.pot = room.smallBlind + room.bigBlind;
    room.currentBet = room.bigBlind;
    room.currentPlayer = (bbIndex + 1) % room.players.length;
    room.phase = 'preflop';
}

// ============ Socket 处理 ============
io.on('connection', (socket) => {
    console.log('用户连接:', socket.id);
    socket.roomId = null;
    socket.playerId = uuidv4();

    // 创建房间
    socket.on('createRoom', (data, callback) => {
        const { playerName, initialChips, baseUrl } = data;

        if (!playerName || !initialChips) {
            callback({ success: false, error: '参数错误' });
            return;
        }

        const roomId = createRoom(socket.playerId, playerName, initialChips);

        const player = {
            id: socket.playerId,
            socketId: socket.id,
            name: playerName,
            chips: initialChips,
            hand: [],
            currentBet: 0,
            folded: false,
            allIn: false,
            isHost: true,
            ready: false
        };

        rooms[roomId].players.push(player);
        socket.join(roomId);
        socket.roomId = roomId;
        socket.playerName = playerName;

        console.log(`房间创建: ${roomId} by ${playerName}`);

        callback({
            success: true,
            roomId,
            playerId: socket.playerId,
            playerName,
            initialChips,
            shareUrl: `${baseUrl || ''}?room=${roomId}`
        });
    });

    // 加入房间
    socket.on('joinRoom', (data, callback) => {
        const { roomId, playerName } = data;
        const room = rooms[roomId];

        if (!room) {
            callback({ success: false, error: '房间不存在' });
            return;
        }

        if (room.players.length >= MAX_PLAYERS) {
            callback({ success: false, error: '房间已满' });
            return;
        }

        if (room.gameStarted) {
            callback({ success: false, error: '游戏已开始' });
            return;
        }

        const exists = room.players.find(p => p.name === playerName);
        if (exists) {
            callback({ success: false, error: '名字已被使用' });
            return;
        }

        const player = {
            id: socket.playerId,
            socketId: socket.id,
            name: playerName,
            chips: room.initialChips,
            hand: [],
            currentBet: 0,
            folded: false,
            allIn: false,
            isHost: false,
            ready: false
        };

        room.players.push(player);
        socket.join(roomId);
        socket.roomId = roomId;
        socket.playerName = playerName;

        io.to(roomId).emit('playerJoined', {
            players: room.players.map(p => ({
                id: p.id,
                name: p.name,
                chips: p.chips,
                ready: p.ready,
                isHost: p.isHost
            }))
        });

        console.log(`玩家加入: ${playerName} 加入房间 ${roomId}`);

        callback({
            success: true,
            playerId: socket.playerId,
            roomId,
            initialChips: room.initialChips,
            players: room.players.map(p => ({
                id: p.id,
                name: p.name,
                chips: p.chips,
                ready: p.ready,
                isHost: p.isHost
            }))
        });
    });

    // 准备/取消准备
    socket.on('playerReady', (data, callback) => {
        const room = rooms[socket.roomId];
        if (!room) {
            callback({ success: false, error: '房间不存在' });
            return;
        }

        if (room.gameStarted) {
            callback({ success: false, error: '游戏已开始' });
            return;
        }

        const player = room.players.find(p => p.id === socket.playerId);
        if (!player) {
            callback({ success: false, error: '玩家不存在' });
            return;
        }

        player.ready = !player.ready;

        io.to(room.roomId).emit('playerReadyUpdate', {
            players: room.players.map(p => ({
                id: p.id,
                name: p.name,
                chips: p.chips,
                ready: p.ready,
                isHost: p.isHost
            }))
        });

        callback({ success: true, ready: player.ready });
    });

    // ========== 开始游戏 (核心) ==========
    socket.on('startGame', (data, callback) => {
        console.log('========== startGame ==========');
        console.log('socket.id:', socket.id);
        console.log('socket.roomId:', socket.roomId);
        console.log('socket.playerId:', socket.playerId);

        const room = rooms[socket.roomId];
        if (!room) {
            console.log('FAIL: 房间不存在');
            callback({ success: false, error: '房间不存在' });
            return;
        }

        console.log('房间:', room.id, '玩家数:', room.players.length);

        const player = room.players.find(p => p.id === socket.playerId);
        if (!player || !player.isHost) {
            console.log('FAIL: 不是房主');
            callback({ success: false, error: '只有房主可以开始' });
            return;
        }

        console.log('房主:', player.name);

        if (room.players.length < MIN_PLAYERS) {
            console.log('FAIL: 人数不足');
            callback({ success: false, error: `至少需要 ${MIN_PLAYERS} 人` });
            return;
        }

        const notReady = room.players.filter(p => !p.ready);
        if (notReady.length > 0) {
            console.log('FAIL: 有玩家未准备:', notReady.map(p => p.name).join(', '));
            callback({ success: false, error: `未准备: ${notReady.map(p => p.name).join(', ')}` });
            return;
        }

        for (const p of room.players) {
            if (p.chips < room.bigBlind * 2) {
                console.log('FAIL: 筹码不足:', p.name);
                callback({ success: false, error: `${p.name} 筹码不足` });
                return;
            }
        }

        console.log('所有检查通过，开始游戏!');
        room.gameStarted = true;
        startNewHand(room);

        io.to(room.roomId).emit('gameStarted', {
            dealer: room.dealer,
            players: room.players.map(p => ({
                id: p.id,
                name: p.name,
                chips: p.chips,
                hand: p.hand,
                currentBet: p.currentBet,
                folded: p.folded
            })),
            communityCards: room.communityCards,
            pot: room.pot,
            currentBet: room.currentBet,
            phase: room.phase,
            currentPlayer: room.currentPlayer,
            smallBlind: room.smallBlind,
            bigBlind: room.bigBlind
        });

        console.log('游戏已开始!');
        callback({ success: true });
    });

    // 下注
    socket.on('bet', (data, callback) => {
        const room = rooms[socket.roomId];
        if (!room) {
            callback({ success: false, error: '房间不存在' });
            return;
        }

        const playerIndex = room.players.findIndex(p => p.id === socket.playerId);
        if (playerIndex !== room.currentPlayer) {
            callback({ success: false, error: '还没轮到你' });
            return;
        }

        const { action, amount } = data;
        const player = room.players[playerIndex];

        if (action === 'fold') {
            player.folded = true;
        } else if (action === 'call') {
            const toCall = room.currentBet - player.currentBet;
            player.chips -= toCall;
            player.currentBet = room.currentBet;
            room.pot += toCall;
        } else if (action === 'bet' || action === 'raise') {
            const betAmount = parseInt(amount) || 0;
            if (betAmount <= 0) {
                callback({ success: false, error: '下注金额必须大于0' });
                return;
            }
            player.chips -= betAmount;
            player.currentBet += betAmount;
            room.pot += betAmount;
            room.currentBet = player.currentBet;
        } else if (action === 'allin') {
            const allInAmount = player.chips;
            player.chips = 0;
            player.allIn = true;
            player.currentBet += allInAmount;
            room.pot += allInAmount;
            if (player.currentBet > room.currentBet) {
                room.currentBet = player.currentBet;
            }
        }

        io.to(room.roomId).emit('playerAction', {
            playerId: socket.playerId,
            action,
            amount: amount || 0
        });

        let nextPlayer = -1;
        for (let i = 1; i <= room.players.length; i++) {
            const idx = (playerIndex + i) % room.players.length;
            if (!room.players[idx].folded && !room.players[idx].allIn) {
                nextPlayer = idx;
                break;
            }
        }

        if (nextPlayer === -1 || room.phase === 'showdown') {
            room.phase = 'showdown';
            io.to(room.roomId).emit('gameEnd', {
                players: room.players,
                communityCards: room.communityCards,
                pot: room.pot
            });
        } else {
            room.currentPlayer = nextPlayer;
            io.to(room.roomId).emit('gameUpdate', {
                players: room.players.map(p => ({
                    id: p.id,
                    name: p.name,
                    chips: p.chips,
                    currentBet: p.currentBet,
                    folded: p.folded
                })),
                pot: room.pot,
                currentBet: room.currentBet,
                currentPlayer: room.currentPlayer,
                phase: room.phase
            });
        }

        callback({ success: true });
    });

    // 转让房主
    socket.on('transferHost', (data, callback) => {
        const room = rooms[socket.roomId];
        if (!room) {
            callback({ success: false, error: '房间不存在' });
            return;
        }

        const player = room.players.find(p => p.id === socket.playerId);
        if (!player || !player.isHost) {
            callback({ success: false, error: '只有房主可以转让' });
            return;
        }

        const { targetPlayerId } = data;
        const target = room.players.find(p => p.id === targetPlayerId);
        if (!target) {
            callback({ success: false, error: '目标玩家不存在' });
            return;
        }

        player.isHost = false;
        target.isHost = true;

        io.to(room.roomId).emit('newHost', { hostId: targetPlayerId });
        callback({ success: true });
    });

    // 断开连接
    socket.on('disconnect', () => {
        console.log('用户断开:', socket.id);
        const room = rooms[socket.roomId];
        if (!room) return;

        const playerIndex = room.players.findIndex(p => p.id === socket.playerId);
        if (playerIndex === -1) return;

        const player = room.players[playerIndex];
        io.to(room.roomId).emit('playerLeft', { playerId: socket.playerId, playerName: player.name });

        room.players.splice(playerIndex, 1);

        if (room.players.length === 0) {
            delete rooms[socket.roomId];
        } else if (player.isHost) {
            room.players[0].isHost = true;
            io.to(room.roomId).emit('newHost', { hostId: room.players[0].id });
        }
    });
});

// ============ 启动 ============
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`德州扑克服务器运行在 http://localhost:${PORT}`);
});
