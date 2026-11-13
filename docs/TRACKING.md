# Alur Tracking & Batasan Platform

Tujuan tracking: administrasi kegiatan rutin dan keselamatan personel. Tidak ada fungsi penargetan, pengarahan, atau pemantauan tersembunyi. Lokasi hanya dikirim selama **sesi** yang dimulai anggota sendiri, dan indikator aktif selalu terlihat.

## Platform pengirim
- Aplikasi pengirim **Lintas Benteng** adalah aplikasi Android (Play Store), menulis `active_tracking` dan `track_records` di database default. **Kode sumbernya tidak ada di repositori ini**, jadi tidak diubah dan tidak dipakai Denzipur.
- Pengirim Denzipur adalah **aplikasi web** `public/anggota.html` (mobile-first). Belum ada aplikasi Android native untuk Denzipur.

## Alur
Tidak ada Cloud Functions (paket Spark). Setiap langkah adalah **batch atomik** dari klien (`public/js/dz-data.js`), dan Firestore Rules memvalidasi seluruh isi batch.

1. Anggota aktif login → registrasi/cek akses → memilih kegiatan yang **ditugaskan** (`pesertaUids` berisi dirinya, status Rencana/Berjalan, tracking diizinkan).
2. Tombol **Mulai Tracking** (aksi pengguna) → browser meminta izin lokasi → batch: buat `sesi`, kunci `sesi_aktif/{uid}`, `lokasi_terkini`, (Rencana → Berjalan), aktivitas.
   - Rules hanya mengizinkan kunci ditulis bila sesi lama tidak aktif. Dua perangkat yang memulai bersamaan menghasilkan tepat satu sesi (diuji).
   - Perangkat yang sama dan kegiatan yang sama → sesi dilanjutkan.
   - Perangkat lain → ditolak, lalu ditawarkan "Akhiri sesi lama".
3. `watchPosition` mengambil titik paling cepat setiap `captureIntervalSec` (bawaan 30 dtk). Ada cadangan `getCurrentPosition` bila perangkat diam.
   - Titik masuk **antrean lokal** (localStorage per akun, maks. `maxQueue`). Jika penuh, titik tertua dibuang dan jumlahnya ditampilkan.
4. Antrean dikirim setiap `sendIntervalSec` (bawaan 60 dtk), maks. 50 titik per batch. Batch berisi dokumen `titik/{seq}` + pembaruan `sesi` (+ `lokasi_terkini` bila ada titik lebih baru). Rules:
   - menolak jika sesi tidak aktif, bukan milik pengirim, berasal dari perangkat lain, atau akun pending/blocked;
   - mewajibkan **seq naik**: setiap titik harus berada di antara `lastSeq` lama dan baru. Kirim ulang batch yang sudah tersimpan otomatis ditolak, lalu klien membaca `lastSeq` server dan menganggapnya duplikat (deduplikasi);
   - membatasi frekuensi (≥ 3 dtk antar batch) dan ukuran (≤ 50 titik);
   - memvalidasi rentang, tipe, dan field yang diizinkan, serta waktu (tidak > 2 mnt di masa depan, tidak sebelum sesi);
   - mewajibkan `receivedAt` = waktu server;
   - mengizinkan `lokasi_terkini` diperbarui **hanya** dengan titik yang `capturedAt`-nya lebih baru. Titik terlambat atau antrean offline disimpan di riwayat dengan `terlambat: true`.
   Penanda kualitas data (`akurasi_rendah`, `koordinat_nol`, `lompatan_tidak_wajar`) dihitung klien dan tidak menolak titik.
5. **Akhiri Tracking** → sisa antrean dikirim (jika gagal, anggota diberi peringatan) → batch: sesi selesai, lokasi terkini selesai, kunci dihapus. Setelah itu Rules menolak titik untuk sesi tersebut.

## Kapasitas paket Spark (perkiraan)
Kuota harian gratis: 20.000 tulis dan 50.000 baca.
- **Tulis** per personel yang tracking: 1 dokumen per titik, ditambah ±2 dokumen per batch. Dengan bawaan (titik 30 dtk, kirim 60 dtk), 8 jam ≈ 960 titik + 960 = **±1.900 tulis**. Jadi sekitar **10 personel × 8 jam per hari** masih dalam kuota, dengan sisa untuk laporan dan admin.
- **Baca**: setiap perubahan posisi dibaca sekali oleh setiap dashboard yang terbuka; 10 personel × 60 pembaruan/jam × 8 jam ≈ 4.800 baca per dashboard.
- Untuk personel lebih banyak, naikkan interval di Pengaturan (mis. titik 60 dtk, kirim 120 dtk).
- Jika kuota habis, penulisan gagal sampai kuota direset; aplikasi menyimpan titik di antrean dan menampilkan pesan.

