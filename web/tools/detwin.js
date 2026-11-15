'use strict';
// Second pass after make_artists.py: makes sure no two presets sound alike. For every preset WITHOUT a published
// source, if its rendered sound is too close to an earlier preset, the single tone/space move that separates it most
// is applied (repeat up to 4 times). Sourced presets are never altered. Deterministic.
const fs = require('fs'), path = require('path'), T = require('../test/presets.test.js');
const dir = path.join(__dirname, '..'), af = path.join(dir, 'artists.json'), L = JSON.parse(fs.readFileSync(af, 'utf8')), P = JSON.parse(fs.readFileSync(path.join(dir, 'presets.json'), 'utf8'));
const MIN = 1.7, clamp = (v, a, b) => Math.max(a, Math.min(b, v)), full = a => Object.assign({}, L.base, L.styles[a.s].o, a.o);
const MOVES = [p => ({ airDb: clamp(p.airDb + 3, -9, 9) }), p => ({ airDb: clamp(p.airDb - 3, -9, 9) }), p => ({ bodyDb: clamp(p.bodyDb + 3, -9, 9) }), p => ({ bodyDb: clamp(p.bodyDb - 3, -9, 9) }),
  p => ({ presDb: clamp(p.presDb + 3, -9, 9) }), p => ({ presDb: clamp(p.presDb - 3, -9, 9) }), p => ({ revMix: clamp(p.revMix * 1.7 + 0.05, 0, 0.6), revTime: clamp(p.revTime * 1.25, 0.3, 4) }),
  p => ({ revMix: clamp(p.revMix * 0.45, 0.03, 0.6) }), p => ({ dlyMix: clamp(p.dlyMix + 0.1, 0, 0.35) }), p => ({ lpfHz: p.lpfHz > 9000 ? 9000 : clamp(p.lpfHz * 0.75, 4000, 20000) })];
const fixed = P.presets.map(a => T.features(a.params)); let changed = 0, stuck = 0;
for (const a of L.artists) {
  let f = T.features(full(a)); const nn = ff => fixed.reduce((m, g) => Math.min(m, T.dist(ff, g)), 1e9);
  if (!a.src) for (let it = 0; it < 4 && nn(f) < MIN; it++) {
    let best = null, bd = nn(f), bf = null; const p = full(a);
    for (const mv of MOVES) { const o = mv(p), ff = T.features(Object.assign({}, p, o)), d = nn(ff); if (d > bd + 0.05) { bd = d; best = o; bf = ff; } }
    if (!best) break; Object.assign(a.o, best); f = bf; changed++;
  }
  if (nn(f) < MIN) stuck++;
  fixed.push(f);
}
fs.writeFileSync(af, JSON.stringify(L));
console.log(`detwin: ${changed} moves applied, ${stuck} presets still closer than ${MIN} to an earlier one`);
