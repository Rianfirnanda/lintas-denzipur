import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { adb, F, Timestamp, resetAll, makeUser, closeAll, expectCode, sleep, seedUnits, seedKegiatan, P, sessState, applyIngest } from './helpers.mjs';

const { doc, getDoc, getDocs, collection, query, where, setDoc, updateDoc, onSnapshot, writeBatch, serverTimestamp } = F;
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
const GAP = 3200; // jeda minimum antar batch (Rules: 3 detik)
const start = (c, kegiatanId = 'KG1', deviceId = DEV) => c.dz.startSession({ uid: c.uid, kegiatanId, deviceId });

test('1. mulai → kirim lokasi → tampil di admin (operator) → akhiri sesi', async () => {
  const s = await start(anggota);
  const st = sessState(s, DEV);
  const seen = [];
  const unsub = onSnapshot(query(collection(opA.db, 'lokasi_terkini'), where('unitId', 'in', ['UNIT-A'])), (snap) => snap.docs.forEach((d) => seen.push(d.data())));
  const now = Date.now();
  const r = await anggota.dz.ingest(st, [P(0, now - 2000), P(1, now - 1000)]);
  assert.deepEqual(r.acked.sort(), [0, 1]);
  assert.equal(r.latestUpdated, true);
  await sleep(500);
  const live = (await getDoc(doc(opA.db, 'lokasi_terkini', s.sessionId))).data();
  assert.equal(live.status, 'aktif');
  assert.equal(live.capturedAt.toMillis(), now - 1000);
  assert.ok(live.receivedAt, 'waktu diterima server tersimpan');
  assert.ok(seen.some((d) => d.lat != null), 'listener admin menerima posisi');
  unsub();
  assert.equal((await adb.doc('kegiatan/KG1').get()).data().status, 'berjalan');
  const e = await anggota.dz.endSession({ sessionId: s.sessionId, reason: 'selesai_oleh_anggota', actorUid: anggota.uid });
  assert.equal(e.alreadyEnded, false);
  assert.equal((await adb.doc(`sesi/${s.sessionId}`).get()).data().status, 'selesai');
  assert.equal((await adb.doc(`lokasi_terkini/${s.sessionId}`).get()).data().status, 'selesai');
  assert.equal((await adb.doc(`sesi_aktif/${anggota.uid}`).get()).exists, false);
  const tr = await opA.dz.getSessionTrack({ uid: opA.uid }, s.sessionId);
  assert.equal(tr.points.length, 2);
  assert.equal((await adb.collection('audit').where('jenis', '==', 'akses_riwayat_lokasi').get()).size, 1);
});

test('2. pengiriman setelah sesi ditutup ditolak', async () => {
  const s = await start(anggota);
  await anggota.dz.endSession({ sessionId: s.sessionId, reason: 'selesai_oleh_anggota', actorUid: anggota.uid });
  const e = await expectCode(anggota.dz.ingest(sessState(s, DEV), [P(0, Date.now())]), 'session_closed');
  assert.equal(e.details.endedReason, 'selesai_oleh_anggota');
  // Tulis langsung ke subkoleksi juga ditolak Rules.
  const b = writeBatch(anggota.db);
  b.set(doc(anggota.db, 'sesi', s.sessionId, 'titik', '0'), { seq: 0, lat: 1, lng: 1, acc: 1, capturedAt: F.Timestamp.now(), receivedAt: serverTimestamp(), deviceId: DEV, quality: [], terlambat: false });
  b.update(doc(anggota.db, 'sesi', s.sessionId), { lastSeq: 0, pointCount: 1, lastCapturedAt: F.Timestamp.now(), lastIngestAt: serverTimestamp() });
  await expectCode(b.commit(), 'permission-denied');
});

