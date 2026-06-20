/**
 * Apex Architect — Supabase Client
 * ─────────────────────────────────────────────────────────────
 * STEP 1: Go to https://supabase.com → New Project
 * STEP 2: Settings → API → copy Project URL + anon/public key
 * STEP 3: Paste them below
 * STEP 4: Run the SQL in the Supabase SQL Editor (see setup-guide.md)
 * ─────────────────────────────────────────────────────────────
 */
const SUPABASE_URL      = 'https://vcjkedqlbxyvjcolooyo.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_rS2TORkgOK074ebHTXPbtw_q6p-FOWH';

// Create Supabase client (loaded via CDN in each HTML page)
const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
        persistSession: true,
        storageKey: 'apex_sb_session',
        autoRefreshToken: true
    }
});

// Expose the client instance globally for pages expecting 'supabase'
window.supabase = db;

// ─── AUTH ─────────────────────────────────────────────────────────────────────

const ApexAuth = {
    async signUp(email, password, displayName) {
        const { data, error } = await db.auth.signUp({
            email,
            password,
            options: { data: { display_name: displayName || email.split('@')[0] } }
        });
        if (error) return { ok: false, error: error.message };
        // Clear local data to prevent collisions when switching accounts
        localStorage.removeItem(LOCAL_KEY);
        return { ok: true, user: _fmt(data.user) };
    },

    async signIn(email, password) {
        const { data, error } = await db.auth.signInWithPassword({ email, password });
        if (error) return { ok: false, error: error.message };
        // Clear local data to prevent collisions when switching accounts
        localStorage.removeItem(LOCAL_KEY);
        return { ok: true, user: _fmt(data.user) };
    },

    async signOut() {
        await db.auth.signOut();
        localStorage.removeItem(LOCAL_KEY);
    },

    /** Reads from cached session — no network call needed */
    async getUser() {
        const { data: { session } } = await db.auth.getSession();
        return session ? _fmt(session.user) : null;
    }
};

function _fmt(u) {
    if (!u) return null;
    return {
        id: u.id,
        email: u.email,
        displayName: u.user_metadata?.display_name || u.email.split('@')[0]
    };
}

// ─── PROJECTS ─────────────────────────────────────────────────────────────────

const LOCAL_KEY = 'apex_projects_v1';

const ApexProjects = {
    /** Fetch all projects from Supabase, cache to localStorage for the editor */
    async fetchAll() {
        const { data, error } = await db
            .from('projects')
            .select('id, name, data, last_modified')
            .order('last_modified', { ascending: false });

        if (error) throw error;

        const projects = data.map(r => ({
            id: r.id,
            name: r.name,
            lastModified: r.last_modified,
            data: r.data
        }));

        // Write to localStorage so f1track.js can read it directly
        try {
            localStorage.setItem(LOCAL_KEY, JSON.stringify(projects));
        } catch (err) {
            console.warn('[Sync] Could not cache projects to localStorage. Quota exceeded.', err);
        }
        return projects;
    },

    /** Upsert a single project to Supabase */
    async upsert(project) {
        const { data: { session } } = await db.auth.getSession();
        if (!session) return;
        const { error } = await db.from('projects').upsert({
            id: project.id,
            user_id: session.user.id,
            name: project.name,
            data: project.data,
            last_modified: project.lastModified
        }, { onConflict: 'id' });
        if (error) throw error;
    },

    /** Delete from Supabase and local cache */
    async delete(id) {
        const { error } = await db.from('projects').delete().eq('id', id);
        if (error) console.warn('[ApexProjects] delete failed:', error.message);
        try {
            const arr = JSON.parse(localStorage.getItem(LOCAL_KEY) || '[]');
            localStorage.setItem(LOCAL_KEY, JSON.stringify(arr.filter(p => p.id !== id)));
        } catch {}
    }
};

// ─── MEMBERSHIP ───────────────────────────────────────────────────────────────

