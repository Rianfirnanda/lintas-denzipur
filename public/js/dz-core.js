// Logika klien murni (tanpa Firebase) — dipakai aplikasi anggota & admin, dan diuji unit di Node.
export const TZ = 'Asia/Jakarta';

export const LABEL = {
  role: { sysadmin: 'Administrator Sistem', operator: 'Operator Unit', pemeriksa: 'Pemeriksa Laporan', pembaca: 'Pembaca Ringkasan', anggota: 'Anggota' },
  akun: { pending: 'Menunggu Persetujuan', active: 'Aktif', blocked: 'Diblokir' },
  kegiatan: { rencana: 'Rencana', berjalan: 'Berjalan', selesai: 'Selesai', dibatalkan: 'Dibatalkan' },
  laporan: { draf: 'Draf', diajukan: 'Diajukan', perlu_revisi: 'Perlu Revisi', disetujui: 'Disetujui' },
  sesi: { aktif: 'Sesi Aktif', selesai: 'Sesi Selesai' },
  fresh: { baru: 'Lokasi terbaru', kedaluwarsa: 'Lokasi belum diperbarui', belum_ada: 'Belum ada lokasi' },
  endedReason: {
    selesai_oleh_anggota: 'diakhiri anggota', diakhiri_operator: 'diakhiri operator', pindah_perangkat: 'pindah perangkat',
    keluar_aplikasi: 'anggota keluar', akun_diblokir: 'akun diblokir', akses_dicabut: 'akses dicabut',
    akun_dihapus: 'akun dihapus', tidak_ada_pembaruan: 'diakhiri sistem: tidak ada pembaruan',
  },
  quality: { akurasi_rendah: 'akurasi rendah', koordinat_nol: 'koordinat 0,0', lompatan_tidak_wajar: 'lompatan tidak wajar' },
};

export function fmtTime(ms, opts = {}) {
  if (ms == null || !Number.isFinite(ms)) return '–';
  return new Date(ms).toLocaleString('id-ID', { timeZone: TZ, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: opts.seconds ? '2-digit' : undefined }) + ' WIB';
}
export function ago(ms, nowMs = Date.now()) {
  if (ms == null) return '–';
  const s = Math.max(0, Math.round((nowMs - ms) / 1000));
  if (s < 60) return `${s} dtk lalu`;
  if (s < 3600) return `${Math.floor(s / 60)} mnt lalu`;
  if (s < 86400) return `${Math.floor(s / 3600)} jam lalu`;
  return `${Math.floor(s / 86400)} hari lalu`;
}
export const tsMs = (v) => (v == null ? null : typeof v === 'number' ? v : typeof v.toMillis === 'function' ? v.toMillis() : v.seconds != null ? v.seconds * 1000 : null);

/** Kesegaran lokasi berdasar waktu pengambilan di perangkat — bukan status koneksi. */
export function freshness(capturedAtMs, nowMs, staleMinutes) {
  if (!capturedAtMs) return 'belum_ada';
  return nowMs - capturedAtMs > staleMinutes * 60000 ? 'kedaluwarsa' : 'baru';
}

/* ── CSV aman dari formula injection ── */
export function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}
export const toCsv = (rows) => rows.map((r) => r.map(csvCell).join(',')).join('\r\n');

/* ── Antrean titik lokal (offline) ── */
export class TrackingQueue {
  constructor({ storage, sessionId, maxSize = 500, key = 'dz-queue' }) {
    this.storage = storage; this.key = key; this.maxSize = maxSize;
    const saved = this._read();
    if (saved && saved.sessionId === sessionId) Object.assign(this, { sessionId, nextSeq: saved.nextSeq, items: saved.items, dropped: saved.dropped || 0 });
    else Object.assign(this, { sessionId, nextSeq: 0, items: [], dropped: 0 });
    this._write();
  }
  _read() { try { return JSON.parse(this.storage.getItem(this.key) || 'null'); } catch { return null; } }
  _write() { try { this.storage.setItem(this.key, JSON.stringify({ sessionId: this.sessionId, nextSeq: this.nextSeq, items: this.items, dropped: this.dropped })); } catch { /* storage penuh/terblokir: antrean tetap di memori */ } }
  /** Pastikan seq baru tidak bertabrakan dengan yang sudah diterima server (mis. setelah pindah tab). */
  ensureSeqAfter(lastSeq) { if (Number.isInteger(lastSeq) && lastSeq >= this.nextSeq) { this.nextSeq = lastSeq + 1; this._write(); } }
  push({ lat, lng, acc, t }) {
    const p = { seq: this.nextSeq++, lat, lng, acc, t };
    this.items.push(p);
    if (this.items.length > this.maxSize) { const n = this.items.length - this.maxSize; this.items.splice(0, n); this.dropped += n; }
    this._write();
    return p;
  }
  peek(n) { return this.items.slice(0, n); }
  /** Hapus titik yang sudah diterima / duplikat / ditolak server. */
  ack(seqs) { const s = new Set(seqs); const before = this.items.length; this.items = this.items.filter((p) => !s.has(p.seq)); this._write(); return before - this.items.length; }
  get size() { return this.items.length; }
  clear() { try { this.storage.removeItem(this.key); } catch { /* abaikan */ } this.items = []; }
}

/** Klasifikasi galat panggilan Functions untuk aplikasi anggota. */
export function classifyCallError(err) {
  const code = (err?.code || '').replace(/^functions\//, '');
  const reason = err?.details?.reason;
  if (code === 'failed-precondition' && reason === 'sesi_ditutup') return 'session_closed';
  if (code === 'failed-precondition' && reason === 'perangkat_lain') return 'other_device';
  if (code === 'permission-denied' && (reason === 'blocked' || reason === 'pending')) return 'account_inactive';
  if (code === 'permission-denied') return 'forbidden';
  if (code === 'unauthenticated') return 'signed_out';
  if (code === 'resource-exhausted') return 'backoff';
  if (code === 'invalid-argument') return 'drop';
  return 'retry'; // unavailable, deadline-exceeded, internal, jaringan
}

export function classifyGeoError(err) {
  switch (err?.code) {
    case 1: return { kind: 'denied', text: 'Izin lokasi ditolak. Aktifkan izin lokasi untuk situs ini di pengaturan browser, lalu tekan Coba Lagi.' };
    case 2: return { kind: 'unavailable', text: 'Lokasi tidak tersedia. Pastikan GPS/layanan lokasi perangkat menyala.' };
    case 3: return { kind: 'timeout', text: 'Waktu menunggu GPS habis. Sinyal mungkin lemah; aplikasi akan mencoba lagi.' };
    default: return { kind: 'other', text: 'Lokasi tidak dapat dibaca: ' + (err?.message || 'kesalahan tidak dikenal') };
  }
}

/** Pengelola listener: memastikan listener lama dilepas saat filter/halaman berubah. */
export function createListenerScope() {
  const subs = new Set();
  return {
    add(unsub) { subs.add(unsub); return () => { subs.delete(unsub); unsub(); }; },
    clear() { for (const u of subs) { try { u(); } catch { /* abaikan */ } } subs.clear(); },
    get size() { return subs.size; },
  };
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
