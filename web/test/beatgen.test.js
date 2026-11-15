'use strict';
const G = require('../beatgen.js'), M = require('../musiclib.js');
let fails = 0; const check = (n, ok, i = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}  ${i}`); if (!ok) fails++; };
const pc = G.parseChords('Fm | Db  Ab, Eb7 - F#m7b5 Bbmaj7 Csus4');
check('parseChords', !pc.error && pc.chords.length === 8 && pc.chords[0].pc === 5 && pc.chords[0].minor && pc.chords[1].pc === 1 && pc.chords[3].iv.length === 4 && pc.chords[4] === pc.chords[3] && pc.chords[6].iv[3] === 11 && pc.chords[7].iv[1] === 5, pc.error || '');
check('parseChords rejects garbage', !!G.parseChords('Fm Hx 12').error && !!G.parseChords('').error);
check('suggestChords', G.suggestChords(5, 'minor') === 'Fm C# G# D#' && G.suggestChords(0, 'major') === 'C G Am F');
const mono = (r) => { const m = new Float32Array(r.L.length); for (let i = 0; i < m.length; i++) m[i] = (r.L[i] + r.R[i]) / 2; return m; };
let chordHits = 0;
const cases = [['trap', 'Fm C# G# D#', 140, [[5, 'minor'], [8, 'major']]], ['pop', 'C G Am F', 116, [[0, 'major'], [9, 'minor']]], ['rnb', 'Am F C G', 88, [[9, 'minor'], [0, 'major']]],
  ['afro', 'F#m D A E', 104, [[6, 'minor'], [9, 'major']]], ['reggaeton', 'Bm G D A', 95, [[11, 'minor'], [2, 'major']]], ['house', 'Am F C G', 124, [[9, 'minor'], [0, 'major']]],
  ['drill', 'Cm G# D# A#', 142, [[0, 'minor'], [3, 'major']]], ['boombap', 'Dm A# F C', 90, [[2, 'minor'], [5, 'major']]], ['ballad', 'G D Em C', 72, [[7, 'major'], [4, 'minor']]]];
for (const [style, chords, bpm, keys] of cases) {
  const t0 = Date.now(), r = G.renderBeat({ chords: G.parseChords(chords).chords, bpm, style, seconds: 60, seed: 7 }), ms = Date.now() - t0;
  let pk = 0, fin = true, e = 0; for (let i = 0; i < r.L.length; i++) { const v = r.L[i]; if (!Number.isFinite(v) || !Number.isFinite(r.R[i])) fin = false; pk = Math.max(pk, Math.abs(v), Math.abs(r.R[i])); e += v * v; }
  const m = mono(r), k = M.detectKey(m, r.sr), b = M.detectBpm(m, r.sr), dc = M.detectChords(m, r.sr);
  const want = chords.split(' '), rot = dc ? want.some((_, s) => want.every((c, i) => dc.chords[(i + s) % dc.chords.length] === c)) && dc.chords.length === want.length : false;
  const tempoOk = [1, 2, 0.5].some(f => Math.abs(b.bpm - bpm * f) <= 1.5);
  check(`${style}: audio sane`, fin && pk <= 0.9 && pk > 0.8 && Math.abs(r.seconds - 60) < 20 && Math.sqrt(e / r.L.length) > 0.05, `${r.seconds.toFixed(0)} s, ${r.loops} loops, rendered in ${ms} ms`);
  const kc = G.keyFromChords(G.parseChords(chords).chords);
  check(`${style}: keyFromChords`, keys.some(([kk, s]) => kk === kc.key && s === kc.scale), `${M.keyLabel(kc.key, kc.scale)} | audio key estimate: ${M.keyLabel(k.key, k.scale)}, tempo estimate ${b.bpm} (true ${bpm})`);
  chordHits += rot ? 1 : 0; console.log(`${rot ? 'ok  ' : 'miss'}  ${style}: detectChords on "${chords}" `, dc ? `${dc.text} (conf ${dc.conf.toFixed(2)}, ${dc.changes} changes)` : 'null');
}
check('detectChords recovers the progression of at least 7 of 9 generated beats', chordHits >= 7, `${chordHits}/9`);
const a = G.renderBeat({ chords: G.parseChords('Am F').chords, bpm: 100, style: 'trap', seconds: 20, seed: 3 }), b2 = G.renderBeat({ chords: G.parseChords('Am F').chords, bpm: 100, style: 'trap', seconds: 20, seed: 3 }), c = G.renderBeat({ chords: G.parseChords('Am F').chords, bpm: 100, style: 'trap', seconds: 20, seed: 4 });
let same = true, diff = false; for (let i = 0; i < a.L.length; i += 97) { if (a.L[i] !== b2.L[i]) same = false; if (a.L[i] !== c.L[i]) diff = true; }
check('same seed -> identical beat, new seed -> different beat', same && diff);
console.log(`${fails} failed`); process.exit(fails ? 1 : 0);
