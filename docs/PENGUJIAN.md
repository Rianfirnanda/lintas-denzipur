# Pengujian & Hasil

Semua pengujian berjalan di **Firebase Emulator** (Auth + Firestore + Hosting) dengan project `demo-denzipur`. Project `demo-*` tidak dapat menyentuh produksi, dan helper tes menolak berjalan di project lain. Data uji fiktif: akun `*@denzipur.test`, unit "Unit Uji A/B", koordinat buatan.

```bash
npm install
```
```bash
npm test
```
```bash
npm run check
```

## Hasil (13 Nov 2026, Windows 11, Node 22.23, firebase-tools 15.34, Java 21) — arsitektur Spark tanpa Functions
- `test:unit`: **13/13 lolos** (antrean offline, kesegaran lokasi, CSV aman, validasi titik, transisi laporan, listener)
- `test:emu`: **18/18 lolos** (Rules + lapisan data `dz-data.js`)
- `check`: **OK** (23 file publik; sintaks JS, referensi lokal, tidak ada kredensial)

| # | Kebutuhan | Bukti |
|---|---|---|
| 1 | Mulai → kirim → tampil di admin → akhiri | emu `1.` + E2E browser |
| 2 | Kirim setelah sesi ditutup ditolak | emu `2.` (lewat klien dan tulis langsung) |
| 3 | Sesi aktif ganda dicegah | emu `3.`, `3b.` (dua perangkat bersamaan → 1 sesi; membuat sesi kedua langsung ditolak Rules) |
| 4 | Tidak bisa kirim atas nama orang lain / menaikkan peran | emu `4.` |
| 5 | Anggota tak bisa baca lokasi orang lain | emu `5.` |
| 6 | Operator di luar lingkup ditolak; pembaca tanpa koordinat | emu `6.` |
| 7 | Pending/blocked ditolak; tak bisa mengaktifkan diri | emu `7.` + E2E blokir |
| 8 | Registrasi: tanpa undangan → pending; undangan & bootstrap ditegakkan Rules | emu `8.` (email belum terverifikasi tidak menjadi admin; dokumen bootstrap tak terbaca klien) |
| 9 | Titik terlambat tidak menimpa posisi terbaru | emu `9.` (termasuk upaya menimpa langsung → ditolak) |
| 10 | Offline tersinkron tanpa duplikasi; batas frekuensi & ukuran | emu `10.` (50 titik/batch; kirim ulang terdeteksi duplikat; 51 titik ditolak) + E2E offline |
| 11 | Izin lokasi ditolak & koneksi terputus | unit `classifyGeoError` + E2E offline (izin ditolak diuji di E2E sebelumnya dengan simulasi) |
| 12 | Kedaluwarsa berubah sesuai waktu | unit `freshness` + emu `12/14` |
| 13 | Status laporan hanya oleh peran berwenang | emu `13.` + E2E pemeriksa |
| 14 | Dashboard konsisten dengan data uji | emu `12/14` + E2E (2 personel aktif · 1 kegiatan berjalan · 1 sesi) |
| 15 | Foto dokumentasi menolak akses tak berwenang | emu `15.` (baca per peran, tipe SVG & > 1 MB ditolak, tidak dapat ditimpa/dihapus setelah diajukan) |
| 16 | Tidak ada listener ganda | unit `listener scope` + E2E sebelumnya (`__dzListeners()` = 1) |
| 17 | Build & halaman tanpa error | `npm run check` + E2E: 10 halaman admin sebagai sysadmin, 0 error konsol |
| – | Pemeliharaan & masa simpan | emu `pemeliharaan` + E2E tombol Pengaturan |

## E2E di browser (Chromium via Playwright, emulator + hosting lokal)
Langkah: `npm run serve` → `node scripts/seed-emulator.mjs` → buka `http://localhost:5000/anggota.html` dan `admin.html`.

Hasil yang diamati:
- **Tracking**: anggota mulai tracking, banner "TRACKING AKTIF — Latihan Uji Lapangan", status "Tersinkron".
- **Offline**: 3 titik saat offline → "Offline — 3 titik disimpan di perangkat" → online → "Tersinkron". Di server: `lastSeq` 3, 4 dokumen titik, tanpa duplikat; posisi terkini = titik offline terbaru.
- **Operator Unit A**:
  - Dashboard: 2 personel aktif · 1 kegiatan berjalan · 1 sesi aktif · 0 lokasi belum diperbarui; aktivitas "mulai tracking" tampil.
  - Live Tracking dan "Lihat jalur" (4 titik) berjalan, tercatat di audit.
- **Laporan berfoto**:
  - Foto PNG 2000×1500 dikompres di perangkat menjadi JPEG 1280×960 (±446 KB), lalu tersimpan di Firestore.
  - Pemeriksa melihat foto → Perlu Revisi dengan catatan → anggota merevisi dan mengajukan ulang → Disetujui. Status di aplikasi anggota ikut berubah.
- **Blokir saat tracking**:
  - Sysadmin memblokir anggota lewat Personel & Akses. Di server sesi menjadi "Sesi Selesai (akun diblokir)" dan perubahan tercatat di audit.
  - Aplikasi anggota menghentikan tracking pada kiriman berikutnya, menampilkan pesan, lalu dimuat ulang ke layar "Akun diblokir".
- **Sysadmin**: 10 halaman admin terbuka tanpa error konsol; tombol pemeliharaan berjalan; galeri Dokumentasi memuat foto dari Firestore.

## Temuan saat pengujian (sudah ditangani)
- **Koneksi pantau macet di emulator.** Halaman anggota yang sudah lama terbuka tidak menerima pembaruan status akses setelah akun diblokir, sedangkan halaman baru langsung membaca "Akun diblokir". Aplikasi kini tidak bergantung pada pembaruan itu: penolakan Rules saat mengirim titik menghentikan tracking, lalu halaman dimuat ulang. Perilaku listener di produksi belum diverifikasi.
- **Geolokasi emulasi Playwright** sempat habis waktu di tab latar belakang. Lokasi laporan kini memakai posisi ≤ 60 detik terakhir.

## Belum terverifikasi
- Perangkat fisik Android/iOS: GPS nyata, layar terkunci, tab di latar belakang, Safari iOS, kompresi foto dari kamera ponsel (HEIC/EXIF).
- Login Google sungguhan (popup). Di emulator dipakai login email/sandi khusus emulator. Bootstrap admin lewat UI juga belum dicoba, karena akun email/sandi emulator tidak terverifikasi; jalurnya sudah diuji di tes Rules.
- Deploy dan perilaku di project produksi `lintas-denzipur`: belum di-deploy.
- Indexes komposit hanya diverifikasi di emulator (emulator tidak mewajibkan index).
- Pemakaian kuota Spark pada beban nyata.
