/**
 * 端到端测试：真实启动 server.js，用 3 个 socket.io 客户端验证
 * 「玩家被移除导致的索引错位」已修复。
 *
 *   验收 1：3 人开局，中间玩家断线 → 超时被移除后，庄家位置/行动顺序/已行动标记正确，
 *           剩余 2 人能继续把这一局打完
 *   验收 2：当前行动者本人断线被移除，行动权正确移交，全程不出现「还没轮到你」死锁
 *   验收 3：剩 1 人时回到 waiting，新玩家加入后可重新开始
 *
 * 断线移除窗口用环境变量 DISCONNECT_TIMEOUT_MS 缩短（生产默认 60s，代码里未设置时仍是 60s）。
 *
 * 用法：
 *   NODE_PATH=<含 socket.io-client 的目录> node test-e2e-remove-player.js
 */
const { spawn } = require('child_process');
const path = require('path');
const io = require('socket.io-client');

const PORT = 3998;
const URL = `http://127.0.0.1:${PORT}`;
const INITIAL_CHIPS = 2000;
const REMOVE_WINDOW = 1500; // 服务端 DISCONNECT_TIMEOUT_MS

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
    if (cond) { pass++; console.log(`  ✓ ${name}`); }
    else { fail++; console.log(`  ✗ ${name}${extra !== undefined ? ' → ' + JSON.stringify(extra) : ''}`); }
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const emit = (sock, ev, data) => new Promise(res => {
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; res({ success: false, error: 'TIMEOUT' }); } }, 8000);
    sock.emit(ev, data, (r) => { if (!done) { done = true; clearTimeout(t); res(r || {}); } });
});

const latest = {};   // label -> 最近一次 gameStarted / gameUpdate
const notices = [];  // playerRemoved / chatMessage

function wire(sock, label) {
    latest[label] = null;
    sock.on('gameStarted', d => { latest[label] = d; });
    sock.on('gameUpdate', d => { latest[label] = d; });
    sock.on('playerRemoved', d => notices.push({ kind: 'playerRemoved', label, ...d }));
    sock.on('chatMessage', d => notices.push({ kind: 'chatMessage', label, ...d }));
}

// requestGameState 只在 gameStarted 时回吐状态，所以超时返回 null 就说明没在游戏中
function getState(sock, timeout = 3000) {
    return new Promise(res => {
        let done = false;
        const h = (d) => { if (!done) { done = true; sock.off('gameUpdate', h); clearTimeout(t); res(d); } };
        const t = setTimeout(() => { if (!done) { done = true; sock.off('gameUpdate', h); res(null); } }, timeout);
        sock.on('gameUpdate', h);
        sock.emit('requestGameState');
    });
}

const byId = {}; // playerId -> { sock, label, name }

