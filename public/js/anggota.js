// Aplikasi anggota: tracking berbasis sesi + laporan kegiatan.
import { auth, db, F, dz, errText, onAuthStateChanged, signOut, DZ } from './firebase.js';
import { GoogleAuthProvider, signInWithPopup, signInWithEmailAndPassword, createUserWithEmailAndPassword } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import { TrackingQueue, classifyGeoError, fmtTime, ago, tsMs, esc, LABEL, createListenerScope, mergeSettings, MAX_BATCH, MIN_INGEST_GAP_MS } from './dz-core.js';

const $ = (id) => document.getElementById(id);
const show = (id, on = true) => { $(id).hidden = !on; };
function toast(m, t = 'ok') { const e = $('toast'); e.textContent = m; e.className = 'toast show ' + t; clearTimeout(toast._t); toast._t = setTimeout(() => (e.className = 'toast'), 3500); }

let cfg = mergeSettings({});
let me = null;            // { uid, email, akses }
let kegiatan = [];        // kegiatan yang ditugaskan
const subs = createListenerScope();

// ID perangkat stabil per browser (bukan data identitas; hanya untuk mencegah sesi ganda).
const deviceId = (() => {
  let d = null; try { d = localStorage.getItem('dz-device-id'); } catch { /* storage diblokir */ }
  if (!d || !/^[A-Za-z0-9_-]{6,64}$/.test(d)) { d = 'web-' + crypto.randomUUID().replace(/-/g, ''); try { localStorage.setItem('dz-device-id', d); } catch { /* abaikan */ } }
  return d;
})();
const safeStorage = (() => { try { localStorage.setItem('_t', '1'); localStorage.removeItem('_t'); return localStorage; } catch { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) }; } })();

/* ═════════ Status tracking ═════════ */
const T = {
  session: null,          // { sessionId, kegiatanId, kegiatanJudul }
  queue: null,
  watchId: null,
  lastCaptureMs: 0,
  lastFix: null,          // { lat, lng, acc, t }
  lastSyncMs: null,
  syncState: 'idle',      // idle | sending | ok | offline | error | backoff
  flushTimer: null,
  backoffMs: 0,
  releaseLock: null,
  wakeLock: null,
  sesiUnsub: null,
  stopping: false,
};

function setBanner() {
  const b = $('trackBanner');
  const on = !!T.session && T.watchId != null;
  b.classList.toggle('on', !!T.session);
  b.classList.toggle('warn', !!T.session && !on);
  $('bannerTxt').textContent = !T.session ? '' : on
    ? `TRACKING AKTIF — ${T.session.kegiatanJudul || 'kegiatan'}`
    : `SESI TRACKING AKTIF — pengambilan lokasi tidak berjalan di halaman ini`;
  document.title = (T.session ? (on ? '● ' : '◌ ') : '') + 'Lintas Denzipur — Anggota';
}

function render() {
  setBanner();
  const s = T.session;
  $('vSesi').innerHTML = s ? `<span class="chip chip-sesi-aktif">● Sesi aktif</span> ${esc(s.kegiatanJudul || '')}` : 'Tidak ada sesi';
  $('vLok').textContent = T.lastFix ? `${fmtTime(T.lastFix.t, { seconds: true })} (${ago(T.lastFix.t)}, akurasi ±${Math.round(T.lastFix.acc)} m)` : (s ? 'Belum ada titik lokasi' : '–');
  const q = T.queue?.size || 0;
  const syncTxt = {
    idle: s ? 'Menunggu titik pertama' : '–',
    sending: `Mengirim ${q} titik…`,
    ok: q ? `${q} titik menunggu dikirim` : `Tersinkron${T.lastSyncMs ? ' · ' + ago(T.lastSyncMs) : ''}`,
    offline: `Offline — ${q} titik disimpan di perangkat, akan dikirim saat koneksi pulih`,
    error: `Gagal mengirim — ${q} titik menunggu, mencoba lagi otomatis`,
    backoff: `${q} titik menunggu (menunggu jeda pengiriman)`,
  }[T.syncState];
  $('vSync').textContent = syncTxt + (T.queue?.dropped ? ` · ${T.queue.dropped} titik terlama dibuang karena antrean penuh` : '');
  show('startBtn', !s && !T.lockedElsewhere);
  show('stopBtn', !!s);
  show('resumeBtn', !!s && T.watchId == null && !T.lockedElsewhere);
  $('kgSel').disabled = !!s;
  if (s && [...$('kgSel').options].some((o) => o.value === s.kegiatanId)) $('kgSel').value = s.kegiatanId;
}
setInterval(() => { if (T.session) render(); }, 5000);

