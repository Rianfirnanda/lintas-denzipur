import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { doc, getDoc, getDocs, collection, query, where, setDoc, updateDoc, deleteDoc, addDoc, serverTimestamp, Timestamp as CTs } from 'firebase/firestore';
import { ref, uploadBytes, getBytes } from 'firebase/storage';
import { adb, resetAll, makeUser, closeAll, expectCode, seedUnits, seedKegiatan, waitFor } from './helpers.mjs';

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
  lokasi: { lat: -5.0, lng: 100.0, acc: 10, capturedAtMs: Date.now() }, fotoPaths: [], status: 'draf',
  pemeriksaUid: null, diperiksaAt: null, catatanRevisi: null, createdAt: serverTimestamp(), updatedAt: serverTimestamp(), diajukanAt: null, ...extra,
});

test('13. alur laporan Draf → Diajukan → Perlu Revisi → Diajukan → Disetujui, hanya peran berwenang', async () => {
  const r = doc(collection(pelapor.db, 'laporan'));
  await setDoc(r, draf(pelapor.uid));
  // Orang lain tidak dapat membuat laporan atas nama pelapor / untuk kegiatan yang tidak ditugaskan.
  await expectCode(setDoc(doc(collection(lain.db, 'laporan')), draf(pelapor.uid)), 'permission-denied');
  await expectCode(setDoc(doc(collection(lain.db, 'laporan')), draf(lain.uid)), 'permission-denied');
  // Pelapor tidak dapat langsung menyetujui.
  await expectCode(updateDoc(doc(pelapor.db, 'laporan', r.id), { status: 'disetujui', updatedAt: serverTimestamp() }), 'permission-denied');
  // Pemeriksa tidak dapat memeriksa draf.
  await expectCode(updateDoc(doc(pemA.db, 'laporan', r.id), { status: 'disetujui', pemeriksaUid: pemA.uid, diperiksaAt: serverTimestamp(), updatedAt: serverTimestamp() }), 'permission-denied');
  await updateDoc(doc(pelapor.db, 'laporan', r.id), { status: 'diajukan', diajukanAt: serverTimestamp(), updatedAt: serverTimestamp() });
  // Pemeriksa unit lain & operator & pembaca tidak dapat memeriksa.
  for (const c of [pemB, opA, pembaca]) {
    await expectCode(updateDoc(doc(c.db, 'laporan', r.id), { status: 'disetujui', pemeriksaUid: c.uid, diperiksaAt: serverTimestamp(), updatedAt: serverTimestamp() }), 'permission-denied');
  }
  // Perlu revisi wajib catatan.
  await expectCode(updateDoc(doc(pemA.db, 'laporan', r.id), { status: 'perlu_revisi', pemeriksaUid: pemA.uid, diperiksaAt: serverTimestamp(), updatedAt: serverTimestamp() }), 'permission-denied');
  await updateDoc(doc(pemA.db, 'laporan', r.id), { status: 'perlu_revisi', catatanRevisi: 'Lengkapi uraian.', pemeriksaUid: pemA.uid, diperiksaAt: serverTimestamp(), updatedAt: serverTimestamp() });
  // Pelapor merevisi lalu mengajukan ulang.
  await updateDoc(doc(pelapor.db, 'laporan', r.id), { isi: 'Isi direvisi', updatedAt: serverTimestamp() });
  await updateDoc(doc(pelapor.db, 'laporan', r.id), { status: 'diajukan', diajukanAt: serverTimestamp(), updatedAt: serverTimestamp() });
  await updateDoc(doc(pemA.db, 'laporan', r.id), { status: 'disetujui', pemeriksaUid: pemA.uid, diperiksaAt: serverTimestamp(), updatedAt: serverTimestamp() });
  // Setelah disetujui: tidak dapat diubah atau dihapus siapa pun dari klien.
  for (const c of [pelapor, pemA, sys]) {
    await expectCode(updateDoc(doc(c.db, 'laporan', r.id), { isi: 'ubah', updatedAt: serverTimestamp() }), 'permission-denied');
    await expectCode(deleteDoc(doc(c.db, 'laporan', r.id)), 'permission-denied');
  }
  const d = (await adb.doc(`laporan/${r.id}`).get()).data();
  assert.equal(d.status, 'disetujui'); assert.equal(d.pemeriksaUid, pemA.uid);
  // Pemicu audit mencatat perubahan status (async).
  const a = await waitFor(async () => { const s = await adb.collection('audit').where('target', '==', r.id).get(); return s.size >= 4 ? s : null; });
  assert.ok(a, 'audit perubahan status (diajukan, perlu_revisi, diajukan, disetujui) tercatat');
});

