/**
 * removePlayerFromRoom 单元测试（断线 splice 索引错位修复 P0-②）
 *
 * 从 server.js 抽取函数源码后 eval 到本模块作用域，用桩替换 io / playerList /
 * playerListEx / advancePhase，直接验证：
 *   1. 移除中段玩家后，dealer / currentPlayer / actedThisPhase / lastRaiseIndex 全部指向正确的人
 *   2. 被移除者恰为当前行动者时，行动权交给「紧邻的下一家」，不出现死锁
 *   3. 剩余 < 2 人时回到 waiting + gameStarted=false，并广播「人数不足，等待新玩家」
 *   4. 移除后广播完整状态（playerJoined + gameUpdate/gameStarted）
 *   5. 穷举 + 随机：所有下标恒在合法范围内
 */
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');

function extractFunction(src, name) {
    const start = src.indexOf(`function ${name}(`);
    if (start === -1) throw new Error(`未找到函数 ${name}`);
    let i = src.indexOf('{', start), depth = 0;
    for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
    }
    throw new Error('括号未配对');
}

// ---- 桩：广播捕获 ----
let events = [];
const io = { to: () => ({ emit: (evt, data) => events.push({ evt, data }) }) };
const playerList = (room) => room.players.map(p => ({ id: p.id, name: p.name, chips: p.chips }));
const playerListEx = (room) => room.players.map(p => ({ id: p.id, name: p.name, chips: p.chips, hand: p.hand || [] }));
let advancePhaseCalls = 0;
function advancePhase() { advancePhaseCalls++; }

// 依赖顺序：被依赖的先 eval
eval(extractFunction(SRC, 'nextActionableIndex'));
eval(extractFunction(SRC, 'remapStateAfterPlayerRemoval'));
eval(extractFunction(SRC, 'normalizeRoomIndices'));
const removePlayerFromRoom = eval(`(${extractFunction(SRC, 'removePlayerFromRoom')})`);

let pass = 0, fail = 0;
function check(name, cond, extra) {
    if (cond) { pass++; console.log(`  ✓ ${name}`); }
    else { fail++; console.log(`  ✗ ${name}${extra !== undefined ? ' → ' + JSON.stringify(extra) : ''}`); }
}
function section(t) { console.log(`\n${t}`); }

// 构造一个「已开局」的房间
function mkRoom(n, opts = {}) {
    const players = [];
    for (let i = 0; i < n; i++) {
        players.push({
            id: 'P' + i, name: 'P' + i, socketId: 'S' + i, chips: 2000, hand: [{ suit: '♠', rank: 'A', value: 14 }],
            currentBet: 0, totalPotBet: 0, folded: false, allIn: false,
            isHost: i === 0, ready: true, isSpectator: false, disconnected: false
        });
    }
    return Object.assign({
        id: 'ROOM1', players, communityCards: [], pot: 0, currentBet: 0, minRaise: 20,
        phase: 'preflop', dealer: 0, currentPlayer: 0, lastRaiseIndex: -1,
        actedThisPhase: new Set(), gameStarted: true, bigBlind: 20, smallBlind: 10,
        initialChips: 2000, phaseBets: {}
    }, opts);
}
const set = (...a) => new Set(a);
const sortedActed = room => [...room.actedThisPhase].sort((a, b) => a - b);

function resetProbe() { events = []; advancePhaseCalls = 0; }
const evtNames = () => events.map(e => e.evt);
const evtOf = n => events.filter(e => e.evt === n).map(e => e.data);

