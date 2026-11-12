// Cloud Functions Lintas Denzipur (codebase "denzipur").
// Semua operasi otoritatif (akses, sesi tracking, titik lokasi, audit) lewat sini;
// Admin SDK melewati Rules, jadi setiap fungsi memeriksa otorisasi sendiri.
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { setGlobalOptions } from 'firebase-functions/v2';
import { logger } from 'firebase-functions';
import {
  ROLES, STAFF_ROLES, ACCOUNT_STATUS, KEGIATAN_STATUS, mergeSettings, isSafeId,
  validatePoint, flagJumps, dzClaims,
} from './core.js';

const REGION = process.env.DZ_REGION || 'asia-southeast2';
const DB_ID = process.env.DZ_DATABASE || 'denzipur';
// App Check: mulai "false" (mode monitor). Ubah ke "true" hanya setelah semua klien terdaftar.
const ENFORCE_APP_CHECK = process.env.DZ_ENFORCE_APP_CHECK === 'true';
const BOOTSTRAP_ADMINS = (process.env.DZ_BOOTSTRAP_ADMINS || '')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

initializeApp();
const db = getFirestore(DB_ID);
setGlobalOptions({ region: REGION, maxInstances: 10 });

const callOpts = { enforceAppCheck: ENFORCE_APP_CHECK, cors: true };
const fail = (code, msg, details) => { throw new HttpsError(code, msg, details); };
const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/* ───────────── util akses ───────────── */
async function loadAkses(uid) {
  const s = await db.doc(`akses/${uid}`).get();
  return s.exists ? { uid, ...s.data() } : null;
}
async function requireActive(req, roles) {
  if (!req.auth) fail('unauthenticated', 'Harus masuk terlebih dahulu.');
  const a = await loadAkses(req.auth.uid);
  if (!a) fail('permission-denied', 'Akun belum terdaftar di Lintas Denzipur.');
  if (a.status === 'blocked') fail('permission-denied', 'Akun diblokir.', { reason: 'blocked' });
  if (a.status !== 'active') fail('permission-denied', 'Akun belum diaktifkan.', { reason: 'pending' });
  if (roles && !roles.includes(a.role)) fail('permission-denied', 'Peran tidak berwenang.');
  return a;
}
const scopeOf = (a) => (a.role === 'sysadmin' ? null : (a.unitScope || []));
const inScope = (a, unitId) => a.role === 'sysadmin' || (a.unitScope || []).includes(unitId);
const canSeeLocation = (a, unitId) => a.role === 'sysadmin' || (a.role === 'operator' && inScope(a, unitId));

let settingsCache = { at: 0, v: null };
async function getSettings() {
  if (Date.now() - settingsCache.at < 60000 && settingsCache.v) return settingsCache.v;
  const s = await db.doc('pengaturan/umum').get();
  settingsCache = { at: Date.now(), v: mergeSettings(s.exists ? s.data() : {}) };
  return settingsCache.v;
}

/** Audit (sysadmin) + umpan aktivitas per unit (tanpa koordinat). */
function logEvent(batchOrTx, { jenis, actorUid, unitId = null, ringkasan, target = null, feed = true, detail = null }) {
  const at = FieldValue.serverTimestamp();
  const w = (ref, data) => (batchOrTx ? batchOrTx.set(ref, data) : ref.set(data));
  const p1 = w(db.collection('audit').doc(), { jenis, actorUid, unitId, ringkasan, target, detail, at });
  const p2 = feed ? w(db.collection('aktivitas').doc(), { jenis, unitId, ringkasan, at }) : null;
  return batchOrTx ? null : Promise.all([p1, p2]);
}

async function syncClaims(uid, akses) {
  try {
    const u = await getAuth().getUser(uid);
    const claims = { ...(u.customClaims || {}) };
    if (akses) claims.dz = dzClaims(akses); else delete claims.dz;
    await getAuth().setCustomUserClaims(uid, claims); // klaim aplikasi lain dipertahankan
  } catch (e) { logger.warn('syncClaims gagal', { uid, code: e.code }); }
}

