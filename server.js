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

// 断线后多久真正把玩家移出房间（默认 60 秒，给移动端切后台重连留窗口）。
// 端到端测试可用环境变量 DISCONNECT_TIMEOUT_MS 调短，生产环境不要设置。
const DISCONNECT_TIMEOUT_MS = (() => {
    const v = Number(process.env.DISCONNECT_TIMEOUT_MS);
    return Number.isFinite(v) && v >= 0 ? v : 60000;
})();

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

const VALUE_NAMES = { 2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: '10', 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };

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

    // 同花顺：必须是「同花花色」内部形成的顺子，不能因跨花色出现顺子而误判。
    // 先只在 flush 花色的牌里找顺子，成立才判同花顺，否则落到下面的普通同花分支。
    let isStraightFlush = false;
    let sfHigh = 0;
    let isWheelFlush = false;
    if (flushSuit) {
        const fv = flushValues;
        for (let i = 0; i <= fv.length - 5; i++) {
            if (fv[i] - fv[i + 4] === 4) { sfHigh = fv[i]; break; }
        }
        isWheelFlush = !sfHigh && fv.includes(5) && fv.includes(4)
            && fv.includes(3) && fv.includes(2) && fv.includes(14);
        isStraightFlush = sfHigh > 0 || isWheelFlush;
    }

    if (isStraightFlush) {
        const isRoyal = sfHigh === 14;
        handName = isRoyal ? '皇家同花顺' : '同花顺';
        handRank = HAND_RANKS[handName];
        tieBreaker = isWheelFlush ? 5 : sfHigh;
        bestValues = isWheelFlush ? [5, 4, 3, 2, 1] : [sfHigh, sfHigh - 1, sfHigh - 2, sfHigh - 3, sfHigh - 4];
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
        handName = '两对' + VALUE_NAMES[parseInt(v1)] + VALUE_NAMES[parseInt(v2)];
        handRank = HAND_RANKS['两对'];
        tieBreaker = parseInt(v1); // v1 是高对（排序时值大的在前）
        const kick = values.find(v => v !== parseInt(v1) && v !== parseInt(v2));
        bestValues = [parseInt(v1), parseInt(v1), parseInt(v2), parseInt(v2), kick || 0];
    } else if (c1 === 2) {
        handName = '一对' + VALUE_NAMES[parseInt(v1)];
        handRank = HAND_RANKS['一对'];
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

    // --- 边池分配 ---
    // 所有玩家（含弃牌者）的贡献层级都需计入，弃牌者贡献的钱任何人可赢
    const allContribs = [...new Set(players.map(p => p.totalPotBet || 0).filter(c => c > 0).sort((a, b) => a - b))];
    const winners = [];
    let prevLevel = 0;

    for (const level of allContribs) {
        if (level <= prevLevel) continue;
        const increment = level - prevLevel;

        // 找出投入了此层级的活跃玩家
        const eligible = results.filter(r => (r.player.totalPotBet || 0) >= level);
        // 计算所有玩家（含弃牌者）中投入此层级的数量
        const allInLevel = players.filter(p => (p.totalPotBet || 0) >= level).length;
        if (eligible.length === 0) {
            // 弃牌者独占此层级，钱归下层级赢家（算入 pot 但无人认领）
            // 这种情况不分配，留给下面层级
            prevLevel = level;
            continue;
        }

        const best = eligible[0];
        const tied = eligible.filter(r =>
            r.handRank === best.handRank &&
            r.tieBreaker === best.tieBreaker &&
            JSON.stringify(r.values) === JSON.stringify(best.values)
        );

        // 子池大小 = increment * 所有投入此层级的玩家数
        const share = Math.floor(increment * allInLevel / tied.length);
        tied.forEach(r => {
            if (!winners.includes(r.player)) winners.push(r.player);
            r.player._sideWin = (r.player._sideWin || 0) + share;
        });

        prevLevel = level;
    }

    // 应用边池分配
    winners.forEach(p => {
        const win = p._sideWin || 0;
        p.chips += win;
        delete p._sideWin;
    });

    // 检查是否有 tied for first overall
    const allWinners = [];
    for (let i = 0; i < results.length; i++) {
        if (i === 0) {
            allWinners.push(results[i].player);
        } else if (results[i].handRank === results[0].handRank &&
                   results[i].tieBreaker === results[0].tieBreaker &&
                   JSON.stringify(results[i].values) === JSON.stringify(results[0].values)) {
            allWinners.push(results[i].player);
        } else {
            break;
        }
    }

    return { winners: allWinners, handName: results[0].handName, results };
}

// ============ 下注合法性校验（纯函数，不修改任何状态） ============
/**
 * 统一校验一次下注动作是否合法，并把它归一化成可安全执行的结果。
 *
 * 关于 amount 的语义：前端传的是「本次要额外投入的筹码」（增量），
 * 而不是「加注到的总注额」。所以：
 *   加注后的总注额 target = player.currentBet + amount
 *   合法加注要求       target >= room.currentBet + room.minRaise
 *
 * @param {object} room   房间对象
 * @param {object} player 行动玩家对象
 * @param {string} action fold | check | call | bet | raise | allin
 * @param {number} amount 增量下注额（bet / raise 时使用）
 *
 * @returns {{
 *   valid: boolean,
 *   error?: string,
 *   normalizedAmount?: number,   // 本次实际从 player.chips 扣掉的筹码（恒 >= 0）
 *   action?: string,             // 归一化后的动作（call 可能变成 check / allin）
 *   newPlayerBet?: number,       // 执行后 player.currentBet
 *   newCurrentBet?: number,      // 执行后 room.currentBet
 *   newMinRaise?: number,        // 执行后 room.minRaise
 *   allIn?: boolean,             // 玩家是否因此 all-in
 *   reopens?: boolean            // 是否是一次「完整加注」，需要重新开放本轮下注
 * }}
 */
