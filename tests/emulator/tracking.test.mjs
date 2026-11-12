import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { doc, getDoc, getDocs, collection, query, where, setDoc, onSnapshot } from 'firebase/firestore';
import { adb, Timestamp, resetAll, makeUser, closeAll, expectCode, sleep, seedUnits, seedKegiatan, P } from './helpers.mjs';

let anggota, anggota2, opA, opB, sys;
beforeEach(async () => {
  await closeAll();
  await resetAll();
  await seedUnits();
  anggota = await makeUser('anggota1', { role: 'anggota', unitId: 'UNIT-A' });
  anggota2 = await makeUser('anggota2', { role: 'anggota', unitId: 'UNIT-A' });
  opA = await makeUser('opA', { role: 'operator', unitScope: ['UNIT-A'] });
  opB = await makeUser('opB', { role: 'operator', unitScope: ['UNIT-B'] });
  sys = await makeUser('sys', { role: 'sysadmin' });
  await seedKegiatan('KG1', 'UNIT-A', [anggota.uid, anggota2.uid]);
  await seedKegiatan('KG2', 'UNIT-A', [anggota.uid]);
});
after(closeAll);

const DEV = 'perangkat-uji-01';

test('1. mulai → kirim lokasi → tampil di admin (operator) → akhiri sesi', async () => {
  const s = await anggota.call('dzStartSession', { kegiatanId: 'KG1', deviceId: DEV });
  assert.ok(s.sessionId);
  // Operator berlangganan lokasi terkini unitnya (seperti dashboard).
  const seen = [];
  const unsub = onSnapshot(query(collection(opA.db, 'lokasi_terkini'), where('unitId', 'in', ['UNIT-A'])), (snap) => {
    snap.docs.forEach((d) => seen.push(d.data()));
  });
  const now = Date.now();
  const r = await anggota.call('dzIngestPoints', { sessionId: s.sessionId, deviceId: DEV, points: [P(0, now - 2000), P(1, now - 1000)] });
  assert.deepEqual(r.accepted, [0, 1]);
  assert.equal(r.latestUpdated, true);
  await sleep(500);
  const live = (await getDoc(doc(opA.db, 'lokasi_terkini', s.sessionId))).data();
  assert.equal(live.status, 'aktif');
  assert.equal(live.capturedAt.toMillis(), now - 1000);
  assert.ok(live.receivedAt, 'waktu diterima server tersimpan');
  assert.ok(seen.some((d) => d.lat != null), 'listener admin menerima posisi');
  unsub();
  // Kegiatan otomatis Berjalan.
  assert.equal((await adb.doc('kegiatan/KG1').get()).data().status, 'berjalan');
  const e = await anggota.call('dzEndSession', { sessionId: s.sessionId });
  assert.equal(e.alreadyEnded, false);
  assert.equal((await adb.doc(`sesi/${s.sessionId}`).get()).data().status, 'selesai');
  assert.equal((await adb.doc(`lokasi_terkini/${s.sessionId}`).get()).data().status, 'selesai');
  assert.equal((await adb.doc(`sesi_aktif/${anggota.uid}`).get()).exists, false);
  // Riwayat sesi dapat dibaca operator (teraudit).
  const tr = await opA.call('dzGetSessionTrack', { sessionId: s.sessionId });
  assert.equal(tr.points.length, 2);
  const audit = await adb.collection('audit').where('jenis', '==', 'akses_riwayat_lokasi').get();
  assert.equal(audit.size, 1);
});

test('2. pengiriman setelah sesi ditutup ditolak', async () => {
  const s = await anggota.call('dzStartSession', { kegiatanId: 'KG1', deviceId: DEV });
  await anggota.call('dzEndSession', { sessionId: s.sessionId });
  const e = await expectCode(anggota.call('dzIngestPoints', { sessionId: s.sessionId, deviceId: DEV, points: [P(0, Date.now())] }), 'failed-precondition');
  assert.equal(e.details.reason, 'sesi_ditutup');
});

