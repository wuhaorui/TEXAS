/**
 * evaluateHand 单元测试（P0-③ 同花顺误判修复）
 * 从 server.js 抽取 evaluateHand 源码后 eval，并注入线上同值 HAND_RANKS / VALUE_NAMES。
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

global.HAND_RANKS = {
    '高牌': 1, '一对': 2, '两对': 3, '三条': 4, '顺子': 5,
    '同花': 6, '葫芦': 7, '四条': 8, '同花顺': 9, '皇家同花顺': 10
};
global.VALUE_NAMES = { 2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: '10', 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };

const evaluateHand = eval(`(${extractFunction(SRC, 'evaluateHand')})`);

let pass = 0, fail = 0;
function check(name, cond, extra) {
    if (cond) { pass++; console.log(`  ✓ ${name}`); }
    else { fail++; console.log(`  ✗ ${name}${extra ? ' → ' + JSON.stringify(extra) : ''}`); }
}
function section(t) { console.log(`\n${t}`); }

// 牌构造器：v=value(2-14)，s=suit 符号
function c(v, s) { return { suit: s, rank: String(v), value: v }; }
const S = '♠', H = '♥', D = '♦', C = '♣';

// 取牌型名
function name(cards) { return evaluateHand(cards).handName; }
function rank(cards) { return evaluateHand(cards).handRank; }

// =====================================================================
section('【同花顺真阳性】应判为同花顺/皇家同花顺');
{
    // 9-high 同花顺：5♠6♠7♠8♠9♠ + 2♥3♥
    const r = evaluateHand([c(5,S),c(6,S),c(7,S),c(8,S),c(9,S),c(2,H),c(3,H)]);
    check('9-high 同花顺', r.handName === '同花顺' && r.handRank === 9, r);
    check('高牌 = 9', r.tieBreaker === 9, r);
    check('values = [9,8,7,6,5]', JSON.stringify(r.values) === JSON.stringify([9,8,7,6,5]), r);

    // 皇家同花顺：T♠J♠Q♠K♠A♠ + 2♥3♥
    const royal = evaluateHand([c(10,S),c(11,S),c(12,S),c(13,S),c(14,S),c(2,H),c(3,H)]);
    check('皇家同花顺', royal.handName === '皇家同花顺' && royal.handRank === 10, royal);

    // 轮同花顺 A♠2♠3♠4♠5♠ + 9♥T♥
    const wheel = evaluateHand([c(14,S),c(2,S),c(3,S),c(4,S),c(5,S),c(9,H),c(10,H)]);
    check('A-2-3-4-5 同花顺(wheel)', wheel.handName === '同花顺' && wheel.tieBreaker === 5, wheel);
    check('wheel values = [5,4,3,2,1]', JSON.stringify(wheel.values) === JSON.stringify([5,4,3,2,1]), wheel);

    // 同花花色内确有顺子：5♠6♠7♠8♠9♠ + T♥J♥（额外两张不同花色，不能干扰）
    const sf2 = evaluateHand([c(5,S),c(6,S),c(7,S),c(8,S),c(9,S),c(10,H),c(11,H)]);
    check('同花花色内顺子 → 同花顺', sf2.handName === '同花顺' && sf2.handRank === 9, sf2);
}

section('【P0-③ 回归】跨花色出现顺子时，不得误判为同花顺，应为普通同花');
{
    // 5♠6♠7♠ + 8♦9♦ + A♠K♠
    // 同花（♠）有 5 张：A♠K♠7♠6♠5♠；但顺子 5-9 用了 8♦9♦（不同花色）
    const cards = [c(5,S),c(6,S),c(7,S),c(8,D),c(9,D),c(14,S),c(13,S)];
    const r = evaluateHand(cards);
    check('应判定为「同花」而非「同花顺」', r.handName === '同花', r);
    check('同花 rank=6 < 同花顺 rank=9', r.handRank === 6 && r.handRank < 9, r);
    check('同花高牌为 A(14)', r.tieBreaker === 14, r);
}

section('【普通牌型】不应被同花顺逻辑影响');
{
    // 普通同花（非顺子）：5♠6♠7♠8♠T♠ + 2♥3♥
    const flush = evaluateHand([c(5,S),c(6,S),c(7,S),c(8,S),c(10,S),c(2,H),c(3,H)]);
    check('T-high 同花', flush.handName === '同花' && flush.handRank === 6, flush);

    // 普通顺子（无同花）：5♥6♣7♦8♠9♥ + 2♣3♣
    const straight = evaluateHand([c(5,H),c(6,C),c(7,D),c(8,S),c(9,H),c(2,C),c(3,C)]);
    check('5-9 顺子', straight.handName === '顺子' && straight.handRank === 5, straight);
    check('顺子高牌 = 9', straight.tieBreaker === 9, straight);

    // 四条
    const quad = evaluateHand([c(9,S),c(9,H),c(9,D),c(9,C),c(13,S),c(2,H),c(3,H)]);
    check('四条', quad.handName === '四条' && quad.handRank === 8, quad);

    // 葫芦
    const boat = evaluateHand([c(9,S),c(9,H),c(9,D),c(13,S),c(13,H),c(2,C),c(3,C)]);
    check('葫芦', boat.handName === '葫芦' && boat.handRank === 7, boat);
}

section('【牌型强度排序】同花顺 > 同花 > 顺子');
{
    const sf = [c(5,S),c(6,S),c(7,S),c(8,S),c(9,S),c(2,H),c(3,H)];
    const flush = [c(5,S),c(6,S),c(7,S),c(8,S),c(10,S),c(2,H),c(3,H)];
    const straight = [c(5,H),c(6,C),c(7,D),c(8,S),c(9,H),c(2,C),c(3,C)];
    check('同花顺 > 同花', rank(sf) > rank(flush), { sf: rank(sf), flush: rank(flush) });
    check('同花 > 顺子', rank(flush) > rank(straight), { flush: rank(flush), straight: rank(straight) });
    check('(跨花色)同花 不应 ≥ 同花顺', rank(flush) < rank(sf), { flush: rank(flush), sf: rank(sf) });
}

// =====================================================================
console.log(`\n=== evaluateHand 测试：${pass} 通过, ${fail} 失败 ===`);
process.exit(fail === 0 ? 0 : 1);