test('3. sesi aktif ganda dicegah (kegiatan lain / perangkat lain); perangkat sama dilanjutkan', async () => {
  const s = await start(anggota);
  await expectCode(start(anggota, 'KG2'), 'already-exists');
  const e = await expectCode(start(anggota, 'KG1', 'perangkat-lain-02'), 'already-exists');
  assert.equal(e.details.perangkatLain, true);
  const again = await start(anggota);
  assert.equal(again.sessionId, s.sessionId); assert.equal(again.resumed, true);
  await expectCode(anggota.dz.ingest(sessState(s, 'perangkat-lain-02'), [P(0, Date.now())]), 'other_device');
  // Membuat sesi kedua secara langsung (melewati klien) juga ditolak Rules.
  const r2 = doc(collection(anggota.db, 'sesi'));
  const b = writeBatch(anggota.db);
  b.set(r2, { uid: anggota.uid, unitId: 'UNIT-A', kegiatanId: 'KG2', kegiatanJudul: 'Kegiatan uji KG2', nama: 'Uji anggota1', pangkat: 'Pratu', deviceId: DEV, status: 'aktif', mulaiAt: serverTimestamp(), selesaiAt: null, endedReason: null, endedBy: null, lastSeq: -1, pointCount: 0, lastCapturedAt: null, lastIngestAt: null });
  b.set(doc(anggota.db, 'sesi_aktif', anggota.uid), { sessionId: r2.id, deviceId: DEV, kegiatanId: 'KG2', unitId: 'UNIT-A', at: serverTimestamp() });
  await expectCode(b.commit(), 'permission-denied');
  const n = await adb.collection('sesi').where('uid', '==', anggota.uid).where('status', '==', 'aktif').get();
  assert.equal(n.size, 1);
});

test('3b. mulai bersamaan dari dua perangkat: hanya satu sesi aktif', async () => {
  const rs = await Promise.allSettled([start(anggota, 'KG1', 'perangkat-aaa-01'), start(anggota, 'KG1', 'perangkat-bbb-02')]);
  assert.equal(rs.filter((r) => r.status === 'fulfilled').length, 1);
  const n = await adb.collection('sesi').where('uid', '==', anggota.uid).where('status', '==', 'aktif').get();
  assert.equal(n.size, 1);
});

test('4. tidak dapat mengirim lokasi atas nama orang lain / menulis langsung / menaikkan peran', async () => {
  const s = await start(anggota);
  // Batch ditolak Rules; sesi orang lain juga tidak dapat dibaca, sehingga klien menghentikan pengiriman.
  await expectCode(anggota2.dz.ingest(sessState(s, DEV), [P(0, Date.now())]), 'account_inactive');
  assert.equal((await adb.collection(`sesi/${s.sessionId}/titik`).get()).size, 0);
  await expectCode(updateDoc(doc(anggota2.db, 'lokasi_terkini', s.sessionId), { lat: 1, lng: 1 }), 'permission-denied');
  await expectCode(setDoc(doc(anggota.db, 'akses', anggota.uid), { role: 'sysadmin', status: 'active' }), 'permission-denied');
  await expectCode(updateDoc(doc(anggota.db, 'akses', anggota.uid), { role: 'sysadmin' }), 'permission-denied');
  await seedKegiatan('KG3', 'UNIT-A', [anggota2.uid]);
  await anggota.dz.endSession({ sessionId: s.sessionId, reason: 'selesai_oleh_anggota', actorUid: anggota.uid });
  await expectCode(start(anggota, 'KG3'), 'permission-denied');
});

test('5. anggota tidak dapat membaca lokasi personel lain', async () => {
  const s = await start(anggota);
  await anggota.dz.ingest(sessState(s, DEV), [P(0, Date.now())]);
  assert.ok((await getDoc(doc(anggota.db, 'lokasi_terkini', s.sessionId))).exists());
  await expectCode(getDoc(doc(anggota2.db, 'lokasi_terkini', s.sessionId)), 'permission-denied');
  await expectCode(getDoc(doc(anggota2.db, 'sesi', s.sessionId)), 'permission-denied');
  await expectCode(getDocs(collection(anggota2.db, 'lokasi_terkini')), 'permission-denied');
  await expectCode(getDocs(collection(anggota2.db, 'sesi', s.sessionId, 'titik')), 'permission-denied');
});