test('3. sesi aktif ganda dicegah (kegiatan lain / perangkat lain); perangkat sama dilanjutkan', async () => {
  const s = await anggota.call('dzStartSession', { kegiatanId: 'KG1', deviceId: DEV });
  await expectCode(anggota.call('dzStartSession', { kegiatanId: 'KG2', deviceId: DEV }), 'already-exists');
  const e = await expectCode(anggota.call('dzStartSession', { kegiatanId: 'KG1', deviceId: 'perangkat-lain-02' }), 'already-exists');
  assert.equal(e.details.perangkatLain, true);
  const again = await anggota.call('dzStartSession', { kegiatanId: 'KG1', deviceId: DEV });
  assert.equal(again.sessionId, s.sessionId); assert.equal(again.resumed, true);
  // Perangkat lain tidak dapat mengirim ke sesi ini.
  const e2 = await expectCode(anggota.call('dzIngestPoints', { sessionId: s.sessionId, deviceId: 'perangkat-lain-02', points: [P(0, Date.now())] }), 'failed-precondition');
  assert.equal(e2.details.reason, 'perangkat_lain');
  const n = await adb.collection('sesi').where('uid', '==', anggota.uid).where('status', '==', 'aktif').get();
  assert.equal(n.size, 1);
});

test('3b. mulai bersamaan dari dua perangkat: hanya satu sesi aktif', async () => {
  const rs = await Promise.allSettled([
    anggota.call('dzStartSession', { kegiatanId: 'KG1', deviceId: 'perangkat-aaa-01' }),
    anggota.call('dzStartSession', { kegiatanId: 'KG1', deviceId: 'perangkat-bbb-02' }),
  ]);
  assert.equal(rs.filter((r) => r.status === 'fulfilled').length, 1);
  const n = await adb.collection('sesi').where('uid', '==', anggota.uid).where('status', '==', 'aktif').get();
  assert.equal(n.size, 1);
});

test('4. tidak dapat mengirim lokasi atas nama orang lain / menulis langsung', async () => {
  const s = await anggota.call('dzStartSession', { kegiatanId: 'KG1', deviceId: DEV });
  await expectCode(anggota2.call('dzIngestPoints', { sessionId: s.sessionId, deviceId: DEV, points: [P(0, Date.now())] }), 'permission-denied');
  await expectCode(setDoc(doc(anggota2.db, 'lokasi_terkini', s.sessionId), { lat: 1, lng: 1 }), 'permission-denied');
  await expectCode(setDoc(doc(anggota.db, 'sesi', s.sessionId, 'titik', 'x'), { lat: 1, lng: 1 }), 'permission-denied');
  await expectCode(setDoc(doc(anggota.db, 'akses', anggota.uid), { role: 'sysadmin', status: 'active' }), 'permission-denied');
  // Tidak dapat memulai sesi pada kegiatan yang tidak ditugaskan.
  await seedKegiatan('KG3', 'UNIT-A', [anggota2.uid]);
  await expectCode(anggota.call('dzStartSession', { kegiatanId: 'KG3', deviceId: DEV }), 'permission-denied');
});

test('5. anggota tidak dapat membaca lokasi personel lain', async () => {
  const s = await anggota.call('dzStartSession', { kegiatanId: 'KG1', deviceId: DEV });
  await anggota.call('dzIngestPoints', { sessionId: s.sessionId, deviceId: DEV, points: [P(0, Date.now())] });
  assert.ok((await getDoc(doc(anggota.db, 'lokasi_terkini', s.sessionId))).exists());
  await expectCode(getDoc(doc(anggota2.db, 'lokasi_terkini', s.sessionId)), 'permission-denied');
  await expectCode(getDoc(doc(anggota2.db, 'sesi', s.sessionId)), 'permission-denied');
  await expectCode(getDocs(collection(anggota2.db, 'lokasi_terkini')), 'permission-denied');
  await expectCode(anggota2.call('dzGetSessionTrack', { sessionId: s.sessionId }), 'permission-denied');
});

