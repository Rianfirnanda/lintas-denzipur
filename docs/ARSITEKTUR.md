# Arsitektur Lintas Denzipur

## Keputusan arsitektur (ADR-001): isolasi di dalam project `lintas-benteng`

**Temuan awal.**
- Admin Denzipur lama menulis profil login ke koleksi `lintas` di database Firestore **default**. Koleksi itu juga dibaca dan ditulis Lintas Benteng.
- Manajemen User membaca `users` dengan `role == 'user-denzipur'`. Koleksi `users` adalah koleksi pengguna Lintas Benteng, sehingga akun Denzipur tampil di daftar pengguna Benteng. Ini adalah **masalah pemisahan data dan akses, bukan desain yang disengaja**: kedua aplikasi berbagi namespace dan Rules.
- Klien bisa mengaktifkan dirinya sendiri lewat dokumen `lintas_invites`.
- Daftar owner ditulis langsung di frontend.

**Keputusan.** Denzipur tetap berada di project `lintas-benteng`, karena Auth (akun Google) dipakai bersama. Semua data dan aturannya dipisahkan:

| Lapisan | Lintas Benteng (tidak diubah) | Lintas Denzipur (baru) |
|---|---|---|
| Firestore | database `(default)`, Rules milik Benteng | **database bernama `denzipur`**, `firestore.rules` sendiri |
| Storage | bucket default | **bucket `lintas-benteng-denzipur`**, `storage.rules` sendiri |
| Functions | (codebase default, jika ada) | **codebase `denzipur`**, semua fungsi berawalan `dz` |
| Hosting | situs `lintas-benteng` | **situs `lintas-denzipur`** (target `denzipur`) |
| Auth | bersama | bersama; izin Denzipur ada di `akses/{uid}` (database denzipur) + klaim `dz` |

**Konsekuensi.**
- Deploy Rules, indexes, Storage, dan Functions Denzipur tidak menimpa Rules atau fungsi Benteng.
  - Firestore Rules memiliki target per database.
  - Storage Rules memiliki target per bucket.
  - Functions dipisahkan per codebase.
- Klaim kustom `dz` ditambahkan pada akun Auth bersama. Klaim lain (milik Benteng) tetap dipertahankan; ini diuji di tes 8.
- Akun Benteng tanpa dokumen `akses` tidak dapat membaca apa pun di database `denzipur`; ini juga diuji di tes 8.
- Folder `/denzipur` di situs Benteng masih menjalankan kode lama sampai diganti dengan redirect. Lihat [DEPLOY.md](DEPLOY.md).
- Prasyarat: paket Blaze (Functions, database bernama, bucket tambahan, Cloud Scheduler).
- Alternatif yang ditolak untuk saat ini: project Firebase terpisah. Isolasinya penuh, tetapi akun Google harus login di project lain, dan migrasi Auth beserta Authorized Domains perlu dikerjakan ulang. Pindah ke project terpisah tetap mudah, karena semua nama database, bucket, dan region dikonfigurasi di `public/js/config.js` dan `functions/.env`.

## Komponen

```
public/                 Hosting (situs statis, ES modules, Firebase JS SDK 10.14.1 via gstatic)
  admin.html            Shell admin (login Google → dzRegister → menu sesuai peran)
  anggota.html          Aplikasi anggota (tracking berbasis sesi + laporan)
  home/kegiatan/tracking/laporan/dokumentasi/rekap/user-manager/unit/audit/pengaturan.html
  js/config.js          Konfigurasi publik (+ mode emulator otomatis di localhost)
  js/firebase.js        Inisialisasi tunggal (db bernama, functions region, bucket dokumentasi, App Check opsional)
  js/dz-core.js         Logika murni: antrean offline, kesegaran lokasi, CSV aman, klasifikasi galat
  js/anggota.js         Logika aplikasi anggota
functions/src/index.js  Callable + trigger + scheduler (Admin SDK, memeriksa otorisasi sendiri)
functions/src/core.js   Validasi titik, transisi, pengaturan (diuji unit)
firestore.rules / storage.rules / firestore.indexes.json
scripts/                check-build, seed-emulator, migrate-from-default (dry-run)
tests/                  unit (node:test) & emulator (Auth, Firestore, Storage, Functions)
```

