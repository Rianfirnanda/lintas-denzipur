// Inisialisasi Firebase tunggal untuk semua halaman Denzipur.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import { getAuth, connectAuthEmulator, onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import * as F from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { getFunctions, connectFunctionsEmulator, httpsCallable } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-functions.js';
import { getStorage, connectStorageEmulator } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-storage.js';
import { DZ } from './config.js';

export { F, DZ, onAuthStateChanged, signOut };
export const app = initializeApp(DZ.firebase);
export const auth = getAuth(app);
export const db = F.getFirestore(app, DZ.databaseId);
export const fns = getFunctions(app, DZ.functionsRegion);
export const storage = getStorage(app, DZ.docsBucket);

if (DZ.emulator) {
  connectAuthEmulator(auth, `http://${location.hostname}:9099`, { disableWarnings: true });
  F.connectFirestoreEmulator(db, location.hostname, 8080);
  connectFunctionsEmulator(fns, location.hostname, 5001);
  connectStorageEmulator(storage, location.hostname, 9199);
} else if (DZ.appCheckSiteKey) {
  // Integrasi bertahap: token App Check dikirim; enforcement diatur terpisah di Functions/Console.
  import('https://www.gstatic.com/firebasejs/10.14.1/firebase-app-check.js').then(({ initializeAppCheck, ReCaptchaEnterpriseProvider }) => {
    initializeAppCheck(app, { provider: new ReCaptchaEnterpriseProvider(DZ.appCheckSiteKey), isTokenAutoRefreshEnabled: true });
  }).catch((e) => console.warn('App Check tidak aktif:', e.message));
}

/** Panggil Cloud Function callable; galat diteruskan apa adanya (code, message, details). */
export const call = (name, data = {}) => httpsCallable(fns, name)(data).then((r) => r.data);

/** Pesan galat yang dapat dibaca pengguna. */
export function errText(e) {
  const code = String(e?.code || '').replace(/^(functions|firestore|storage|auth)\//, '');
  const map = {
    'permission-denied': 'Akses ditolak.', unauthenticated: 'Sesi login berakhir. Silakan masuk kembali.',
    unavailable: 'Server tidak dapat dihubungi. Periksa koneksi.', 'deadline-exceeded': 'Waktu permintaan habis.',
    'failed-precondition': 'Permintaan tidak dapat diproses pada kondisi saat ini.', 'not-found': 'Data tidak ditemukan.',
    unauthorized: 'Tidak berwenang mengakses file ini.',
  };
  const m = e?.message && !/^(internal|INTERNAL)$/.test(e.message) ? e.message : '';
  return m && code !== 'unavailable' ? m : (map[code] || m || 'Terjadi kesalahan.');
}
