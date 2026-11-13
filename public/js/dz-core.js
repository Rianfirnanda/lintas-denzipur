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

/* ── Aturan domain (sebelumnya di Cloud Functions; kini dipakai klien, dan ditegakkan ulang oleh Firestore Rules) ── */
export const ROLES = ['sysadmin', 'operator', 'pemeriksa', 'pembaca', 'anggota'];
export const STAFF_ROLES = ['operator', 'pemeriksa', 'pembaca'];
export const KEGIATAN_STATUS = ['rencana', 'berjalan', 'selesai', 'dibatalkan'];
export const LAPORAN_STATUS = ['draf', 'diajukan', 'perlu_revisi', 'disetujui'];
export const MAX_BATCH = 50;          // titik per batch (dibatasi juga oleh Rules)
export const MIN_INGEST_GAP_MS = 3000; // jeda minimum antar batch per sesi (ditegakkan Rules)

// Bawaan disetel untuk kuota paket Spark (20.000 tulis/hari). Lihat docs/TRACKING.md.
export const DEFAULT_SETTINGS = Object.freeze({
  staleMinutes: 5,
  captureIntervalSec: 30,
  sendIntervalSec: 60,
  maxQueue: 500,
  autoEndMinutes: 180,
  retentionDays: 90,
});
export const SETTINGS_LIMITS = Object.freeze({
  staleMinutes: [1, 120],
  captureIntervalSec: [5, 300],
  sendIntervalSec: [10, 600],
  maxQueue: [50, 2000],
  autoEndMinutes: [30, 1440],
  retentionDays: [7, 730],
});
export function mergeSettings(raw) {
  const out = { ...DEFAULT_SETTINGS };
  for (const [k, [lo, hi]] of Object.entries(SETTINGS_LIMITS)) {
    const v = raw?.[k];
    if (Number.isInteger(v) && v >= lo && v <= hi) out[k] = v;
  }
  return out;
}

export const isSafeId = (s) => typeof s === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(s);
const num = (v) => typeof v === 'number' && Number.isFinite(v);

export function haversineM(a, b) {
  const R = 6371000, rad = (d) => d * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Validasi satu titik sebelum dikirim. Rules menegakkan ulang rentang, tipe, dan waktu di server. */
export function validatePoint(p, { sessionStartMs, nowMs, maxFutureMs = 2 * 60 * 1000, maxPastSkewMs = 60 * 1000 }) {
  if (!p || typeof p !== 'object') return { ok: false, reason: 'format' };
  if (Object.keys(p).some((k) => !['seq', 'lat', 'lng', 'acc', 't'].includes(k))) return { ok: false, reason: 'field_tidak_diizinkan' };
  if (!Number.isInteger(p.seq) || p.seq < 0 || p.seq > 1e9) return { ok: false, reason: 'seq' };
  if (!num(p.lat) || p.lat < -90 || p.lat > 90) return { ok: false, reason: 'lat' };
  if (!num(p.lng) || p.lng < -180 || p.lng > 180) return { ok: false, reason: 'lng' };
  if (!num(p.acc) || p.acc < 0 || p.acc > 100000) return { ok: false, reason: 'akurasi' };
  if (!Number.isInteger(p.t)) return { ok: false, reason: 'waktu' };
  if (p.t > nowMs + maxFutureMs) return { ok: false, reason: 'waktu_masa_depan' };
  if (sessionStartMs != null && p.t < sessionStartMs - maxPastSkewMs) return { ok: false, reason: 'sebelum_sesi' };
  const quality = [];
  if (p.acc > 100) quality.push('akurasi_rendah');
  if (p.lat === 0 && p.lng === 0) quality.push('koordinat_nol');
  return { ok: true, point: { seq: p.seq, lat: p.lat, lng: p.lng, acc: Math.round(p.acc * 10) / 10, t: p.t }, quality };
}

/** Tandai lompatan tidak wajar (> maxSpeed m/s). Hanya penanda kualitas data, bukan kesimpulan pelanggaran. */
export function flagJumps(sortedPoints, prev, maxSpeed = 70) {
  let last = prev;
  for (const sp of sortedPoints) {
    if (last && sp.point.t > last.t) {
      const v = haversineM(last, sp.point) / ((sp.point.t - last.t) / 1000);
      if (v > maxSpeed) sp.quality.push('lompatan_tidak_wajar');
    }
    last = sp.point;
  }
  return sortedPoints;
}

export const LAPORAN_TRANSITIONS = Object.freeze({
  pemilik: { draf: ['draf', 'diajukan'], perlu_revisi: ['perlu_revisi', 'diajukan'] },
  pemeriksa: { diajukan: ['perlu_revisi', 'disetujui'] },
});
export const canTransitionLaporan = (actor, from, to) => (LAPORAN_TRANSITIONS[actor]?.[from] || []).includes(to);
