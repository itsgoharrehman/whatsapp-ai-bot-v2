"use strict";

document.addEventListener("DOMContentLoaded", () => {
  // Authentication State
  let authToken = localStorage.getItem("whatsapp_bot_token") || null;
  let currentUser = null;
  let sseSource = null;

  // Views & Overlays
  const authView = document.getElementById("authView");
  const dashboardView = document.getElementById("dashboardView");
  const loginOverlay = document.getElementById("loginOverlay");
  const settingsModal = document.getElementById("settingsModal");

  // Topbar Actions
  const authActions = document.getElementById("authActions");
  const dashActions = document.getElementById("dashActions");
  const authSettingsBtn = document.getElementById("authSettingsBtn");
  const dashboardSettingsBtn = document.getElementById("dashboardSettingsBtn");
  const authAdminLink = document.getElementById("authAdminLink");
  const dashboardAdminLink = document.getElementById("dashboardAdminLink");
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

  // Login Form Elements
  const loginForm = document.getElementById("loginForm");
  const loginUsername = document.getElementById("loginUsername");
  const loginPassword = document.getElementById("loginPassword");
  const loginError = document.getElementById("loginError");

  // Settings Form Elements
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
    if (statusInterval) clearInterval(statusInterval);
    if (logsInterval) clearInterval(logsInterval);

    loginOverlay.hidden = false;
    authActions.hidden = true;
    dashActions.hidden = true;
  }

  // ==========================================
  // Authentication Lifecycle
  // ==========================================

  async function checkAuth() {
    if (!authToken) {
      handleAuthRequired();
      return;
    }

    try {
      const res = await apiFetch("/api/auth/me");
      const data = await res.json();
      if (data && data.user) {
        currentUser = data.user;
        onAuthenticated();
      } else {
        handleAuthRequired();
      }
    } catch (err) {
      handleAuthRequired();
    }
  }

  function onAuthenticated() {
    loginOverlay.hidden = true;
    authActions.hidden = false;
    dashActions.hidden = false;

    // Show Admin Link if user is admin
    const isAdmin = currentUser && currentUser.role === "admin";
    if (authAdminLink) authAdminLink.hidden = !isAdmin;
    if (dashboardAdminLink) dashboardAdminLink.hidden = !isAdmin;

    startStatusPolling();
    setupLogStream();
  }

  // Login Form Submission
  loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    loginError.hidden = true;
    const username = loginUsername.value.trim();
    const password = loginPassword.value.trim();

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password })
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        loginError.textContent = data.error || "Login failed";
        loginError.hidden = false;
        return;
      }

      authToken = data.token;
      currentUser = data.user;
      localStorage.setItem("whatsapp_bot_token", authToken);
      loginForm.reset();
      onAuthenticated();
    } catch (err) {
      loginError.textContent = "Network error: " + err.message;
      loginError.hidden = false;
    }
  });

  // Logout Handlers
  async function handleLogout() {
    try {
      await apiFetch("/api/auth/logout", { method: "POST" });
    } catch (err) {}
    handleAuthRequired();
  }

  if (authLogoutBtn) authLogoutBtn.addEventListener("click", handleLogout);
  if (dashboardLogoutBtn) dashboardLogoutBtn.addEventListener("click", handleLogout);

  // ==========================================
  // Settings & BYOK
  // ==========================================

  async function openSettings() {
    settingsSuccess.hidden = true;
    settingsError.hidden = true;
    try {
      const res = await apiFetch("/api/settings");
      const data = await res.json();
      const s = data.settings || {};
      const k = data.keys || {};

      settingsProvider.value = s.provider || "nvidia";
      settingsOwnerNumber.value = s.ownerNumber || "";
      settingsSystemPrompt.value = s.systemPrompt || "";
      settingsNvidiaKeys.value = "";
      settingsGroqKeys.value = "";

      const nvKeyMasked = k.nvidiaKeysMasked && k.nvidiaKeysMasked[0] ? k.nvidiaKeysMasked[0] : "None";
      const groqKeyMasked = k.groqKeysMasked && k.groqKeysMasked[0] ? k.groqKeysMasked[0] : "None";

      nvidiaKeyStatus.textContent = `Active Key: ${nvKeyMasked}`;
      groqKeyStatus.textContent = `Active Key: ${groqKeyMasked}`;

      settingsModal.hidden = false;
    } catch (err) {
      console.error("Failed to load settings:", err);
    }
  }

  if (authSettingsBtn) authSettingsBtn.addEventListener("click", openSettings);
  if (dashboardSettingsBtn) dashboardSettingsBtn.addEventListener("click", openSettings);
  if (closeSettingsBtn) closeSettingsBtn.addEventListener("click", () => settingsModal.hidden = true);
  if (cancelSettingsBtn) cancelSettingsBtn.addEventListener("click", () => settingsModal.hidden = true);

  settingsForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    settingsSuccess.hidden = true;
    settingsError.hidden = true;

    const payload = {
      settings: {
        provider: settingsProvider.value,
        ownerNumber: settingsOwnerNumber.value.trim(),
        systemPrompt: settingsSystemPrompt.value.trim()
      }
    };

    const nvInput = settingsNvidiaKeys.value.trim();
    if (nvInput) {
      payload.nvidiaKeys = nvInput.split(",").map(k => k.trim()).filter(Boolean);
    }
    const groqInput = settingsGroqKeys.value.trim();
    if (groqInput) {
      payload.groqKeys = groqInput.split(",").map(k => k.trim()).filter(Boolean);
    }

    try {
      const res = await apiFetch("/api/settings", {
        method: "POST",
        body: payload
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        settingsError.textContent = data.error || "Failed to save settings";
        settingsError.hidden = false;
        return;
      }
      settingsSuccess.hidden = false;
      setTimeout(() => {
        settingsModal.hidden = true;
      }, 1000);
    } catch (err) {
      settingsError.textContent = err.message;
      settingsError.hidden = false;
    }
  });

  // ==========================================
  // Bot Status & Controls
  // ==========================================

  function updateStatusIndicator(el, statusText, statusClass) {
    if (!el) return;
    el.className = `status ${statusClass}`;
    const txt = el.querySelector(".status-text") || el;
    txt.textContent = statusText;
  }

  function setView(isLive) {
    if (isLive) {
      if (authView.style.display !== "none") authView.style.display = "none";
      if (dashboardView.style.display !== "block") dashboardView.style.display = "block";
      authView.hidden = true;
      dashboardView.hidden = false;
    } else {
      if (dashboardView.style.display !== "none") dashboardView.style.display = "none";
      if (authView.style.display !== "block") authView.style.display = "block";
      dashboardView.hidden = true;
      authView.hidden = false;
    }
  }

  function renderStatus(data) {
    if (!data) return;
    const status = data.status || "DISCONNECTED";

    if (data.analytics) {
      if (totalMessages) totalMessages.textContent = data.analytics.totalProcessed || 0;
      if (totalReplies) totalReplies.textContent = data.analytics.totalReplies || 0;
    }
    if (data.autoReply !== undefined && autoReplyState) {
      autoReplyState.textContent = data.autoReply ? "ACTIVE" : "DISABLED";
    }
    if (data.keyIndices && activeAiKey) {
      activeAiKey.textContent = `NVIDIA: #${data.keyIndices.nvidia || 0} | Groq: #${data.keyIndices.groq || 0}`;
    }

    if (status === "CONNECTED") {
      setView(true);
      updateStatusIndicator(dashboardStatus, "CONNECTED", "connected");
      if (dashboardStatusText) dashboardStatusText.textContent = "CONNECTED";
    } else if (status === "CONNECTING") {
      setView(false);
      updateStatusIndicator(authStatus, "CONNECTING", "connecting");
      showQrState("loading", "Connecting to WhatsApp...", "Please wait while session initializes.");
    } else if (status === "QR_READY" && data.qrCodeDataUrl) {
      setView(false);
      updateStatusIndicator(authStatus, "QR_READY", "connecting");
      if (qrImage) qrImage.src = data.qrCodeDataUrl;
      showQrState("ready");
    } else {
      setView(false);
      updateStatusIndicator(authStatus, "DISCONNECTED", "disconnected");
      showQrState("loading", "Service Disconnected", "Click Start to generate pairing QR code.");
    }
  }

  function showQrState(state, title, copy) {
    if (qrLoading) qrLoading.classList.remove("active");
    if (qrReady) qrReady.classList.remove("active");
    if (qrConnected) qrConnected.classList.remove("active");

    if (state === "loading" && qrLoading) {
      qrLoading.classList.add("active");
      if (title && qrStateTitle) qrStateTitle.textContent = title;
      if (copy && qrStateCopy) qrStateCopy.textContent = copy;
    } else if (state === "ready" && qrReady) {
      qrReady.classList.add("active");
    } else if (state === "connected" && qrConnected) {
      qrConnected.classList.add("active");
    }
  }

  async function fetchStatus() {
    if (!authToken) return;
    try {
      const res = await apiFetch("/api/status");
      const data = await res.json();
      renderStatus(data);
    } catch (err) {}
  }

  function startStatusPolling() {
    if (statusInterval) clearInterval(statusInterval);
    fetchStatus();
    statusInterval = setInterval(fetchStatus, 3000);
  }

  // Button Actions
  async function triggerAction(endpoint, btn) {
    if (btn) btn.disabled = true;
    try {
      await apiFetch(endpoint, { method: "POST" });
      setTimeout(fetchStatus, 500);
    } catch (err) {
      console.error("Action error:", err);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  if (startBtn) startBtn.addEventListener("click", () => triggerAction("/api/control/start", startBtn));
  if (stopBtn) stopBtn.addEventListener("click", () => triggerAction("/api/control/stop", stopBtn));
  if (newSessionBtn) newSessionBtn.addEventListener("click", () => triggerAction("/api/control/reset_session", newSessionBtn));
  if (dashboardStopBtn) dashboardStopBtn.addEventListener("click", () => triggerAction("/api/control/stop", dashboardStopBtn));
  if (dashboardNewSessionBtn) dashboardNewSessionBtn.addEventListener("click", () => triggerAction("/api/control/reset_session", dashboardNewSessionBtn));

  // ==========================================
  // Terminal Log Stream
  // ==========================================

  function appendLog(line) {
    if (!logArea || !line) return;
    const logId = line.id || `${line.timestamp || Date.now()}-${line.message}`;
    if (seenLogIds.has(logId)) return;
    seenLogIds.add(logId);

    const logText = typeof line === "string" ? line : `[${line.timestamp || new Date().toISOString()}] [${line.level || "INFO"}] ${line.message}`;
    logArea.textContent += logText + "\n";

    if (autoScroll && autoScroll.checked) {
      logArea.scrollTop = logArea.scrollHeight;
    }
  }

  function setupLogStream() {
    if (sseSource) {
      sseSource.close();
      sseSource = null;
    }

    try {
      const streamUrl = `/api/logs/stream?token=${encodeURIComponent(authToken || "")}`;
      sseSource = new EventSource(streamUrl);

      sseSource.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data);
          if (payload.type === "history" && Array.isArray(payload.logs)) {
            payload.logs.forEach(appendLog);
          } else if (payload.type === "log" && payload.log) {
            appendLog(payload.log);
          }
        } catch (e) {
          appendLog(event.data);
        }
      };

      sseSource.onerror = () => {
        if (sseSource) sseSource.close();
        sseSource = null;
        startLogFallback();
      };
    } catch (e) {
      startLogFallback();
    }
  }

  function startLogFallback() {
    if (logsInterval) return;
    logsInterval = setInterval(async () => {
      if (!authToken) return;
      try {
        const res = await apiFetch("/api/logs");
        const logs = await res.json();
        if (Array.isArray(logs)) {
          logs.forEach(appendLog);
        }
      } catch (err) {}
    }, 4000);
  }

  if (clearLog) {
    clearLog.addEventListener("click", () => {
      if (logArea) logArea.textContent = "";
      seenLogIds.clear();
    });
  }

  // Check auth state on load
  checkAuth();
});