test('6. operator tidak dapat mengakses unit di luar lingkupnya; pembaca tanpa koordinat', async () => {
  const s = await anggota.call('dzStartSession', { kegiatanId: 'KG1', deviceId: DEV });
  await anggota.call('dzIngestPoints', { sessionId: s.sessionId, deviceId: DEV, points: [P(0, Date.now())] });
  await expectCode(getDoc(doc(opB.db, 'lokasi_terkini', s.sessionId)), 'permission-denied');
  await expectCode(getDocs(query(collection(opB.db, 'lokasi_terkini'), where('unitId', 'in', ['UNIT-A']))), 'permission-denied');
  await expectCode(opB.call('dzGetSessionTrack', { sessionId: s.sessionId }), 'permission-denied');
  await expectCode(opB.call('dzEndSession', { sessionId: s.sessionId }), 'permission-denied');
  const ok = await getDocs(query(collection(opB.db, 'lokasi_terkini'), where('unitId', 'in', ['UNIT-B'])));
  assert.equal(ok.size, 0);
  const pembaca = await makeUser('pembacaA', { role: 'pembaca', unitScope: ['UNIT-A'] });
  await expectCode(getDoc(doc(pembaca.db, 'lokasi_terkini', s.sessionId)), 'permission-denied');
  const dash = await pembaca.call('dzDashboard', {});
  assert.equal(dash.sesiAktif, 1);
  assert.equal(dash.lokasiBelumDiperbarui, null, 'pembaca tidak mendapat rincian lokasi');
  // Operator unit dapat mengakhiri sesi di unitnya.
  const e = await opA.call('dzEndSession', { sessionId: s.sessionId, reason: 'diakhiri_operator' });
  assert.equal(e.ok, true);
});

test('7. akun pending/blocked ditolak; blokir menutup sesi aktif', async () => {
  const pend = await makeUser('pending1', { role: 'anggota', status: 'pending', unitId: 'UNIT-A' });
  await seedKegiatan('KGP', 'UNIT-A', [pend.uid]);
  await expectCode(pend.call('dzStartSession', { kegiatanId: 'KGP', deviceId: DEV }), 'permission-denied');
  await expectCode(getDoc(doc(pend.db, 'kegiatan', 'KGP')), 'permission-denied');
  // Blokir saat sesi berjalan.
  const s = await anggota.call('dzStartSession', { kegiatanId: 'KG1', deviceId: DEV });
  await sys.call('dzSetAccess', { uid: anggota.uid, role: 'anggota', status: 'blocked', unitId: 'UNIT-A', unitScope: [] });
  const sesi = (await adb.doc(`sesi/${s.sessionId}`).get()).data();
  assert.equal(sesi.status, 'selesai'); assert.equal(sesi.endedReason, 'akun_diblokir');
  const e = await expectCode(anggota.call('dzIngestPoints', { sessionId: s.sessionId, deviceId: DEV, points: [P(0, Date.now())] }), 'permission-denied');
  assert.equal(e.details.reason, 'blocked');
  await expectCode(getDoc(doc(anggota.db, 'kegiatan', 'KG1')), 'permission-denied');
  // Pengguna tidak dapat mengaktifkan diri sendiri.
  await expectCode(anggota.call('dzSetAccess', { uid: anggota.uid, role: 'anggota', status: 'active', unitId: 'UNIT-A' }), 'permission-denied');
});

