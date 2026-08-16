/* ===================================================================
   Admin Console — tenant user management
     GET /api/me         (auth + role check)
     GET /api/admin/users
     POST /api/admin/users     { username, password, role, owner_number, provider }
     DELETE /api/admin/users/:id  (POST /api/admin/users/delete fallback)
     POST /api/logout
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

    /* ---------- Auth guard ---------- */
    async function guard() {
        try {
            const me = await api("/api/me");
            const u = me.user || me;
            const isAdmin = u && (u.role === "admin" || u.is_admin === true);
            if (!u || (!me.authenticated && !u.username)) {
                window.location.href = "index.html";
                return false;
            }
            if (!isAdmin) {
                window.location.href = "index.html";
                return false;
            }
            $("app").hidden = false;
            return true;
        } catch (e) {
            window.location.href = "index.html";
            return false;
        }
    }

    /* ---------- Users ---------- */
    async function loadUsers() {
        const body = $("userTableBody");
        try {
            const data = await api("/api/admin/users");
            const users = Array.isArray(data) ? data : (data.users || []);
            renderUsers(users);
        } catch (e) {
            body.innerHTML = '<tr><td colspan="5" style="color:var(--danger);">Failed to load users.</td></tr>';
        }
    }

    function renderUsers(users) {
        const body = $("userTableBody");
        $("userCount").textContent = users.length + (users.length === 1 ? " user" : " users");
        if (!users.length) {
            body.innerHTML = '<tr><td colspan="5" style="color:var(--text-muted);">No tenant users yet.</td></tr>';
            return;
        }
        body.innerHTML = "";
        users.forEach((u) => {
            const tr = document.createElement("tr");

            const tdName = document.createElement("td");
            tdName.textContent = u.username || "—";
            tdName.style.color = "var(--text)";

            const tdRole = document.createElement("td");
            const badge = document.createElement("span");
            const role = u.role || (u.is_admin ? "admin" : "user");
            badge.className = "role-badge" + (role === "admin" ? " admin" : "");
            badge.textContent = role;
            tdRole.appendChild(badge);

            const tdNum = document.createElement("td");
            tdNum.textContent = u.owner_number || u.ownerNumber || "—";
            tdNum.style.color = "var(--text-2)";

            const tdProv = document.createElement("td");
            tdProv.textContent = u.provider || "auto";
            tdProv.style.color = "var(--text-2)";

            const tdAct = document.createElement("td");
            tdAct.style.textAlign = "right";
            const del = document.createElement("button");
            del.className = "btn-sm btn-danger";
            del.textContent = "Remove";
            del.addEventListener("click", () => removeUser(u));
            tdAct.appendChild(del);

            tr.append(tdName, tdRole, tdNum, tdProv, tdAct);
            body.appendChild(tr);
        });
    }

    async function removeUser(u) {
        const id = u.id ?? u.username;
        try {
            try {
                await api("/api/admin/users/" + encodeURIComponent(id), { method: "DELETE" });
            } catch (e) {
                await api("/api/admin/users/delete", {
                    method: "POST",
                    body: JSON.stringify({ id, username: u.username }),
                });
            }
            showFeedback($("adminOk"), "User removed.");
            loadUsers();
        } catch (e) {
            showFeedback($("adminErr"), "Could not remove user.");
        }
    }

    async function createUser(e) {
        e.preventDefault();
        hideFeedback($("adminOk"));
        hideFeedback($("adminErr"));
        const btn = $("btnCreateUser");
        const username = $("newUsername").value.trim();
        const password = $("newPassword").value;
        if (!username || !password) {
            showFeedback($("adminErr"), "Username and password are required.");
            return;
        }
        btn.disabled = true;
        try {
            await api("/api/admin/users", {
                method: "POST",
                body: JSON.stringify({
                    username,
                    password,
                    role: $("newRole").value,
                    owner_number: $("newOwnerNumber").value.trim(),
                    provider: $("newProvider").value,
                }),
            });
            showFeedback($("adminOk"), "User created.");
            resetForm();
            loadUsers();
        } catch (err) {
            showFeedback($("adminErr"), "Could not create user. The username may already exist.");
        } finally {
            btn.disabled = false;
        }
    }

    function resetForm() {
        $("createUserForm").reset();
    }

    async function doLogout() {
        try { await api("/api/logout", { method: "POST" }); } catch (e) { }
        window.location.href = "index.html";
    }

    /* ---------- Feedback ---------- */
    function showFeedback(el, msg) { if (el) { el.textContent = msg; el.classList.add("show"); } }
    function hideFeedback(el) { if (el) { el.textContent = ""; el.classList.remove("show"); } }

    /* ---------- Mobile nav ---------- */
    function toggleMobileNav() {
        const nav = $("mobileNav");
        const open = nav.classList.toggle("open");
        $("hamburger").setAttribute("aria-expanded", String(open));
    }

    function bind() {
        $("createUserForm").addEventListener("submit", createUser);
        $("btnCancelCreate").addEventListener("click", resetForm);
        $("btnSignOut").addEventListener("click", doLogout);
        $("btnSignOutM").addEventListener("click", doLogout);
        $("hamburger").addEventListener("click", toggleMobileNav);
    }

    document.addEventListener("DOMContentLoaded", async () => {
        bind();
        const ok = await guard();
        if (ok) loadUsers();
    });
})();
