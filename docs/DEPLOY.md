# Setup, Deployment, Migrasi & Rollback

> **Target:** project Firebase **`lintas-denzipur`** (terpisah dari Lintas Benteng). Repositori ini tidak berisi target ke project `lintas-benteng`, sehingga deploy dari sini tidak dapat menyentuh database, Rules, Functions, atau Hosting Lintas Benteng.

## Target
| Komponen | Target |
|---|---|
| Project | `lintas-denzipur` (`.firebaserc` alias `default`) |
| Firestore | database `(default)` project `lintas-denzipur`, lokasi `asia-southeast2` |
| Storage | bucket default `lintas-denzipur.firebasestorage.app` |
| Functions | codebase `denzipur`, region `asia-southeast2`, Node 22 |
| Hosting | situs `lintas-denzipur` → `https://lintas-denzipur.web.app` |

## Prasyarat (sekali)
Sudah selesai:
- Project `lintas-denzipur` dibuat.
- Aplikasi web "Lintas Denzipur Web" terdaftar; konfigurasinya ada di `public/js/config.js`.

Belum selesai (dikerjakan pemilik project lewat Firebase Console):
1. **Upgrade ke paket Blaze** (pojok kiri bawah → Upgrade). Dibutuhkan untuk Cloud Functions, Cloud Scheduler, dan bucket Storage. Disarankan memasang *budget alert* di Google Cloud Billing.
2. **Authentication → Get started → Sign-in method → Google → Enable.** Domain `lintas-denzipur.web.app` dan `lintas-denzipur.firebaseapp.com` otomatis masuk Authorized domains.
3. **Firestore Database → Create database**: lokasi `asia-southeast2 (Jakarta)`, mode **production**. Lokasi tidak bisa diubah.
4. **Storage → Get started**: lokasi `asia-southeast2`, mode **production**.
5. Periksa `functions/.env`: `DZ_BOOTSTRAP_ADMINS` berisi email Google administrator pertama.
6. Opsional, App Check:
   - Daftarkan reCAPTCHA Enterprise dan isi `appCheckSiteKey` di `public/js/config.js`.
   - Pantau metriknya dulu, lalu set `DZ_ENFORCE_APP_CHECK=true` setelah semua klien mengirim token.

Langkah 3 dan 4 juga bisa dijalankan lewat CLI setelah login:
```bash
firebase firestore:databases:create "(default)" --location=asia-southeast2 --delete-protection=ENABLED --project lintas-denzipur
```

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
Functions di-deploy **sebelum** Hosting, karena halaman login memanggil `dzRegister`.
```bash
firebase deploy --only firestore --project lintas-denzipur
```
```bash
firebase deploy --only storage --project lintas-denzipur
```
```bash
firebase deploy --only functions:denzipur --project lintas-denzipur
```
```bash
firebase deploy --only hosting --project lintas-denzipur
```
Indexes komposit perlu beberapa menit untuk dibangun. Query yang membutuhkannya gagal sampai index berstatus *Enabled*.

Selalu sertakan `--project lintas-denzipur` agar target terlihat jelas di setiap perintah.

## Migrasi data lama (opsional, manual)
Data Denzipur lama ada di project `lintas-benteng` (database default): koleksi `lintas`, `users` dengan role `user-denzipur`, `lintas_kegiatan`, dan `lintas_tracking`. Skrip **hanya membaca** project Benteng dan menulis ke project Denzipur.

1. Siapkan kredensial operator dengan akses baca Firestore di project `lintas-benteng`. Jangan memakai file service-account dari folder Downloads dan jangan menyimpannya di repositori.
   ```bash
   gcloud auth application-default login
   ```
2. Dry-run (tidak menulis apa pun):
   ```bash
   node scripts/migrate-from-default.mjs --source lintas-benteng --target lintas-denzipur --dry-run
   ```
3. Setelah angka dari dry-run ditinjau, terapkan:
   ```bash
   node scripts/migrate-from-default.mjs --source lintas-benteng --target lintas-denzipur --apply --unit-default <UNIT-ID>
   ```

Sifat migrasi:
- Idempoten: ID `legacy_<id>`, dan akses yang sudah ada tidak ditimpa.
- Admin lama menjadi `sysadmin`; anggota lama masuk sebagai **pending** agar unitnya ditetapkan.
- Laporan lama menjadi status Diajukan dengan `legacy: true`. Foto lama tetap berupa `fotoUrlLama` (URL bertoken di bucket Benteng), tidak disalin.
- Akun `akses` lama memakai UID dari project Benteng. UID di project Denzipur berbeda, sehingga akun hasil migrasi hanya bernilai sebagai catatan riwayat; personel tetap mendaftar ulang di Denzipur.

## Peralihan dari `/denzipur` lama
Halaman lama di `lintas-benteng.web.app/denzipur/` dikelola dari repositori Hosting Lintas Benteng. Pemilik project Benteng dapat menggantinya dengan redirect ke `https://lintas-denzipur.web.app/admin.html`. Itu tidak dilakukan dari repositori ini.

## Rollback
| Komponen | Cara | Dampak |
|---|---|---|
| Hosting | `firebase hosting:rollback --project lintas-denzipur` atau Console → Hosting → Release history | tidak ada dampak data |
| Functions | deploy ulang commit sebelumnya dengan `--only functions:denzipur`, atau hapus: `firebase functions:delete <nama> --region asia-southeast2 --project lintas-denzipur` | selama fungsi tidak tersedia, titik tracking tertahan di antrean perangkat (maks. `maxQueue`) |
| Firestore Rules | Console → Firestore → Rules → riwayat versi | hanya project Denzipur |
| Storage Rules | Console → Storage → Rules → riwayat versi | hanya project Denzipur |

Lintas Benteng tidak terdampak oleh langkah rollback mana pun.