/* ───────────── registrasi & akses ───────────── */
export const dzRegister = onCall(callOpts, async (req) => {
  if (!req.auth) fail('unauthenticated', 'Harus masuk.');
  const { uid, token } = req.auth;
  const email = (token.email || '').toLowerCase();
  const verified = token.email_verified === true;
  const ref = db.doc(`akses/${uid}`);

  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const inviteRef = email ? db.doc(`undangan/${email}`) : null;
    const inv = inviteRef && verified ? await tx.get(inviteRef) : null;
    const now = FieldValue.serverTimestamp();

    if (snap.exists) {
      const cur = snap.data();
      const patch = { lastLogin: now };
      if (cur.status === 'pending' && inv?.exists) {
        const d = inv.data();
        Object.assign(patch, { status: 'active', role: d.role, unitId: d.unitId || null, unitScope: d.unitScope || [], updatedAt: now, updatedBy: 'undangan' });
        tx.delete(inviteRef);
        tx.set(db.doc(`personel/${uid}`), { unitId: d.unitId || null, updatedAt: now }, { merge: true });
        logEvent(tx, { jenis: 'akun_aktif_undangan', actorUid: uid, unitId: d.unitId || null, ringkasan: `Akun ${email} aktif lewat undangan`, target: uid });
      }
      tx.update(ref, patch);
      return { ...cur, ...patch, lastLogin: null };
    }

    let akses = { uid, email, role: 'anggota', status: 'pending', unitId: null, unitScope: [] };
    if (inv?.exists) {
      const d = inv.data();
      akses = { ...akses, role: d.role, status: 'active', unitId: d.unitId || null, unitScope: d.unitScope || [] };
      tx.delete(inviteRef);
    } else if (verified && BOOTSTRAP_ADMINS.includes(email)) {
      akses = { ...akses, role: 'sysadmin', status: 'active' };
    }
    tx.set(ref, { ...akses, createdAt: now, updatedAt: now, lastLogin: now, updatedBy: 'registrasi' });
    tx.set(db.doc(`personel/${uid}`), {
      uid, email, nama: str(token.name, 120) || email, pangkat: '', jabatan: '',
      unitId: akses.unitId, statusKeanggotaan: 'aktif', createdAt: now, updatedAt: now,
    }, { merge: true });
    logEvent(tx, {
      jenis: 'akun_baru', actorUid: uid, unitId: akses.unitId,
      ringkasan: akses.status === 'active' ? `Akun baru aktif: ${email}` : `Akun baru menunggu persetujuan: ${email}`, target: uid,
    });
    return akses;
  });
  await syncClaims(uid, result);
  return { role: result.role, status: result.status, unitId: result.unitId || null, unitScope: result.unitScope || [] };
});

