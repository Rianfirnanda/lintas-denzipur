// Migrasi data Denzipur LAMA (database Firestore default, dipakai bersama Lintas Benteng)
// ke database bernama "denzipur". Aman & dapat diulang:
//  - Default --dry-run: hanya membaca dan mencetak rencana. Tidak menulis apa pun.
//  - --apply: menulis ke database "denzipur" dengan ID deterministik (legacy_<id>); menjalankan ulang tidak menggandakan.
//  - TIDAK PERNAH menghapus/mengubah data di database default (data Lintas Benteng tidak disentuh).
//  - Kredensial: Application Default Credentials (gcloud auth application-default login) milik operator.
//    Jangan simpan service-account key di repositori.
//
// Pemakaian:
//   node scripts/migrate-from-default.mjs --project lintas-benteng --dry-run
//   node scripts/migrate-from-default.mjs --project lintas-benteng --apply --unit-default UNIT-ID
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

const arg = (k, d = null) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const APPLY = process.argv.includes('--apply');
const PROJECT = arg('--project');
const UNIT_DEFAULT = arg('--unit-default', 'TANPA_UNIT');
if (!PROJECT) { console.error('Wajib: --project <id>'); process.exit(1); }
if (APPLY && process.argv.includes('--dry-run')) { console.error('Pilih salah satu: --dry-run atau --apply'); process.exit(1); }

initializeApp({ credential: applicationDefault(), projectId: PROJECT });
const src = getFirestore();             // database default (Benteng + Denzipur lama) — HANYA DIBACA
const dst = getFirestore('denzipur');   // database Denzipur baru

const plan = { akses: [], laporan: [], titikManual: [], dilewati: [] };
const ms = (d) => d.createdAt?.toMillis?.() ?? (typeof d.createdAt === 'number' ? d.createdAt : null) ?? (d.createdAtServer?.toMillis?.() ?? d.tanggalMillis ?? null);

// 1) Akun: koleksi "lintas" (admin Denzipur lama) dan "users" role "user-denzipur".
const lintas = await src.collection('lintas').get();
for (const d of lintas.docs) {
  const x = d.data();
  const role = x.role === 'admin' ? 'sysadmin' : 'anggota';
  const status = ['active', 'blocked', 'pending'].includes(x.status) ? x.status : 'pending';
  plan.akses.push({ uid: d.id, email: x.email || '', role, status: role === 'anggota' && status === 'active' ? 'pending' : status, sumber: 'lintas' });
}
const dzUsers = await src.collection('users').where('role', '==', 'user-denzipur').get();
for (const d of dzUsers.docs) {
  if (plan.akses.some((a) => a.uid === d.id)) continue;
  const x = d.data();
  // Anggota lama belum punya unit → dimigrasikan sebagai "pending" agar sysadmin menetapkan unit & mengaktifkan.
  plan.akses.push({ uid: d.id, email: x.email || '', role: 'anggota', status: x.status === 'blocked' ? 'blocked' : 'pending', sumber: 'users', nama: x.displayName || x.nama || x.name || '' });
}

// 2) Laporan lama "lintas_kegiatan" → laporan (status Diajukan, ditandai legacy).
const keg = await src.collection('lintas_kegiatan').get();
for (const d of keg.docs) {
  const x = d.data();
  if (!x.userId) { plan.dilewati.push(`lintas_kegiatan/${d.id}: tanpa userId`); continue; }
  const lat = Number(x.lat), lng = Number(x.lng);
  plan.laporan.push({
    id: `legacy_${d.id}`, uid: x.userId, unitId: UNIT_DEFAULT, kegiatanId: `legacy_tanpa_kegiatan`, kegiatanJudul: x.judul || '(kegiatan lama)',
    judul: String(x.judul || 'Laporan lama').slice(0, 160), isi: String(x.catatan || x.deskripsi || '').slice(0, 5000),
    lokasi: Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng, acc: 0, capturedAtMs: ms(x) || 0 } : null,
    fotoPaths: [], fotoUrlLama: typeof x.fotoUrl === 'string' ? x.fotoUrl : null, status: 'diajukan',
    pemeriksaUid: null, diperiksaAt: null, catatanRevisi: null, legacy: true, sumberLama: `lintas_kegiatan/${d.id}`,
    createdAtMs: ms(x),
  });
}