test('8. akun Lintas Benteng tanpa akses Denzipur ditolak; registrasi baru selalu pending', async () => {
  const benteng = await makeUser('benteng1', null); // hanya punya akun Auth bersama
  await expectCode(getDocs(collection(benteng.db, 'unit')), 'permission-denied');
  await expectCode(benteng.call('dzStartSession', { kegiatanId: 'KG1', deviceId: DEV }), 'permission-denied');
  await expectCode(benteng.call('dzDashboard', {}), 'permission-denied');
  const r = await benteng.call('dzRegister', {});
  assert.equal(r.status, 'pending'); assert.equal(r.role, 'anggota');
  await expectCode(getDocs(collection(benteng.db, 'unit')), 'permission-denied');
  // Undangan dari sysadmin mengaktifkan akun saat registrasi; klaim lain dipertahankan.
  const inv = await makeUser('undangan1', null);
  const { getAuth: aa } = await import('firebase-admin/auth');
  await aa().setCustomUserClaims(inv.uid, { bentengRole: 'pegawai' });
  await setDoc(doc(sys.db, 'undangan', inv.email), { email: inv.email, role: 'anggota', unitId: 'UNIT-B', unitScope: [], createdBy: sys.uid, createdAt: (await import('firebase/firestore')).serverTimestamp() });
  const r2 = await inv.call('dzRegister', {});
  assert.equal(r2.status, 'active'); assert.equal(r2.unitId, 'UNIT-B');
  const claims = (await aa().getUser(inv.uid)).customClaims;
  assert.equal(claims.bentengRole, 'pegawai'); assert.equal(claims.dz.u, 'UNIT-B');
  // Non-sysadmin tidak dapat membuat undangan.
  await expectCode(setDoc(doc(opA.db, 'undangan', 'x@denzipur.test'), { email: 'x@denzipur.test', role: 'sysadmin', unitId: null, unitScope: [], createdBy: opA.uid, createdAt: (await import('firebase/firestore')).serverTimestamp() }), 'permission-denied');
});

test('9. titik terlambat tidak menggantikan lokasi terbaru', async () => {
  const s = await anggota.call('dzStartSession', { kegiatanId: 'KG1', deviceId: DEV });
  const now = Date.now();
  await anggota.call('dzIngestPoints', { sessionId: s.sessionId, deviceId: DEV, points: [P(5, now - 1000, -5.1, 100.1)] });
  await sleep(1100);
  const r = await anggota.call('dzIngestPoints', { sessionId: s.sessionId, deviceId: DEV, points: [P(3, now - 20000, -5.3, 100.3), P(4, now - 10000, -5.2, 100.2)] });
  assert.deepEqual(r.accepted.sort(), [3, 4]);
  assert.equal(r.latestUpdated, false);
  const live = (await adb.doc(`lokasi_terkini/${s.sessionId}`).get()).data();
  assert.equal(live.lat, -5.1); assert.equal(live.capturedAt.toMillis(), now - 1000);
  const late = (await adb.doc(`sesi/${s.sessionId}/titik/${DEV}_000000003`).get()).data();
  assert.equal(late.terlambat, true);
});

test('10. data offline tersinkron tanpa duplikasi; batas frekuensi ditegakkan', async () => {
  const s = await anggota.call('dzStartSession', { kegiatanId: 'KG1', deviceId: DEV });
  const now = Date.now();
  const batch = Array.from({ length: 20 }, (_, i) => P(i, now - (20 - i) * 1000));
  const r1 = await anggota.call('dzIngestPoints', { sessionId: s.sessionId, deviceId: DEV, points: batch });
  assert.equal(r1.accepted.length, 20);
  // Kirim ulang langsung → ditolak batas frekuensi.
  await expectCode(anggota.call('dzIngestPoints', { sessionId: s.sessionId, deviceId: DEV, points: batch }), 'resource-exhausted');
  await sleep(1100);
  // Kirim ulang (respons sebelumnya "hilang") → semuanya duplikat.
  const r2 = await anggota.call('dzIngestPoints', { sessionId: s.sessionId, deviceId: DEV, points: [...batch, P(20, now)] });
  assert.equal(r2.duplicates.length, 20); assert.deepEqual(r2.accepted, [20]);
  const pts = await adb.collection(`sesi/${s.sessionId}/titik`).get();
  assert.equal(pts.size, 21);
  assert.equal((await adb.doc(`sesi/${s.sessionId}`).get()).data().pointCount, 21);
  // Titik tidak valid ditolak dengan alasan, sisanya diterima.
  await sleep(1100);
  const r3 = await anggota.call('dzIngestPoints', { sessionId: s.sessionId, deviceId: DEV, points: [{ seq: 30, lat: 95, lng: 0, acc: 1, t: now }, P(31, now + 500)] });
  assert.deepEqual(r3.rejected, [{ seq: 30, reason: 'lat' }]); assert.deepEqual(r3.accepted, [31]);
  // Batch melebihi batas ditolak.
  await sleep(1100);
  await expectCode(anggota.call('dzIngestPoints', { sessionId: s.sessionId, deviceId: DEV, points: Array.from({ length: 101 }, (_, i) => P(100 + i, now)) }), 'invalid-argument');
});

