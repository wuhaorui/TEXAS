const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*' },
    pingTimeout: 60000,
    pingInterval: 25000
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

// ============ 扑克手牌评估 ============
const HAND_RANKS = {
    '高牌': 1, '一对': 2, '两对': 3, '三条': 4, '顺子': 5,
    '同花': 6, '葫芦': 7, '四条': 8, '同花顺': 9, '皇家同花顺': 10
};

function evaluateHand(cards) {
    // cards: [{suit, rank, value}] — 7张牌（2张手牌 + 5张公共牌）
    // 德州扑克规则：从7张牌中选出最好的5张牌组合

    const values = cards.map(c => c.value).sort((a, b) => b - a);
    const suits = cards.map(c => c.suit);
    const valueCounts = {};
    values.forEach(v => valueCounts[v] = (valueCounts[v] || 0) + 1);

    // 统计每个花色的牌数，判断是否存在同花（至少5张同花色）
    const suitCounts = {};
    suits.forEach(s => suitCounts[s] = (suitCounts[s] || 0) + 1);
    const flushSuit = Object.keys(suitCounts).find(s => suitCounts[s] >= 5) || null;
    const isFlush = flushSuit !== null;

    // 收集同花色的牌的值（用于同花比较）
    const flushValues = flushSuit
        ? cards.filter(c => c.suit === flushSuit).map(c => c.value).sort((a, b) => b - a)
        : [];

    // 判断顺子：从去重的值中找连续5个
    const uniqueValues = [...new Set(values)].sort((a, b) => b - a);
    // 特殊处理 A 可以当 1 用
    if (uniqueValues.includes(14)) uniqueValues.push(1);
    uniqueValues.sort((a, b) => b - a);
    let isStraight = false;
    let straightHigh = 0;
    for (let i = 0; i <= uniqueValues.length - 5; i++) {
        if (uniqueValues[i] - uniqueValues[i + 4] === 4) {
            isStraight = true;
            straightHigh = uniqueValues[i];
            break;
        }
    }
    // 特殊处理 A-2-3-4-5
    const isWheel = !isStraight && uniqueValues.includes(5) && uniqueValues.includes(4)
        && uniqueValues.includes(3) && uniqueValues.includes(2) && uniqueValues.includes(14);

    const counts = Object.entries(valueCounts).sort((a, b) => b[1] - a[1] || b[0] - a[0]);
    const [v1, c1] = counts[0];
    const [v2, c2] = counts[1] || [0, 0];

    let handRank, handName, tieBreaker, bestValues;

    if (isFlush && (isStraight || isWheel)) {
        // 同花顺：用同花花色的牌判断顺子
        const fv = flushValues;
        let sfHigh = 0;
        for (let i = 0; i <= fv.length - 5; i++) {
            if (fv[i] - fv[i + 4] === 4) {
                sfHigh = fv[i];
                break;
            }
        }
        // 检查 A-2-3-4-5 同花顺
        const isWheelFlush = !sfHigh && fv.includes(5) && fv.includes(4)
            && fv.includes(3) && fv.includes(2) && fv.includes(14);
        const isRoyal = (sfHigh === 14) || (isWheelFlush && fv[0] === 14 && fv.includes(10));
        handName = isRoyal ? '皇家同花顺' : '同花顺';
        handRank = HAND_RANKS[handName];
        tieBreaker = isWheelFlush ? 5 : (sfHigh || 5);
        bestValues = isWheelFlush ? [5, 4, 3, 2, 1] : fv.slice(0, 5);
    } else if (c1 === 4) {
        handName = '四条';
        handRank = HAND_RANKS[handName];
        tieBreaker = parseInt(v1);
        // 四条的 bestValues: 4张 + 最大踢牌
        const quadValues = cards.filter(c => c.value === parseInt(v1)).map(c => c.value);
        const kicker = values.find(v => v !== parseInt(v1));
        bestValues = [...quadValues.slice(0, 4), kicker || 0];
    } else if (c1 === 3 && c2 === 2) {
        handName = '葫芦';
        handRank = HAND_RANKS[handName];
        tieBreaker = parseInt(v1);
        bestValues = [parseInt(v1), parseInt(v1), parseInt(v1), parseInt(v2), parseInt(v2)];
    } else if (isFlush) {
        handName = '同花';
        handRank = HAND_RANKS[handName];
        tieBreaker = flushValues[0];
        bestValues = flushValues.slice(0, 5);
    } else if (isStraight || isWheel) {
        handName = '顺子';
        handRank = HAND_RANKS[handName];
        tieBreaker = isWheel ? 5 : straightHigh;
        bestValues = isWheel ? [5, 4, 3, 2, 1] : [straightHigh, straightHigh-1, straightHigh-2, straightHigh-3, straightHigh-4];
    } else if (c1 === 3) {
        handName = '三条';
        handRank = HAND_RANKS[handName];
        tieBreaker = parseInt(v1);
        const triple = cards.filter(c => c.value === parseInt(v1)).map(c => c.value);
        const kickers = values.filter(v => v !== parseInt(v1)).slice(0, 2);
        bestValues = [...triple, ...kickers];
    } else if (c1 === 2 && c2 === 2) {
        handName = '两对';
        handRank = HAND_RANKS[handName];
        tieBreaker = Math.max(parseInt(v1), parseInt(v2));
        const kick = values.find(v => v !== parseInt(v1) && v !== parseInt(v2));
        bestValues = [Math.max(parseInt(v1), parseInt(v2)), Math.min(parseInt(v1), parseInt(v2)), Math.max(parseInt(v1), parseInt(v2)), Math.min(parseInt(v1), parseInt(v2)), kick || 0];
    } else if (c1 === 2) {
        handName = '一对';
        handRank = HAND_RANKS[handName];
        tieBreaker = parseInt(v1);
        const pair = cards.filter(c => c.value === parseInt(v1)).map(c => c.value);
        const kickers = values.filter(v => v !== parseInt(v1)).slice(0, 3);
        bestValues = [...pair, ...kickers];
    } else {
        handName = '高牌';
        handRank = HAND_RANKS[handName];
        tieBreaker = values[0];
        bestValues = values.slice(0, 5);
    }

    return { handRank, handName, tieBreaker, values: bestValues };
}

