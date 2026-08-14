-- ═══════════════════════════════════════════════════════════════
-- Apex Architect — Premium Membership & Admin Test Users
-- Run this in your Supabase SQL Editor (supabase.com → SQL Editor)
-- ═══════════════════════════════════════════════════════════════

-- ── 1. Memberships Table ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS memberships (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    email TEXT,
    tier TEXT NOT NULL CHECK (tier IN ('circuit', 'rally', 'all_access')),
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Enable RLS
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;

-- Users can read their own memberships
CREATE POLICY "Users can read own memberships"
    ON memberships FOR SELECT
    USING (auth.uid() = user_id);

-- Users can insert their own memberships
CREATE POLICY "Users can insert own memberships"
    ON memberships FOR INSERT
    WITH CHECK (auth.uid() = user_id);

-- Users can update their own memberships
CREATE POLICY "Users can update own memberships"
    ON memberships FOR UPDATE
    USING (auth.uid() = user_id);


-- ── 2. Admin Test Users Table ─────────────────────────────────
CREATE TABLE IF NOT EXISTS admin_test_users (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    tier TEXT NOT NULL CHECK (tier IN ('circuit', 'rally', 'all_access')),
    granted_by TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS admin_users (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('owner', 'admin', 'viewer')),
    added_by TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS admin_access_requests (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    email TEXT NOT NULL,
    reason TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    requested_by TEXT,
    resolved_by TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS admin_audit_logs (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    actor_email TEXT NOT NULL,
    action TEXT NOT NULL,
    target_email TEXT,
    details TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_blocks (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    reason TEXT,
    blocked_by TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Enable RLS
ALTER TABLE admin_test_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_access_requests ENABLE ROW LEVEL SECURITY;

ALTER TABLE admin_access_requests
    ADD COLUMN IF NOT EXISTS resolved_by TEXT;
ALTER TABLE admin_audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_blocks ENABLE ROW LEVEL SECURITY;

-- Membership policies (safe to rerun)
DROP POLICY IF EXISTS "Users can read own memberships" ON memberships;
CREATE POLICY "Users can read own memberships"
    ON memberships FOR SELECT
    USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own memberships" ON memberships;
CREATE POLICY "Users can insert own memberships"
    ON memberships FOR INSERT
    WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own memberships" ON memberships;
CREATE POLICY "Users can update own memberships"
    ON memberships FOR UPDATE
    USING (auth.uid() = user_id);

-- Admin policies (safe to rerun)
DROP POLICY IF EXISTS "Authenticated users can read test users" ON admin_test_users;
CREATE POLICY "Authenticated users can read test users"
    ON admin_test_users FOR SELECT
    USING (
        lower(auth.jwt() ->> 'email') = 'psycho12e4@gmail.com'
        OR lower(granted_by) = lower(auth.jwt() ->> 'email')
    );

DROP POLICY IF EXISTS "Authenticated users can insert test users" ON admin_test_users;
CREATE POLICY "Authenticated users can insert test users"
    ON admin_test_users FOR INSERT
    WITH CHECK (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "Authenticated users can update test users" ON admin_test_users;
CREATE POLICY "Authenticated users can update test users"
    ON admin_test_users FOR UPDATE
    USING (
        lower(auth.jwt() ->> 'email') = 'psycho12e4@gmail.com'
        OR lower(granted_by) = lower(auth.jwt() ->> 'email')
    );

DROP POLICY IF EXISTS "Authenticated users can delete test users" ON admin_test_users;
CREATE POLICY "Authenticated users can delete test users"
    ON admin_test_users FOR DELETE
    USING (
        lower(auth.jwt() ->> 'email') = 'psycho12e4@gmail.com'
        OR lower(granted_by) = lower(auth.jwt() ->> 'email')
    );

DROP POLICY IF EXISTS "Authenticated users can read admin users" ON admin_users;
CREATE POLICY "Authenticated users can read admin users"
    ON admin_users FOR SELECT
    USING (
        lower(auth.jwt() ->> 'email') = 'psycho12e4@gmail.com'
        OR lower(email) = lower(auth.jwt() ->> 'email')
        OR lower(added_by) = lower(auth.jwt() ->> 'email')
    );

DROP POLICY IF EXISTS "Authenticated users can insert admin users" ON admin_users;
CREATE POLICY "Authenticated users can insert admin users"
    ON admin_users FOR INSERT
    WITH CHECK (lower(auth.jwt() ->> 'email') = 'psycho12e4@gmail.com');

DROP POLICY IF EXISTS "Authenticated users can update admin users" ON admin_users;
CREATE POLICY "Authenticated users can update admin users"
    ON admin_users FOR UPDATE
    USING (lower(auth.jwt() ->> 'email') = 'psycho12e4@gmail.com')
    WITH CHECK (lower(auth.jwt() ->> 'email') = 'psycho12e4@gmail.com');

DROP POLICY IF EXISTS "Authenticated users can delete admin users" ON admin_users;
CREATE POLICY "Authenticated users can delete admin users"
    ON admin_users FOR DELETE
    USING (lower(auth.jwt() ->> 'email') = 'psycho12e4@gmail.com');

DROP POLICY IF EXISTS "Authenticated users can read access requests" ON admin_access_requests;
CREATE POLICY "Authenticated users can read access requests"
    ON admin_access_requests FOR SELECT
    USING (
        lower(auth.jwt() ->> 'email') = 'psycho12e4@gmail.com'
        OR lower(requested_by) = lower(auth.jwt() ->> 'email')
        OR lower(resolved_by) = lower(auth.jwt() ->> 'email')
    );

DROP POLICY IF EXISTS "Authenticated users can insert access requests" ON admin_access_requests;
CREATE POLICY "Authenticated users can insert access requests"
    ON admin_access_requests FOR INSERT
    WITH CHECK (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "Authenticated users can update access requests" ON admin_access_requests;
CREATE POLICY "Authenticated users can update access requests"
    ON admin_access_requests FOR UPDATE
    USING (lower(auth.jwt() ->> 'email') = 'psycho12e4@gmail.com')
    WITH CHECK (lower(auth.jwt() ->> 'email') = 'psycho12e4@gmail.com');

DROP POLICY IF EXISTS "Authenticated users can read audit logs" ON admin_audit_logs;
CREATE POLICY "Authenticated users can read audit logs"
    ON admin_audit_logs FOR SELECT
    USING (
        lower(auth.jwt() ->> 'email') = 'psycho12e4@gmail.com'
        OR lower(actor_email) = lower(auth.jwt() ->> 'email')
    );

DROP POLICY IF EXISTS "Authenticated users can insert audit logs" ON admin_audit_logs;
CREATE POLICY "Authenticated users can insert audit logs"
    ON admin_audit_logs FOR INSERT
    WITH CHECK (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "Authenticated users can read user blocks" ON user_blocks;
CREATE POLICY "Authenticated users can read user blocks"
    ON user_blocks FOR SELECT
    USING (
        lower(auth.jwt() ->> 'email') = 'psycho12e4@gmail.com'
        OR lower(blocked_by) = lower(auth.jwt() ->> 'email')
    );

DROP POLICY IF EXISTS "Authenticated users can insert user blocks" ON user_blocks;
CREATE POLICY "Authenticated users can insert user blocks"
    ON user_blocks FOR INSERT
    WITH CHECK (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "Authenticated users can delete user blocks" ON user_blocks;
CREATE POLICY "Authenticated users can delete user blocks"
    ON user_blocks FOR DELETE
    USING (
        lower(auth.jwt() ->> 'email') = 'psycho12e4@gmail.com'
        OR lower(blocked_by) = lower(auth.jwt() ->> 'email')
    );


-- ── 3. Indexes ────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_memberships_user_active
    ON memberships(user_id, is_active);

CREATE INDEX IF NOT EXISTS idx_admin_test_users_email
    ON admin_test_users(email);

CREATE INDEX IF NOT EXISTS idx_admin_users_email
    ON admin_users(email);

CREATE INDEX IF NOT EXISTS idx_admin_access_requests_status
    ON admin_access_requests(status);

CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_created_at
    ON admin_audit_logs(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_blocks_email
    ON user_blocks(email);