const MEMBERSHIP_LOCAL_KEY = 'apex_memberships_v1';
const TEST_USERS_LOCAL_KEY = 'apex_test_users_v1';
const ADMIN_EMAILS_LOCAL_KEY = 'apex_admin_emails_v1';
const ADMIN_EMAILS = ['admin@apexarchitect.com', 'psycho12e4@gmail.com', 'user-admin']; // Extend as needed

const ApexMembership = {
    normalizeIdentifier(value) {
        return (value || '').trim().toLowerCase();
    },

    normalizeTier(tier) {
        const normalized = this.normalizeIdentifier(tier).replace(/\s+/g, '_');
        const aliases = {
            circuit: 'circuit',
            premium: 'circuit',
            formula: 'circuit',
            formula_pro: 'circuit',
            circuit_pro: 'circuit',
            f1: 'circuit',
            f1_f2_f3: 'circuit',
            rally: 'rally',
            rallying: 'rally',
            rally_pro: 'rally',
            all_access: 'all_access',
            allaccess: 'all_access',
            ultimate: 'all_access',
            ultimate_access: 'all_access'
        };
        return aliases[normalized] || normalized;
    },

    /** Tier definitions with track type tags and length specs */
    TIERS: {
        circuit: {
            name: 'Apex Circuit & Formula Pro',
            tags: ['f1_f2_f3', 'go_karting', 'gt', 'hypercar', 'lmp'],
            tagLabels: {
                f1_f2_f3: 'F1 / F2 / F3',
                go_karting: 'Go-Karting',
                gt: 'GT Racing',
                hypercar: 'Hypercar',
                lmp: 'LMP / Le Mans'
            },
            lengthLimits: {
                f1_f2_f3: { min: 3, max: 7, unit: 'km', closed: true },
                go_karting: { min: 0.3, max: 5, unit: 'km', closed: true },
                gt: { min: 3, max: 7, unit: 'km', closed: true },
                hypercar: { min: 3, max: 7, unit: 'km', closed: true },
                lmp: { min: 3, max: 7, unit: 'km', closed: true }
            }
        },
        rally: {
            name: 'Apex Rally Pro',
            tags: ['rallying'],
            tagLabels: {
                rallying: 'Rallying'
            },
            lengthLimits: {
                rallying: {
                    min: 1,
                    max: 800,
                    unit: 'km',
                    closed: false,
                    variants: {
                        normal: { min: 1, max: 2, closed: true },
                        stage: { min: 3, max: 50, closed: false, totalMin: 300, totalMax: 350 },
                        raid: { min: 100, max: 800, closed: false, totalMin: 3000, totalMax: 8000 }
                    }
                }
            }
        },
        all_access: {
            name: 'Apex Ultimate',
            tags: ['f1_f2_f3', 'go_karting', 'gt', 'hypercar', 'lmp', 'rallying'],
            tagLabels: {
                f1_f2_f3: 'F1 / F2 / F3',
                go_karting: 'Go-Karting',
                gt: 'GT Racing',
                hypercar: 'Hypercar',
                lmp: 'LMP / Le Mans',
                rallying: 'Rallying'
            },
            lengthLimits: {
                f1_f2_f3: { min: 3, max: 7, unit: 'km', closed: true },
                go_karting: { min: 0.3, max: 5, unit: 'km', closed: true },
                gt: { min: 3, max: 7, unit: 'km', closed: true },
                hypercar: { min: 3, max: 7, unit: 'km', closed: true },
                lmp: { min: 3, max: 7, unit: 'km', closed: true },
                rallying: {
                    min: 1,
                    max: 800,
                    unit: 'km',
                    closed: false,
                    variants: {
                        normal: { min: 1, max: 2, closed: true },
                        stage: { min: 3, max: 50, closed: false, totalMin: 300, totalMax: 350 },
                        raid: { min: 100, max: 800, closed: false, totalMin: 3000, totalMax: 8000 }
                    }
                }
            }
        }
    },

    RALLY_TAGS: ['rallying'],
    CIRCUIT_TAGS: ['f1_f2_f3', 'go_karting', 'gt', 'hypercar', 'lmp'],

    /** Get membership for current user (checks test users first, then real memberships) */
    async getMembership() {
        const { data: { session } } = await db.auth.getSession();
        let user = session?.user || null;

        // When the editor loads before the cached session is fully restored,
        // ask Supabase for the current user once so premium access still resolves.
        if (!user) {
            const { data: { user: resolvedUser } } = await db.auth.getUser();
            user = resolvedUser || null;
        }

        if (!user) return null;
        const email = this.normalizeIdentifier(user.email);
        const userId = user.id;

        // 1. Check if admin-granted test user
        const testTier = await this._getTestUserTier(email, userId);
        if (testTier) {
            this._syncGrantedTierToMembership(userId, testTier).catch(err => {
                console.warn('[Membership] Could not mirror admin grant into memberships table:', err);
            });
            return { tier: this.normalizeTier(testTier), isTestUser: true };
        }

        // 2. Check Supabase memberships table
        try {
            const { data, error } = await db
                .from('memberships')
                .select('tier, is_active')
                .eq('user_id', userId)
                .eq('is_active', true)
                .order('created_at', { ascending: false })
                .limit(1);
            if (!error && data && data.length > 0) {
                return { tier: this.normalizeTier(data[0].tier), isTestUser: false };
            }
        } catch (e) {
            console.warn('[Membership] Supabase query failed, falling back to local:', e);
        }

        // 3. Fallback to localStorage
        try {
            const local = JSON.parse(localStorage.getItem(MEMBERSHIP_LOCAL_KEY) || '{}');
            const localMembership = local[email] || local[user.email];
            if (localMembership && localMembership.is_active) {
                return { tier: this.normalizeTier(localMembership.tier), isTestUser: false };
            }
        } catch (e) { /* ignore */ }

        return null;
    },

    /** Set membership (simulated purchase — stores locally + Supabase) */
    async setMembership(tier) {
        tier = this.normalizeTier(tier);
        const { data: { session } } = await db.auth.getSession();
        if (!session) return { ok: false, error: 'Not authenticated' };
        const email = this.normalizeIdentifier(session.user.email);
        const userId = session.user.id;

        // Store in localStorage
        try {
            const local = JSON.parse(localStorage.getItem(MEMBERSHIP_LOCAL_KEY) || '{}');
            local[email] = { tier, is_active: true, created_at: Date.now() };
            localStorage.setItem(MEMBERSHIP_LOCAL_KEY, JSON.stringify(local));
        } catch (e) { /* ignore */ }

        // Store in Supabase
        try {
            // Deactivate existing
            await db.from('memberships').update({ is_active: false }).eq('user_id', userId);
            // Insert new
            const { error } = await db.from('memberships').insert({
                user_id: userId,
                tier,
                is_active: true
            });
            if (error) throw error;
        } catch (e) {
            console.warn('[Membership] Supabase save failed (local saved):', e);
        }

        return { ok: true };
    },

    /** Cancel membership */
    async cancelMembership() {
        const { data: { session } } = await db.auth.getSession();
        if (!session) return { ok: false, error: 'Not authenticated' };
        const email = this.normalizeIdentifier(session.user.email);
        const userId = session.user.id;

        try {
            const local = JSON.parse(localStorage.getItem(MEMBERSHIP_LOCAL_KEY) || '{}');
            if (local[email]) { local[email].is_active = false; }
            localStorage.setItem(MEMBERSHIP_LOCAL_KEY, JSON.stringify(local));
        } catch (e) { /* ignore */ }

        try {
            await db.from('memberships').update({ is_active: false }).eq('user_id', userId);
        } catch (e) { console.warn('[Membership] Cancel failed on Supabase:', e); }

        return { ok: true };
    },

    /** Get available tags for current user based on membership */
    async getAvailableTags() {
        const membership = await this.getMembership();
        if (!membership) return { tags: [], tier: null, tagLabels: {}, lengthLimits: {}, hasSubscription: false };
        const tierDef = this.TIERS[membership.tier];
        if (!tierDef) return { tags: [], tier: null, tagLabels: {}, lengthLimits: {}, hasSubscription: false };
        return {
            tags: tierDef.tags,
            tier: membership.tier,
            tagLabels: tierDef.tagLabels,
            lengthLimits: tierDef.lengthLimits,
            hasSubscription: true
        };
    },

    /** Check if a set of tags is valid (Rally + Circuit cannot mix) */
    isValidTagCombination(selectedTags) {
        const hasCircuit = selectedTags.some(t => this.CIRCUIT_TAGS.includes(t));
        const hasRally = selectedTags.some(t => this.RALLY_TAGS.includes(t));
        return !(hasCircuit && hasRally);
    },

    /** Get length limits for a set of tags (uses the widest range) */
    getLengthLimitsForTags(selectedTags, tier) {
        const tierDef = this.TIERS[tier];
        if (!tierDef || selectedTags.length === 0) return null;
        let minLen = Infinity, maxLen = 0;
        for (const tag of selectedTags) {
            const limits = tierDef.lengthLimits[tag];
            if (limits) {
                minLen = Math.min(minLen, limits.min);
                maxLen = Math.max(maxLen, limits.max);
            }
        }
        if (minLen === Infinity) return null;
        return { min: minLen, max: maxLen };
    },

    /** Check test user tier */
    async _getTestUserTier(email, userId) {
        const normalizedEmail = this.normalizeIdentifier(email);
        const normalizedUserId = this.normalizeIdentifier(userId);
        // Check Supabase first
        try {
            const { data: emailMatch, error: emailError } = await db
                .from('admin_test_users')
                .select('tier')
                .eq('email', normalizedEmail)
                .limit(1);
            if (!emailError && emailMatch && emailMatch.length > 0) {
                return emailMatch[0].tier;
            }

            if (normalizedUserId) {
                const { data: idMatch, error: idError } = await db
                    .from('admin_test_users')
                    .select('tier')
                    .eq('email', normalizedUserId)
                    .limit(1);
                if (!idError && idMatch && idMatch.length > 0) {
                    return idMatch[0].tier;
                }
            }
        } catch (e) {
            console.warn('[Membership] Test user check failed on Supabase:', e);
        }
        // Fallback to localStorage
        try {
            const testUsers = JSON.parse(localStorage.getItem(TEST_USERS_LOCAL_KEY) || '[]');
            const found = testUsers.find(u => {
                const normalizedStored = this.normalizeIdentifier(u.email || '');
                return normalizedStored === normalizedEmail || normalizedStored === normalizedUserId;
            });
            return found ? found.tier : null;
        } catch (e) { return null; }
    },

    async _syncGrantedTierToMembership(userId, tier) {
        tier = this.normalizeTier(tier);
        if (!userId || !tier) return;
        const { data, error } = await db
            .from('memberships')
            .select('id, tier, is_active')
            .eq('user_id', userId)
            .eq('is_active', true)
            .order('created_at', { ascending: false })
            .limit(1);
        if (error) throw error;
        if (data && data.length > 0 && data[0].tier === tier) return;

        await db.from('memberships').update({ is_active: false }).eq('user_id', userId);
        const { error: insertError } = await db.from('memberships').insert({
            user_id: userId,
            tier,
            is_active: true
        });
        if (insertError) throw insertError;
    }
};