test('12/14. dashboard konsisten dengan data uji dan status kedaluwarsa mengikuti waktu', async () => {
  const s1 = await anggota.call('dzStartSession', { kegiatanId: 'KG1', deviceId: DEV });
  const s2 = await anggota2.call('dzStartSession', { kegiatanId: 'KG1', deviceId: 'perangkat-uji-02' });
  await anggota.call('dzIngestPoints', { sessionId: s1.sessionId, deviceId: DEV, points: [P(0, Date.now())] });
  let d = await opA.call('dzDashboard', {});
  assert.equal(d.sesiAktif, 2);
  assert.equal(d.sesiBelumAdaLokasi, 1);
  assert.equal(d.lokasiBelumDiperbarui, 1);
  // Majukan waktu: jadikan titik terakhir s1 berumur 10 menit.
  await adb.doc(`lokasi_terkini/${s1.sessionId}`).update({ capturedAt: Timestamp.fromMillis(Date.now() - 10 * 60000) });
  d = await opA.call('dzDashboard', {});
  assert.equal(d.lokasiBelumDiperbarui, 2);
  assert.equal(d.kegiatan.berjalan, 1); // KG1 otomatis Berjalan; KG2 masih Rencana
  assert.equal(d.kegiatan.rencana, 1);
  assert.equal(d.personelAktif >= 2, true);
  const dB = await opB.call('dzDashboard', {});
  assert.equal(dB.sesiAktif, 0); assert.equal(dB.kegiatan.berjalan, 0);
  void s2;
});

test('pemeliharaan: sesi tanpa pembaruan diakhiri sistem, riwayat lama dihapus sesuai masa simpan', async () => {
  const s = await anggota.call('dzStartSession', { kegiatanId: 'KG1', deviceId: DEV });
  await anggota.call('dzIngestPoints', { sessionId: s.sessionId, deviceId: DEV, points: [P(0, Date.now())] });
  await adb.doc(`lokasi_terkini/${s.sessionId}`).update({ updatedAt: Timestamp.fromMillis(Date.now() - 4 * 3600_000) });
  let r = await sys.call('dzRunMaintenance', {});
  assert.equal(r.autoEnded, 1);
  assert.equal((await adb.doc(`sesi/${s.sessionId}`).get()).data().endedReason, 'tidak_ada_pembaruan');
  await adb.doc(`sesi/${s.sessionId}`).update({ selesaiAt: Timestamp.fromMillis(Date.now() - 100 * 86400_000) });
  r = await sys.call('dzRunMaintenance', {});
  assert.equal(r.purgedSessions, 1);
  assert.equal((await adb.collection(`sesi/${s.sessionId}/titik`).get()).size, 0);
  await expectCode(opA.call('dzRunMaintenance', {}), 'permission-denied');
});

test('sysadmin terakhir tidak dapat diturunkan; tidak dapat mengubah diri sendiri', async () => {
  await expectCode(sys.call('dzSetAccess', { uid: sys.uid, role: 'anggota', status: 'active', unitId: 'UNIT-A' }), 'failed-precondition');
  const sys2 = await makeUser('sys2', { role: 'sysadmin' });
  await sys2.call('dzSetAccess', { uid: sys.uid, role: 'operator', status: 'active', unitScope: ['UNIT-A'] });
  await expectCode(sys.call('dzSetAccess', { uid: sys2.uid, role: 'anggota', status: 'active', unitId: 'UNIT-A' }), 'permission-denied');
});