test('laporan: lingkup baca sesuai peran', async () => {
  const r = doc(collection(pelapor.db, 'laporan'));
  await setDoc(r, draf(pelapor.uid, { status: 'diajukan', diajukanAt: serverTimestamp() }));
  for (const c of [pelapor, opA, pemA, sys]) assert.ok((await getDoc(doc(c.db, 'laporan', r.id))).exists());
  for (const c of [lain, opB, pemB, pembaca]) await expectCode(getDoc(doc(c.db, 'laporan', r.id)), 'permission-denied');
  const q = await getDocs(query(collection(pemA.db, 'laporan'), where('unitId', 'in', ['UNIT-A'])));
  assert.equal(q.size, 1);
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
  // Operator tidak dapat memindahkan kegiatan ke unit lain.
  await expectCode(updateDoc(doc(opA.db, 'kegiatan', k.id), { unitId: 'UNIT-B', updatedBy: opA.uid, updatedAt: serverTimestamp() }), 'permission-denied');
  const mine = await getDocs(query(collection(pelapor.db, 'kegiatan'), where('pesertaUids', 'array-contains', pelapor.uid)));
  assert.ok(mine.size >= 1);
  await expectCode(getDocs(query(collection(lain.db, 'kegiatan'), where('pesertaUids', 'array-contains', pelapor.uid))), 'permission-denied');
  await updateDoc(doc(opA.db, 'kegiatan', k.id), { status: 'selesai', updatedBy: opA.uid, updatedAt: serverTimestamp() });
  await expectCode(updateDoc(doc(opA.db, 'kegiatan', k.id), { status: 'berjalan', updatedBy: opA.uid, updatedAt: serverTimestamp() }), 'permission-denied');
});

test('15. Storage menolak akses dokumentasi yang tidak berwenang', async () => {
  const path = `laporan/UNIT-A/${pelapor.uid}/LAP1/foto1.jpg`;
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  await uploadBytes(ref(pelapor.storage, path), bytes, { contentType: 'image/jpeg' });
  // Tidak dapat menimpa / mengunggah atas nama orang lain / tipe lain.
  await expectCode(uploadBytes(ref(pelapor.storage, path), bytes, { contentType: 'image/jpeg' }), 'unauthorized', 'timpa');
  await expectCode(uploadBytes(ref(lain.storage, `laporan/UNIT-A/${pelapor.uid}/LAP1/x.jpg`), bytes, { contentType: 'image/jpeg' }), 'unauthorized', 'atas nama orang lain');
  await expectCode(uploadBytes(ref(pelapor.storage, `laporan/UNIT-B/${pelapor.uid}/LAP1/x.jpg`), bytes, { contentType: 'image/jpeg' }), 'unauthorized', 'unit lain');
  await expectCode(uploadBytes(ref(pelapor.storage, `laporan/UNIT-A/${pelapor.uid}/LAP1/x.html`), bytes, { contentType: 'text/html' }), 'unauthorized', 'tipe html');
  for (const c of [pelapor, opA, pemA, sys]) assert.equal((await getBytes(ref(c.storage, path))).byteLength, 4);
  for (const c of [lain, opB, pemB, pembaca]) await expectCode(getBytes(ref(c.storage, path)), 'unauthorized', `baca oleh ${c.email}`);
  // Perubahan akses berlaku di Storage setelah token klien diperbarui (klaim "dz").
  await sys.call('dzSetAccess', { uid: pemA.uid, role: 'pemeriksa', status: 'active', unitScope: ['UNIT-B'] });
  await pemA.auth.currentUser.getIdToken(true);
  await expectCode(getBytes(ref(pemA.storage, path)), 'unauthorized', 'pemeriksa setelah dipindah unit');
});

test('pengaturan: hanya sysadmin, nilai divalidasi', async () => {
  const ok = { staleMinutes: 5, captureIntervalSec: 15, sendIntervalSec: 30, maxQueue: 500, autoEndMinutes: 180, retentionDays: 90, updatedBy: sys.uid, updatedAt: serverTimestamp() };
  await setDoc(doc(sys.db, 'pengaturan', 'umum'), ok);
  await expectCode(setDoc(doc(sys.db, 'pengaturan', 'umum'), { ...ok, retentionDays: 5000 }), 'permission-denied');
  await expectCode(setDoc(doc(opA.db, 'pengaturan', 'umum'), { ...ok, updatedBy: opA.uid }), 'permission-denied');
  assert.equal((await getDoc(doc(pelapor.db, 'pengaturan', 'umum'))).data().staleMinutes, 5);
  await expectCode(getDocs(collection(opA.db, 'audit')), 'permission-denied');
});