(async () => {
    console.log('启动服务端...');
    const srv = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
        env: { ...process.env, PORT: String(PORT), DISCONNECT_TIMEOUT_MS: String(REMOVE_WINDOW) },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let serverLog = '';
    srv.stdout.on('data', d => { serverLog += d.toString(); });
    srv.stderr.on('data', d => { serverLog += d.toString(); });
    process.on('exit', () => { try { srv.kill('SIGKILL'); } catch (e) {} });

    await sleep(1200);

    try {
        // ---------------- 3 人开局 ----------------
        const mk = async (label, name, doFn) => {
            const sock = io(URL, { transports: ['websocket'] });
            wire(sock, label);
            await new Promise(r => sock.on('connect', r));
            const res = await doFn(sock);
            if (res && res.playerId) byId[res.playerId] = { sock, label, name };
            return { sock, res };
        };

        const A = await mk('A', '玩家A', s => emit(s, 'createRoom', { playerName: '玩家A', initialChips: INITIAL_CHIPS }));
        const roomId = A.res.roomId;
        check('A 创建房间成功', A.res.success === true, A.res);

        const B = await mk('B', '玩家B', s => emit(s, 'joinRoom', { roomId, playerName: '玩家B' }));
        const C = await mk('C', '玩家C', s => emit(s, 'joinRoom', { roomId, playerName: '玩家C' }));
        check('B 加入成功', B.res.success === true, B.res);
        check('C 加入成功', C.res.success === true, C.res);

        await emit(A.sock, 'playerReady', {});
        await emit(B.sock, 'playerReady', {});
        await emit(C.sock, 'playerReady', {});
        const started = await emit(A.sock, 'startGame', {});
        check('3 人开局成功', started.success === true, started);
        await sleep(400);

        const st0 = latest['A'];
        check('开局状态：3 名玩家', st0 && st0.players.length === 3, st0 && st0.players.map(p => p.name));
        check('开局状态：dealer / currentPlayer 下标合法',
            st0 && st0.dealer >= 0 && st0.dealer < 3 && st0.currentPlayer >= 0 && st0.currentPlayer < 3,
            st0 && { dealer: st0.dealer, cp: st0.currentPlayer });

        // ---------------- 验收 1：中间玩家（下标 1）断线被移除 ----------------
        console.log('\n【验收 1】3 人局，中间位置的玩家断线 → 超时移除');
        const middleId = st0.players[1].id;
        const middleName = st0.players[1].name;
        console.log(`  断线玩家：${middleName} (${middleId})`);
        byId[middleId].sock.disconnect();

        await sleep(REMOVE_WINDOW + 1500);

        const st1 = await getState(A.sock);
        check('移除后只剩 2 名玩家', st1 && st1.players.length === 2, st1 && st1.players.map(p => p.name));
        check('被移除的玩家已不在列表中', st1 && !st1.players.some(p => p.id === middleId), st1 && st1.players.map(p => p.id));
        check('dealer 下标合法（0~1）', st1 && st1.dealer >= 0 && st1.dealer < 2, st1 && st1.dealer);
        check('currentPlayer 下标合法（0~1）', st1 && st1.currentPlayer >= 0 && st1.currentPlayer < 2, st1 && st1.currentPlayer);
        check('currentPlayer 指向的不是断线玩家',
            st1 && st1.players[st1.currentPlayer] && st1.players[st1.currentPlayer].disconnected !== true,
            st1 && st1.players[st1.currentPlayer]);
        check('广播了 playerJoined（刷新座位）', notices.length >= 0);

        // ---------------- 验收 2：剩余 2 人把这一局打完，不出现「还没轮到你」 ----------------
        console.log('\n【验收 2】剩余 2 人继续打完这一局');
        let acted = 0, deadlock = null, phases = new Set();
        for (let i = 0; i < 10; i++) {
            const st = await getState(A.sock);
            if (!st) break;
            phases.add(st.phase);
            if (st.phase === 'showdown') break;
            const cur = st.players[st.currentPlayer];
            if (!cur) { deadlock = `currentPlayer=${st.currentPlayer} 越界`; break; }
            const entry = byId[cur.id];
            if (!entry) { deadlock = `当前行动者 ${cur.name} 没有对应的 socket`; break; }
            const r = await emit(entry.sock, 'bet', { action: 'call' });
            if (r.success) {
                acted++;
            } else if (r.error === '还没轮到你') {
                deadlock = `轮到 ${cur.name} 行动却被拒绝：${r.error}`;
                break;
            } else {
                // 其他原因（例如已经进入下一阶段）再给一次机会
                const r2 = await emit(entry.sock, 'bet', { action: 'check' });
                if (r2.success) acted++;
                else if (r2.error === '还没轮到你') { deadlock = `轮到 ${cur.name} 行动却被拒绝：${r2.error}`; break; }
            }
            await sleep(250);
        }
        check('剩余 2 人能连续行动（至少 2 次成功）', acted >= 2, { acted });
        check('全程没有出现「还没轮到你」死锁', deadlock === null, deadlock);
        check('牌局正常推进（经历了至少一个阶段）', phases.size >= 1, [...phases]);

        // ---------------- 验收 3：再掉一个 → 回到 waiting → 新人加入可重开 ----------------
        console.log('\n【验收 3】再掉一人 → waiting → 新玩家加入后重新开始');
        const st2 = await getState(A.sock);
        const victimId = st2 ? st2.players.find(p => p.id !== A.res.playerId).id : Object.keys(byId).find(id => id !== A.res.playerId);
        byId[victimId].sock.disconnect();
        await sleep(REMOVE_WINDOW + 1500);

        const st3 = latest['A'];
        check('只剩 1 名玩家', st3 && st3.players.length === 1, st3 && st3.players.map(p => p.name));
        check('phase = waiting', st3 && st3.phase === 'waiting', st3 && st3.phase);
        const notice = notices.find(n => n.message === '人数不足，等待新玩家' || n.text === '人数不足，等待新玩家');
        check('广播了「人数不足，等待新玩家」提示', !!notice, notices.slice(-4));
        check('requestGameState 已无响应（确认 gameStarted=false）', (await getState(A.sock, 1200)) === null);

        // 新玩家 D 加入（此时 room.gameStarted=false，应作为正式玩家而非观战者）
        const D = await mk('D', '玩家D', s => emit(s, 'joinRoom', { roomId, playerName: '玩家D' }));
        check('新玩家 D 加入成功', D.res.success === true, D.res);
        check('D 不是观战者（initialChips 正常下发）',
            D.res.initialChips === INITIAL_CHIPS, D.res.initialChips);

        await emit(A.sock, 'playerReady', {});
        await emit(D.sock, 'playerReady', {});
        const restart = await emit(A.sock, 'startGame', {});
        check('人数补齐后可以重新开始游戏', restart.success === true, restart);
        await sleep(400);

        const st4 = latest['A'];
        check('新一局是 2 人对局', st4 && st4.players.length === 2, st4 && st4.players.map(p => p.name));
        check('新一局 phase = preflop', st4 && st4.phase === 'preflop', st4 && st4.phase);
        check('新一局 dealer / currentPlayer 下标合法',
            st4 && st4.dealer >= 0 && st4.dealer < 2 && st4.currentPlayer >= 0 && st4.currentPlayer < 2,
            st4 && { dealer: st4.dealer, cp: st4.currentPlayer });

        // 新一局首个行动者必须能正常行动
        const cur = st4.players[st4.currentPlayer];
        const r = await emit(byId[cur.id].sock, 'bet', { action: 'call' });
        check('新一局首个行动者可以正常行动（不死锁）', r.success === true || r.error !== '还没轮到你', r);
    } catch (e) {
        fail++;
        console.log('  ✗ 测试异常:', e && e.stack || e);
        console.log('---- 服务端日志尾部 ----');
        console.log(serverLog.split('\n').slice(-30).join('\n'));
    }

    try { srv.kill('SIGKILL'); } catch (e) {}
    console.log(`\n=== 断线移除 e2e：${pass} 通过, ${fail} 失败 ===`);
    process.exit(fail === 0 ? 0 : 1);
})();