function getWinners(players, communityCards) {
    const activePlayers = players.filter(p => !p.folded);
    if (activePlayers.length === 1) {
        return { winners: [activePlayers[0]], handName: '对手弃牌' };
    }

    const results = activePlayers.map(p => {
        const allCards = [...p.hand, ...communityCards];
        const bestHand = evaluateHand(allCards);
        return { player: p, ...bestHand };
    });

    // 按 handRank > tieBreaker > values 排序
    results.sort((a, b) => {
        if (b.handRank !== a.handRank) return b.handRank - a.handRank;
        if (b.tieBreaker !== a.tieBreaker) return b.tieBreaker - a.tieBreaker;
        for (let i = 0; i < a.values.length; i++) {
            if (b.values[i] !== a.values[i]) return b.values[i] - a.values[i];
        }
        return 0;
    });

    const winners = [results[0].player];
    for (let i = 1; i < results.length; i++) {
        if (results[i].handRank === results[0].handRank &&
            results[i].tieBreaker === results[0].tieBreaker &&
            JSON.stringify(results[i].values) === JSON.stringify(results[0].values)) {
            winners.push(results[i].player);
        } else {
            break;
        }
    }

    return { winners, handName: results[0].handName, results };
}

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
    room.actedThisPhase = new Set(); // 重置本阶段已行动玩家
}

