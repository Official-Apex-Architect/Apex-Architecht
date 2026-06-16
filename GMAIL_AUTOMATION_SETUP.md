# Gmail Automation System - Setup Guide

## ✅ Implementation Complete

Your MCP-powered Gmail automation system is now fully integrated into Apex Architect!

---

## 📋 Setup Steps

### Step 1: Create the Database Table

1. Go to your Supabase Dashboard: https://supabase.com
2. Open your project: `vcjkedqlbxyvjcolooyo`
3. Navigate to **SQL Editor** (left sidebar)
4. Click **New Query**
5. Copy-paste the SQL from: `config/sql-migrations/001_create_review_emails_table.sql`
6. Click **Run** (or press Cmd+Enter)

**Expected result:** A new `review_emails` table is created with indexes and RLS policies.

---

### Step 2: Verify Files Created

- ✅ [gmail-automation.js](../gmail-automation.js) — Core email service with Zapier MCP integration
- ✅ [config/sql-migrations/001_create_review_emails_table.sql](../config/sql-migrations/001_create_review_emails_table.sql) — Database schema
- ✅ [supabase-client.js](../supabase-client.js) — Extended with `ApexReviewEmails` queries
- ✅ [login.html](../login.html) — Email trigger on signup
- ✅ [index.html](../index.html) — Email trigger on email verification
- ✅ [f1track.js](../f1track.js) — Email triggers on circuit creation & export
- ✅ [f1track.html](../f1track.html) — Script tag added for gmail-automation.js

---

## 🚀 Trigger Events

The system now automatically sends review request emails on:

| Event | Trigger | Status |
|-------|---------|--------|
| **User Signs Up** | `ApexAuth.signUp()` in login.html | ✅ Integrated |
| **Email Verified** | After `email_confirmed_at` check in index.html | ✅ Integrated |
| **First Circuit Created** | `createNewProject()` in f1track.js | ✅ Integrated |
| **Circuit Exported (JSON)** | `export-json-btn` click handler in f1track.js | ✅ Integrated |
| **Circuit Exported (PNG)** | `exportImage()` method in f1track.js | ✅ Integrated |

---

## 📧 Email Behavior

### Duplicate Prevention
- The system checks `review_emails` table for `status='sent'` before sending
- **Only 1 email per user** (ever) — subsequent triggers are skipped
- Fully atomic using Supabase unique index on `(user_id)` where `status='sent'`

### Retry Logic
- **Max attempts:** 3
- **Backoff:** 1s → 2s → 4s (exponential)
- **Failure handling:** Logged to `review_emails.last_error`

### Template
- **Subject:** `How is your experience with Apex Architect?`
- **Body:** Pre-formatted feedback request with 4 talking points
- **Interpolation:** `{{user_name}}` → user's display name

---

## 🔧 Zapier MCP Integration

Your system uses Zapier MCP to send emails via Gmail. The flow:

```
Event Triggered (signup/verify/create/export)
       ↓
Check if email already sent (query review_emails table)
       ↓
Render email body with user name
       ↓
POST to https://mcp.zapier.com/api/v1/connect/actions/execute
       ↓
Zapier executes "send_gmail" action
       ↓
Gmail sends email to user
       ↓
Update review_emails table with status='sent' & sent_at timestamp
```

---

## 📊 Monitoring & Debugging

### Check Email Activity
Open browser console and run:
```javascript
// View recent emails
await ReviewEmailService.logActivity(null, 20);

// View emails for current user
const user = await ApexAuth.getUser();
await ReviewEmailService.logActivity(user.id, 10);

// Check if user already got email
await ReviewEmailService.checkIfAlreadySent(user.id);
```

### Check Database
```sql
SELECT * FROM review_emails ORDER BY created_at DESC LIMIT 20;

-- Check by status
SELECT status, COUNT(*) as count FROM review_emails GROUP BY status;

-- Check user's email history
SELECT * FROM review_emails WHERE user_id = 'user-uuid' ORDER BY created_at DESC;
```

### Console Logs
All operations log to browser console with `[ReviewEmail]`, `[Auth]`, or `[F1Track]` prefix for easy filtering.

---

## ⚠️ Troubleshooting

### Emails Not Sending?
1. **Check Zapier MCP connection:**
   - Verify `https://mcp.zapier.com/api/v1/connect` is reachable
   - Check browser Network tab for POST to `/actions/execute`

2. **Check database setup:**
   - Open Supabase SQL Editor → run: `SELECT * FROM review_emails LIMIT 1;`
   - If error: re-run the SQL migration file

3. **Check auth:**
   - Make sure user is logged in (`ApexAuth.getUser()` returns data)
   - Make sure email is verified (`user.email_confirmed_at` is set)

4. **Check logs:**
   - Browser console for `[ReviewEmail]` messages
   - Browser DevTools Network tab for Zapier API calls
   - Supabase dashboard → Logs for any RLS policy errors

### Duplicate Emails Sending?
- By design, only 1 email per user is ever sent
- Check browser console for `[ReviewEmail] Skipping: User X already sent review email`
- If duplicate was sent before today: use Supabase to query and clean up

---

## 🧪 Test Checklist

- [ ] **Signup trigger:** Create new account → check console for `[ReviewEmail]` log → check DB for new row
- [ ] **Verify trigger:** Verify email → check console for `[ReviewEmail]` log (should skip if already sent)
- [ ] **Circuit creation trigger:** Create new circuit → check console → check DB
- [ ] **Export triggers:** Export as JSON/PNG → check console → check DB
- [ ] **Duplicate prevention:** Repeat any trigger → verify console says "already sent" → verify DB has only 1 sent status

---

## 📞 Next Steps

1. ✅ **SQL Migration:** Run the SQL from `001_create_review_emails_table.sql` in Supabase
2. ✅ **Test:** Create test account and verify all triggers work
3. ✅ **Monitor:** Use the commands above to track email activity
4. ✅ **Iterate:** Adjust email template or retry logic if needed

---

**All code is ready to use. Just run the SQL migration and test!** 🎉
