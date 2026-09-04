/**
 * validateBetAction 单元测试
 * 从 server.js 中抽取纯函数源码后 eval，保证测的就是线上那份代码。
 */
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');

// ---- 用花括号配对抽取 validateBetAction 函数体 ----
function extractFunction(src, name) {
    const start = src.indexOf(`function ${name}(`);
    if (start === -1) throw new Error(`未找到函数 ${name}`);
    let i = src.indexOf('{', start);
    let depth = 0;
    for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') {
            depth--;
            if (depth === 0) return src.slice(start, i + 1);
        }
    }
    throw new Error('括号未配对');
}

const validateBetAction = eval(`(${extractFunction(SRC, 'validateBetAction')})`);

// ---- 断言工具 ----
let pass = 0, fail = 0;
function check(name, cond, extra) {
    if (cond) { pass++; console.log(`  ✓ ${name}`); }
    else { fail++; console.log(`  ✗ ${name}${extra ? ' → ' + JSON.stringify(extra) : ''}`); }
}
function section(t) { console.log(`\n${t}`); }

// ---- 模拟一次下注动作，返回执行后的状态（镜像 bet handler 的应用逻辑）----
function apply(room, player, action, amount) {
    const v = validateBetAction(room, player, action, amount);
    if (!v.valid) return { rejected: true, error: v.error, v };
    const deduct = Math.max(0, Math.min(v.normalizedAmount, Math.max(0, player.chips)));
    player.chips = Math.max(0, player.chips - deduct);
    player.currentBet = Math.max(0, v.newPlayerBet !== undefined ? v.newPlayerBet : player.currentBet + deduct);
    room.pot = Math.max(0, room.pot + deduct);
    room.currentBet = Math.max(room.currentBet, v.newCurrentBet !== undefined ? v.newCurrentBet : player.currentBet);
    if (Number.isFinite(v.newMinRaise)) room.minRaise = Math.max(0, v.newMinRaise);
    if (v.allIn || player.chips === 0) player.allIn = true;
    return { rejected: false, v, deduct };
}

function makeRoom(players, currentBet, minRaise) {
    return { pot: 0, currentBet, minRaise, bigBlind: 20, smallBlind: 10, players };
}
function p(chips, currentBet) { return { chips, currentBet, allIn: false, folded: false }; }
function total(room) { return room.pot + room.players.reduce((s, x) => s + x.chips, 0); }

// =====================================================================
section('【用例 1】preflop BB=20，非盲注位下注 10 必须被拒绝');
{
    const A = p(1000, 0), B = p(980, 20), C = p(990, 10);
    const room = makeRoom([A, B, C], 20, 20);
    const r = validateBetAction(room, A, 'bet', 10);
    check('下注 10 被拒绝', r.valid === false, r);
    check('错误提示含"最小加注到 40"', r.error && r.error.includes('最小加注到 40'), r.error);
    check('校验是纯函数：未改动任何状态',
        A.chips === 1000 && A.currentBet === 0 && room.currentBet === 20 && room.pot === 0 && room.minRaise === 20);
}

section('【用例 2】preflop 下注 40（= currentBet 20 + minRaise 20）应被接受');
{
    const A = p(1000, 0), B = p(980, 20), C = p(990, 10);
    const room = makeRoom([A, B, C], 20, 20);
    room.pot = 30; // 已收的 SB 10 + BB 20
    const r = apply(room, A, 'bet', 40);
    check('下注 40 被接受', !r.rejected, r);
    check('currentBet 抬到 40', room.currentBet === 40, room.currentBet);
    check('minRaise 更新为 40 - 20 = 20', room.minRaise === 20, room.minRaise);
    check('A 扣 40 筹码', A.chips === 960 && A.currentBet === 40, A);
    check('底池 = 30(盲注) + 40 = 70', room.pot === 70, room.pot);
    check('完整加注 → reopens = true', r.v.reopens === true);
}

