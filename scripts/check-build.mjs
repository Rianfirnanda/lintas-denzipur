// Pemeriksaan "build" untuk situs statis: sintaks JS, referensi file lokal, dan larangan rahasia di frontend.
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';

const PUB = 'public';
const errors = [];
const files = [];
(function walk(d) { for (const f of readdirSync(d)) { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : files.push(p); } })(PUB);

for (const f of files.filter((f) => extname(f) === '.js')) {
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); } catch (e) { errors.push(`Sintaks ${f}: ${e.stderr}`); }
}
for (const f of files.filter((f) => extname(f) === '.html')) {
  const html = readFileSync(f, 'utf8');
  for (const m of html.matchAll(/(?:src|href)="([^"#?]+)"/g)) {
    const ref = m[1];
    if (/^(https?:|mailto:|data:|javascript:)/.test(ref) || ref.startsWith('//') || ref.includes('${')) continue;
    if (!existsSync(join(dirname(f), ref))) errors.push(`${f}: referensi tidak ditemukan "${ref}"`);
  }
  for (const m of html.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)) {
    for (const im of m[1].matchAll(/from '(\.[^']+)'/g)) if (!existsSync(join(dirname(f), im[1]))) errors.push(`${f}: import tidak ditemukan ${im[1]}`);
  }
}
for (const f of files) {
  const t = readFileSync(f, 'utf8');
  if (/PRIVATE KEY|"private_key"|service_account/.test(t)) errors.push(`${f}: tampak berisi kredensial service account`);
}
for (const f of ['firebase.json', 'firestore.rules', 'firestore.indexes.json', '.firebaserc', 'public/js/dz-data.js']) {
  if (!existsSync(f)) errors.push(`Berkas wajib tidak ada: ${f}`);
}
JSON.parse(readFileSync('firestore.indexes.json', 'utf8'));
JSON.parse(readFileSync('firebase.json', 'utf8'));

if (errors.length) { console.error('GAGAL:\n' + errors.join('\n')); process.exit(1); }
console.log(`OK: ${files.length} file publik diperiksa (sintaks JS, referensi lokal, tanpa kredensial).`);
