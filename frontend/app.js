"use strict";

document.addEventListener("DOMContentLoaded", () => {
  // Authentication State
  let authToken = localStorage.getItem("whatsapp_bot_token") || null;
  let currentUser = null;
  let sseSource = null;

  // Views
  const authView = document.getElementById("authView");
  const dashboardView = document.getElementById("dashboardView");
  const loginOverlay = document.getElementById("loginOverlay");
  const settingsModal = document.getElementById("settingsModal");
  const adminModal = document.getElementById("adminModal");

  // User & Nav Badges
  const authUsernameBadge = document.getElementById("authUsernameBadge");
  const dashboardUsernameBadge = document.getElementById("dashboardUsernameBadge");
  const authSubtitle = document.getElementById("authSubtitle");
  const dashboardSubtitle = document.getElementById("dashboardSubtitle");

  // Nav Buttons
  const authSettingsBtn = document.getElementById("authSettingsBtn");
  const dashboardSettingsBtn = document.getElementById("dashboardSettingsBtn");
  const authAdminBtn = document.getElementById("authAdminBtn");
  const dashboardAdminBtn = document.getElementById("dashboardAdminBtn");
  const authLogoutBtn = document.getElementById("authLogoutBtn");
  const dashboardLogoutBtn = document.getElementById("dashboardLogoutBtn");

  // Status Indicators
  const authStatus = document.getElementById("authStatus");
  const dashboardStatus = document.getElementById("dashboardStatus");
  const dashboardStatusText = document.getElementById("dashboardStatusText");

  // QR Block Elements
  const qrLoading = document.getElementById("qrLoading");
  const qrReady = document.getElementById("qrReady");
  const qrConnected = document.getElementById("qrConnected");
  const qrImage = document.getElementById("qrImage");
  const qrStateTitle = document.getElementById("qrStateTitle");
  const qrStateCopy = document.getElementById("qrStateCopy");
  const qrNote = document.getElementById("qrNote");

  // Control Buttons
  const startBtn = document.getElementById("startBtn");
  const stopBtn = document.getElementById("stopBtn");
  const newSessionBtn = document.getElementById("newSessionBtn");
  const dashboardStopBtn = document.getElementById("dashboardStopBtn");
  const dashboardNewSessionBtn = document.getElementById("dashboardNewSessionBtn");

  // Dashboard Session Banner
  const sessionTitle = document.getElementById("sessionTitle");
  const sessionSubtitleMain = document.getElementById("sessionSubtitle");

  // Metrics
  const operatingMode = document.getElementById("operatingMode");
  const autoReplyState = document.getElementById("autoReplyState");
  const activeAiKey = document.getElementById("activeAiKey");
  const totalMessages = document.getElementById("totalMessages");
  const totalReplies = document.getElementById("totalReplies");

  // Terminal Controls
  const logArea = document.getElementById("logArea");
  const clearLog = document.getElementById("clearLog");
  const autoScroll = document.getElementById("autoScroll");

  // Modals & Forms
  const loginForm = document.getElementById("loginForm");
  const loginUsername = document.getElementById("loginUsername");
  const loginPassword = document.getElementById("loginPassword");
  const loginError = document.getElementById("loginError");

  const settingsForm = document.getElementById("settingsForm");
  const settingsProvider = document.getElementById("settingsProvider");
  const settingsOwnerNumber = document.getElementById("settingsOwnerNumber");
  const settingsNvidiaKeys = document.getElementById("settingsNvidiaKeys");
  const settingsGroqKeys = document.getElementById("settingsGroqKeys");
  const settingsSystemPrompt = document.getElementById("settingsSystemPrompt");
  const nvidiaKeyStatus = document.getElementById("nvidiaKeyStatus");
  const groqKeyStatus = document.getElementById("groqKeyStatus");
  const settingsSuccess = document.getElementById("settingsSuccess");
  const settingsError = document.getElementById("settingsError");
  const closeSettingsBtn = document.getElementById("closeSettingsBtn");
  const cancelSettingsBtn = document.getElementById("cancelSettingsBtn");

  const closeAdminBtn = document.getElementById("closeAdminBtn");
  const showAddUserBtn = document.getElementById("showAddUserBtn");
  const addUserFormContainer = document.getElementById("addUserFormContainer");
  const addUserForm = document.getElementById("addUserForm");
  const cancelAddUserBtn = document.getElementById("cancelAddUserBtn");
  const usersTableBody = document.getElementById("usersTableBody");
  const addUserError = document.getElementById("addUserError");

  const seenLogIds = new Set();
  let statusInterval = null;
  let logsInterval = null;

  // Helper for Authenticated Fetch
  async function apiFetch(url, options = {}) {
    const headers = options.headers ? { ...options.headers } : {};
    if (authToken) {
      headers["Authorization"] = `Bearer ${authToken}`;
    }
    if (options.body && typeof options.body === "object" && !(options.body instanceof FormData)) {
      headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(options.body);
    }
    const res = await fetch(url, { ...options, headers });
    if (res.status === 401) {
      handleAuthRequired();
      throw new Error("Unauthorized");
    }
    return res;
  }

  function handleAuthRequired() {
    authToken = null;
    currentUser = null;
    localStorage.removeItem("whatsapp_bot_token");
    if (sseSource) {
      sseSource.close();
      sseSource = null;
    }
    if (loginOverlay) loginOverlay.hidden = false;
  }

  function setQRState(state) {
    const states = {
      loading: qrLoading,
      ready: qrReady,
      connected: qrConnected
    };

    Object.values(states).forEach((node) => {
      if (node) node.classList.remove("active");
    });

    if (states[state]) {
      states[state].classList.add("active");
    }
  }

  function updateStatusBadges(status) {
    const isConnected = status === "CONNECTED";
    const isConnecting = status === "CONNECTING" || status === "QR_READY";

    if (authStatus) {
      const textEl = authStatus.querySelector(".status-text");
      if (textEl) textEl.textContent = status;
      authStatus.className = `status ${isConnected ? "connected" : isConnecting ? "connecting" : "disconnected"}`;
    }

    if (dashboardStatus) {
      if (dashboardStatusText) dashboardStatusText.textContent = status;
      dashboardStatus.className = `status ${isConnected ? "connected" : isConnecting ? "connecting" : "disconnected"}`;
    }
  }

  function updateDashboard(data) {
    const status = data.status || "DISCONNECTED";
    updateStatusBadges(status);

    if (status === "CONNECTED") {
      if (authView) authView.hidden = true;
      if (dashboardView) dashboardView.hidden = false;

      if (sessionTitle) sessionTitle.textContent = "Active Session Authenticated";
      if (sessionSubtitleMain) {
        sessionSubtitleMain.textContent = `WhatsApp socket connected. Bot JID: ${data.botJid || "Connected"}`;
      }
    } else if (status === "QR_READY" && data.qrCodeDataUrl) {
      if (authView) authView.hidden = false;
      if (dashboardView) dashboardView.hidden = true;

      setQRState("ready");
      if (qrImage) {
        qrImage.src = data.qrCodeDataUrl;
        qrImage.style.display = "block";
      }
      if (qrNote) qrNote.textContent = "Scan QR code using WhatsApp linked devices.";
    } else if (status === "CONNECTING") {
      if (authView) authView.hidden = false;
      if (dashboardView) dashboardView.hidden = true;

      setQRState("loading");
      if (qrStateTitle) qrStateTitle.textContent = "Connecting to WhatsApp";
      if (qrStateCopy) qrStateCopy.textContent = "Establishing secure socket connection...";
      if (qrNote) qrNote.textContent = "Please wait while WhatsApp socket initializes.";
    } else {
      if (authView) authView.hidden = false;
      if (dashboardView) dashboardView.hidden = true;

      setQRState("loading");
      if (qrStateTitle) qrStateTitle.textContent = "Service Disconnected";
      if (qrStateCopy) qrStateCopy.textContent = 'Click "Start" or "New Session" to generate QR code.';
      if (qrNote) qrNote.textContent = "Codes expire automatically. Generate a new session if needed.";
    }

    // Update Metrics
    if (autoReplyState) {
      autoReplyState.textContent = data.autoReply ? "ENABLED" : "DISABLED";
    }

    const aiStatus = data.aiStatus || data.groqStatus;
    if (aiStatus && activeAiKey) {
      const activeP = (aiStatus.activeProvider || "nvidia").toUpperCase();
      const pDetails = aiStatus[aiStatus.activeProvider] || aiStatus.nvidia || aiStatus.groq || {};
      const keyIdx = (typeof pDetails.activeKeyIndex === "number")
        ? (pDetails.activeKeyIndex + 1)
        : ((typeof aiStatus.activeKeyIndex === "number") ? (aiStatus.activeKeyIndex + 1) : 1);
      const totalKeys = (typeof pDetails.keysConfigured === "number")
        ? pDetails.keysConfigured
        : (aiStatus.totalKeysConfigured || 1);
      activeAiKey.textContent = `[${activeP}] Key #${keyIdx} / ${totalKeys || 1}`;
    }

    if (data.analytics) {
      if (totalMessages) {
        totalMessages.textContent = (data.analytics.totalMessagesProcessed || 0).toLocaleString();
      }
      if (totalReplies) {
        totalReplies.textContent = (data.analytics.totalRepliesSent || 0).toLocaleString();
      }
    }
  }

  async function fetchStatus() {
    if (!authToken) return;
    try {
      const res = await apiFetch("/api/status");
      if (!res.ok) return;
      const data = await res.json();
      updateDashboard(data);
    } catch (err) {
      updateStatusBadges("DISCONNECTED");
    }
  }

  async function fetchLogsFallback() {
    if (!authToken) return;
    try {
      const res = await apiFetch("/api/logs");
      if (res.ok) {
        const logs = await res.json();
        if (Array.isArray(logs)) {
          logs.forEach(appendLogEntry);
        }
      }
    } catch (err) {}
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function appendLogEntry(log) {
    if (!log || !logArea) return;
    if (log.id && seenLogIds.has(log.id)) return;
    if (log.id) seenLogIds.add(log.id);

    const timeStr = log.timestamp
      ? log.timestamp.split("T")[1]?.split(".")[0] || log.timestamp
      : new Date().toLocaleTimeString([], { hour12: false });

    const div = document.createElement("div");
    div.className = `log-row ${log.level || "info"}`;

    let msg = (log.message || "").trim();

    msg = msg.replace(/^\[(INFO|WARN|WARNING|SUCCESS|ERROR)\]\s*(?=\[)/i, "");

    let categoryHtml = "";
    const tagMatch = msg.match(
      /^\[(INPUT|ROUTE|SELECTION|OUTPUT|DISPATCH|COMMAND|ANTI-BAN|CONTEXT|FAILOVER|ROUTER|SYSTEM)\]\s*(.*)$/i
    );

    if (tagMatch) {
      const cat = tagMatch[1].toUpperCase();
      const rest = tagMatch[2];
      categoryHtml = `<span class="tag-badge tag-${cat.toLowerCase().replace(/[^a-z0-9]/g, "-")}">[${cat}]</span>`;
      msg = rest;
    } else {
      categoryHtml = `<span class="lvl">[${(log.level || "INFO").toUpperCase()}]</span>`;
    }

    div.innerHTML = `
      <span class="time">[${timeStr}]</span>
      ${categoryHtml}
      <span class="msg">${escapeHtml(msg)}</span>
      ${log.details ? `<span class="details"> (${escapeHtml(log.details)})</span>` : ""}
    `;

    logArea.appendChild(div);

    if (autoScroll && autoScroll.checked) {
      logArea.scrollTop = logArea.scrollHeight;
    }
  }

  function setupSSE() {
    if (!authToken) return;
    if (sseSource) sseSource.close();

    try {
      sseSource = new EventSource(`/api/logs/stream?token=${encodeURIComponent(authToken)}`);

      sseSource.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data);
          if (payload.type === "history" && Array.isArray(payload.logs)) {
            payload.logs.forEach(appendLogEntry);
          } else if (payload.type === "log" && payload.log) {
            appendLogEntry(payload.log);
            fetchStatus();
          }
        } catch (err) {}
      };

      sseSource.onerror = () => {
        if (sseSource) sseSource.close();
        if (authToken) {
          setTimeout(setupSSE, 5000);
        }
      };
    } catch (err) {}
  }

  // ==========================================
  // Auth & Session Lifecycle
  // ==========================================

  function applyUserContext(user) {
    currentUser = user;
    if (authUsernameBadge) authUsernameBadge.textContent = `@${user.username}`;
    if (dashboardUsernameBadge) dashboardUsernameBadge.textContent = `@${user.username}`;

    const subtitleText = `${user.username.charAt(0).toUpperCase() + user.username.slice(1)}'s Assistant`;
    if (authSubtitle) authSubtitle.textContent = subtitleText;
    if (dashboardSubtitle) dashboardSubtitle.textContent = subtitleText;

    const isAdmin = user.role === "admin";
    if (authAdminBtn) authAdminBtn.hidden = !isAdmin;
    if (dashboardAdminBtn) dashboardAdminBtn.hidden = !isAdmin;

    if (loginOverlay) loginOverlay.hidden = true;

    fetchStatus();
    fetchLogsFallback();
    setupSSE();

    if (!statusInterval) statusInterval = setInterval(fetchStatus, 3000);
    if (!logsInterval) logsInterval = setInterval(fetchLogsFallback, 3000);
  }

  async function checkAuthSession() {
    if (!authToken) {
      if (loginOverlay) loginOverlay.hidden = false;
      return;
    }
    try {
      const res = await apiFetch("/api/auth/me");
      if (res.ok) {
        const data = await res.json();
        applyUserContext(data.user);
      } else {
        handleAuthRequired();
      }
    } catch (err) {
      handleAuthRequired();
    }
  }

  if (loginForm) {
    loginForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (loginError) loginError.hidden = true;
      const username = loginUsername.value.trim();
      const password = loginPassword.value;

      try {
        const res = await fetch("/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, password })
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
          throw new Error(data.error || "Login failed");
        }
        authToken = data.token;
        localStorage.setItem("whatsapp_bot_token", authToken);
        applyUserContext(data.user);
      } catch (err) {
        if (loginError) {
          loginError.textContent = err.message || "Invalid credentials";
          loginError.hidden = false;
        }
      }
    });
  }

  async function handleLogout() {
    try {
      await apiFetch("/api/auth/logout", { method: "POST" });
    } catch (err) {}
    handleAuthRequired();
  }

  if (authLogoutBtn) authLogoutBtn.addEventListener("click", handleLogout);
  if (dashboardLogoutBtn) dashboardLogoutBtn.addEventListener("click", handleLogout);

  // ==========================================
  // Settings & BYOK API Keys
  // ==========================================

  async function openSettings() {
    if (settingsSuccess) settingsSuccess.hidden = true;
    if (settingsError) settingsError.hidden = true;
    if (settingsNvidiaKeys) settingsNvidiaKeys.value = "";
    if (settingsGroqKeys) settingsGroqKeys.value = "";

    try {
      const res = await apiFetch("/api/settings");
      if (res.ok) {
        const data = await res.json();
        const s = data.settings || {};
        const k = data.keys || {};

        if (settingsProvider) settingsProvider.value = s.provider || "nvidia";
        if (settingsOwnerNumber) settingsOwnerNumber.value = s.ownerNumber || "";
        if (settingsSystemPrompt) settingsSystemPrompt.value = s.systemPrompt || "";

        if (nvidiaKeyStatus) {
          const count = k.nvidiaKeysConfigured || 0;
          nvidiaKeyStatus.textContent = count > 0
            ? `Status: ${count} key(s) active (${k.isCustomNvidia ? "Custom BYOK" : "System Default"})`
            : "Status: Not configured";
        }
        if (groqKeyStatus) {
          const count = k.groqKeysConfigured || 0;
          groqKeyStatus.textContent = count > 0
            ? `Status: ${count} key(s) active (${k.isCustomGroq ? "Custom BYOK" : "System Default"})`
            : "Status: Not configured";
        }
      }
      if (settingsModal) settingsModal.hidden = false;
    } catch (err) {}
  }

  if (authSettingsBtn) authSettingsBtn.addEventListener("click", openSettings);
  if (dashboardSettingsBtn) dashboardSettingsBtn.addEventListener("click", openSettings);
  if (closeSettingsBtn) closeSettingsBtn.addEventListener("click", () => { if (settingsModal) settingsModal.hidden = true; });
  if (cancelSettingsBtn) cancelSettingsBtn.addEventListener("click", () => { if (settingsModal) settingsModal.hidden = true; });

  if (settingsForm) {
    settingsForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (settingsSuccess) settingsSuccess.hidden = true;
      if (settingsError) settingsError.hidden = true;

      const payload = {
        settings: {
          provider: settingsProvider.value,
          ownerNumber: settingsOwnerNumber.value.trim(),
          systemPrompt: settingsSystemPrompt.value.trim()
        }
      };

      if (settingsNvidiaKeys.value.trim()) {
        payload.nvidiaKeys = settingsNvidiaKeys.value.split(",").map(k => k.trim()).filter(Boolean);
      }
      if (settingsGroqKeys.value.trim()) {
        payload.groqKeys = settingsGroqKeys.value.split(",").map(k => k.trim()).filter(Boolean);
      }

      try {
        const res = await apiFetch("/api/settings", {
          method: "POST",
          body: payload
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
          throw new Error(data.error || "Failed to update settings");
        }
        if (settingsSuccess) settingsSuccess.hidden = false;
        setTimeout(() => {
          if (settingsModal) settingsModal.hidden = true;
        }, 800);
        fetchStatus();
      } catch (err) {
        if (settingsError) {
          settingsError.textContent = err.message;
          settingsError.hidden = false;
        }
      }
    });
  }

  // ==========================================
  // Admin User Management
  // ==========================================

  async function openAdminPanel() {
    if (addUserFormContainer) addUserFormContainer.hidden = true;
    if (addUserError) addUserError.hidden = true;
    if (adminModal) adminModal.hidden = false;
    loadAdminUsers();
  }

  async function loadAdminUsers() {
    if (!usersTableBody) return;
    usersTableBody.innerHTML = '<tr><td colspan="6" class="text-center">Loading users...</td></tr>';

    try {
      const res = await apiFetch("/api/admin/users");
      if (!res.ok) throw new Error("Failed to load users");
      const data = await res.json();
      const users = data.users || [];

      if (users.length === 0) {
        usersTableBody.innerHTML = '<tr><td colspan="6" class="text-center">No users found.</td></tr>';
        return;
      }

      usersTableBody.innerHTML = users.map(u => {
        const isSelf = currentUser && currentUser.id === u.id;
        const botStatus = u.botStatus || "DISCONNECTED";
        const isBotConnected = botStatus === "CONNECTED";
        const isEnabled = u.enabled;

        return `
          <tr>
            <td><strong>${escapeHtml(u.username)}</strong>${isSelf ? " (You)" : ""}</td>
            <td><span class="badge-tag badge-role">${escapeHtml(u.role)}</span></td>
            <td><span class="badge-tag ${isEnabled ? "badge-active" : "badge-disabled"}">${isEnabled ? "Enabled" : "Disabled"}</span></td>
            <td><span class="status-marker ${isBotConnected ? "connected" : "disconnected"}"></span> ${escapeHtml(botStatus)}</td>
            <td>${(u.analytics?.totalMessagesProcessed || 0).toLocaleString()}</td>
            <td>
              <button class="button-sm toggle-user-btn" data-id="${u.id}" data-enabled="${isEnabled}">${isEnabled ? "Disable" : "Enable"}</button>
              <button class="button-sm reset-pwd-btn" data-id="${u.id}" data-user="${escapeHtml(u.username)}">Password</button>
              ${!isSelf ? `<button class="button-sm button-logout delete-user-btn" data-id="${u.id}" data-user="${escapeHtml(u.username)}">Delete</button>` : ""}
            </td>
          </tr>
        `;
      }).join("");

      bindAdminRowEvents();
    } catch (err) {
      usersTableBody.innerHTML = `<tr><td colspan="6" class="text-center form-error">${escapeHtml(err.message)}</td></tr>`;
    }
  }

  function bindAdminRowEvents() {
    document.querySelectorAll(".toggle-user-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        const id = btn.dataset.id;
        const currentlyEnabled = btn.dataset.enabled === "true";
        try {
          await apiFetch(`/api/admin/users/${id}`, {
            method: "PUT",
            body: { enabled: !currentlyEnabled }
          });
          loadAdminUsers();
        } catch (err) {
          alert("Action failed: " + err.message);
        }
      });
    });

    document.querySelectorAll(".reset-pwd-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        const id = btn.dataset.id;
        const uname = btn.dataset.user;
        const newPass = prompt(`Enter new password for @${uname}:`);
        if (newPass && newPass.trim()) {
          try {
            await apiFetch(`/api/admin/users/${id}`, {
              method: "PUT",
              body: { password: newPass.trim() }
            });
            alert(`Password updated for @${uname}`);
          } catch (err) {
            alert("Password update failed: " + err.message);
          }
        }
      });
    });

    document.querySelectorAll(".delete-user-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        const id = btn.dataset.id;
        const uname = btn.dataset.user;
        if (confirm(`Are you sure you want to permanently delete user @${uname} and their WhatsApp session?`)) {
          try {
            await apiFetch(`/api/admin/users/${id}`, { method: "DELETE" });
            loadAdminUsers();
          } catch (err) {
            alert("Delete failed: " + err.message);
          }
        }
      });
    });
  }

  if (authAdminBtn) authAdminBtn.addEventListener("click", openAdminPanel);
  if (dashboardAdminBtn) dashboardAdminBtn.addEventListener("click", openAdminPanel);
  if (closeAdminBtn) closeAdminBtn.addEventListener("click", () => { if (adminModal) adminModal.hidden = true; });

  if (showAddUserBtn) {
    showAddUserBtn.addEventListener("click", () => {
      if (addUserFormContainer) addUserFormContainer.hidden = !addUserFormContainer.hidden;
    });
  }
  if (cancelAddUserBtn) {
    cancelAddUserBtn.addEventListener("click", () => {
      if (addUserFormContainer) addUserFormContainer.hidden = true;
    });
  }

  if (addUserForm) {
    addUserForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (addUserError) addUserError.hidden = true;

      const payload = {
        username: document.getElementById("newUsername").value.trim(),
        password: document.getElementById("newPassword").value,
        role: document.getElementById("newRole").value,
        settings: {
          ownerNumber: document.getElementById("newOwnerNumber").value.trim(),
          provider: document.getElementById("newProvider").value
        }
      };

      try {
        const res = await apiFetch("/api/admin/users", {
          method: "POST",
          body: payload
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
          throw new Error(data.error || "Failed to create user");
        }
        addUserForm.reset();
        if (addUserFormContainer) addUserFormContainer.hidden = true;
        loadAdminUsers();
      } catch (err) {
        if (addUserError) {
          addUserError.textContent = err.message;
          addUserError.hidden = false;
        }
      }
    });
  }

  // ==========================================
  // Session Controls
  // ==========================================

  if (startBtn) {
    startBtn.addEventListener("click", async () => {
      startBtn.disabled = true;
      try {
        await apiFetch("/api/control/start", { method: "POST" });
        await fetchStatus();
      } catch (err) {}
      startBtn.disabled = false;
    });
  }

  if (stopBtn) {
    stopBtn.addEventListener("click", async () => {
      try {
        await apiFetch("/api/control/stop", { method: "POST" });
        await fetchStatus();
      } catch (err) {}
    });
  }

  if (dashboardStopBtn) {
    dashboardStopBtn.addEventListener("click", async () => {
      try {
        await apiFetch("/api/control/stop", { method: "POST" });
        await fetchStatus();
      } catch (err) {}
    });
  }

  async function handleResetSession() {
    if (confirm("Are you sure you want to clear your active WhatsApp session and generate a new QR code?")) {
      try {
        await apiFetch("/api/control/reset_session", { method: "POST" });
        await fetchStatus();
      } catch (err) {}
    }
  }

  if (newSessionBtn) newSessionBtn.addEventListener("click", handleResetSession);
  if (dashboardNewSessionBtn) dashboardNewSessionBtn.addEventListener("click", handleResetSession);

  if (clearLog) {
    clearLog.addEventListener("click", () => {
      if (logArea) logArea.innerHTML = "";
      seenLogIds.clear();
      appendLogEntry({
        timestamp: new Date().toISOString(),
        level: "info",
        message: "[SYSTEM] Terminal log cleared."
      });
    });
  }

  // Startup initialization
  checkAuthSession();
});
