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

// ─── EMAIL VERIFICATION CODES ────────────────────────────────────────────────

const ApexVerification = {
    /** Generate a random 6-digit verification code */
    generateCode() {
        return String(Math.floor(100000 + Math.random() * 900000));
    },

    /** Send verification code to user email via Gmail MCP */
    async sendVerificationCodeEmail(email, code) {
        try {
            const response = await fetch('https://mcp.zapier.com/api/v1/connect', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    action: 'send_gmail_message',
                    params: {
                        to: email,
                        subject: 'Your Apex Architect Verification Code',
                        body: `
Your verification code is: <strong>${code}</strong>

This code expires in 15 minutes.

If you didn't request this code, please ignore this email.

— Apex Architect Team
                        `
                    }
                })
            });
            
            if (!response.ok) {
                throw new Error(`Failed to send email: ${response.statusText}`);
            }
            return { ok: true };
        } catch (err) {
            console.error('[ApexVerification] Email send failed:', err);
            return { ok: false, error: err.message };
        }
    },

    /** Create verification code record and send email */
    async requestVerificationCode(email) {
        const { data: { session } } = await db.auth.getSession();
        if (!session) return { ok: false, error: 'Not authenticated' };

        const code = this.generateCode();
        const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes from now

        // Insert verification code into database
        const { data, error } = await db.from('verification_codes').insert({
            user_id: session.user.id,
            email,
            code,
            expires_at: expiresAt.toISOString()
        }).select().single();

        if (error) {
            console.error('[ApexVerification] DB insert failed:', error);
            return { ok: false, error: error.message };
        }

        // Send code via Gmail
        const emailResult = await this.sendVerificationCodeEmail(email, code);
        if (!emailResult.ok) {
            // Try to delete the code record if email send failed
            await db.from('verification_codes').delete().eq('id', data.id);
            return emailResult;
        }

        return { ok: true, codeId: data.id };
    },

    /** Verify the code entered by user */
    async verifyCode(email, userEnteredCode) {
        const { data: { session } } = await db.auth.getSession();
        if (!session) return { ok: false, error: 'Not authenticated' };

        // Get the latest verification code for this user
        const { data: codes, error: queryError } = await db
            .from('verification_codes')
            .select('*')
            .eq('user_id', session.user.id)
            .eq('email', email)
            .eq('verified', false)
            .order('created_at', { ascending: false })
            .limit(1);

        if (queryError) {
            return { ok: false, error: queryError.message };
        }

        if (!codes || codes.length === 0) {
            return { ok: false, error: 'No verification code found. Please request a new code.' };
        }

        const verificationRecord = codes[0];

        // Check if expired
        if (new Date() > new Date(verificationRecord.expires_at)) {
            return { ok: false, error: 'Verification code expired. Please request a new code.' };
        }

        // Check attempt limit
        if (verificationRecord.attempts >= verificationRecord.max_attempts) {
            return { ok: false, error: 'Too many failed attempts. Please request a new code.' };
        }

        // Check if code matches
        if (userEnteredCode !== verificationRecord.code) {
            // Increment attempts
            await db
                .from('verification_codes')
                .update({ attempts: verificationRecord.attempts + 1 })
                .eq('id', verificationRecord.id);
            
            return { ok: false, error: 'Invalid code. Please try again.' };
        }

        // Code is valid! Mark as verified
        const { error: updateError } = await db
            .from('verification_codes')
            .update({ verified: true })
            .eq('id', verificationRecord.id);

        if (updateError) {
            return { ok: false, error: updateError.message };
        }

        return { ok: true };
    },

    /** Check if user has verified their email */
    async isVerified(email) {
        const { data: { session } } = await db.auth.getSession();
        if (!session) return false;

        const { data, error } = await db
            .from('verification_codes')
            .select('verified')
            .eq('user_id', session.user.id)
            .eq('email', email)
            .eq('verified', true)
            .limit(1);

        if (error) {
            console.error('[ApexVerification] Check failed:', error);
            return false;
        }

        return data && data.length > 0;
    },

    /** Get remaining time for current verification code */
    async getCodeExpiryTime(email) {
        const { data: { session } } = await db.auth.getSession();
        if (!session) return null;

        const { data } = await db
            .from('verification_codes')
            .select('expires_at')
            .eq('user_id', session.user.id)
            .eq('email', email)
            .eq('verified', false)
            .order('created_at', { ascending: false })
            .limit(1);

        if (data && data.length > 0) {
            const expiresAt = new Date(data[0].expires_at);
            const now = new Date();
            const secondsLeft = Math.max(0, Math.floor((expiresAt - now) / 1000));
            return secondsLeft;
        }
        return null;
    }
};

