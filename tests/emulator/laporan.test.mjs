import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { F, adb, resetAll, makeUser, closeAll, expectCode, seedUnits, seedKegiatan } from './helpers.mjs';

const { doc, getDoc, getDocs, collection, query, where, setDoc, updateDoc, deleteDoc, addDoc, writeBatch, serverTimestamp, Timestamp: CTs } = F;
let pelapor, lain, opA, opB, pemA, pemB, pembaca, sys;
beforeEach(async () => {
  await closeAll();
  await resetAll();
  await seedUnits();
  pelapor = await makeUser('pelapor', { role: 'anggota', unitId: 'UNIT-A' });
  lain = await makeUser('lain', { role: 'anggota', unitId: 'UNIT-A' });
  opA = await makeUser('opA', { role: 'operator', unitScope: ['UNIT-A'] });
  opB = await makeUser('opB', { role: 'operator', unitScope: ['UNIT-B'] });
  pemA = await makeUser('pemA', { role: 'pemeriksa', unitScope: ['UNIT-A'] });
  pemB = await makeUser('pemB', { role: 'pemeriksa', unitScope: ['UNIT-B'] });
  pembaca = await makeUser('pembaca', { role: 'pembaca', unitScope: ['UNIT-A'] });
  sys = await makeUser('sys', { role: 'sysadmin' });
  await seedKegiatan('KG1', 'UNIT-A', [pelapor.uid]);
});
after(closeAll);

const draf = (uid, extra = {}) => ({
  uid, unitId: 'UNIT-A', kegiatanId: 'KG1', kegiatanJudul: 'Kegiatan uji KG1', judul: 'Laporan uji', isi: 'Isi fiktif',
  lokasi: { lat: -5.0, lng: 100.0, acc: 10, capturedAtMs: Date.now() }, fotoIds: [], status: 'draf',
  pemeriksaUid: null, diperiksaAt: null, catatanRevisi: null, createdAt: serverTimestamp(), updatedAt: serverTimestamp(), diajukanAt: null, ...extra,
});
const review = (status, uid, catatan = null) => ({ status, catatanRevisi: catatan, pemeriksaUid: uid, diperiksaAt: serverTimestamp(), updatedAt: serverTimestamp() });

test('13. alur laporan Draf → Diajukan → Perlu Revisi → Diajukan → Disetujui, hanya peran berwenang', async () => {
  const r = doc(collection(pelapor.db, 'laporan'));
  await setDoc(r, draf(pelapor.uid));
  await expectCode(setDoc(doc(collection(lain.db, 'laporan')), draf(pelapor.uid)), 'permission-denied');
  await expectCode(setDoc(doc(collection(lain.db, 'laporan')), draf(lain.uid)), 'permission-denied');
  await expectCode(updateDoc(doc(pelapor.db, 'laporan', r.id), { status: 'disetujui', updatedAt: serverTimestamp() }), 'permission-denied');
  await expectCode(updateDoc(doc(pemA.db, 'laporan', r.id), review('disetujui', pemA.uid)), 'permission-denied');
  await updateDoc(doc(pelapor.db, 'laporan', r.id), { status: 'diajukan', diajukanAt: serverTimestamp(), updatedAt: serverTimestamp() });
  for (const c of [pemB, opA, pembaca]) await expectCode(updateDoc(doc(c.db, 'laporan', r.id), review('disetujui', c.uid)), 'permission-denied');
  await expectCode(updateDoc(doc(pemA.db, 'laporan', r.id), review('perlu_revisi', pemA.uid)), 'permission-denied');
  await updateDoc(doc(pemA.db, 'laporan', r.id), review('perlu_revisi', pemA.uid, 'Lengkapi uraian.'));
  await updateDoc(doc(pelapor.db, 'laporan', r.id), { isi: 'Isi direvisi', updatedAt: serverTimestamp() });
  await updateDoc(doc(pelapor.db, 'laporan', r.id), { status: 'diajukan', diajukanAt: serverTimestamp(), updatedAt: serverTimestamp() });
  await updateDoc(doc(pemA.db, 'laporan', r.id), review('disetujui', pemA.uid));
  for (const c of [pelapor, pemA, sys]) {
    await expectCode(updateDoc(doc(c.db, 'laporan', r.id), { isi: 'ubah', updatedAt: serverTimestamp() }), 'permission-denied');
    await expectCode(deleteDoc(doc(c.db, 'laporan', r.id)), 'permission-denied');
  }
  const d = (await adb.doc(`laporan/${r.id}`).get()).data();
  assert.equal(d.status, 'disetujui'); assert.equal(d.pemeriksaUid, pemA.uid);
});