test('6. operator tidak dapat mengakses unit di luar lingkupnya; pembaca tanpa koordinat', async () => {
  const s = await start(anggota);
  await anggota.dz.ingest(sessState(s, DEV), [P(0, Date.now())]);
  await expectCode(getDoc(doc(opB.db, 'lokasi_terkini', s.sessionId)), 'permission-denied');
  await expectCode(getDocs(query(collection(opB.db, 'lokasi_terkini'), where('unitId', 'in', ['UNIT-A']))), 'permission-denied');
  await expectCode(getDocs(collection(opB.db, 'sesi', s.sessionId, 'titik')), 'permission-denied');
  await expectCode(opB.dz.endSession({ sessionId: s.sessionId, reason: 'diakhiri_operator', actorUid: opB.uid }), 'permission-denied');
  assert.equal((await getDocs(query(collection(opB.db, 'lokasi_terkini'), where('unitId', 'in', ['UNIT-B'])))).size, 0);
  const pembaca = await makeUser('pembacaA', { role: 'pembaca', unitScope: ['UNIT-A'] });
  await expectCode(getDoc(doc(pembaca.db, 'lokasi_terkini', s.sessionId)), 'permission-denied');
  const dash = await pembaca.dz.dashboard({ isSys: false, scope: ['UNIT-A'] });
  assert.equal(dash.sesiAktif, null, 'pembaca tidak mendapat hitungan lokasi');
  assert.equal(dash.kegiatan.berjalan, 1);
  const e = await opA.dz.endSession({ sessionId: s.sessionId, reason: 'diakhiri_operator', actorUid: opA.uid });
  assert.equal(e.alreadyEnded, false);
  assert.equal((await adb.doc(`sesi_aktif/${anggota.uid}`).get()).exists, false);
});

test('7. akun pending/blocked ditolak; blokir menutup sesi aktif', async () => {
  const pend = await makeUser('pending1', { role: 'anggota', status: 'pending', unitId: 'UNIT-A' });
  await seedKegiatan('KGP', 'UNIT-A', [pend.uid]);
  await expectCode(start(pend, 'KGP'), 'permission-denied');
  await expectCode(getDoc(doc(pend.db, 'kegiatan', 'KGP')), 'permission-denied');
  const s = await start(anggota);
  await sys.dz.setAccess({ uid: sys.uid }, anggota.uid, { role: 'anggota', status: 'blocked', unitId: 'UNIT-A', unitScope: [] });
  const sesi = (await adb.doc(`sesi/${s.sessionId}`).get()).data();
  assert.equal(sesi.status, 'selesai'); assert.equal(sesi.endedReason, 'akun_diblokir');
  await expectCode(anggota.dz.ingest(sessState(s, DEV), [P(0, Date.now())]), 'account_inactive');
  await expectCode(getDoc(doc(anggota.db, 'kegiatan', 'KG1')), 'permission-denied');
  // Tidak dapat mengaktifkan diri sendiri / mengubah akses sendiri.
  await expectCode(updateDoc(doc(anggota.db, 'akses', anggota.uid), { status: 'active' }), 'permission-denied');
  await expectCode(sys.dz.setAccess({ uid: sys.uid }, sys.uid, { role: 'anggota', status: 'active', unitId: 'UNIT-A' }), 'failed-precondition');
  await expectCode(updateDoc(doc(sys.db, 'akses', sys.uid), { role: 'anggota', updatedAt: serverTimestamp(), updatedBy: sys.uid }), 'permission-denied');
});

test('8. registrasi: tanpa undangan selalu pending; undangan & bootstrap ditegakkan Rules', async () => {
  const baru = await makeUser('baru1', null);
  await expectCode(getDocs(collection(baru.db, 'unit')), 'permission-denied');
  const r = await baru.dz.register(baru.user);
  assert.equal(r.status, 'pending'); assert.equal(r.role, 'anggota');
  await expectCode(getDocs(collection(baru.db, 'unit')), 'permission-denied');
  // Undangan dari sysadmin → aktif sesuai undangan; undangan terpakai.
  const inv = await makeUser('undangan1', null);
  await setDoc(doc(sys.db, 'undangan', inv.email), { email: inv.email, role: 'anggota', unitId: 'UNIT-B', unitScope: [], createdBy: sys.uid, createdAt: serverTimestamp() });
  const r2 = await inv.dz.register(inv.user);
  assert.equal(r2.status, 'active'); assert.equal(r2.unitId, 'UNIT-B');
  assert.equal((await adb.doc(`undangan/${inv.email}`).get()).exists, false);
  // Pengguna pending tidak dapat memalsukan undangan/peran.
  await expectCode(setDoc(doc(baru.db, 'undangan', baru.email), { email: baru.email, role: 'sysadmin', unitId: null, unitScope: [], createdBy: baru.uid, createdAt: serverTimestamp() }), 'permission-denied');
  await expectCode(setDoc(doc(opA.db, 'undangan', 'x@denzipur.test'), { email: 'x@denzipur.test', role: 'sysadmin', unitId: null, unitScope: [], createdBy: opA.uid, createdAt: serverTimestamp() }), 'permission-denied');
  // Bootstrap administrator hanya untuk email yang ada di pengaturan/bootstrap.
  await adb.doc('pengaturan/bootstrap').set({ emails: ['bootstrap1@denzipur.test'] });
  const boot = await makeUser('bootstrap1', null);
  assert.equal((await boot.dz.register(boot.user)).role, 'sysadmin');
  const bukan = await makeUser('bukanbootstrap', null);
  assert.equal((await bukan.dz.register(bukan.user)).status, 'pending');
  const unverified = await makeUser('bootstrap2', null, { emailVerified: false });
  await adb.doc('pengaturan/bootstrap').set({ emails: ['bootstrap1@denzipur.test', 'bootstrap2@denzipur.test'] });
  assert.equal((await unverified.dz.register(unverified.user)).status, 'pending', 'email belum terverifikasi tidak menjadi admin');
  await expectCode(getDoc(doc(sys.db, 'pengaturan', 'bootstrap')), 'permission-denied');
});

