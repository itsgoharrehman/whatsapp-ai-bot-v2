/* ===== WA Bot — Main Dashboard Logic ===== */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const dom = {
    settingsModal:     $('settingsModal'),
    settingsForm:      $('settingsForm'),
    selAiProvider:     $('selAiProvider'),
    inputOwnerNumber:  $('inputOwnerNumber'),
    inputBotTag:       $('inputBotTag'),
    inputNvidiaKeys:   $('inputNvidiaKeys'),
    nvidiaKeyStatus:   $('nvidiaKeyStatus'),
    inputGroqKeys:     $('inputGroqKeys'),
    groqKeyStatus:     $('groqKeyStatus'),
    txtSystemPrompt:   $('txtSystemPrompt'),
    btnSaveSettings:   $('btnSaveSettings'),
    btnCancelSettings: $('btnCancelSettings'),
    settingsFeedback:  $('settingsFeedback'),

    mobileMenu:        $('mobileMenu'),
    hamburgerBtn:      $('hamburgerBtn'),
    drawerClose:       $('drawerClose'),
    mobileSettingsBtn: $('mobileSettingsBtn'),
    mobileAdminBtn:    $('mobileAdminBtn'),
    mobileSignOutBtn:  $('mobileSignOutBtn'),

    settingsBtn:       $('settingsBtn'),
    adminLink:         $('adminLink'),
    signOutBtn:        $('signOutBtn'),

    statusDot:         $('statusDot'),
    statusText:        $('statusText'),
    brandSubtitle:     $('brandSubtitle'),
    envLabel:          $('envLabel'),

    pairingView:       $('pairingView'),
    dashboardView:     $('dashboardView'),

    btnStart:          $('btnStart'),
    btnStop:           $('btnStop'),
    btnNewSession:     $('btnNewSession'),

    qrFrame:          $('qrFrame'),
    qrLoading:        $('qrLoading'),
    qrImage:          $('qrImage'),
    qrConnected:      $('qrConnected'),
    qrStatusText:     $('qrStatusText'),

    metricMode:        $('metricMode'),
    metricAutoReply:   $('metricAutoReply'),
    metricKeyIndex:    $('metricKeyIndex'),
    metricTotalMsgs:   $('metricTotalMsgs'),
    metricAiReplies:   $('metricAiReplies'),

    btnStopSession:    $('btnStopSession'),
    btnResetPair:      $('btnResetPair'),

    logStream:         $('logStream'),
    chkAutoScroll:     $('chkAutoScroll'),
    btnClearLogs:      $('btnClearLogs'),
  };

  /* ----- State ----- */
  let currentUser = null;
  let statusInterval = null;
  let logEventSource = null;
  let logPollInterval = null;
  let lastLogOffset = 0;

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
    if (res.status === 401) {
      localStorage.removeItem('session_token');
      localStorage.removeItem('user_data');
      window.location.href = 'login.html';
      throw new Error('Unauthorized');
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return res.json();
  }

  function timestamp() {
    return new Date().toTimeString().slice(0, 8);
  }

  /* ----- Auth Verification ----- */
  async function checkAuth() {
    try {
      const data = await apiFetch('/api/auth/me');
      currentUser = data.user || data;
      localStorage.setItem('user_data', JSON.stringify(currentUser));

      const isAdmin = currentUser.role === 'admin' || currentUser.is_admin === true;
      if (dom.adminLink) dom.adminLink.classList.toggle('hidden', !isAdmin);
      if (dom.mobileAdminBtn) dom.mobileAdminBtn.classList.toggle('hidden', !isAdmin);

      // Check status and start session cleanly once if currently disconnected
      const st = await apiFetch('/api/status').catch(() => null);
      if (st && st.status === 'DISCONNECTED' && !st.connected) {
        apiFetch('/api/control/start', { method: 'POST' }).catch(() => {});
      }

      // Start periodic status polling and load settings
      startStatusPolling();
      loadSettings().catch(() => {});
    } catch (err) {
      window.location.href = 'login.html';
    }
  }

  async function doSignOut() {
    try {
      await apiFetch('/api/auth/logout', { method: 'POST' });
    } catch (_) {}
    localStorage.removeItem('session_token');
    localStorage.removeItem('user_data');
    stopStatusPolling();
    stopLogStream();
    window.location.href = 'login.html';
  }

  function startStatusPolling() {
    stopStatusPolling();
    pollStatus();
  }

  function stopStatusPolling() {
    if (statusInterval) {
      clearTimeout(statusInterval);
      statusInterval = null;
    }
  }

  let isAutoStarting = false;

  async function pollStatus() {
    try {
      const data = await apiFetch('/api/status');
      renderStatus(data || {});
      const isConnected = data.connected === true || data.status === 'CONNECTED';
      const isQrReady = Boolean(data.qr_code || data.qr || data.qrCodeDataUrl);

      // If disconnected without QR, auto-trigger session start
      if (!isConnected && !isQrReady && !isAutoStarting && data.status === 'DISCONNECTED') {
        isAutoStarting = true;
        apiFetch('/api/control/start', { method: 'POST' })
          .catch(() => {})
          .finally(() => { setTimeout(() => { isAutoStarting = false; }, 3000); });
      }

      // Fast 1s polling while connecting / awaiting pairing, 3s once connected
      const nextDelay = !isConnected ? 1000 : 3000;
      if (statusInterval) clearTimeout(statusInterval);
      statusInterval = setTimeout(pollStatus, nextDelay);
    } catch (_) {
      if (dom.statusDot) dom.statusDot.className = 'status-dot';
      if (dom.statusText) dom.statusText.textContent = 'Disconnected';
      if (statusInterval) clearTimeout(statusInterval);
      statusInterval = setTimeout(pollStatus, 2000);
    }
  }

  function renderStatus(data) {
    const isConnected = data.connected === true || data.status === 'CONNECTED';
    const isConnecting = data.status === 'CONNECTING';
    const isQrReady = (data.status === 'QR_READY' || data.qr || data.qr_code) && !isConnected;

    // Status Dot and Text
    if (dom.statusDot) {
      dom.statusDot.className = 'status-dot' + (isConnected ? ' connected' : (isConnecting ? ' danger' : ''));
    }
    if (dom.statusText) {
      dom.statusText.textContent = isConnected ? 'Connected' : (isConnecting ? 'Connecting...' : 'Disconnected');
    }

    if (isConnected) {
      // Show Dashboard View, Hide Pairing View
      if (dom.pairingView) dom.pairingView.classList.add('hidden');
      if (dom.dashboardView) dom.dashboardView.classList.remove('hidden');
      if (dom.brandSubtitle) dom.brandSubtitle.classList.add('hidden');
      if (dom.envLabel) dom.envLabel.classList.remove('hidden');

      // Update Dashboard Metrics
      if (dom.metricMode) dom.metricMode.textContent = data.operating_mode || data.mode || 'Auto';
      if (dom.metricAutoReply) {
        const auto = data.auto_reply !== undefined ? data.auto_reply : data.autoReply;
        dom.metricAutoReply.textContent = auto ? 'On' : 'Off';
        dom.metricAutoReply.className = 'metric-value' + (auto ? ' green' : '');
      }
      if (dom.metricKeyIndex) {
        dom.metricKeyIndex.textContent = data.active_key_index !== undefined ? data.active_key_index : (data.key_index || '0');
      }
      if (dom.metricTotalMsgs) {
        dom.metricTotalMsgs.textContent = data.messages_processed ?? data.total_messages ?? 0;
      }
      if (dom.metricAiReplies) {
        dom.metricAiReplies.textContent = data.ai_replies ?? data.total_replies ?? 0;
      }

      // Start live logs if not already streaming
      startLogStream();
    } else {
      // Show Pairing View, Hide Dashboard View
      if (dom.pairingView) dom.pairingView.classList.remove('hidden');
      if (dom.dashboardView) dom.dashboardView.classList.add('hidden');
      if (dom.brandSubtitle) dom.brandSubtitle.classList.remove('hidden');
      if (dom.envLabel) dom.envLabel.classList.add('hidden');

      stopLogStream();

      // Handle QR State
      const qrData = data.qr_code || data.qr || data.qrCodeDataUrl;
      if (qrData) {
        if (dom.qrLoading) dom.qrLoading.classList.add('hidden');
        if (dom.qrConnected) dom.qrConnected.classList.add('hidden');
        if (dom.qrImage) {
          dom.qrImage.src = qrData.startsWith('data:') || qrData.startsWith('http') ? qrData : 'data:image/png;base64,' + qrData;
          dom.qrImage.classList.remove('hidden');
        }
        if (dom.qrStatusText) dom.qrStatusText.textContent = 'Scan QR code with WhatsApp';
      } else {
        if (dom.qrLoading) dom.qrLoading.classList.remove('hidden');
        if (dom.qrImage) dom.qrImage.classList.add('hidden');
        if (dom.qrConnected) dom.qrConnected.classList.add('hidden');
        if (dom.qrStatusText) dom.qrStatusText.textContent = isConnecting ? 'Initializing WhatsApp session...' : 'Generating QR code...';
      }
    }
  }

  /* ----- WhatsApp Control Actions ----- */
  async function triggerControl(action, btnEl) {
    if (btnEl) btnEl.disabled = true;
    try {
      try {
        await apiFetch('/api/control', {
          method: 'POST',
          body: JSON.stringify({ action })
        });
      } catch (err) {
        // Fallback for legacy /api/start, /api/stop, /api/reset endpoints
        const altEndpoint = action === 'reset' ? '/api/reset_session' : `/api/${action}`;
        await apiFetch(altEndpoint, { method: 'POST' });
      }
      appendLogLine(`Action requested: ${action}`);
      setTimeout(pollStatus, 500);
    } catch (err) {
      appendLogLine(`Action: ${action} (${err.message || 'processed'})`);
    } finally {
      if (btnEl) btnEl.disabled = false;
    }
  }

  /* ----- Real-time Event Terminal Logs ----- */
  function startLogStream() {
    if (logEventSource || logPollInterval) return;

    const token = getToken();
    const streamUrl = `/api/logs/stream?token=${encodeURIComponent(token)}`;

    try {
      logEventSource = new EventSource(streamUrl);

      logEventSource.onmessage = function (ev) {
        try {
          const payload = JSON.parse(ev.data);
          if (payload.type === 'history' && Array.isArray(payload.logs)) {
            payload.logs.forEach(l => appendLogLine(typeof l === 'string' ? l : (l.message || '')));
          } else if (payload.type === 'log' && payload.log) {
            appendLogLine(typeof payload.log === 'string' ? payload.log : (payload.log.message || ''));
          } else if (payload.message) {
            appendLogLine(payload.message);
          }
        } catch (_) {
          appendLogLine(ev.data);
        }
      };

      logEventSource.onerror = function () {
        stopLogStream();
        logPollInterval = setInterval(pollLogs, 3000);
      };
    } catch (_) {
      logPollInterval = setInterval(pollLogs, 3000);
    }
  }

  function stopLogStream() {
    if (logEventSource) {
      logEventSource.close();
      logEventSource = null;
    }
    if (logPollInterval) {
      clearInterval(logPollInterval);
      logPollInterval = null;
    }
  }

  async function pollLogs() {
    try {
      const data = await apiFetch('/api/logs?offset=' + lastLogOffset);
      const logs = Array.isArray(data) ? data : (data.logs || []);
      if (logs && logs.length > 0) {
        logs.forEach(l => appendLogLine(typeof l === 'string' ? l : (l.message || l.msg || '')));
        lastLogOffset += logs.length;
      }
    } catch (_) {}
  }

  function appendLogLine(raw) {
    if (!raw || !dom.logStream) return;
    const line = document.createElement('span');
    line.className = 'log-line';
    line.textContent = `[${timestamp()}] ${raw}`;
    dom.logStream.appendChild(line);

    // Keep terminal buffer capped
    while (dom.logStream.childElementCount > 300) {
      dom.logStream.removeChild(dom.logStream.firstChild);
    }

    if (dom.chkAutoScroll && dom.chkAutoScroll.checked) {
      dom.logStream.scrollTop = dom.logStream.scrollHeight;
    }
  }

  /* ----- AI & Account Settings ----- */
  async function loadSettings() {
    try {
      const data = await apiFetch('/api/settings');
      if (dom.selAiProvider) dom.selAiProvider.value = data.ai_provider || data.provider || 'nvidia';
      if (dom.inputOwnerNumber) dom.inputOwnerNumber.value = data.owner_number || data.ownerNumber || '';
      if (dom.inputBotTag) dom.inputBotTag.value = data.bot_tag || data.botTag || '';
      if (dom.inputNvidiaKeys) dom.inputNvidiaKeys.value = Array.isArray(data.nvidia_keys) ? data.nvidia_keys.join(', ') : (data.nvidia_keys || '');
      if (dom.inputGroqKeys) dom.inputGroqKeys.value = Array.isArray(data.groq_keys) ? data.groq_keys.join(', ') : (data.groq_keys || '');
      if (dom.txtSystemPrompt) dom.txtSystemPrompt.value = data.system_prompt || data.systemPrompt || '';

      updateKeyStatus(dom.nvidiaKeyStatus, data.nvidia_keys);
      updateKeyStatus(dom.groqKeyStatus, data.groq_keys);
    } catch (_) {}
  }

  function updateKeyStatus(el, keys) {
    if (!el) return;
    const count = Array.isArray(keys) ? keys.length : (keys ? 1 : 0);
    if (count > 0) {
      el.textContent = `${count} key(s) configured`;
      el.className = 'key-status valid';
    } else {
      el.textContent = 'No keys configured';
      el.className = 'key-status neutral';
    }
  }

  function openSettings() {
    loadSettings().catch(() => {});
    if (dom.settingsFeedback) {
      dom.settingsFeedback.textContent = '';
      dom.settingsFeedback.className = 'settings-feedback';
    }
    if (dom.settingsModal) dom.settingsModal.classList.remove('hidden');
    closeMobileMenu();
  }

  function closeSettings() {
    if (dom.settingsModal) dom.settingsModal.classList.add('hidden');
  }

  async function saveSettings(e) {
    e.preventDefault();
    if (dom.settingsFeedback) {
      dom.settingsFeedback.textContent = '';
      dom.settingsFeedback.className = 'settings-feedback';
    }
    if (dom.btnSaveSettings) dom.btnSaveSettings.disabled = true;

    const payload = {
      provider: dom.selAiProvider ? dom.selAiProvider.value : 'nvidia',
      owner_number: dom.inputOwnerNumber ? dom.inputOwnerNumber.value.trim() : '',
      bot_tag: dom.inputBotTag ? dom.inputBotTag.value.trim() : '',
      nvidia_keys: dom.inputNvidiaKeys ? dom.inputNvidiaKeys.value.split(',').map(s => s.trim()).filter(Boolean) : [],
      groq_keys: dom.inputGroqKeys ? dom.inputGroqKeys.value.split(',').map(s => s.trim()).filter(Boolean) : [],
      system_prompt: dom.txtSystemPrompt ? dom.txtSystemPrompt.value : ''
    };

    try {
      await apiFetch('/api/settings', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      if (dom.settingsFeedback) {
        dom.settingsFeedback.textContent = 'Settings saved successfully.';
        dom.settingsFeedback.className = 'settings-feedback success';
      }
      setTimeout(closeSettings, 1000);
    } catch (err) {
      if (dom.settingsFeedback) {
        dom.settingsFeedback.textContent = 'Failed to save settings.';
        dom.settingsFeedback.className = 'settings-feedback error';
      }
    } finally {
      if (dom.btnSaveSettings) dom.btnSaveSettings.disabled = false;
    }
  }

  /* ----- Mobile Dropdown Popup ----- */
  function toggleMobileMenu(e) {
    if (e) e.stopPropagation();
    if (!dom.mobileMenu) return;
    const isHidden = dom.mobileMenu.classList.contains('hidden');
    if (isHidden) {
      dom.mobileMenu.classList.remove('hidden');
      if (dom.hamburgerBtn) dom.hamburgerBtn.setAttribute('aria-expanded', 'true');
    } else {
      closeMobileMenu();
    }
  }

  function closeMobileMenu() {
    if (dom.mobileMenu) dom.mobileMenu.classList.add('hidden');
    if (dom.hamburgerBtn) dom.hamburgerBtn.setAttribute('aria-expanded', 'false');
  }

  /* ----- Event Listeners ----- */
  function bindEvents() {
    if (dom.signOutBtn) dom.signOutBtn.addEventListener('click', doSignOut);
    if (dom.mobileSignOutBtn) dom.mobileSignOutBtn.addEventListener('click', () => { closeMobileMenu(); doSignOut(); });

    if (dom.settingsBtn) dom.settingsBtn.addEventListener('click', openSettings);
    if (dom.mobileSettingsBtn) dom.mobileSettingsBtn.addEventListener('click', () => { closeMobileMenu(); openSettings(); });
    if (dom.btnCancelSettings) dom.btnCancelSettings.addEventListener('click', closeSettings);
    if (dom.settingsForm) dom.settingsForm.addEventListener('submit', saveSettings);

    if (dom.hamburgerBtn) dom.hamburgerBtn.addEventListener('click', toggleMobileMenu);

    // Auto-close dropdown when clicking anywhere outside
    document.addEventListener('click', (e) => {
      if (dom.mobileMenu && !dom.mobileMenu.contains(e.target) && e.target !== dom.hamburgerBtn && !dom.hamburgerBtn.contains(e.target)) {
        closeMobileMenu();
      }
    });

    if (dom.btnStart) dom.btnStart.addEventListener('click', () => triggerControl('start', dom.btnStart));
    if (dom.btnStop) dom.btnStop.addEventListener('click', () => triggerControl('stop', dom.btnStop));
    if (dom.btnNewSession) dom.btnNewSession.addEventListener('click', () => triggerControl('reset_session', dom.btnNewSession));

    if (dom.btnStopSession) dom.btnStopSession.addEventListener('click', () => triggerControl('stop', dom.btnStopSession));
    if (dom.btnResetPair) dom.btnResetPair.addEventListener('click', () => triggerControl('reset_session', dom.btnResetPair));

    if (dom.btnClearLogs) {
      dom.btnClearLogs.addEventListener('click', () => {
        if (dom.logStream) dom.logStream.innerHTML = '';
        lastLogOffset = 0;
      });
    }

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeSettings();
        closeMobileMenu();
      }
    });
  }

  /* ----- Initialize ----- */
  document.addEventListener('DOMContentLoaded', () => {
    bindEvents();
    checkAuth();
  });
})();
