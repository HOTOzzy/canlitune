'use strict';
/* Pure helpers for karaoke mode: LRC parsing, key names, key + tempo estimation of the user's own backing track. */
const KEY_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLATS = { DB: 1, EB: 3, GB: 6, AB: 8, BB: 10 };

// "F#m" -> {key:6, scale:'minor'}, "Bb" -> {key:10, scale:'major'}; null if not a key name
function parseKeyName(s) {
  if (!s) return null;
  const m = /^([A-Ga-g])([#b]?)(m?)$/.exec(String(s).trim());
  if (!m) return null;
  const up = (m[1] + m[2]).toUpperCase();
  let k = up in FLATS ? FLATS[up] : KEY_NAMES.indexOf(up);
  if (k < 0) return null;
  return { key: k, scale: m[3] ? 'minor' : 'major' };
}

// LRC text -> { synced:boolean, lines:[{t:seconds|-1, text}] }. Plain text gives synced:false.
function parseLrc(txt) {
  const out = []; let synced = false, offset = 0;
  for (const raw of String(txt).replace(/\r/g, '').split('\n')) {
    const line = raw.trim();
    const off = /^\[offset:\s*([+-]?\d+)\s*\]$/i.exec(line);
    if (off) { offset = +off[1] / 1000; continue; }
    if (/^\[[a-z]+:.*\]$/i.test(line)) continue;                       // [ar:], [ti:], [by:] ...
    const stamps = []; let rest = line, m;
    while ((m = /^\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/.exec(rest))) {
      const frac = m[3] ? +m[3] / Math.pow(10, m[3].length) : 0;
      stamps.push(+m[1] * 60 + +m[2] + frac); rest = rest.slice(m[0].length);
    }
    const text = rest.replace(/<\d+:\d+(?:\.\d+)?>/g, '').trim();      // drop word-level stamps
    if (stamps.length) { synced = true; for (const t of stamps) out.push({ t: Math.max(0, t - offset), text }); }
    else if (line) out.push({ t: -1, text: line });
  }
  if (synced) { const s = out.filter(l => l.t >= 0); s.sort((a, b) => a.t - b.t); return { synced: true, lines: s }; }
  return { synced: false, lines: out };
}
// index of the line being sung at time t (binary search), -1 before the first line
function lineAt(lines, t) {
  let lo = 0, hi = lines.length - 1, r = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (lines[mid].t <= t) { r = mid; lo = mid + 1; } else hi = mid - 1; }
  return r;
}

function decimate(x, sr, target) {
  const f = Math.max(1, Math.round(sr / target)), n = Math.floor(x.length / f), y = new Float32Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let j = 0; j < f; j++) s += x[i * f + j]; y[i] = s / f; }
  return { y, sr: sr / f };
}

// Krumhansl-Kessler key profiles
const MAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MIN = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
function corr(a, b, rot) {
  let ma = 0, mb = 0; for (let i = 0; i < 12; i++) { ma += a[i]; mb += b[i]; } ma /= 12; mb /= 12;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < 12; i++) { const x = a[(i + rot) % 12] - ma, y = b[i] - mb; sab += x * y; saa += x * x; sbb += y * y; }
  return sab / Math.sqrt(saa * sbb + 1e-20);
}
// mono Float32Array -> { key, scale, conf(0..1), chroma }
function detectKey(mono, sr) {
  const d = decimate(mono, sr, 11025), x = d.y, fs = d.sr, N = 8192, hop = 4096;
  const chroma = new Float64Array(12), win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
  const notes = []; for (let m = 36; m <= 88; m++) { const f = 440 * Math.pow(2, (m - 69) / 12); if (f < fs * 0.45) notes.push([m % 12, 2 * Math.cos(2 * Math.PI * f / fs)]); }
  const fr = new Float32Array(N);
  for (let s = 0; s + N <= x.length; s += hop) {
    for (let i = 0; i < N; i++) fr[i] = x[s + i] * win[i];
    for (const [pc, c] of notes) {                                   // Goertzel
      let s1 = 0, s2 = 0;
      for (let i = 0; i < N; i++) { const s0 = fr[i] + c * s1 - s2; s2 = s1; s1 = s0; }
      chroma[pc] += Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - c * s1 * s2));
    }
  }
  let best = -2, second = -2, key = 0, scale = 'major';
  for (let k = 0; k < 12; k++) for (const [prof, name] of [[MAJ, 'major'], [MIN, 'minor']]) {
    const r = corr(chroma, prof, k);
    if (r > best) { second = best; best = r; key = k; scale = name; } else if (r > second) second = r;
  }
  return { key, scale, conf: Math.max(0, Math.min(1, (best - second) * 4 + (best > 0.6 ? 0.3 : 0))), chroma: Array.from(chroma) };
}
// mono Float32Array -> { bpm, conf }
function detectBpm(mono, sr) {
  const d = decimate(mono, sr, 11025), x = d.y, fs = d.sr, hop = 64, n = Math.floor(x.length / hop) - 1, rate = fs / hop;
  if (n < rate * 4) return { bpm: 0, conf: 0 };
  const env = new Float32Array(n); let prev = 0;
  for (let i = 0; i < n; i++) { let e = 0; for (let j = 0; j < hop * 6 && i * hop + j < x.length; j++)  /* ~32 ms window: longer than a bass period, so sustained notes don't ripple */ { const v = x[i * hop + j]; e += v * v; } const l = Math.log(1e-7 + e); env[i] = Math.max(0, l - prev); prev = l; }
  let mean = 0; for (let i = 0; i < n; i++) mean += env[i]; mean /= n; for (let i = 0; i < n; i++) env[i] -= mean;
  // autocorrelation of the onset envelope for every integer lag up to 4 beats at 60 BPM
  const maxLag = Math.min(n - 2, Math.ceil(4 * 60 * rate / 60) + 2), acf = new Float64Array(maxLag + 2);
  for (let lag = 0; lag <= maxLag; lag++) { let s = 0; for (let i = 0; i + lag < n; i++) s += env[i] * env[i + lag]; acf[lag] = s / (n - lag); }
  const at = lag => { if (lag >= maxLag) return 0; const l0 = Math.floor(lag), f = lag - l0; return (1 - f) * acf[l0] + f * acf[l0 + 1]; };
  let best = -1e9, bl = 0; const a0 = acf[0] + 1e-12;
  for (let bpm = 60; bpm <= 185; bpm += 0.25) {
    const lag = 60 * rate / bpm;
    // comb over 1,2,3,4 beats; subtracting the half-beat lags penalises picking half the true tempo's period
    let v = at(lag) + 0.6 * at(2 * lag) + 0.4 * at(3 * lag) + 0.5 * at(4 * lag) - 0.25 * (at(1.5 * lag) + at(2.5 * lag));
    v *= Math.exp(-0.5 * Math.pow(Math.log2(bpm / 110) / 0.75, 2));   // prior: most pop/rap tempi are 75-160
    if (v > best) { best = v; bl = bpm; }
  }
  return { bpm: Math.round(bl * 2) / 2, conf: Math.max(0, Math.min(1, best / a0)) };
}
function keyLabel(k, scale) { return KEY_NAMES[k] + (scale === 'minor' ? ' minör' : ' majör'); }

const MusicLib = { parseKeyName, parseLrc, lineAt, detectKey, detectBpm, keyLabel, KEY_NAMES };
if (typeof module !== 'undefined') module.exports = MusicLib;
