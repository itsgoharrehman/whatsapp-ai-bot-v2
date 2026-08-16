/* ===== WA Bot — Admin Console Logic ===== */
(function () {
  'use strict';

  /* ----- DOM refs ----- */
  const $ = (id) => document.getElementById(id);

  const dom = {
    adminMobileMenu:     $('adminMobileMenu'),
    adminHamburgerBtn:   $('adminHamburgerBtn'),
    adminDrawerClose:    $('adminDrawerClose'),
    adminMobileSignOutBtn: $('adminMobileSignOutBtn'),
    adminSignOutBtn:     $('adminSignOutBtn'),

    tenantListBody:      $('tenantListBody'),
    createUserForm:      $('createUserForm'),
    newUsername:         $('newUsername'),
    newPassword:         $('newPassword'),
    newRole:             $('newRole'),
    newOwnerNumber:      $('newOwnerNumber'),
    newDefaultProvider:  $('newDefaultProvider'),
    btnCreateUser:       $('btnCreateUser'),
    btnCancelCreate:     $('btnCancelCreate'),
    createUserError:     $('createUserError'),
  };

  /* ----- State ----- */
  let demoMode = false;

  /* ----- API base ----- */
  const API = '';

  /* ----- Helpers ----- */
  function fetchJSON(url, options) {
    return fetch(API + url, {
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      credentials: 'same-origin',
      ...options,
    }).then(function (r) {
      if (r.status === 401) { window.location.href = 'index.html'; throw new Error('Unauthorized'); }
      if (!r.ok) throw new Error('Request failed: ' + r.status);
      return r.json();
    });
  }

  /* ----- Auth ----- */
  async function checkAuth() {
    try {
      const data = await fetchJSON('/api/auth/me');
      if (data.role !== 'admin') { window.location.href = 'index.html'; }
    } catch {
      window.location.href = 'index.html';
    }
  }

  async function doSignOut() {
    try { await fetchJSON('/api/auth/logout', { method: 'POST' }); } catch {}
    window.location.href = 'index.html';
  }

  /* ----- Mobile Menu ----- */
  function openMobileMenu() {
    dom.adminMobileMenu.classList.add('open');
    dom.adminMobileMenu.setAttribute('aria-hidden', 'false');
    dom.adminHamburgerBtn.setAttribute('aria-expanded', 'true');
  }

  function closeMobileMenu() {
    dom.adminMobileMenu.classList.remove('open');
    dom.adminMobileMenu.setAttribute('aria-hidden', 'true');
    dom.adminHamburgerBtn.setAttribute('aria-expanded', 'false');
  }

  /* ----- Tenant User List ----- */
  async function loadUsers() {
    try {
      const data = await fetchJSON('/api/admin/users');
      renderUsers(data.users || []);
    } catch {
      if (!demoMode) renderUsers([]);
    }
  }

  function renderUsers(users) {
    dom.tenantListBody.innerHTML = '';
    if (!users.length) {
      var tr = document.createElement('tr');
      var td = document.createElement('td');
      td.colSpan = 5;
      td.style.color = 'var(--text-3)';
      td.style.textAlign = 'center';
      td.style.padding = '20px 10px';
      td.textContent = 'No tenant users found';
      tr.appendChild(td);
      dom.tenantListBody.appendChild(tr);
      return;
    }
    users.forEach(function (u) {
      var tr = document.createElement('tr');
      tr.innerHTML =
        '<td>' + esc(u.username) + '</td>' +
        '<td>' + esc(u.role) + '</td>' +
        '<td>' + esc(u.owner_number || '—') + '</td>' +
        '<td>' + esc(u.default_provider || '—') + '</td>' +
        '<td><span class="badge' + (u.active ? ' green' : ' danger') + '">' + (u.active ? 'Active' : 'Inactive') + '</span></td>';
      dom.tenantListBody.appendChild(tr);
    });
  }

  function esc(s) {
    var d = document.createElement('span');
    d.textContent = s;
    return d.innerHTML;
  }

  /* ----- Create User ----- */
  async function createUser(e) {
    e.preventDefault();
    dom.createUserError.textContent = '';
    var payload = {
      username: dom.newUsername.value.trim(),
      password: dom.newPassword.value,
      role: dom.newRole.value,
      owner_number: dom.newOwnerNumber.value.trim(),
      default_provider: dom.newDefaultProvider.value,
    };
    if (!payload.username || !payload.password) {
      dom.createUserError.textContent = 'Username and password are required';
      return;
    }
    try {
      await fetchJSON('/api/admin/users', { method: 'POST', body: JSON.stringify(payload) });
      dom.createUserForm.reset();
      loadUsers();
    } catch {
      dom.createUserError.textContent = 'Failed to create user';
    }
  }

  function cancelCreate() {
    dom.createUserForm.reset();
    dom.createUserError.textContent = '';
  }

  /* ----- Event Bindings ----- */
  dom.adminSignOutBtn.addEventListener('click', doSignOut);
  dom.adminMobileSignOutBtn.addEventListener('click', doSignOut);
  dom.adminHamburgerBtn.addEventListener('click', openMobileMenu);
  dom.adminDrawerClose.addEventListener('click', closeMobileMenu);
  dom.adminMobileMenu.addEventListener('click', function (e) {
    if (e.target === dom.adminMobileMenu) closeMobileMenu();
  });

  dom.createUserForm.addEventListener('submit', createUser);
  dom.btnCancelCreate.addEventListener('click', cancelCreate);

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && dom.adminMobileMenu.classList.contains('open')) closeMobileMenu();
  });

  /* ----- Demo Mode ----- */
  var demoUsers = [
    { username: 'admin', role: 'admin', owner_number: '+1 555-0100', default_provider: 'auto', active: true },
    { username: 'operator1', role: 'user', owner_number: '+1 555-0142', default_provider: 'nvidia_nim', active: true },
    { username: 'operator2', role: 'user', owner_number: '+44 7700 900123', default_provider: 'groq', active: true },
    { username: 'operator3', role: 'user', owner_number: '+91 98765 43210', default_provider: 'auto', active: false },
  ];

  function enableDemoMode() {
    demoMode = true;
    renderUsers(demoUsers);
  }

  /* Demo create user override */
  dom.createUserForm.addEventListener('submit', function (e) {
    if (demoMode) {
      e.stopImmediatePropagation();
      e.preventDefault();
      dom.createUserError.textContent = '';
      var uname = dom.newUsername.value.trim();
      var pwd = dom.newPassword.value;
      if (!uname || !pwd) { dom.createUserError.textContent = 'Username and password are required'; return; }
      demoUsers.push({
        username: uname,
        role: dom.newRole.value,
        owner_number: dom.newOwnerNumber.value.trim() || '—',
        default_provider: dom.newDefaultProvider.value,
        active: true,
      });
      renderUsers(demoUsers);
      dom.createUserForm.reset();
    }
  }, true);

  /* ----- Init ----- */
  function init() {
    fetch(API + '/api/auth/me', { credentials: 'same-origin' }).then(function (r) {
      if (r.ok) {
        r.json().then(function (data) {
          if (data.role !== 'admin') window.location.href = 'index.html';
        });
        loadUsers();
      } else {
        enableDemoMode();
      }
    }).catch(function () {
      enableDemoMode();
    });
  }

  init();
})();
