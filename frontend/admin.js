/* ===== WA Bot — Admin Console Logic ===== */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const dom = {
    adminMobileMenu:       $('adminMobileMenu'),
    adminHamburgerBtn:     $('adminHamburgerBtn'),
    adminDrawerClose:      $('adminDrawerClose'),
    adminMobileSignOutBtn: $('adminMobileSignOutBtn'),
    adminSignOutBtn:       $('adminSignOutBtn'),

    tenantListBody:        $('tenantListBody'),
    createUserForm:        $('createUserForm'),
    newUsername:           $('newUsername'),
    newPassword:           $('newPassword'),
    newRole:               $('newRole'),
    newOwnerNumber:        $('newOwnerNumber'),
    newDefaultProvider:    $('newDefaultProvider'),
    btnCreateUser:         $('btnCreateUser'),
    btnCancelCreate:       $('btnCancelCreate'),
    createUserError:       $('createUserError'),
  };

  function getToken() {
    return localStorage.getItem('session_token') || '';
  }

  function getHeaders() {
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    };
    const token = getToken();
    if (token) {
      headers['Authorization'] = 'Bearer ' + token;
    }
    return headers;
  }

  async function apiFetch(url, options = {}) {
    const res = await fetch(url, {
      ...options,
      headers: { ...getHeaders(), ...(options.headers || {}) },
      credentials: 'same-origin'
    });
    if (res.status === 401 || res.status === 403) {
      window.location.href = 'index.html';
      throw new Error('Unauthorized');
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return res.json();
  }

  /* ----- Auth Guard ----- */
  async function checkAuth() {
    try {
      const data = await apiFetch('/api/auth/me');
      const user = data.user || data;
      if (user.role !== 'admin' && user.is_admin !== true) {
        window.location.href = 'index.html';
        return;
      }
      loadUsers();
    } catch (_) {
      window.location.href = 'login.html';
    }
  }

  async function doSignOut() {
    try {
      await apiFetch('/api/auth/logout', { method: 'POST' });
    } catch (_) {}
    localStorage.removeItem('session_token');
    localStorage.removeItem('user_data');
    window.location.href = 'login.html';
  }

  /* ----- Mobile Navigation Popup ----- */
  function toggleMobileMenu(e) {
    if (e) e.stopPropagation();
    if (!dom.adminMobileMenu) return;
    const isHidden = dom.adminMobileMenu.classList.contains('hidden');
    if (isHidden) {
      dom.adminMobileMenu.classList.remove('hidden');
      if (dom.adminHamburgerBtn) dom.adminHamburgerBtn.setAttribute('aria-expanded', 'true');
    } else {
      closeMobileMenu();
    }
  }

  function closeMobileMenu() {
    if (dom.adminMobileMenu) dom.adminMobileMenu.classList.add('hidden');
    if (dom.adminHamburgerBtn) dom.adminHamburgerBtn.setAttribute('aria-expanded', 'false');
  }

  /* ----- User List Management ----- */
  async function loadUsers() {
    try {
      const data = await apiFetch('/api/admin/users');
      renderUsers(data.users || []);
    } catch (_) {
      renderUsers([]);
    }
  }

  function renderUsers(users) {
    if (!dom.tenantListBody) return;
    dom.tenantListBody.innerHTML = '';

    if (!users || users.length === 0) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td colspan="6" style="text-align:center;color:var(--text-3);padding:20px;">No tenant users found</td>';
      dom.tenantListBody.appendChild(tr);
      return;
    }

    users.forEach((u) => {
      const tr = document.createElement('tr');
      const isActive = u.enabled !== false;
      const role = u.role || 'user';
      const botStatus = u.botStatus || 'DISCONNECTED';

      tr.innerHTML = `
        <td><strong>${esc(u.username)}</strong></td>
        <td><span class="badge ${role === 'admin' ? 'green' : ''}">${esc(role)}</span></td>
        <td>${esc(u.owner_number || u.ownerNumber || '—')}</td>
        <td>${esc(u.default_provider || u.provider || 'nvidia')}</td>
        <td><span class="badge ${botStatus === 'CONNECTED' ? 'green' : ''}">${esc(botStatus)}</span></td>
        <td style="text-align:right;">
          <button class="btn btn-sm btn-danger btn-delete-user" data-id="${esc(u.id || u.username)}" data-name="${esc(u.username)}">Remove</button>
        </td>
      `;
      dom.tenantListBody.appendChild(tr);
    });

    // Bind remove buttons
    dom.tenantListBody.querySelectorAll('.btn-delete-user').forEach(btn => {
      btn.addEventListener('click', async () => {
        const userId = btn.dataset.id;
        const name = btn.dataset.name;
        if (!confirm(`Are you sure you want to delete user '${name}'?`)) return;
        try {
          await apiFetch(`/api/admin/users/${encodeURIComponent(userId)}`, { method: 'DELETE' });
          loadUsers();
        } catch (err) {
          alert(`Failed to delete user: ${err.message}`);
        }
      });
    });
  }

  function esc(s) {
    if (s === null || s === undefined) return '';
    const d = document.createElement('div');
    d.textContent = String(s);
    return d.innerHTML;
  }

  /* ----- Create User ----- */
  async function createUser(e) {
    e.preventDefault();
    if (dom.createUserError) dom.createUserError.textContent = '';

    const username = dom.newUsername ? dom.newUsername.value.trim() : '';
    const password = dom.newPassword ? dom.newPassword.value : '';
    const role = dom.newRole ? dom.newRole.value : 'user';
    const ownerNumber = dom.newOwnerNumber ? dom.newOwnerNumber.value.trim() : '';
    const defaultProvider = dom.newDefaultProvider ? dom.newDefaultProvider.value : 'nvidia';

    if (!username || !password) {
      if (dom.createUserError) dom.createUserError.textContent = 'Username and password are required';
      return;
    }

    if (dom.btnCreateUser) dom.btnCreateUser.disabled = true;

    try {
      await apiFetch('/api/admin/users', {
        method: 'POST',
        body: JSON.stringify({
          username,
          password,
          role,
          owner_number: ownerNumber,
          default_provider: defaultProvider
        })
      });

      if (dom.createUserForm) dom.createUserForm.reset();
      loadUsers();
    } catch (err) {
      if (dom.createUserError) dom.createUserError.textContent = 'Failed to create user. The username may already exist.';
    } finally {
      if (dom.btnCreateUser) dom.btnCreateUser.disabled = false;
    }
  }

  function cancelCreate() {
    if (dom.createUserForm) dom.createUserForm.reset();
    if (dom.createUserError) dom.createUserError.textContent = '';
  }

  /* ----- Event Listeners ----- */
  function bindEvents() {
    if (dom.adminSignOutBtn) dom.adminSignOutBtn.addEventListener('click', doSignOut);
    if (dom.adminMobileSignOutBtn) dom.adminMobileSignOutBtn.addEventListener('click', () => { closeMobileMenu(); doSignOut(); });

    if (dom.adminHamburgerBtn) dom.adminHamburgerBtn.addEventListener('click', toggleMobileMenu);

    document.addEventListener('click', (e) => {
      if (dom.adminMobileMenu && !dom.adminMobileMenu.contains(e.target) && e.target !== dom.adminHamburgerBtn && !dom.adminHamburgerBtn.contains(e.target)) {
        closeMobileMenu();
      }
    });

    if (dom.createUserForm) dom.createUserForm.addEventListener('submit', createUser);
    if (dom.btnCancelCreate) dom.btnCancelCreate.addEventListener('click', cancelCreate);

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeMobileMenu();
    });
  }

  /* ----- Init ----- */
  document.addEventListener('DOMContentLoaded', () => {
    bindEvents();
    checkAuth();
  });
})();