export const dzSetAccess = onCall(callOpts, async (req) => {
  const me = await requireActive(req, ['sysadmin']);
  const { uid } = req.data || {};
  if (!(typeof uid === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(uid))) fail('invalid-argument', 'UID tidak valid.');
  if (uid === me.uid) fail('failed-precondition', 'Tidak dapat mengubah akses akun sendiri.');
  const role = req.data.role, status = req.data.status;
  if (!ROLES.includes(role)) fail('invalid-argument', 'Peran tidak valid.');
  if (!ACCOUNT_STATUS.includes(status)) fail('invalid-argument', 'Status tidak valid.');
  const unitId = req.data.unitId ? str(req.data.unitId, 64) : null;
  const unitScope = Array.isArray(req.data.unitScope) ? [...new Set(req.data.unitScope.map((x) => str(x, 64)).filter(Boolean))].slice(0, 30) : [];
  if (STAFF_ROLES.includes(role) && status === 'active' && !unitScope.length) fail('invalid-argument', 'Peran unit membutuhkan minimal satu unit lingkup.');
  if (role === 'anggota' && status === 'active' && !unitId) fail('invalid-argument', 'Anggota aktif harus memiliki unit.');
  for (const u of new Set([unitId, ...unitScope].filter(Boolean))) {
    if (!(await db.doc(`unit/${u}`).get()).exists) fail('invalid-argument', `Unit ${u} tidak ditemukan.`);
  }

  const ref = db.doc(`akses/${uid}`);
  const after = await db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    if (!s.exists) fail('not-found', 'Akun tidak ditemukan.');
    const cur = s.data();
    if (cur.role === 'sysadmin' && cur.status === 'active' && (role !== 'sysadmin' || status !== 'active')) {
      const others = await tx.get(db.collection('akses').where('role', '==', 'sysadmin').where('status', '==', 'active').limit(2));
      if (others.size < 2) fail('failed-precondition', 'Minimal harus ada satu administrator sistem aktif.');
    }
    const now = FieldValue.serverTimestamp();
    const next = { role, status, unitId, unitScope: role === 'anggota' ? [] : unitScope };
    tx.update(ref, { ...next, updatedAt: now, updatedBy: me.uid });
    tx.set(db.doc(`personel/${uid}`), { unitId, updatedAt: now }, { merge: true });
    logEvent(tx, {
      jenis: 'akses_diubah', actorUid: me.uid, unitId, target: uid,
      ringkasan: `Akses ${cur.email || uid}: ${cur.role}/${cur.status} → ${role}/${status}`,
      detail: { sebelum: { role: cur.role, status: cur.status, unitId: cur.unitId || null }, sesudah: next },
    });
    return { ...cur, ...next };
  });
  await syncClaims(uid, after);
  if (status !== 'active') {
    await endActiveSessionOf(uid, status === 'blocked' ? 'akun_diblokir' : 'akses_dicabut', me.uid);
    if (status === 'blocked') await getAuth().revokeRefreshTokens(uid).catch(() => {});
  }
  return { ok: true };
});

export const dzDeleteAccount = onCall(callOpts, async (req) => {
  const me = await requireActive(req, ['sysadmin']);
  const uid = str(req.data?.uid, 128);
  if (!uid || uid === me.uid) fail('failed-precondition', 'Akun tidak dapat dihapus.');
  const s = await db.doc(`akses/${uid}`).get();
  if (!s.exists) fail('not-found', 'Akun tidak ditemukan.');
  if (s.data().role === 'sysadmin') fail('failed-precondition', 'Cabut peran administrator sebelum menghapus.');
  await endActiveSessionOf(uid, 'akun_dihapus', me.uid);
  const b = db.batch();
  b.delete(db.doc(`akses/${uid}`));
  b.delete(db.doc(`personel/${uid}`));
  logEvent(b, { jenis: 'akun_dihapus', actorUid: me.uid, unitId: s.data().unitId || null, ringkasan: `Akun ${s.data().email || uid} dihapus dari Denzipur`, target: uid });
  await b.commit();
  await syncClaims(uid, null); // Akun Auth tidak dihapus: dipakai bersama Lintas Benteng.
  return { ok: true };
});

export const dzSavePersonel = onCall(callOpts, async (req) => {
  const me = await requireActive(req, ['sysadmin', 'operator']);
  const uid = str(req.data?.uid, 128);
  const ref = db.doc(`personel/${uid}`);
  const s = await ref.get();
  if (!uid || !s.exists) fail('not-found', 'Personel tidak ditemukan.');
  if (me.role === 'operator' && !inScope(me, s.data().unitId)) fail('permission-denied', 'Personel di luar unit Anda.');
  const nama = str(req.data.nama, 120);
  if (nama.length < 2) fail('invalid-argument', 'Nama wajib diisi.');
  const statusKeanggotaan = req.data.statusKeanggotaan;
  if (!['aktif', 'nonaktif', 'mutasi', 'pensiun'].includes(statusKeanggotaan)) fail('invalid-argument', 'Status keanggotaan tidak valid.');
  const patch = { nama, pangkat: str(req.data.pangkat, 60), jabatan: str(req.data.jabatan, 120), statusKeanggotaan, updatedAt: FieldValue.serverTimestamp(), updatedBy: me.uid };
  const b = db.batch();
  b.update(ref, patch);
  logEvent(b, { jenis: 'personel_diubah', actorUid: me.uid, unitId: s.data().unitId || null, ringkasan: `Profil ${nama} diperbarui`, target: uid });
  await b.commit();
  return { ok: true };
});

