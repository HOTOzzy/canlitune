'use strict';
const M = require('../musiclib.js');
let fails = 0; const check = (n, ok, i = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}  ${i}`); if (!ok) fails++; };
// --- key names
check('parseKeyName', JSON.stringify([M.parseKeyName('F#m'), M.parseKeyName('Bb'), M.parseKeyName('C'), M.parseKeyName('Hm')]) ===
  JSON.stringify([{ key: 6, scale: 'minor' }, { key: 10, scale: 'major' }, { key: 0, scale: 'major' }, null]));
// --- LRC (invented test text)
const lrc = '[ti:Test]\n[ar:Nobody]\n[offset:500]\n[00:12.50]birinci satir\n[00:15.00][01:05.25]tekrar eden satir\n[00:20.1]<00:20.10>kelime <00:20.90>zamanli\n\n[00:30:00]son';
const p = M.parseLrc(lrc);
check('LRC: synced, 5 timed lines, sorted, offset applied', p.synced && p.lines.length === 5 && p.lines[0].t === 12 && p.lines[1].text === 'tekrar eden satir' && p.lines[4].t === 64.75, JSON.stringify(p.lines.map(l => l.t)));
check('LRC: word stamps stripped', p.lines[2].text === 'kelime zamanli' && Math.abs(p.lines[2].t - 19.6) < 1e-9);
check('LRC: lineAt', M.lineAt(p.lines, 5) === -1 && M.lineAt(p.lines, 14.6) === 1 && M.lineAt(p.lines, 500) === 4);
const plain = M.parseLrc('ilk satir\n\nikinci satir');
check('plain text -> unsynced lines', !plain.synced && plain.lines.length === 2);
// --- synthetic backing tracks: triads + bass + kick/hat pattern
const FS = 44100;
function track(chords, bpm, bars = 16) {
  const beat = 60 / bpm, n = Math.round(bars * 4 * beat * FS), x = new Float32Array(n); let seed = 3;
  const f = m => 440 * Math.pow(2, (m - 69) / 12);
  for (let i = 0; i < n; i++) {
    const t = i / FS, bar = Math.floor(t / (4 * beat)), ch = chords[bar % chords.length], tb = (t % beat);
    let v = 0;
    for (const m of ch) v += 0.12 * Math.sin(2 * Math.PI * f(m) * t) + 0.04 * Math.sin(4 * Math.PI * f(m) * t);
    v += 0.25 * Math.sin(2 * Math.PI * f(ch[0] - 24) * t);                                    // bass on the root
    v += 0.6 * Math.exp(-tb * 30) * Math.sin(2 * Math.PI * 55 * tb * (1 + 3 * Math.exp(-tb * 40)));  // kick every beat
    seed = (seed * 16807) % 2147483647; const th = (t % (beat / 2));
    v += 0.08 * Math.exp(-th * 80) * (seed / 2147483647 - 0.5);                               // hats on 8ths
    x[i] = v * 0.6;
  }
  return x;
}
const cases = [
  ['A minor  (Am F C G), 128 BPM', [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]], 128, [[9, 'minor'], [0, 'major']]],
  ['F# minor (F#m D A E), 84 BPM', [[54, 57, 61], [50, 54, 57], [57, 61, 64], [52, 56, 59]], 84, [[6, 'minor'], [9, 'major']]],
  ['G major  (G Em C D), 140 BPM', [[55, 59, 62], [52, 55, 59], [48, 52, 55], [50, 54, 57]], 140, [[7, 'major'], [4, 'minor']]],
  ['C minor  (Cm Ab Eb Bb), 96 BPM', [[48, 51, 55], [56, 60, 63], [51, 55, 58], [58, 62, 65]], 96, [[0, 'minor'], [3, 'major']]],
];
for (const [name, chords, bpm, ok] of cases) {
  const x = track(chords, bpm), t0 = Date.now(), k = M.detectKey(x, FS), b = M.detectBpm(x, FS), ms = Date.now() - t0;
  // relative major/minor share the same 7 notes -> identical scale mask for the tuner, so either counts
  check(`key  ${name}`, ok.some(([kk, s]) => kk === k.key && s === k.scale), `detected ${M.keyLabel(k.key, k.scale)} (conf ${k.conf.toFixed(2)})`);
  const ratio = b.bpm / bpm;
  check(`tempo ${name}`, Math.abs(b.bpm - bpm) <= 1, `detected ${b.bpm} BPM (conf ${b.conf.toFixed(2)}), ${ms} ms for ${(x.length / FS).toFixed(0)} s`);
}
console.log(`${fails} failed`); process.exit(fails ? 1 : 0);