## Model data (database `denzipur`)

| Koleksi | Isi | Ditulis oleh |
|---|---|---|
| `akses/{uid}` | **izin aplikasi**: `role`, `status` (pending/active/blocked), `unitId`, `unitScope[]`, `email` | Functions saja |
| `personel/{uid}` | **profil organisasi**: `nama`, `pangkat`, `jabatan`, `unitId`, `statusKeanggotaan`, `email` | Functions saja |
| `undangan/{email}` | undangan aktivasi (`role`, `unitId`, `unitScope`) | sysadmin |
| `unit/{unitId}` | `nama`, `kode`, `keterangan` | sysadmin |
| `kegiatan/{id}` | `judul`, `unitId`, `penanggungJawabUid`, `pesertaUids[]`, `jadwalMulai/Selesai`, `lokasiNama/Lat/Lng`, `status` (rencana/berjalan/selesai/dibatalkan), `trackingDiizinkan` | sysadmin/operator unit |
| `sesi/{sessionId}` | `uid`, `unitId`, `kegiatanId`, `deviceId`, `status` (aktif/selesai), `mulaiAt`, `selesaiAt`, `endedReason`, `lastSeq`, `pointCount`, `lastCapturedAt`, `lastReceivedAt` | Functions |
| `sesi/{id}/titik/{deviceId_seq}` | riwayat: `lat`, `lng`, `acc`, `capturedAt` (perangkat), `receivedAt` (server), `seq`, `sumber`, `quality[]`, `terlambat` | Functions |
| `lokasi_terkini/{sessionId}` | posisi terakhir per sesi + status sesi (dipisah dari riwayat agar pembacaan murah) | Functions |
| `sesi_aktif/{uid}` | kunci satu sesi aktif per personel | Functions |
| `titik_manual/{id}` | titik input operator | sysadmin/operator unit |
| `laporan/{id}` | `uid`, `unitId`, `kegiatanId`, `judul`, `isi`, `lokasi{lat,lng,acc,capturedAtMs}`, `fotoPaths[]`, `status` (draf/diajukan/perlu_revisi/disetujui), `pemeriksaUid`, `diperiksaAt`, `catatanRevisi` | pemilik/pemeriksa (Rules) |
| `pengaturan/umum` | ambang & interval (lihat Pengaturan) | sysadmin |
| `audit/{id}` | log audit (perubahan akses, sesi, laporan, akses riwayat lokasi, ekspor) | Functions |
| `aktivitas/{id}` | umpan aktivitas per unit tanpa koordinat (dashboard) | Functions |

ID kegiatan yang sama dipakai oleh sesi, laporan, dan dokumentasi (`laporan/{unit}/{uid}/{laporanId}/…` di Storage).

## Matriks hak akses

| Data / aksi | Administrator Sistem | Operator Unit | Pemeriksa Laporan | Pembaca Ringkasan | Anggota | Pending/Blocked/akun Benteng saja |
|---|---|---|---|---|---|---|
| Dashboard (agregat) | semua unit | unit lingkup | unit lingkup | unit lingkup (tanpa angka lokasi) | – | ✕ |
| Kegiatan: baca | semua | unit lingkup | unit lingkup | unit lingkup | yang ditugaskan | ✕ |
| Kegiatan: kelola | ✓ | unit lingkup | ✕ | ✕ | ✕ | ✕ |
| Live/riwayat lokasi sesi | ✓ (riwayat teraudit) | unit lingkup (teraudit) | ✕ | ✕ | milik sendiri | ✕ |
| Mulai/kirim/akhiri sesi | – | akhiri sesi unitnya | – | – | milik sendiri, kegiatan yang ditugaskan | ✕ |
| Laporan: baca | ✓ | unit lingkup | unit lingkup | ✕ | milik sendiri | ✕ |
| Laporan: buat/ubah/ajukan | – | – | – | – | milik sendiri saat Draf/Perlu Revisi | ✕ |
| Laporan: setujui/minta revisi | ✓ (bukan milik sendiri) | ✕ | unit lingkup (bukan milik sendiri) | ✕ | ✕ | ✕ |
| Foto dokumentasi | ✓ | unit lingkup | unit lingkup | ✕ | milik sendiri (unggah ke unitnya) | ✕ |
| Titik manual | ✓ | kelola unit lingkup | baca unit lingkup | ✕ | ✕ | ✕ |
| Personel: profil | ✓ | ubah profil unit lingkup | baca unit lingkup | baca unit lingkup | baca diri | baca diri |
| Akses (peran/status/unit), undangan, unit, audit, pengaturan | ✓ | ✕ (pengaturan: baca) | ✕ (baca) | ✕ (baca) | ✕ | ✕ |

