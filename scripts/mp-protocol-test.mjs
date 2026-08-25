#!/usr/bin/env node
/* ===========================================================
   マルチプレイと山の記録の疎通テスト。
   wrangler dev をローカルで起動し、WebSocket 2本と HTTP API を検証する。

   使い方: npm run test:mp
   =========================================================== */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';

const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
const WS = `ws://127.0.0.1:${PORT}`;

let failures = 0;
function check(name, ok, detail = '') {
  const mark = ok ? 'ok  ' : 'FAIL';
  if (!ok) failures++;
  console.log(`${mark} ${name}${detail ? ` — ${detail}` : ''}`);
}

/** 受信メッセージを待つ小さなヘルパー */
function client(url) {
  const ws = new WebSocket(url);
  const inbox = [];
  const waiters = [];
  // 生成した時点で open を待ち始める (後から once を付けると取りこぼす)
  const opened = new Promise((res, rej) => {
    ws.once('open', res);
    ws.once('error', rej);
  });
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    inbox.push(msg);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].match(msg)) {
        waiters[i].resolve(msg);
        waiters.splice(i, 1);
      }
    }
  });
  return {
    ws,
    open: () => opened,
    send: (obj) => ws.send(JSON.stringify(obj)),
    /** 条件に合うメッセージを待つ (既に届いていればそれを返す) */
    wait: (match, ms = 3000) =>
      new Promise((resolve, reject) => {
        const found = inbox.find(match);
        if (found) return resolve(found);
        const timer = setTimeout(() => reject(new Error('timeout: ' + match.toString())), ms);
        waiters.push({ match, resolve: (m) => { clearTimeout(timer); resolve(m); } });
      }),
    inbox,
    close: () => ws.close(),
  };
}

