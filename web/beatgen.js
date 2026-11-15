'use strict';
/* Original backing-track generator: the user gives chords + tempo + style, this synthesises drums, bass and
 * accompaniment from scratch (no samples, no melodies from existing songs). Deterministic for a given seed. */
const BG_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
function bgRng(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

// "Fm Db Ab Eb" | "Am - F G7" ("-" or "%" repeats the previous bar). One chord per bar.
function parseChords(str) {
  const toks = String(str || '').replace(/[|,;]/g, ' ').trim().split(/\s+/).filter(Boolean), out = [];
  for (const tok of toks) {
    if (tok === '%' || tok === '-') { if (out.length) out.push(out[out.length - 1]); continue; }
    const m = /^([A-Ga-g])([#b♯♭]?)(.*)$/.exec(tok); if (!m) return { error: tok, chords: [] };
    const pc = (BG_PC[m[1].toUpperCase()] + (m[2] === '#' || m[2] === '♯' ? 1 : m[2] ? -1 : 0) + 12) % 12, q = m[3].split('/')[0];
    if (!/^(m|min|maj|M|dim|aug|sus|add|\+|°|[0-9])*[0-9a-zA-Z+°]*$/.test(q)) return { error: tok, chords: [] };
    const dim = /dim|°/.test(q), minor = dim || /^m(?!aj)/.test(q), third = /sus2/.test(q) ? 2 : /sus/.test(q) ? 5 : minor ? 3 : 4, fifth = dim ? 6 : /aug|\+/.test(q) ? 8 : 7;
    const iv = [0, third, fifth]; if (/maj7|M7/.test(q)) iv.push(11); else if (/7|9/.test(q)) iv.push(dim ? 9 : 10);
    out.push({ pc, iv, minor, name: tok });
  }
  return out.length ? { chords: out } : { error: '(boş)', chords: [] };
}
// a sensible default progression for a key: minor i-VI-III-VII, major I-V-vi-IV
function suggestChords(key, scale) {
  const N = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'], n = d => N[(key + d) % 12];
  return scale === 'major' || scale === 'majPent' ? `${n(0)} ${n(7)} ${n(9)}m ${n(5)}` : `${n(0)}m ${n(8)} ${n(3)} ${n(10)}`;
}

// Key implied by a chord list: the major scale covering most chord tones (its relative minor if the first chord is that minor).
function keyFromChords(chords) {
  const MAJ = [0, 2, 4, 5, 7, 9, 11]; let best = -1, K = 0;
  for (let k = 0; k < 12; k++) { let sc = 0; for (const ch of chords) for (const iv of ch.iv.slice(0, 3)) if (MAJ.includes((ch.pc + iv - k + 24) % 12)) sc++;
    const f = chords[0]; if ((!f.minor && f.pc === k) || (f.minor && f.pc === (k + 9) % 12)) sc += 0.5;
    if (sc > best) { best = sc; K = k; } }
  const f = chords[0]; return f.minor && f.pc === (K + 9) % 12 ? { key: f.pc, scale: 'minor' } : { key: K, scale: 'major' };
}

const BG_STYLES = {
  trap:      { label: 'Trap', bpm: 140, kick: ['x.....x...x.....', 'x..x......x...x.', 'x.......x.x.....'], snare: '........x.......', clap: 1, hat: 'x.x.x.x.x.x.x.x.', rolls: 0.14, bass: '808', chord: 'pad', swing: 0 },
  drill:     { label: 'Drill', bpm: 142, kick: ['x..x......x..x..', 'x.....x...x..x..'], snare: '........x.....x.', clap: 0, hat: 'x..x..x.x..x..x.', rolls: 0.08, bass: '808', chord: 'pad', swing: 0 },
  pop:       { label: 'Pop', bpm: 116, kick: ['x.......x.x.....', 'x.....x.x.......'], snare: '....x.......x...', clap: 1, hat: 'x.x.x.x.x.x.x.x.', rolls: 0, bass: 'eighth', chord: 'keys', swing: 0 },
  rnb:       { label: 'R&B', bpm: 88, kick: ['x......x..x.....', 'x.........x..x..'], snare: '....x.......x...', clap: 0, hat: 'xxxxxxxxxxxxxxxx', rolls: 0.05, bass: 'sub', chord: 'pad', swing: 0.14 },
  afro:      { label: 'Afrobeats', bpm: 104, kick: ['x..x..x...x..x..', 'x.....x.x.....x.'], snare: '..x...x...x..x..', rim: 1, hat: 'xxxxxxxxxxxxxxxx', shaker: 1, rolls: 0, bass: 'synco', chord: 'pluck', swing: 0.08 },
  reggaeton: { label: 'Reggaeton', bpm: 95, kick: ['x...x...x...x...'], snare: '...x..x....x..x.', clap: 0, hat: 'x.x.x.x.x.x.x.x.', rolls: 0, bass: 'onkick', chord: 'pluck', swing: 0 },
  house:     { label: 'House', bpm: 124, kick: ['x...x...x...x...'], snare: '....x.......x...', clap: 1, clapOnly: 1, hat: '..o...o...o...o.', rolls: 0, bass: 'offbeat', chord: 'stab', swing: 0 },
  boombap:   { label: 'Boom bap', bpm: 90, kick: ['x......x.x......', 'x.........x.....'], snare: '....x.......x...', clap: 0, hat: 'x.x.x.x.x.x.x.x.', rolls: 0, bass: 'sub', chord: 'keys', swing: 0.17 },
  ballad:    { label: 'Balad', bpm: 72, kick: ['x.........x.....'], snare: '........x.......', rim: 1, hat: '', rolls: 0, bass: 'sub', chord: 'arp', swing: 0 },
};
const BASS_PAT = { eighth: [0, 2, 4, 6, 8, 10, 12, 14], sub: [0, 10], synco: [0, 3, 6, 10], offbeat: [2, 6, 10, 14] };

function bgTable(harm) { const n = 2048, t = new Float32Array(n + 1); let pk = 0; for (let i = 0; i <= n; i++) { let v = 0; for (let h = 0; h < harm.length; h++) v += harm[h] * Math.sin(2 * Math.PI * (h + 1) * i / n); t[i] = v; pk = Math.max(pk, Math.abs(v)); } for (let i = 0; i <= n; i++) t[i] /= pk; return t; }

function renderBeat(opt) {
  const sr = opt.sr || 48000, st = BG_STYLES[opt.style] || BG_STYLES.pop, bpm = Math.max(50, Math.min(220, opt.bpm || st.bpm)), rnd = bgRng((opt.seed | 0) || 1);
  let chords = opt.chords.slice(); if (!chords.length) throw new Error('akor yok');
  while (chords.length < 4) chords = chords.concat(opt.chords);
  const bars = chords.length, step = 60 / bpm / 4 * sr, barLen = step * 16, len = Math.round(barLen * bars);
  const mk = () => [new Float32Array(len), new Float32Array(len)];
  const C = mk(), B = mk(), D1 = mk(), D2 = mk();
  const stepPos = (bar, s) => bar * barLen + s * step + (s % 2 ? st.swing * step : 0);
  // ---------- one-shot drums ----------
  const shot = (dur, fn) => { const n = Math.round(dur * sr), a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = fn(i / sr, i); return a; };
  let ph = 0; const kick = shot(0.4, (t) => { ph += 2 * Math.PI * (44 + 130 * Math.exp(-t * 38)) / sr; return Math.sin(ph) * Math.exp(-t * 8.5) * Math.min(1, t * 2000) + 0.25 * Math.exp(-t * 400) * (rnd() - 0.5); });
  const hp = () => { let x1 = 0, x2 = 0; return v => { const y = v - 2 * x1 + x2; x2 = x1; x1 = v; return y * 0.3; }; };
  let f1 = hp(); const snare = shot(0.25, (t) => 0.75 * f1(rnd() * 2 - 1) * Math.exp(-t * 24) + 0.5 * Math.sin(2 * Math.PI * 185 * t) * Math.exp(-t * 34));
  f1 = hp(); const clap = shot(0.3, (t) => { const e = Math.exp(-((t % 0.011) * 260)) * (t < 0.033 ? 1 : 0) + (t >= 0.033 ? Math.exp(-(t - 0.033) * 26) : 0); return f1(rnd() * 2 - 1) * e * 0.9; });
  f1 = hp(); let f2 = hp(); const hatC = shot(0.06, (t) => f2(f1(rnd() * 2 - 1)) * Math.exp(-t * 95) * 1.6);
  f1 = hp(); f2 = hp(); const hatO = shot(0.32, (t) => f2(f1(rnd() * 2 - 1)) * Math.exp(-t * 13) * 1.4);
  const rim = shot(0.06, (t) => (Math.sin(2 * Math.PI * 1700 * t) + 0.5 * Math.sin(2 * Math.PI * 820 * t)) * Math.exp(-t * 90));
  const put = (buf, pos, smp, g, pan) => { const p0 = Math.round(pos), gl = g * (1 - Math.max(0, pan || 0)), gr = g * (1 + Math.min(0, pan || 0)); for (let i = 0; i < smp.length; i++) { const k = (p0 + i) % len; buf[0][k] += smp[i] * gl; buf[1][k] += smp[i] * gr; } };
  // ---------- pitched voices ----------
  const mf = m => 440 * Math.pow(2, (m - 69) / 12);
  const T_PAD = bgTable([1, 0.5, 0.33, 0.2, 0.12, 0.06]), T_KEYS = bgTable([1, 0.45, 0.22, 0.12, 0.05]), T_PLUCK = bgTable([1, 0.7, 0.45, 0.3, 0.2, 0.12, 0.08]), T_SUB = bgTable([1, 0.12]);
  const tone = (buf, pos, dur, freq, tab, amp, atk, decay, pan, detune) => {
    const n = Math.round((dur + 0.12) * sr), p0 = Math.round(pos), rel = 0.1 * sr, dN = dur * sr, aN = Math.max(1, atk * sr); let p1 = 0, p2 = 0; const inc = freq * 2048 / sr, inc2 = inc * (1 + (detune || 0));
    const gl = amp * (1 - Math.max(0, pan)), gr = amp * (1 + Math.min(0, pan));
    for (let i = 0; i < n; i++) {
      let e = Math.min(1, i / aN) * Math.exp(-decay * i / sr); if (i > dN) e *= Math.max(0, 1 - (i - dN) / rel);
      const a = p1 | 0, b = p2 | 0, v = (tab[a] + (tab[a + 1] - tab[a]) * (p1 - a) + (detune ? tab[b] + (tab[b + 1] - tab[b]) * (p2 - b) : 0)) * e;
      p1 += inc; if (p1 >= 2048) p1 -= 2048; p2 += inc2; if (p2 >= 2048) p2 -= 2048;
      const k = (p0 + i) % len; buf[0][k] += v * gl; buf[1][k] += v * gr;
    }
  };
  const bass808 = (pos, dur, freq, amp) => { const n = Math.round(dur * sr), p0 = Math.round(pos); let p = 0; for (let i = 0; i < n; i++) { const t = i / sr; p += 2 * Math.PI * freq * (1 + 0.5 * Math.exp(-t * 60)) / sr; const e = Math.min(1, i / 150) * Math.exp(-t * 2.2) * Math.min(1, (n - i) / 400); const v = Math.tanh(1.8 * Math.sin(p)) * e * amp, k = (p0 + i) % len; B[0][k] += v; B[1][k] += v; } };
  // ---------- per-bar content ----------
  const kp = st.kick[Math.floor(rnd() * st.kick.length)], kp2 = st.kick[Math.floor(rnd() * st.kick.length)];
  let prevTop = 64;
  for (let bar = 0; bar < bars; bar++) {
    const ch = chords[bar], kpat = bar % 2 ? kp2 : kp, lastBar = bar === bars - 1;
    // voicing: keep every chord tone inside one octave window that follows the previous chord (smooth voice leading)
    const lo = prevTop - 9, notes = ch.iv.map(iv => { let m = 48 + ch.pc + iv; while (m < lo) m += 12; while (m >= lo + 12) m -= 12; return m; }).sort((a, b) => a - b);
    prevTop = notes[notes.length - 1];
    const bassM = 24 + ((ch.pc + 12 - 4) % 12) + 4;   // E1..D#2
    // chords
    if (st.chord === 'pad') notes.forEach((m, i) => tone(C, bar * barLen, barLen / sr * 0.98, mf(m), T_PAD, 0.085, 0.09, 0.15, (i % 2 ? 0.35 : -0.35), 0.004));
    else if (st.chord === 'keys') for (const s of [0, 6, 10]) notes.forEach((m, i) => tone(C, stepPos(bar, s), step * 4 / sr, mf(m), T_KEYS, s ? 0.075 : 0.1, 0.004, 3.2, (i - 1) * 0.25, 0));
    else if (st.chord === 'stab') for (const s of [0, 3, 6, 10, 13]) notes.forEach((m, i) => tone(C, stepPos(bar, s), step * 1.4 / sr, mf(m + 12), T_PLUCK, 0.06, 0.003, 9, (i - 1) * 0.3, 0.003));
    else { const seq = st.chord === 'arp' ? [0, 1, 2, 1, 0, 1, 2, 1] : [0, 2, 1, 2, 0, 2, 1, 2]; for (let e = 0; e < 8; e++) { const m = notes[seq[e] % notes.length] + (st.chord === 'arp' ? 0 : 12); tone(C, stepPos(bar, e * 2), step * (st.chord === 'arp' ? 6 : 2.2) / sr, mf(m), st.chord === 'arp' ? T_KEYS : T_PLUCK, st.chord === 'arp' ? 0.1 : 0.075, 0.003, st.chord === 'arp' ? 2.2 : 7, e % 2 ? 0.3 : -0.3, 0); }
      if (st.chord === 'arp') tone(C, bar * barLen, barLen / sr, mf(notes[0] - 12), T_PAD, 0.07, 0.05, 0.4, 0, 0.003); }
    // bass
    if (st.bass === '808' || st.bass === 'onkick') { const hits = []; for (let s = 0; s < 16; s++) if (kpat[s] === 'x') hits.push(s);
      hits.forEach((s, i) => { const end = i + 1 < hits.length ? hits[i + 1] : 16, f = mf(bassM + (st.bass === '808' && i === hits.length - 1 && rnd() < 0.3 ? 12 : 0));
        if (st.bass === '808') bass808(stepPos(bar, s), (end - s) * step / sr, f, 0.55); else tone(B, stepPos(bar, s), step * 2.5 / sr, f * 2, T_SUB, 0.45, 0.004, 4, 0, 0); }); }
    else for (const s of BASS_PAT[st.bass]) tone(B, stepPos(bar, s), step * (st.bass === 'sub' ? 5.5 : 1.6) / sr, mf(bassM + 12), st.bass === 'sub' ? T_SUB : T_KEYS, st.bass === 'sub' ? 0.5 : 0.33, 0.005, st.bass === 'sub' ? 1.2 : 5, 0, 0);
    // drums: D1 = main groove, D2 = same with a fill in its last bar
    for (const [D, fill] of [[D1, false], [D2, lastBar]]) {
      for (let s = 0; s < 16; s++) {
        const pos = stepPos(bar, s), dropped = fill && s >= 8;
        if (kpat[s] === 'x' && !dropped) put(D, pos, kick, 0.9, 0);
        if (st.snare[s] === 'x') { if (!st.clapOnly) put(D, pos, st.rim ? rim : snare, st.rim ? 0.4 : 0.5, 0.1); if (st.clap) put(D, pos, clap, 0.38, -0.1); }
        if (fill && s >= 12) put(D, pos, snare, 0.25 + 0.08 * (s - 12), 0.1);
        const h = st.hat[s];
        if (h === 'o') put(D, pos, hatO, 0.2, 0.2);
        else if (h === 'x') { const g = (st.shaker ? 0.1 : 0.17) * (s % 4 === 0 ? 1 : 0.7 + 0.2 * rnd());
          if (st.rolls && rnd() < st.rolls && s < 15) { const k = rnd() < 0.5 ? 3 : 4; for (let r = 0; r < k; r++) put(D, pos + r * step * 2 / k, hatC, g * (0.6 + 0.4 * r / k), 0.2); }
          else put(D, pos, hatC, g, 0.2); }
      }
      if (st.hat && bar % 4 === 3 && !st.shaker && opt.style !== 'house') put(D, stepPos(bar, 14), hatO, 0.16, 0.2);
    }
  }
  // ---------- arrangement: intro (chords) -> grooves (fill every 4th loop) -> outro ----------
  const loopSec = len / sr, nLoops = Math.max(3, Math.round((opt.seconds || 150) / loopSec)), total = nLoops * len, L = new Float32Array(total), R = new Float32Array(total);
  for (let k = 0; k < nLoops; k++) {
    const intro = k === 0, outro = k === nLoops - 1 && nLoops >= 4, D = (k % 4 === 0 || k === nLoops - 2) ? D2 : D1, o = k * len;
    for (let i = 0; i < len; i++) { let l = C[0][i], r = C[1][i]; if (!intro) { l += B[0][i]; r += B[1][i]; } if (!intro && !outro) { l += D[0][i]; r += D[1][i]; } L[o + i] = l; R[o + i] = r; }
  }
  for (let i = 0, n = Math.min(total, Math.round(0.02 * sr)); i < n; i++) { L[i] *= i / n; R[i] *= i / n; }
  for (let i = 0, n = Math.min(total, Math.round(2 * sr)); i < n; i++) { const g = i / n; L[total - 1 - i] *= g; R[total - 1 - i] *= g; }
  let pk = 1e-9; for (let i = 0; i < total; i++) { const a = Math.abs(L[i]), b = Math.abs(R[i]); if (a > pk) pk = a; if (b > pk) pk = b; }
  const g = 0.89 / pk; for (let i = 0; i < total; i++) { L[i] *= g; R[i] *= g; }
  return { L, R, sr, bars, bpm, seconds: total / sr, loops: nLoops };
}
const BeatGen = { parseChords, suggestChords, keyFromChords, renderBeat, STYLES: BG_STYLES };
if (typeof module !== 'undefined') module.exports = BeatGen;
