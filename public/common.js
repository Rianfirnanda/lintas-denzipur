// Utilitas halaman admin (dimuat di dalam iframe shell admin.html).
import { auth, db, F, call, errText, onAuthStateChanged, DZ } from './js/firebase.js';
import { esc, LABEL, fmtTime, ago, tsMs, toCsv, createListenerScope } from './js/dz-core.js';

export { auth, db, F, call, errText, DZ, esc, LABEL, fmtTime, ago, tsMs, toCsv, createListenerScope };
export const $ = (id) => document.getElementById(id);
export const ADMIN_ROLES = ['sysadmin', 'operator', 'pemeriksa', 'pembaca'];

export function toast(m, t = 'ok') {
  const e = $('toast'); if (!e) return;
  e.textContent = m; e.className = 'toast show ' + t; e.setAttribute('role', t === 'err' ? 'alert' : 'status');
  clearTimeout(toast._t); toast._t = setTimeout(() => (e.className = 'toast'), 3500);
}
export const ready = () => window.__ready && window.__ready();

/** Label status dengan teks + ikon bentuk (tidak bergantung warna saja). */
export function chip(group, value, extra = '') {
  const txt = LABEL[group]?.[value] || value || '–';
  const sym = { aktif: '●', active: '●', berjalan: '▶', baru: '●', disetujui: '✔', selesai: '■', pending: '◷', rencana: '◷', diajukan: '↑', draf: '✎', perlu_revisi: '↺', kedaluwarsa: '⚠', belum_ada: '○', blocked: '⛔', dibatalkan: '✕' }[value] || '•';
  return `<span class="chip chip-${esc(group)}-${esc(value)} ${extra}"><span aria-hidden="true">${sym}</span> ${esc(txt)}</span>`;
}

/** Penjaga halaman: hanya akun aktif dengan peran yang diizinkan. */
export function guard(cb, { roles = ADMIN_ROLES } = {}) {
  onAuthStateChanged(auth, async (u) => {
    if (!u) { top.location.href = 'admin.html'; return; }
    try {
      const s = await F.getDoc(F.doc(db, 'akses', u.uid));
      const akses = s.exists() ? s.data() : null;
      if (!akses || akses.status !== 'active' || !ADMIN_ROLES.includes(akses.role)) { top.location.href = 'admin.html'; return; }
      if (!roles.includes(akses.role)) {
        document.body.innerHTML = `<div class="page-header"><h1>Akses dibatasi</h1><p>Peran ${esc(LABEL.role[akses.role])} tidak memiliki akses ke halaman ini.</p></div>`;
        ready(); return;
      }
      await cb({ user: u, uid: u.uid, akses, isSys: akses.role === 'sysadmin', scope: akses.role === 'sysadmin' ? null : (akses.unitScope || []) });
    } catch (e) {
      document.body.insertAdjacentHTML('afterbegin', `<div class="state state-err" role="alert">Gagal memuat akses: ${esc(errText(e))} <button class="btn" onclick="location.reload()">Coba lagi</button></div>`);
      ready();
    }
  });
}

/** Terapkan lingkup unit pada query (sysadmin: semua). Firestore membatasi "in" maksimal 30 nilai. */
export function scoped(q, ctx, field = 'unitId', unitFilter = '') {
  if (unitFilter) return F.query(q, F.where(field, '==', unitFilter));
  if (ctx.scope) return F.query(q, F.where(field, 'in', ctx.scope.length ? ctx.scope.slice(0, 30) : ['__kosong__']));
  return q;
}

let unitCache = null;
export async function loadUnits() {
  if (unitCache) return unitCache;
  const s = await F.getDocs(F.query(F.collection(db, 'unit'), F.orderBy('nama'), F.limit(200)));
  unitCache = s.docs.map((d) => ({ id: d.id, ...d.data() }));
  return unitCache;
}
export async function unitOptions(ctx, { all = true, selected = '' } = {}) {
  const units = (await loadUnits()).filter((u) => !ctx.scope || ctx.scope.includes(u.id));
  return (all ? '<option value="">Semua unit</option>' : '') + units.map((u) => `<option value="${esc(u.id)}" ${u.id === selected ? 'selected' : ''}>${esc(u.nama)}</option>`).join('');
}
export const unitName = async (id) => (await loadUnits()).find((u) => u.id === id)?.nama || id || '–';

/** Komponen state (memuat/kosong/galat) dengan tombol coba lagi. */
export function stateBox(el, kind, text, retry) {
  el.innerHTML = `<div class="state state-${kind}" ${kind === 'err' ? 'role="alert"' : 'role="status"'}>${kind === 'loading' ? '<span class="spin" aria-hidden="true"></span>' : ''}${esc(text)}${retry ? ' <button class="btn" data-retry>Coba lagi</button>' : ''}</div>`;
  if (retry) el.querySelector('[data-retry]').onclick = retry;
}

export function downloadCsv(name, rows) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + toCsv(rows)], { type: 'text/csv;charset=utf-8' }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