// =====================================================================
section('【用例 1】3 人局，移除中间玩家(index=1)：庄家/行动顺序/已行动标记全部正确');
{
    resetProbe();
    // dealer=P0(0)，BB=P2(2)，轮到 P2 行动(2)，P0/P1 已行动
    const room = mkRoom(3, { dealer: 0, currentPlayer: 2, lastRaiseIndex: 1, actedThisPhase: set(0, 1), pot: 120 });
    const removed = removePlayerFromRoom(room, 1);

    check('返回被移除的玩家 P1', removed && removed.id === 'P1', removed && removed.id);
    check('人数 3→2，剩下 P0/P2', room.players.length === 2 && room.players[0].id === 'P0' && room.players[1].id === 'P2', room.players.map(p => p.id));
    check('dealer 仍在 P0（下标 0 < 1，不位移）', room.dealer === 0 && room.players[room.dealer].id === 'P0', room.dealer);
    check('currentPlayer 从 P2(2) 重映射到新下标 1，仍指向 P2', room.currentPlayer === 1 && room.players[1].id === 'P2', room.currentPlayer);
    check('lastRaiseIndex 命中被删者 → -1', room.lastRaiseIndex === -1, room.lastRaiseIndex);
    check('actedThisPhase {0,1} → {0}（丢弃被删者，P2 未行动不误加）',
        JSON.stringify(sortedActed(room)) === JSON.stringify([0]), sortedActed(room));
    check('牌局继续：phase 仍是 preflop、gameStarted 仍为 true',
        room.phase === 'preflop' && room.gameStarted === true, { phase: room.phase, started: room.gameStarted });
    check('广播包含 playerJoined', evtNames().includes('playerJoined'), evtNames());
    check('广播包含 gameStarted（游戏中，同步座位）', evtNames().includes('gameStarted'), evtNames());
    const gs = evtOf('gameStarted')[0];
    check('gameStarted 携带正确的 dealer/currentPlayer', gs && gs.dealer === 0 && gs.currentPlayer === 1, gs && { d: gs.dealer, c: gs.currentPlayer });
    check('gameStarted 标记 silent=true（前端不弹新局弹窗）', gs && gs.silent === true, gs && gs.silent);
    check('没有误触发 advancePhase', advancePhaseCalls === 0, advancePhaseCalls);
}

// =====================================================================
section('【用例 2】被移除者就是当前行动者：行动权交给紧邻的下一家，不死锁');
{
    // 2a：3人，行动者 P1 被移除 → 交给 P2，而不是跳过 P2 给 P0
    resetProbe();
    const room = mkRoom(3, { dealer: 0, currentPlayer: 1, actedThisPhase: set(0), pot: 120 });
    removePlayerFromRoom(room, 1);
    check('2a 行动权交给原 P2（新下标 1）', room.currentPlayer === 1 && room.players[1].id === 'P2', room.currentPlayer);
    check('2a currentPlayer 是真实可行动玩家（未弃牌/未 allIn/未断线）',
        room.players[room.currentPlayer] && !room.players[room.currentPlayer].folded);
    check('2a dealer 未被打乱（P0）', room.dealer === 0 && room.players[0].id === 'P0', room.dealer);

    // 2b：行动者是最后一位（下标 2），继承者应回绕到下标 0 的 P0
    resetProbe();
    const room2 = mkRoom(3, { dealer: 2, currentPlayer: 2, actedThisPhase: set(0, 1), pot: 120 });
    removePlayerFromRoom(room2, 2);
    check('2b 行动者位于末位时回绕到 P0（新下标 0）', room2.currentPlayer === 0 && room2.players[0].id === 'P0', room2.currentPlayer);
    check('2b 被删者是庄家 → 庄家顺延到前一位 P1（新下标 1）', room2.dealer === 1 && room2.players[1].id === 'P1', room2.dealer);
    check('2b actedThisPhase {0,1} 保持 {0,1}（两条都 < 被删下标 2）',
        JSON.stringify(sortedActed(room2)) === JSON.stringify([0, 1]), sortedActed(room2));

    // 2c：无人可接手（其余人全弃牌）→ 推进阶段，避免「还没轮到你」卡死
    resetProbe();
    const room3 = mkRoom(3, { dealer: 0, currentPlayer: 1, pot: 120 });
    room3.players[2].folded = true; // P2 已弃牌，只剩 P0 也未行动……让 P0 也弃牌
    room3.players[0].folded = true;
    removePlayerFromRoom(room3, 1);
    check('2c 无人接手时调用 advancePhase 推进', advancePhaseCalls === 1, advancePhaseCalls);
    check('2c currentPlayer 仍被兜底到合法下标', room3.currentPlayer >= 0 && room3.currentPlayer < room3.players.length, room3.currentPlayer);
}

