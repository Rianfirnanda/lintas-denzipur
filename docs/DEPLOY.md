# Setup, Deployment, Migrasi & Rollback

> **Status:** belum pernah di-deploy. Firebase CLI di mesin ini belum login (`No authorized accounts`), sehingga target produksi belum dapat diverifikasi. Jangan menjalankan perintah produksi sebelum prasyarat di bawah dicek.

## Target
| Komponen | Target | Catatan |
|---|---|---|
| Project | `lintas-benteng` | `.firebaserc` alias `default` |
| Firestore | database **`denzipur`**, lokasi `asia-southeast2` | harus dibuat dulu; Rules & indexes hanya untuk database ini |
| Storage | bucket **`lintas-benteng-denzipur`** (target `denzipur-docs`) | harus dibuat dulu; Rules hanya untuk bucket ini |
| Functions | codebase **`denzipur`**, region `asia-southeast2`, Node 22 | fungsi `dz*`; tidak menyentuh codebase lain |
| Hosting | situs **`lintas-denzipur`** (target `denzipur`) → `public/` | situs Benteng tidak disentuh |

## Prasyarat (sekali, oleh pemilik project)
1. Paket **Blaze**: dibutuhkan untuk Functions, database bernama, bucket tambahan, dan Scheduler.
2. Login:
   ```bash
   firebase login
   ```
   ```bash
   firebase use default
   ```
3. Buat database:
   ```bash
   firebase firestore:databases:create denzipur --location=asia-southeast2
   ```
4. Buat bucket `lintas-benteng-denzipur` di lokasi `asia-southeast2`: Firebase Console → Storage → Add bucket.
5. Buat situs Hosting:
   ```bash
   firebase hosting:sites:create lintas-denzipur
   ```
6. Tambahkan `lintas-denzipur.web.app` ke Auth → Settings → **Authorized domains**.
7. Isi `functions/.env`: `DZ_BOOTSTRAP_ADMINS` = email Google administrator pertama. Contoh tanpa rahasia ada di `.env.example`.
8. Opsional, App Check:
   - Daftarkan reCAPTCHA Enterprise dan isi `appCheckSiteKey` di `public/js/config.js`.
   - Pantau metrik terlebih dahulu.
   - Setelah semua klien mengirim token, set `DZ_ENFORCE_APP_CHECK=true`.

## Pemeriksaan sebelum deploy
```bash
npm install
```
```bash
cd functions && npm install && cd ..
```
```bash
npm test
```
```bash
npm run check
```

## Perintah deploy (urutan aman)
```bash
firebase deploy --only firestore:denzipur
```
```bash
firebase deploy --only storage:denzipur-docs
```
```bash
firebase deploy --only functions:denzipur
```
```bash
firebase deploy --only hosting:denzipur
```
Indexes komposit perlu beberapa menit untuk dibangun. Query yang membutuhkannya akan gagal sampai index berstatus *Enabled*.

**Jangan** menjalankan `firebase deploy` tanpa `--only`, dan jangan men-deploy Rules ke database `(default)` dari repositori ini.

## Migrasi data lama (opsional, manual)
Data Denzipur lama berada di database default: `lintas`, `users` dengan role `user-denzipur`, `lintas_kegiatan`, dan `lintas_tracking`.

1. Siapkan kredensial operator. Jangan memakai file service-account dari folder Downloads dan jangan menyimpannya di repositori.
   ```bash
   gcloud auth application-default login
   ```
2. Jalankan dry-run (hanya membaca):
   ```bash
   node scripts/migrate-from-default.mjs --project lintas-benteng --dry-run
   ```
3. Tinjau angka hasil dry-run, lalu terapkan:
   ```bash
   node scripts/migrate-from-default.mjs --project lintas-benteng --apply --unit-default <UNIT-ID>
   ```

Sifat migrasi:
- **Idempoten**: ID `legacy_<id>`, dan akses yang sudah ada tidak ditimpa.
- **Tidak mengubah atau menghapus** data di database default.
- Admin lama menjadi `sysadmin`. Anggota lama dimigrasikan sebagai **pending** agar unitnya ditetapkan.
- Laporan lama menjadi status Diajukan dengan `legacy: true`. Foto lama tetap berupa `fotoUrlLama` (URL bertoken di bucket Benteng) dan tidak disalin.

## Peralihan dari `/denzipur` lama
Setelah situs baru berjalan, ganti `public/denzipur/` pada repositori Hosting Benteng dengan redirect ke `https://lintas-denzipur.web.app/admin.html`. Langkah ini dilakukan di repositori Benteng, bukan di sini. Sampai saat itu, halaman lama tetap berjalan dengan data lama dan tidak terpengaruh deploy ini.

Pembersihan dokumen Denzipur di koleksi Benteng (`users` dengan role `user-denzipur`, `lintas`) **tidak** otomatis. Lakukan manual setelah migrasi disetujui.

## Rollback
| Komponen | Cara | Dampak data |
|---|---|---|
| Hosting | `firebase hosting:rollback` (pilih situs `lintas-denzipur`) atau Console → Release history | tidak ada |
| Functions | deploy ulang commit sebelumnya dengan `--only functions:denzipur`; menghapus semua: `firebase functions:delete <nama> --region asia-southeast2` | sesi yang sedang aktif tidak bisa mengirim titik sampai fungsi kembali; antrean klien menyimpan titik (maks. `maxQueue`) |
| Firestore Rules | Console → Firestore (database `denzipur`) → Rules → riwayat versi | Rules hanya berlaku untuk database `denzipur`; tidak memengaruhi Benteng |
| Storage Rules | Console → Storage (bucket denzipur) → Rules → riwayat | sama |
| Seluruh Denzipur | kembalikan redirect `/denzipur` ke kode lama | data baru tetap di database `denzipur`; data lama tidak pernah diubah |

Kompatibilitas: klien lama (folder `/denzipur` di situs Benteng) membaca dan menulis database default, sehingga tidak terpengaruh Rules baru. Klien baru membutuhkan Functions yang sudah ter-deploy, jadi deploy Functions **sebelum** Hosting.