/* ───────────── sesi tracking ───────────── */
async function personelSummary(uid) {
  const p = await db.doc(`personel/${uid}`).get();
  const d = p.exists ? p.data() : {};
  return { nama: d.nama || '', pangkat: d.pangkat || '' };
}

export const dzStartSession = onCall(callOpts, async (req) => {
  const me = await requireActive(req);
  const kegiatanId = str(req.data?.kegiatanId, 64);
  const deviceId = str(req.data?.deviceId, 64);
  if (!kegiatanId) fail('invalid-argument', 'Kegiatan wajib dipilih.');
  if (!isSafeId(deviceId)) fail('invalid-argument', 'ID perangkat tidak valid.');
  const who = await personelSummary(me.uid);
  const lockRef = db.doc(`sesi_aktif/${me.uid}`);

  return db.runTransaction(async (tx) => {
    const [kg, lock] = await Promise.all([tx.get(db.doc(`kegiatan/${kegiatanId}`)), tx.get(lockRef)]);
    if (!kg.exists) fail('not-found', 'Kegiatan tidak ditemukan.');
    const k = kg.data();
    if (!(k.pesertaUids || []).includes(me.uid)) fail('permission-denied', 'Anda tidak ditugaskan pada kegiatan ini.');
    if (!['rencana', 'berjalan'].includes(k.status)) fail('failed-precondition', 'Kegiatan tidak sedang berlangsung.');
    if (k.trackingDiizinkan === false) fail('failed-precondition', 'Tracking tidak diaktifkan untuk kegiatan ini.');

    if (lock.exists) {
      const l = lock.data();
      const cur = await tx.get(db.doc(`sesi/${l.sessionId}`));
      if (cur.exists && cur.data().status === 'aktif') {
        if (l.deviceId === deviceId && l.kegiatanId === kegiatanId) {
          return { sessionId: l.sessionId, resumed: true, mulaiAtMs: cur.data().mulaiAt?.toMillis?.() ?? null, lastSeq: cur.data().lastSeq ?? -1 };
        }
        fail('already-exists', 'Masih ada sesi tracking aktif.', { sessionId: l.sessionId, kegiatanId: l.kegiatanId, perangkatLain: l.deviceId !== deviceId });
      }
    }
    const ref = db.collection('sesi').doc();
    const now = FieldValue.serverTimestamp();
    const base = { uid: me.uid, unitId: k.unitId, kegiatanId, kegiatanJudul: k.judul || '', nama: who.nama, pangkat: who.pangkat };
    tx.set(ref, { ...base, deviceId, status: 'aktif', mulaiAt: now, selesaiAt: null, endedReason: null, pointCount: 0, lastSeq: -1, lastCapturedAt: null, lastReceivedAt: null, lastIngestAt: null });
    tx.set(lockRef, { sessionId: ref.id, deviceId, kegiatanId, at: now });
    tx.set(db.doc(`lokasi_terkini/${ref.id}`), {
      ...base, sessionId: ref.id, status: 'aktif', mulaiAt: now, selesaiAt: null,
      lat: null, lng: null, acc: null, capturedAt: null, receivedAt: null, quality: [], pointCount: 0, updatedAt: now,
    });
    if (k.status === 'rencana') tx.update(kg.ref, { status: 'berjalan', updatedAt: now });
    logEvent(tx, { jenis: 'tracking_mulai', actorUid: me.uid, unitId: k.unitId, ringkasan: `${who.nama || me.email} mulai tracking: ${k.judul || kegiatanId}`, target: ref.id });
    return { sessionId: ref.id, resumed: false, mulaiAtMs: Date.now(), lastSeq: -1 };
  });
});