// ─── ADMIN ────────────────────────────────────────────────────────────────────

const ApexAdmin = {
    normalizeIdentifier(identifier) {
        return (identifier || '').trim().toLowerCase();
    },

    async _getCurrentSessionEmail() {
        const { data: { session } } = await db.auth.getSession();
        return session?.user?.email || null;
    },

    async _loadAdminRows() {
        try {
            const { data, error } = await db
                .from('admin_users')
                .select('email, role, added_by, created_at')
                .order('created_at', { ascending: false });
            if (!error && Array.isArray(data)) {
                return data.map(entry => ({
                    ...entry,
                    email: this.normalizeIdentifier(entry?.email),
                    role: (entry?.role || 'admin').toLowerCase()
                })).filter(entry => entry.email);
            }
        } catch (e) {
            console.warn('[Admin] Could not load admin_users list:', e);
        }

        const fallback = [];
        ADMIN_EMAILS.forEach(email => {
            const value = this.normalizeIdentifier(email);
            if (value) fallback.push({ email: value, role: 'admin', added_by: 'default' });
        });
        return fallback;
    },

    async _loadAdminEmails() {
        const rows = await this._loadAdminRows();
        const normalized = new Set();
        rows.forEach(entry => normalized.add(this.normalizeIdentifier(entry.email)));

        ADMIN_EMAILS.forEach(email => normalized.add(this.normalizeIdentifier(email)));

        try {
            const stored = JSON.parse(localStorage.getItem(ADMIN_EMAILS_LOCAL_KEY) || '[]');
            (Array.isArray(stored) ? stored : []).forEach(email => normalized.add(this.normalizeIdentifier(email)));
        } catch (e) { /* ignore */ }

        return Array.from(normalized).filter(Boolean);
    },

    async _persistAdminEmailList(emails) {
        const normalized = Array.from(new Set((emails || []).map(email => this.normalizeIdentifier(email)).filter(Boolean)));
        localStorage.setItem(ADMIN_EMAILS_LOCAL_KEY, JSON.stringify(normalized));
        return normalized;
    },

    async logAuditEvent(action, targetEmail, details) {
        const actorEmail = await this._getCurrentSessionEmail();
        try {
            await db.from('admin_audit_logs').insert({
                actor_email: actorEmail || 'system',
                action,
                target_email: targetEmail || null,
                details: details || null
            });
        } catch (e) {
            console.warn('[Admin] Audit log write failed:', e);
        }
    },

    async getAdminProfile(identifier) {
        const email = this.normalizeIdentifier(identifier);
        if (!email) return null;
        const rows = await this._loadAdminRows();
        return rows.find(entry => this.normalizeIdentifier(entry.email) === email) || null;
    },

    async isAdmin(identifier) {
        const email = this.normalizeIdentifier(identifier || await this._getCurrentSessionEmail());
        if (!email) return false;
        const profile = await this.getAdminProfile(email);
        return Boolean(profile);
    },

    async canManage(identifier) {
        const email = this.normalizeIdentifier(identifier || await this._getCurrentSessionEmail());
        if (!email) return false;
        const profile = await this.getAdminProfile(email);
        return Boolean(profile && ['owner', 'admin'].includes(profile.role || 'admin'));
    },

    async addAdminUser(identifier, role = 'admin') {
        identifier = this.normalizeIdentifier(identifier);
        if (!identifier) return { ok: false, error: 'Email is required' };

        const existing = await this.getAdminProfile(identifier);
        if (existing) {
            return { ok: true, message: 'This admin email is already present.' };
        }

        const next = await this._loadAdminEmails();
        const normalized = [...next, identifier];
        await this._persistAdminEmailList(normalized);

        try {
            const { data: { session } } = await db.auth.getSession();
            const { error } = await db.from('admin_users').upsert({
                email: identifier,
                role: (role || 'admin').toLowerCase(),
                added_by: session?.user?.email || 'admin'
            }, { onConflict: 'email' });
            if (error) throw error;
        } catch (e) {
            console.warn('[Admin] Could not persist admin user to Supabase:', e);
        }

        await this.logAuditEvent('add_admin', identifier, `Granted ${role || 'admin'} access`);
        return { ok: true, admins: normalized };
    },

    async removeAdminUser(identifier) {
        identifier = this.normalizeIdentifier(identifier);
        if (!identifier) return { ok: false, error: 'Email is required' };

        const next = (await this._loadAdminEmails()).filter(email => email !== identifier);
        await this._persistAdminEmailList(next);

        try {
            await db.from('admin_users').delete().eq('email', identifier);
        } catch (e) {
            console.warn('[Admin] Could not remove admin user from Supabase:', e);
        }

        await this.logAuditEvent('remove_admin', identifier, 'Removed admin access');
        return { ok: true, admins: next };
    },

    async listAdminUsers() {
        const rows = await this._loadAdminRows();
        return rows.map(entry => ({
            email: entry.email,
            role: entry.role || 'admin',
            added_by: entry.added_by || 'system',
            created_at: entry.created_at || null
        }));
    },

    async requestAdminAccess(email, reason) {
        const identifier = this.normalizeIdentifier(email);
        if (!identifier) return { ok: false, error: 'Email is required' };

        try {
            const { error } = await db.from('admin_access_requests').insert({
                email: identifier,
                reason: reason || null,
                status: 'pending',
                requested_by: identifier
            });
            if (error) throw error;
        } catch (e) {
            console.warn('[Admin] Could not submit access request:', e);
            return { ok: false, error: 'Could not submit access request.' };
        }

        await this.logAuditEvent('request_admin_access', identifier, reason || 'No reason provided');
        return { ok: true };
    },

    async listAccessRequests() {
        try {
            const { data, error } = await db
                .from('admin_access_requests')
                .select('id, email, reason, status, requested_by, created_at')
                .order('created_at', { ascending: false });
            if (!error && Array.isArray(data)) {
                return data.map(entry => ({ ...entry, email: this.normalizeIdentifier(entry.email) }));
            }
        } catch (e) {
            console.warn('[Admin] Could not load access requests:', e);
        }
        return [];
    },

    async approveAccessRequest(id, email) {
        if (!id) return { ok: false, error: 'Request id is required' };
        const identifier = this.normalizeIdentifier(email);
        try {
            const { error } = await db.from('admin_access_requests').update({ status: 'approved' }).eq('id', id);
            if (error) throw error;
        } catch (e) {
            console.warn('[Admin] Could not approve access request:', e);
            return { ok: false, error: 'Could not approve access request.' };
        }

        if (identifier) {
            await this.addAdminUser(identifier, 'admin');
        }
        await this.logAuditEvent('approve_admin_request', identifier, 'Approved admin request');
        return { ok: true };
    },

    async rejectAccessRequest(id, email) {
        if (!id) return { ok: false, error: 'Request id is required' };
        const identifier = this.normalizeIdentifier(email);
        try {
            const { error } = await db.from('admin_access_requests').update({ status: 'rejected' }).eq('id', id);
            if (error) throw error;
        } catch (e) {
            console.warn('[Admin] Could not reject access request:', e);
            return { ok: false, error: 'Could not reject access request.' };
        }
        await this.logAuditEvent('reject_admin_request', identifier, 'Rejected admin request');
        return { ok: true };
    },

    async listAuditLogs(limit = 20) {
        try {
            const { data, error } = await db
                .from('admin_audit_logs')
                .select('id, actor_email, action, target_email, details, created_at')
                .order('created_at', { ascending: false })
                .limit(limit);
            if (!error && Array.isArray(data)) {
                return data;
            }
        } catch (e) {
            console.warn('[Admin] Could not load audit logs:', e);
        }
        return [];
    },

    async blockUser(identifier, reason) {
        const email = this.normalizeIdentifier(identifier);
        if (!email) return { ok: false, error: 'Email is required' };
        try {
            const { error } = await db.from('user_blocks').upsert({
                email,
                reason: reason || null,
                blocked_by: await this._getCurrentSessionEmail() || 'admin'
            }, { onConflict: 'email' });
            if (error) throw error;
        } catch (e) {
            console.warn('[Admin] Could not block user:', e);
            return { ok: false, error: 'Could not block user.' };
        }
        await this.logAuditEvent('block_user', email, reason || 'No reason');
        return { ok: true };
    },

    async unblockUser(identifier) {
        const email = this.normalizeIdentifier(identifier);
        if (!email) return { ok: false, error: 'Email is required' };
        try {
            await db.from('user_blocks').delete().eq('email', email);
        } catch (e) {
            console.warn('[Admin] Could not unblock user:', e);
            return { ok: false, error: 'Could not unblock user.' };
        }
        await this.logAuditEvent('unblock_user', email, 'Unblocked user');
        return { ok: true };
    },

    async listBlockedUsers() {
        try {
            const { data, error } = await db
                .from('user_blocks')
                .select('email, reason, blocked_by, created_at')
                .order('created_at', { ascending: false });
            if (!error && Array.isArray(data)) {
                return data.map(entry => ({ ...entry, email: this.normalizeIdentifier(entry.email) }));
            }
        } catch (e) {
            console.warn('[Admin] Could not load blocked users:', e);
        }
        return [];
    },

    async listPremiumMembers() {
        const mergeMembers = (memberships, testUsers, localMembers) => {
            const merged = new Map();
            const pushEntry = (entry, source) => {
                if (!entry) return;
                const email = this.normalizeIdentifier(entry.email || entry.user_email || entry.userEmail || '');
                const key = email || entry.user_id || entry.id || JSON.stringify(entry);
                merged.set(key, {
                    ...entry,
                    email: email || entry.email || entry.user_email || entry.userEmail || entry.user_id || 'Unknown',
                    tier: entry.tier || 'circuit',
                    is_active: entry.is_active !== false,
                    source
                });
            };

            (memberships || []).forEach(member => pushEntry(member, 'membership'));
            (testUsers || []).forEach(user => pushEntry({ ...user, is_active: true, created_at: user.created_at || Date.now() }, 'grant'));
            (localMembers || []).forEach(member => pushEntry(member, 'local'));

            return Array.from(merged.values()).sort((a, b) => {
                const aTime = new Date(a.created_at || 0).getTime() || 0;
                const bTime = new Date(b.created_at || 0).getTime() || 0;
                return bTime - aTime;
            });
        };

        let localMembers = [];
        try {
            const local = JSON.parse(localStorage.getItem(MEMBERSHIP_LOCAL_KEY) || '{}');
            localMembers = Object.entries(local).map(([email, entry]) => ({
                email,
                tier: entry?.tier || 'circuit',
                is_active: entry?.is_active !== false,
                created_at: entry?.created_at || Date.now()
            }));
        } catch (e) { /* ignore */ }

        let memberships = [];
        try {
            const { data, error } = await db
                .from('memberships')
                .select('id, user_id, email, tier, is_active, created_at')
                .order('created_at', { ascending: false });
            if (!error && Array.isArray(data)) {
                memberships = data;
            }
        } catch (e) {
            console.warn('[Admin] Could not load memberships from Supabase:', e);
        }

        let testUsers = [];
        try {
            const { data, error } = await db
                .from('admin_test_users')
                .select('email, tier, granted_by, created_at')
                .order('created_at', { ascending: false });
            if (!error && Array.isArray(data)) {
                testUsers = data;
            }
        } catch (e) {
            console.warn('[Admin] Could not load admin grants from Supabase:', e);
        }

        return mergeMembers(memberships, testUsers, localMembers);
    },

    /** Add test user with premium tier */
    async addTestUser(identifier, tier) {
        identifier = this.normalizeIdentifier(identifier);
        if (!['circuit', 'rally', 'all_access'].includes(tier)) {
            return { ok: false, error: 'Invalid tier' };
        }
        if (!identifier) {
            return { ok: false, error: 'Identifier is required' };
        }

        try {
            const { data: { session } } = await db.auth.getSession();
            const { error } = await db.from('admin_test_users').upsert({
                email: identifier,
                tier,
                granted_by: session?.user?.email || 'admin'
            }, { onConflict: 'email' });
            if (error) throw error;

            const { data: inserted, error: readBackError } = await db
                .from('admin_test_users')
                .select('email, tier')
                .eq('email', identifier)
                .limit(1);
            if (readBackError) throw readBackError;
            if (!inserted || inserted.length === 0) {
                throw new Error('Grant could not be read back after saving.');
            }
        } catch (e) {
            console.warn('[Admin] Supabase save failed:', e);
            return {
                ok: false,
                error: `Could not grant shared premium access. Make sure the SQL in supabase-migrations.sql has been run and that the admin_test_users table exists. ${e.message || ''}`.trim()
            };
        }

        try {
            const testUsers = JSON.parse(localStorage.getItem(TEST_USERS_LOCAL_KEY) || '[]');
            const existing = testUsers.findIndex(u => u.email === identifier);
            if (existing >= 0) {
                testUsers[existing].tier = tier;
            } else {
                testUsers.push({ email: identifier, tier, created_at: Date.now() });
            }
            localStorage.setItem(TEST_USERS_LOCAL_KEY, JSON.stringify(testUsers));
        } catch (e) { /* ignore */ }

        await this.logAuditEvent('grant_premium', identifier, `Granted ${tier} access`);
        return { ok: true };
    },

    async removeTestUser(identifier) {
        identifier = this.normalizeIdentifier(identifier);

        try {
            const { error } = await db.from('admin_test_users').delete().eq('email', identifier);
            if (error) throw error;
        } catch (e) {
            console.warn('[Admin] Supabase delete failed:', e);
            return {
                ok: false,
                error: `Could not remove shared premium access. ${e.message || ''}`.trim()
            };
        }

        try {
            const testUsers = JSON.parse(localStorage.getItem(TEST_USERS_LOCAL_KEY) || '[]');
            localStorage.setItem(TEST_USERS_LOCAL_KEY, JSON.stringify(testUsers.filter(u => u.email !== identifier)));
        } catch (e) { /* ignore */ }

        await this.logAuditEvent('remove_premium', identifier, 'Removed premium grant');
        return { ok: true };
    },

    async listTestUsers() {
        const mergeUsers = (remoteUsers, localUsers) => {
            const merged = new Map();
            [...(remoteUsers || []), ...(localUsers || [])].forEach(user => {
                if (!user || !user.email) return;
                const key = this.normalizeIdentifier(user.email);
                merged.set(key, {
                    ...user,
                    email: key
                });
            });
            return Array.from(merged.values()).sort((a, b) => {
                const aTime = new Date(a.created_at || 0).getTime() || 0;
                const bTime = new Date(b.created_at || 0).getTime() || 0;
                return bTime - aTime;
            });
        };

        let localUsers = [];
        try {
            localUsers = JSON.parse(localStorage.getItem(TEST_USERS_LOCAL_KEY) || '[]');
        } catch (e) { /* ignore */ }

        try {
            const { data, error } = await db
                .from('admin_test_users')
                .select('email, tier, granted_by, created_at')
                .order('created_at', { ascending: false });
            if (!error && data) {
                return mergeUsers(data, localUsers);
            }
        } catch (e) {
            console.warn('[Admin] Supabase list failed, using local:', e);
        }

        return mergeUsers([], localUsers);
    }
};

// ─── UPDATE REDIRECT ──────────────────────────────────────────────────────────

const ApexUpdate = {
    CURRENT_VERSION: 'v1.2',

    /** Check if the current page should redirect to update.html */
    shouldRedirect() {
        const path = window.location.pathname.split('/').pop() || '';
        if (path === 'login.html' || path === 'update.html') return false;
        const seenVersion = localStorage.getItem('apex_update_version');
        return seenVersion !== this.CURRENT_VERSION;
    },

    /** Mark the current update version as acknowledged */
    acknowledge() {
        localStorage.setItem('apex_update_version', this.CURRENT_VERSION);
    },

    /** Redirect to update.html if the user hasn't seen this version yet */
    redirect() {
        if (this.shouldRedirect()) {
            window.location.replace('update.html');
        }
    }
};

// ─── EXPORT ───────────────────────────────────────────────────────────────────

// Expose helpers to pages that read them from `window.*`
window.ApexAuth = ApexAuth;
window.ApexProjects = ApexProjects;
window.ApexMembership = ApexMembership;
window.ApexAdmin = ApexAdmin;
window.ApexUpdate = ApexUpdate;
