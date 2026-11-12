import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js';
import * as F from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js';

const firebaseConfig = {
  apiKey: "AIzaSyAlVfejf312G-tIleA8izbxn98bDGe1MvM",
  authDomain: "lintas-benteng.firebaseapp.com",
  databaseURL: "https://lintas-benteng-default-rtdb.firebaseio.com",
  projectId: "lintas-benteng",
  storageBucket: "lintas-benteng.firebasestorage.app",
  messagingSenderId: "1005929757785",
  appId: "1:1005929757785:web:65b6d25b390677a98f0548",
  measurementId: "G-647RZ20J14"
};

export { F };
export const OWNER_EMAILS = ['sutannadhif@gmail.com'];
export const COLLECTION = 'lintas';
export const auth = getAuth(initializeApp(firebaseConfig));
export const db = F.getFirestore(auth.app);
export const $ = (id) => document.getElementById(id);
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const fmt = (ts) => {
  if (!ts) return '-';
  const d = ts.seconds ? new Date(ts.seconds * 1000) : new Date(ts);
  return d.toLocaleString('id-ID', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' });
};
export function toast(m, t = 'ok') {
  const e = $('toast'); e.textContent = m; e.className = 'toast show ' + t;
  clearTimeout(toast._t); toast._t = setTimeout(() => e.className = 'toast', 2800);
}

export function guard(cb) {
  onAuthStateChanged(auth, async (u) => {
    if (!u) { top.location.href = 'admin.html'; return; }
    if (!OWNER_EMAILS.includes(u.email)) {
      const s = await F.getDoc(F.doc(db, COLLECTION, u.uid));
      const d = s.exists() ? s.data() : null;
      if (!d || d.role !== 'admin' || d.status !== 'active') { top.location.href = 'admin.html'; return; }
    }
    cb(u);
  });
}

export const listen = (col, cb) => F.onSnapshot(F.collection(db, col),
  (s) => { cb(s.docs.map(d => ({ id: d.id, ...d.data() }))); window.__ready && window.__ready(); },
  (e) => { toast('Gagal memuat: ' + (e.code || e.message), 'err'); window.__ready && window.__ready(); });

const byNew = (a, b) => (b.createdAt?.seconds ?? 9e12) - (a.createdAt?.seconds ?? 9e12);

/* Halaman CRUD generik: tambah, edit, hapus */
export function crud({ col, title, desc, fields, cols }) {
  guard((me) => {
    let rows = [], editId = null;
    const lbl = (k) => fields.find(f => f.k === k)?.label || k;
    const input = (f) => f.type === 'select'
      ? `<select name="${f.k}">${f.opts.map(o => `<option>${esc(o)}</option>`).join('')}</select>`
      : f.type === 'textarea' ? `<textarea name="${f.k}" rows="2"></textarea>`
      : `<input name="${f.k}" type="${f.type || 'text'}" ${f.req ? 'required' : ''}>`;

    $('root').innerHTML = `
      <div class="page-header"><h1>${title}</h1><p>${desc}</p></div>
      <div class="panel"><form id="f" class="form">
        ${fields.map(f => `<label>${f.label}${input(f)}</label>`).join('')}
        <div class="acts"><button class="btn ok" type="submit">Simpan</button><button class="btn" type="button" id="cl" hidden>Batal</button></div>
      </form></div>
      <div class="panel"><div class="table-wrap"><table>
        <thead><tr>${cols.map(k => `<th>${lbl(k)}</th>`).join('')}<th>Aksi</th></tr></thead>
        <tbody id="rows"></tbody></table></div></div>`;

    const f = $('f');
    const reset = () => { f.reset(); editId = null; $('cl').hidden = true; };
    const draw = () => {
      $('rows').innerHTML = rows.map(r => `<tr>${cols.map(k => {
        const v = r[k], isUrl = fields.find(x => x.k === k)?.type === 'url';
        return `<td>${isUrl && /^https?:\/\//.test(v || '') ? `<a href="${esc(v)}" target="_blank" rel="noopener">Buka</a>` : esc(v)}</td>`;
      }).join('')}<td><div class="acts">
        <button class="btn pr" data-a="e" data-id="${r.id}">Edit</button>
        <button class="btn dg" data-a="d" data-id="${r.id}">Hapus</button></div></td></tr>`).join('')
        || `<tr><td colspan="${cols.length + 1}" class="empty">Belum ada data.</td></tr>`;
    };

    f.onsubmit = async (e) => {
      e.preventDefault();
      const d = Object.fromEntries(new FormData(f));
      try {
        if (editId) await F.updateDoc(F.doc(db, col, editId), d);
        else await F.addDoc(F.collection(db, col), { ...d, createdBy: me.email, createdAt: F.serverTimestamp() });
        toast('Tersimpan.'); reset();
      } catch (err) { toast('Gagal: ' + (err.code || err.message), 'err'); }
    };
    $('cl').onclick = reset;
    $('rows').onclick = async (e) => {
      const b = e.target.closest('button[data-a]'); if (!b) return;
      const r = rows.find(x => x.id === b.dataset.id); if (!r) return;
      if (b.dataset.a === 'e') {
        editId = r.id; $('cl').hidden = false;
        fields.forEach(x => { f.elements[x.k].value = r[x.k] ?? ''; });
        scrollTo({ top: 0, behavior: 'smooth' });
      } else if (confirm('Hapus data ini?')) {
        try { await F.deleteDoc(F.doc(db, col, r.id)); toast('Dihapus.'); }
        catch (err) { toast('Gagal: ' + (err.code || err.message), 'err'); }
      }
    };
    listen(col, (r) => { rows = r.sort(byNew); draw(); });
  });
}