async function endSessionTx(sessionId, { reason, actorUid, check }) {
  const sRef = db.doc(`sesi/${sessionId}`);
  return db.runTransaction(async (tx) => {
    const s = await tx.get(sRef);
    if (!s.exists) fail('not-found', 'Sesi tidak ditemukan.');
    const d = s.data();
    if (check) check(d);
    if (d.status !== 'aktif') return { ok: true, alreadyEnded: true };
    const lockRef = db.doc(`sesi_aktif/${d.uid}`);
    const lock = await tx.get(lockRef);
    const now = FieldValue.serverTimestamp();
    tx.update(sRef, { status: 'selesai', selesaiAt: now, endedReason: reason, endedBy: actorUid });
    tx.set(db.doc(`lokasi_terkini/${sessionId}`), { status: 'selesai', selesaiAt: now, endedReason: reason, updatedAt: now }, { merge: true });
    if (lock.exists && lock.data().sessionId === sessionId) tx.delete(lockRef);
    logEvent(tx, { jenis: 'tracking_selesai', actorUid, unitId: d.unitId, ringkasan: `Tracking ${d.nama || d.uid} diakhiri (${reason})`, target: sessionId });
    return { ok: true, alreadyEnded: false };
  });
}
async function endActiveSessionOf(uid, reason, actorUid) {
  const lock = await db.doc(`sesi_aktif/${uid}`).get();
  if (lock.exists) await endSessionTx(lock.data().sessionId, { reason, actorUid }).catch((e) => logger.warn('endActiveSessionOf', e.message));
}

export const dzEndSession = onCall(callOpts, async (req) => {
  // Pemilik boleh mengakhiri sesinya walau statusnya baru diblokir? Tidak: requireActive dulu,
  // sesi milik akun terblokir sudah diakhiri otomatis oleh dzSetAccess.
  const me = await requireActive(req);
  const sessionId = str(req.data?.sessionId, 64);
  const reasons = ['selesai_oleh_anggota', 'diakhiri_operator', 'pindah_perangkat', 'keluar_aplikasi'];
  const reason = reasons.includes(req.data?.reason) ? req.data.reason : 'selesai_oleh_anggota';
  return endSessionTx(sessionId, {
    reason, actorUid: me.uid,
    check: (d) => { if (d.uid !== me.uid && !canSeeLocation(me, d.unitId)) fail('permission-denied', 'Tidak berwenang mengakhiri sesi ini.'); },
  });
});

