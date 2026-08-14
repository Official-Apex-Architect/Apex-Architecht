/**
 * Apex Architect — Gmail Automation Service
 * ─────────────────────────────────────────────────────────────
 * Sends review request emails via Zapier MCP Gmail integration
 * Tracks sent status in Supabase review_emails table
 * Implements exponential backoff retry logic
 * ─────────────────────────────────────────────────────────────
 */

const ReviewEmailService = (() => {
    const ZAPIER_MCP_URL = 'https://mcp.zapier.com/api/v1/connect';
    const EMAIL_TEMPLATE = {
        subject: 'How is your experience with Apex Architect?',
        body: `Hello {{user_name}},

Thank you for using Apex Architect.

We would love to hear your feedback.

Please reply to this email and tell us:

- What you liked
- What could be improved
- Features you would like to see
- Any bugs you encountered

Your feedback helps us improve Apex Architect.

Thank you,

Apex Architect Team`
    };

    const RETRY_CONFIG = {
        maxAttempts: 3,
        backoffMs: [1000, 2000, 4000] // exponential backoff: 1s, 2s, 4s
    };

    /**
     * Check if review email was already sent to this user
     * @param {string} userId - Supabase user ID
     * @returns {Promise<boolean>} true if already sent
     */
    async function checkIfAlreadySent(userId) {
        try {
            const { data, error } = await window.supabase
                .from('review_emails')
                .select('id')
                .eq('user_id', userId)
                .eq('status', 'sent')
                .limit(1);

            if (error) {
                console.error('[ReviewEmail] DB check error:', error);
                return false; // Assume not sent on error (will try to send)
            }

            const alreadySent = data && data.length > 0;
            if (alreadySent) {
                console.log(`[ReviewEmail] User ${userId} already received review email`);
            }
            return alreadySent;
        } catch (err) {
            console.error('[ReviewEmail] checkIfAlreadySent exception:', err);
            return false;
        }
    }

    /**
     * Get or create a pending review email record
     * @param {string} userId - Supabase user ID
     * @param {string} email - User email
     * @param {string} triggerEvent - Event type (signup, email_verified, circuit_created, circuit_exported)
     * @returns {Promise<object>} Record with id, user_id, etc.
     */
    async function getOrCreateRecord(userId, email, triggerEvent) {
        try {
            // Check if there's an existing pending or failed record
            const { data: existing, error: fetchError } = await window.supabase
                .from('review_emails')
                .select('*')
                .eq('user_id', userId)
                .in('status', ['pending', 'failed'])
                .limit(1);

            if (fetchError) throw fetchError;

            if (existing && existing.length > 0) {
                return existing[0];
            }

            // Create new record
            const { data: newRecord, error: insertError } = await window.supabase
                .from('review_emails')
                .insert([{
                    user_id: userId,
                    email: email,
                    status: 'pending',
                    attempt_count: 0,
                    trigger_event: triggerEvent
                }])
                .select()
                .single();

            if (insertError) throw insertError;
            return newRecord;
        } catch (err) {
            console.error('[ReviewEmail] getOrCreateRecord error:', err);
            throw err;
        }
    }

    /**
     * Update record status and metadata
     * @param {string} recordId - Record UUID
     * @param {object} updates - { status, attempt_count, last_error, sent_at }
     */
    async function updateRecord(recordId, updates) {
        try {
            const { error } = await window.supabase
                .from('review_emails')
                .update({
                    ...updates,
                    updated_at: new Date().toISOString()
                })
                .eq('id', recordId);

            if (error) throw error;
        } catch (err) {
            console.error('[ReviewEmail] updateRecord error:', err);
            throw err;
        }
    }

    /**
     * Send email via Zapier MCP Gmail integration
     * @param {string} recipientEmail - Target email address
     * @param {string} recipientName - Recipient display name
     * @param {string} subject - Email subject
     * @param {string} body - Email body
     * @returns {Promise<boolean>} true if sent successfully
     */
    async function sendViaZapierMCP(recipientEmail, recipientName, subject, body) {
        try {
            // Construct the MCP request payload
            const payload = {
                action: 'send_gmail',
                params: {
                    to: recipientEmail,
                    subject: subject,
                    body: body,
                    cc: [],
                    bcc: []
                }
            };

            console.log('[ReviewEmail] Sending via Zapier MCP:', recipientEmail);

            const response = await fetch(`${ZAPIER_MCP_URL}/actions/execute`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Zapier MCP error: ${response.status} ${errorText}`);
            }

            const result = await response.json();
            console.log('[ReviewEmail] Zapier MCP response:', result);

            // Check if Zapier confirmed successful send
            if (result.success || result.status === 'success') {
                return true;
            }

            throw new Error(`Zapier MCP did not confirm success: ${JSON.stringify(result)}`);
        } catch (err) {
            console.error('[ReviewEmail] sendViaZapierMCP error:', err);
            throw err;
        }
    }

    /**
     * Render email body by interpolating template variables
     * @param {string} displayName - User display name
     * @returns {string} Rendered body
     */
    function renderEmailBody(displayName) {
        return EMAIL_TEMPLATE.body.replace('{{user_name}}', displayName);
    }

    /**
     * Sleep for N milliseconds
     * @param {number} ms - Milliseconds to sleep
     */
    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Send review email with retry logic
     * @param {string} userId - Supabase user ID
     * @param {string} email - User email
     * @param {string} displayName - User display name
     * @param {string} triggerEvent - Event type
     * @returns {Promise<boolean>} true if sent (eventually)
     */
    async function sendReviewRequest(userId, email, displayName, triggerEvent = 'signup') {
        try {
            // Step 1: Check if already sent
            if (await checkIfAlreadySent(userId)) {
                console.log(`[ReviewEmail] Skipping: User ${userId} already sent review email`);
                return true; // Don't error, just skip
            }

            // Step 2: Create or get pending record
            const record = await getOrCreateRecord(userId, email, triggerEvent);
            console.log(`[ReviewEmail] Processing record ${record.id} for user ${userId}`);

            // Step 3: Render email body
            const renderedBody = renderEmailBody(displayName);
            const subject = EMAIL_TEMPLATE.subject;

            // Step 4: Attempt to send with exponential backoff retry
            let lastError = null;
            for (let attempt = 0; attempt < RETRY_CONFIG.maxAttempts; attempt++) {
                try {
                    console.log(`[ReviewEmail] Attempt ${attempt + 1}/${RETRY_CONFIG.maxAttempts}`);

                    const success = await sendViaZapierMCP(email, displayName, subject, renderedBody);

                    if (success) {
                        // Update record as sent
                        await updateRecord(record.id, {
                            status: 'sent',
                            sent_at: new Date().toISOString(),
                            attempt_count: attempt + 1,
                            last_error: null
                        });

                        console.log(`[ReviewEmail] ✓ Email sent to ${email} (attempt ${attempt + 1})`);
                        return true;
                    }
                } catch (err) {
                    lastError = err;
                    console.warn(`[ReviewEmail] Attempt ${attempt + 1} failed:`, err.message);

                    // Update record with attempt count and error
                    await updateRecord(record.id, {
                        attempt_count: attempt + 1,
                        last_error: err.message
                    });

                    // Sleep before retry (unless this was the last attempt)
                    if (attempt < RETRY_CONFIG.maxAttempts - 1) {
                        const backoffMs = RETRY_CONFIG.backoffMs[attempt];
                        console.log(`[ReviewEmail] Retrying in ${backoffMs}ms...`);
                        await sleep(backoffMs);
                    }
                }
            }

            // Step 5: All retries exhausted
            console.error(`[ReviewEmail] ✗ Failed to send after ${RETRY_CONFIG.maxAttempts} attempts`);
            await updateRecord(record.id, {
                status: 'failed',
                last_error: lastError ? lastError.message : 'Unknown error'
            });

            return false;
        } catch (err) {
            console.error('[ReviewEmail] sendReviewRequest exception:', err);
            return false;
        }
    }

    /**
     * Log activity (for debugging/analytics)
     * Optionally retrieve recent email sends
     * @param {string} userId - Supabase user ID (optional)
     * @param {number} limit - Number of recent records
     * @returns {Promise<array>} Recent records
     */
    async function logActivity(userId = null, limit = 10) {
        try {
            let query = window.supabase
                .from('review_emails')
                .select('*')
                .order('created_at', { ascending: false })
                .limit(limit);

            if (userId) {
                query = query.eq('user_id', userId);
            }

            const { data, error } = await query;
            if (error) throw error;

            console.table(data);
            return data;
        } catch (err) {
            console.error('[ReviewEmail] logActivity error:', err);
            return [];
        }
    }

    // Public API
    return {
        sendReviewRequest,
        checkIfAlreadySent,
        logActivity,
        getEmailTemplate: () => ({ ...EMAIL_TEMPLATE })
    };
})();

// Expose globally for use in HTML/JS files
window.ReviewEmailService = ReviewEmailService;
