(function () {
  /* ═══════ EDIT MENU DI SINI SAJA ═══════ */
  // roles: peran yang melihat menu (Rules & Functions tetap menegakkan akses di backend).
  const ALL = ['sysadmin', 'operator', 'pemeriksa', 'pembaca'];
  const MENU = [
    { label: 'Utama', items: [
      { href: 'home.html',          icon: 'grid',        text: 'Dashboard', roles: ALL },
    ]},
    { label: 'Operasional', items: [
      { href: 'kegiatan.html',      icon: 'activity',    text: 'Kegiatan', roles: ALL },
      { href: 'tracking.html',      icon: 'map-pin',     text: 'Tracking', roles: ['sysadmin', 'operator'] },
      { href: 'laporan.html',       icon: 'file-text',   text: 'Laporan', roles: ['sysadmin', 'operator', 'pemeriksa'] },
      { href: 'dokumentasi.html',   icon: 'image',       text: 'Dokumentasi', roles: ['sysadmin', 'operator', 'pemeriksa'] },
      { href: 'rekap.html',         icon: 'bar-chart-2', text: 'Rekap', roles: ALL },
    ]},
    { label: 'Personel', items: [
      { href: 'user-manager.html',  icon: 'users',       text: 'Personel & Akses', roles: ['sysadmin', 'operator'] },
      { href: 'unit.html',          icon: 'layers',      text: 'Unit', roles: ['sysadmin'] },
    ]},
    { label: 'Sistem', items: [
      { href: 'audit.html',         icon: 'shield',      text: 'Log Audit', roles: ['sysadmin'] },
      { href: 'pengaturan.html',    icon: 'settings',    text: 'Pengaturan', roles: ALL },
    ]},
  ];
  const DEFAULT_PAGE = 'home';

  const LOGO_LINTAS   = 'https://firebasestorage.googleapis.com/v0/b/lintas-benteng.firebasestorage.app/o/assets%2Flintas_new%20(1).png?alt=media&token=7742714a-1063-4ff2-8591-6e0183724931';
  const LOGO_DENZIPUR = 'https://firebasestorage.googleapis.com/v0/b/lintas-benteng.firebasestorage.app/o/assets%2Fdenzipur%2014%20logo.png?alt=media&token=dc433442-00dd-40d5-93b1-a2529c9813b0';

  const CSS = `
  .sidebar{width:var(--sidebar-w,260px);background:rgba(10,10,10,.98);border-right:1px solid rgba(255,255,255,.1);display:flex;flex-direction:column;position:fixed;top:0;left:0;height:100vh;z-index:200;transition:transform .3s ease;overflow-y:auto;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.1) transparent}
  .sidebar-logo{padding:24px 24px 20px;border-bottom:1px solid rgba(255,255,255,.1);text-align:center}
  .logo-pair{display:flex;align-items:center;justify-content:center;gap:10px;margin-bottom:12px}
  .logo-pair img{width:auto;object-fit:contain}.logo-pair .l1{height:34px}.logo-pair .l2{height:48px}.logo-pair span{color:#a0a0a0;font-size:12px}
  .s-title{font-size:13px;font-weight:800;letter-spacing:.12em;background:linear-gradient(135deg,#3b82f6,#8b5cf6);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
  .s-badge{display:block;margin-top:4px;font-size:10px;font-weight:600;letter-spacing:.12em;color:#555;text-transform:uppercase}
  .sidebar-user{padding:16px 24px;border-bottom:1px solid rgba(255,255,255,.1);display:flex;align-items:center;gap:12px}
  .sidebar .avatar{width:36px;height:36px;border-radius:10px;background:linear-gradient(135deg,#3b82f6,#8b5cf6);display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;color:#fff;flex-shrink:0;overflow:hidden}
  .sidebar .avatar img{width:100%;height:100%;object-fit:cover}
  .sidebar .user-meta{min-width:0}
  .sidebar .user-meta small{display:block;font-size:10px;color:#555;text-transform:uppercase;letter-spacing:.08em;font-weight:600}
  .sidebar .user-meta span{display:block;font-size:12px;font-weight:500;color:#e5e5e5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .sidebar-nav{flex:1;padding:16px 12px}
  .nav-label{font-size:9px;font-weight:700;letter-spacing:.15em;color:#555;text-transform:uppercase;padding:8px 12px 6px;margin-top:8px}
  .nav-item{display:flex;align-items:center;gap:12px;padding:10px 12px;border-radius:10px;color:#a0a0a0;text-decoration:none;font-size:13.5px;font-weight:500;transition:all .2s;margin-bottom:2px;border:1px solid transparent}
  .nav-item[hidden],.nav-label[hidden]{display:none}
  .nav-item:hover{color:#e5e5e5;background:rgba(255,255,255,.05);border-color:rgba(255,255,255,.1)}
  .nav-item.active{color:#3b82f6;background:rgba(59,130,246,.1);border-color:rgba(59,130,246,.2)}
  .nav-item svg{width:16px;height:16px;flex-shrink:0;stroke-width:1.8}
  .sidebar-footer{padding:16px 12px;border-top:1px solid rgba(255,255,255,.1)}
  .logout-btn{display:flex;align-items:center;gap:10px;width:100%;padding:10px 12px;border-radius:10px;border:1px solid rgba(239,83,80,.2);background:rgba(239,83,80,.05);color:#f87171;font-size:13.5px;font-weight:500;cursor:pointer;transition:all .2s;font-family:inherit}
  .logout-btn:hover{background:rgba(239,83,80,.15);border-color:rgba(239,83,80,.4)}
  .logout-btn svg{width:16px;height:16px;stroke-width:1.8}
  .overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:150}
  @media(max-width:768px){.sidebar{transform:translateX(-100%)}.sidebar.open{transform:translateX(0)}}
  `;

  const norm = (p) => (p || '').split('?')[0].split('#')[0].split('/').pop().replace(/\.html$/, '');
  const allItems = MENU.flatMap(g => g.items).filter(i => i.href !== '#');

  const nav = MENU.map(g => `
    <div class="nav-label">${g.label}</div>
    ${g.items.map(i => `
      <a href="${i.href}" class="nav-item" data-roles="${(i.roles || []).join(' ')}" data-page="${i.href === '#' ? '' : norm(i.href)}">
        <i data-feather="${i.icon}"></i> ${i.text}
      </a>`).join('')}
  `).join('');

  const el = document.getElementById('sidebar-mount');
  if (!el) { console.warn('sidebar-mount tidak ditemukan'); return; }

  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  el.innerHTML = `
    <div class="overlay" id="overlay"></div>
    <aside class="sidebar" id="sidebar">
      <div class="sidebar-logo">
        <div class="logo-pair"><img class="l1" src="${LOGO_LINTAS}" alt="Lintas"><span>✕</span><img class="l2" src="${LOGO_DENZIPUR}" alt="Denzipur 14"></div>
        <div class="s-title">LINTAS DENZIPUR</div>
        <span class="s-badge">Admin Panel</span>
      </div>
      <div class="sidebar-user">
        <div class="avatar" id="avatar">A</div>
        <div class="user-meta"><small>Logged in as</small><span id="sidebarEmail">-</span></div>
      </div>
      <nav class="sidebar-nav">${nav}</nav>
      <div class="sidebar-footer">
        <button class="logout-btn" id="sbLogout"><i data-feather="log-out"></i> Logout</button>
      </div>
    </aside>`;

  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('overlay');
  const view    = document.getElementById('view');      // iframe di shell
  const crumb   = document.getElementById('crumb');     // teks breadcrumb di topbar

  window.toggleSidebar = (force) => {
    const open = typeof force === 'boolean' ? force : !sidebar.classList.contains('open');
    sidebar.classList.toggle('open', open);
    overlay.style.display = open ? 'block' : 'none';
  };

  /* ── Navigasi tanpa reload sidebar ── */
  let role = null;
  const allowed = (i) => !role || (i.roles || []).includes(role);
  /** Tampilkan hanya menu sesuai peran; grup kosong disembunyikan. */
  window.dzApplyRole = (r, label) => {
    role = r;
    document.querySelectorAll('.nav-item').forEach(a => { a.hidden = !a.dataset.roles.split(' ').includes(r); });
    document.querySelectorAll('.nav-label').forEach(l => {
      let n = l.nextElementSibling, any = false;
      while (n && !n.classList.contains('nav-label')) { if (!n.hidden) any = true; n = n.nextElementSibling; }
      l.hidden = !any;
    });
    const b = document.querySelector('.sidebar .s-badge'); if (b && label) b.textContent = label;
  };

  function go(page, push) {
    const item = allItems.find(i => norm(i.href) === page && allowed(i)) || allItems.find(i => norm(i.href) === DEFAULT_PAGE);
    if (!item) return;
    const name = norm(item.href);

    document.querySelectorAll('.nav-item').forEach(a => a.classList.toggle('active', a.dataset.page === name));
    if (crumb) crumb.textContent = item.text;
    document.title = item.text + ' — Lintas Denzipur';
    if (push && location.hash !== '#' + name) history.pushState(null, '', '#' + name);

    if (view) {
      const target = item.href + '?embed=1';
      if (!view.src.endsWith(target)) {
                window.showLoader && window.showLoader();
        view.src = target;
      }
    }
    window.toggleSidebar(false);
  }

  window.navigate   = (href) => go(norm(href), true);
  window.initRouter = () => go(location.hash.slice(1) || DEFAULT_PAGE, false);

  sidebar.addEventListener('click', (e) => {
    const a = e.target.closest('a.nav-item');
    if (!a) return;
    e.preventDefault();
    if (a.dataset.page) go(a.dataset.page, true);
  });
  window.addEventListener('popstate', () => go(location.hash.slice(1) || DEFAULT_PAGE, false));

  overlay.addEventListener('click', () => window.toggleSidebar(false));
  document.getElementById('sbLogout').addEventListener('click', () => window.logout && window.logout());
  if (window.feather) feather.replace();
})();