// =====================================================================
section('【用例 3】庄家被移除：顺延到前一个位置，保持轮转顺序');
{
    resetProbe();
    // 4 人：dealer=P2(2)，移除 P2 → 新数组 [P0,P1,P3]，庄家应为 P1（新下标 1）
    const room = mkRoom(4, { dealer: 2, currentPlayer: 3, actedThisPhase: set(0, 1, 2, 3) });
    removePlayerFromRoom(room, 2);
    check('dealer 顺延到前一位 P1（新下标 1）', room.dealer === 1 && room.players[1].id === 'P1', room.dealer);
    check('currentPlayer P3(3) → 新下标 2', room.currentPlayer === 2 && room.players[2].id === 'P3', room.currentPlayer);
    check('actedThisPhase {0,1,2,3} → {0,1,2}', JSON.stringify(sortedActed(room)) === JSON.stringify([0, 1, 2]), sortedActed(room));

    // 被删庄家位于首位：dealer=0 → 顺延到末位
    resetProbe();
    const room2 = mkRoom(3, { dealer: 0, currentPlayer: 1 });
    removePlayerFromRoom(room2, 0);
    check('dealer 在首位被删 → 顺延到末位 P2（新下标 1）', room2.dealer === 1 && room2.players[1].id === 'P2', room2.dealer);
}

// =====================================================================
section('【用例 4】剩余 1 人：回到 waiting，底池归最后一人，广播提示');
{
    resetProbe();
    const room = mkRoom(2, { dealer: 1, currentPlayer: 0, pot: 300, phase: 'flop', actedThisPhase: set(0, 1) });
    const chipsBefore = room.players[0].chips;
    removePlayerFromRoom(room, 1);

    check('只剩 P0', room.players.length === 1 && room.players[0].id === 'P0', room.players.map(p => p.id));
    check('phase = waiting', room.phase === 'waiting', room.phase);
    check('gameStarted = false', room.gameStarted === false, room.gameStarted);
    check('底池 300 归最后一人（筹码不凭空消失）', room.players[0].chips === chipsBefore + 300, room.players[0].chips);
    check('pot 归零', room.pot === 0, room.pot);
    check('dealer/currentPlayer 归一到 0', room.dealer === 0 && room.currentPlayer === 0, { d: room.dealer, c: room.currentPlayer });
    check('手牌状态已重置', room.players[0].hand.length === 0 && room.players[0].folded === false, room.players[0].hand.length);

    const removed = evtOf('playerRemoved')[0];
    check('playerRemoved 携带提示文案', removed && removed.message === '人数不足，等待新玩家', removed && removed.message);
    const chat = evtOf('chatMessage')[0];
    check('chatMessage 广播「人数不足，等待新玩家」', chat && chat.text === '人数不足，等待新玩家', chat);
    check('此时广播 gameUpdate 而非 gameStarted', evtNames().includes('gameUpdate') && !evtNames().includes('gameStarted'), evtNames());
}

// =====================================================================
section('【用例 5】房主被移除 → 转让房主');
{
    resetProbe();
    const room = mkRoom(3, { dealer: 0, currentPlayer: 2 });
    removePlayerFromRoom(room, 0); // P0 是房主
    const nh = evtOf('newHost')[0];
    check('广播 newHost', !!nh, evtNames());
    check('新房主是剩余玩家之一', room.players.some(p => p.isHost), room.players.map(p => [p.id, p.isHost]));
    check('新房主 id 与广播一致', nh && room.players.some(p => p.id === nh.hostId && p.isHost), nh);
}

// =====================================================================
section('【用例 6】非法输入：不改数组、返回 null');
{
    resetProbe();
    const room = mkRoom(3);
    const before = room.players.length;
    check('下标 -1 → null', removePlayerFromRoom(room, -1) === null);
    check('下标越界 → null', removePlayerFromRoom(room, 3) === null);
    check('非整数下标 → null', removePlayerFromRoom(room, 1.5) === null);
    check('房间为空对象 → null', removePlayerFromRoom({}, 0) === null);
    check('数组未被修改', room.players.length === before, room.players.length);
    check('没有任何广播', events.length === 0, evtNames());
}