section('【用例 3】currentBet 永不被调低');
{
    // A 已经是最高注 40，再"下注"一个很小的数：target 仍 >= currentBet，但不足 minRaise → 拒绝
    const A = p(960, 40), B = p(980, 20);
    const room = makeRoom([A, B], 40, 20);
    const r = validateBetAction(room, A, 'raise', 5);
    check('加注增量不足被拒绝', r.valid === false, r);
    check('拒绝后 currentBet 仍为 40', room.currentBet === 40);

    // 盲注位 currentBet=20 尝试 bet 1 → target=21 < 40 且不是 all-in → 拒绝
    const r2 = validateBetAction(room, B, 'bet', 1);
    check('BB 下注 1 被拒绝（不能把注额压到 20 以下）', r2.valid === false, r2);
    check('room.currentBet 仍为 40', room.currentBet === 40);
}

section('【用例 4】call 归一化为 check（不出现负数）');
{
    const BB = p(980, 20);
    const room = makeRoom([p(960, 20), BB], 20, 20);
    const r = apply(room, BB, 'call', 0);
    check('toCall<=0 时 call 归一化为 check', !r.rejected && r.v.action === 'check', r.v);
    check('不移动任何筹码', r.deduct === 0 && BB.chips === 980 && room.pot === 0);
    check('currentBet 保持 20', room.currentBet === 20);
}

section('【用例 5】筹码不足跟注 → 归一化为 all-in');
{
    const short = p(15, 0);              // 只有 15 筹码，要跟 20
    const room = makeRoom([short, p(1000, 20)], 20, 20);
    const r = apply(room, short, 'call', 0);
    check('call 归一化为 allin', !r.rejected && r.v.action === 'allin', r.v);
    check('只投入 15，不为负', r.deduct === 15 && short.chips === 0, short);
    check('short.allIn = true', short.allIn === true);
    check('pot = 15，非负', room.pot === 15, room.pot);
    check('currentBet 未被拉低到 15', room.currentBet === 20, room.currentBet);
}

section('【用例 6】短码 all-in 允许，但不重新开放下注');
{
    const short = p(25, 0);              // 想加注到 40 需要 40，只有 25
    const room = makeRoom([short, p(1000, 20)], 20, 20);
    const r = apply(room, short, 'raise', 25);
    check('短码 all-in 被接受', !r.rejected, r);
    check('action 归一化为 allin', r.v.action === 'allin', r.v.action);
    check('投入 25，筹码归零', short.chips === 0 && short.currentBet === 25);
    check('reopens = false（不是完整加注）', r.v.reopens === false);
    check('minRaise 保持 20 不变', room.minRaise === 20, room.minRaise);
    check('currentBet 提升到 25', room.currentBet === 25, room.currentBet);
}

section('【用例 7】fold / check / allin 基本合法性');
{
    const room = makeRoom([p(1000, 0), p(1000, 0)], 0, 20);
    check('fold 永远合法', validateBetAction(room, room.players[0], 'fold', 0).valid === true);
    check('无注时 check 合法', validateBetAction(room, room.players[0], 'check', 0).valid === true);
    const room2 = makeRoom([p(1000, 0), p(1000, 20)], 20, 20);
    check('有注时 check 被拒绝并给出原因',
        validateBetAction(room2, room2.players[0], 'check', 0).error.includes('不能过牌'));
    check('allin 永远合法', validateBetAction(room2, room2.players[0], 'allin', 0).valid === true);
    check('未知动作被拒绝', validateBetAction(room2, room2.players[0], 'xxx', 0).valid === false);
    check('NaN 金额被拒绝', validateBetAction(room2, room2.players[0], 'raise', NaN).valid === false);
    check('负金额被拒绝', validateBetAction(room2, room2.players[0], 'raise', -100).valid === false);
    check('0 金额下注被拒绝', validateBetAction(room2, room2.players[0], 'raise', 0).valid === false);
}

section('【用例 8】下注超过身家 → 截断为 all-in，不产生负数 / NaN');
{
    const A = p(100, 0);
    const room = makeRoom([A, p(1000, 20)], 20, 20);
    const r = apply(room, A, 'raise', 999999);
    check('被接受并截断为 all-in', !r.rejected && r.v.action === 'allin', r.v);
    check('只投入 100', r.deduct === 100 && A.chips === 0, A);
    check('pot = 100，非负', room.pot === 100, room.pot);
}