export const dzIngestPoints = onCall(callOpts, async (req) => {
  const me = await requireActive(req);
  const cfg = await getSettings();
  const sessionId = str(req.data?.sessionId, 64);
  const deviceId = str(req.data?.deviceId, 64);
  const pts = req.data?.points;
  if (!sessionId || !isSafeId(deviceId)) fail('invalid-argument', 'Sesi/perangkat tidak valid.');
  if (!Array.isArray(pts) || pts.length < 1 || pts.length > cfg.maxBatch) fail('invalid-argument', `Jumlah titik harus 1–${cfg.maxBatch}.`);
  if (JSON.stringify(pts).length > cfg.maxBatch * 200) fail('invalid-argument', 'Ukuran data terlalu besar.');
  const sRef = db.doc(`sesi/${sessionId}`);
  const latestRef = db.doc(`lokasi_terkini/${sessionId}`);

  return db.runTransaction(async (tx) => {
    const s = await tx.get(sRef);
    if (!s.exists) fail('not-found', 'Sesi tidak ditemukan.');
    const d = s.data();
    if (d.uid !== me.uid) fail('permission-denied', 'Sesi bukan milik Anda.');
    if (d.status !== 'aktif') fail('failed-precondition', 'Sesi sudah ditutup.', { reason: 'sesi_ditutup', endedReason: d.endedReason || null });
    if (d.deviceId !== deviceId) fail('failed-precondition', 'Sesi berjalan di perangkat lain.', { reason: 'perangkat_lain' });
    const nowMs = Date.now();
    const lastIngest = d.lastIngestAt?.toMillis?.() ?? 0;
    if (nowMs - lastIngest < cfg.minIngestGapMs) fail('resource-exhausted', 'Pengiriman terlalu sering.', { retryAfterMs: cfg.minIngestGapMs - (nowMs - lastIngest) });

    const startMs = d.mulaiAt?.toMillis?.() ?? nowMs;
    const rejected = [], valid = [];
    const seen = new Set();
    for (const p of pts) {
      const v = validatePoint(p, { sessionStartMs: startMs, nowMs });
      if (!v.ok) { rejected.push({ seq: Number.isInteger(p?.seq) ? p.seq : null, reason: v.reason }); continue; }
      if (seen.has(v.point.seq)) continue;
      seen.add(v.point.seq);
      valid.push(v);
    }
    const refs = valid.map((v) => sRef.collection('titik').doc(`${deviceId}_${String(v.point.seq).padStart(9, '0')}`));
    const existing = refs.length ? await tx.getAll(...refs) : [];
    const latestSnap = await tx.get(latestRef);
    const fresh = [], duplicates = [];
    valid.forEach((v, i) => (existing[i].exists ? duplicates.push(v.point.seq) : fresh.push({ ...v, ref: refs[i] })));
    fresh.sort((a, b) => a.point.t - b.point.t);

    const lastCapMs = d.lastCapturedAt?.toMillis?.() ?? 0;
    const prev = latestSnap.exists && latestSnap.data().lat != null
      ? { lat: latestSnap.data().lat, lng: latestSnap.data().lng, t: latestSnap.data().capturedAt?.toMillis?.() ?? 0 } : null;
    flagJumps(fresh, prev);

    const now = FieldValue.serverTimestamp();
    for (const f of fresh) {
      tx.create(f.ref, {
        uid: me.uid, sessionId, deviceId, seq: f.point.seq, lat: f.point.lat, lng: f.point.lng, acc: f.point.acc,
        capturedAt: Timestamp.fromMillis(f.point.t), receivedAt: now, sumber: 'gps_perangkat',
        quality: f.quality, terlambat: f.point.t <= lastCapMs,
      });
    }
    const newest = fresh.length ? fresh[fresh.length - 1] : null;
    const sesiPatch = { lastIngestAt: Timestamp.fromMillis(nowMs), pointCount: FieldValue.increment(fresh.length) };
    if (fresh.length) {
      sesiPatch.lastReceivedAt = now;
      sesiPatch.lastSeq = Math.max(d.lastSeq ?? -1, ...fresh.map((f) => f.point.seq));
    }
    // Titik lama (antrean offline / tidak berurutan) tidak boleh menggantikan posisi terkini.
    if (newest && newest.point.t > lastCapMs) {
      sesiPatch.lastCapturedAt = Timestamp.fromMillis(newest.point.t);
      tx.set(latestRef, {
        lat: newest.point.lat, lng: newest.point.lng, acc: newest.point.acc,
        capturedAt: Timestamp.fromMillis(newest.point.t), receivedAt: now, quality: newest.quality,
        pointCount: FieldValue.increment(fresh.length), updatedAt: now,
      }, { merge: true });
    } else if (fresh.length) {
      tx.set(latestRef, { pointCount: FieldValue.increment(fresh.length), updatedAt: now }, { merge: true });
    }
    tx.update(sRef, sesiPatch);
    return {
      accepted: fresh.map((f) => f.point.seq), duplicates, rejected,
      latestUpdated: !!(newest && newest.point.t > lastCapMs), serverTimeMs: nowMs,
    };
  });
});