function validateBetAction(room, player, action, amount) {
    const safeChips = Math.max(0, Number.isFinite(player.chips) ? player.chips : 0);
    const playerBet = Math.max(0, Number.isFinite(player.currentBet) ? player.currentBet : 0);
    const tableBet = Math.max(0, Number.isFinite(room.currentBet) ? room.currentBet : 0);
    const minRaise = Math.max(0, Number.isFinite(room.minRaise) ? room.minRaise : 0);

    const toCall = tableBet - playerBet;        // 补多少才能跟平（可能 <= 0）
    const minTarget = tableBet + minRaise;      // 合法加注后的最低「总注额」
    const maxTarget = playerBet + safeChips;    // 打光全部筹码能到的总注额

    const base = { action, toCall, minTarget, maxTarget, allIn: false, reopens: false };

    if (!action) return { ...base, valid: false, error: '未知操作' };

    // 牌局未开始或已结束（摊牌展示期）：任何下注动作都不合法，
    // 否则在结算后的 3~8 秒展示窗口里收到的动作会污染下一局的状态。
    if (room.phase === 'waiting' || room.phase === 'showdown') {
        return { ...base, valid: false, error: '本局已结束，请等待下一局开始' };
    }

    switch (action) {
        // ---------- 弃牌：永远合法 ----------
        case 'fold':
            return { ...base, valid: true, normalizedAmount: 0 };

        // ---------- 过牌：只有在无人领先时才合法 ----------
        case 'check':
            if (toCall > 0) {
                // 筹码不够跟平时提示实际能跟的数额
                const affordable = Math.min(toCall, safeChips);
                return {
                    ...base, valid: false,
                    error: `当前有下注，不能过牌（需跟注 ${affordable}${affordable < toCall ? '，筹码不足将全下' : ''}）`
                };
            }
            return { ...base, valid: true, normalizedAmount: 0 };

        // ---------- 跟注：可能为 check / 正常跟注 / 全下 ----------
        case 'call': {
            // 无需补码（含 BB 未被人加注时的「过牌」选项）→ 归一化为过牌，不动筹码
            if (toCall <= 0) {
                return { ...base, valid: true, action: 'check', normalizedAmount: 0, newPlayerBet: playerBet };
            }
            const pay = Math.max(0, Math.min(toCall, safeChips)); // 恒 >= 0，杜绝负数
            const isAllIn = pay >= safeChips;
            return {
                ...base,
                valid: true,
                action: isAllIn ? 'allin' : 'call',
                normalizedAmount: pay,
                newPlayerBet: playerBet + pay,
                // 跟注不会抬高当前注额，minRaise 也不变
                newCurrentBet: Math.max(tableBet, playerBet + pay),
                newMinRaise: minRaise,
                allIn: isAllIn,
                reopens: false
            };
        }

        // ---------- 下注 / 加注 ----------
        case 'bet':
        case 'raise': {
            const raw = Number(amount);
            if (!Number.isFinite(raw) || Math.floor(raw) <= 0) {
                return { ...base, valid: false, error: '下注金额必须是大于 0 的整数' };
            }
            if (safeChips <= 0) {
                return { ...base, valid: false, error: '没有筹码可以下注' };
            }

            const requestedTarget = playerBet + Math.floor(raw);
            // 想下的超过身家 → 截断成 all-in（而不是拒绝）
            const target = Math.min(requestedTarget, maxTarget);
            const isAllIn = requestedTarget >= maxTarget;
            const isFullRaise = target >= minTarget;

            // 既达不到最小加注额，又不是 all-in → 明确拒绝并给出最小加注目标
            if (!isFullRaise && !isAllIn) {
                return {
                    ...base, valid: false,
                    error: `最小加注到 ${minTarget}（当前注额 ${tableBet}，最小加注增量 ${minRaise}）`
                };
            }
            // 短码 all-in（投入全部筹码仍达不到 minTarget）：允许，但不重新开放下注

            const pay = Math.max(0, target - playerBet);
            const newCurrentBet = Math.max(tableBet, target); // 只允许抬高，绝不调低
            return {
                ...base,
                valid: true,
                action: isAllIn ? 'allin' : action,
                normalizedAmount: pay,
                newPlayerBet: target,
                newCurrentBet,
                // 完整加注才更新 minRaise = 加注后注额 - 加注前注额
                newMinRaise: isFullRaise ? Math.max(minRaise, newCurrentBet - tableBet) : minRaise,
                allIn: isAllIn,
                reopens: isFullRaise
            };
        }

        // ---------- 全下：永远合法 ----------
        case 'allin': {
            if (safeChips <= 0) {
                return { ...base, valid: false, error: '没有筹码可以下注' };
            }
            const target = maxTarget;
            const isFullRaise = target >= minTarget;
            const newCurrentBet = Math.max(tableBet, target);
            return {
                ...base,
                valid: true,
                normalizedAmount: safeChips,
                newPlayerBet: target,
                newCurrentBet,
                newMinRaise: isFullRaise ? Math.max(minRaise, newCurrentBet - tableBet) : minRaise,
                allIn: true,
                reopens: isFullRaise
            };
        }

        default:
            return { ...base, valid: false, error: `未知操作: ${action}` };
    }
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

// 跳过断线的当前行动玩家：如果当前行动玩家断线了，自动fold并前进
function skipDisconnectedCurrent(room) {
    const cp = room.players[room.currentPlayer];
    if (!cp || !cp.disconnected) return;
    if (room.phase === 'waiting' || room.phase === 'showdown') return;
    console.log('[skipDisconnected] 当前玩家', cp.name, '已断线，自动弃牌跳过');
    cp.folded = true;
    room.actedThisPhase.add(room.currentPlayer);

    let nextPlayer = -1;
    for (let i = 1; i < room.players.length; i++) {
        const idx = (room.currentPlayer + i) % room.players.length;
        if (!room.players[idx].folded && !room.players[idx].allIn && !room.players[idx].isSpectator && !room.players[idx].disconnected) {
            nextPlayer = idx;
            break;
        }
    }

    const nonFolded = room.players.filter(p => !p.folded && !p.isSpectator && !p.disconnected);
    if (nonFolded.length === 1) {
        const winner = nonFolded[0];
        const wonPot = room.pot;
        winner.chips += wonPot;
        room.pot = 0;
        room.phase = 'showdown';
        io.to(room.id).emit('gameEnd', {
            players: playerListEx(room, ['hand']),
            communityCards: room.communityCards, pot: wonPot,
            winners: [winner.id], handName: '对手断线弃牌',
            results: nonFolded.map(p => ({ playerId: p.id, handName: '对手断线弃牌', handRank: 0 })),
            dealer: room.dealer
        });
        setTimeout(() => {
            handleRebuy(room);
            const ep = room.players.filter(p => p.chips >= room.bigBlind && !p.isSpectator && !p.disconnected);
            if (ep.length >= 2) { startNewHand(room); io.to(room.id).emit('gameStarted', { players: playerListEx(room, ['hand']), dealer: room.dealer, phase: room.phase, currentPlayer: room.currentPlayer, pot: room.pot, currentBet: room.currentBet, minRaise: room.minRaise, smallBlind: room.smallBlind, bigBlind: room.bigBlind }); }
        }, 3000);
    } else if (nextPlayer === -1) {
        advancePhase(room);
    } else {
        room.currentPlayer = nextPlayer;
        io.to(room.id).emit('gameUpdate', {
            players: playerList(room),
            communityCards: room.communityCards, pot: room.pot,
            currentBet: room.currentBet, minRaise: room.minRaise, currentPlayer: room.currentPlayer,
            phase: room.phase, dealer: room.dealer
        });
    }
}

function serializePlayer(p, extras) {
    const obj = {
        id: p.id,
        name: p.name,
        chips: p.chips,
        currentBet: p.currentBet,
        folded: p.folded,
        allIn: p.allIn,
        isHost: p.isHost,
        ready: p.ready,
        isSpectator: p.isSpectator || false,
        rebuyCount: p.rebuyCount || 0,
        disconnected: p.disconnected || false
    };
    if (extras) Object.assign(obj, extras);
    return obj;
}

function playerList(room) { return room.players.map(p => serializePlayer(p)); }
function playerListEx(room, fields) { return room.players.map(p => serializePlayer(p, fields.reduce((a, f) => { if (p[f] !== undefined && !(f === 'hand' && p.folded)) a[f] = p[f]; return a; }, {}))); }

// allIn 输掉的玩家自动 rebuy（借2000筹码，名字后加借次数标记）
function handleRebuy(room) {
    room.players.forEach(p => {
        if (p.allIn && p.chips < room.bigBlind && !p.folded && !p.isSpectator) {
            p.chips += 2000;
            p.rebuyCount = (p.rebuyCount || 0) + 1;
            console.log(`[Rebuy] ${p.name} allIn 输光，自动补2000筹码（第${p.rebuyCount}次）`);
        }
        // 重置 rebuy 相关状态由 startNewHand 处理
    });
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
        createdAt: Date.now(),
        // ---- 下注规则状态 ----
        // minRaise: 当前最小加注「增量」（不是总注额）。startNewHand 时重置为 bigBlind。
        minRaise: BIG_BLIND,
        // lastRaiseIndex: 最后一次「完整加注」的玩家索引，用于判断一轮下注是否结束
        lastRaiseIndex: -1
    };
    return roomId;
}

