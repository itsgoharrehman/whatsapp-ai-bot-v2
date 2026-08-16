/* ===================================================================
   WhatsApp AI Assistant — Main application logic
   Preserves all element IDs and API contracts:
     GET  /api/status
     GET  /api/logs        (+ EventSource /api/logs/stream fallback)
     POST /api/control     { action: start | stop | reset_session }
     POST /api/login  /api/logout   GET /api/me
     GET/POST /api/settings
   =================================================================== */
(function () {
    "use strict";

    const $ = (id) => document.getElementById(id);
    const api = async (url, opts = {}) => {
        const res = await fetch(url, {
            headers: { "Content-Type": "application/json" },
            credentials: "same-origin",
            ...opts,
        });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const ct = res.headers.get("content-type") || "";
        return ct.includes("application/json") ? res.json() : res.text();
    };

    const state = {
        connected: false,
        currentUser: null,
        statusTimer: null,
        logTimer: null,
        logSource: null,
        lastLogId: 0,
    };

    /* ---------------- Auth ---------------- */
    async function checkAuth() {
        try {
            const me = await api("/api/me");
            if (me && (me.authenticated || me.username)) {
                state.currentUser = me.user || me;
                showApp();
                return true;
            }
        } catch (e) { /* fall through to login */ }
        showLogin();
        return false;
    }

    function showLogin() {
        $("loginGate").hidden = false;
        $("app").hidden = true;
        setTimeout(() => $("loginUsername") && $("loginUsername").focus(), 30);
    }

    function showApp() {
        $("loginGate").hidden = true;
        $("app").hidden = false;
        applyRole();
        loadSettings().catch(() => { });
        startStatusPolling();
        startLogStream();
    }

    function applyRole() {
        const u = state.currentUser || {};
        const isAdmin = u.role === "admin" || u.is_admin === true;
        ["adminLink", "adminLinkM"].forEach((id) => {
            const el = $(id);
            if (el) el.hidden = !isAdmin;
        });
        if (u.username) {
            // no-op label hook reserved
        }
    }

    async function doLogin(e) {
        e.preventDefault();
        hideFeedback($("loginError"));
        const btn = $("loginBtn");
        btn.disabled = true;
        try {
            const body = JSON.stringify({
                username: $("loginUsername").value.trim(),
                password: $("loginPassword").value,
            });
            const r = await api("/api/login", { method: "POST", body });
            state.currentUser = (r && (r.user || r)) || null;
            $("loginPassword").value = "";
            showApp();
        } catch (err) {
            showFeedback($("loginError"), "Invalid username or password.");
        } finally {
            btn.disabled = false;
        }
    }

    async function doLogout() {
        try { await api("/api/logout", { method: "POST" }); } catch (e) { }
        stopStatusPolling();
        stopLogStream();
        state.currentUser = null;
        showLogin();
    }

    /* ---------------- Status polling ---------------- */
    function startStatusPolling() {
        fetchStatus();
        stopStatusPolling();
        state.statusTimer = setInterval(fetchStatus, 4000);
    }
    function stopStatusPolling() {
        if (state.statusTimer) clearInterval(state.statusTimer);
        state.statusTimer = null;
    }

    async function fetchStatus() {
        try {
            const s = await api("/api/status");
            renderStatus(s || {});
        } catch (e) {
            setConn("disconnected", "Status unavailable");
        }
    }

    function renderStatus(s) {
        const conn = (s.connection || s.status || "").toLowerCase();
        const connected = s.connected === true || conn === "connected" || conn === "open";
        const pairing = conn === "pairing" || conn === "connecting" || (!!s.qr && !connected);

        if (connected) setConn("connected", "Connected");
        else if (pairing) setConn("pending", "Pairing");
        else setConn("disconnected", "Disconnected");

        if (s.environment || s.env) $("envLabel").textContent = s.environment || s.env;

        // View switching
        if (connected !== state.connected) {
            state.connected = connected;
            switchView(connected);
        } else {
            state.connected = connected;
        }

        // QR handling
        if (!connected) {
            const stage = $("qrStage");
            if (s.qr) {
                const img = $("qrImage");
                img.src = s.qr.startsWith("data:") || s.qr.startsWith("http")
                    ? s.qr
                    : "data:image/png;base64," + s.qr;
                setQrState("ready", "Ready");
            } else if (pairing) {
                setQrState("loading", "Generating");
            } else {
                setQrState("loading", "Waiting");
            }
        } else {
            setQrState("connected", "Linked");
        }

        // Metrics
        if (connected) renderMetrics(s);
    }

    function renderMetrics(s) {
        const set = (id, v) => { const el = $(id); if (el && v !== undefined && v !== null) el.textContent = v; };
        set("mMode", s.mode || s.operating_mode || "Standard");
        const auto = s.auto_reply !== undefined ? s.auto_reply : s.autoReply;
        set("mAutoReply", auto === undefined ? "—" : (auto ? "On" : "Off"));
        const ki = s.active_key_index !== undefined ? s.active_key_index : s.key_index;
        set("mKeyIndex", ki === undefined ? "—" : ki);
        set("mMessages", s.messages_processed ?? s.total_messages ?? 0);
        set("mReplies", s.ai_replies ?? s.total_replies ?? 0);
    }

    function switchView(connected) {
        $("pairingView").classList.toggle("active", !connected);
        $("dashboardView").classList.toggle("active", connected);
    }

    function setConn(kind, label) {
        const dot = $("connDot");
        dot.className = "status-dot is-" + kind;
        $("connLabel").textContent = label;
    }

    function setQrState(st, label) {
        const stage = $("qrStage");
        if (stage) stage.setAttribute("data-state", st);
        const lbl = $("qrStateLabel");
        if (lbl) lbl.textContent = label;
    }

    /* ---------------- Control actions ---------------- */
    async function control(action) {
        try {
            await api("/api/control", {
                method: "POST",
                body: JSON.stringify({ action }),
            });
            appendLog("Requested action: " + action, "info");
            fetchStatus();
        } catch (e) {
            appendLog("Action failed: " + action, "error");
        }
    }

    /* ---------------- Logs ---------------- */
    function startLogStream() {
        // Prefer SSE, fall back to polling.
        if (typeof EventSource !== "undefined") {
            try {
                const es = new EventSource("/api/logs/stream");
                es.onmessage = (ev) => {
                    const line = parseLog(ev.data);
                    appendLog(line.msg, line.level, line.time);
                };
                es.onerror = () => {
                    es.close();
                    state.logSource = null;
                    startLogPolling();
                };
                state.logSource = es;
                return;
            } catch (e) { /* fall through */ }
        }
        startLogPolling();
    }

    function startLogPolling() {
        stopLogPolling();
        fetchLogs();
        state.logTimer = setInterval(fetchLogs, 3000);
    }

    function stopLogPolling() {
        if (state.logTimer) clearInterval(state.logTimer);
        state.logTimer = null;
    }
    function stopLogStream() {
        if (state.logSource) { state.logSource.close(); state.logSource = null; }
        stopLogPolling();
    }

    async function fetchLogs() {
        try {
            const data = await api("/api/logs?since=" + state.lastLogId);
            const items = Array.isArray(data) ? data : (data.logs || []);
            items.forEach((item) => {
                if (item.id !== undefined) state.lastLogId = Math.max(state.lastLogId, item.id);
                const l = normalizeLog(item);
                appendLog(l.msg, l.level, l.time);
            });
        } catch (e) { /* silent */ }
    }

    function parseLog(raw) {
        try { return normalizeLog(JSON.parse(raw)); }
        catch (e) { return { msg: String(raw), level: "info", time: nowTime() }; }
    }
    function normalizeLog(item) {
        if (typeof item === "string") return { msg: item, level: "info", time: nowTime() };
        return {
            msg: item.message || item.msg || item.text || "",
            level: (item.level || item.type || "info").toLowerCase(),
            time: item.time || item.timestamp || nowTime(),
        };
    }

    function nowTime() {
        return new Date().toLocaleTimeString([], { hour12: false });
    }

    function appendLog(msg, level, time) {
        if (!msg) return;
        const term = $("logTerminal");
        const empty = term.querySelector(".log-empty");
        if (empty) empty.remove();

        const line = document.createElement("div");
        line.className = "log-line";
        const lvl = ["info", "success", "warn", "error"].includes(level) ? level : "info";
        const t = document.createElement("span");
        t.className = "log-time";
        t.textContent = time || nowTime();
        const m = document.createElement("span");
        m.className = "log-" + lvl;
        m.textContent = msg;
        line.appendChild(t);
        line.appendChild(m);
        term.appendChild(line);

        // cap lines
        while (term.childElementCount > 500) term.removeChild(term.firstChild);

        if ($("autoScroll").checked) term.scrollTop = term.scrollHeight;
    }

    function clearLogs() {
        const term = $("logTerminal");
        term.innerHTML = '<div class="log-empty">Awaiting events…</div>';
        state.lastLogId = 0;
    }

    /* ---------------- Settings ---------------- */
    async function loadSettings() {
        try {
            const s = await api("/api/settings");
            const g = (k) => s[k] ?? s[k.toLowerCase()];
            if ($("setProvider")) $("setProvider").value = g("provider") || "auto";
            if ($("setOwnerNumber")) $("setOwnerNumber").value = g("owner_number") || g("ownerNumber") || "";
            if ($("setNvidiaKeys")) $("setNvidiaKeys").value = joinKeys(g("nvidia_keys") || g("nvidiaKeys"));
            if ($("setGroqKeys")) $("setGroqKeys").value = joinKeys(g("groq_keys") || g("groqKeys"));
            if ($("setSystemPrompt")) $("setSystemPrompt").value = g("system_prompt") || g("systemPrompt") || "";
            renderKeyStatus("nvidiaKeyStatus", g("nvidia_valid"));
            renderKeyStatus("groqKeyStatus", g("groq_valid"));
        } catch (e) { /* settings may be empty */ }
    }

    function joinKeys(v) {
        if (!v) return "";
        return Array.isArray(v) ? v.join(", ") : String(v);
    }
    function splitKeys(v) {
        return String(v || "").split(",").map((k) => k.trim()).filter(Boolean);
    }
    function renderKeyStatus(id, valid) {
        const el = $(id);
        if (!el) return;
        el.classList.remove("valid", "invalid");
        const label = el.querySelector("span:last-child");
        if (valid === true) { el.classList.add("valid"); label.textContent = "Verified"; }
        else if (valid === false) { el.classList.add("invalid"); label.textContent = "Invalid or unreachable"; }
        else { label.textContent = "Not verified"; }
    }

    async function saveSettings() {
        hideFeedback($("settingsOk"));
        hideFeedback($("settingsErr"));
        const btn = $("settingsSave");
        btn.disabled = true;
        try {
            const payload = {
                provider: $("setProvider").value,
                owner_number: $("setOwnerNumber").value.trim(),
                nvidia_keys: splitKeys($("setNvidiaKeys").value),
                groq_keys: splitKeys($("setGroqKeys").value),
                system_prompt: $("setSystemPrompt").value,
            };
            const r = await api("/api/settings", { method: "POST", body: JSON.stringify(payload) });
            renderKeyStatus("nvidiaKeyStatus", r && r.nvidia_valid);
            renderKeyStatus("groqKeyStatus", r && r.groq_valid);
            showFeedback($("settingsOk"), "Settings saved.");
        } catch (e) {
            showFeedback($("settingsErr"), "Could not save settings. Please retry.");
        } finally {
            btn.disabled = false;
        }
    }

    function openSettings() {
        loadSettings().catch(() => { });
        $("settingsModal").classList.add("open");
        closeMobileNav();
        setTimeout(() => $("setProvider") && $("setProvider").focus(), 30);
    }
    function closeSettings() {
        $("settingsModal").classList.remove("open");
        hideFeedback($("settingsOk"));
        hideFeedback($("settingsErr"));
    }

    /* ---------------- Feedback helpers ---------------- */
    function showFeedback(el, msg) { if (el) { el.textContent = msg; el.classList.add("show"); } }
    function hideFeedback(el) { if (el) { el.textContent = ""; el.classList.remove("show"); } }

    /* ---------------- Mobile nav ---------------- */
    function toggleMobileNav() {
        const nav = $("mobileNav");
        const open = nav.classList.toggle("open");
        $("hamburger").setAttribute("aria-expanded", String(open));
    }
    function closeMobileNav() {
        $("mobileNav").classList.remove("open");
        const h = $("hamburger");
        if (h) h.setAttribute("aria-expanded", "false");
    }

    /* ---------------- Wire up ---------------- */
    function bind() {
        $("loginForm").addEventListener("submit", doLogin);
        $("btnSignOut").addEventListener("click", doLogout);
        $("btnSignOutM").addEventListener("click", doLogout);

        $("btnSettings").addEventListener("click", openSettings);
        $("btnSettingsM").addEventListener("click", openSettings);
        $("settingsClose").addEventListener("click", closeSettings);
        $("settingsCancel").addEventListener("click", closeSettings);
        $("settingsSave").addEventListener("click", saveSettings);
        $("settingsModal").addEventListener("click", (e) => {
            if (e.target === $("settingsModal")) closeSettings();
        });

        $("btnStart").addEventListener("click", () => control("start"));
        $("btnStop").addEventListener("click", () => control("stop"));
        $("btnNewSession").addEventListener("click", () => control("reset_session"));
        $("btnStopDash").addEventListener("click", () => control("stop"));
        $("btnResetSession").addEventListener("click", () => control("reset_session"));

        $("btnClearLogs").addEventListener("click", clearLogs);
        $("hamburger").addEventListener("click", toggleMobileNav);

        document.addEventListener("keydown", (e) => {
            if (e.key === "Escape") closeSettings();
        });
    }

    document.addEventListener("DOMContentLoaded", () => {
        bind();
        checkAuth();
    });
})();
