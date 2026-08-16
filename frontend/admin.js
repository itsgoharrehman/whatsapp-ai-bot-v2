"use strict";

document.addEventListener("DOMContentLoaded", () => {
  const token = localStorage.getItem("whatsapp_bot_token") || null;
  if (!token) {
    window.location.href = "index.html";
    return;
  }

  const usersTableBody = document.getElementById("usersTableBody");
  const toggleAddUserBtn = document.getElementById("toggleAddUserBtn");
  const addUserBox = document.getElementById("addUserBox");
  const cancelCreateUserBtn = document.getElementById("cancelCreateUserBtn");
  const createUserForm = document.getElementById("createUserForm");
  const createUserError = document.getElementById("createUserError");
  const adminLogoutBtn = document.getElementById("adminLogoutBtn");
  const adminHamburgerBtn = document.getElementById("adminHamburgerBtn");
  const adminMobileMenu = document.getElementById("adminMobileMenu");
  const mobileAdminLogoutBtn = document.getElementById("mobileAdminLogoutBtn");

  if (adminHamburgerBtn && adminMobileMenu) {
    adminHamburgerBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      adminMobileMenu.hidden = !adminMobileMenu.hidden;
    });
  }

  document.addEventListener("click", (e) => {
    if (adminMobileMenu && !adminMobileMenu.hidden && !e.target.closest(".mobile-menu-wrapper")) {
      adminMobileMenu.hidden = true;
    }
  });

  async function apiFetch(url, options = {}) {
    const headers = options.headers || {};
    headers["Authorization"] = `Bearer ${token}`;
    headers["Content-Type"] = "application/json";
    const res = await fetch(url, { ...options, headers });
    if (res.status === 401 || res.status === 403) {
      window.location.href = "index.html";
      return null;
    }
    return res;
  }

  async function loadUsers() {
    try {
      const res = await apiFetch("/api/admin/users");
      if (!res) return;
      const data = await res.json();
      renderUsers(data.users || []);
    } catch (err) {
      console.error("Failed to load users:", err);
      usersTableBody.innerHTML = `<tr><td colspan="6" class="table-error">Failed to load users</td></tr>`;
    }
  }

  function renderUsers(users) {
    if (!users.length) {
      usersTableBody.innerHTML = `<tr><td colspan="6" class="table-empty">No users found.</td></tr>`;
      return;
    }

    usersTableBody.innerHTML = users.map(u => {
      const botStatusClass = u.botStatus === 'CONNECTED' ? 'status-tag-connected' :
                             u.botStatus === 'QR_READY' ? 'status-tag-qr' : 'status-tag-disconnected';
      const isConnected = u.botStatus === 'CONNECTED';
      const isQr = u.botStatus === 'QR_READY';

      return `
        <tr>
          <td>
            <div class="user-cell">
              <strong>${escapeHtml(u.username)}</strong>
              ${u.ownerNumber ? `<span class="user-phone">${escapeHtml(u.ownerNumber)}</span>` : ''}
            </div>
          </td>
          <td><span class="role-badge role-${u.role}">${escapeHtml(u.role)}</span></td>
          <td>
            <button class="btn-toggle ${u.enabled ? 'btn-enabled' : 'btn-disabled'}" data-action="toggle-enable" data-id="${u.id}" data-enabled="${u.enabled}">
              ${u.enabled ? 'Enabled' : 'Disabled'}
            </button>
          </td>
          <td>
            <span class="status-tag ${botStatusClass}">${u.botStatus || 'DISCONNECTED'}</span>
          </td>
          <td>
            <span class="metric-num">${u.analytics?.totalProcessed || 0}</span> msg / 
            <span class="metric-num">${u.analytics?.totalReplies || 0}</span> replies
          </td>
          <td>
            <div class="table-actions">
              ${!isConnected ? `
                <button class="btn-action btn-start" data-action="bot-action" data-id="${u.id}" data-type="start">Start</button>
              ` : `
                <button class="btn-action btn-stop" data-action="bot-action" data-id="${u.id}" data-type="stop">Stop</button>
              `}
              <button class="btn-action btn-reset" data-action="bot-action" data-id="${u.id}" data-type="reset">Reset QR</button>
              <button class="btn-action btn-password" data-action="reset-password" data-id="${u.id}" data-user="${escapeHtml(u.username)}">Password</button>
              <button class="btn-action btn-delete" data-action="delete-user" data-id="${u.id}" data-user="${escapeHtml(u.username)}">Delete</button>
            </div>
          </td>
        </tr>
      `;
    }).join("");
  }

  // Handle table actions
  usersTableBody.addEventListener("click", async (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    const action = btn.dataset.action;
    const userId = btn.dataset.id;
    const username = btn.dataset.user;

    if (action === "toggle-enable") {
      const current = btn.dataset.enabled === "true";
      btn.disabled = true;
      try {
        await apiFetch(`/api/admin/users/${userId}`, {
          method: "PUT",
          body: JSON.stringify({ enabled: !current })
        });
        await loadUsers();
      } catch (err) {
        alert("Failed to toggle user status");
      }
    } else if (action === "bot-action") {
      const type = btn.dataset.type;
      btn.disabled = true;
      try {
        await apiFetch(`/api/admin/users/${userId}/action`, {
          method: "POST",
          body: JSON.stringify({ action: type })
        });
        await loadUsers();
      } catch (err) {
        alert(`Failed to ${type} bot`);
      }
    } else if (action === "reset-password") {
      const newPass = prompt(`Enter new password for user '${username}':`);
      if (newPass && newPass.trim().length >= 4) {
        try {
          await apiFetch(`/api/admin/users/${userId}`, {
            method: "PUT",
            body: JSON.stringify({ password: newPass.trim() })
          });
          alert(`Password updated for '${username}'.`);
        } catch (err) {
          alert("Failed to update password");
        }
      }
    } else if (action === "delete-user") {
      if (confirm(`Are you sure you want to permanently delete user '${username}' and all their session data?`)) {
        try {
          await apiFetch(`/api/admin/users/${userId}`, { method: "DELETE" });
          await loadUsers();
        } catch (err) {
          alert("Failed to delete user");
        }
      }
    }
  });

  // Toggle Add User Box
  toggleAddUserBtn.addEventListener("click", () => {
    addUserBox.hidden = !addUserBox.hidden;
    if (!addUserBox.hidden) {
      document.getElementById("newUsername").focus();
    }
  });

  cancelCreateUserBtn.addEventListener("click", () => {
    addUserBox.hidden = true;
    createUserForm.reset();
    createUserError.hidden = true;
  });

  // Create User Form Submit
  createUserForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    createUserError.hidden = true;
    const username = document.getElementById("newUsername").value.trim();
    const password = document.getElementById("newPassword").value.trim();
    const role = document.getElementById("newRole").value;
    const ownerNumber = document.getElementById("newOwnerNumber").value.trim();
    const provider = document.getElementById("newProvider").value;

    try {
      const res = await apiFetch("/api/admin/users", {
        method: "POST",
        body: JSON.stringify({
          username,
          password,
          role,
          settings: { ownerNumber, provider }
        })
      });
      if (!res) return;
      const data = await res.json();
      if (!res.ok || data.error) {
        createUserError.textContent = data.error || "Failed to create user";
        createUserError.hidden = false;
        return;
      }
      createUserForm.reset();
      addUserBox.hidden = true;
      await loadUsers();
    } catch (err) {
      createUserError.textContent = err.message;
      createUserError.hidden = false;
    }
  });

  // Sign out
  adminLogoutBtn.addEventListener("click", async () => {
    try {
      await apiFetch("/api/auth/logout", { method: "POST" });
    } catch (err) {}
    localStorage.removeItem("whatsapp_bot_token");
    window.location.href = "index.html";
  });

  function escapeHtml(str) {
    if (!str) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  loadUsers();
  setInterval(loadUsers, 5000);
});