function startNewHand(room) {
    // allIn 输光的玩家自动补充筹码
    handleRebuy(room);

    room.deck = createDeck();
    room.communityCards = [];
    room.pot = 0;
    room.currentBet = 0;
    room.phaseBets = {};
    // 重置本局下注规则：最小加注增量 = 大盲，尚无人加注
    room.minRaise = room.bigBlind;
    room.lastRaiseIndex = -1;
    room.previousBet = 0;

    // 将观战者升级为正式玩家（发筹码）
    room.players.forEach(p => {
        if (p.isSpectator) {
            p.isSpectator = false;
            p.chips = room.initialChips;
        }
    });

    room.players.forEach(p => {
        p.hand = [];
        p.currentBet = 0;
        p.totalPotBet = 0;
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

    // 收盲注：短码玩家最多只能投入全部筹码，底池按实际投入累加（保证筹码守恒、非负）
    const sbPlayer = room.players[sbIndex];
    const bbPlayer = room.players[bbIndex];
    const sbPut = Math.min(room.smallBlind, Math.max(0, sbPlayer.chips));
    const bbPut = Math.min(room.bigBlind, Math.max(0, bbPlayer.chips));
    sbPlayer.chips = Math.max(0, sbPlayer.chips - sbPut);
    sbPlayer.currentBet = sbPut;
    if (sbPlayer.chips === 0) sbPlayer.allIn = true;
    bbPlayer.chips = Math.max(0, bbPlayer.chips - bbPut);
    bbPlayer.currentBet = bbPut;
    if (bbPlayer.chips === 0) bbPlayer.allIn = true;

    room.pot = sbPut + bbPut;
    room.currentBet = Math.max(0, bbPut);
    room.currentPlayer = (bbIndex + 1) % room.players.length;
    room.phase = 'preflop';
    room.actedThisPhase = new Set(); // 重置本阶段已行动玩家
}

// 进入下一阶段
function advancePhase(room) {
    // 如果只剩一个未弃牌玩家，跳过所有阶段直接判胜（安全网）
    const nonFolded = room.players.filter(p => !p.folded && !p.isSpectator && !p.disconnected);
    if (nonFolded.length === 1) {
        console.log('[advancePhase] 只剩一人未弃牌，直接判胜');
        const winner = nonFolded[0];
        const wonPot = room.pot;
        winner.chips += wonPot;
        room.pot = 0;
        room.phase = 'showdown';
        io.to(room.id).emit('gameEnd', {
            players: playerListEx(room, ['hand']),
            communityCards: room.communityCards,
            pot: wonPot,
            winners: [winner.id],
            handName: '对手全弃牌',
            results: room.players
                .filter(p => !p.folded)
                .map(p => ({
                    playerId: p.id,
                    handName: '对手全弃牌',
                    handRank: 0
                })),
            dealer: room.dealer
        });

        setTimeout(() => {
            handleRebuy(room);
            const eligiblePlayers = room.players.filter(p => p.chips >= room.bigBlind && !p.isSpectator && !p.disconnected);
            if (eligiblePlayers.length >= 2) {
                startNewHand(room);
                io.to(room.id).emit('gameStarted', {
                    players: playerListEx(room, ['hand']),
                    dealer: room.dealer,
                    phase: room.phase,
                    currentPlayer: room.currentPlayer,
                    pot: room.pot,
                    currentBet: room.currentBet, minRaise: room.minRaise,
                    smallBlind: room.smallBlind,
                    bigBlind: room.bigBlind
                });
            }
        }, 3000);
        return;
    }

    // 所有非弃牌玩家都 allIn → 快进到摊牌，一次性发完所有公共牌
    if (nonFolded.length >= 2 && nonFolded.every(p => p.allIn)) {
        console.log('[advancePhase] 所有玩家 allIn，快进到摊牌');
        // 先把当前轮的 currentBet 计入 totalPotBet
        room.players.forEach(p => p.totalPotBet = (p.totalPotBet || 0) + p.currentBet);
        room.currentBet = 0;
        room.players.forEach(p => p.currentBet = 0);
        room.actedThisPhase = new Set();

        if (room.phase === 'preflop') for (let i = 0; i < 5; i++) room.communityCards.push(room.deck.pop());
        else if (room.phase === 'flop') { room.communityCards.push(room.deck.pop()); room.communityCards.push(room.deck.pop()); }
        else if (room.phase === 'turn') room.communityCards.push(room.deck.pop());
        room.phase = 'showdown';

        // 第一步：先发 gameUpdate 亮出所有公共牌
        io.to(room.id).emit('gameUpdate', {
            players: playerList(room),
            communityCards: room.communityCards,
            pot: room.pot,
            currentBet: room.currentBet, minRaise: room.minRaise,
            currentPlayer: room.currentPlayer,
            phase: room.phase,
            dealer: room.dealer
        });

        // 第二步：延迟 5 秒后发 gameEnd 显示结果
        setTimeout(() => {
            const wonPot = room.pot;
            room.pot = 0;
            const { winners, handName, results } = getWinners(room.players, room.communityCards);

            io.to(room.id).emit('gameEnd', {
                players: playerListEx(room, ['hand']),
                communityCards: room.communityCards, pot: wonPot,
                winners: winners.map(w => w.id), handName,
                results: results.map(r => ({ playerId: r.player.id, handName: r.handName, handRank: r.handRank })),
                dealer: room.dealer
            });
        }, 5000);

        // 第三步：8 秒后开始新一局
        setTimeout(() => {
            // 先补充 allIn 输家筹码，再检查人数
            handleRebuy(room);
            const ep = room.players.filter(p => p.chips >= room.bigBlind && !p.isSpectator && !p.disconnected);
            if (ep.length >= 2) {
                startNewHand(room);
                io.to(room.id).emit('gameStarted', { players: playerListEx(room, ['hand']), dealer: room.dealer, phase: room.phase, currentPlayer: room.currentPlayer, pot: room.pot, currentBet: room.currentBet, minRaise: room.minRaise, smallBlind: room.smallBlind, bigBlind: room.bigBlind });
            }
        }, 8000);
        return;
    }

    // 重置本轮下注（先累计到总下注池）
    room.players.forEach(p => p.totalPotBet = (p.totalPotBet || 0) + p.currentBet);
    room.currentBet = 0;
    // 新的一轮下注：最小加注增量回到大盲，尚无人加注
    room.minRaise = room.bigBlind;
    room.lastRaiseIndex = -1;
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

        const wonPot = room.pot;
        room.pot = 0;
        // 评估手牌并分配奖池（含边池逻辑）
        const { winners, handName, results } = getWinners(room.players, room.communityCards);

        // 先发 gameUpdate 亮出所有公共牌和 phase=showdown
        io.to(room.id).emit('gameUpdate', {
            players: playerListEx(room, ['hand']),
            communityCards: room.communityCards,
            pot: wonPot,
            currentBet: room.currentBet, minRaise: room.minRaise,
            currentPlayer: room.currentPlayer,
            phase: room.phase,
            dealer: room.dealer
        });

        // 5 秒后宣布结果（同时亮出所有未弃牌玩家手牌）
        setTimeout(() => {
            io.to(room.id).emit('gameEnd', {
                players: playerListEx(room, ['hand']),
                communityCards: room.communityCards,
                pot: wonPot,
                winners: winners.map(w => w.id),
                handName,
                results: results.map(r => ({
                    playerId: r.player.id,
                    handName: r.handName,
                    handRank: r.handRank
                })),
                dealer: room.dealer
            });
        }, 5000);

        // 8 秒后自动开始下一局
        setTimeout(() => {
            handleRebuy(room);
            const eligiblePlayers = room.players.filter(p => p.chips >= room.bigBlind && !p.isSpectator && !p.disconnected);
            if (eligiblePlayers.length >= 2) {
                startNewHand(room);
                io.to(room.id).emit('gameStarted', {
                    players: playerListEx(room, ['hand']),
                    dealer: room.dealer,
                    phase: room.phase,
                    currentPlayer: room.currentPlayer,
                    pot: room.pot,
                    currentBet: room.currentBet, minRaise: room.minRaise,
                    smallBlind: room.smallBlind,
                    bigBlind: room.bigBlind
                });
            }
        }, 8000);

        return;
    }

    // 设置本阶段第一个行动的玩家（dealer下一位）
    room.currentPlayer = (room.dealer + 1) % room.players.length;
    while (room.players[room.currentPlayer].folded || room.players[room.currentPlayer].allIn || room.players[room.currentPlayer].isSpectator || room.players[room.currentPlayer].disconnected) {
        room.currentPlayer = (room.currentPlayer + 1) % room.players.length;
    }

    // 保险：如果新 currentPlayer 此时刚断线，再检查一次
    skipDisconnectedCurrent(room);

    io.to(room.id).emit('gameUpdate', {
        players: playerList(room),
        communityCards: room.communityCards,
        pot: room.pot,
        currentBet: room.currentBet, minRaise: room.minRaise,
        currentPlayer: room.currentPlayer,
        phase: room.phase,
        dealer: room.dealer  // 添加 dealer 字段，前端用于显示位置标识
    });
}

// ============ 玩家移除：全文件唯一的 splice 出口 ============
//
// TODO(中期重构): 把 room.currentPlayer / room.dealer / room.actedThisPhase /
// room.lastRaiseIndex 从「数组下标」改成「玩家 id」（string / Set<playerId>），
// 从根本上消除 splice 造成的下标错位。届时下面这一整套重映射逻辑可以整体删除，
// 移除玩家时只需丢弃对应 id 即可。
//
// 在此之前：**任何地方都不要直接 splice room.players**，必须调用 removePlayerFromRoom()。

// 从 from 开始向后找下一个「可行动」玩家（未弃牌、未 all-in、未观战、未断线）。
// inclusive=false（默认）：跳过 from 本身，用于「把行动权交给下一位」。
// inclusive=true：from 本身也算候选，用于「被删玩家腾出的位置由谁顶上」。
// from 会先对数组长度取模，所以传入刚被删掉的旧下标也不会漏掉回绕到 0 的那一位。
function nextActionableIndex(room, from, inclusive = false) {
    const n = room.players.length;
    if (n === 0) return -1;
    const start = ((from % n) + n) % n;
    for (let i = (inclusive ? 0 : 1); i < n; i++) {
        const idx = (start + i) % n;
        const p = room.players[idx];
        if (p && !p.folded && !p.allIn && !p.isSpectator && !p.disconnected) return idx;
    }
    return -1;
}

// 玩家被 splice 出 room.players **之后**，把所有「数组下标」状态重映射到新数组：
//   - 旧下标 > removedIndex：整体前移一位（-1）
//   - 旧下标 === removedIndex：按语义重新定位（不能简单丢弃，也不能靠 -1 蒙混）
//   - 旧下标 < removedIndex：不变
function remapStateAfterPlayerRemoval(room, removedIndex, successorIndex = -1) {
    const n = room.players.length; // 移除「后」的长度
    const shift = idx => (idx > removedIndex ? idx - 1 : idx);

    // ---- currentPlayer：行动权 ----
    // 只有「被删者本人就是当前行动者」才需要重新定位；其余情况一律按位移处理
    // （currentPlayer > removedIndex → -1，否则不变）。越界的脏下标交给
    // 后面的 normalizeRoomIndices() 取模兜底，不要在这里抢着重定位，
    // 否则会把「被删者排在行动者前面」这种最常见的场景误判成移交行动权。
    if (room.currentPlayer === removedIndex) {
        // 被删者正是当前行动者：交给调用方在旧数组里算好的继承者（也要 -1 位移）
        let next = successorIndex >= 0 ? shift(successorIndex) : -1;
        // 兜底：没算出来就在新数组里从被删位置（含）重新找一遍
        if (next < 0 || next >= n) next = nextActionableIndex(room, removedIndex, true);
        room.currentPlayer = next >= 0 ? next : (n > 0 ? 0 : -1);
    } else {
        room.currentPlayer = shift(room.currentPlayer);
    }

    // ---- dealer：庄家 ----
    // 被删者就是庄家时，庄家顺延到前一个位置，保持其余玩家的相对顺序不变，
    // 这样下一局 startNewHand() 里的 (dealer + 1) % n 轮转不会被打乱。
    if (room.dealer === removedIndex) {
        room.dealer = n > 0 ? (removedIndex - 1 + n) % n : 0;
    } else {
        room.dealer = shift(room.dealer);
    }

    // ---- lastRaiseIndex：最后一个完整加注者 ----
    if (room.lastRaiseIndex === removedIndex) {
        room.lastRaiseIndex = -1;
    } else if (room.lastRaiseIndex >= 0) {
        const s = shift(room.lastRaiseIndex);
        room.lastRaiseIndex = (s >= 0 && s < n) ? s : -1;
    }

    // ---- actedThisPhase（Set<下标>）：整体重建，丢弃被删者 + 越界脏数据 ----
    const oldSet = (room.actedThisPhase instanceof Set) ? room.actedThisPhase : new Set();
    const newSet = new Set();
    for (const idx of oldSet) {
        if (idx === removedIndex) continue;
        const s = shift(idx);
        if (s >= 0 && s < n) newSet.add(s);
    }
    room.actedThisPhase = newSet;
}

// 一致性兜底：currentPlayer / dealer 必须落在 [0, players.length - 1]，越界对 length 取模
function normalizeRoomIndices(room) {
    const n = room.players.length;
    const wrap = (v, fallback) => {
        const num = Number(v);
        if (!Number.isFinite(num) || n === 0) return fallback;
        return ((Math.trunc(num) % n) + n) % n;
    };
    room.currentPlayer = n === 0 ? -1 : wrap(room.currentPlayer, 0);
    room.dealer = wrap(room.dealer, 0);
    if (!Number.isFinite(room.lastRaiseIndex) || room.lastRaiseIndex >= n) room.lastRaiseIndex = -1;
    if (!(room.actedThisPhase instanceof Set)) room.actedThisPhase = new Set();
}

/**
 * 从房间里永久移除一个玩家 —— 全文件唯一允许 splice room.players 的地方。
 * 负责：断线定时器清理 → 行动权/庄家/已行动集合下标重映射 → 一致性兜底 →
 * 房主转让 → 人数不足回到 waiting → 广播完整状态。
 *
 * @param {object} room        房间对象
 * @param {number} playerIndex 待移除玩家在 room.players 中的下标
 * @returns {object|null}      被移除的玩家对象；未移除返回 null
 */
function removePlayerFromRoom(room, playerIndex) {
    if (!room || !Array.isArray(room.players)) return null;
    if (!Number.isInteger(playerIndex) || playerIndex < 0 || playerIndex >= room.players.length) return null;

    const removed = room.players[playerIndex];
    if (!removed) return null;

    // 0) 清掉挂在玩家身上的断线移除定时器，防止重复移除
    if (removed._disconnectTimer) {
        clearTimeout(removed._disconnectTimer);
        removed._disconnectTimer = null;
    }

    const wasHost = !!removed.isHost;
    const wasCurrentActor = room.currentPlayer === playerIndex;

    // 1) 移除「前」先在旧数组坐标系里算好行动权继承者：
    //    splice 之后数组变短，再去找就会漏掉回绕到下标 0 的那一位。
    const successorIndex = wasCurrentActor ? nextActionableIndex(room, playerIndex) : -1;

    console.log(`[移除玩家] ${removed.name} (旧下标 ${playerIndex}) 房间 ${room.id} | ` +
        `是当前行动者:${wasCurrentActor} 继承者(旧下标):${successorIndex} | ` +
        `人数 ${room.players.length}→${room.players.length - 1}`);

    // 2) 执行移除（唯一一处 splice）
    room.players.splice(playerIndex, 1);

    // 3) 重映射所有下标类状态
    remapStateAfterPlayerRemoval(room, playerIndex, successorIndex);

    // 4) 一致性兜底
    normalizeRoomIndices(room);

    // 5) 被删者是当前行动者且无人接手（其余人全弃牌/全下/断线）→ 推进阶段，避免死锁
    if (wasCurrentActor && successorIndex === -1 &&
        room.gameStarted && room.phase !== 'waiting' && room.phase !== 'showdown') {
        console.log('[移除玩家] 当前行动者被移除且无人接手，推进阶段');
        advancePhase(room);
    }

    // 6) 房主转让（游戏进行中也可能转让，不能只在 !gameStarted 时处理）
    if (wasHost) {
        const newHost = room.players.find(p => !p.isSpectator && !p.disconnected) || room.players[0];
        if (newHost) {
            newHost.isHost = true;
            io.to(room.id).emit('newHost', { hostId: newHost.id });
            console.log(`[移除玩家] 房主转让给 ${newHost.name}`);
        }
    }

    // 7) 人数不足：结束当前手牌，回到 waiting
    let notice = null;
    if (room.players.length < 2) {
        // 剩余底池归最后一位玩家，避免筹码凭空消失
        if (room.pot > 0 && room.players.length === 1) {
            room.players[0].chips += room.pot;
            console.log(`[移除玩家] 底池 ${room.pot} 归 ${room.players[0].name}`);
        }
        room.pot = 0;
        room.currentBet = 0;
        room.minRaise = room.bigBlind;
        room.lastRaiseIndex = -1;
        room.communityCards = [];
        room.actedThisPhase = new Set();
        room.phase = 'waiting';
        room.gameStarted = false;
        room.players.forEach(p => {
            p.hand = [];
            p.currentBet = 0;
            p.totalPotBet = 0;
            p.folded = false;
            p.allIn = false;
            p.ready = false;
        });
        normalizeRoomIndices(room);
        notice = '人数不足，等待新玩家';
    }

    // 8) 广播完整状态，避免前端停留在旧座位布局
    io.to(room.id).emit('playerJoined', { players: playerList(room) });
    io.to(room.id).emit('playerRemoved', {
        playerId: removed.id,
        playerName: removed.name,
        dealer: room.dealer,
        currentPlayer: room.currentPlayer,
        message: notice
    });
    if (notice) {
        io.to(room.id).emit('chatMessage', { name: '系统', text: notice });
        console.log(`[移除玩家] 房间 ${room.id}：${notice}`);
    }

    if (room.gameStarted && room.phase !== 'waiting') {
        io.to(room.id).emit('gameStarted', {
            dealer: room.dealer,
            players: playerListEx(room, ['hand']),
            communityCards: room.communityCards,
            pot: room.pot,
            currentBet: room.currentBet, minRaise: room.minRaise,
            phase: room.phase,
            currentPlayer: room.currentPlayer,
            smallBlind: room.smallBlind,
            bigBlind: room.bigBlind,
            silent: true // 仅为同步座位/状态，前端不要弹「新对局开始」弹窗
        });
    } else {
        io.to(room.id).emit('gameUpdate', {
            players: playerList(room),
            communityCards: room.communityCards, pot: room.pot,
            currentBet: room.currentBet, minRaise: room.minRaise,
            currentPlayer: room.currentPlayer,
            phase: room.phase, dealer: room.dealer
        });
    }

    return removed;
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

        // 游戏已开始
        if (room.gameStarted) {
            // 检查是否有同名断线玩家，有则直接恢复
            const disconnectedPlayer = room.players.find(p => p.name === playerName && p.disconnected);
            if (disconnectedPlayer) {
                // 恢复断线玩家
                disconnectedPlayer.socketId = socket.id;
                disconnectedPlayer.disconnected = false;
                socket.playerId = disconnectedPlayer.id;
                socket.roomId = roomId;
                socket.playerName = playerName;
                socket.join(roomId);
                if (disconnectedPlayer._disconnectTimer) {
                    clearTimeout(disconnectedPlayer._disconnectTimer);
                    disconnectedPlayer._disconnectTimer = null;
                }
                console.log(`断线玩家恢复: ${playerName} → 房间 ${roomId}`);
                callback({
                    success: true, playerId: disconnectedPlayer.id, roomId,
                    isHost: disconnectedPlayer.isHost, players: playerList(room),
                    gameInProgress: true
                });
                return;
            }

            // 检查名字冲突（活跃玩家）
            const exists = room.players.find(p => p.name === playerName && !p.isSpectator && !p.disconnected);
            if (exists) { callback({ success: false, error: '名字已被使用' }); return; }

            const player = {
                id: socket.playerId, socketId: socket.id, name: playerName,
                chips: 0, hand: [], currentBet: 0, folded: false, allIn: false,
                isHost: false, ready: false, isSpectator: true
            };
            room.players.push(player);
            socket.join(roomId); socket.roomId = roomId; socket.playerName = playerName;
            console.log(`观战者加入: ${playerName} → 房间 ${roomId}`);

            io.to(roomId).emit('playerJoined', { players: playerList(room) });

            callback({
                success: true, playerId: socket.playerId, roomId,
                initialChips: room.initialChips, isSpectator: true,
                players: playerList(room),
                gameState: { communityCards: room.communityCards, pot: room.pot,
                    currentBet: room.currentBet, minRaise: room.minRaise, currentPlayer: room.currentPlayer,
                    phase: room.phase, dealer: room.dealer }
            });
            return;
        }

        // 正常加入（游戏未开始）
        const exists = room.players.find(p => p.name === playerName && !p.isSpectator);
        if (exists) { callback({ success: false, error: '名字已被使用' }); return; }

        const player = {
            id: socket.playerId, socketId: socket.id, name: playerName,
            chips: room.initialChips, hand: [], currentBet: 0, folded: false,
            allIn: false, isHost: false, ready: false
        };

        room.players.push(player);
        socket.join(roomId); socket.roomId = roomId; socket.playerName = playerName;

        io.to(roomId).emit('playerJoined', { players: playerList(room) });
        console.log(`玩家加入: ${playerName} 加入房间 ${roomId}`);

        callback({ success: true, playerId: socket.playerId, roomId,
            initialChips: room.initialChips, players: playerList(room) });
    });

    // 重新加入房间
    socket.on('rejoinRoom', (data, callback) => {
        const { roomId, playerName, oldPlayerId } = data;

        const room = rooms[roomId];
        if (!room) {
            callback({ success: false, error: '房间不存在或已结束' });
            return;
        }

        // 查找是否有同名的老玩家（包括断线的）
        let player = room.players.find(p => p.name === playerName || (oldPlayerId && p.id === oldPlayerId));

        if (player) {
            // 找到玩家，重新分配 socket 并恢复断线状态
            player.socketId = socket.id;
            player.disconnected = false;
            socket.playerId = player.id;
            socket.roomId = roomId;
            socket.join(roomId);

            // 清除断线计时器
            if (player._disconnectTimer) {
                clearTimeout(player._disconnectTimer);
                player._disconnectTimer = null;
            }

            console.log(`玩家重新加入: ${playerName} 房间 ${roomId}${player.disconnected ? ' (断线恢复)' : ''}`);

            callback({
                success: true,
                playerId: player.id,
                isHost: player.isHost,
                players: playerList(room),
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
                players: playerList(room)
            });

            callback({
                success: true,
                playerId: newPlayer.id,
                isHost: false,
                players: playerList(room),
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
            players: playerList(room)
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
            players: playerListEx(room, ['hand']),
            communityCards: room.communityCards,
            pot: room.pot,
            currentBet: room.currentBet, minRaise: room.minRaise,
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

        // 如果当前行动玩家断线了，自动跳过
        skipDisconnectedCurrent(room);

        const playerIndex = room.players.findIndex(p => p.id === socket.playerId);
        if (playerIndex !== room.currentPlayer) {
            callback({ success: false, error: '还没轮到你' });
            return;
        }

        const { action, amount } = data || {};
        const player = room.players[playerIndex];

        // 记录当前注额，用于判断是否有加注
        room.previousBet = room.currentBet;

        // ============ 1. 合法性校验（纯函数，失败时不动任何状态）============
        const validation = validateBetAction(room, player, action, amount);
        if (!validation.valid) {
            console.log(
                `[bet][拒绝] room=${room.id} player=${player.name} action=${action} amount=${amount} ` +
                `currentBet=${room.currentBet} minRaise=${room.minRaise} → ${validation.error}`
            );
            callback({ success: false, error: validation.error });
            return;
        }

        // ============ 2. 应用状态变更（所有加减都做非负 / 非 NaN 兜底）============
        const beforeChips = player.chips;
        const actualAmount = Math.max(0, Number.isFinite(validation.normalizedAmount) ? validation.normalizedAmount : 0);

        if (action === 'fold') {
            player.folded = true;
        }

        // 扣筹码：恒不超过持有量，恒 >= 0
        const deduct = Math.min(actualAmount, Math.max(0, player.chips));
        player.chips = Math.max(0, player.chips - deduct);
        // 本轮已投入：优先用校验器算出的目标值，保证与 pot 增量一致
        player.currentBet = Math.max(
            0,
            Number.isFinite(validation.newPlayerBet)
                ? validation.newPlayerBet
                : (player.currentBet || 0) + deduct
        );
        room.pot = Math.max(0, (room.pot || 0) + deduct);
        // 当前注额只允许抬高，绝不调低（防止把 currentBet 压到盲注以下）
        room.currentBet = Math.max(
            room.currentBet || 0,
            Number.isFinite(validation.newCurrentBet) ? validation.newCurrentBet : player.currentBet
        );
        if (Number.isFinite(validation.newMinRaise)) {
            room.minRaise = Math.max(0, validation.newMinRaise);
        }
        if (validation.allIn || player.chips === 0) {
            player.allIn = true;
        }
        if (validation.reopens) {
            room.lastRaiseIndex = playerIndex;
        }

        // ============ 3. 动作日志（一行 JSON，便于核对筹码流向）============
        console.log(`[bet] ${JSON.stringify({
            room: room.id, player: player.name, action: validation.action, amount: deduct,
            beforeChips, afterChips: player.chips, pot: room.pot,
            playerBet: player.currentBet, tableBet: room.currentBet, tableMinRaise: room.minRaise,
            allIn: !!player.allIn, phase: room.phase
        })}`);

        io.to(room.id).emit('playerAction', {
            playerId: socket.playerId,
            action: validation.action, // 用归一化后的动作（call 可能已被转成 check / allin）
            amount: deduct
        });

        // 记录本阶段已行动的玩家
        room.actedThisPhase.add(playerIndex);

        // 检查是否只剩一个未弃牌玩家（其他人全弃牌），直接判胜
        const nonFolded = room.players.filter(p => !p.folded && !p.isSpectator && !p.disconnected);
        if (nonFolded.length === 1) {
            const winner = nonFolded[0];
            const wonPot = room.pot;
            winner.chips += wonPot;
            room.pot = 0;
            room.phase = 'showdown';

            io.to(room.id).emit('gameEnd', {
                players: playerListEx(room, ['hand']),
                communityCards: room.communityCards,
                pot: wonPot,
                winners: [winner.id],
                handName: '对手全弃牌',
                results: room.players
                    .filter(p => !p.folded)
                    .map(p => ({
                        playerId: p.id,
                        handName: '对手全弃牌',
                        handRank: 0
                    })),
                dealer: room.dealer
            });

            // 3秒后自动开始下一局
            setTimeout(() => {
                handleRebuy(room);
                const eligiblePlayers = room.players.filter(p => p.chips >= room.bigBlind && !p.isSpectator && !p.disconnected);
                if (eligiblePlayers.length >= 2) {
                    startNewHand(room);
                    io.to(room.id).emit('gameStarted', {
                        players: playerListEx(room, ['hand']),
                        dealer: room.dealer,
                        phase: room.phase,
                        currentPlayer: room.currentPlayer,
                        pot: room.pot,
                        currentBet: room.currentBet, minRaise: room.minRaise,
                        smallBlind: room.smallBlind,
                        bigBlind: room.bigBlind
                    });
                }
            }, 3000);

            callback({ success: true });
            return;
        }

        // 只有「完整加注」才会重新开放本轮下注，让其他玩家需要再次行动。
        // 注意：短码 all-in（达不到最小加注额）不重新开放——reopens 为 false。
        // 旧的 room.currentBet > room.previousBet 判断会在短码 all-in 时错误地重置已行动标记。
        if (validation.reopens) {
            room.lastRaiseIndex = playerIndex;
            room.actedThisPhase.clear();
            room.actedThisPhase.add(playerIndex);
        }

        // 计算下一个可以行动的玩家
        let nextPlayer = -1;
        for (let i = 1; i < room.players.length; i++) {
            const idx = (playerIndex + i) % room.players.length;
            if (!room.players[idx].folded && !room.players[idx].allIn && !room.players[idx].isSpectator && !room.players[idx].disconnected) {
                nextPlayer = idx;
                break;
            }
        }

        // 判断一轮是否结束：
        // 1. 所有active玩家下注金额相等
        // 2. 所有active玩家都已行动过（或无法行动）
        const activePlayers = room.players.filter(p => !p.folded && !p.allIn && !p.isSpectator && !p.disconnected);
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
                players: playerList(room),
                communityCards: room.communityCards,
                pot: room.pot,
                currentBet: room.currentBet, minRaise: room.minRaise,
                currentPlayer: room.currentPlayer,
                phase: room.phase,
                dealer: room.dealer
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

    // 改名
    socket.on('renamePlayer', (data, callback) => {
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

        const { newName } = data;
        if (!newName || !newName.trim()) {
            callback({ success: false, error: '昵称不能为空' });
            return;
        }

        const trimmed = newName.trim().substring(0, 12);
        player.name = trimmed;

        // 广播更新后的玩家列表
        io.to(room.id).emit('playerRenamed', {
            players: playerList(room)
        });

        callback({ success: true });
    });

    // 聊天消息
    socket.on('chatMessage', (data, callback) => {
        const room = rooms[socket.roomId];
        if (!room) return;
        const player = room.players.find(p => p.id === socket.playerId);
        if (!player) return;
        const text = (data.text || '').trim().substring(0, 100);
        if (!text) return;

        io.to(room.id).emit('chatMessage', {
            name: player.name,
            text
        });
        // callback 兼容
        if (typeof callback === 'function') callback({ success: true });
    });

    // 请求当前游戏状态（断线重连/恢复时使用）
    socket.on('requestGameState', () => {
        const room = rooms[socket.roomId];
        if (!room || !room.gameStarted) return;
        const player = room.players.find(p => p.id === socket.playerId);
        if (!player) return;
        // 发送当前游戏状态给该玩家（包含手牌）
        socket.emit('gameUpdate', {
            players: room.players.map(p => {
                const base = serializePlayer(p);
                if (p.id === player.id && p.hand.length > 0) base.hand = p.hand;
                return base;
            }),
            communityCards: room.communityCards,
            pot: room.pot,
            currentBet: room.currentBet, minRaise: room.minRaise,
            currentPlayer: room.currentPlayer,
            phase: room.phase,
            dealer: room.dealer
        });
    });

    // 断开连接（不立即删除，给移动端切后台重连留 60 秒窗口期）
    socket.on('disconnect', (reason) => {
        console.log('=== DISCONNECT ===');
        console.log('socket.id:', socket.id, 'playerId:', socket.playerId, 'roomId:', socket.roomId, 'reason:', reason);
        const room = rooms[socket.roomId];
        if (!room) return;

        const playerIndex = room.players.findIndex(p => p.id === socket.playerId);
        if (playerIndex === -1) return;

        const player = room.players[playerIndex];
        console.log('玩家断线:', player.name, '(index:', playerIndex, ')');

        // 标记为断线（不删除），60 秒后如果还没重连才真正移除
        player.disconnected = true;
        player.socketId = null;
        io.to(room.id).emit('playerLeft', { playerId: socket.playerId, playerName: player.name + ' (断线)' });

        // 如果房主断线且游戏未开始，立即转让房主
        if (player.isHost && !room.gameStarted) {
            const nextHost = room.players.find(p => !p.isSpectator && !p.disconnected && p.id !== player.id);
            if (nextHost) {
                player.isHost = false;
                nextHost.isHost = true;
                io.to(room.id).emit('newHost', { hostId: nextHost.id });
                console.log(`[断线] 房主 ${player.name} 断线，转让给 ${nextHost.name}`);
            }
        }

        // 如果是当前行动玩家，自动弃牌
        if (room.currentPlayer === playerIndex && room.phase !== 'waiting' && room.phase !== 'showdown') {
            console.log('[断线] 当前行动玩家断线，自动弃牌');
            player.folded = true;
            // 模拟 fold 后的游戏流程
            const betActions = ['bet', 'raise', 'allin'];
            // 计算下一个玩家
            let nextPlayer = -1;
            for (let i = 1; i < room.players.length; i++) {
                const idx = (playerIndex + i) % room.players.length;
                if (!room.players[idx].folded && !room.players[idx].allIn && !room.players[idx].isSpectator && !room.players[idx].disconnected) {
                    nextPlayer = idx;
                    break;
                }
            }
            room.actedThisPhase.add(playerIndex);
            // 检查是否只剩一人
            const nonFolded = room.players.filter(p => !p.folded && !p.isSpectator && !p.disconnected);
            if (nonFolded.length === 1) {
                const winner = nonFolded[0];
                const wonPot = room.pot;
                winner.chips += wonPot;
                room.pot = 0;
                room.phase = 'showdown';
                io.to(room.id).emit('gameEnd', {
                    players: playerListEx(room, ['hand']),
                    communityCards: room.communityCards, pot: wonPot,
                    winners: [winner.id], handName: '对手断线弃牌',
                    results: nonFolded.map(p => ({ playerId: p.id, handName: '对手断线弃牌', handRank: 0 })),
                    dealer: room.dealer
                });
                setTimeout(() => {
                    handleRebuy(room);
                    const ep = room.players.filter(p => p.chips >= room.bigBlind && !p.isSpectator && !p.disconnected);
                    if (ep.length >= 2) {
                        startNewHand(room);
                        io.to(room.id).emit('gameStarted', { players: playerListEx(room, ['hand']), dealer: room.dealer, phase: room.phase, currentPlayer: room.currentPlayer, pot: room.pot, currentBet: room.currentBet, minRaise: room.minRaise, smallBlind: room.smallBlind, bigBlind: room.bigBlind });
                    }
                }, 3000);
            } else if (nextPlayer === -1) {
                advancePhase(room);
            } else {
                room.currentPlayer = nextPlayer;
                io.to(room.id).emit('gameUpdate', {
                    players: playerList(room),
                    communityCards: room.communityCards, pot: room.pot,
                    currentBet: room.currentBet, minRaise: room.minRaise, currentPlayer: room.currentPlayer,
                    phase: room.phase, dealer: room.dealer
                });
            }
        }

        // 60 秒后如果还没重连，真正移除
        // 统一走 removePlayerFromRoom：内部负责下标重映射 / 房主转让 / 广播，禁止在这里直接 splice
        const disconnectTimer = setTimeout(() => {
            const currentRoom = rooms[socket.roomId];
            if (!currentRoom) return;

            const pi = currentRoom.players.findIndex(p => p.id === socket.playerId);
            if (pi === -1 || !currentRoom.players[pi].disconnected) return;

            const removed = removePlayerFromRoom(currentRoom, pi);
            if (!removed) return;

            console.log('[断线超时] 已移除玩家:', removed.name, '(旧下标:', pi, ')',
                '| 剩余人数:', currentRoom.players.length,
                '| dealer:', currentRoom.dealer, 'currentPlayer:', currentRoom.currentPlayer,
                '| acted:', [...currentRoom.actedThisPhase]);

            // 房间空了就销毁
            if (currentRoom.players.length === 0) {
                console.log('[断线超时] 房间已空，销毁房间', socket.roomId);
                delete rooms[socket.roomId];
            }
        }, DISCONNECT_TIMEOUT_MS);
        player._disconnectTimer = disconnectTimer;
    });
});

// ============ 启动 ============
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`德州扑克服务器运行在 http://localhost:${PORT}`);
});