## Penanganan kondisi
| Kondisi | Perilaku |
|---|---|
| Izin ditolak/dicabut | Pesan jelas + tombol Coba Lagi. Sesi tidak dibuat jika ditolak di awal. Jika dicabut saat berjalan, pengambilan berhenti dan banner berubah menjadi "pengambilan lokasi tidak berjalan". |
| GPS tidak tersedia / timeout | Pesan, lalu dicoba ulang otomatis |
| Offline | Titik disimpan lokal, status "Offline — n titik disimpan". Dikirim saat event `online` atau dengan backoff eksponensial (maks. 5 mnt). |
| Sesi ditutup operator/sistem | Listener `sesi/{id}`, atau penolakan Rules saat kirim berikutnya → tracking berhenti, antrean dibuang, alasan ditampilkan |
| Akun diblokir | Batch administrator menutup sesi. Kiriman berikutnya ditolak Rules → tracking berhenti, pesan tampil, lalu halaman dimuat ulang ke layar "Akun diblokir". Penolakan tanpa sebab yang bisa dipastikan juga memicu satu kali muat ulang. |
| Keluar (logout) | Konfirmasi → sesi diakhiri (`keluar_aplikasi`) → logout |
| Beberapa tab | Web Locks API: hanya satu tab per perangkat yang mengambil lokasi. Tab lain menampilkan info dan mengambil alih otomatis bila tab pertama ditutup. |
| Muat ulang halaman | Sesi aktif terdeteksi. GPS dilanjutkan setelah anggota menekan **Lanjutkan Tracking** (izin lokasi tetap mengikuti aksi pengguna), sementara antrean lama tetap dikirim. |

## Dashboard admin
Tiga sumber lokasi ditampilkan dalam tab terpisah dengan bentuk penanda yang berbeda:
1. **Live Tracking**: `lokasi_terkini` (listener terbatas 200 dokumen, 12 jam terakhir, lingkup unit).
   - Lingkaran: hijau untuk lokasi terbaru; oranye putus-putus untuk lokasi belum diperbarui; abu-abu untuk sesi selesai. Radius akurasi digambar.
   - Kesegaran dihitung ulang setiap 15 detik dari **waktu pengambilan**, bukan dari koneksi dashboard.
   - Label: "Lokasi belum diperbarui", bukan "offline".
2. **Riwayat Sesi**: daftar `sesi` dengan pagination per 50. Jalur dimuat dari `sesi/{id}/titik` (dicatat ke audit sebelum dibaca) dan dapat diekspor ke CSV (dicatat ke audit).
3. **Lokasi Laporan (■) & Titik Manual (▲)**: titik manual dapat ditambah operator dengan klik peta.

Status sesi dan status kesegaran ditampilkan sebagai label terpisah (teks + simbol, tidak bergantung warna). Listener dilepas saat tab atau filter berubah dan saat halaman ditutup; uji E2E menunjukkan jumlah listener tetap 1.

Peta: tile OpenStreetMap dengan atribusi "© OpenStreetMap contributors". Kebijakan tile OSM membatasi penggunaan berat; untuk pemakaian produksi yang besar, gunakan penyedia tile berlisensi.

## Batasan yang jujur
- **Web saja**: pengambilan lokasi berjalan selama halaman terbuka dan layar menyala.
  - Saat layar terkunci, browser di latar belakang, atau tab ditutup, browser dapat menghentikan GPS. Aplikasi menampilkan peringatan dan melanjutkan saat halaman aktif kembali.
  - Opsi "Jaga layar tetap menyala" (Screen Wake Lock) membantu jika browser mendukungnya.
- **Belum terverifikasi**: perilaku pada layar terkunci/latar belakang di perangkat fisik Android/iOS, serta akurasi GPS nyata. Pengujian memakai Chromium (Playwright) dengan geolokasi emulasi.
- Tracking latar belakang yang andal memerlukan aplikasi Android native dengan *foreground service* bertipe `location`, notifikasi yang terus tampil, serta izin `ACCESS_FINE_LOCATION`, `FOREGROUND_SERVICE_LOCATION`, dan bila perlu `ACCESS_BACKGROUND_LOCATION` sesuai kebijakan Google Play. Ini **tidak** termasuk implementasi saat ini.
