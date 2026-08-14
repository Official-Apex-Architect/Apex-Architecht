/**
 * Apex Architect — Standalone Auth System
 * Uses localStorage. No external services required.
 */

const AUTH_KEY = 'apex_auth_v1';
const USERS_KEY = 'apex_users_v1';

const ApexAuth = (() => {

    function getUsers() {
        try { return JSON.parse(localStorage.getItem(USERS_KEY) || '{}'); } catch { return {}; }
    }

    function saveUsers(users) {
        localStorage.setItem(USERS_KEY, JSON.stringify(users));
    }

    function getSession() {
        try { return JSON.parse(localStorage.getItem(AUTH_KEY) || 'null'); } catch { return null; }
    }

    function saveSession(user) {
        localStorage.setItem(AUTH_KEY, JSON.stringify(user));
    }

    function clearSession() {
        localStorage.removeItem(AUTH_KEY);
    }

    function hashPassword(str) {
        // Simple deterministic hash — not cryptographic, but prevents plaintext storage
        let h = 0x811c9dc5;
        for (let i = 0; i < str.length; i++) {
            h ^= str.charCodeAt(i);
            h = (h * 0x01000193) >>> 0;
        }
        return h.toString(16);
    }

    function register(email, password, displayName) {
        email = email.trim().toLowerCase();
        const users = getUsers();
        if (users[email]) return { ok: false, error: 'An account with this email already exists.' };
        users[email] = { email, displayName: displayName || email.split('@')[0], passwordHash: hashPassword(password), createdAt: Date.now() };
        saveUsers(users);
        const user = { email, displayName: users[email].displayName };
        saveSession(user);
        return { ok: true, user };
    }

    function login(email, password) {
        email = email.trim().toLowerCase();
        const users = getUsers();
        const record = users[email];
        if (!record) return { ok: false, error: 'No account found with this email.' };
        if (record.passwordHash !== hashPassword(password)) return { ok: false, error: 'Incorrect password.' };
        const user = { email, displayName: record.displayName };
        saveSession(user);
        return { ok: true, user };
    }

    function logout() {
        clearSession();
    }

    function currentUser() {
        return getSession();
    }

    return { register, login, logout, currentUser };
})();

// ─── Modal UI ────────────────────────────────────────────────────────────────