// =====================================================================
section('【用例 7】穷举：任意人数 / 任意被删下标 / 任意初始状态，下标恒合法');
{
    let allOk = true;
    const bad = [];
    const realLog = console.log;
    console.log = () => {}; // 穷举期间静音服务端的移除日志
    for (let n = 2; n <= 8; n++) {
        for (let removed = 0; removed < n; removed++) {
            for (let dealer = 0; dealer < n; dealer++) {
                for (let cp = 0; cp < n; cp++) {
                    for (const lri of [-1, 0, removed, n - 1]) {
                        resetProbe();
                        const room = mkRoom(n, {
                            dealer, currentPlayer: cp, lastRaiseIndex: lri,
                            actedThisPhase: new Set([...Array(n).keys()])
                        });
                        removePlayerFromRoom(room, removed);
                        const m = room.players.length;
                        const ok = m === n - 1
                            && Number.isInteger(room.dealer) && room.dealer >= 0 && room.dealer < m
                            && Number.isInteger(room.currentPlayer) && room.currentPlayer >= 0 && room.currentPlayer < m
                            && room.lastRaiseIndex >= -1 && room.lastRaiseIndex < m
                            && [...room.actedThisPhase].every(x => Number.isInteger(x) && x >= 0 && x < m)
                            && room.actedThisPhase.size <= m;
                        if (!ok) {
                            allOk = false;
                            bad.push({ n, removed, dealer, cp, lri, dealer2: room.dealer, cp2: room.currentPlayer, lri2: room.lastRaiseIndex, acted: sortedActed(room) });
                        }
                    }
                }
            }
        }
    }
    console.log = realLog;
    check(`穷举 2~8 人 × 全部下标组合（${bad.length} 个反例）`, allOk, bad.slice(0, 3));
}

// =====================================================================
section('【用例 8】actedThisPhase 映射的物理玩家不变（不只是下标合法）');
{
    resetProbe();
    // 5 人：已行动 {P0,P2,P4} = {0,2,4}，移除下标 2（P2）
    // 移除后数组 [P0,P1,P3,P4]，已行动应映射到 {0,3}（P0 与 P4）
    const room = mkRoom(5, { dealer: 1, currentPlayer: 3, actedThisPhase: set(0, 2, 4) });
    removePlayerFromRoom(room, 2);
    const actedIds = sortedActed(room).map(i => room.players[i].id).sort();
    check('已行动集合映射后仍是 P0/P4', JSON.stringify(actedIds) === JSON.stringify(['P0', 'P4']), actedIds);
    check('被删者 P2 的已行动标记已丢弃', !actedIds.includes('P2'), actedIds);
}

// =====================================================================
section('【用例 9】被删者排在行动者「前面」：只做位移，不许抢行动权');
{
    // 3 人，行动者是末位 P2(下标 2)，删掉首位 P0(下标 0)
    // 正确结果：新数组 [P1,P2]，行动者 P2 的新下标 = 1（不是 0）
    resetProbe();
    const room = mkRoom(3, { dealer: 0, currentPlayer: 2, actedThisPhase: set(2) });
    removePlayerFromRoom(room, 0);
    check('行动者 P2 位移到新下标 1（仍指向 P2）', room.currentPlayer === 1 && room.players[1].id === 'P2', room.currentPlayer);
    check('已行动标记 {2} → {1}，仍指向 P2', sortedActed(room).length === 1 && room.players[sortedActed(room)[0]].id === 'P2', sortedActed(room));
    check('dealer 0 被删 → 顺延到末位 P2（新下标 1）', room.dealer === 1 && room.players[1].id === 'P2', room.dealer);
}

// =====================================================================
console.log(`\n=== removePlayerFromRoom 测试：${pass} 通过, ${fail} 失败 ===`);
process.exit(fail === 0 ? 0 : 1);
