// Mengisi EMULATOR dengan data uji fiktif (bukan data personel/koordinat nyata).
// Pemakaian: (emulator berjalan) node scripts/seed-emulator.mjs
process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST ||= '127.0.0.1:9099';
const PROJECT = 'demo-denzipur';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';

initializeApp({ projectId: PROJECT });
const db = getFirestore();
const auth = getAuth();
const PW = 'uji-emulator-123';

const users = [
  ['sysadmin', { role: 'sysadmin', unitId: null, unitScope: [] }, 'Admin Uji', 'Mayor'],
  ['operator.a', { role: 'operator', unitId: null, unitScope: ['UNIT-A'] }, 'Operator Uji A', 'Kapten'],
  ['pemeriksa.a', { role: 'pemeriksa', unitId: null, unitScope: ['UNIT-A'] }, 'Pemeriksa Uji A', 'Lettu'],
  ['pembaca.a', { role: 'pembaca', unitId: null, unitScope: ['UNIT-A'] }, 'Pembaca Uji A', 'Letda'],
  ['operator.b', { role: 'operator', unitId: null, unitScope: ['UNIT-B'] }, 'Operator Uji B', 'Kapten'],
  ['anggota1', { role: 'anggota', unitId: 'UNIT-A', unitScope: [] }, 'Anggota Uji Satu', 'Pratu'],
  ['anggota2', { role: 'anggota', unitId: 'UNIT-A', unitScope: [] }, 'Anggota Uji Dua', 'Prada'],
  ['anggota3', { role: 'anggota', unitId: 'UNIT-B', unitScope: [] }, 'Anggota Uji Tiga', 'Pratu'],
];
await db.doc('unit/UNIT-A').set({ nama: 'Unit Uji A', kode: 'A', keterangan: 'Data uji', updatedAt: Timestamp.now() });
await db.doc('unit/UNIT-B').set({ nama: 'Unit Uji B', kode: 'B', keterangan: 'Data uji', updatedAt: Timestamp.now() });
const uid = {};
for (const [k, a, nama, pangkat] of users) {
  const email = `${k}@denzipur.test`;
  let u; try { u = await auth.getUserByEmail(email); } catch { u = await auth.createUser({ email, password: PW, emailVerified: true, displayName: nama }); }
  uid[k] = u.uid;
  await db.doc(`akses/${u.uid}`).set({ uid: u.uid, email, status: 'active', ...a, createdAt: Timestamp.now(), updatedAt: Timestamp.now() });
  await db.doc(`personel/${u.uid}`).set({ uid: u.uid, email, nama, pangkat, jabatan: a.role === 'anggota' ? 'Anggota' : 'Staf', unitId: a.unitId, statusKeanggotaan: 'aktif' });
}
// Akun pending (registrasi tanpa undangan)
const pend = await auth.createUser({ email: 'pending@denzipur.test', password: PW, emailVerified: true }).catch(() => auth.getUserByEmail('pending@denzipur.test'));
await db.doc(`akses/${pend.uid}`).set({ uid: pend.uid, email: 'pending@denzipur.test', role: 'anggota', status: 'pending', unitId: null, unitScope: [], createdAt: Timestamp.now() });
await db.doc(`personel/${pend.uid}`).set({ uid: pend.uid, email: 'pending@denzipur.test', nama: 'Calon Uji', pangkat: '', jabatan: '', unitId: null, statusKeanggotaan: 'aktif' });

const now = Date.now();
const keg = (id, judul, unitId, peserta, status, offH) => db.doc(`kegiatan/${id}`).set({
  judul, deskripsi: 'Kegiatan uji (fiktif)', unitId, penanggungJawabUid: uid['operator.a'], pesertaUids: peserta.map((k) => uid[k]),
  jadwalMulai: Timestamp.fromMillis(now + offH * 3600_000), jadwalSelesai: null, lokasiNama: 'Lokasi fiktif', lokasiLat: null, lokasiLng: null,
  status, trackingDiizinkan: true, createdBy: uid.sysadmin, createdAt: Timestamp.now(), updatedBy: uid.sysadmin, updatedAt: Timestamp.now(),
});
await keg('KG-UJI-1', 'Latihan Uji Lapangan', 'UNIT-A', ['anggota1', 'anggota2'], 'rencana', -1);
await keg('KG-UJI-2', 'Pemeliharaan Alat Uji', 'UNIT-A', ['anggota1'], 'rencana', 24);
await keg('KG-UJI-3', 'Patroli Uji Unit B', 'UNIT-B', ['anggota3'], 'berjalan', -2);
await db.doc('pengaturan/umum').set({ staleMinutes: 2, captureIntervalSec: 5, sendIntervalSec: 10, maxQueue: 500, autoEndMinutes: 180, retentionDays: 90 });
await db.doc('pengaturan/bootstrap').set({ emails: ['bootstrap@denzipur.test'] });
await db.doc('titik_manual/TM-UJI-1').set({ nama: 'Pos uji (fiktif)', keterangan: 'Titik manual uji', unitId: 'UNIT-A', kegiatanId: null, lat: -3.79, lng: 102.26, createdBy: uid['operator.a'], updatedAt: Timestamp.now() });
console.log('Seed emulator selesai. Sandi semua akun uji:', PW);