export const dzGetSessionTrack = onCall(callOpts, async (req) => {
  const me = await requireActive(req);
  const sessionId = str(req.data?.sessionId, 64);
  const limit = Math.min(Math.max(parseInt(req.data?.limit, 10) || 1000, 1), 2000);
  const s = await db.doc(`sesi/${sessionId}`).get();
  if (!s.exists) fail('not-found', 'Sesi tidak ditemukan.');
  const d = s.data();
  if (d.uid !== me.uid && !canSeeLocation(me, d.unitId)) fail('permission-denied', 'Tidak berwenang melihat riwayat lokasi ini.');
  const q = await s.ref.collection('titik').orderBy('capturedAt').limit(limit).get();
  if (d.uid !== me.uid) {
    await logEvent(null, { jenis: 'akses_riwayat_lokasi', actorUid: me.uid, unitId: d.unitId, feed: false, target: sessionId, ringkasan: `Melihat riwayat lokasi sesi ${sessionId} (${q.size} titik)` });
  }
  return {
    session: { id: s.id, uid: d.uid, nama: d.nama, kegiatanJudul: d.kegiatanJudul, status: d.status, mulaiAtMs: d.mulaiAt?.toMillis?.() ?? null, selesaiAtMs: d.selesaiAt?.toMillis?.() ?? null, endedReason: d.endedReason || null, titikDihapus: !!d.titikDihapus },
    points: q.docs.map((x) => {
      const p = x.data();
      return { seq: p.seq, lat: p.lat, lng: p.lng, acc: p.acc, capturedAtMs: p.capturedAt.toMillis(), receivedAtMs: p.receivedAt?.toMillis?.() ?? null, quality: p.quality || [], terlambat: !!p.terlambat };
    }),
    truncated: q.size >= limit,
  };
});

export const dzLogAccess = onCall(callOpts, async (req) => {
  const me = await requireActive(req, ['sysadmin', 'operator', 'pemeriksa', 'pembaca']);
  const jenis = req.data?.jenis;
  if (!['buka_live_tracking', 'ekspor_laporan', 'ekspor_lokasi'].includes(jenis)) fail('invalid-argument', 'Jenis akses tidak valid.');
  await logEvent(null, { jenis, actorUid: me.uid, feed: false, ringkasan: `${jenis} oleh ${me.email || me.uid}`, detail: { filter: str(JSON.stringify(req.data?.filter ?? null), 500) } });
  return { ok: true };
});

/* ───────────── dashboard ───────────── */
export const dzDashboard = onCall(callOpts, async (req) => {
  const me = await requireActive(req, ['sysadmin', 'operator', 'pemeriksa', 'pembaca']);
  const cfg = await getSettings();
  const scope = scopeOf(me);
  if (scope && !scope.length) return { generatedAtMs: Date.now(), scope: [], empty: true };
  const scoped = (q, field = 'unitId') => (scope ? q.where(field, 'in', scope) : q);
  const count = async (q) => (await q.count().get()).data().count;
  const cutoff = Timestamp.fromMillis(Date.now() - cfg.staleMinutes * 60000);
  const lt = db.collection('lokasi_terkini');
  const showLoc = me.role === 'sysadmin' || me.role === 'operator';

  const [personelAktif, keg, lap, sesiAktif, staleOld, staleNone, feed] = await Promise.all([
    count(scoped(db.collection('akses').where('status', '==', 'active'))),
    Promise.all(KEGIATAN_STATUS.map((st) => count(scoped(db.collection('kegiatan').where('status', '==', st))))),
    Promise.all(['draf', 'diajukan', 'perlu_revisi', 'disetujui'].map((st) => count(scoped(db.collection('laporan').where('status', '==', st))))),
    count(scoped(lt.where('status', '==', 'aktif'))),
    count(scoped(lt.where('status', '==', 'aktif').where('capturedAt', '<', cutoff))),
    count(scoped(lt.where('status', '==', 'aktif').where('capturedAt', '==', null))),
    scoped(db.collection('aktivitas')).orderBy('at', 'desc').limit(12).get(),
  ]);
  return {
    generatedAtMs: Date.now(), staleMinutes: cfg.staleMinutes, scope,
    personelAktif,
    kegiatan: Object.fromEntries(KEGIATAN_STATUS.map((s, i) => [s, keg[i]])),
    laporan: { draf: lap[0], diajukan: lap[1], perlu_revisi: lap[2], disetujui: lap[3] },
    sesiAktif,
    lokasiBelumDiperbarui: showLoc ? staleOld + staleNone : null,
    sesiBelumAdaLokasi: showLoc ? staleNone : null,
    aktivitas: feed.docs.map((x) => ({ id: x.id, jenis: x.data().jenis, ringkasan: x.data().ringkasan, atMs: x.data().at?.toMillis?.() ?? null })),
  };
});