function apexAuthInit(onAuthChange) {
    // Inject modal HTML
    const modal = document.createElement('div');
    modal.id = 'auth-modal';
    modal.innerHTML = `
    <div id="auth-backdrop" style="
        position:fixed;inset:0;z-index:9999;
        background:rgba(0,0,0,0.75);
        backdrop-filter:blur(12px);
        display:flex;align-items:center;justify-content:center;
        opacity:0;transition:opacity 0.25s ease;
    ">
      <div style="
        background:linear-gradient(145deg,#0f172a,#0b0e14);
        border:1px solid rgba(255,255,255,0.1);
        border-radius:20px;
        width:min(420px,92vw);
        padding:0;
        box-shadow:0 40px 80px rgba(0,0,0,0.6);
        overflow:hidden;
        transform:translateY(24px);
        transition:transform 0.3s ease;
      " id="auth-box">
        <!-- Header -->
        <div style="background:linear-gradient(90deg,#e10600,#b00400);padding:28px 32px 24px;">
          <div style="display:flex;align-items:center;gap:14px;margin-bottom:6px;">
            <div style="width:36px;height:36px;background:rgba(255,255,255,0.2);border-radius:6px;transform:skewX(-8deg);display:flex;align-items:center;justify-content:center;">
              <svg width="16" height="16" fill="none" stroke="white" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/></svg>
            </div>
            <div id="auth-title" style="font-family:'Orbitron',sans-serif;font-size:18px;font-weight:700;color:white;letter-spacing:2px;text-transform:uppercase;font-style:italic;">Sign In</div>
          </div>
          <div id="auth-subtitle" style="color:rgba(255,255,255,0.65);font-size:11px;letter-spacing:2px;text-transform:uppercase;">Access your Apex Architect workspace</div>
        </div>
        <!-- Body -->
        <div style="padding:28px 32px 32px;display:flex;flex-direction:column;gap:0;">
          <div id="auth-error" style="display:none;background:rgba(225,6,0,0.12);border:1px solid rgba(225,6,0,0.35);border-radius:8px;padding:10px 14px;color:#ff6b6b;font-size:12px;margin-bottom:16px;"></div>
          <div id="name-field" style="display:none;margin-bottom:14px;">
            <label style="display:block;font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:rgba(255,255,255,0.4);margin-bottom:6px;">Display Name</label>
            <input id="auth-name" type="text" placeholder="Your name" autocomplete="name" style="
              width:100%;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);
              border-radius:8px;padding:11px 14px;color:white;font-size:13px;outline:none;
              box-sizing:border-box;transition:border-color 0.2s;
            ">
          </div>
          <div style="margin-bottom:14px;">
            <label style="display:block;font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:rgba(255,255,255,0.4);margin-bottom:6px;">Email Address</label>
            <input id="auth-email" type="email" placeholder="you@example.com" autocomplete="email" style="
              width:100%;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);
              border-radius:8px;padding:11px 14px;color:white;font-size:13px;outline:none;
              box-sizing:border-box;transition:border-color 0.2s;
            ">
          </div>
          <div style="margin-bottom:24px;">
            <label style="display:block;font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:rgba(255,255,255,0.4);margin-bottom:6px;">Password</label>
            <input id="auth-password" type="password" placeholder="••••••••" autocomplete="current-password" style="
              width:100%;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);
              border-radius:8px;padding:11px 14px;color:white;font-size:13px;outline:none;
              box-sizing:border-box;transition:border-color 0.2s;
            ">
          </div>
          <button id="auth-submit" style="
            background:linear-gradient(90deg,#e10600,#b00400);color:white;border:none;
            border-radius:8px;padding:13px;font-family:'Orbitron',sans-serif;
            font-size:11px;font-weight:700;letter-spacing:3px;text-transform:uppercase;
            cursor:pointer;transition:all 0.2s;font-style:italic;
          ">ENTER WORKSPACE</button>
          <div style="text-align:center;margin-top:18px;">
            <span id="auth-toggle-text" style="color:rgba(255,255,255,0.35);font-size:11px;">Don't have an account?</span>
            <button id="auth-toggle" style="
              background:none;border:none;color:#e10600;font-size:11px;font-weight:700;
              cursor:pointer;margin-left:6px;letter-spacing:1px;text-decoration:underline;
            ">Create one</button>
          </div>
        </div>
      </div>
    </div>`;
    document.body.appendChild(modal);

    const backdrop = document.getElementById('auth-backdrop');
    const box = document.getElementById('auth-box');
    let isSignUp = false;

    // Focus animation on inputs
    ['auth-name','auth-email','auth-password'].forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('focus', () => el.style.borderColor = 'rgba(225,6,0,0.6)');
        el.addEventListener('blur', () => el.style.borderColor = 'rgba(255,255,255,0.1)');
    });

    function showModal() {
        backdrop.style.display = 'flex';
        requestAnimationFrame(() => {
            backdrop.style.opacity = '1';
            box.style.transform = 'translateY(0)';
        });
    }

    function hideModal() {
        backdrop.style.opacity = '0';
        box.style.transform = 'translateY(24px)';
        setTimeout(() => { backdrop.style.display = 'none'; }, 280);
    }

    function setError(msg) {
        const el = document.getElementById('auth-error');
        if (msg) { el.textContent = msg; el.style.display = 'block'; }
        else { el.style.display = 'none'; }
    }

    function switchMode(signup) {
        isSignUp = signup;
        document.getElementById('auth-title').textContent = signup ? 'Create Account' : 'Sign In';
        document.getElementById('auth-subtitle').textContent = signup ? 'Join Apex Architect today' : 'Access your Apex Architect workspace';
        document.getElementById('auth-submit').textContent = signup ? 'CREATE ACCOUNT' : 'ENTER WORKSPACE';
        document.getElementById('name-field').style.display = signup ? 'block' : 'none';
        document.getElementById('auth-toggle-text').textContent = signup ? 'Already have an account?' : "Don't have an account?";
        document.getElementById('auth-toggle').textContent = signup ? 'Sign in' : 'Create one';
        document.getElementById('auth-password').autocomplete = signup ? 'new-password' : 'current-password';
        setError('');
    }

    document.getElementById('auth-toggle').addEventListener('click', () => switchMode(!isSignUp));

    document.getElementById('auth-submit').addEventListener('click', () => {
        setError('');
        const email = document.getElementById('auth-email').value.trim();
        const password = document.getElementById('auth-password').value;
        const name = document.getElementById('auth-name').value.trim();

        if (!email || !password) { setError('Please fill in all fields.'); return; }
        if (isSignUp && password.length < 6) { setError('Password must be at least 6 characters.'); return; }

        const result = isSignUp
            ? ApexAuth.register(email, password, name)
            : ApexAuth.login(email, password);

        if (!result.ok) { setError(result.error); return; }
        hideModal();
        onAuthChange(result.user);
    });

    document.getElementById('auth-password').addEventListener('keydown', e => {
        if (e.key === 'Enter') document.getElementById('auth-submit').click();
    });

    // Public API
    return {
        open: showModal,
        close: hideModal,
        currentUser: ApexAuth.currentUser,
        logout() {
            ApexAuth.logout();
            onAuthChange(null);
        }
    };
}