Prinsip yang diterapkan:
- Pangkat dan jabatan tidak memberi izin apa pun.
- Pengguna tidak dapat menulis `akses` atau `personel`.
- Sysadmin tidak dapat mengubah aksesnya sendiri, dan sysadmin aktif terakhir tidak dapat diturunkan.
- Pencabutan akses berlaku di Rules dan Functions saat itu juga. Untuk Storage, lihat batasan di bawah.

**Lintas Benteng ↔ Denzipur:** akun Auth dipakai bersama. Database Denzipur hanya dapat diakses dengan dokumen `akses` aktif. Rules Denzipur tidak memberi akses apa pun ke database default Benteng, dan izin administrator Benteng tidak diubah.

## Firebase yang digunakan
- **Auth** (Google; email/sandi hanya untuk emulator).
- **Firestore** database `denzipur` (Rules + indexes).
- **Storage** bucket `lintas-benteng-denzipur`. Foto dibaca dengan `getBlob()` yang memerlukan autentikasi; tidak ada URL unduhan bertoken yang berumur panjang.
- **Cloud Functions v2**: region `asia-southeast2`, Node 22, codebase `denzipur`.
- **Cloud Scheduler** untuk `dzMaintenance` (setiap 30 menit).
- **App Check**: opsional. Klien mengirim token bila `appCheckSiteKey` diisi; enforcement lewat `DZ_ENFORCE_APP_CHECK` (bawaan `false`).
- **Hosting**: situs `lintas-denzipur`.

Realtime Database (`databaseURL` di konfigurasi lama) **tidak** dipakai. Tidak ada database kedua yang ditambahkan untuk tracking: listener Firestore pada `lokasi_terkini` sudah cukup untuk pembaruan setiap ±30 detik.

## Masa simpan & penghapusan
- Riwayat titik (`sesi/*/titik`) dihapus `dzMaintenance` setelah `retentionDays` (bawaan 90 hari, dapat diatur 7–730) sejak sesi selesai. Dokumen `lokasi_terkini` sesi tersebut juga dihapus. Metadata sesi tetap ada dengan `titikDihapus: true`.
- Sesi aktif tanpa pembaruan selama `autoEndMinutes` (bawaan 180 menit) diakhiri sistem dengan alasan "tidak ada pembaruan". Alasan ini menggambarkan data, bukan kesimpulan tentang kondisi personel.
- Log `audit` dan `aktivitas` tidak dihapus otomatis. Kebijakan arsipnya perlu disetujui satuan.

## Batasan keamanan yang diketahui
- **Storage memakai klaim token.** Akun yang diblokir atau dipindah unit kehilangan akses Firestore dan Functions saat itu juga. Untuk Storage, klaim lama tetap berlaku sampai token ID diperbarui (maks. ±1 jam); refresh token dicabut saat blokir. Perpindahan unit setelah token diperbarui sudah diuji (tes 15).
- **Listener lokasi terkini dibaca langsung dari klien**, jadi setiap pembacaan tidak dapat diaudit satu per satu. Yang dicatat adalah pembukaan halaman Live Tracking (`buka_live_tracking`, upaya terbaik dari klien). Akses **riwayat** lokasi wajib lewat `dzGetSessionTrack` dan selalu teraudit. Ekspor lokasi dan laporan juga dicatat.
- **Foto Storage tidak bisa dihapus atau ditimpa dari klien.** Foto yatim dari laporan yang batal disimpan belum dibersihkan otomatis.
