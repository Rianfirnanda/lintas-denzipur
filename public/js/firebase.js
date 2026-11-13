// Inisialisasi Firebase tunggal untuk semua halaman Denzipur (paket Spark: Auth + Firestore + Hosting).
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import { getAuth, connectAuthEmulator, onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import * as F from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { DZ } from './config.js';
import { createDz } from './dz-data.js';

export { F, DZ, onAuthStateChanged, signOut };
export const app = initializeApp(DZ.firebase);
export const auth = getAuth(app);
export const db = F.getFirestore(app, DZ.databaseId);

if (DZ.emulator) {
  connectAuthEmulator(auth, `http://${location.hostname}:9099`, { disableWarnings: true });
  F.connectFirestoreEmulator(db, location.hostname, 8080);
} else if (DZ.appCheckSiteKey) {
  // Integrasi bertahap: token App Check dikirim; enforcement diaktifkan terpisah di Console.
  import('https://www.gstatic.com/firebasejs/10.14.1/firebase-app-check.js').then(({ initializeAppCheck, ReCaptchaEnterpriseProvider }) => {
    initializeAppCheck(app, { provider: new ReCaptchaEnterpriseProvider(DZ.appCheckSiteKey), isTokenAutoRefreshEnabled: true });
  }).catch((e) => console.warn('App Check tidak aktif:', e.message));
}

/** Operasi data bersama (pengganti Cloud Functions; ditegakkan Firestore Rules). */
export const dz = createDz(F, db);

/** Pesan galat yang dapat dibaca pengguna. */
export function errText(e) {
  const code = String(e?.code || '').replace(/^(firestore|auth)\//, '');
  const map = {
    'permission-denied': 'Akses ditolak.', unauthenticated: 'Sesi login berakhir. Silakan masuk kembali.',
    unavailable: 'Server tidak dapat dihubungi. Periksa koneksi.', 'deadline-exceeded': 'Waktu permintaan habis.',
    'failed-precondition': 'Permintaan tidak dapat diproses pada kondisi saat ini.', 'not-found': 'Data tidak ditemukan.',
    'resource-exhausted': 'Kuota harian Firestore habis atau permintaan terlalu sering. Coba lagi nanti.',
  };
  if (map[code] && !(e instanceof Error && e.name === 'Error' && e.details)) return map[code];
  return e?.message || map[code] || 'Terjadi kesalahan.';
}
