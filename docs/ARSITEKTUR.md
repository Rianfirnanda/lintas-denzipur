# Arsitektur Lintas Denzipur

## Keputusan arsitektur

### ADR-003 (berlaku): project terpisah, paket Spark (gratis), tanpa Cloud Functions dan Storage
**Konteks.**
- Pemilik tidak akan memakai paket Blaze.
- Pada paket Spark, Cloud Functions, Cloud Scheduler, dan Cloud Storage (bucket baru) tidak tersedia.
- Layanan yang tersedia: **Authentication, Firestore, Hosting**.

**Keputusan.**
- **Semua penegakan akses ada di Firestore Security Rules.** Operasi yang sebelumnya dikerjakan Functions ditulis klien sebagai **batch atomik** (`public/js/dz-data.js`), lalu Rules memvalidasi seluruh isi batch dengan `get()` / `getAfter()`.
- **Foto dokumentasi** dikompres di perangkat (maks. 1280 px, JPEG, < 1 MB) dan disimpan di Firestore pada `laporan/{id}/foto/{fid}`. Lingkup aksesnya sama dengan laporan, dan tidak ada tautan publik.
- **Dashboard** memakai *count query* Firestore dari klien. Hasilnya otomatis mengikuti hak baca peran; kartu yang tidak boleh dilihat tampil "tidak tersedia".
- **Pemeliharaan** berjalan dari peramban Administrator Sistem: otomatis maksimal sekali per 24 jam saat Dashboard dibuka, atau manual dari menu Pengaturan.
- **Administrator pertama** ditetapkan pemilik project lewat dokumen `pengaturan/bootstrap` di Console. Dokumen ini tidak dapat dibaca atau ditulis klien.

**Konsekuensi (jaminan yang berubah dibanding versi Functions).**

| Aspek | Versi Functions (ADR-002) | Versi Spark (sekarang) |
|---|---|---|
| Satu sesi aktif, tolak titik setelah sesi ditutup, tidak bisa kirim atas nama orang lain | server | **Rules** (tetap ditegakkan server) |
| Deduplikasi & titik terlambat tidak menimpa posisi terkini | server | **Rules**: seq harus naik, `capturedAt` lokasi terkini harus lebih baru |
| Batas frekuensi | 4 dtk per panggilan | **Rules**: ≥ 3 dtk per batch, maks. 50 titik |
| Penanda kualitas data (akurasi rendah, lompatan) | dihitung server | dihitung **klien**; Rules hanya membatasi nilai yang diizinkan |
| Waktu diterima server (`receivedAt`) | server | `request.time`, ditegakkan Rules |
| Audit akses riwayat lokasi & ekspor | dijamin (lewat Functions) | **upaya terbaik**: klien menulis audit sebelum membaca/mengekspor; staf yang memodifikasi klien dapat melewatinya |
| Umpan aktivitas & audit perubahan laporan | trigger otomatis | ditulis klien dalam batch yang sama (tidak dipaksa Rules) |
| Menutup sesi saat akun diblokir | otomatis di server | batch administrator ikut menutup sesi; kiriman dari akun terblokir tetap ditolak Rules |
| Penutupan sesi tanpa pembaruan & penghapusan riwayat | terjadwal setiap 30 mnt | saat sysadmin membuka Dashboard (≤ 1×/24 jam) atau manual |
| Foto | Cloud Storage | Firestore (maks. 10 foto/laporan, terkompresi) |

### ADR-002 (digantikan): project terpisah `lintas-denzipur` dengan Blaze
Dipilih karena akun pengembang tidak berizin membuat resource di project `lintas-benteng`, dan database Lintas Benteng tidak boleh tersentuh. Digantikan ADR-003 karena paket Blaze tidak dipakai.

### ADR-001 (digantikan): database bernama di dalam project `lintas-benteng`
Temuan awal yang tetap relevan:
- Admin Denzipur lama menulis ke koleksi `lintas` dan `users` di database default Lintas Benteng. Akibatnya akun Denzipur muncul di daftar pengguna Benteng. Ini masalah pemisahan data, bukan desain.
- Klien lama bisa mengaktifkan dirinya sendiri lewat `lintas_invites`.

## Pemisahan dari Lintas Benteng

