# Apex Architect — Codebase Overview

## Summary
Apex Architect is a web-based Formula 1 / motorsport circuit designer built with vanilla HTML, CSS, and JavaScript, backed by Supabase for authentication, project storage, and membership management. Users sign in, create/edit track layouts on a canvas-based editor, and save them to the cloud. The system supports premium tiers (Circuit, Rally, Ultimate) that unlock specific track tags with class-based length rules. An admin panel allows granting premium access to specific users.

## Architecture

**Primary pattern**: Static multi-page web app (SPA-style auth guards on each page) with Supabase as the backend. Each HTML page is self-contained with its own `<script>` block and CSS, sharing common logic via `supabase-client.js`.

**Technology stack**:
- **Language**: Vanilla JavaScript (no framework)
- **Runtime**: Browser (static HTML served via any web server)
- **Backend**: Supabase (PostgreSQL + Auth + REST API)
- **Auth**: Supabase Auth with email/password + session persistence via `apex_sb_session` localStorage key
- **Styling**: Tailwind CSS (CDN) + custom CSS with CSS variables and glassmorphism design
- **Fonts**: Google Fonts (Orbitron + Outfit)
- **Canvas**: HTML5 Canvas (for the track designer)

**Major subsystems**:
1. **Auth system** (`supabase-client.js` via `ApexAuth`) — handles sign-in, sign-up, session management
2. **Project storage** (`supabase-client.js` via `ApexProjects`) — CRUD operations on track designs stored in Supabase `projects` table + local cache
3. **Membership system** (`supabase-client.js` via `ApexMembership`) — tier management, tag availability, length limit rules
4. **Admin system** (`supabase-client.js` via `ApexAdmin`) — test user management (grant/remove premium tiers)
5. **Circuit editor** (`f1track.html` + `f1track.js`) — canvas-based track designer with Bezier/point manipulation, DRS zones, sector markers, corner profiling
6. **UI pages** — `index.html` (dashboard), `login.html`, `premium.html`, `admin.html`, `tutorial.html`, `update.html`

**Execution flow**:
- User lands on any page → auth guard checks `supabase.auth.getSession()` → redirects to `login.html` if no session
- login.html authenticates → redirects to `index.html` (workspace dashboard)
- From dashboard, user can create new track (`f1track.html?new=true`) or open existing (`f1track.html?id=xxx`)
- The track editor auto-saves to localStorage, and a bridge in `f1track.html` syncs changes to Supabase

## Directory Structure

```
Apex Arcitecht/
├── index.html                — Workspace dashboard — lists saved circuits, user profile
├── login.html                — Sign-in / sign-up form with auth tabs
├── f1track.html              — Circuit designer canvas with sidebar tools and dock
├── f1track.js                — (supplementary) Canvas rendering, node editing, tool logic
├── premium.html              — Premium plan cards: Circuit Pro ($14.99), Rally Pro ($12.99), Ultimate ($19.99)
├── admin.html                — Admin panel: test user grant/remove by email
├── tutorial.html             — Static tutorial page (design guide)
├── update.html               — Release notes page (current update changelog)
├── supabase-client.js        — Central module: Supabase init + ApexAuth, ApexProjects, ApexMembership, ApexAdmin
├── apex-auth.js              — Legacy standalone auth system (localStorage-based, not currently used by main pages)
├── native-bridge.js          — (referenced but not present in file listing) localStorage wrapper
├── gmail-automation.js       — (referenced but legacy) Gmail verification flow
├── supabase-migrations.sql   — SQL migrations for Supabase tables
├── Track.png                 — Static asset (track illustration)
├── trackrea.png              — Static asset (hero background)
└── config/                   — MCP configuration and skill definitions (not part of core app)
```

## Key Abstractions