/* ───────────── pemicu & pemeliharaan ───────────── */
const LAPORAN_LABEL = { draf: 'Draf', diajukan: 'Diajukan', perlu_revisi: 'Perlu Revisi', disetujui: 'Disetujui' };
export const dzOnLaporanWrite = onDocumentWritten({ document: 'laporan/{id}', database: DB_ID }, async (ev) => {
  const before = ev.data?.before?.exists ? ev.data.before.data() : null;
  const after = ev.data?.after?.exists ? ev.data.after.data() : null;
  if (!after || before?.status === after.status) return;
  const actor = after.status === 'perlu_revisi' || after.status === 'disetujui' ? after.pemeriksaUid : after.uid;
  await logEvent(null, {
    jenis: `laporan_${after.status}`, actorUid: actor || null, unitId: after.unitId || null, target: ev.params.id,
    ringkasan: `Laporan "${after.judul || ''}" → ${LAPORAN_LABEL[after.status] || after.status}`,
  });
});
export const dzOnKegiatanWrite = onDocumentWritten({ document: 'kegiatan/{id}', database: DB_ID }, async (ev) => {
  const before = ev.data?.before?.exists ? ev.data.before.data() : null;
  const after = ev.data?.after?.exists ? ev.data.after.data() : null;
  if (!after) return;
  if (before && before.status === after.status) return;
  await logEvent(null, {
    jenis: before ? `kegiatan_${after.status}` : 'kegiatan_baru', actorUid: after.updatedBy || after.createdBy || null,
    unitId: after.unitId || null, target: ev.params.id,
    ringkasan: before ? `Kegiatan "${after.judul}" → ${after.status}` : `Kegiatan baru: "${after.judul}"`,
  });
});

export async function runMaintenance(nowMs = Date.now()) {
  const cfg = await getSettings();
  const out = { autoEnded: 0, purgedSessions: 0, purgedPoints: 0 };
  const idle = await db.collection('lokasi_terkini').where('status', '==', 'aktif')
    .where('updatedAt', '<', Timestamp.fromMillis(nowMs - cfg.autoEndMinutes * 60000)).limit(200).get();
  for (const d of idle.docs) {
    await endSessionTx(d.id, { reason: 'tidak_ada_pembaruan', actorUid: 'sistem' }).catch(() => {});
    out.autoEnded++;
  }
  const old = await db.collection('sesi').where('status', '==', 'selesai')
    .where('selesaiAt', '<', Timestamp.fromMillis(nowMs - cfg.retentionDays * 86400000)).limit(50).get();
  for (const s of old.docs) {
    if (s.data().titikDihapus) continue;
    const pts = await s.ref.collection('titik').listDocuments();
    out.purgedPoints += pts.length;
    await db.recursiveDelete(s.ref.collection('titik'));
    await s.ref.update({ titikDihapus: true, titikDihapusAt: FieldValue.serverTimestamp() });
    await db.doc(`lokasi_terkini/${s.id}`).delete();
    out.purgedSessions++;
  }
  if (out.autoEnded || out.purgedSessions) {
    await logEvent(null, { jenis: 'pemeliharaan', actorUid: 'sistem', feed: false, ringkasan: `Pemeliharaan: ${out.autoEnded} sesi diakhiri, ${out.purgedSessions} riwayat sesi dihapus (${out.purgedPoints} titik)` });
  }
  return out;
}
export const dzMaintenance = onSchedule({ schedule: 'every 30 minutes', timeZone: 'Asia/Jakarta' }, async () => { await runMaintenance(); });
export const dzRunMaintenance = onCall(callOpts, async (req) => {
  await requireActive(req, ['sysadmin']);
  return runMaintenance();
});
