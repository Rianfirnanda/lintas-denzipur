// Konfigurasi klien Lintas Denzipur. Berisi konfigurasi web Firebase publik (bukan rahasia).
// JANGAN taruh service-account key, token, atau kredensial di file frontend.
// Project Firebase khusus Denzipur (terpisah total dari project Lintas Benteng).
const PROD = {
  firebase: {
    apiKey: 'AIzaSyDeTYBHB3hql2xcSzD__uWdLyKZHWXz_6I',
    authDomain: 'lintas-denzipur.firebaseapp.com',
    projectId: 'lintas-denzipur',
    storageBucket: 'lintas-denzipur.firebasestorage.app',
    messagingSenderId: '310813714383',
    appId: '1:310813714383:web:0a6bea364b21132427d4ba',
  },
  databaseId: '(default)',                          // database default milik project lintas-denzipur
  docsBucket: 'gs://lintas-denzipur.firebasestorage.app',
  functionsRegion: 'asia-southeast2',
  // App Check (reCAPTCHA Enterprise). Kosong = nonaktif. Isi site key untuk mode monitor terlebih dahulu.
  appCheckSiteKey: '',
};

// Emulator lokal (npm run serve). Project demo-* tidak pernah menyentuh produksi.
const EMU = {
  ...PROD,
  firebase: { apiKey: 'demo-key', authDomain: 'localhost', projectId: 'demo-denzipur', storageBucket: 'demo-denzipur.appspot.com', appId: 'demo' },
  docsBucket: 'gs://demo-denzipur.appspot.com',
  appCheckSiteKey: '',
};

const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname) && !new URLSearchParams(location.search).has('prod');
export const DZ = { ...(isLocal ? EMU : PROD), emulator: isLocal, timeZone: 'Asia/Jakarta' };