test('9. titik terlambat tidak menggantikan lokasi terbaru', async () => {
  const s = await start(anggota);
  const st = sessState(s, DEV);
  const now = Date.now();
  applyIngest(st, await anggota.dz.ingest(st, [P(5, now - 1000, -5.1, 100.1)]));
  await sleep(GAP);
  // seq lebih besar tetapi waktu pengambilan lebih lama (antrean dari perangkat lain/offline)
  const r = await anggota.dz.ingest(st, [P(6, now - 20000, -5.3, 100.3), P(7, now - 10000, -5.2, 100.2)]);
  assert.deepEqual(r.acked.sort(), [6, 7]);
  assert.equal(r.latestUpdated, false);
  const live = (await adb.doc(`lokasi_terkini/${s.sessionId}`).get()).data();
  assert.equal(live.lat, -5.1); assert.equal(live.capturedAt.toMillis(), now - 1000);
  assert.equal((await adb.doc(`sesi/${s.sessionId}/titik/6`).get()).data().terlambat, true);
  // Menimpa posisi terkini dengan titik lebih lama secara langsung ditolak Rules.
  await sleep(GAP);
  const b = writeBatch(anggota.db);
  b.set(doc(anggota.db, 'sesi', s.sessionId, 'titik', '8'), { seq: 8, lat: -5.9, lng: 100.9, acc: 5, capturedAt: F.Timestamp.fromMillis(now - 60000), receivedAt: serverTimestamp(), deviceId: DEV, quality: [], terlambat: false });
  b.update(doc(anggota.db, 'sesi', s.sessionId), { lastSeq: 8, pointCount: F.increment(1), lastCapturedAt: F.Timestamp.fromMillis(now - 60000), lastIngestAt: serverTimestamp() });
  b.update(doc(anggota.db, 'lokasi_terkini', s.sessionId), { lat: -5.9, lng: 100.9, acc: 5, capturedAt: F.Timestamp.fromMillis(now - 60000), receivedAt: serverTimestamp(), quality: [], updatedAt: serverTimestamp() });
  await expectCode(b.commit(), 'permission-denied');
});