// 3) Titik manual "lintas_tracking".
const man = await src.collection('lintas_tracking').get();
for (const d of man.docs) {
  const x = d.data(); const lat = Number(x.lat), lng = Number(x.lng);
  if (!(Number.isFinite(lat) && Number.isFinite(lng))) { plan.dilewati.push(`lintas_tracking/${d.id}: koordinat tidak valid`); continue; }
  plan.titikManual.push({ id: `legacy_${d.id}`, nama: String(x.nama || 'Titik lama').slice(0, 120), keterangan: String(x.keterangan || '').slice(0, 500), unitId: UNIT_DEFAULT, kegiatanId: null, lat, lng });
}

console.log(`Mode: ${APPLY ? 'APPLY (menulis ke database "denzipur")' : 'DRY-RUN (tidak menulis)'}`);
console.log(`Akun: ${plan.akses.length} (sysadmin: ${plan.akses.filter((a) => a.role === 'sysadmin').length})`);
console.log(`Laporan lama: ${plan.laporan.length} (dengan lokasi: ${plan.laporan.filter((l) => l.lokasi).length}, dengan foto lama: ${plan.laporan.filter((l) => l.fotoUrlLama).length})`);
console.log(`Titik manual: ${plan.titikManual.length}`);
console.log(`Dilewati: ${plan.dilewati.length}`); plan.dilewati.slice(0, 20).forEach((s) => console.log('  - ' + s));
if (!APPLY) { console.log('\nTidak ada yang ditulis. Jalankan dengan --apply setelah meninjau angka di atas.'); process.exit(0); }

let w = 0;
const writer = dst.bulkWriter();
for (const a of plan.akses) {
  const ref = dst.doc(`akses/${a.uid}`);
  if ((await ref.get()).exists) continue; // jangan timpa akses yang sudah diatur di sistem baru
  writer.set(ref, { uid: a.uid, email: a.email, role: a.role, status: a.status, unitId: null, unitScope: [], createdAt: Timestamp.now(), updatedAt: Timestamp.now(), updatedBy: 'migrasi' });
  writer.set(dst.doc(`personel/${a.uid}`), { uid: a.uid, email: a.email, nama: a.nama || a.email, pangkat: '', jabatan: '', unitId: null, statusKeanggotaan: 'aktif', createdAt: Timestamp.now() }, { merge: true });
  w += 2;
}
for (const l of plan.laporan) {
  const { id, createdAtMs, ...rest } = l;
  writer.set(dst.doc(`laporan/${id}`), { ...rest, createdAt: createdAtMs ? Timestamp.fromMillis(createdAtMs) : Timestamp.now(), updatedAt: Timestamp.now(), diajukanAt: createdAtMs ? Timestamp.fromMillis(createdAtMs) : null }, { merge: true });
  w++;
}
for (const t of plan.titikManual) { const { id, ...rest } = t; writer.set(dst.doc(`titik_manual/${id}`), { ...rest, createdBy: 'migrasi', updatedAt: Timestamp.now() }, { merge: true }); w++; }
writer.set(dst.collection('audit').doc(), { jenis: 'migrasi', actorUid: 'skrip', unitId: null, ringkasan: `Migrasi dari database default: ${plan.akses.length} akun, ${plan.laporan.length} laporan, ${plan.titikManual.length} titik manual`, target: null, detail: null, at: Timestamp.now() });
await writer.close();
console.log(`Selesai: ${w} penulisan. Data di database default tidak diubah.`);