### ApexAuth (supabase-client.js)
- **File**: `Apex Arcitecht/supabase-client.js`
- **Responsibility**: Manages user authentication via Supabase Auth (email/password). Provides sign-in, sign-up, sign-out, and session retrieval.
- **Key methods**:
  - `signUp(email, password, displayName)` → creates account, returns user
  - `signIn(email, password)` → authenticates, returns user
  - `signOut()` → ends session, clears local project cache
  - `getUser()` → returns current user from cached session (no network)
- **Lifecycle**: Session persists in localStorage key `apex_sb_session`. Accessed on every page load for auth guard.
- **Used by**: All pages (index.html, f1track.html, premium.html, admin.html)

### ApexProjects (supabase-client.js)
- **File**: `Apex Arcitecht/supabase-client.js`
- **Responsibility**: CRUD for track designs stored in Supabase `projects` table, with localStorage caching.
- **Key methods**:
  - `fetchAll()` → fetches all projects from Supabase, caches to localStorage key `apex_projects_v1`
  - `upsert(project)` → insert or update a single project (used by the auto-save bridge)
  - `delete(id)` → delete from Supabase and local cache
- **Lifecycle**: Data flows from Supabase → localStorage (read by f1track.js) → editor modifies → bridge syncs back.
- **Used by**: index.html (dashboard listing), f1track.html (auto-save bridge)

### ApexMembership (supabase-client.js)
- **File**: `Apex Arcitecht/supabase-client.js`
- **Responsibility**: Manages premium membership tiers (circuit, rally, all_access). Determines available track tags, length limits, and tag combination rules.
- **Key methods**:
  - `getMembership()` → checks Supabase memberships table + admin_test_users table + localStorage fallback
  - `setMembership(tier)` → activates a tier (simulated purchase, stored in Supabase + localStorage)
  - `cancelMembership()` → deactivates current tier
  - `getAvailableTags()` → returns tag definitions based on current membership
  - `isValidTagCombination(tags)` → prevents mixing circuit + rally tags
  - `getLengthLimitsForTags(tags, tier)` → returns min/max length constraints
- **Key constant**: `TIERS` object defining three tiers with their tags, labels, and per-tag length limits
- **Used by**: f1track.html (tag selector, length validation), premium.html (plan display/activation)

### ApexAdmin (supabase-client.js)
- **File**: `Apex Arcitecht/supabase-client.js`
- **Responsibility**: Admin functions for managing test users who get premium access via admin panel.
- **Key methods**:
  - `isAdmin()` → always returns true (any authenticated user can access admin panel)
  - `addTestUser(identifier, tier)` → grants premium tier to an email or user ID
  - `removeTestUser(identifier)` → revokes premium grant
  - `listTestUsers()` → returns merged list from Supabase `admin_test_users` table + localStorage
- **Used by**: admin.html

### Circuit Editor (f1track.html)
- **File**: `Apex Arcitecht/f1track.html`
- **Responsibility**: Full canvas-based track designer. Handles node placement, Bezier tangents, DRS zones, sector markers, corner profiling, background image tracing, AI track analysis, undo/redo, auto-close circuit toggle, and JSON/PNG export.
- **Key UI sections**: Left sidebar (tags, scale, background, tools), top toolbar (save, export, clear), bottom dock (point inspector, quick controls)
- **Lifecycle**: Loaded with `?new=true` or `?id=xxx` URL params. Auto-saves on changes via a localStorage bridge that also syncs to Supabase.
- **Used by**: Users who design tracks.

## Data Flow

### Authentication Flow
1. User enters email/password on `login.html` → `ApexAuth.signIn()` calls Supabase Auth
2. Supabase returns session → stored in localStorage key `apex_sb_session`
3. User redirected to `index.html`
4. Every page runs an auth guard: `supabase.auth.getSession()` → redirect to `login.html` if null
5. Logout button calls `ApexAuth.signOut()` → clears session → redirect to `login.html`

### Project Save Flow
1. User edits track → editor calls `ApexNativeBridge.setItem('apex_projects_v1', ...)` 
2. A patched bridge in `f1track.html` intercepts the call
3. Detects the current project ID from URL params or editor instance
4. Calls `ApexProjects.upsert(project)` → writes to Supabase `projects` table
5. Deletions are detected by comparing old project list with new project list

