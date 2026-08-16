/* ===== WA Bot — Main Dashboard Logic ===== */
(function () {
  'use strict';

  /* ----- DOM refs ----- */
  const $ = (id) => document.getElementById(id);

  const dom = {
    loginModal:       $('loginModal'),
    loginForm:        $('loginForm'),
    loginUsername:    $('loginUsername'),
    loginPassword:    $('loginPassword'),
    loginBtn:         $('loginBtn'),
    loginError:       $('loginError'),

    settingsModal:    $('settingsModal'),
    settingsForm:     $('settingsForm'),
    selAiProvider:    $('selAiProvider'),
    inputOwnerNumber: $('inputOwnerNumber'),
    inputNvidiaKeys:  $('inputNvidiaKeys'),
    nvidiaKeyStatus:  $('nvidiaKeyStatus'),
    inputGroqKeys:    $('inputGroqKeys'),
    groqKeyStatus:    $('groqKeyStatus'),
    txtSystemPrompt:  $('txtSystemPrompt'),
    btnSaveSettings:  $('btnSaveSettings'),
    btnCancelSettings:$('btnCancelSettings'),
    settingsFeedback: $('settingsFeedback'),

    mobileMenu:       $('mobileMenu'),
    hamburgerBtn:     $('hamburgerBtn'),
    drawerClose:      $('drawerClose'),
    mobileSettingsBtn:$('mobileSettingsBtn'),
    mobileAdminBtn:   $('mobileAdminBtn'),
    mobileSignOutBtn: $('mobileSignOutBtn'),

    settingsBtn:      $('settingsBtn'),
    adminLink:        $('adminLink'),
    signOutBtn:       $('signOutBtn'),

    statusDot:        $('statusDot'),
    statusText:       $('statusText'),
    brandSubtitle:    $('brandSubtitle'),
    envLabel:         $('envLabel'),

    pairingView:      $('pairingView'),
    dashboardView:    $('dashboardView'),

    btnStart:         $('btnStart'),
    btnStop:          $('btnStop'),
    btnNewSession:    $('btnNewSession'),

    qrFrame:         $('qrFrame'),
    qrLoading:       $('qrLoading'),
    qrImage:         $('qrImage'),
    qrConnected:     $('qrConnected'),
    qrStatusText:    $('qrStatusText'),

    metricMode:       $('metricMode'),
    metricAutoReply:  $('metricAutoReply'),
    metricKeyIndex:   $('metricKeyIndex'),
    metricTotalMsgs:  $('metricTotalMsgs'),
    metricAiReplies:  $('metricAiReplies'),

    btnStopSession:   $('btnStopSession'),
    btnResetPair:     $('btnResetPair'),

    logStream:        $('logStream'),
    chkAutoScroll:    $('chkAutoScroll'),
    btnClearLogs:     $('btnClearLogs'),
  };

  /* ----- State ----- */
  let isAuthenticated = false;
  let userRole = null;
  let statusInterval = null;
  let logEventSource = null;
  let logPollInterval = null;
  let lastLogOffset = 0;

  /* ----- API base ----- */
  const API = '';

  /* ----- Helpers ----- */
  function show(el) { el && el.classList.remove('hidden'); }
  function hide(el) { el && el.classList.add('hidden'); }

  function fetchJSON(url, options) {
    return fetch(API + url, {
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      credentials: 'same-origin',
      ...options,
    }).then((r) => {
      if (r.status === 401) { handleAuthLost(); throw new Error('Unauthorized'); }
      if (!r.ok) throw new Error('Request failed: ' + r.status);
      return r.json();
    });
  }

  function timestamp() {
    const d = new Date();
    return d.toTimeString().slice(0, 8);
  }

  /* ----- Auth ----- */
  function handleAuthLost() {
    isAuthenticated = false;
    userRole = null;
    show(dom.loginModal);
    stopPolling();
    stopLogStream();
  }

  async function checkAuth() {
    try {
      const data = await fetchJSON('/api/auth/me');
      isAuthenticated = true;
      userRole = data.role || 'user';
      hide(dom.loginModal);
      applyRole();
      startPolling();
    } catch {
      isAuthenticated = false;
      show(dom.loginModal);
    }
  }

  async function doLogin(e) {
    e.preventDefault();
    dom.loginError.textContent = '';
    const username = dom.loginUsername.value.trim();
    const password = dom.loginPassword.value;
    if (!username || !password) { dom.loginError.textContent = 'Enter username and password'; return; }
    try {
      const data = await fetchJSON('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      });
      isAuthenticated = true;
      userRole = data.role || 'user';
      hide(dom.loginModal);
      applyRole();
      startPolling();
    } catch (err) {
      dom.loginError.textContent = 'Invalid credentials';
    }
  }

  async function doSignOut() {
    try { await fetchJSON('/api/auth/logout', { method: 'POST' }); } catch {}
    isAuthenticated = false;
    userRole = null;
    stopPolling();
    stopLogStream();
    show(dom.loginModal);
    closeMobileMenu();
  }

  function applyRole() {
    if (userRole === 'admin') {
      show(dom.adminLink);
      show(dom.mobileAdminBtn);
    } else {
      hide(dom.adminLink);
      hide(dom.mobileAdminBtn);
    }
  }

  /* ----- Status Polling ----- */
  function startPolling() {
    stopPolling();
    pollStatus();
    statusInterval = setInterval(pollStatus, 4000);
  }

  function stopPolling() {
    if (statusInterval) { clearInterval(statusInterval); statusInterval = null; }
  }

  async function pollStatus() {
    try {
      const data = await fetchJSON('/api/status');
      updateUI(data);
    } catch {}
  }

  /* ----- UI State Switch ----- */
  function updateUI(data) {
    const connected = data.connected === true;
    const qrReady = data.qr_code && !connected;

    /* Top bar status */
    dom.statusDot.className = 'status-dot' + (connected ? ' connected' : '');
    dom.statusText.textContent = connected ? 'Connected' : 'Disconnected';

    if (connected) {
      hide(dom.pairingView);
      show(dom.dashboardView);
      hide(dom.brandSubtitle);
      show(dom.envLabel);

      dom.metricMode.textContent = data.operating_mode || 'Auto';
      dom.metricAutoReply.textContent = data.auto_reply ? 'On' : 'Off';
      dom.metricAutoReply.className = 'metric-value' + (data.auto_reply ? ' green' : '');
      dom.metricKeyIndex.textContent = data.active_key_index != null ? data.active_key_index : '—';
      dom.metricTotalMsgs.textContent = data.total_messages || 0;
      dom.metricAiReplies.textContent = data.ai_replies || 0;

      startLogStream();
    } else {
      show(dom.pairingView);
      hide(dom.dashboardView);
      show(dom.brandSubtitle);
      hide(dom.envLabel);
      stopLogStream();

      /* QR states */
      if (qrReady) {
        hide(dom.qrLoading);
        show(dom.qrImage);
        hide(dom.qrConnected);
        dom.qrImage.src = data.qr_code;
        dom.qrStatusText.textContent = 'Scan with WhatsApp to pair';
      } else if (data.session_loading) {
        show(dom.qrLoading);
        hide(dom.qrImage);
        hide(dom.qrConnected);
        dom.qrStatusText.textContent = 'Generating QR code...';
      } else {
        hide(dom.qrLoading);
        hide(dom.qrImage);
        hide(dom.qrConnected);
        dom.qrStatusText.textContent = 'Waiting for session start';
      }
    }
  }

  /* ----- Log Streaming ----- */
  function startLogStream() {
    if (logEventSource || logPollInterval) return;

    /* Try SSE first */
    try {
      logEventSource = new EventSource(API + '/api/logs/stream');
      logEventSource.onmessage = function (ev) {
        appendLogLine(ev.data);
      };
      logEventSource.onerror = function () {
        /* Fallback to polling */
        stopLogStream();
        logPollInterval = setInterval(pollLogs, 3000);
      };
    } catch {
      logPollInterval = setInterval(pollLogs, 3000);
    }
  }

  function stopLogStream() {
    if (logEventSource) { logEventSource.close(); logEventSource = null; }
    if (logPollInterval) { clearInterval(logPollInterval); logPollInterval = null; }
  }

  async function pollLogs() {
    try {
      const data = await fetchJSON('/api/logs?offset=' + lastLogOffset);
      if (data && data.logs && data.logs.length) {
        data.logs.forEach(function (line) { appendLogLine(line); });
        lastLogOffset += data.logs.length;
      }
    } catch {}
  }

  function appendLogLine(raw) {
    const line = document.createElement('span');
    line.className = 'log-line';
    line.textContent = '[' + timestamp() + '] ' + raw;
    dom.logStream.appendChild(line);
    if (dom.chkAutoScroll.checked) {
      dom.logStream.scrollTop = dom.logStream.scrollHeight;
    }
  }

  /* ----- Controls ----- */
  async function controlAction(endpoint) {
    try {
      await fetchJSON('/api/' + endpoint, { method: 'POST' });
      appendLogLine('Action: ' + endpoint);
      setTimeout(pollStatus, 800);
    } catch (err) {
      appendLogLine('Error: ' + endpoint + ' failed');
    }
  }

  /* ----- Settings ----- */
  async function openSettings() {
    dom.settingsFeedback.textContent = '';
    dom.settingsFeedback.className = 'settings-feedback';
    try {
      const data = await fetchJSON('/api/settings');
      dom.selAiProvider.value = data.ai_provider || 'auto';
      dom.inputOwnerNumber.value = data.owner_number || '';
      dom.inputNvidiaKeys.value = (data.nvidia_keys || []).join(',');
      dom.inputGroqKeys.value = (data.groq_keys || []).join(',');
      dom.txtSystemPrompt.value = data.system_prompt || '';
      updateKeyStatus(dom.nvidiaKeyStatus, data.nvidia_keys);
      updateKeyStatus(dom.groqKeyStatus, data.groq_keys);
    } catch {}
    show(dom.settingsModal);
    closeMobileMenu();
  }

  function closeSettings() {
    hide(dom.settingsModal);
  }

  async function saveSettings(e) {
    e.preventDefault();
    dom.settingsFeedback.textContent = '';
    dom.settingsFeedback.className = 'settings-feedback';
    const payload = {
      ai_provider: dom.selAiProvider.value,
      owner_number: dom.inputOwnerNumber.value.trim(),
      nvidia_keys: dom.inputNvidiaKeys.value.split(',').map(function (k) { return k.trim(); }).filter(Boolean),
      groq_keys: dom.inputGroqKeys.value.split(',').map(function (k) { return k.trim(); }).filter(Boolean),
      system_prompt: dom.txtSystemPrompt.value,
    };
    try {
      await fetchJSON('/api/settings', { method: 'POST', body: JSON.stringify(payload) });
      dom.settingsFeedback.textContent = 'Settings saved';
      dom.settingsFeedback.className = 'settings-feedback success';
    } catch {
      dom.settingsFeedback.textContent = 'Failed to save settings';
      dom.settingsFeedback.className = 'settings-feedback error';
    }
  }

  function updateKeyStatus(el, keys) {
    if (!keys || !keys.length) {
      el.textContent = 'No keys configured';
      el.className = 'key-status neutral';
    } else {
      el.textContent = keys.length + ' key' + (keys.length > 1 ? 's' : '') + ' configured';
      el.className = 'key-status valid';
    }
  }

  /* ----- Mobile Menu ----- */
  function openMobileMenu() {
    dom.mobileMenu.classList.add('open');
    dom.mobileMenu.setAttribute('aria-hidden', 'false');
    dom.hamburgerBtn.setAttribute('aria-expanded', 'true');
  }

  function closeMobileMenu() {
    dom.mobileMenu.classList.remove('open');
    dom.mobileMenu.setAttribute('aria-hidden', 'true');
    dom.hamburgerBtn.setAttribute('aria-expanded', 'false');
  }

  /* ----- Event Bindings ----- */
  dom.loginForm.addEventListener('submit', doLogin);
  dom.signOutBtn.addEventListener('click', doSignOut);
  dom.mobileSignOutBtn.addEventListener('click', doSignOut);

  dom.hamburgerBtn.addEventListener('click', openMobileMenu);
  dom.drawerClose.addEventListener('click', closeMobileMenu);
  dom.mobileMenu.addEventListener('click', function (e) {
    if (e.target === dom.mobileMenu) closeMobileMenu();
  });

  dom.settingsBtn.addEventListener('click', openSettings);
  dom.mobileSettingsBtn.addEventListener('click', openSettings);
  dom.btnCancelSettings.addEventListener('click', closeSettings);
  dom.settingsForm.addEventListener('submit', saveSettings);

  dom.btnStart.addEventListener('click', function () { controlAction('start'); });
  dom.btnStop.addEventListener('click', function () { controlAction('stop'); });
  dom.btnNewSession.addEventListener('click', function () { controlAction('reset_session'); });

  dom.btnStopSession.addEventListener('click', function () { controlAction('stop'); });
  dom.btnResetPair.addEventListener('click', function () { controlAction('reset_session'); });

  dom.btnClearLogs.addEventListener('click', function () {
    dom.logStream.innerHTML = '';
    lastLogOffset = 0;
  });

  /* Live key status while typing */
  dom.inputNvidiaKeys.addEventListener('input', function () {
    const keys = dom.inputNvidiaKeys.value.split(',').map(function (k) { return k.trim(); }).filter(Boolean);
    updateKeyStatus(dom.nvidiaKeyStatus, keys);
  });
  dom.inputGroqKeys.addEventListener('input', function () {
    const keys = dom.inputGroqKeys.value.split(',').map(function (k) { return k.trim(); }).filter(Boolean);
    updateKeyStatus(dom.groqKeyStatus, keys);
  });

  /* Keyboard: Escape to close overlays */
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      if (!dom.settingsModal.classList.contains('hidden')) closeSettings();
      if (dom.mobileMenu.classList.contains('open')) closeMobileMenu();
    }
  });

  /* ----- Demo Mode (no backend) ----- */
  /* When there is no API backend, render a self-contained demo so the UI is fully visible */
  let demoMode = false;

  function enableDemoMode() {
    demoMode = true;
    hide(dom.loginModal);
    isAuthenticated = true;
    userRole = 'admin';
    applyRole();

    /* Show pairing briefly, then auto-transition to dashboard */
    showPairingDemo();
    setTimeout(function () {
      appendLogLine('Session start requested');
      setTimeout(showDashboardDemo, 600);
    }, 1800);
  }

  function showPairingDemo() {
    dom.statusDot.className = 'status-dot';
    dom.statusText.textContent = 'Disconnected';
    show(dom.pairingView);
    hide(dom.dashboardView);
    show(dom.brandSubtitle);
    hide(dom.envLabel);

    /* Show a placeholder QR */
    hide(dom.qrLoading);
    show(dom.qrImage);
    hide(dom.qrConnected);
    /* Generate a simple SVG QR-like placeholder */
    dom.qrImage.src = 'data:image/svg+xml,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200">' +
      '<rect width="200" height="200" fill="#1f2c33"/>' +
      '<g fill="#e9edef" opacity="0.15">' +
      Array.from({length: 400}, function(_, i) {
        var x = (i % 20) * 10; var y = Math.floor(i / 20) * 10;
        return Math.random() > 0.45 ? '<rect x="'+x+'" y="'+y+'" width="9" height="9" rx="1"/>' : '';
      }).join('') +
      '</g></svg>'
    );
    dom.qrStatusText.textContent = 'Scan with WhatsApp to pair';
  }

  function showDashboardDemo() {
    dom.statusDot.className = 'status-dot connected';
    dom.statusText.textContent = 'Connected';
    hide(dom.pairingView);
    show(dom.dashboardView);
    hide(dom.brandSubtitle);
    show(dom.envLabel);

    dom.metricMode.textContent = 'Auto';
    dom.metricAutoReply.textContent = 'On';
    dom.metricAutoReply.className = 'metric-value green';
    dom.metricKeyIndex.textContent = '0';
    dom.metricTotalMsgs.textContent = '1,247';
    dom.metricAiReplies.textContent = '893';

    /* Start demo log stream */
    if (!demoLogTimer) startDemoLog();
  }

  let demoLogTimer = null;
  const demoMessages = [
    'Incoming message from +1 (555) 0142',
    'AI reply sent (NVIDIA NIM, model: meta/llama3-70b)',
    'Incoming message from +44 7700 900123',
    'Auto-reply triggered for owner command: status',
    'AI reply sent (Groq, model: mixtral-8x7b)',
    'Incoming group message from Family Group',
    'Ignored: group message (auto-reply off for groups)',
    'Incoming message from +1 (555) 0198',
    'AI reply sent (NVIDIA NIM, model: meta/llama3-70b)',
    'Session heartbeat OK',
    'Incoming message from +91 98765 43210',
    'AI reply sent (Auto → Groq fallback)',
    'Rate limit warning: NVIDIA NIM key 0 approaching limit',
    'Switched to NVIDIA NIM key 1',
    'Incoming message from +1 (555) 0142',
    'AI reply sent (NVIDIA NIM key 1)',
  ];
  let demoMsgIndex = 0;

  function startDemoLog() {
    demoLogTimer = setInterval(function () {
      appendLogLine(demoMessages[demoMsgIndex % demoMessages.length]);
      demoMsgIndex++;
    }, 2200);
  }

  function stopDemoLog() {
    if (demoLogTimer) { clearInterval(demoLogTimer); demoLogTimer = null; }
  }

  /* Demo control overrides */
  dom.btnStart.addEventListener('click', function () {
    if (demoMode) {
      appendLogLine('Starting session...');
      setTimeout(showDashboardDemo, 1200);
    }
  }, true);

  dom.btnStop.addEventListener('click', function () {
    if (demoMode) {
      stopDemoLog();
      showPairingDemo();
      dom.qrStatusText.textContent = 'Session stopped';
    }
  }, true);

  dom.btnNewSession.addEventListener('click', function () {
    if (demoMode) {
      stopDemoLog();
      show(dom.qrLoading);
      hide(dom.qrImage);
      hide(dom.qrConnected);
      dom.qrStatusText.textContent = 'Generating new QR code...';
      setTimeout(showPairingDemo, 1500);
    }
  }, true);

  dom.btnStopSession.addEventListener('click', function () {
    if (demoMode) {
      stopDemoLog();
      appendLogLine('Session stopped by user');
      setTimeout(showPairingDemo, 400);
    }
  }, true);

  dom.btnResetPair.addEventListener('click', function () {
    if (demoMode) {
      stopDemoLog();
      appendLogLine('Session reset — pairing new device');
      setTimeout(showPairingDemo, 600);
    }
  }, true);

  /* Demo login */
  dom.loginForm.addEventListener('submit', function (e) {
    if (demoMode) {
      e.stopImmediatePropagation();
      e.preventDefault();
      hide(dom.loginModal);
      isAuthenticated = true;
      userRole = 'admin';
      applyRole();
      showPairingDemo();
    }
  }, true);

  /* Demo settings */
  dom.settingsForm.addEventListener('submit', function (e) {
    if (demoMode) {
      e.stopImmediatePropagation();
      e.preventDefault();
      dom.settingsFeedback.textContent = 'Settings saved';
      dom.settingsFeedback.className = 'settings-feedback success';
      setTimeout(closeSettings, 1200);
    }
  }, true);

  /* ----- Init ----- */
  async function init() {
    try {
      const r = await fetch(API + '/api/auth/me', { method: 'GET', credentials: 'same-origin' });
      if (r.ok || r.status === 401) {
        /* Backend exists — use real mode */
        checkAuth();
        return;
      }
    } catch {}
    /* No backend detected — enable self-contained demo */
    enableDemoMode();
  }

  init();
})();