| Lapisan | Lintas Benteng (`lintas-benteng`) | Lintas Denzipur (`lintas-denzipur`) |
|---|---|---|
| Firestore | database default Benteng — **tidak disentuh** | database default project Denzipur |
| Auth | daftar akun Benteng | daftar akun Denzipur (login tetap dengan akun Google) |
| Hosting | `lintas-benteng.web.app` | `lintas-denzipur.web.app` |
| Functions/Storage | milik Benteng | tidak dipakai |

`.firebaserc` di repositori ini hanya berisi `lintas-denzipur` dan `demo-denzipur` (emulator).

## Komponen
```
public/                 Hosting (situs statis, ES modules, Firebase JS SDK 10.14.1 via gstatic)
  admin.html            Shell admin (login Google → registrasi → menu sesuai peran)
  anggota.html          Aplikasi anggota (tracking berbasis sesi + laporan berfoto)
  home/kegiatan/tracking/laporan/dokumentasi/rekap/user-manager/unit/audit/pengaturan.html
  js/config.js          Konfigurasi web publik (+ mode emulator otomatis di localhost)
  js/firebase.js        Inisialisasi Auth + Firestore, App Check opsional
  js/dz-data.js         Lapisan data: registrasi, akses, sesi, kirim titik, riwayat, dashboard, pemeliharaan
  js/dz-core.js         Logika murni: antrean offline, validasi titik, kesegaran lokasi, CSV aman
  js/anggota.js         Logika aplikasi anggota
firestore.rules / firestore.indexes.json
scripts/                check-build, seed-emulator, migrate-from-default (dry-run)
tests/                  unit (node:test) & emulator (Auth + Firestore)
```

## Model data (project `lintas-denzipur`, database default)

| Koleksi | Isi | Ditulis oleh (ditegakkan Rules) |
|---|---|---|
| `akses/{uid}` | **izin aplikasi**: `role`, `status` (pending/active/blocked), `unitId`, `unitScope[]` | pemilik saat registrasi (selalu pending, kecuali undangan/bootstrap); sysadmin (bukan untuk dirinya) |
| `personel/{uid}` | **profil organisasi**: nama, pangkat, jabatan, unit, status keanggotaan | registrasi; sysadmin; operator unit (tanpa ubah unit) |
| `undangan/{email}` | undangan aktivasi | sysadmin; dihapus oleh yang diundang saat dipakai |
| `unit/{unitId}` | nama, kode | sysadmin |
| `kegiatan/{id}` | judul, unit, penanggung jawab, peserta, jadwal, lokasi, status, tracking diizinkan | sysadmin/operator unit; peserta hanya Rencana → Berjalan saat memulai sesi |
| `sesi/{id}` | pemilik, unit, kegiatan, perangkat, status, waktu mulai/selesai, `lastSeq`, `pointCount`, `lastCapturedAt`, `lastIngestAt` | pemilik (mulai/kirim/akhiri); operator unit & sysadmin (akhiri) |
| `sesi/{id}/titik/{seq}` | lat, lng, akurasi, `capturedAt` (perangkat), `receivedAt` (server), kualitas, terlambat | pemilik, hanya sebagai batch bersama kenaikan `lastSeq`; tidak dapat diubah |
| `lokasi_terkini/{sesiId}` | posisi terakhir + status sesi | pemilik (hanya titik yang lebih baru); akhiri oleh pemilik/operator |
| `sesi_aktif/{uid}` | kunci satu sesi aktif per personel | pemilik; hanya bisa ditimpa bila sesi lama tidak aktif |
| `titik_manual/{id}` | titik input operator | sysadmin/operator unit |
| `laporan/{id}` + `foto/{fid}` | laporan & foto terkompresi | pemilik (Draf/Perlu Revisi); pemeriksa (Diajukan → Perlu Revisi/Disetujui) |
| `pengaturan/umum` | ambang & interval | sysadmin |
| `pengaturan/pemeliharaan` | hasil pemeliharaan terakhir | sysadmin |
| `pengaturan/bootstrap` | `{emails: [...]}` administrator awal | **hanya pemilik project lewat Console** |
| `audit/{id}` | log audit | staf atas namanya sendiri; dibaca sysadmin |
| `aktivitas/{id}` | umpan per unit tanpa koordinat | pengguna aktif untuk unitnya |

## Matriks hak akses