function setErr(text) { $('trackErr').textContent = text || ''; show('trackErr', !!text); }
function setInfo(text) { $('trackInfo').textContent = text || ''; show('trackInfo', !!text); }

/* ── Izin & GPS ── */
async function permState() {
  try { const p = await navigator.permissions.query({ name: 'geolocation' }); return p; } catch { return null; }
}
async function refreshPerm() {
  if (!('geolocation' in navigator)) { $('vPerm').textContent = 'Perangkat/browser tidak mendukung lokasi'; return 'unsupported'; }
  const p = await permState();
  const st = p?.state || 'unknown';
  $('vPerm').textContent = { granted: 'Diizinkan', denied: 'Ditolak — aktifkan di pengaturan situs browser', prompt: 'Akan diminta saat tracking dimulai', unknown: 'Akan diminta saat tracking dimulai' }[st];
  if (p && !p._dz) { p._dz = 1; p.onchange = () => { refreshPerm(); if (p.state === 'denied' && T.watchId != null) onGeoError({ code: 1 }); }; }
  return st;
}

function startWatch() {
  stopWatch();
  T.watchId = navigator.geolocation.watchPosition(onFix, onGeoError, { enableHighAccuracy: true, maximumAge: 10000, timeout: 30000 });
  setErr(''); if (!T.lockedElsewhere) setInfo(''); render();
}
function stopWatch() { if (T.watchId != null) navigator.geolocation.clearWatch(T.watchId); T.watchId = null; setBanner(); }
// watchPosition sering tidak memanggil callback saat perangkat diam; minta posisi berkala sebagai cadangan.
setInterval(() => {
  if (T.watchId == null || !T.session || document.visibilityState !== 'visible') return;
  if (Date.now() - T.lastCaptureMs < cfg.captureIntervalSec * 2000) return;
  navigator.geolocation.getCurrentPosition(onFix, (e) => { if (e.code === 1) onGeoError(e); }, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
}, 5000);

function onFix(pos) {
  $('vPerm').textContent = 'Diizinkan';
  setErr('');
  const t = Math.round(pos.timestamp || Date.now());
  if (t - T.lastCaptureMs < cfg.captureIntervalSec * 1000) return; // hemat baterai & biaya
  T.lastCaptureMs = t;
  const fix = { lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy ?? 9999, t };
  T.lastFix = fix;
  T.queue.push(fix);
  render();
  if (T.queue.size === 1 && T.syncState !== 'backoff') scheduleFlush(500);
}
function onGeoError(err) {
  const g = classifyGeoError(err);
  setErr(g.text);
  if (g.kind === 'denied') { stopWatch(); show('retryBtn', true); $('vPerm').textContent = 'Ditolak/dicabut'; }
  render();
}

/* ── Pengiriman antrean ── */
function scheduleFlush(ms) {
  clearTimeout(T.flushTimer);
  T.flushTimer = setTimeout(flush, ms);
}
async function flush() {
  clearTimeout(T.flushTimer);
  if (!T.session || !T.queue || T.sending) return;
  const next = () => scheduleFlush(Math.max(cfg.sendIntervalSec * 1000, T.backoffMs));
  if (!T.queue.size) { if (T.syncState !== 'idle') T.syncState = 'ok'; render(); return next(); }
  if (!navigator.onLine) { T.syncState = 'offline'; render(); return next(); }
  T.syncState = 'sending'; T.sending = true; render();
  try {
    const r = await dz.ingest(T.state, T.queue.peek(MAX_BATCH));
    T.queue.ack(r.acked);
    T.state.lastSeq = r.lastSeq; T.state.lastCapturedAtMs = r.lastCapturedAtMs; if (r.prevFix) T.state.prevFix = r.prevFix;
    T.lastSyncMs = Date.now(); T.syncState = 'ok'; T.backoffMs = 0;
    try { sessionStorage.removeItem('dz-reload-diagnosa'); } catch { /* abaikan */ }
    render();
    // Masih ada antrean (mis. setelah offline lama) → kirim batch berikutnya setelah jeda minimum.
    if (T.queue.size) { T.sending = false; return scheduleFlush(MIN_INGEST_GAP_MS + 1500); }
  } catch (e) {
    const k = e.code;
    T.sending = false;
    if (k === 'session_closed') return endLocal(`Sesi telah ditutup${e.details?.endedReason ? ' (' + (LABEL.endedReason[e.details.endedReason] || e.details.endedReason) + ')' : ''}. Titik baru tidak dikirim.`);
    if (k === 'other_device') return endLocal('Sesi ini sedang berjalan di perangkat lain. Tracking di perangkat ini dihentikan.');
    if (k === 'account_inactive') { endLocal('Akun Anda tidak aktif atau akses dicabut. Tracking dihentikan.'); setTimeout(() => location.reload(), 3000); return; }
    if (k === 'rejected') {
      // Ditolak tanpa sebab yang dapat dipastikan (mis. status akses berubah tetapi koneksi pantau belum
      // menerimanya). Muat ulang sekali dengan koneksi baru; antrean tetap tersimpan di perangkat.
      let reloaded = false;
      try { reloaded = sessionStorage.getItem('dz-reload-diagnosa') === T.state.sessionId; } catch { /* abaikan */ }
      if (!reloaded) {
        try { sessionStorage.setItem('dz-reload-diagnosa', T.state.sessionId); } catch { /* abaikan */ }
        stopWatch(); releaseTabLock(); location.reload(); return;
      }
      try { sessionStorage.removeItem('dz-reload-diagnosa'); } catch { /* abaikan */ }
      T.queue.ack(T.queue.peek(MAX_BATCH).map((p) => p.seq)); T.syncState = 'error';
      if (Number.isInteger(e.details?.lastSeq)) T.state.lastSeq = e.details.lastSeq;
    }
    else if (k === 'backoff') { T.backoffMs = Math.max(5000, e.details?.retryAfterMs || 5000); T.syncState = 'backoff'; }
    else if (/resource-exhausted/.test(String(k))) { T.backoffMs = 600000; T.syncState = 'error'; setErr('Kuota harian database tercapai. Titik disimpan di perangkat dan dikirim ulang nanti.'); }
    else { T.backoffMs = Math.min(300000, Math.max(10000, T.backoffMs * 2)); T.syncState = navigator.onLine ? 'error' : 'offline'; }
    render();
  }
  T.sending = false;
  next();
}
addEventListener('online', () => { if (T.session) { T.backoffMs = 0; scheduleFlush(300); } });
addEventListener('offline', () => { if (T.session) { T.syncState = 'offline'; render(); } });

/* ── Kunci antar-tab (satu tab pengambil lokasi per perangkat) ── */
function acquireTabLock(onGranted) {
  if (!navigator.locks || T.releaseLock) { onGranted(); return; } // tab ini sudah memegang kunci
  if (T.lockPending) { T.onLockGranted = onGranted; return; }      // sudah menunggu; ganti aksi saat kunci didapat
  const name = 'dz-tracking-' + me.uid;
  navigator.locks.request(name, { ifAvailable: true }, (lock) => {
    if (!lock) {
      T.lockedElsewhere = true;
      setInfo('Tracking sedang berjalan di tab lain pada perangkat ini. Tab ini akan mengambil alih otomatis jika tab tersebut ditutup.');
      render();
      T.lockPending = true; T.onLockGranted = onGranted;
      navigator.locks.request(name, () => new Promise((res) => { T.lockPending = false; T.lockedElsewhere = false; T.releaseLock = res; setInfo(''); T.onLockGranted(); }));
      return;
    }
    return new Promise((res) => { T.releaseLock = res; onGranted(); });
  });
}
function releaseTabLock() { if (T.releaseLock) { T.releaseLock(); T.releaseLock = null; } }

/* ── Wake lock opsional ── */
async function applyWake() {
  try {
    if ($('wakeChk').checked && T.watchId != null && 'wakeLock' in navigator && document.visibilityState === 'visible') {
      if (!T.wakeLock) { T.wakeLock = await navigator.wakeLock.request('screen'); T.wakeLock.addEventListener('release', () => { T.wakeLock = null; }); }
    } else if (T.wakeLock) { await T.wakeLock.release(); T.wakeLock = null; }
  } catch { $('wakeChk').checked = false; toast('Browser tidak mengizinkan menjaga layar tetap menyala.', 'err'); }
}
$('wakeChk').onchange = applyWake;
document.addEventListener('visibilitychange', () => {
  if (!T.session) return;
  if (document.visibilityState === 'hidden') setInfo('Halaman berada di latar belakang — browser dapat menghentikan pengambilan lokasi sampai halaman dibuka kembali.');
  else { setInfo(T.lockedElsewhere ? $('trackInfo').textContent : ''); applyWake(); scheduleFlush(300); }
});

/* ── Sesi ── */
function attachSession(s) {
  T.session = s;
  T.state = { sessionId: s.sessionId, deviceId, sessionStartMs: s.mulaiAtMs ?? null, lastSeq: s.lastSeq ?? -1, lastCapturedAtMs: s.lastCapturedAtMs ?? null, prevFix: null };
  T.queue = new TrackingQueue({ storage: safeStorage, sessionId: s.sessionId, maxSize: cfg.maxQueue, key: 'dz-queue-' + me.uid });
  if (Number.isInteger(s.lastSeq)) T.queue.ensureSeqAfter(s.lastSeq);
  // Pantau sesi di server: ditutup operator/sistem → hentikan.
  T.sesiUnsub?.();
  T.sesiUnsub = F.onSnapshot(F.doc(db, 'sesi', s.sessionId), (snap) => {
    const d = snap.data();
    if (d && T.state && Number.isInteger(d.lastSeq) && d.lastSeq > T.state.lastSeq) { T.state.lastSeq = d.lastSeq; T.state.lastCapturedAtMs = d.lastCapturedAt?.toMillis?.() ?? T.state.lastCapturedAtMs; }
    if (d && d.status !== 'aktif' && !T.stopping) endLocal(`Sesi diakhiri (${LABEL.endedReason[d.endedReason] || d.endedReason || 'server'}).`);
  }, () => { /* izin dicabut → ditangani saat kirim berikutnya */ });
  scheduleFlush(500);
  render();
}
function endLocal(msg) {
  stopWatch(); releaseTabLock();
  clearTimeout(T.flushTimer);
  T.sesiUnsub?.(); T.sesiUnsub = null;
  T.queue?.clear(); // sesi ditutup: titik tersisa tidak dapat diterima server
  T.session = null; T.queue = null; T.state = null; T.sending = false; T.lastFix = null; T.syncState = 'idle'; T.stopping = false;
  if (T.wakeLock) T.wakeLock.release().catch(() => {});
  setInfo(''); show('retryBtn', false); show('otherBtn', false);
  if (msg) setErr(msg);
  render();
}

async function requestLocationOnce(maximumAge = 0) {
  return new Promise((res, rej) => navigator.geolocation.getCurrentPosition(res, rej, { enableHighAccuracy: true, timeout: 20000, maximumAge }));
}

$('startBtn').onclick = async () => {
  const kegiatanId = $('kgSel').value;
  if (!kegiatanId) return setErr('Pilih kegiatan terlebih dahulu.');
  if (!('geolocation' in navigator)) return setErr('Browser ini tidak mendukung lokasi.');
  setErr(''); $('startBtn').disabled = true;
  try {
    // Minta izin lokasi setelah tindakan pengguna, sebelum sesi dibuat.
    $('vPerm').textContent = 'Meminta izin…';
    try { const p = await requestLocationOnce(); onFix.first = p; } catch (ge) { onGeoError(ge); if (ge.code === 1) return; }
    const r = await dz.startSession({ uid: me.uid, kegiatanId, deviceId });
    const k = kegiatan.find((x) => x.id === kegiatanId);
    acquireTabLock(() => {
      attachSession({ sessionId: r.sessionId, kegiatanId, kegiatanJudul: k?.judul || '', lastSeq: r.lastSeq, mulaiAtMs: r.mulaiAtMs, lastCapturedAtMs: r.lastCapturedAtMs });
      startWatch();
      if (onFix.first) { onFix(onFix.first); onFix.first = null; }
      applyWake();
      toast(r.resumed ? 'Sesi tracking dilanjutkan.' : 'Tracking dimulai.');
    });
  } catch (e) {
    if (e.code === 'already-exists') {
      const d = e.details || {};
      setErr(d.perangkatLain ? 'Masih ada sesi tracking aktif di perangkat/browser lain. Akhiri sesi tersebut untuk memulai di sini.' : 'Masih ada sesi tracking aktif untuk kegiatan lain. Akhiri sesi tersebut terlebih dahulu.');
      T.otherSessionId = d.sessionId; show('otherBtn', true);
    } else setErr(errText(e));
  } finally { $('startBtn').disabled = false; render(); }
};

$('resumeBtn').onclick = async () => {
  try { const p = await requestLocationOnce(); acquireTabLock(() => { startWatch(); onFix(p); applyWake(); }); }
  catch (ge) { onGeoError(ge); }
};
$('retryBtn').onclick = async () => {
  show('retryBtn', false);
  if (!T.session) return $('startBtn').click();
  $('resumeBtn').click();
};
$('otherBtn').onclick = async () => {
  if (!T.otherSessionId || !confirm('Akhiri sesi tracking yang masih aktif (di perangkat/tab lain)?')) return;
  try { await dz.endSession({ sessionId: T.otherSessionId, reason: 'pindah_perangkat', actorUid: me.uid }); show('otherBtn', false); setErr(''); toast('Sesi lama diakhiri. Silakan mulai tracking.'); }
  catch (e) { setErr(errText(e)); }
};

async function endSession(reason) {
  if (!T.session) return true;
  T.stopping = true;
  // Kirim sisa antrean dulu (maksimal beberapa kali percobaan).
  for (let i = 0; i < 3 && T.queue?.size && navigator.onLine; i++) { await flush(); if (T.queue?.size) await new Promise((r) => setTimeout(r, 4600)); }
  const left = T.queue?.size || 0;
  if (left && !confirm(`${left} titik lokasi belum terkirim (koneksi bermasalah). Jika sesi diakhiri sekarang, titik tersebut tidak akan tersimpan. Tetap akhiri?`)) { T.stopping = false; return false; }
  if (!navigator.onLine) { T.stopping = false; setErr('Tidak ada koneksi. Sesi dapat diakhiri setelah koneksi tersedia.'); return false; }
  try { await dz.endSession({ sessionId: T.session.sessionId, reason, actorUid: me.uid }); }
  catch (e) { if (e.code !== 'permission-denied' && e.code !== 'not-found') { T.stopping = false; setErr('Gagal mengakhiri sesi: ' + errText(e)); return false; } }
  endLocal('');
  toast('Tracking diakhiri.');
  return true;
}
$('stopBtn').onclick = async () => { if (confirm('Akhiri sesi tracking?')) { $('stopBtn').disabled = true; await endSession('selesai_oleh_anggota'); $('stopBtn').disabled = false; } };

$('logoutBtn').onclick = async () => {
  if (T.session && !confirm('Sesi tracking masih aktif dan akan diakhiri saat keluar. Lanjutkan?')) return;
  if (T.session && !(await endSession('keluar_aplikasi'))) return;
  subs.clear();
  await signOut(auth);
};
addEventListener('beforeunload', (e) => { if (T.session && T.watchId != null) { e.preventDefault(); e.returnValue = ''; } });

/* ═════════ Data anggota ═════════ */
async function loadSettings() {
  try { const s = await F.getDoc(F.doc(db, 'pengaturan', 'umum')); cfg = mergeSettings(s.exists() ? s.data() : {}); } catch { cfg = mergeSettings({}); }
  $('vMaxQ').textContent = cfg.maxQueue;
}

function listenKegiatan() {
  subs.add(F.onSnapshot(F.query(F.collection(db, 'kegiatan'), F.where('pesertaUids', 'array-contains', me.uid), F.orderBy('jadwalMulai', 'desc'), F.limit(30)), (snap) => {
    kegiatan = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const cur = $('kgSel').value || T.session?.kegiatanId;
    const aktif = kegiatan.filter((k) => ['rencana', 'berjalan'].includes(k.status) && k.trackingDiizinkan !== false);
    $('kgSel').innerHTML = aktif.length
      ? '<option value="">— pilih kegiatan —</option>' + aktif.map((k) => `<option value="${esc(k.id)}">${esc(k.judul)} · ${fmtTime(tsMs(k.jadwalMulai))}</option>`).join('')
      : '<option value="">Tidak ada kegiatan aktif yang ditugaskan</option>';
    if (aktif.some((k) => k.id === cur)) $('kgSel').value = cur;
    showKgInfo();
  }, (e) => setErr('Gagal memuat kegiatan: ' + errText(e))));
}
function showKgInfo() {
  const k = kegiatan.find((x) => x.id === $('kgSel').value);
  $('kgInfo').innerHTML = k ? `${esc(LABEL.kegiatan[k.status])} · ${fmtTime(tsMs(k.jadwalMulai))}${k.lokasiNama ? ' · ' + esc(k.lokasiNama) : ''}${k.deskripsi ? '<br>' + esc(k.deskripsi) : ''}` : '';
}
$('kgSel').onchange = showKgInfo;

async function checkExistingSession() {
  try {
    const lock = await F.getDoc(F.doc(db, 'sesi_aktif', me.uid));
    if (!lock.exists()) return;
    const l = lock.data();
    const s = await F.getDoc(F.doc(db, 'sesi', l.sessionId));
    if (!s.exists() || s.data().status !== 'aktif') return;
    if (l.deviceId !== deviceId) {
      T.otherSessionId = l.sessionId; show('otherBtn', true);
      setInfo(`Ada sesi tracking aktif di perangkat lain (${s.data().kegiatanJudul || ''}).`);
      return;
    }
    acquireTabLock(() => {
      attachSession({ sessionId: l.sessionId, kegiatanId: l.kegiatanId, kegiatanJudul: s.data().kegiatanJudul, lastSeq: s.data().lastSeq, mulaiAtMs: s.data().mulaiAt?.toMillis?.() ?? null, lastCapturedAtMs: s.data().lastCapturedAt?.toMillis?.() ?? null });
      if (!T.lockedElsewhere) setInfo('Sesi tracking sebelumnya masih aktif. Tekan "Lanjutkan Tracking" untuk melanjutkan pengambilan lokasi.');
      render();
    });
  } catch (e) { console.warn(e); }
}

/* ── Laporan ── */
let laporan = [];
function listenLaporan() {
  subs.add(F.onSnapshot(F.query(F.collection(db, 'laporan'), F.where('uid', '==', me.uid), F.orderBy('createdAt', 'desc'), F.limit(30)), (snap) => {
    laporan = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    $('lapList').innerHTML = laporan.map((r) => `<div class="lap">
      <div><b>${esc(r.judul)}</b><br><small class="muted">${esc(r.kegiatanJudul || '')} · ${fmtTime(tsMs(r.createdAt))}</small>
        ${r.status === 'perlu_revisi' && r.catatanRevisi ? `<div class="alert" style="margin-top:6px">Catatan pemeriksa: ${esc(r.catatanRevisi)}</div>` : ''}</div>
      <div class="acts" style="flex-direction:column;align-items:flex-end"><span class="chip chip-laporan-${esc(r.status)}">${esc(LABEL.laporan[r.status])}</span>
        ${['draf', 'perlu_revisi'].includes(r.status) ? `<button class="btn" data-edit="${esc(r.id)}">Ubah</button>` : `<button class="btn" data-view="${esc(r.id)}">Lihat</button>`}</div></div>`).join('')
      || '<div class="empty">Belum ada laporan.</div>';
  }, (e) => { $('lapList').innerHTML = `<div class="state state-err">Gagal memuat laporan: ${esc(errText(e))}</div>`; }));
}

let editing = null, lapLok = null;
function openLap(r = null, readOnly = false) {
  editing = r; lapLok = r?.lokasi || null;
  const f = $('lapForm');
  f.reset();
  const opts = kegiatan.filter((k) => r ? k.id === r.kegiatanId : ['rencana', 'berjalan', 'selesai'].includes(k.status));
  f.kegiatanId.innerHTML = (r ? '' : '<option value="">— pilih kegiatan —</option>') + (opts.length ? opts : r ? [{ id: r.kegiatanId, judul: r.kegiatanJudul }] : []).map((k) => `<option value="${esc(k.id)}">${esc(k.judul)}</option>`).join('');
  f.kegiatanId.disabled = !!r;
  f.judul.value = r?.judul || ''; f.isi.value = r?.isi || '';
  f.pakaiLokasi.checked = !!lapLok;
  $('lapLokInfo').textContent = lapLok ? `Lokasi laporan: ±${Math.round(lapLok.acc)} m · ${fmtTime(lapLok.capturedAtMs)}` : '';
  $('lapRevisi').textContent = r?.catatanRevisi ? 'Catatan pemeriksa: ' + r.catatanRevisi : ''; show('lapRevisi', !!r?.catatanRevisi);
  [...f.elements].forEach((el) => { if (el.value !== 'cancel') el.disabled = readOnly || (el.name === 'kegiatanId' && !!r); });
  show('lapSaveDraf', !readOnly && (!r || r.status === 'draf')); show('lapSubmit', !readOnly);
  $('lapDlgTitle').textContent = readOnly ? 'Laporan' : r ? 'Ubah Laporan' : 'Laporan Baru';
  show('lapErr', false);
  $('lapThumbs').innerHTML = '';
  showFotos(r);
  $('lapDlg').showModal();
}
/** Tampilkan foto dokumentasi (dibaca dari Firestore sesuai hak akses laporan). */
async function showFotos(r) {
  for (const fid of r?.fotoIds || []) {
    try {
      const s = await F.getDoc(F.doc(db, 'laporan', r.id, 'foto', fid));
      const d = s.data();
      if (!d || !/^data:image\/(jpeg|webp);base64,/.test(d.data)) continue; // hanya gambar raster yang aman
      const img = new Image(); img.alt = 'foto dokumentasi'; img.src = d.data; $('lapThumbs').appendChild(img);
    } catch { /* tidak berwenang */ }
  }
}
/** Kompres foto di perangkat (maks. 1280 px, JPEG) agar muat di dokumen Firestore (< 1 MB). */
async function compressImage(file) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  for (const [max, q] of [[1280, 0.72], [1024, 0.6], [800, 0.5], [640, 0.45]]) {
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale)), h = Math.max(1, Math.round(bmp.height * scale));
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    cv.getContext('2d').drawImage(bmp, 0, 0, w, h);
    const data = cv.toDataURL('image/jpeg', q);
    if (data.length < 900000) { bmp.close?.(); return { data, mime: 'image/jpeg', w, h }; }
  }
  throw new Error(`${file.name}: foto terlalu besar setelah dikompres.`);
}
$('newLapBtn').onclick = () => openLap();
$('lapList').onclick = (e) => {
  const b = e.target.closest('button[data-edit],button[data-view]'); if (!b) return;
  const r = laporan.find((x) => x.id === (b.dataset.edit || b.dataset.view));
  openLap(r, !!b.dataset.view);
};
$('lapForm').pakaiLokasi.onchange = async (e) => {
  if (!e.target.checked) { lapLok = null; $('lapLokInfo').textContent = ''; return; }
  $('lapLokInfo').textContent = 'Mengambil lokasi…';
  try {
    const p = await requestLocationOnce(60000); // lokasi laporan: posisi < 60 detik masih relevan
    lapLok = { lat: p.coords.latitude, lng: p.coords.longitude, acc: Math.round(p.coords.accuracy * 10) / 10, capturedAtMs: Math.round(p.timestamp) };
    $('lapLokInfo').textContent = `Lokasi laporan: ±${Math.round(lapLok.acc)} m · ${fmtTime(lapLok.capturedAtMs)}`;
  } catch (ge) { e.target.checked = false; lapLok = null; $('lapLokInfo').textContent = classifyGeoError(ge).text; }
};
$('lapForm').addEventListener('submit', async (e) => {
  const action = e.submitter?.value;
  if (action === 'cancel' || !action) return;
  e.preventDefault();
  const f = e.target;
  const err = (t) => { $('lapErr').textContent = t; show('lapErr', true); };
  const kId = editing?.kegiatanId || f.kegiatanId.value;
  const k = kegiatan.find((x) => x.id === kId);
  if (!kId || (!k && !editing)) return err('Pilih kegiatan.');
  if (f.judul.value.trim().length < 3) return err('Judul minimal 3 karakter.');
  const files = [...f.foto.files];
  const existing = editing?.fotoIds || [];
  if (existing.length + files.length > 10) return err('Maksimal 10 foto per laporan.');
  for (const fl of files) { if (fl.size > 25 * 1024 * 1024) return err(`${fl.name} melebihi 25 MB.`); if (!/^image\//.test(fl.type)) return err(`${fl.name}: bukan file gambar.`); }
  [...f.elements].forEach((el) => (el.disabled = true));
  try {
    const ref = editing ? F.doc(db, 'laporan', editing.id) : F.doc(F.collection(db, 'laporan'));
    const unitId = editing?.unitId || k.unitId;
    $('lapErr').textContent = files.length ? 'Mengompres foto…' : ''; show('lapErr', !!files.length);
    const fotos = [];
    for (const fl of files) fotos.push({ id: 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), ...(await compressImage(fl)) });
    const now = F.serverTimestamp();
    const content = { judul: f.judul.value.trim(), isi: f.isi.value.trim(), lokasi: lapLok, fotoIds: [...existing, ...fotos.map((x) => x.id)], updatedAt: now };
    if (action === 'diajukan') Object.assign(content, { status: 'diajukan', diajukanAt: now });
    // Laporan + foto ditulis atomik dalam satu batch (Rules memeriksa daftar fotoIds).
    const b = F.writeBatch(db);
    if (editing) b.update(ref, content);
    else b.set(ref, {
      uid: me.uid, unitId, kegiatanId: kId, kegiatanJudul: k.judul, status: 'draf', pemeriksaUid: null, diperiksaAt: null,
      catatanRevisi: null, createdAt: now, diajukanAt: null, ...content,
    });
    for (const x of fotos) b.set(F.doc(ref, 'foto', x.id), { data: x.data, mime: x.mime, w: x.w, h: x.h, uid: me.uid, createdAt: now });
    if (action === 'diajukan' && unitId === me.akses.unitId) {
      b.set(F.doc(F.collection(db, 'aktivitas')), { jenis: 'laporan_diajukan', actorUid: me.uid, unitId, ringkasan: `Laporan "${content.judul}" diajukan`, at: now });
    }
    await b.commit();
    $('lapDlg').close();
    toast(action === 'diajukan' ? 'Laporan diajukan untuk diperiksa.' : 'Draf disimpan.');
  } catch (x) { err('Gagal menyimpan: ' + errText(x)); }
  finally { [...f.elements].forEach((el) => (el.disabled = false)); if (editing) f.kegiatanId.disabled = true; }
});

/* ── Tab ── */
document.querySelectorAll('.tab').forEach((t) => (t.onclick = () => {
  document.querySelectorAll('.tab').forEach((x) => x.setAttribute('aria-selected', String(x === t)));
  ['tTrack', 'tLap'].forEach((id) => show(id, id === t.dataset.tab));
}));

/* ═════════ Autentikasi ═════════ */
$('googleBtn').onclick = async () => {
  try { const p = new GoogleAuthProvider(); p.setCustomParameters({ prompt: 'select_account' }); await signInWithPopup(auth, p); }
  catch (e) { $('loginMsg').textContent = e.code === 'auth/popup-blocked' ? 'Popup diblokir browser. Izinkan popup lalu coba lagi.' : 'Login gagal: ' + (e.code || e.message); show('loginMsg', true); }
};
if (DZ.emulator) {
  show('devLogin', true);
  $('devLogin').onsubmit = async (e) => {
    e.preventDefault();
    const em = e.target.email.value.trim(), pw = e.target.pw.value;
    try { await signInWithEmailAndPassword(auth, em, pw); } catch { await createUserWithEmailAndPassword(auth, em, pw).catch((x) => { $('loginMsg').textContent = x.code; show('loginMsg', true); }); }
  };
}

function screen(which) { ['boot', 'loginBox', 'blockedBox', 'appBox'].forEach((id) => show(id, id === which)); }

onAuthStateChanged(auth, async (u) => {
  subs.clear();
  if (!u) { if (T.session) endLocal(''); me = null; screen('loginBox'); show('logoutBtn', false); $('who').textContent = 'Aplikasi Anggota'; return; }
  screen('boot');
  try {
    const a = await dz.register(u);
    me = { uid: u.uid, email: u.email, akses: a };
    show('logoutBtn', true);
    $('who').textContent = u.email;
    if (a.status !== 'active') {
      $('blockedTitle').textContent = a.status === 'blocked' ? 'Akun diblokir' : 'Menunggu persetujuan';
      $('blockedTxt').textContent = a.status === 'blocked' ? 'Akun Anda diblokir. Hubungi administrator.' : 'Akun Anda sudah terdaftar dan menunggu aktivasi oleh administrator. Halaman ini akan diperbarui otomatis.';
      screen('blockedBox');
    } else {
      screen('appBox');
      await loadSettings();
      listenKegiatan(); listenLaporan();
      await refreshPerm();
      await checkExistingSession();
      render();
    }
    // Perubahan akses (aktivasi/blokir) berlaku langsung.
    subs.add(F.onSnapshot(F.doc(db, 'akses', u.uid), (s) => {
      const st = s.data()?.status;
      if (st && st !== a.status) {
        if (st !== 'active' && T.session) endLocal('Akun Anda tidak lagi aktif. Tracking dihentikan.');
        location.reload();
      }
    }, () => {}));
  } catch (e) {
    screen('loginBox');
    $('loginMsg').textContent = 'Gagal memproses akun: ' + errText(e); show('loginMsg', true);
  }
});