test('laporan: lingkup baca sesuai peran', async () => {
  const r = doc(collection(pelapor.db, 'laporan'));
  await setDoc(r, draf(pelapor.uid, { status: 'diajukan', diajukanAt: serverTimestamp() }));
  for (const c of [pelapor, opA, pemA, sys]) assert.ok((await getDoc(doc(c.db, 'laporan', r.id))).exists());
  for (const c of [lain, opB, pemB, pembaca]) await expectCode(getDoc(doc(c.db, 'laporan', r.id)), 'permission-denied');
  assert.equal((await getDocs(query(collection(pemA.db, 'laporan'), where('unitId', 'in', ['UNIT-A'])))).size, 1);
  await expectCode(getDocs(collection(pemA.db, 'laporan')), 'permission-denied');
});

test('kegiatan: operator hanya mengelola unitnya; peserta membaca kegiatannya', async () => {
  const base = {
    judul: 'Apel pagi uji', deskripsi: '', unitId: 'UNIT-A', penanggungJawabUid: opA.uid, pesertaUids: [pelapor.uid],
    jadwalMulai: CTs.now(), jadwalSelesai: null, lokasiNama: 'Lapangan fiktif', lokasiLat: null, lokasiLng: null,
    status: 'rencana', trackingDiizinkan: true, createdBy: opA.uid, createdAt: serverTimestamp(), updatedBy: opA.uid, updatedAt: serverTimestamp(),
  };
  const k = await addDoc(collection(opA.db, 'kegiatan'), base);
  await expectCode(addDoc(collection(opB.db, 'kegiatan'), { ...base, createdBy: opB.uid, updatedBy: opB.uid }), 'permission-denied');
  await expectCode(addDoc(collection(pelapor.db, 'kegiatan'), { ...base, createdBy: pelapor.uid, updatedBy: pelapor.uid }), 'permission-denied');
  await expectCode(addDoc(collection(opA.db, 'kegiatan'), { ...base, status: 'aneh' }), 'permission-denied');
  await expectCode(updateDoc(doc(opA.db, 'kegiatan', k.id), { unitId: 'UNIT-B', updatedBy: opA.uid, updatedAt: serverTimestamp() }), 'permission-denied');
  // Peserta tidak dapat mengubah status kegiatan di luar alur mulai tracking.
  await expectCode(updateDoc(doc(pelapor.db, 'kegiatan', k.id), { status: 'berjalan', updatedBy: pelapor.uid, updatedAt: serverTimestamp() }), 'permission-denied');
  assert.ok((await getDocs(query(collection(pelapor.db, 'kegiatan'), where('pesertaUids', 'array-contains', pelapor.uid)))).size >= 1);
  await expectCode(getDocs(query(collection(lain.db, 'kegiatan'), where('pesertaUids', 'array-contains', pelapor.uid))), 'permission-denied');
  await updateDoc(doc(opA.db, 'kegiatan', k.id), { status: 'selesai', updatedBy: opA.uid, updatedAt: serverTimestamp() });
  await expectCode(updateDoc(doc(opA.db, 'kegiatan', k.id), { status: 'berjalan', updatedBy: opA.uid, updatedAt: serverTimestamp() }), 'permission-denied');
});