| Data / aksi | Administrator Sistem | Operator Unit | Pemeriksa Laporan | Pembaca Ringkasan | Anggota | Pending / Blocked / tanpa akses |
|---|---|---|---|---|---|---|
| Dashboard | semua unit | unit lingkup | unit lingkup (tanpa angka lokasi) | kegiatan & personel saja | – | ✕ |
| Kegiatan: baca | semua | unit lingkup | unit lingkup | unit lingkup | yang ditugaskan | ✕ |
| Kegiatan: kelola | ✓ | unit lingkup | ✕ | ✕ | ✕ | ✕ |
| Live/riwayat lokasi sesi | ✓ | unit lingkup | ✕ | ✕ | milik sendiri | ✕ |
| Mulai/kirim/akhiri sesi | akhiri | akhiri sesi unitnya | – | – | milik sendiri, kegiatan yang ditugaskan | ✕ |
| Laporan & foto: baca | ✓ | unit lingkup | unit lingkup | ✕ | milik sendiri | ✕ |
| Laporan: buat/ubah/ajukan | – | – | – | – | milik sendiri saat Draf/Perlu Revisi | ✕ |
| Laporan: setujui/minta revisi | ✓ (bukan milik sendiri) | ✕ | unit lingkup (bukan milik sendiri) | ✕ | ✕ | ✕ |
| Titik manual | ✓ | kelola unit lingkup | baca unit lingkup | ✕ | ✕ | ✕ |
| Personel: profil | ✓ | ubah profil unit lingkup | baca unit lingkup | baca unit lingkup | baca diri | baca diri |
| Akses, undangan, unit, audit, pengaturan | ✓ | ✕ (pengaturan umum: baca) | ✕ (baca) | ✕ (baca) | ✕ | ✕ |

Prinsip yang diterapkan:
- Pangkat dan jabatan tidak memberi izin apa pun.
- Pengguna tidak dapat menaikkan peran atau mengaktifkan dirinya, kecuali lewat undangan sah yang sekaligus terpakai.
- Sysadmin tidak dapat mengubah akses akunnya sendiri, sehingga selalu tersisa minimal satu sysadmin.
- Pencabutan akses berlaku seketika di Rules, karena setiap permintaan membaca dokumen `akses`.

## Masa simpan & penghapusan
- Riwayat titik dihapus oleh pemeliharaan setelah `retentionDays` (bawaan 90 hari, rentang 7–730) sejak sesi selesai. Dokumen `lokasi_terkini` sesi itu juga dihapus; metadata sesi tetap ada dengan `titikDihapus: true`.
- Sesi aktif tanpa pembaruan selama `autoEndMinutes` (bawaan 180) diakhiri dengan alasan "tidak ada pembaruan". Alasan ini hanya menggambarkan data, bukan kondisi personel.
- Log `audit` dan `aktivitas` tidak dihapus otomatis.
- Karena pemeliharaan berjalan dari peramban sysadmin, penghapusan hanya terjadi bila ada sysadmin yang membuka Dashboard atau menekan tombol pemeliharaan.

## Batasan keamanan yang diketahui
- **Audit akses lokasi bersifat upaya terbaik.** Rules tidak dapat mewajibkan penulisan audit sebelum membaca. Operator yang memodifikasi kode klien dapat membaca riwayat tanpa jejak audit. Membaca riwayat tetap hanya mungkin bagi yang berhak.
- **Penanda kualitas data dihitung klien**, sehingga dapat dihilangkan oleh klien yang dimodifikasi. Koordinat, waktu, dan urutan tetap divalidasi Rules.
- **Pemblokiran tidak menutup sesi secara otomatis** bila dilakukan di luar aplikasi (misalnya lewat Console). Kiriman titik dari akun terblokir tetap ditolak.
- **Kuota Spark**: 50.000 baca, 20.000 tulis, dan 20.000 hapus per hari; penyimpanan 1 GiB. Jika kuota habis, penulisan gagal sampai kuota direset (tengah malam waktu Pasifik, sekitar pukul 14.00–15.00 WIB). Titik tetap tersimpan di antrean perangkat. Lihat perhitungan di [TRACKING.md](TRACKING.md).
- **Uji emulator**: setelah status akses berubah, koneksi pantau halaman yang sudah lama terbuka tidak menerima pembaruan. Aplikasi anggota menangani ini dengan memuat ulang dirinya ketika server menolak kiriman titik. Perilaku di produksi belum diverifikasi.
