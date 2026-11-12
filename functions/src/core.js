// Logika murni (tanpa Firebase) agar bisa diuji unit.
export const ROLES = ['sysadmin', 'operator', 'pemeriksa', 'pembaca', 'anggota'];
export const STAFF_ROLES = ['operator', 'pemeriksa', 'pembaca'];
export const ACCOUNT_STATUS = ['pending', 'active', 'blocked'];
export const KEGIATAN_STATUS = ['rencana', 'berjalan', 'selesai', 'dibatalkan'];
export const LAPORAN_STATUS = ['draf', 'diajukan', 'perlu_revisi', 'disetujui'];

export const DEFAULT_SETTINGS = Object.freeze({
  staleMinutes: 5,          // lokasi dianggap "belum diperbarui" setelah n menit
  captureIntervalSec: 15,   // jarak minimum pengambilan titik di perangkat
  sendIntervalSec: 30,      // jarak pengiriman antrean ke server
  maxQueue: 500,            // batas antrean lokal perangkat
  maxBatch: 100,            // batas titik per panggilan ingest
  minIngestGapMs: 4000,     // batas frekuensi panggilan ingest per sesi
  autoEndMinutes: 180,      // sesi aktif tanpa pembaruan selama n menit diakhiri sistem
  retentionDays: 90,        // masa simpan riwayat titik setelah sesi selesai
});

export const SETTINGS_LIMITS = Object.freeze({
  staleMinutes: [1, 120],
  captureIntervalSec: [5, 300],
  sendIntervalSec: [10, 600],
  maxQueue: [50, 2000],
  maxBatch: [10, 200],
  minIngestGapMs: [1000, 60000],
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

const SAFE_ID = /^[A-Za-z0-9_-]{6,64}$/;
export const isSafeId = (s) => typeof s === 'string' && SAFE_ID.test(s);

const num = (v) => typeof v === 'number' && Number.isFinite(v);

export function haversineM(a, b) {
  const R = 6371000, rad = (d) => d * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Validasi satu titik dari perangkat.
 * Titik yang ditolak tidak disimpan; titik dengan kualitas meragukan disimpan dengan penanda.
 */
export function validatePoint(p, { sessionStartMs, nowMs, maxFutureMs = 2 * 60 * 1000, maxPastSkewMs = 60 * 1000 }) {
  if (!p || typeof p !== 'object') return { ok: false, reason: 'format' };
  const keys = Object.keys(p);
  if (keys.some((k) => !['seq', 'lat', 'lng', 'acc', 't'].includes(k))) return { ok: false, reason: 'field_tidak_diizinkan' };
  if (!Number.isInteger(p.seq) || p.seq < 0 || p.seq > 1e9) return { ok: false, reason: 'seq' };
  if (!num(p.lat) || p.lat < -90 || p.lat > 90) return { ok: false, reason: 'lat' };
  if (!num(p.lng) || p.lng < -180 || p.lng > 180) return { ok: false, reason: 'lng' };
  if (!num(p.acc) || p.acc < 0 || p.acc > 100000) return { ok: false, reason: 'akurasi' };
  if (!Number.isInteger(p.t)) return { ok: false, reason: 'waktu' };
  if (p.t > nowMs + maxFutureMs) return { ok: false, reason: 'waktu_masa_depan' };
  if (p.t < sessionStartMs - maxPastSkewMs) return { ok: false, reason: 'sebelum_sesi' };
  const quality = [];
  if (p.acc > 100) quality.push('akurasi_rendah');
  if (p.lat === 0 && p.lng === 0) quality.push('koordinat_nol');
  return { ok: true, point: { seq: p.seq, lat: p.lat, lng: p.lng, acc: Math.round(p.acc * 10) / 10, t: p.t }, quality };
}

/** Tandai lompatan tidak wajar (> maxSpeed m/s) terhadap titik sebelumnya. Hanya penanda kualitas data. */
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

/** Status kesegaran lokasi berdasarkan waktu pengambilan, bukan koneksi dashboard. */
export function freshness(capturedAtMs, nowMs, staleMinutes) {
  if (!capturedAtMs) return 'belum_ada';
  return nowMs - capturedAtMs > staleMinutes * 60000 ? 'kedaluwarsa' : 'baru';
}

/** Perpindahan status laporan yang sah, beserta pelaku. */
export const LAPORAN_TRANSITIONS = Object.freeze({
  pemilik: { draf: ['draf', 'diajukan'], perlu_revisi: ['perlu_revisi', 'diajukan'] },
  pemeriksa: { diajukan: ['perlu_revisi', 'disetujui'] },
});
export function canTransitionLaporan(actor, from, to) {
  return (LAPORAN_TRANSITIONS[actor]?.[from] || []).includes(to);
}

export function dzClaims(akses) {
  return {
    r: akses.role,
    s: akses.status,
    u: akses.unitId || null,
    sc: Array.isArray(akses.unitScope) ? akses.unitScope.slice(0, 30) : [],
  };
}
