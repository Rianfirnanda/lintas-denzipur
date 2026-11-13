# Lintas Denzipur

Administrasi personel, kegiatan rutin, laporan, dokumentasi, dan tracking berbasis sesi untuk Detasemen Zeni Tempur. Diadaptasi dari Lintas Benteng, dengan data dan aturan akses yang terpisah dari Benteng.

- **Admin**: `public/admin.html`. Dashboard, Kegiatan, Tracking (Live / Riwayat Sesi / Lokasi Laporan & Titik Manual), Laporan, Dokumentasi, Rekap, Personel & Akses, Unit, Log Audit, Pengaturan.
- **Aplikasi anggota**: `public/anggota.html`. Tracking berbasis sesi (aplikasi web) dan laporan kegiatan berfoto.
- **Backend**: project Firebase tersendiri `lintas-denzipur` di paket **Spark (gratis)**: Authentication, Firestore, dan Hosting saja. Penegakan akses sepenuhnya di Firestore Security Rules; tanpa Cloud Functions dan Cloud Storage. Terpisah total dari project Lintas Benteng.

## Mulai cepat (lokal, emulator — tanpa menyentuh produksi)
```bash
npm install
```
```bash
npm run serve
```
Di terminal lain:
```bash
node scripts/seed-emulator.mjs
```
Buka `http://localhost:5000/admin.html` atau `http://localhost:5000/anggota.html`. Masuk dengan form "Masuk (emulator)", misalnya `sysadmin@denzipur.test`, `operator.a@denzipur.test`, atau `anggota1@denzipur.test`. Sandi uji dicetak oleh skrip seed.

## Pengujian
```bash
npm test
```
```bash
npm run check
```

## Dokumentasi
- [Arsitektur, model data, matriks hak akses, konfigurasi Firebase, masa simpan](docs/ARSITEKTUR.md)
- [Alur tracking & batasan platform](docs/TRACKING.md)
- [Pengujian & hasil](docs/PENGUJIAN.md)
- [Setup, deployment, migrasi & rollback](docs/DEPLOY.md)

## Aturan penting
- Jangan menyimpan service-account key, token, atau kredensial di repositori atau frontend. `public/js/config.js` hanya berisi konfigurasi web Firebase yang memang publik.
- Selalu deploy dengan `--only` dan `--project lintas-denzipur` sesuai DEPLOY.md. Repositori ini tidak berisi target ke project Lintas Benteng.
- Pengujian hanya memakai emulator dengan project `demo-denzipur` dan data fiktif.
