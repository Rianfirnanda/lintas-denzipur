# Setup, Deployment, Migrasi & Rollback

> **Target:** project Firebase **`lintas-denzipur`** dengan paket **Spark (gratis)**. Yang dipakai hanya Authentication, Firestore, dan Hosting; tidak ada Cloud Functions maupun Cloud Storage. Repositori ini tidak berisi target ke project `lintas-benteng`.

## Target
| Komponen | Target |
|---|---|
| Project | `lintas-denzipur` (`.firebaserc` alias `default`) |
| Firestore | database default, lokasi `asia-southeast2` (Jakarta) |
| Hosting | `https://lintas-denzipur.web.app` |
| Auth | penyedia Google |

## Prasyarat (sekali, oleh pemilik project di Firebase Console)
Sudah selesai:
- Project `lintas-denzipur` dibuat.
- Aplikasi web "Lintas Denzipur Web" terdaftar (`public/js/config.js`).

Belum selesai:
1. **Security → Authentication → Get started → Sign-in method → Google → Enable.**
2. **Databases & Storage → Firestore → Create database.** Lokasi `asia-southeast2 (Jakarta)`, mode **production**. Lokasi tidak bisa diubah.
3. **Administrator pertama.** Di Firestore → Data, buat koleksi `pengaturan`, dokumen `bootstrap`, field `emails` bertipe *array* berisi email Google administrator. Saat email itu login pertama kali ke `admin.html`, akunnya otomatis menjadi Administrator Sistem. Dokumen ini tidak dapat dibaca klien. Hapus atau kosongkan isinya setelah administrator terbentuk.

Langkah 2 juga bisa lewat CLI:
```bash
firebase firestore:databases:create "(default)" --location=asia-southeast2 --delete-protection=ENABLED --project lintas-denzipur
```

## Pemeriksaan sebelum deploy
```bash
npm install
```
```bash
npm test
```
```bash
npm run check
```

## Perintah deploy
Rules dan indexes di-deploy **sebelum** Hosting, karena aplikasi baru membutuhkan Rules baru.
```bash
firebase deploy --only firestore --project lintas-denzipur
```
```bash
firebase deploy --only hosting --project lintas-denzipur
```
Indexes komposit perlu beberapa menit untuk dibangun. Query yang membutuhkannya gagal sampai index berstatus *Enabled*.

## Setelah deploy
1. Buka `https://lintas-denzipur.web.app/admin.html` dan login dengan email bootstrap.
2. Buat **Unit**, lalu undang personel (Personel & Akses → Undang akun), atau setujui akun yang mendaftar sendiri.
3. Buat **Kegiatan** dengan peserta. Anggota memakai `https://lintas-denzipur.web.app/anggota.html`.

## Migrasi data lama (opsional, manual)
Data Denzipur lama ada di project `lintas-benteng` (database default). Skrip **hanya membaca** project Benteng dan menulis ke project Denzipur.

1. Siapkan kredensial operator dengan akses baca Firestore di project `lintas-benteng`. Jangan memakai file service-account dari folder Downloads dan jangan menyimpannya di repositori.
   ```bash
   gcloud auth application-default login
   ```
2. Dry-run:
   ```bash
   node scripts/migrate-from-default.mjs --source lintas-benteng --target lintas-denzipur --dry-run
   ```
3. Setelah angka dari dry-run ditinjau, terapkan:
   ```bash
   node scripts/migrate-from-default.mjs --source lintas-benteng --target lintas-denzipur --apply --unit-default <UNIT-ID>
   ```

Sifat migrasi:
- Idempoten: ID `legacy_<id>`, dan akses yang sudah ada tidak ditimpa.
- Akun hasil migrasi memakai UID project Benteng, sehingga hanya bernilai sebagai catatan riwayat; personel tetap mendaftar di Denzipur.
- Laporan lama menjadi status Diajukan dengan `legacy: true`; foto lama tetap sebagai `fotoUrlLama` (tautan di bucket Benteng) dan tidak disalin.

## Peralihan dari `/denzipur` lama
Halaman lama `lintas-benteng.web.app/denzipur/` dikelola dari repositori Hosting Lintas Benteng. Pemilik project Benteng dapat menggantinya dengan redirect ke `https://lintas-denzipur.web.app/admin.html`; langkah ini tidak dilakukan dari repositori ini.

## Rollback
| Komponen | Cara | Dampak |
|---|---|---|
| Hosting | `firebase hosting:rollback --project lintas-denzipur` atau Console → Hosting → Release history | tidak ada dampak data |
| Firestore Rules | Console → Firestore → Rules → riwayat versi | klien versi baru membutuhkan Rules versi ini; kembalikan Hosting bersamaan |
| Indexes | deploy ulang `firestore.indexes.json` versi sebelumnya | query yang butuh index lama gagal sampai dibangun ulang |

Lintas Benteng tidak terdampak oleh langkah rollback mana pun.