// 进入下一阶段
function advancePhase(room) {
    // 重置本轮下注
    room.currentBet = 0;
    room.players.forEach(p => p.currentBet = 0);
    room.actedThisPhase = new Set(); // 重置本阶段已行动玩家

    if (room.phase === 'preflop') {
        // 翻牌圈：发3张公共牌
        for (let i = 0; i < 3; i++) {
            room.communityCards.push(room.deck.pop());
        }
        room.phase = 'flop';
    } else if (room.phase === 'flop') {
        // 转牌圈：发1张
        room.communityCards.push(room.deck.pop());
        room.phase = 'turn';
    } else if (room.phase === 'turn') {
        // 河牌圈：发1张
        room.communityCards.push(room.deck.pop());
        room.phase = 'river';
    } else if (room.phase === 'river') {
        // 进入摊牌
        room.phase = 'showdown';

        // 评估手牌，决定赢家
        const { winners, handName, results } = getWinners(room.players, room.communityCards);

        // 分配奖池
        const winAmount = Math.floor(room.pot / winners.length);
        winners.forEach(w => {
            const player = room.players.find(p => p.id === w.id);
            if (player) player.chips += winAmount;
        });

        // 发送游戏结束信息（注意：此时 room.dealer 还是当前局的，下一局会+1）
        io.to(room.id).emit('gameEnd', {
            players: room.players.map(p => ({
                id: p.id,
                name: p.name,
                chips: p.chips,
                hand: p.hand,
                folded: p.folded
            })),
            communityCards: room.communityCards,
            pot: room.pot,
            winners: winners.map(w => w.id),
            handName,
            results: results.map(r => ({
                playerId: r.player.id,
                handName: r.handName,
                handRank: r.handRank
            })),
            dealer: room.dealer // 发送当前 dealer 位置，前端用于显示位置标识
        });

        // 3秒后自动开始下一局
        setTimeout(() => {
            // 检查是否还有玩家有足够筹码
            const eligiblePlayers = room.players.filter(p => p.chips >= room.bigBlind);
            if (eligiblePlayers.length >= 2) {
                startNewHand(room);
                io.to(room.id).emit('gameStarted', {
                    players: room.players.map(p => ({
                        id: p.id,
                        name: p.name,
                        chips: p.chips,
                        hand: p.hand
                    })),
                    dealer: room.dealer,
                    phase: room.phase,
                    currentPlayer: room.currentPlayer,
                    pot: room.pot,
                    currentBet: room.currentBet
                });
            }
        }, 3000);

        return;
    }

    // 设置本阶段第一个行动的玩家（dealer下一位）
    room.currentPlayer = (room.dealer + 1) % room.players.length;
    while (room.players[room.currentPlayer].folded || room.players[room.currentPlayer].allIn) {
        room.currentPlayer = (room.currentPlayer + 1) % room.players.length;
    }

    io.to(room.id).emit('gameUpdate', {
        players: room.players.map(p => ({
            id: p.id,
            name: p.name,
            chips: p.chips,
            currentBet: p.currentBet,
            folded: p.folded
        })),
        communityCards: room.communityCards,
        pot: room.pot,
        currentBet: room.currentBet,
        currentPlayer: room.currentPlayer,
        phase: room.phase,
        dealer: room.dealer  // 添加 dealer 字段，前端用于显示位置标识
    });
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
            shareUrl: `${baseUrl || ''}?room=${roomId}`,
            players: rooms[roomId].players.map(p => ({
                id: p.id,
                name: p.name,
                chips: p.chips,
                ready: p.ready,
                isHost: p.isHost
            }))
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

    // 重新加入房间
    socket.on('rejoinRoom', (data, callback) => {
        const { roomId, playerName, oldPlayerId } = data;

        const room = rooms[roomId];
        if (!room) {
            callback({ success: false, error: '房间不存在或已结束' });
            return;
        }

        // 查找是否有同名的老玩家
        let player = room.players.find(p => p.name === playerName);

        if (player) {
            // 找到同名玩家，重新分配 socket
            player.socketId = socket.id;
            socket.playerId = player.id;
            socket.roomId = roomId;
            socket.join(roomId);

            console.log(`玩家重新加入: ${playerName} 房间 ${roomId}`);

            callback({
                success: true,
                playerId: player.id,
                isHost: player.isHost,
                players: room.players.map(p => ({
                    id: p.id,
                    name: p.name,
                    chips: p.chips,
                    ready: p.ready,
                    isHost: p.isHost
                })),
                gameInProgress: room.gameStarted
            });
        } else {
            // 没有找到同名玩家，作为新玩家加入
            const newPlayer = {
                id: oldPlayerId || uuidv4(),
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

            room.players.push(newPlayer);
            socket.playerId = newPlayer.id;
            socket.roomId = roomId;
            socket.join(roomId);

            io.to(room.id).emit('playerJoined', {
                players: room.players.map(p => ({
                    id: p.id,
                    name: p.name,
                    chips: p.chips,
                    ready: p.ready,
                    isHost: p.isHost
                }))
            });

            callback({
                success: true,
                playerId: newPlayer.id,
                isHost: false,
                players: room.players.map(p => ({
                    id: p.id,
                    name: p.name,
                    chips: p.chips,
                    ready: p.ready,
                    isHost: p.isHost
                })),
                gameInProgress: false
            });
        }
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

        io.to(room.id).emit('playerReadyUpdate', {
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

        io.to(room.id).emit('gameStarted', {
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
            console.log('[bet] 房间不存在! socket.roomId:', socket.roomId, 'socket.id:', socket.id);
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

        // 记录当前注额，用于判断是否有加注
        room.previousBet = room.currentBet;

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

        io.to(room.id).emit('playerAction', {
            playerId: socket.playerId,
            action,
            amount: amount || 0
        });

        // 记录本阶段已行动的玩家
        room.actedThisPhase.add(playerIndex);

        // 如果有人下注/加注/全下（提高了当前注额），重置其他玩家的已行动标记
        // 这样其他玩家需要再次行动来跟注或加注
        const betActions = ['bet', 'raise', 'allin'];
        if (betActions.includes(action) && room.currentBet > (room.previousBet || 0)) {
            // 重置其他玩家的已行动标记（当前玩家已记录）
            room.actedThisPhase.clear();
            room.actedThisPhase.add(playerIndex);
        }

        // 计算下一个可以行动的玩家
        let nextPlayer = -1;
        for (let i = 1; i < room.players.length; i++) {
            const idx = (playerIndex + i) % room.players.length;
            if (!room.players[idx].folded && !room.players[idx].allIn) {
                nextPlayer = idx;
                break;
            }
        }

        // 判断一轮是否结束：
        // 1. 所有active玩家下注金额相等
        // 2. 所有active玩家都已行动过（或无法行动）
        const activePlayers = room.players.filter(p => !p.folded && !p.allIn);
        const allMatched = activePlayers.length > 0 && activePlayers.every(p => p.currentBet === room.currentBet);
        const allActed = activePlayers.every(p => room.actedThisPhase.has(room.players.indexOf(p)));

        console.log(`[下注后] 动作:${action} 玩家:${player.name} | nextPlayer:${nextPlayer} | allMatched:${allMatched} | allActed:${allActed} | acted:${[...room.actedThisPhase]}`);
        console.log(`[下注后] room.dealer:${room.dealer}, room.phase:${room.phase}`);

        // 情况1：没有可行动玩家了（都fold或allIn），直接进入下一阶段
        if (nextPlayer === -1) {
            console.log('[下注后] 没有可行动玩家，进入下一阶段');
            advancePhase(room);
        }
        // 情况2：所有active玩家都已行动，且下注金额相等，一轮结束
        else if (allMatched && allActed) {
            console.log('[下注后] 一轮结束，进入下一阶段');
            advancePhase(room);
        } else {
            room.currentPlayer = nextPlayer;
            console.log(`[下注后] 下一个玩家索引:${nextPlayer} (${room.players[nextPlayer].name})`);
            io.to(room.id).emit('gameUpdate', {
                players: room.players.map(p => ({
                    id: p.id,
                    name: p.name,
                    chips: p.chips,
                    currentBet: p.currentBet,
                    folded: p.folded
                })),
                communityCards: room.communityCards,
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

        io.to(room.id).emit('newHost', { hostId: targetPlayerId });
        callback({ success: true });
    });

    // 断开连接
    socket.on('disconnect', (reason) => {
        console.log('=== DISCONNECT ===');
        console.log('socket.id:', socket.id);
        console.log('socket.playerId:', socket.playerId);
        console.log('socket.roomId:', socket.roomId);
        console.log('reason:', reason);
        const room = rooms[socket.roomId];
        if (!room) {
            console.log('房间不存在于 disconnect');
            return;
        }
        console.log('房间:', room.id, '游戏已开始:', room.gameStarted);

        const playerIndex = room.players.findIndex(p => p.id === socket.playerId);
        if (playerIndex === -1) {
            console.log('找不到玩家:', socket.playerId);
            return;
        }

        const player = room.players[playerIndex];
        console.log('离开的玩家:', player.name, '(index:', playerIndex, ')');
        io.to(room.id).emit('playerLeft', { playerId: socket.playerId, playerName: player.name });

        room.players.splice(playerIndex, 1);

        if (room.players.length === 0) {
            delete rooms[socket.roomId];
        } else if (player.isHost) {
            room.players[0].isHost = true;
            io.to(room.id).emit('newHost', { hostId: room.players[0].id });
        }
    });
});

// ============ 启动 ============
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`德州扑克服务器运行在 http://localhost:${PORT}`);
});
