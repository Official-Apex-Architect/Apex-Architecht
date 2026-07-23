const express = require('express');

const router = express.Router();
router.use(express.urlencoded({ extended: true }));
router.use(express.json());

function getUserModel() {
  const candidates = [
    '../models/User',
    '../models/user',
    '../models/userModel',
    '../models/user.model',
    './models/User',
    './models/user',
    '../db/models/User',
    '../db/models/user',
    '../Apex Arcitecht/apex-auth'
  ];

  for (const candidate of candidates) {
    try {
      const loaded = require(candidate);
      if (loaded && typeof loaded === 'function') return loaded;
      if (loaded && typeof loaded.User === 'function') return loaded.User;
      if (loaded && typeof loaded.default === 'function') return loaded.default;
      if (loaded && typeof loaded.default === 'object' && loaded.default && typeof loaded.default.User === 'function') return loaded.default.User;
      if (loaded && typeof loaded.model === 'function') return loaded.model;
      if (loaded && typeof loaded.default === 'object' && loaded.default && typeof loaded.default.model === 'function') return loaded.default.model;
    } catch (error) {
      // Continue trying other common locations.
    }
  }

  return null;
}

function pickValue(user, keys) {
  for (const key of keys) {
    if (!key) continue;
    const value = user && user[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }

  return null;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeUser(user) {
  if (!user) return null;

  const id = pickValue(user, ['_id', 'id']);
  const username = pickValue(user, ['username', 'userName', 'name', 'fullName', 'displayName']) || 'Unknown';
  const gmail = pickValue(user, ['email', 'gmail', 'gmailAddress', 'emailAddress']) || '-';
  const password = pickValue(user, ['password', 'passwordHash', 'hashedPassword', 'passwordText', 'plainPassword', 'rawPassword']) || '-';
  const roleValue = pickValue(user, ['role', 'userRole', 'accountType']);
  const adminFlag = Boolean(pickValue(user, ['isAdmin', 'admin', 'isAdminUser', 'is_superuser']));
  const premiumFlag = Boolean(pickValue(user, ['premium', 'isPremium', 'premiumMembership', 'hasPremium', 'isPremiumMember']));
  const membershipValue = pickValue(user, ['membership', 'plan', 'membershipType', 'subscriptionStatus']);
  const isAdmin = adminFlag || (typeof roleValue === 'string' && /admin|super|owner/i.test(roleValue));
  const isPremium = premiumFlag || (typeof membershipValue === 'string' && /premium|active/i.test(membershipValue));

  return {
    id,
    username,
    gmail,
    password,
    role: isAdmin ? 'Admin' : (roleValue ? String(roleValue) : 'User'),
    isAdmin,
    isPremium
  };
}

async function loadUsers() {
  const UserModel = getUserModel();

  if (!UserModel || typeof UserModel.find !== 'function') {
    return [];
  }

  const found = await UserModel.find({}).lean().exec().catch(() => []);

  if (!Array.isArray(found)) {
    return [];
  }

  return found.map(normalizeUser).filter(Boolean);
}

async function updateUser(UserModel, filter, update) {
  if (!UserModel) return null;

  if (typeof UserModel.findOneAndUpdate === 'function') {
    return UserModel.findOneAndUpdate(filter, update, { new: true }).lean().exec().catch(() => null);
  }

  if (typeof UserModel.findByIdAndUpdate === 'function') {
    const id = filter && filter._id ? filter._id : null;
    if (!id) return null;
    return UserModel.findByIdAndUpdate(id, update, { new: true }).lean().exec().catch(() => null);
  }

  if (typeof UserModel.updateOne === 'function') {
    return UserModel.updateOne(filter, update).then(() => ({ ok: true })).catch(() => null);
  }

  return null;
}

async function findUser(UserModel, identifier) {
  if (!UserModel || typeof UserModel.findOne !== 'function') {
    return null;
  }

  const value = String(identifier || '').trim();
  if (!value) return null;

  const query = {
    $or: [
      { username: value },
      { userName: value },
      { email: value },
      { gmail: value },
      { _id: value }
    ]
  };

  return UserModel.findOne(query).lean().exec().catch(() => null);
}

function renderAdminPage({ users, adminUsers, premiumUsers, message, error }) {
  const adminRows = adminUsers
    .map((user) => `
      <tr>
        <td>${escapeHtml(user.username)}</td>
        <td>${escapeHtml(user.gmail)}</td>
        <td>${escapeHtml(user.role)}</td>
        <td>${user.isPremium ? '<span class="pill pill-premium">Premium</span>' : '<span class="pill">Standard</span>'}</td>
      </tr>`)
    .join('');

  const premiumRows = premiumUsers
    .map((user) => `
      <tr>
        <td>${escapeHtml(user.username)}</td>
        <td>${escapeHtml(user.gmail)}</td>
        <td>${escapeHtml(user.password)}</td>
      </tr>`)
    .join('');

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Apex Architect Admin</title>
    <style>
      :root { color-scheme: dark; --bg:#030407; --surface:#0b1020; --surface-2:#121a2d; --text:#f5f7ff; --muted:#97a1ba; --accent:#a855f7; --accent-2:#e10600; --border:rgba(255,255,255,0.09); }
      * { box-sizing:border-box; }
      body { margin:0; font-family: Inter, Arial, sans-serif; background:linear-gradient(135deg, var(--bg), #090d18); color:var(--text); min-height:100vh; }
      .wrap { max-width: 1180px; margin: 0 auto; padding: 32px 20px 80px; }
      .hero { background:rgba(255,255,255,0.03); border:1px solid var(--border); border-radius: 24px; padding: 28px; box-shadow:0 20px 45px rgba(0,0,0,.25); }
      .hero h1 { margin: 0 0 8px; font-size: 32px; }
      .hero p { margin: 0; color: var(--muted); line-height: 1.6; }
      .stats { display:grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 14px; margin-top: 20px; }
      .stat { background: var(--surface); border:1px solid var(--border); border-radius: 16px; padding: 16px; }
      .stat strong { display:block; font-size: 24px; margin-bottom: 6px; }
      .section { margin-top: 24px; background:rgba(255,255,255,0.03); border:1px solid var(--border); border-radius: 20px; padding: 22px; }
      .section h2 { margin:0 0 8px; font-size: 18px; }
      .section p { color: var(--muted); margin-bottom: 16px; }
      .table-wrap { overflow-x:auto; }
      table { width:100%; border-collapse: collapse; min-width: 560px; }
      th, td { text-align:left; padding: 12px 10px; border-bottom:1px solid var(--border); }
      th { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .08em; }
      .pill { display:inline-block; padding:4px 8px; border-radius:999px; background:rgba(255,255,255,.08); font-size: 12px; }
      .pill-premium { background: rgba(168,85,247,.16); color: #d9b7ff; }
      .forms { display:grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 14px; margin-top: 16px; }
      form { background: var(--surface); border:1px solid var(--border); border-radius: 16px; padding: 16px; }
      label { display:block; font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); margin-bottom: 8px; }
      input, select, button { width:100%; border-radius: 10px; padding: 10px 12px; border:1px solid var(--border); background: var(--surface-2); color: var(--text); margin-bottom: 10px; }
      button { cursor:pointer; background: linear-gradient(90deg, var(--accent), var(--accent-2)); border:none; font-weight:700; }
      .message, .error { padding: 12px 14px; border-radius: 12px; margin-top: 16px; border:1px solid var(--border); }
      .message { background: rgba(40, 167, 69, .16); color: #b9f3c4; }
      .error { background: rgba(225, 6, 0, .16); color: #ffc2c2; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <section class="hero">
        <h1>Apex Architect Admin Hub</h1>
        <p>Manage admin accounts, review premium members, and perform quick admin actions without leaving this workspace.</p>
        <div class="stats">
          <div class="stat"><strong>${users.length}</strong><span>Total users</span></div>
          <div class="stat"><strong>${adminUsers.length}</strong><span>Admin users</span></div>
          <div class="stat"><strong>${premiumUsers.length}</strong><span>Premium members</span></div>
        </div>
        ${message ? `<div class="message">${escapeHtml(message)}</div>` : ''}
        ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
      </section>

      <section class="section">
        <h2>Admin accounts</h2>
        <p>Only admin accounts are listed here so the workspace stays focused on privileged users.</p>
        <div class="table-wrap">
          <table>
            <thead>
              <tr><th>Username</th><th>Gmail</th><th>Role</th><th>Status</th></tr>
            </thead>
            <tbody>${adminRows || '<tr><td colspan="4">No admin accounts found.</td></tr>'}</tbody>
          </table>
        </div>
      </section>

      <section class="section">
        <h2>Premium membership users</h2>
        <p>Premium members are surfaced in a dedicated table with their username, gmail address, and password.</p>
        <div class="table-wrap">
          <table>
            <thead>
              <tr><th>Username</th><th>Gmail</th><th>Password</th></tr>
            </thead>
            <tbody>${premiumRows || '<tr><td colspan="3">No premium members found.</td></tr>'}</tbody>
          </table>
        </div>
      </section>

      <section class="section">
        <h2>Admin actions</h2>
        <p>Use these quick controls to update a user’s privileges directly from the panel.</p>
        <div class="forms">
          <form method="post" action="/admin/toggle-admin">
            <label for="admin-identifier">User</label>
            <input id="admin-identifier" name="identifier" placeholder="Username or email" required />
            <button type="submit">Toggle admin access</button>
          </form>
          <form method="post" action="/admin/toggle-premium">
            <label for="premium-identifier">User</label>
            <input id="premium-identifier" name="identifier" placeholder="Username or email" required />
            <button type="submit">Toggle premium access</button>
          </form>
        </div>
      </section>
    </div>
  </body>
</html>`;
}

router.get(['/', '/premium-users', '/premium-members'], async (req, res) => {
  const message = req.query.message || '';
  const error = req.query.error || '';
  const users = await loadUsers();
  const adminUsers = users.filter((user) => user.isAdmin);
  const premiumUsers = users.filter((user) => user.isPremium);
  res.send(renderAdminPage({ users, adminUsers, premiumUsers, message, error }));
});

router.post('/toggle-admin', async (req, res) => {
  const identifier = req.body && req.body.identifier;
  const UserModel = getUserModel();

  if (!identifier) {
    return res.redirect('/admin?error=Please enter a username or email.');
  }

  const existing = await findUser(UserModel, identifier);
  if (!existing) {
    return res.redirect('/admin?error=No matching user found.');
  }

  const nextAdmin = !Boolean(existing.isAdmin || existing.admin || existing.isAdminUser || existing.is_superuser || /admin|super|owner/i.test(String(existing.role || '')));
  const update = {
    $set: {
      isAdmin: nextAdmin,
      admin: nextAdmin,
      role: nextAdmin ? 'admin' : 'user'
    }
  };

  const updated = await updateUser(UserModel, { _id: existing._id || existing.id }, update);

  if (updated) {
    return res.redirect('/admin?message=Admin access updated successfully.');
  }

  return res.redirect('/admin?error=Unable to update admin access.');
});

router.post('/toggle-premium', async (req, res) => {
  const identifier = req.body && req.body.identifier;
  const UserModel = getUserModel();

  if (!identifier) {
    return res.redirect('/admin?error=Please enter a username or email.');
  }

  const existing = await findUser(UserModel, identifier);
  if (!existing) {
    return res.redirect('/admin?error=No matching user found.');
  }

  const nextPremium = !Boolean(existing.premium || existing.isPremium || existing.premiumMembership || existing.hasPremium || /premium|active/i.test(String(existing.membership || existing.plan || existing.membershipType || existing.subscriptionStatus || '')));
  const update = {
    $set: {
      premium: nextPremium,
      isPremium: nextPremium,
      premiumMembership: nextPremium,
      membership: nextPremium ? 'premium' : 'standard'
    }
  };

  const updated = await updateUser(UserModel, { _id: existing._id || existing.id }, update);

  if (updated) {
    return res.redirect('/admin?message=Premium access updated successfully.');
  }

  return res.redirect('/admin?error=Unable to update premium access.');
});

module.exports = router;
