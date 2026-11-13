import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TrackingQueue, freshness, csvCell, toCsv, classifyGeoError, createListenerScope, validatePoint, flagJumps, mergeSettings, canTransitionLaporan } from '../../public/js/dz-core.js';

const mem = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k), m }; };

test('antrean: seq berurutan, persist, dan bertahan setelah muat ulang', () => {
  const s = mem();
  const q = new TrackingQueue({ storage: s, sessionId: 'S1', maxSize: 5 });
  q.push({ lat: 1, lng: 1, acc: 5, t: 1 }); q.push({ lat: 1, lng: 1, acc: 5, t: 2 });
  const q2 = new TrackingQueue({ storage: s, sessionId: 'S1', maxSize: 5 });
  assert.equal(q2.size, 2);
  assert.equal(q2.push({ lat: 1, lng: 1, acc: 5, t: 3 }).seq, 2);
});

test('antrean: sesi berbeda tidak mewarisi antrean lama', () => {
  const s = mem();
  new TrackingQueue({ storage: s, sessionId: 'A' }).push({ lat: 1, lng: 1, acc: 1, t: 1 });
  assert.equal(new TrackingQueue({ storage: s, sessionId: 'B' }).size, 0);
});

test('antrean: batas ukuran membuang titik tertua dan mencatat jumlahnya', () => {
  const q = new TrackingQueue({ storage: mem(), sessionId: 'S', maxSize: 3 });
  for (let i = 0; i < 5; i++) q.push({ lat: 0, lng: 0, acc: 1, t: i });
  assert.deepEqual(q.items.map((p) => p.seq), [2, 3, 4]);
  assert.equal(q.dropped, 2);
});

test('antrean: ack menghapus titik terkirim; kirim ulang tidak menggandakan', () => {
  const q = new TrackingQueue({ storage: mem(), sessionId: 'S' });
  for (let i = 0; i < 4; i++) q.push({ lat: 0, lng: 0, acc: 1, t: i });
  q.ack([0, 1]); q.ack([0, 1]);
  assert.deepEqual(q.items.map((p) => p.seq), [2, 3]);
});

test('antrean: ensureSeqAfter mencegah tabrakan seq setelah resume', () => {
  const q = new TrackingQueue({ storage: mem(), sessionId: 'S' });
  q.ensureSeqAfter(41);
  assert.equal(q.push({ lat: 0, lng: 0, acc: 1, t: 0 }).seq, 42);
});

test('kesegaran lokasi berubah sesuai waktu', () => {
  const t0 = 1_700_000_000_000;
  assert.equal(freshness(null, t0, 5), 'belum_ada');
  assert.equal(freshness(t0, t0 + 4 * 60000, 5), 'baru');
  assert.equal(freshness(t0, t0 + 6 * 60000, 5), 'kedaluwarsa');
});

test('CSV: sel berbahaya diberi awalan petik', () => {
  assert.equal(csvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
  assert.equal(csvCell('+1'), '"\'+1"');
  assert.equal(csvCell('-2'), '"\'-2"');
  assert.equal(csvCell('@SUM'), '"\'@SUM"');
  assert.equal(csvCell('aman'), '"aman"');
  assert.equal(toCsv([['a', 'b'], [1, null]]), '"a","b"\r\n"1",""');
});

test('klasifikasi galat lokasi', () => {
  assert.equal(classifyGeoError({ code: 1 }).kind, 'denied');
  assert.equal(classifyGeoError({ code: 2 }).kind, 'unavailable');
});

test('listener scope: clear melepas semua listener sekali saja', () => {
  const sc = createListenerScope(); let n = 0;
  sc.add(() => n++); sc.add(() => n++);
  sc.clear(); sc.clear();
  assert.equal(n, 2); assert.equal(sc.size, 0);
});

test('validasi titik: rentang, field, dan waktu', () => {
  const ctx = { sessionStartMs: 1000_000, nowMs: 2000_000 };
  assert.equal(validatePoint({ seq: 1, lat: 91, lng: 0, acc: 1, t: 1500_000 }, ctx).ok, false);
  assert.equal(validatePoint({ seq: 1, lat: 0, lng: 181, acc: 1, t: 1500_000 }, ctx).ok, false);
  assert.equal(validatePoint({ seq: 1, lat: 0, lng: 0, acc: 1, t: 1500_000, uid: 'x' }, ctx).reason, 'field_tidak_diizinkan');
  assert.equal(validatePoint({ seq: 1, lat: 1, lng: 1, acc: 1, t: 9000_000 }, ctx).reason, 'waktu_masa_depan');
  assert.equal(validatePoint({ seq: 1, lat: 1, lng: 1, acc: 1, t: 1 }, ctx).reason, 'sebelum_sesi');
  assert.equal(validatePoint({ seq: 1.5, lat: 1, lng: 1, acc: 1, t: 1500_000 }, ctx).ok, false);
  const ok = validatePoint({ seq: 1, lat: -3.8, lng: 102.3, acc: 250, t: 1500_000 }, ctx);
  assert.equal(ok.ok, true); assert.deepEqual(ok.quality, ['akurasi_rendah']);
});

test('lompatan tidak wajar hanya ditandai, tidak ditolak', () => {
  const pts = [{ point: { lat: 0, lng: 0, t: 0 }, quality: [] }, { point: { lat: 1, lng: 1, t: 10_000 }, quality: [] }];
  flagJumps(pts, null);
  assert.deepEqual(pts[1].quality, ['lompatan_tidak_wajar']);
});

test('pengaturan: nilai di luar batas diabaikan', () => {
  const s = mergeSettings({ staleMinutes: 0, retentionDays: 30, maxQueue: 'x' });
  assert.equal(s.staleMinutes, 5); assert.equal(s.retentionDays, 30); assert.equal(s.maxQueue, 500);
});

test('transisi laporan', () => {
  assert.ok(canTransitionLaporan('pemilik', 'draf', 'diajukan'));
  assert.ok(canTransitionLaporan('pemeriksa', 'diajukan', 'disetujui'));
  assert.ok(!canTransitionLaporan('pemilik', 'diajukan', 'disetujui'));
  assert.ok(!canTransitionLaporan('pemeriksa', 'disetujui', 'perlu_revisi'));
});
