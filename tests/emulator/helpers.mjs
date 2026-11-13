// Utilitas uji emulator. Hanya berjalan terhadap project demo-* (emulator), tidak pernah produksi.
import { initializeApp as adminInit, getApps as adminApps } from 'firebase-admin/app';
import { getFirestore as adminDb, Timestamp } from 'firebase-admin/firestore';
import { getAuth as adminAuth } from 'firebase-admin/auth';
import { initializeApp, deleteApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, signInWithEmailAndPassword } from 'firebase/auth';
import * as F from 'firebase/firestore';
import { createDz } from '../../public/js/dz-data.js';

export const PROJECT = process.env.GCLOUD_PROJECT || 'demo-denzipur';
if (!PROJECT.startsWith('demo-')) throw new Error('Uji hanya boleh berjalan pada project demo-* (emulator).');
for (const v of ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST']) {
  if (!process.env[v]) throw new Error(`${v} tidak diset — jalankan lewat "npm run test:emu".`);
}
const FS = process.env.FIRESTORE_EMULATOR_HOST;
const AUTH = process.env.FIREBASE_AUTH_EMULATOR_HOST;

if (!adminApps().length) adminInit({ projectId: PROJECT });
export const adb = adminDb();
export { Timestamp, F };

export async function resetAll() {
  await fetch(`http://${FS}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  await fetch(`http://${AUTH}/emulator/v1/projects/${PROJECT}/accounts`, { method: 'DELETE' });
}

let n = 0;
const clients = [];
/** Buat akun uji (+ dokumen akses/personel bila diberikan); kembalikan klien yang sudah login. */
export async function makeUser(label, akses = null, { emailVerified = true } = {}) {
  const email = `${label}@denzipur.test`;
  const u = await adminAuth().createUser({ email, password: 'uji-emulator-123', emailVerified, displayName: `Uji ${label}` });
  if (akses) {
    await adb.doc(`akses/${u.uid}`).set({ uid: u.uid, email, role: 'anggota', status: 'active', unitId: null, unitScope: [], ...akses });
    await adb.doc(`personel/${u.uid}`).set({ uid: u.uid, email, nama: `Uji ${label}`, pangkat: 'Pratu', jabatan: 'Anggota', unitId: akses.unitId ?? null, statusKeanggotaan: 'aktif' });
  }
  const app = initializeApp({ apiKey: 'demo-key', projectId: PROJECT }, `c${n++}-${label}`);
  const auth = getAuth(app);
  connectAuthEmulator(auth, `http://${AUTH}`, { disableWarnings: true });
  const db = F.getFirestore(app);
  const [h, p] = FS.split(':');
  F.connectFirestoreEmulator(db, h, +p);
  await signInWithEmailAndPassword(auth, email, 'uji-emulator-123');
  const c = { uid: u.uid, email, app, auth, db, dz: createDz(F, db), user: auth.currentUser };
  clients.push(c);
  return c;
}
export async function closeAll() { while (clients.length) await deleteApp(clients.pop().app).catch(() => {}); }

export async function expectCode(promise, code, label = '') {
  try { await promise; } catch (e) {
    const got = String(e.code || '').replace(/^(firestore|functions)\//, '');
    if (got === code) return e;
    throw new Error(`Diharapkan kode "${code}", diterima "${e.code}": ${e.message} ${label}`);
  }
  throw new Error(`Diharapkan gagal dengan "${code}", tetapi berhasil. ${label}`);
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function seedUnits() {
  await adb.doc('unit/UNIT-A').set({ nama: 'Unit Uji A', kode: 'A' });
  await adb.doc('unit/UNIT-B').set({ nama: 'Unit Uji B', kode: 'B' });
}
export async function seedKegiatan(id, unitId, pesertaUids, extra = {}) {
  await adb.doc(`kegiatan/${id}`).set({
    judul: `Kegiatan uji ${id}`, deskripsi: '', unitId, penanggungJawabUid: null, pesertaUids,
    jadwalMulai: Timestamp.now(), jadwalSelesai: null, lokasiNama: 'Lokasi fiktif', lokasiLat: null, lokasiLng: null,
    status: 'rencana', trackingDiizinkan: true, createdBy: 'seed', createdAt: Timestamp.now(), updatedBy: 'seed', updatedAt: Timestamp.now(), ...extra,
  });
}
// Koordinat fiktif (grid uji di laut), bukan lokasi personel nyata.
export const P = (seq, t, lat = -5.0 + seq * 0.0001, lng = 100.0) => ({ seq, lat, lng, acc: 8, t });

/** Status sesi untuk dz.ingest (seperti yang disimpan aplikasi anggota). */
export function sessState(s, deviceId) {
  return { sessionId: s.sessionId, deviceId, sessionStartMs: s.mulaiAtMs, lastSeq: s.lastSeq, lastCapturedAtMs: s.lastCapturedAtMs ?? null, prevFix: null };
}
export function applyIngest(state, r) { state.lastSeq = r.lastSeq; state.lastCapturedAtMs = r.lastCapturedAtMs; if (r.prevFix) state.prevFix = r.prevFix; return state; }
