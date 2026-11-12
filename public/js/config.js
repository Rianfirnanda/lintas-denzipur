// Konfigurasi klien Lintas Denzipur. Berisi konfigurasi web Firebase publik (bukan rahasia).
// JANGAN taruh service-account key, token, atau kredensial di file frontend.
const PROD = {
  firebase: {
    apiKey: 'AIzaSyAlVfejf312G-tIleA8izbxn98bDGe1MvM',
    authDomain: 'lintas-benteng.firebaseapp.com',
    projectId: 'lintas-benteng',
    storageBucket: 'lintas-benteng.firebasestorage.app',
    messagingSenderId: '1005929757785',
    appId: '1:1005929757785:web:65b6d25b390677a98f0548',
  },
  databaseId: 'denzipur',                         // Firestore bernama, terpisah dari database default Lintas Benteng
  docsBucket: 'gs://lintas-benteng-denzipur',     // bucket dokumentasi khusus Denzipur
  functionsRegion: 'asia-southeast2',
  // App Check (reCAPTCHA Enterprise). Kosong = nonaktif. Isi site key untuk mode monitor terlebih dahulu.
  appCheckSiteKey: '',
};

// Emulator lokal (npm run serve). Project demo-* tidak pernah menyentuh produksi.
const EMU = {
  ...PROD,
  firebase: { apiKey: 'demo-key', authDomain: 'localhost', projectId: 'demo-denzipur', storageBucket: 'demo-denzipur-docs', appId: 'demo' },
  docsBucket: 'gs://demo-denzipur-docs',
  appCheckSiteKey: '',
};

const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname) && !new URLSearchParams(location.search).has('prod');
export const DZ = { ...(isLocal ? EMU : PROD), emulator: isLocal, timeZone: 'Asia/Jakarta' };