test('15. foto dokumentasi mengikuti lingkup laporan dan tidak dapat diubah setelah diajukan', async () => {
  const data = 'data:image/jpeg;base64,' + 'A'.repeat(2000);
  const foto = { data, mime: 'image/jpeg', w: 10, h: 10, uid: pelapor.uid, createdAt: serverTimestamp() };
  const r = doc(collection(pelapor.db, 'laporan'));
  const b = writeBatch(pelapor.db);
  b.set(r, draf(pelapor.uid, { fotoIds: ['f1'] }));
  b.set(doc(r, 'foto', 'f1'), foto);
  await b.commit();
  // Foto yang tidak tercantum di laporan / milik orang lain / tipe lain / terlalu besar ditolak.
  await expectCode(setDoc(doc(r, 'foto', 'f2'), foto), 'permission-denied', 'tidak tercantum');
  await expectCode(setDoc(doc(lain.db, 'laporan', r.id, 'foto', 'f1'), { ...foto, uid: lain.uid }), 'permission-denied', 'orang lain');
  const b2 = writeBatch(pelapor.db);
  b2.update(r, { fotoIds: ['f1', 'f3'], updatedAt: serverTimestamp() });
  b2.set(doc(r, 'foto', 'f3'), { ...foto, mime: 'image/svg+xml' });
  await expectCode(b2.commit(), 'permission-denied', 'svg');
  const b3 = writeBatch(pelapor.db);
  b3.update(r, { fotoIds: ['f1', 'f4'], updatedAt: serverTimestamp() });
  b3.set(doc(r, 'foto', 'f4'), { ...foto, data: 'data:image/jpeg;base64,' + 'A'.repeat(1000000) });
  await expectCode(b3.commit(), 'permission-denied', 'terlalu besar');
  await expectCode(setDoc(doc(r, 'foto', 'f1'), foto), 'permission-denied', 'timpa');
  // Baca: pemilik, operator & pemeriksa unit, sysadmin. Bukan: anggota lain, unit lain, pembaca.
  await updateDoc(r, { status: 'diajukan', diajukanAt: serverTimestamp(), updatedAt: serverTimestamp() });
  for (const c of [pelapor, opA, pemA, sys]) assert.equal((await getDoc(doc(c.db, 'laporan', r.id, 'foto', 'f1'))).data().mime, 'image/jpeg');
  for (const c of [lain, opB, pemB, pembaca]) await expectCode(getDoc(doc(c.db, 'laporan', r.id, 'foto', 'f1')), 'permission-denied', `baca oleh ${c.email}`);
  // Setelah diajukan: foto tidak dapat ditambah atau dihapus.
  await expectCode(deleteDoc(doc(r, 'foto', 'f1')), 'permission-denied', 'hapus setelah diajukan');
});

test('pengaturan: hanya sysadmin, nilai divalidasi; audit hanya dibaca sysadmin', async () => {
  const ok = { staleMinutes: 5, captureIntervalSec: 30, sendIntervalSec: 60, maxQueue: 500, autoEndMinutes: 180, retentionDays: 90, updatedBy: sys.uid, updatedAt: serverTimestamp() };
  await setDoc(doc(sys.db, 'pengaturan', 'umum'), ok);
  await expectCode(setDoc(doc(sys.db, 'pengaturan', 'umum'), { ...ok, retentionDays: 5000 }), 'permission-denied');
  await expectCode(setDoc(doc(opA.db, 'pengaturan', 'umum'), { ...ok, updatedBy: opA.uid }), 'permission-denied');
  assert.equal((await getDoc(doc(pelapor.db, 'pengaturan', 'umum'))).data().staleMinutes, 5);
  await expectCode(getDocs(collection(opA.db, 'audit')), 'permission-denied');
  // Anggota tidak dapat menulis audit; staf hanya atas namanya sendiri.
  await expectCode(addDoc(collection(pelapor.db, 'audit'), { jenis: 'palsu', actorUid: pelapor.uid, unitId: null, ringkasan: 'x', target: null, at: serverTimestamp() }), 'permission-denied');
  await expectCode(addDoc(collection(opA.db, 'audit'), { jenis: 'palsu', actorUid: sys.uid, unitId: null, ringkasan: 'x', target: null, at: serverTimestamp() }), 'permission-denied');
  await addDoc(collection(opA.db, 'audit'), { jenis: 'ekspor_laporan', actorUid: opA.uid, unitId: null, ringkasan: 'uji', target: null, at: serverTimestamp() });
});