### Membership Resolution Flow
1. `index.html`, `f1track.html`, `premium.html` all call `ApexMembership.getMembership()`
2. Resolves session user from Supabase
3. Checks `admin_test_users` table first (admin grants take priority)
4. If no admin grant, checks `memberships` table for active tier
5. Falls back to localStorage cache
6. Returns `{ tier, isTestUser }` or null (free tier)

## Non-Obvious Behaviors & Design Decisions

- **Admin access is open to all authenticated users**: `ApexAdmin.isAdmin()` always returns `true`. There's no admin role check — any signed-in user can access the admin panel and grant/revoke premium tiers. This is a development/debugging convenience, not production-ready security.

- **Dual storage with localStorage fallback**: Both projects and memberships are cached in localStorage alongside Supabase. This means:
  - Projects work offline (read from localStorage)
  - Memberships work even if Supabase is unreachable
  - But it also means stale data can persist: clearing localStorage can cause membership loss until the next Supabase sync

- **Membership grant sync is one-way**: `_syncGrantedTierToMembership` mirrors admin_test_user grants into the memberships table, but if the admin later removes the user from admin_test_users, the memberships table is NOT cleaned up — the user retains access until the membership expires or is manually cancelled.

- **Tag combination validation happens client-side only**: `ApexMembership.isValidTagCombination()` prevents mixing circuit + rally tags, but there's no server-side enforcement. A user could bypass the frontend check.

- **The editor auto-save uses a monkey-patched bridge**: `window.ApexNativeBridge.setItem` is overridden in `f1track.html` to intercept writes to the localStorage key and forward them to Supabase. This is a fragile pattern — if `native-bridge.js` ever loads differently, the patch may not apply.

- **No project ownership verification**: The Supabase `projects` upsert uses `onConflict: 'id'` but doesn't include a `user_id` filter on reads. A user could potentially read another user's projects if they know the project ID.

- **The `apex-auth.js` file is legacy code**: It implements a standalone localStorage-based auth system (`ApexAuth.register/login/logout` with password hashing). This file is not used by the main pages — they all use `supabase-client.js` with Supabase Auth instead. But it's still present in the codebase and could cause confusion.

## Module Reference

| File | Purpose |
|------|---------|
| `index.html` | Workspace dashboard — lists saved circuits, user profile, create/open/delete projects |
| `login.html` | Auth page — sign-in/sign-up with Supabase email/password |
| `f1track.html` | Circuit designer — canvas editor with full toolset, sidebar, and dock |
| `f1track.js` | Supplementary JS for f1track.html (canvas rendering, node editing) |
| `premium.html` | Premium subscription page — three tier cards with pricing and feature lists |
| `admin.html` | Admin panel — grant/remove premium tiers by email |
| `tutorial.html` | Static tutorial/guide page |
| `update.html` | Release notes for the current version |
| `supabase-client.js` | Central module — Supabase client init + ApexAuth, ApexProjects, ApexMembership, ApexAdmin |
| `apex-auth.js` | Legacy standalone auth system (not in active use) |
| `supabase-migrations.sql` | SQL scripts for creating Supabase tables |

## Suggested Reading Order

1. **`supabase-client.js`** — Start here. This is the brain of the app. Understand the auth, project CRUD, membership tiers, and admin functions. Everything else builds on this.

2. **`login.html`** — Understand the auth flow and how sessions are created.

3. **`index.html`** — See how the dashboard fetches and renders projects, handles auth state, and links to the editor.

4. **`f1track.html`** — The most complex page. Focus on the auth guard, the auto-save bridge patch, and how it loads/saves projects.

5. **`premium.html`** — Understand how membership tiers are displayed, selected, and activated.

6. **`update.html` and `admin.html`** — Simpler pages; review for context on update notes and admin features.
