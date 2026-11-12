# Pengujian & Hasil

Semua pengujian berjalan di **Firebase Emulator** dengan project `demo-denzipur`. Project `demo-*` tidak dapat menyentuh produksi, dan helper tes menolak berjalan di project lain. Data uji fiktif: akun `*@denzipur.test`, unit "Unit Uji A/B", koordinat buatan.

```bash
npm install && (cd functions && npm install)
npm run test:unit      # 13 tes logika murni
npm run test:emu       # 19 tes Rules + Functions + Storage di emulator
npm run check          # pemeriksaan build statis
```

## Hasil (12 Nov 2026, Windows 11, Node 22.23, firebase-tools 15.34, Java 21)
- `test:unit`: **13/13 lolos**
- `test:emu`: **19/19 lolos**
- `check`: **OK** (22 file publik; sintaks JS, referensi lokal, tidak ada kredensial)

| # | Kebutuhan | Bukti |
|---|---|---|
| 1 | Mulai → kirim → tampil di admin → akhiri | emu `1.` + E2E browser |
| 2 | Kirim setelah sesi ditutup ditolak | emu `2.` (`failed-precondition/sesi_ditutup`) |
| 3 | Sesi aktif ganda dicegah | emu `3.`, `3b.` (dua perangkat bersamaan → 1 sesi) + E2E multi-tab |
| 4 | Tidak bisa kirim atas nama orang lain | emu `4.` |
| 5 | Anggota tak bisa baca lokasi orang lain | emu `5.` |
| 6 | Operator di luar lingkup ditolak | emu `6.` |
| 7 | Pending/blocked ditolak | emu `7.` + E2E layar "Menunggu persetujuan" |
| 8 | Lintas Benteng ↔ Denzipur sesuai matriks | emu `8.` (akun Auth tanpa `akses` ditolak; klaim Benteng dipertahankan) |
| 9 | Titik terlambat tidak menimpa terbaru | emu `9.` |
| 10 | Offline tersinkron tanpa duplikasi | emu `10.` + unit antrean + E2E offline |
| 11 | Izin ditolak & koneksi terputus | unit `classifyGeoError` + E2E (izin ditolak disimulasikan, offline via Playwright) |
| 12 | Kedaluwarsa berubah sesuai waktu | unit `freshness` + emu `12/14` + E2E label "Lokasi belum diperbarui" |
| 13 | Status laporan hanya oleh peran berwenang | emu `13.` + E2E pemeriksa |
| 14 | Dashboard konsisten dengan data uji | emu `12/14` + E2E (2 personel aktif, 1 kegiatan berjalan, 1 sesi) |
| 15 | Storage menolak akses tak berwenang | emu `15.` |
| 16 | Tidak ada listener ganda | unit `listener scope` + E2E (`__dzListeners()` = 1 setelah 4× ganti filter + 3× ganti tab) |
| 17 | Build & halaman tanpa error | `npm run check` + E2E: 10 halaman admin sebagai sysadmin, 0 error konsol |

## E2E di browser (Chromium via Playwright, emulator + hosting lokal)
Langkah: `npm run serve` → `node scripts/seed-emulator.mjs` → buka `http://localhost:5000/anggota.html` dan `admin.html`.

Hasil yang diamati:
- **Mulai tracking**
  - anggota1 memilih "Latihan Uji Lapangan", lalu banner "TRACKING AKTIF — Latihan Uji Lapangan" tampil.
  - Status "Tersinkron".
- **Offline**
  - 3 titik diambil saat offline, lalu tampil "Offline — 3 titik disimpan di perangkat".
  - Setelah online: "Tersinkron", antrean 0.
  - Di server: `pointCount` 5 = 5 dokumen titik, dan posisi terkini adalah titik offline terbaru.
- **Tampilan operator Unit A**
  - Dashboard: 2 personel aktif · 1 kegiatan berjalan · 1 sesi aktif.
  - Live Tracking: popup memuat sumber "Sesi tracking (GPS perangkat)", waktu pengambilan, waktu diterima server, dan akurasi.
  - Setelah >2 menit tanpa titik baru (ambang uji 2 menit) muncul label "Lokasi belum diperbarui".
  - "Lihat jalur" menampilkan 8 titik dan garis jalur, dan tercatat di audit.
- **Muat ulang halaman anggota**
  - Sesi aktif terdeteksi dan tombol "Lanjutkan Tracking" muncul.
  - Tab kedua pada perangkat yang sama menampilkan "Tracking sedang berjalan di tab lain", tanpa tombol Mulai.
- **Akhiri tracking**: anggota melihat "Tidak ada sesi" dan antrean dibersihkan. Admin melihat "Sesi Selesai … (diakhiri anggota)".
- **Izin lokasi ditolak** (disimulasikan dengan mengganti `navigator.geolocation`, karena Playwright tidak dapat menekan "Block"):
  - tampil pesan izin ditolak dan tombol Coba Lagi;
  - **tidak ada sesi yang dibuat**.
- **Laporan berfoto dan berlokasi**: diajukan → pemeriksa melihat foto (dimuat via `getBlob`) → Perlu Revisi dengan catatan → anggota merevisi dan mengajukan ulang → Disetujui. Status di sisi anggota ikut "Disetujui".
- **Sysadmin**
  - Menyetujui akun pending lewat Personel & Akses; layar anggota pending otomatis berpindah ke aplikasi.
  - Membuat kegiatan dengan peserta lewat UI.
- **Pembaca ringkasan**
  - Menu hanya Dashboard/Kegiatan/Rekap/Pengaturan.
  - Kartu lokasi berstatus "Tidak tersedia untuk peran ini".
  - URL `#tracking` dialihkan ke Dashboard.
- **Migrasi** (`scripts/migrate-from-default.mjs`, terhadap emulator)
  - dry-run tidak menulis;
  - `--apply` dua kali tidak menggandakan data;
  - database default tidak berubah.

Tangkapan layar ada di `docs/screenshots/`.

## Belum terverifikasi
- Perangkat fisik Android/iOS: GPS nyata, layar terkunci, tab di latar belakang, Safari iOS.
- Login Google sungguhan (popup). Di emulator dipakai login email/sandi khusus emulator.
- Deploy dan perilaku di project produksi `lintas-benteng`: CLI tidak memiliki kredensial (lihat [DEPLOY.md](DEPLOY.md)).
- Indexes komposit hanya diverifikasi di emulator (emulator tidak mewajibkan index); produksi bisa meminta index tambahan.
- Trigger `onDocumentWritten` pada database bernama dan Cloud Scheduler di produksi.