section('【用例 9】验收场景：A 下注 10(拒) → 下注 40 → B 跟注 → BB 过牌，筹码守恒');
{
    const INIT = 1000 + 1000 + 1000;
    const A = p(1000, 0), B = p(1000, 0), C = p(1000, 0);
    const room = makeRoom([A, B, C], 0, 0);
    // 模拟 startNewHand: A=SB? 这里简化：C 是 BB
    C.chips -= 20; C.currentBet = 20;
    B.chips -= 10; B.currentBet = 10;
    room.pot = 30; room.currentBet = 20; room.minRaise = 20;

    const snap = () => total(room);
    const t0 = snap();
    check('初始总筹码 == 3000', t0 === INIT, t0);

    const r1 = apply(room, A, 'bet', 10);
    check('A 下注 10 被拒绝', r1.rejected === true, r1);
    check('被拒后总筹码不变', snap() === INIT, snap());

    const r2 = apply(room, A, 'bet', 40);
    check('A 下注 40 成功', !r2.rejected, r2);
    check('currentBet = 40', room.currentBet === 40, room.currentBet);
    check('下注后总筹码不变', snap() === INIT, snap());

    const r3 = apply(room, C, 'call', 0);   // BB: 20 → 40，补 20
    check('BB 跟注成功，补 20', !r3.rejected && r3.deduct === 20, r3);
    check('BB currentBet = 40', C.currentBet === 40, C.currentBet);
    check('跟注后总筹码不变', snap() === INIT, snap());

    const r4 = apply(room, B, 'call', 0);   // SB: 10 → 40，补 30
    check('SB 跟注成功，补 30', !r4.rejected && r4.deduct === 30, r4);
    check('三方均到 40', [A, B, C].every(x => x.currentBet === 40));
    check('底池 = 30(盲注) + 40 + 20 + 30 = 120', room.pot === 120, room.pot);
    check('全程总筹码守恒 == 3000', snap() === INIT, snap());
    check('无负值', room.pot >= 0 && [A, B, C].every(x => x.chips >= 0 && x.currentBet >= 0));
    check('无 NaN', [room.pot, room.currentBet, room.minRaise, ...[A, B, C].flatMap(x => [x.chips, x.currentBet])]
        .every(Number.isFinite));
}

section('【用例 10】随机 fuzz：10000 次随机动作，检查守恒 / 非负 / 无 NaN');
{
    let bad = 0;
    for (let iter = 0; iter < 10000; iter++) {
        const hands = [];
        const players = [p(0, 0), p(0, 0), p(0, 0)];
        const room = makeRoom(players, 0, 20);
        players.forEach((pl, i) => { pl.chips = 50 + Math.floor(Math.random() * 2000); });
        const INIT = total(room);

        // 随机收盲
        players[0].chips -= 10; players[0].currentBet = 10;
        players[1].chips -= 20; players[1].currentBet = 20;
        room.pot = 30; room.currentBet = 20; room.minRaise = 20;

        const actions = ['fold', 'check', 'call', 'bet', 'raise', 'allin', 'xxx'];
        for (let step = 0; step < 12; step++) {
            const pl = players[Math.floor(Math.random() * players.length)];
            const act = actions[Math.floor(Math.random() * actions.length)];
            const amt = Math.floor(Math.random() * 400) - 20; // 含负数
            const before = total(room);
            const r = apply(room, pl, act, amt);
            if (r.rejected) {
                if (total(room) !== before) { bad++; console.log('  拒绝后状态被改动!', act, amt); }
            }
            const vals = [room.pot, room.currentBet, room.minRaise,
                ...players.flatMap(x => [x.chips, x.currentBet])];
            if (vals.some(v => !Number.isFinite(v))) { bad++; console.log('  NaN!', act, amt, vals); }
            if (vals.some(v => v < 0)) { bad++; console.log('  负数!', act, amt, vals); }
            if (total(room) !== INIT) { bad++; console.log('  守恒破坏!', act, amt, total(room), INIT); }
            if (bad > 3) break;
        }
        if (bad > 3) break;
    }
    check('10000 轮 fuzz 无守恒破坏 / 无负数 / 无 NaN', bad === 0, bad);
}

console.log(`\n================ 结果：${pass} 通过 / ${fail} 失败 ================`);
process.exit(fail === 0 ? 0 : 1);
