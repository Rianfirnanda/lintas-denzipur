# Alur Tracking & Batasan Platform

Tujuan tracking: administrasi kegiatan rutin dan keselamatan personel. Tidak ada fungsi penargetan, pengarahan, atau pemantauan tersembunyi. Lokasi hanya dikirim selama **sesi** yang dimulai anggota sendiri, dan indikator aktif selalu terlihat.

## Platform pengirim
- Aplikasi pengirim **Lintas Benteng** adalah aplikasi Android (Play Store), menulis `active_tracking` dan `track_records` di database default. **Kode sumbernya tidak ada di repositori ini**, jadi tidak diubah dan tidak dipakai Denzipur.
- Pengirim Denzipur adalah **aplikasi web** `public/anggota.html` (mobile-first). Belum ada aplikasi Android native untuk Denzipur.

## Alur
1. Anggota aktif login → `dzRegister` → memilih kegiatan yang **ditugaskan** (`pesertaUids` berisi dirinya, status Rencana/Berjalan, tracking diizinkan).
2. Tombol **Mulai Tracking** (aksi pengguna) → browser meminta izin lokasi → `dzStartSession`.
   - Server memakai transaksi dengan kunci `sesi_aktif/{uid}`. Ini mencegah sesi ganda lintas perangkat; uji dua perangkat bersamaan menghasilkan tepat satu sesi.
   - Perangkat yang sama dan kegiatan yang sama → sesi dilanjutkan.
   - Perangkat lain → ditolak, lalu ditawarkan "Akhiri sesi lama".
   - Kegiatan Rencana otomatis menjadi Berjalan.
3. `watchPosition` mengambil titik paling cepat setiap `captureIntervalSec` (bawaan 15 dtk). Ada cadangan `getCurrentPosition` bila perangkat diam.
   - Titik masuk **antrean lokal** (localStorage per akun, maks. `maxQueue`). Jika penuh, titik tertua dibuang dan jumlahnya ditampilkan.
4. Antrean dikirim ke `dzIngestPoints` setiap `sendIntervalSec` (bawaan 30 dtk), maks. 100 titik per panggilan. Server:
   - menolak jika sesi tidak aktif, bukan milik pengirim, berasal dari perangkat lain, atau akun pending/blocked;
   - membatasi frekuensi (`minIngestGapMs`) serta ukuran dan jumlah titik;
   - memvalidasi rentang, tipe, dan field yang diizinkan, serta waktu (tidak > 2 mnt di masa depan, tidak sebelum sesi);
   - mendeduplikasi dengan ID `deviceId_seq`; kirim ulang menghasilkan `duplicates`;
   - menyimpan `capturedAt` (perangkat) dan `receivedAt` (server timestamp);
   - memperbarui `lokasi_terkini` **hanya** jika titik lebih baru dari `lastCapturedAt`. Titik terlambat atau antrean offline disimpan di riwayat dengan `terlambat: true` dan tidak menjadi posisi terkini;
   - menandai kualitas data (`akurasi_rendah`, `koordinat_nol`, `lompatan_tidak_wajar`) tanpa menolak titik dan tanpa menyimpulkan pelanggaran.
   Klien menghapus dari antrean semua seq yang diterima, duplikat, atau ditolak.
5. **Akhiri Tracking** → sisa antrean dikirim (jika gagal, anggota diberi peringatan) → `dzEndSession`. Setelah itu titik untuk sesi tersebut ditolak server.

## Penanganan kondisi
| Kondisi | Perilaku |
|---|---|
| Izin ditolak/dicabut | Pesan jelas + tombol Coba Lagi. Sesi tidak dibuat jika ditolak di awal. Jika dicabut saat berjalan, pengambilan berhenti dan banner berubah menjadi "pengambilan lokasi tidak berjalan". |
| GPS tidak tersedia / timeout | Pesan, lalu dicoba ulang otomatis |
| Offline | Titik disimpan lokal, status "Offline — n titik disimpan". Dikirim saat event `online` atau dengan backoff eksponensial (maks. 5 mnt). |
| Sesi ditutup operator/sistem | Listener `sesi/{id}` atau respons server → tracking berhenti, antrean dibuang, alasan ditampilkan |
| Akun diblokir | Server menutup sesi, listener `akses/{uid}` memicu muat ulang, tracking berhenti |
| Keluar (logout) | Konfirmasi → sesi diakhiri (`keluar_aplikasi`) → logout |
| Beberapa tab | Web Locks API: hanya satu tab per perangkat yang mengambil lokasi. Tab lain menampilkan info dan mengambil alih otomatis bila tab pertama ditutup. |
| Muat ulang halaman | Sesi aktif terdeteksi. GPS dilanjutkan setelah anggota menekan **Lanjutkan Tracking** (izin lokasi tetap mengikuti aksi pengguna), sementara antrean lama tetap dikirim. |

## Dashboard admin
Tiga sumber lokasi ditampilkan dalam tab terpisah dengan bentuk penanda yang berbeda:
1. **Live Tracking**: `lokasi_terkini` (listener terbatas 200 dokumen, 12 jam terakhir, lingkup unit).
   - Lingkaran: hijau untuk lokasi terbaru; oranye putus-putus untuk lokasi belum diperbarui; abu-abu untuk sesi selesai. Radius akurasi digambar.
   - Kesegaran dihitung ulang setiap 15 detik dari **waktu pengambilan**, bukan dari koneksi dashboard.
   - Label: "Lokasi belum diperbarui", bukan "offline".
2. **Riwayat Sesi**: daftar `sesi` dengan pagination per 50. Jalur dimuat lewat `dzGetSessionTrack` (teraudit) dan dapat diekspor ke CSV (teraudit).
3. **Lokasi Laporan (■) & Titik Manual (▲)**: titik manual dapat ditambah operator dengan klik peta.

Status sesi dan status kesegaran ditampilkan sebagai label terpisah (teks + simbol, tidak bergantung warna). Listener dilepas saat tab atau filter berubah dan saat halaman ditutup; uji E2E menunjukkan jumlah listener tetap 1.

Peta: tile OpenStreetMap dengan atribusi "© OpenStreetMap contributors". Kebijakan tile OSM membatasi penggunaan berat; untuk pemakaian produksi yang besar, gunakan penyedia tile berlisensi.

## Batasan yang jujur
- **Web saja**: pengambilan lokasi berjalan selama halaman terbuka dan layar menyala.
  - Saat layar terkunci, browser di latar belakang, atau tab ditutup, browser dapat menghentikan GPS. Aplikasi menampilkan peringatan dan melanjutkan saat halaman aktif kembali.
  - Opsi "Jaga layar tetap menyala" (Screen Wake Lock) membantu jika browser mendukungnya.
- **Belum terverifikasi**: perilaku pada layar terkunci/latar belakang di perangkat fisik Android/iOS, serta akurasi GPS nyata. Pengujian memakai Chromium (Playwright) dengan geolokasi emulasi.
- Tracking latar belakang yang andal memerlukan aplikasi Android native dengan *foreground service* bertipe `location`, notifikasi yang terus tampil, serta izin `ACCESS_FINE_LOCATION`, `FOREGROUND_SERVICE_LOCATION`, dan bila perlu `ACCESS_BACKGROUND_LOCATION` sesuai kebijakan Google Play. Ini **tidak** termasuk implementasi saat ini.
