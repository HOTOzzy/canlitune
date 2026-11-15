'use strict';
// node build.js  -> dist/index.html (single self-contained file)
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
const dir = __dirname;
const rd = f => fs.readFileSync(path.join(dir, f), 'utf8');
const dsp = rd('dsp-core.js'), presets = rd('presets.json'), artists = rd('artists.json'), musiclib = rd('musiclib.js'), beatgen = rd('beatgen.js');
JSON.parse(presets); JSON.parse(artists); // validate
if (/<\/script/i.test(dsp + presets + artists + musiclib)) throw new Error('</script> inside inlined code');
execFileSync(process.execPath, [path.join(dir, 'test', 'musiclib.test.js')]);
execFileSync(process.execPath, [path.join(dir, 'test', 'beatgen.test.js')]);
let tests = '';
try {
  const out = execFileSync(process.execPath, ['--expose-gc', path.join(dir, 'test', 'dsp.test.js')], { encoding: 'utf8' });
  tests = out.split('\n').filter(l => /^(PASS|FAIL)/.test(l)).map(l => {
    const m = l.match(/^(PASS|FAIL)\s+(.*?)\s{2}(.*)$/) || [null, l.slice(0, 4), l.slice(6), ''];
    const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    return `<tr><td>${m[1] === 'PASS' ? '✅' : '❌'} ${esc(m[2])}<br><span class="small">${esc(m[3] || '')}</span></td><td></td></tr>`;
  }).join('');
} catch (e) { throw new Error('tests failed, not building:\n' + (e.stdout || e.message)); }
const html = rd('template.html')
  .replace('__FONT_EXT__', () => fs.readFileSync(path.join(dir, 'assets/fonts/space-grotesk-latin-ext-wght-normal.woff2')).toString('base64'))
  .replace('__FONT_LATIN__', () => fs.readFileSync(path.join(dir, 'assets/fonts/space-grotesk-latin-wght-normal.woff2')).toString('base64'))
  .replace('__INFO__', () => rd('info.html').replace('__TESTS__', () => tests))
  .replace('__DSP__', () => dsp)
  .replace('__PRESETS__', () => presets)
  .replace('__ARTISTS__', () => artists)
  .replace('__MUSICLIB__', () => musiclib)
  .replace('__BEATGEN__', () => beatgen);
fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
fs.writeFileSync(path.join(dir, 'dist', 'index.html'), html);
console.log('dist/index.html', (html.length / 1024).toFixed(1), 'KiB');
// the native apps ship the same UI
for (const rel of ['../android/app/src/main/assets/index.html', '../ios/CanliTune/Resources/index.html']) {
  const dst = path.join(dir, rel); fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.writeFileSync(dst, html); console.log('->', rel);
}
