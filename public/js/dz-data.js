// Lapisan data Lintas Denzipur untuk paket Spark (tanpa Cloud Functions).
// Semua operasi ditulis sebagai batch atomik; Firestore Rules menegakkan kepemilikan, peran,
// lingkup unit, validasi titik, urutan seq (deduplikasi), batas frekuensi, dan status sesi.
// Modul ini menerima modul Firestore (F) dan instance db agar bisa dipakai di browser (gstatic)
// maupun di pengujian Node (paket npm "firebase").
import { MAX_BATCH, MIN_INGEST_GAP_MS, STAFF_ROLES, KEGIATAN_STATUS, isSafeId, validatePoint, flagJumps, mergeSettings } from './dz-core.js';

export class DzError extends Error {
  constructor(code, message, details = {}) { super(message); this.code = code; this.details = details; }
}
const code = (e) => String(e?.code || '').replace(/^(firestore|functions|auth)\//, '');

export function createDz(F, db) {
  const T = () => F.serverTimestamp();
  const d = (...p) => F.doc(db, ...p);
  const aktivitas = (b, { jenis, actorUid, unitId, ringkasan }) =>
    b.set(F.doc(F.collection(db, 'aktivitas')), { jenis, actorUid, unitId: unitId ?? null, ringkasan: String(ringkasan).slice(0, 300), at: T() });
  const audit = (b, { jenis, actorUid, unitId = null, ringkasan, target = null }) =>
    b.set(F.doc(F.collection(db, 'audit')), { jenis, actorUid, unitId, ringkasan: String(ringkasan).slice(0, 300), target, at: T() });

  /* ───────── Registrasi (dipanggil setiap login) ───────── */
  async function register(user) {
    const email = (user.email || '').toLowerCase();
    const ref = d('akses', user.uid);
    const snap = await F.getDoc(ref);
    let inv = null;
    if (email && (!snap.exists() || snap.data().status === 'pending')) {
      try { const s = await F.getDoc(d('undangan', email)); if (s.exists()) inv = s.data(); } catch { /* tidak ada undangan */ }
    }
    if (snap.exists()) {
      const cur = snap.data();
      const b = F.writeBatch(db);
      if (cur.status === 'pending' && inv) {
        b.update(ref, { role: inv.role, status: 'active', unitId: inv.unitId ?? null, unitScope: inv.unitScope || [], updatedAt: T(), updatedBy: 'undangan', lastLogin: T() });
        b.update(d('personel', user.uid), { unitId: inv.unitId ?? null, updatedAt: T() });
        b.delete(d('undangan', email));
        aktivitas(b, { jenis: 'akun_aktif_undangan', actorUid: user.uid, unitId: inv.unitId ?? null, ringkasan: `Akun ${email} aktif lewat undangan` });
        await b.commit();
        return { ...cur, role: inv.role, status: 'active', unitId: inv.unitId ?? null, unitScope: inv.unitScope || [] };
      }
      await F.updateDoc(ref, { lastLogin: T() }).catch(() => {}); // akun diblokir tetap boleh mencatat login
      return cur;
    }
    const create = async (akses, viaInvite) => {
      const b = F.writeBatch(db);
      b.set(ref, { uid: user.uid, email, ...akses, createdAt: T(), updatedAt: T(), updatedBy: 'registrasi', lastLogin: T() });
      b.set(d('personel', user.uid), { uid: user.uid, email, nama: String(user.displayName || email).slice(0, 120), pangkat: '', jabatan: '', unitId: akses.unitId, statusKeanggotaan: 'aktif', createdAt: T(), updatedAt: T() });
      if (viaInvite) b.delete(d('undangan', email));
      if (akses.status === 'active' && akses.unitId) aktivitas(b, { jenis: 'akun_baru', actorUid: user.uid, unitId: akses.unitId, ringkasan: `Akun baru aktif: ${email}` });
      await b.commit();
      return akses;
    };
    if (inv) return create({ role: inv.role, status: 'active', unitId: inv.unitId ?? null, unitScope: inv.unitScope || [] }, true);
    // Administrator awal: hanya berhasil jika email ada di pengaturan/bootstrap (dicek Rules).
    try { return await create({ role: 'sysadmin', status: 'active', unitId: null, unitScope: [] }, false); }
    catch (e) { if (code(e) !== 'permission-denied') throw e; }
    return create({ role: 'anggota', status: 'pending', unitId: null, unitScope: [] }, false);
  }

  /* ───────── Akses & personel (administrator sistem) ───────── */
  async function setAccess(me, uid, { role, status, unitId, unitScope }) {
    if (uid === me.uid) throw new DzError('failed-precondition', 'Tidak dapat mengubah akses akun sendiri.');
    if (STAFF_ROLES.includes(role) && status === 'active' && !(unitScope || []).length) throw new DzError('invalid-argument', 'Peran unit membutuhkan minimal satu unit lingkup.');
    if (role === 'anggota' && status === 'active' && !unitId) throw new DzError('invalid-argument', 'Anggota aktif harus memiliki unit.');
    const cur = (await F.getDoc(d('akses', uid))).data();
    if (!cur) throw new DzError('not-found', 'Akun tidak ditemukan.');
    const next = { role, status, unitId: unitId || null, unitScope: role === 'anggota' ? [] : [...new Set(unitScope || [])].slice(0, 30) };
    const b = F.writeBatch(db);
    b.update(d('akses', uid), { ...next, updatedAt: T(), updatedBy: me.uid });
    b.update(d('personel', uid), { unitId: next.unitId, updatedAt: T(), updatedBy: me.uid });
    audit(b, { jenis: 'akses_diubah', actorUid: me.uid, unitId: next.unitId, target: uid, ringkasan: `Akses ${cur.email || uid}: ${cur.role}/${cur.status} → ${role}/${status}` });
    if (status !== 'active') await addEndActiveSession(b, uid, status === 'blocked' ? 'akun_diblokir' : 'akses_dicabut', me.uid);
    await b.commit();
  }
  async function savePersonel(me, uid, p) {
    const nama = String(p.nama || '').trim().slice(0, 120);
    if (nama.length < 2) throw new DzError('invalid-argument', 'Nama wajib diisi.');
    const b = F.writeBatch(db);
    b.update(d('personel', uid), { nama, pangkat: String(p.pangkat || '').trim().slice(0, 60), jabatan: String(p.jabatan || '').trim().slice(0, 120), statusKeanggotaan: p.statusKeanggotaan, updatedAt: T(), updatedBy: me.uid });
    await b.commit();
  }
  async function deleteAccount(me, uid) {
    if (uid === me.uid) throw new DzError('failed-precondition', 'Tidak dapat menghapus akun sendiri.');
    const cur = (await F.getDoc(d('akses', uid))).data();
    const b = F.writeBatch(db);
    await addEndActiveSession(b, uid, 'akun_dihapus', me.uid);
    b.delete(d('akses', uid));
    b.delete(d('personel', uid));
    audit(b, { jenis: 'akun_dihapus', actorUid: me.uid, unitId: cur?.unitId ?? null, target: uid, ringkasan: `Akun ${cur?.email || uid} dihapus dari Denzipur` });
    await b.commit();
  }

  /* ───────── Sesi tracking ───────── */
  async function addEndActiveSession(b, uid, reason, actorUid) {
    const lock = await F.getDoc(d('sesi_aktif', uid)).catch(() => null);
    if (!lock?.exists()) return false;
    const sid = lock.data().sessionId;
    const s = await F.getDoc(d('sesi', sid)).catch(() => null);
    if (s?.exists() && s.data().status === 'aktif') {
      b.update(d('sesi', sid), { status: 'selesai', selesaiAt: T(), endedReason: reason, endedBy: actorUid });
      b.update(d('lokasi_terkini', sid), { status: 'selesai', selesaiAt: T(), endedReason: reason, updatedAt: T() });
      aktivitas(b, { jenis: 'tracking_selesai', actorUid, unitId: s.data().unitId, ringkasan: `Tracking ${s.data().nama || ''} diakhiri (${reason})` });
    }
    b.delete(d('sesi_aktif', uid));
    return true;
  }

  async function startSession({ uid, kegiatanId, deviceId }) {
    if (!isSafeId(deviceId)) throw new DzError('invalid-argument', 'ID perangkat tidak valid.');
    const [kg, lock, pers] = await Promise.all([F.getDoc(d('kegiatan', kegiatanId)), F.getDoc(d('sesi_aktif', uid)), F.getDoc(d('personel', uid))]);
    if (!kg.exists()) throw new DzError('not-found', 'Kegiatan tidak ditemukan.');
    const k = kg.data();
    if (lock.exists()) {
      const l = lock.data();
      const cur = await F.getDoc(d('sesi', l.sessionId));
      if (cur.exists() && cur.data().status === 'aktif') {
        if (l.deviceId === deviceId && l.kegiatanId === kegiatanId) {
          const c = cur.data();
          return { sessionId: l.sessionId, resumed: true, mulaiAtMs: c.mulaiAt?.toMillis?.() ?? null, lastSeq: c.lastSeq, lastCapturedAtMs: c.lastCapturedAt?.toMillis?.() ?? null };
        }
        throw new DzError('already-exists', 'Masih ada sesi tracking aktif.', { sessionId: l.sessionId, kegiatanId: l.kegiatanId, perangkatLain: l.deviceId !== deviceId });
      }
    }
    const ref = F.doc(F.collection(db, 'sesi'));
    const p = pers.data() || {};
    const base = { uid, unitId: k.unitId, kegiatanId, kegiatanJudul: k.judul || '', nama: p.nama || '', pangkat: p.pangkat || '' };
    const b = F.writeBatch(db);
    b.set(ref, { ...base, deviceId, status: 'aktif', mulaiAt: T(), selesaiAt: null, endedReason: null, endedBy: null, lastSeq: -1, pointCount: 0, lastCapturedAt: null, lastIngestAt: null });
    b.set(d('sesi_aktif', uid), { sessionId: ref.id, deviceId, kegiatanId, unitId: k.unitId, at: T() }); // ditolak Rules bila masih ada sesi aktif
    b.set(d('lokasi_terkini', ref.id), { ...base, sessionId: ref.id, status: 'aktif', mulaiAt: T(), selesaiAt: null, endedReason: null, lat: null, lng: null, acc: null, capturedAt: null, receivedAt: null, quality: [], updatedAt: T() });
    if (k.status === 'rencana') b.update(kg.ref, { status: 'berjalan', updatedBy: uid, updatedAt: T() });
    aktivitas(b, { jenis: 'tracking_mulai', actorUid: uid, unitId: k.unitId, ringkasan: `${p.nama || 'Personel'} mulai tracking: ${k.judul || kegiatanId}` });
    try { await b.commit(); }
    catch (e) {
      if (code(e) === 'permission-denied') {
        const l2 = await F.getDoc(d('sesi_aktif', uid)).catch(() => null);
        if (l2?.exists() && l2.data().sessionId !== ref.id) throw new DzError('already-exists', 'Masih ada sesi tracking aktif.', { sessionId: l2.data().sessionId, kegiatanId: l2.data().kegiatanId, perangkatLain: l2.data().deviceId !== deviceId });
      }
      throw e;
    }
    return { sessionId: ref.id, resumed: false, mulaiAtMs: Date.now(), lastSeq: -1, lastCapturedAtMs: null };
  }

  async function endSession({ sessionId, reason, actorUid }) {
    const s = await F.getDoc(d('sesi', sessionId));
    if (!s.exists()) throw new DzError('not-found', 'Sesi tidak ditemukan.');
    const x = s.data();
    if (x.status !== 'aktif') return { alreadyEnded: true };
    const lock = await F.getDoc(d('sesi_aktif', x.uid)).catch(() => null);
    const b = F.writeBatch(db);
    b.update(s.ref, { status: 'selesai', selesaiAt: T(), endedReason: reason, endedBy: actorUid });
    b.update(d('lokasi_terkini', sessionId), { status: 'selesai', selesaiAt: T(), endedReason: reason, updatedAt: T() });
    if (lock?.exists() && lock.data().sessionId === sessionId) b.delete(lock.ref);
    aktivitas(b, { jenis: 'tracking_selesai', actorUid, unitId: x.unitId, ringkasan: `Tracking ${x.nama || ''} diakhiri (${reason})` });
    await b.commit();
    return { alreadyEnded: false };
  }

  /**
   * Kirim titik antrean dalam satu batch atomik.
   * state: { sessionId, deviceId, sessionStartMs, lastSeq, lastCapturedAtMs, prevFix }
   * Hasil: { acked: seq[], rejected: [{seq,reason}], latestUpdated, lastSeq, lastCapturedAtMs }
   * Galat: DzError kode session_closed | other_device | account_inactive | backoff
   */
  async function ingest(state, points) {
    const nowMs = Date.now();
    const rejected = [], valid = [];
    for (const p of points) {
      if (p.seq <= state.lastSeq) continue; // sudah tersimpan sebelumnya
      const v = validatePoint(p, { sessionStartMs: state.sessionStartMs, nowMs });
      if (v.ok) valid.push(v); else rejected.push({ seq: p.seq, reason: v.reason });
    }
    const already = points.filter((p) => p.seq <= state.lastSeq).map((p) => p.seq);
    const batchPts = valid.slice(0, MAX_BATCH);
    if (!batchPts.length) return { acked: [...already, ...rejected.map((r) => r.seq)], rejected, latestUpdated: false, lastSeq: state.lastSeq, lastCapturedAtMs: state.lastCapturedAtMs };
    const sorted = [...batchPts].sort((a, b) => a.point.t - b.point.t);
    flagJumps(sorted, state.prevFix || null);
    const maxSeq = Math.max(...batchPts.map((v) => v.point.seq));
    const newest = sorted[sorted.length - 1];
    const lastCap = state.lastCapturedAtMs || 0;
    const latest = newest.point.t > lastCap;
    const sRef = d('sesi', state.sessionId);
    const b = F.writeBatch(db);
    for (const v of batchPts) {
      b.set(F.doc(sRef, 'titik', String(v.point.seq)), {
        seq: v.point.seq, lat: v.point.lat, lng: v.point.lng, acc: v.point.acc, capturedAt: F.Timestamp.fromMillis(v.point.t),
        receivedAt: T(), deviceId: state.deviceId, quality: v.quality.slice(0, 3), terlambat: v.point.t <= lastCap,
      });
    }
    const newCapMs = latest ? newest.point.t : lastCap || null;
    b.update(sRef, { lastSeq: maxSeq, pointCount: F.increment(batchPts.length), lastCapturedAt: newCapMs ? F.Timestamp.fromMillis(newCapMs) : null, lastIngestAt: T() });
    if (latest) {
      b.update(d('lokasi_terkini', state.sessionId), {
        lat: newest.point.lat, lng: newest.point.lng, acc: newest.point.acc, capturedAt: F.Timestamp.fromMillis(newest.point.t),
        receivedAt: T(), quality: newest.quality.slice(0, 3), updatedAt: T(),
      });
    }
    try { await b.commit(); }
    catch (e) {
      if (code(e) !== 'permission-denied') throw e; // jaringan dsb → coba lagi nanti
      // Diagnosa: baca status sesi dari server.
      let s;
      try { s = await F.getDocFromServer(sRef); } catch (e2) { if (code(e2) === 'permission-denied') throw new DzError('account_inactive', 'Akun tidak aktif.'); throw e2; }
      const x = s.data();
      if (!x) throw new DzError('session_closed', 'Sesi tidak ditemukan.');
      if (x.status !== 'aktif') throw new DzError('session_closed', 'Sesi sudah ditutup.', { endedReason: x.endedReason });
      if (x.deviceId !== state.deviceId) throw new DzError('other_device', 'Sesi berjalan di perangkat lain.');
      if (x.lastSeq >= maxSeq) { // batch sebelumnya sudah tersimpan (respons hilang) → anggap duplikat
        return { acked: points.filter((p) => p.seq <= x.lastSeq).map((p) => p.seq), rejected, latestUpdated: false, lastSeq: x.lastSeq, lastCapturedAtMs: x.lastCapturedAt?.toMillis?.() ?? null, duplicate: true };
      }
      const li = x.lastIngestAt?.toMillis?.() ?? 0;
      if (Date.now() - li < MIN_INGEST_GAP_MS + 2000) throw new DzError('backoff', 'Pengiriman terlalu sering.', { retryAfterMs: MIN_INGEST_GAP_MS });
      const a = await F.getDocFromServer(d('akses', x.uid)).catch(() => null);
      if (!a?.exists() || a.data().status !== 'active') throw new DzError('account_inactive', 'Akun tidak aktif.');
      throw new DzError('rejected', 'Data titik ditolak server.', { lastSeq: x.lastSeq });
    }
    return { acked: [...already, ...rejected.map((r) => r.seq), ...batchPts.map((v) => v.point.seq)], rejected, latestUpdated: latest, lastSeq: maxSeq, lastCapturedAtMs: newCapMs, prevFix: newest.point };
  }

  /* ───────── Riwayat (akses dicatat di audit sebelum dibaca) ───────── */
  async function getSessionTrack(me, sessionId, limitN = 1000) {
    const s = await F.getDoc(d('sesi', sessionId));
    if (!s.exists()) throw new DzError('not-found', 'Sesi tidak ditemukan.');
    const x = s.data();
    if (x.uid !== me.uid) {
      const b = F.writeBatch(db);
      audit(b, { jenis: 'akses_riwayat_lokasi', actorUid: me.uid, unitId: x.unitId, target: sessionId, ringkasan: `Melihat riwayat lokasi sesi ${x.nama || sessionId}` });
      await b.commit();
    }
    const q = await F.getDocs(F.query(F.collection(s.ref, 'titik'), F.orderBy('capturedAt'), F.limit(limitN)));
    return {
      session: { id: s.id, uid: x.uid, nama: x.nama, kegiatanJudul: x.kegiatanJudul, status: x.status, endedReason: x.endedReason || null, titikDihapus: !!x.titikDihapus },
      points: q.docs.map((p) => { const v = p.data(); return { seq: v.seq, lat: v.lat, lng: v.lng, acc: v.acc, capturedAtMs: v.capturedAt.toMillis(), receivedAtMs: v.receivedAt?.toMillis?.() ?? null, quality: v.quality || [], terlambat: !!v.terlambat }; }),
      truncated: q.size >= limitN,
    };
  }
  async function logAccess(me, jenis, ringkasan) {
    const b = F.writeBatch(db);
    audit(b, { jenis, actorUid: me.uid, ringkasan });
    await b.commit();
  }

  /* ───────── Dashboard: hitungan agregat sesuai hak akses ───────── */
  async function dashboard(ctx) {
    const scope = ctx.isSys ? null : (ctx.scope || []);
    if (scope && !scope.length) return { empty: true, generatedAtMs: Date.now() };
    const cfg = await getSettings();
    const scoped = (q) => (scope ? F.query(q, F.where('unitId', 'in', scope.slice(0, 30))) : q);
    const count = async (q) => { try { return (await F.getCountFromServer(q)).data().count; } catch (e) { if (code(e) === 'permission-denied') return null; throw e; } };
    const C = (name, ...w) => count(scoped(F.query(F.collection(db, name), ...w)));
    const cutoff = F.Timestamp.fromMillis(Date.now() - cfg.staleMinutes * 60000);
    const [personelAktif, keg, lap, sesiAktif, staleOld, staleNone, feed] = await Promise.all([
      C('akses', F.where('status', '==', 'active')),
      Promise.all(KEGIATAN_STATUS.map((st) => C('kegiatan', F.where('status', '==', st)))),
      Promise.all(['draf', 'diajukan', 'perlu_revisi', 'disetujui'].map((st) => C('laporan', F.where('status', '==', st)))),
      C('lokasi_terkini', F.where('status', '==', 'aktif')),
      C('lokasi_terkini', F.where('status', '==', 'aktif'), F.where('capturedAt', '<', cutoff)),
      C('lokasi_terkini', F.where('status', '==', 'aktif'), F.where('capturedAt', '==', null)),
      F.getDocs(F.query(scoped(F.collection(db, 'aktivitas')), F.orderBy('at', 'desc'), F.limit(12))).catch(() => null),
    ]);
    const obj = (keys, vals) => (vals.some((v) => v === null) ? null : Object.fromEntries(keys.map((k, i) => [k, vals[i]])));
    return {
      generatedAtMs: Date.now(), staleMinutes: cfg.staleMinutes, scope,
      personelAktif,
      kegiatan: obj(KEGIATAN_STATUS, keg),
      laporan: obj(['draf', 'diajukan', 'perlu_revisi', 'disetujui'], lap),
      sesiAktif,
      lokasiBelumDiperbarui: staleOld === null || staleNone === null ? null : staleOld + staleNone,
      sesiBelumAdaLokasi: staleNone,
      aktivitas: feed ? feed.docs.map((x) => ({ id: x.id, jenis: x.data().jenis, ringkasan: x.data().ringkasan, atMs: x.data().at?.toMillis?.() ?? null })) : null,
    };
  }

  let settingsCache = null;
  async function getSettings() {
    if (settingsCache) return settingsCache;
    try { const s = await F.getDoc(d('pengaturan', 'umum')); settingsCache = mergeSettings(s.exists() ? s.data() : {}); }
    catch { settingsCache = mergeSettings({}); }
    return settingsCache;
  }

  /* ───────── Pemeliharaan (dijalankan administrator sistem dari admin) ───────── */
  async function maintenance(me, nowMs = Date.now()) {
    settingsCache = null;
    const cfg = await getSettings();
    const out = { autoEnded: 0, purgedSessions: 0, purgedPoints: 0 };
    const idle = await F.getDocs(F.query(F.collection(db, 'lokasi_terkini'), F.where('status', '==', 'aktif'),
      F.where('updatedAt', '<', F.Timestamp.fromMillis(nowMs - cfg.autoEndMinutes * 60000)), F.limit(100)));
    for (const x of idle.docs) {
      try { await endSession({ sessionId: x.id, reason: 'tidak_ada_pembaruan', actorUid: me.uid }); out.autoEnded++; } catch { /* lanjut */ }
    }
    const old = await F.getDocs(F.query(F.collection(db, 'sesi'), F.where('status', '==', 'selesai'),
      F.where('selesaiAt', '<', F.Timestamp.fromMillis(nowMs - cfg.retentionDays * 86400000)), F.limit(30)));
    for (const s of old.docs) {
      if (s.data().titikDihapus) continue;
      for (;;) {
        const pts = await F.getDocs(F.query(F.collection(s.ref, 'titik'), F.limit(400)));
        if (pts.empty) break;
        const b = F.writeBatch(db);
        pts.docs.forEach((p) => b.delete(p.ref));
        await b.commit();
        out.purgedPoints += pts.size;
      }
      const b = F.writeBatch(db);
      b.update(s.ref, { titikDihapus: true, titikDihapusAt: T() });
      b.delete(d('lokasi_terkini', s.id));
      await b.commit();
      out.purgedSessions++;
    }
    const b = F.writeBatch(db);
    b.set(d('pengaturan', 'pemeliharaan'), { lastRunAt: T(), lastRunBy: me.uid, ...out });
    if (out.autoEnded || out.purgedSessions) audit(b, { jenis: 'pemeliharaan', actorUid: me.uid, ringkasan: `Pemeliharaan: ${out.autoEnded} sesi diakhiri, ${out.purgedSessions} riwayat sesi dihapus (${out.purgedPoints} titik)` });
    await b.commit();
    return out;
  }

  return { register, setAccess, savePersonel, deleteAccount, startSession, endSession, ingest, getSessionTrack, logAccess, dashboard, getSettings, maintenance, addEndActiveSession };
}