async function main() {
  if (!existsSync('dist')) {
    mkdirSync('dist', { recursive: true });
    writeFileSync('dist/index.html', '<!doctype html><title>placeholder</title>');
  }

  console.log('wrangler dev を起動中…');
  const wrangler = spawn(
    'npx',
    ['wrangler', 'dev', '--local', '--port', String(PORT), '--persist-to', '/tmp/tozanbu-test-state'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let log = '';
  wrangler.stdout.on('data', (d) => (log += d));
  wrangler.stderr.on('data', (d) => (log += d));

  const stop = () => {
    try {
      wrangler.kill('SIGTERM');
    } catch {
      /* すでに終了している */
    }
  };
  process.on('exit', stop);

  // 起動待ち
  let up = false;
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    try {
      const r = await fetch(`${BASE}/api/mountains?limit=1`);
      if (r.ok) {
        up = true;
        break;
      }
    } catch {
      /* まだ起動していない */
    }
  }
  if (!up) {
    console.error('wrangler dev が起動しなかった\n' + log.slice(-2000));
    process.exit(1);
  }
  console.log('起動した\n');

  // --- 山の記録 API ---
  const id = `MTEST${Date.now().toString(36).toUpperCase()}-3`;
  const seed = 4242;

  let res = await fetch(`${BASE}/api/mountains/${id}`);
  let body = await res.json();
  check('未登録の山は null を返す', body.mountain === null);

  res = await fetch(`${BASE}/api/mountains/${id}/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ seed, difficulty: 3, name: '試験岳', by: 'あさひ', party: ['あさひ', 'みなみ'] }),
  });
  body = await res.json();
  check('初登頂で命名できる', body.mountain?.name === '試験岳', JSON.stringify(body.mountain?.name));
  check('初登頂者が記録される', body.mountain?.firstAscentBy === 'あさひ');
  check('パーティーが記録される', body.mountain?.firstAscentParty?.length === 2);
  check('登頂者数が1', body.mountain?.ascents === 1);
  const firstAt = body.mountain?.firstAscentAt;

  res = await fetch(`${BASE}/api/mountains/${id}/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ seed, difficulty: 3, name: '横取り岳', by: 'よこどり' }),
  });
  body = await res.json();
  check('命名済みの山は改名されない', body.mountain?.name === '試験岳');
  check('初登頂日時は変わらない', body.mountain?.firstAscentAt === firstAt);
  check('登頂者数だけ増える', body.mountain?.ascents === 2);

  res = await fetch(`${BASE}/api/mountains/${id}/ascent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ seed, difficulty: 3, by: 'さんにんめ' }),
  });
  body = await res.json();
  check('登頂の追加記録', body.mountain?.ascents === 3);

  res = await fetch(`${BASE}/api/mountains?limit=10`);
  body = await res.json();
  check('一覧に載る', body.mountains?.some((m) => m.id === id));

  // --- パーティー同期 ---
  const url = `${WS}/ws?mountain=${id}&room=test`;
  const a = client(url);
  const b = client(url);
  await a.open();
  a.send({ t: 'join', mountain: id, name: 'あさひ', x: 1, y: 2, z: 3 });
  const welcomeA = await a.wait((m) => m.t === 'welcome');
  check('1人目の welcome', welcomeA.players.length === 0, `players=${welcomeA.players.length}`);

  await b.open();
  b.send({ t: 'join', mountain: id, name: 'みなみ', x: 4, y: 5, z: 6 });
  const welcomeB = await b.wait((m) => m.t === 'welcome');
  check('2人目の welcome に先客がいる', welcomeB.players.length === 1 && welcomeB.players[0].name === 'あさひ');
  const joined = await a.wait((m) => m.t === 'joined');
  check('先客に合流が通知される', joined.p.name === 'みなみ');

  a.send({ t: 's', x: 10, y: 20, z: 30, yaw: 1.5, a: 'CLIMB', cur: 55, max: 90 });
  const state = await b.wait((m) => m.t === 's');
  check('位置が中継される', state.x === 10 && state.a === 'CLIMB' && state.cur === 55);

  a.send({ t: 'trail', c: [100, 180, 101, 200] });
  const trail = await b.wait((m) => m.t === 'trail');
  check('踏み跡が中継される', trail.c.length === 4 && trail.c[1] === 180);

  a.send({ t: 'rope', r: { wallId: 'w1_2', x: 1, y: 2, z: 3, height: 12 } });
  const rope = await b.wait((m) => m.t === 'rope');
  check('ロープが共有される', rope.r.wallId === 'w1_2' && rope.r.by === 'あさひ');

  // ブリーフィングの書き込み
  a.send({ t: 'mark', m: { id: '7', hue: 2, by: 'なりすまし', pts: [0.5, 0.4, 0.6, 0.45] } });
  const mark = await b.wait((m) => m.t === 'mark');
  check('地図の書き込みが共有される', mark.m.pts.length === 4 && mark.m.hue === 2);
  check('書き込みの名前はサーバが入れる', mark.m.by === 'あさひ', `by=${mark.m.by}`);

  a.send({ t: 'mark', m: { id: '8', hue: 2, by: 'x', pts: [3.5, -2, 0.5, 0.5] } });
  const clamped = await b.wait((m) => m.t === 'mark' && m.m.id.endsWith(':8'));
  check('地図の外へは描けない', clamped.m.pts[0] === 1 && clamped.m.pts[1] === 0);

  // 後から入った人が踏み跡とロープを受け取れるか
  const c = client(url);
  await c.open();
  c.send({ t: 'join', mountain: id, name: 'あとから', x: 0, y: 0, z: 0 });
  const welcomeC = await c.wait((m) => m.t === 'welcome');
  check('後続が踏み跡を受け取る', welcomeC.trail.length === 4, `trail=${welcomeC.trail.length}`);
  check('後続がロープを受け取る', welcomeC.ropes.length === 1);
  check('後続が地図の書き込みを受け取る', welcomeC.marks.length === 2, `marks=${welcomeC.marks?.length}`);
  check('後続が全員を受け取る', welcomeC.players.length === 2);

  a.send({ t: 'unmark' });
  const unmark = await b.wait((m) => m.t === 'unmark');
  check('書き込みの消去が共有される', unmark.by === 'あさひ');

  a.send({ t: 'record', record: { id, seed, difficulty: 3, name: '試験岳', ascents: 3, firstAscentBy: 'あさひ', firstAscentParty: ['あさひ'], firstAscentAt: firstAt } });
  const rec = await b.wait((m) => m.t === 'record');
  check('登頂記録が共有される', rec.record.name === '試験岳');

  c.close();
  await sleep(300);
  const left = await b.wait((m) => m.t === 'left');
  check('離脱が通知される', typeof left.id === 'string');

  // 別の山では同じ部屋名でも混ざらない
  const other = client(`${WS}/ws?mountain=MOTHER-1&room=test`);
  await other.open();
  other.send({ t: 'join', mountain: 'MOTHER-1', name: 'べつやま', x: 0, y: 0, z: 0 });
  await other.wait((m) => m.t === 'welcome');
  await sleep(300);
  check('別の山の部屋は独立している', !b.inbox.some((m) => m.t === 'joined' && m.p?.name === 'べつやま'));

  a.close();
  b.close();
  other.close();
  await sleep(200);
  stop();

  console.log(`\n${failures === 0 ? 'すべて成功' : `${failures} 件失敗`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
