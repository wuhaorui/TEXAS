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

// 游戏配置
const SMALL_BLIND = 10;
const BIG_BLIND = 20;
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 8;

// 房间存储
const rooms = {};

// 扑克牌相关
const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const RANK_VALUES = { '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14 };

// 创建房间
function createRoom(hostId, hostName, initialChips) {
    const roomId = uuidv4().slice(0, 8).toUpperCase();
    rooms[roomId] = {
        id: roomId,
        players: [],
        deck: [],
        communityCards: [],
        pot: 0,
        currentBet: 0,
        phase: 'waiting', // waiting, preflop, flop, turn, river, showdown
        dealer: 0,
        currentPlayer: 0,
        phaseBets: {}, // 每轮下注 { playerId: amount }
        smallBlind: SMALL_BLIND,
        bigBlind: BIG_BLIND,
        initialChips: initialChips, // 房间初始筹码，由房主设置
        gameStarted: false,
        createdAt: Date.now()
    };
    return roomId;
}

// 创建牌组
function createDeck() {
    const deck = [];
    for (const suit of SUITS) {
        for (const rank of RANKS) {
            deck.push({ suit, rank, value: RANK_VALUES[rank] });
        }
    }
    return shuffleDeck(deck);
}

function shuffleDeck(deck) {
    const shuffled = [...deck];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
}

// 洗牌和发牌
function startNewHand(room) {
    room.deck = createDeck();
    room.communityCards = [];
    room.pot = 0;
    room.currentBet = 0;
    room.phaseBets = {};

    // 重置玩家手牌和下注
    room.players.forEach(p => {
        p.hand = [];
        p.currentBet = 0;
        p.folded = false;
        p.allIn = false;
    });

    // 轮流发牌
    for (let i = 0; i < 2; i++) {
        for (let j = 0; j < room.players.length; j++) {
            const playerIndex = (room.dealer + 1 + j) % room.players.length;
            room.players[playerIndex].hand.push(room.deck.pop());
        }
    }

    // 小盲大盲
    const sbPos = (room.dealer + 1) % room.players.length;
    const bbPos = (room.dealer + 2) % room.players.length;

    room.players[sbPos].chips -= room.smallBlind;
    room.players[sbPos].currentBet = room.smallBlind;
    room.pot += room.smallBlind;

    room.players[bbPos].chips -= room.bigBlind;
    room.players[bbPos].currentBet = room.bigBlind;
    room.pot += room.bigBlind;

    room.currentBet = room.bigBlind;
    room.phase = 'preflop';
    room.currentPlayer = (bbPos + 1) % room.players.length;

    room.phaseBets[sbPos] = room.smallBlind;
    room.phaseBets[bbPos] = room.bigBlind;
}

// 发公共牌
function dealCommunityCards(room, count) {
    for (let i = 0; i < count; i++) {
        room.communityCards.push(room.deck.pop());
    }
}

// 判断下注是否完成
function bettingComplete(room) {
    const activePlayers = room.players.filter(p => !p.folded && !p.allIn);
    if (activePlayers.length <= 1) return true;

    const bets = room.players.map(p => p.currentBet);
    const maxBet = Math.max(...bets);
    return bets.every(b => b === maxBet || room.players[bets.indexOf(b)].folded || room.players[bets.indexOf(b)].allIn);
}

// 获取下一个需要行动的玩家
function getNextPlayer(room, fromIndex) {
    let attempts = 0;
    let index = fromIndex;
    while (attempts < room.players.length) {
        index = (index + 1) % room.players.length;
        const player = room.players[index];
        if (!player.folded && !player.allIn && player.chips > 0) {
            return index;
        }
        attempts++;
    }
    return -1;
}

// 评估手牌
function evaluateHand(cards) {
    if (cards.length < 5) return { rank: 0, name: '高牌' };

    const sorted = [...cards].sort((a, b) => b.value - a.value);
    const values = sorted.map(c => c.value);
    const suits = sorted.map(c => c.suit);

    const valueCounts = {};
    values.forEach(v => valueCounts[v] = (valueCounts[v] || 0) + 1);
    const counts = Object.values(valueCounts).sort((a, b) => b - a);

    const isFlush = suits.length === 5 && suits.every(s => s === suits[0]);
    const isStraight = checkStraight(values);

    if (isFlush && values[0] === 14 && values[1] === 13) return { rank: 900, name: '皇家同花顺' };
    if (isFlush && isStraight) return { rank: 800 + values[0], name: '同花顺' };
    if (counts[0] === 4) return { rank: 700 + Object.keys(valueCounts).find(k => valueCounts[k] === 4), name: '四条' };
    if (counts[0] === 3 && counts[1] === 2) return { rank: 600, name: '葫芦' };
    if (isFlush) return { rank: 500 + values[0], name: '同花' };
    if (isStraight) return { rank: 400 + values[0], name: '顺子' };
    if (counts[0] === 3) return { rank: 300, name: '三条' };
    if (counts[0] === 2 && counts[1] === 2) return { rank: 200, name: '两对' };
    if (counts[0] === 2) return { rank: 100 + parseInt(Object.keys(valueCounts).find(k => valueCounts[k] === 2)), name: '一对' };
    return { rank: values[0], name: '高牌' };
}

function checkStraight(values) {
    const unique = [...new Set(values)].sort((a, b) => b - a);
    if (unique.length !== 5) return false;
    if (unique.join(',') === '14,5,4,3,2') return true;
    return unique[0] - unique[4] === 4;
}

// Socket.io 连接处理
io.on('connection', (socket) => {
    console.log('用户连接:', socket.id);
    socket.roomId = null;
    socket.playerId = uuidv4();

    // 创建房间
    socket.on('createRoom', (data, callback) => {
        const { playerName, initialChips } = data;
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

        callback({
            success: true,
            roomId,
            playerId: socket.playerId,
            playerName,
            initialChips: initialChips,
            shareUrl: `${data.baseUrl || ''}?room=${roomId}`
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
            callback({ success: false, error: '游戏已开始，请等待下一局' });
            return;
        }

        // 检查重名
        const existingPlayer = room.players.find(p => p.name === playerName);
        if (existingPlayer) {
            callback({ success: false, error: '该名字已被使用，请换一个名字' });
            return;
        }

        const player = {
            id: socket.playerId,
            socketId: socket.id,
            name: playerName,
            chips: room.initialChips, // 使用房间设定的初始筹码
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

        // 通知房间内其他人
        io.to(roomId).emit('playerJoined', {
            player: { id: player.id, name: player.name, chips: player.chips, ready: player.ready },
            players: room.players.map(p => ({ id: p.id, name: p.name, chips: p.chips, ready: p.ready, isHost: p.isHost }))
        });

        callback({
            success: true,
            playerId: socket.playerId,
            roomId,
            initialChips: room.initialChips,
            players: room.players.map(p => ({ id: p.id, name: p.name, chips: p.chips, isHost: p.isHost })),
            dealer: room.dealer,
            smallBlind: room.smallBlind,
            bigBlind: room.bigBlind
        });
    });

    // 开始游戏
    socket.on('startGame', (data, callback) => {
        console.log('=== startGame ===');
        console.log('socket.id:', socket.id);
        console.log('socket.roomId:', socket.roomId);
        console.log('socket.playerId:', socket.playerId);

        const room = rooms[socket.roomId];
        if (!room) {
            console.log('FAIL: Room not found');
            callback({ success: false, error: '房间不存在' });
            return;
        }

        console.log('Room found, players:', room.players.length);

        const player = room.players.find(p => p.id === socket.playerId);
        console.log('Player found:', player ? player.name : 'null', 'isHost:', player ? player.isHost : 'N/A');

        if (!player || !player.isHost) {
            console.log('FAIL: Not host');
            callback({ success: false, error: '只有房主可以开始游戏' });
            return;
        }

        console.log('Player count check:', room.players.length, '>=', MIN_PLAYERS);
        if (room.players.length < MIN_PLAYERS) {
            console.log('FAIL: Not enough players');
            callback({ success: false, error: `至少需要 ${MIN_PLAYERS} 名玩家，当前 ${room.players.length} 人` });
            return;
        }

        // 检查所有玩家是否已准备
        const notReadyPlayers = room.players.filter(p => !p.ready);
        if (notReadyPlayers.length > 0) {
            console.log('FAIL: Not all players ready');
            callback({ success: false, error: `还有玩家未准备: ${notReadyPlayers.map(p => p.name).join(', ')}` });
            return;
        }

        // 检查所有玩家是否有足够筹码
        for (const p of room.players) {
            console.log('Chip check:', p.name, p.chips, '>=', room.bigBlind * 2);
            if (p.chips < room.bigBlind * 2) {
                console.log('FAIL: Not enough chips');
                callback({ success: false, error: `${p.name} 筹码不足` });
                return;
            }
        }

        console.log('All checks passed, starting game...');
        room.gameStarted = true;
        room.dealer = Math.floor(Math.random() * room.players.length);
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

        console.log('SUCCESS: Game started');
        callback({ success: true });
    });

    // 下注/跟注/加注
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

        const { amount, action } = data; // action: 'call', 'check', 'bet', 'raise', 'allin', 'fold'
        let betAmount = 0;

        if (action === 'fold') {
            room.players[playerIndex].folded = true;
            io.to(room.roomId).emit('playerAction', {
                playerId: socket.playerId,
                action: 'fold'
            });
        } else if (action === 'check') {
            // 过牌
        } else if (action === 'call') {
            const toCall = room.currentBet - room.players[playerIndex].currentBet;
            betAmount = Math.min(toCall, room.players[playerIndex].chips);
            room.players[playerIndex].chips -= betAmount;
            room.players[playerIndex].currentBet += betAmount;
            room.pot += betAmount;
            io.to(room.roomId).emit('playerAction', {
                playerId: socket.playerId,
                action: 'call',
                amount: betAmount
            });
        } else if (action === 'allin') {
            betAmount = room.players[playerIndex].chips;
            room.players[playerIndex].chips = 0;
            room.players[playerIndex].allIn = true;
            room.players[playerIndex].currentBet += betAmount;
            room.pot += betAmount;
            room.currentBet = Math.max(room.currentBet, room.players[playerIndex].currentBet);
            io.to(room.roomId).emit('playerAction', {
                playerId: socket.playerId,
                action: 'allin',
                amount: betAmount
            });
        } else if (action === 'bet' || action === 'raise') {
            const toCall = room.currentBet - room.players[playerIndex].currentBet;
            const minRaise = room.currentBet > 0 ? room.currentBet * 2 : room.bigBlind;
            betAmount = Math.min(amount, room.players[playerIndex].chips);

            if (action === 'raise' && betAmount < minRaise) {
                betAmount = Math.min(minRaise, room.players[playerIndex].chips);
            }

            room.players[playerIndex].chips -= betAmount;
            room.players[playerIndex].currentBet += betAmount;
            room.pot += betAmount;
            room.currentBet = Math.max(room.currentBet, room.players[playerIndex].currentBet);
            io.to(room.roomId).emit('playerAction', {
                playerId: socket.playerId,
                action: action,
                amount: betAmount
            });
        }

        // 检查下注轮是否完成
        if (bettingComplete(room)) {
            advancePhase(room);
        } else {
            room.currentPlayer = getNextPlayer(room, playerIndex);
        }

        io.to(room.roomId).emit('gameUpdate', {
            players: room.players.map(p => ({
                id: p.id,
                name: p.name,
                chips: p.chips,
                hand: p.id === socket.playerId ? p.hand : (p.folded ? [] : undefined),
                currentBet: p.currentBet,
                folded: p.folded,
                allIn: p.allIn
            })),
            communityCards: room.communityCards,
            pot: room.pot,
            currentBet: room.currentBet,
            phase: room.phase,
            currentPlayer: room.currentPlayer
        });

        callback({ success: true });
    });

    // 推进游戏阶段
    function advancePhase(room) {
        const activePlayers = room.players.filter(p => !p.folded);
        if (activePlayers.length <= 1) {
            // 只剩一个玩家，直接获胜
            const winner = activePlayers[0] || room.players.find(p => !p.folded);
            if (winner) {
                winner.chips += room.pot;
                io.to(room.roomId).emit('gameEnd', {
                    winner: { id: winner.id, name: winner.name },
                    hand: null,
                    handName: '对手弃牌',
                    pot: room.pot
                });
            }
            endHand(room);
            return;
        }

        // 重置本轮下注
        room.players.forEach(p => p.currentBet = 0);
        room.currentBet = 0;

        switch (room.phase) {
            case 'preflop':
                room.phase = 'flop';
                dealCommunityCards(room, 3);
                break;
            case 'flop':
                room.phase = 'turn';
                dealCommunityCards(room, 1);
                break;
            case 'turn':
                room.phase = 'river';
                dealCommunityCards(room, 1);
                break;
            case 'river':
                // 摊牌
                showdown(room);
                return;
        }

        // 找到下一个可行动的玩家
        room.currentPlayer = getNextPlayer(room, room.dealer);

        io.to(room.roomId).emit('phaseAdvanced', {
            phase: room.phase,
            communityCards: room.communityCards,
            currentPlayer: room.currentPlayer
        });
    }

    // 摊牌
    function showdown(room) {
        room.phase = 'showdown';

        const activePlayers = room.players.filter(p => !p.folded);
        let bestHand = null;
        let winner = null;

        for (const player of activePlayers) {
            const allCards = [...player.hand, ...room.communityCards];
            const handResult = evaluateBestHand(allCards);
            if (!bestHand || handResult.rank > bestHand.rank) {
                bestHand = handResult;
                winner = player;
            }
        }

        if (winner) {
            winner.chips += room.pot;
            io.to(room.roomId).emit('gameEnd', {
                winner: { id: winner.id, name: winner.name },
                hand: winner.hand,
                handName: bestHand.name,
                pot: room.pot,
                players: room.players.map(p => ({
                    id: p.id,
                    name: p.name,
                    hand: p.hand,
                    handName: evaluateBestHand([...p.hand, ...room.communityCards]).name
                }))
            });
        }

        endHand(room);
    }

    function evaluateBestHand(cards) {
        // 选取5张牌的最佳组合
        let bestRank = 0;
        let bestName = '高牌';

        for (let i = 0; i < cards.length - 4; i++) {
            for (let j = i + 1; j < cards.length - 3; j++) {
                for (let k = j + 1; k < cards.length - 2; k++) {
                    for (let l = k + 1; l < cards.length - 1; l++) {
                        for (let m = l + 1; m < cards.length; m++) {
                            const combo = [cards[i], cards[j], cards[k], cards[l], cards[m]];
                            const result = evaluateHand(combo);
                            if (result.rank > bestRank) {
                                bestRank = result.rank;
                                bestName = result.name;
                            }
                        }
                    }
                }
            }
        }

        return { rank: bestRank, name: bestName };
    }

    // 结束一手牌
    function endHand(room) {
        // 检查是否有人筹码不足
        const hasLoser = room.players.some(p => p.chips < room.bigBlind);

        if (hasLoser || !room.players.some(p => p.chips > room.bigBlind * 2)) {
            // 游戏结束，找到获胜者
            const winner = room.players.reduce((max, p) => p.chips > max.chips ? p : max);
            io.to(room.roomId).emit('gameOver', {
                winner: { id: winner.id, name: winner.name, chips: winner.chips }
            });
            room.gameStarted = false;
        } else {
            // 下一手
            room.dealer = (room.dealer + 1) % room.players.length;
            setTimeout(() => {
                if (room.gameStarted) {
                    startNewHand(room);
                    io.to(room.roomId).emit('newHand', {
                        dealer: room.dealer,
                        players: room.players.map(p => ({
                            id: p.id,
                            name: p.name,
                            chips: p.chips,
                            hand: p.hand,
                            currentBet: 0,
                            folded: false,
                            allIn: false
                        })),
                        communityCards: [],
                        pot: 0,
                        currentBet: 0,
                        phase: 'preflop',
                        smallBlind: room.smallBlind,
                        bigBlind: room.bigBlind
                    });
                }
            }, 3000);
        }
    }

    // 断开连接
    socket.on('disconnect', () => {
        console.log('用户断开:', socket.id);
        const room = rooms[socket.roomId];
        if (room) {
            const playerIndex = room.players.findIndex(p => p.id === socket.playerId);
            if (playerIndex !== -1) {
                const player = room.players[playerIndex];
                io.to(room.roomId).emit('playerLeft', {
                    playerId: socket.playerId,
                    playerName: player.name
                });

                // 如果是游戏中有人离开
                if (room.gameStarted && !player.folded) {
                    player.folded = true;
                    // 检查是否只剩一个玩家
                    const activePlayers = room.players.filter(p => !p.folded);
                    if (activePlayers.length <= 1) {
                        const winner = activePlayers[0] || room.players.find(p => !p.folded);
                        if (winner) {
                            winner.chips += room.pot;
                            io.to(room.roomId).emit('gameEnd', {
                                winner: { id: winner.id, name: winner.name },
                                hand: null,
                                handName: '对手离开',
                                pot: room.pot
                            });
                        }
                        room.gameStarted = false;
                    }
                }

                // 移除玩家
                room.players.splice(playerIndex, 1);

                // 如果房间空了，删除
                if (room.players.length === 0) {
                    delete rooms[socket.roomId];
                } else if (player.isHost) {
                    // 转让房主
                    room.players[0].isHost = true;
                    io.to(room.roomId).emit('newHost', { hostId: room.players[0].id });
                }
            }
        }
    });

    // 转让房主
    socket.on('transferHost', (data, callback) => {
        const room = rooms[socket.roomId];
        if (!room) {
            callback({ success: false, error: '房间不存在' });
            return;
        }

        const currentPlayer = room.players.find(p => p.id === socket.playerId);
        if (!currentPlayer || !currentPlayer.isHost) {
            callback({ success: false, error: '只有房主可以转让' });
            return;
        }

        const { targetPlayerId } = data;
        const targetPlayer = room.players.find(p => p.id === targetPlayerId);
        if (!targetPlayer) {
            callback({ success: false, error: '目标玩家不存在' });
            return;
        }

        currentPlayer.isHost = false;
        targetPlayer.isHost = true;

        io.to(room.roomId).emit('newHost', { hostId: targetPlayerId });
        callback({ success: true });
    });

    // 玩家准备/取消准备
    socket.on('playerReady', (data, callback) => {
        const room = rooms[socket.roomId];
        if (!room) {
            callback({ success: false, error: '房间不存在' });
            return;
        }

        const player = room.players.find(p => p.id === socket.playerId);
        if (!player) {
            callback({ success: false, error: '玩家不存在' });
            return;
        }

        // 游戏已开始后不能取消准备
        if (room.gameStarted) {
            callback({ success: false, error: '游戏已开始' });
            return;
        }

        player.ready = !player.ready; // 切换准备状态

        io.to(room.roomId).emit('playerReadyUpdate', {
            players: room.players.map(p => ({ id: p.id, name: p.name, chips: p.chips, ready: p.ready, isHost: p.isHost }))
        });

        callback({ success: true, ready: player.ready });
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`德州扑克服务器运行在 http://localhost:${PORT}`);
});