test('10. data offline tersinkron tanpa duplikasi; batas frekuensi & ukuran ditegakkan', async () => {
  const s = await start(anggota);
  const st = sessState(s, DEV);
  const now = Date.now();
  const batch = Array.from({ length: 50 }, (_, i) => P(i, now - (50 - i) * 1000));
  const r1 = await anggota.dz.ingest(st, batch);
  assert.equal(r1.acked.length, 50);
  // Kirim ulang seolah respons hilang (state lama) → terdeteksi duplikat, tidak ada titik ganda.
  await sleep(GAP);
  const r2 = await anggota.dz.ingest(sessState(s, DEV), batch);
  assert.equal(r2.duplicate, true); assert.equal(r2.acked.length, 50);
  applyIngest(st, r1);
  // Batch kedua terlalu cepat → backoff.
  await anggota.dz.ingest(st, [P(50, now)]).then((r) => applyIngest(st, r));
  await expectCode(anggota.dz.ingest(st, [P(51, now + 100)]), 'backoff');
  await sleep(GAP);
  // Titik tidak valid ditolak dengan alasan, sisanya diterima.
  const r3 = await anggota.dz.ingest(st, [{ seq: 52, lat: 95, lng: 0, acc: 1, t: now }, P(53, now + 500)]);
  assert.deepEqual(r3.rejected, [{ seq: 52, reason: 'lat' }]);
  applyIngest(st, r3);
  const pts = await adb.collection(`sesi/${s.sessionId}/titik`).get();
  assert.equal(pts.size, 52);
  assert.equal((await adb.doc(`sesi/${s.sessionId}`).get()).data().pointCount, 52);
  // Lebih dari 50 titik dalam satu batch langsung ditolak Rules.
  await sleep(GAP);
  const b = writeBatch(anggota.db);
  for (let i = 60; i < 111; i++) b.set(doc(anggota.db, 'sesi', s.sessionId, 'titik', String(i)), { seq: i, lat: -5, lng: 100, acc: 5, capturedAt: F.Timestamp.fromMillis(now + 1000), receivedAt: serverTimestamp(), deviceId: DEV, quality: [], terlambat: false });
  b.update(doc(anggota.db, 'sesi', s.sessionId), { lastSeq: 110, pointCount: F.increment(51), lastCapturedAt: F.Timestamp.fromMillis(now + 1000), lastIngestAt: serverTimestamp() });
  await expectCode(b.commit(), 'permission-denied');
});

test('12/14. dashboard konsisten dengan data uji dan status kedaluwarsa mengikuti waktu', async () => {
  const s1 = await start(anggota);
  await start(anggota2, 'KG1', 'perangkat-uji-02');
  await anggota.dz.ingest(sessState(s1, DEV), [P(0, Date.now())]);
  const ctxA = { isSys: false, scope: ['UNIT-A'] };
  let d = await opA.dz.dashboard(ctxA);
  assert.equal(d.sesiAktif, 2);
  assert.equal(d.sesiBelumAdaLokasi, 1);
  assert.equal(d.lokasiBelumDiperbarui, 1);
  await adb.doc(`lokasi_terkini/${s1.sessionId}`).update({ capturedAt: Timestamp.fromMillis(Date.now() - 10 * 60000) });
  d = await opA.dz.dashboard(ctxA);
  assert.equal(d.lokasiBelumDiperbarui, 2);
  assert.equal(d.kegiatan.berjalan, 1); assert.equal(d.kegiatan.rencana, 1);
  assert.equal(d.personelAktif, 2);
  assert.ok(d.aktivitas.some((a) => a.jenis === 'tracking_mulai'));
  const dB = await opB.dz.dashboard({ isSys: false, scope: ['UNIT-B'] });
  assert.equal(dB.sesiAktif, 0); assert.equal(dB.kegiatan.berjalan, 0);
  const dS = await sys.dz.dashboard({ isSys: true, scope: null });
  assert.equal(dS.sesiAktif, 2);
});

test('pemeliharaan: sesi tanpa pembaruan diakhiri, riwayat lama dihapus sesuai masa simpan', async () => {
  const s = await start(anggota);
  await anggota.dz.ingest(sessState(s, DEV), [P(0, Date.now())]);
  await adb.doc(`lokasi_terkini/${s.sessionId}`).update({ updatedAt: Timestamp.fromMillis(Date.now() - 4 * 3600_000) });
  let r = await sys.dz.maintenance({ uid: sys.uid });
  assert.equal(r.autoEnded, 1);
  assert.equal((await adb.doc(`sesi/${s.sessionId}`).get()).data().endedReason, 'tidak_ada_pembaruan');
  await adb.doc(`sesi/${s.sessionId}`).update({ selesaiAt: Timestamp.fromMillis(Date.now() - 100 * 86400_000) });
  r = await sys.dz.maintenance({ uid: sys.uid });
  assert.equal(r.purgedSessions, 1);
  assert.equal((await adb.collection(`sesi/${s.sessionId}/titik`).get()).size, 0);
  assert.equal((await adb.doc(`lokasi_terkini/${s.sessionId}`).get()).exists, false);
  await expectCode(opA.dz.maintenance({ uid: opA.uid }), 'permission-denied');
});
