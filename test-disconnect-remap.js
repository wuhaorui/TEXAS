/**
 * remapStateAfterPlayerRemoval 单元测试（P0-② 断线 splice 索引错位修复）
 * 从 server.js 抽取两个辅助函数源码后 eval，直接验证「删除中段玩家后下标重映射」的正确性。
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

// 两个函数都注入模块作用域，remap 内部调用的 nextActionableIndex 才能解析
eval(extractFunction(SRC, 'nextActionableIndex'));
const remapStateAfterPlayerRemoval = eval(`(${extractFunction(SRC, 'remapStateAfterPlayerRemoval')})`);

let pass = 0, fail = 0;
function check(name, cond, extra) {
    if (cond) { pass++; console.log(`  ✓ ${name}`); }
    else { fail++; console.log(`  ✗ ${name}${extra ? ' → ' + JSON.stringify(extra) : ''}`); }
}
function section(t) { console.log(`\n${t}`); }

function mkRoom(n, opts = {}) {
    const players = [];
    for (let i = 0; i < n; i++) players.push({ id: 'P' + i, name: 'P' + i, isSpectator: false, disconnected: false, folded: false, allIn: false });
    return Object.assign({ players, dealer: 0, currentPlayer: 0, lastRaiseIndex: -1, actedThisPhase: new Set() }, opts);
}
const set = (...a) => new Set(a);

// =====================================================================
section('【用例 A】删除中段玩家 index=1（4人房）');
{
    // dealer=2, currentPlayer=2, lastRaiseIndex=1, actedThisPhase={0,2}
    const room = mkRoom(4, { dealer: 2, currentPlayer: 2, lastRaiseIndex: 1, actedThisPhase: set(0, 2) });
    room.players.splice(1, 1); // 与 server 端一致：先 splice 再重映射
    remapStateAfterPlayerRemoval(room, 1);
    check('人数 4→3', room.players.length === 3, room.players.length);
    check('dealer 2→1（>removed 减1）', room.dealer === 1, room.dealer);
    check('currentPlayer 2→1', room.currentPlayer === 1, room.currentPlayer);
    check('lastRaiseIndex 1(==removed)→-1', room.lastRaiseIndex === -1, room.lastRaiseIndex);
    check('actedThisPhase {0,2}→{0,1}', JSON.stringify([...room.actedThisPhase].sort((a,b)=>a-b)) === JSON.stringify([0,1]), [...room.actedThisPhase]);
    // 下标指向的物理玩家不变：原 index2 的玩家(P2)现在应在新 index1
    check('新 index1 仍是原 P2', room.players[1].id === 'P2', room.players[1].id);
    check('新 index2 应是原 P3', room.players[2].id === 'P3', room.players[2].id);
}

section('【用例 B】删除首位玩家 index=0（4人房）');
{
    const room = mkRoom(4, { dealer: 1, currentPlayer: 3, lastRaiseIndex: 2, actedThisPhase: set(0, 1, 3) });
    room.players.splice(0, 1);
    remapStateAfterPlayerRemoval(room, 0);
    check('人数 4→3', room.players.length === 3, room.players.length);
    check('dealer 1→0', room.dealer === 0, room.dealer);
    check('currentPlayer 3→2', room.currentPlayer === 2, room.currentPlayer);
    check('lastRaiseIndex 2→1', room.lastRaiseIndex === 1, room.lastRaiseIndex);
    check('actedThisPhase {0,1,3}→{0,2}', JSON.stringify([...room.actedThisPhase].sort((a,b)=>a-b)) === JSON.stringify([0,2]), [...room.actedThisPhase]);
    check('新 index0 仍是原 P1', room.players[0].id === 'P1', room.players[0].id);
    check('新 index1 仍是原 P2', room.players[1].id === 'P2', room.players[1].id);
    check('新 index2 应是原 P3', room.players[2].id === 'P3', room.players[2].id);
}

section('【用例 C】被删玩家恰为当前行动者 currentPlayer==removed');
{
    const room = mkRoom(3, { dealer: 0, currentPlayer: 1, lastRaiseIndex: -1, actedThisPhase: set(0) });
    room.players.splice(1, 1);
    remapStateAfterPlayerRemoval(room, 1);
    check('人数 3→2', room.players.length === 2, room.players.length);
    // 修正点：行动权应交给「紧邻的下一家」= 原 P2（新下标 1）。
    // 旧实现在 splice 后的新数组里从 removedIndex 向后**跳过一位**找，会跳过 P2 直接给 P0。
    check('currentPlayer 重定位到紧邻下一家 P2(新下标1)', room.currentPlayer === 1 && room.players[1].id === 'P2', room.currentPlayer);
    check('currentPlayer 不越界且指向真实玩家', room.currentPlayer >= 0 && room.currentPlayer < 2, room.currentPlayer);
    check('dealer 0 不变', room.dealer === 0, room.dealer);
    check('actedThisPhase {0}(移除1)→{0}', JSON.stringify([...room.actedThisPhase]) === JSON.stringify([0]), [...room.actedThisPhase]);
}

section('【用例 D】被删玩家是 dealer，需重定位到剩余合格玩家');
{
    const room = mkRoom(3, { dealer: 1, currentPlayer: 2, lastRaiseIndex: -1, actedThisPhase: new Set() });
    room.players.splice(1, 1);
    remapStateAfterPlayerRemoval(room, 1);
    check('人数 3→2', room.players.length === 2, room.players.length);
    check('dealer 重定位到 0（原 P1 被删，剩 P0/P2）', room.dealer === 0, room.dealer);
    check('dealer 仍在合法范围', room.dealer >= 0 && room.dealer < 2, room.dealer);
    check('currentPlayer 2→1', room.currentPlayer === 1, room.currentPlayer);
}

section('【用例 E】所有下标状态恒为合法下标（不越界、不为负）');
{
    for (let removed = 0; removed < 4; removed++) {
        const room = mkRoom(4, { dealer: 3, currentPlayer: 3, lastRaiseIndex: 2, actedThisPhase: set(0, 1, 2, 3) });
        room.players.splice(removed, 1);
        remapStateAfterPlayerRemoval(room, removed);
        const ok = room.dealer >= 0 && room.dealer < 3
            && room.currentPlayer >= 0 && room.currentPlayer < 3
            && room.lastRaiseIndex >= -1
            && [...room.actedThisPhase].every(x => x >= 0 && x < 3);
        check(`删除 index=${removed} 后所有下标合法`, ok, { dealer: room.dealer, currentPlayer: room.currentPlayer, lastRaiseIndex: room.lastRaiseIndex, acted: [...room.actedThisPhase] });
    }
}

// =====================================================================
console.log(`\n=== remapStateAfterPlayerRemoval 测试：${pass} 通过, ${fail} 失败 ===`);
process.exit(fail === 0 ? 0 : 1);
