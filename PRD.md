# MKP Chat — Product Requirements Document (PRD)

**Document Version:** 1.0  
**Status:** Draft  
**Prepared By:** Senior Product Manager & Full-Stack Architect  
**Date:** April 2026  
**Classification:** Internal — Confidential

---

## Table of Contents

1. Executive Summary
2. Product Vision & Goals
3. Tech Stack & Architecture Overview
4. Visual Identity & UI Framework
5. Feature Breakdown
   - 5.1 User Authentication & Onboarding
   - 5.2 Home / All Chats
   - 5.3 Status System
   - 5.4 Random Chat (Omegle-Style)
   - 5.5 Settings & Privacy
   - 5.6 Admin Panel
6. Database Architecture
7. System Logic & Business Rules
8. Real-Time Logic (Supabase Realtime)
9. Security & Row Level Security (RLS) Policies
10. Non-Functional Requirements
11. Out of Scope (v1.0)

---

## 1. Executive Summary
(mcp already connected with supabase)
MKP Chat is a cross-platform instant messaging application targeting mobile and desktop users. Modeled after the hybrid experience of WhatsApp and Telegram, it delivers personal chat, a 24-hour status feed, and a novel anonymous random-chat feature — all within a single, cohesive product.

The application is built on a modern, cost-efficient stack: **React + Vite** on the frontend, **Capacitor** as the native mobile wrapper for iOS/Android, and **Supabase** (PostgreSQL, Auth, Realtime, Storage) as the entire backend. This serverless-first approach minimizes infrastructure overhead while providing enterprise-grade real-time capabilities from day one.

**Primary Users:** General consumers seeking a fast, private, and visually clean messaging experience.  
**Secondary Users:** Internal administrators managing users, content moderation, and platform health.

---

## 2. Product Vision & Goals

| Goal | Description |
|---|---|
| Accessibility | Available on iOS, Android, and Web/Desktop from a single codebase |
| Real-Time | Sub-second message delivery and live status updates via Supabase Realtime |
| Privacy-First | Granular user privacy controls backed by database-level RLS policies |
| Discovery | An Omegle-style random chat mechanism for organic user connection |
| Modularity | Clean feature separation to allow iterative releases without regressions |

---

## 3. Tech Stack & Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│                  CLIENT LAYER                       │
│                                                     │
│   React + Vite (Web / Desktop PWA)                  │
│   Capacitor Wrapper (iOS App / Android App)         │
│   React Router v6 (SPA Routing)                     │
│   Zustand or Context API (Global State)             │
└─────────────────────┬───────────────────────────────┘
                      │  HTTPS / WSS
┌─────────────────────▼───────────────────────────────┐
│                 SUPABASE BACKEND                    │
│                                                     │
│   Auth          → Email/Password, JWT Sessions      │
│   PostgreSQL    → All relational data               │
│   Realtime      → Message delivery, pairing queue   │
│   Storage       → Profile pictures, media           │
│   Edge Functions→ Business logic (cron, pairing)    │
└─────────────────────────────────────────────────────┘
```

### Client-Side Libraries

| Library | Purpose |
|---|---|
| `@supabase/supabase-js` | Supabase SDK — auth, DB queries, realtime subscriptions |
| `@capacitor/core` | Native mobile bridge |
| `emoji-picker-react` | Emoji picker component |
| `date-fns` | Date utilities (cooldowns, expiry logic) |
| `react-router-dom` | SPA routing |
| `lucide-react` | Icon set |

---

## 4. Visual Identity & UI Framework

### Color Palette

| Token | Value | Usage |
|---|---|---|
| `--color-primary` | `#38BDF8` (Sky Blue 400) | CTA buttons, active indicators, sent message bubbles |
| `--color-primary-dark` | `#0EA5E9` (Sky Blue 500) | Hover/pressed states |
| `--color-surface` | `#FFFFFF` (White) | Background panels, received message bubbles |
| `--color-on-surface` | `#0F172A` (Near Black) | Primary text |
| `--color-muted` | `#94A3B8` | Secondary/placeholder text |
| `--color-dark-bg` | `#0F172A` | Dark mode background |

### Layout: Responsive / Adaptive

```
Mobile (< 768px)              Desktop (≥ 768px)
┌──────────────┐              ┌──────────┬─────────────────┐
│   Header     │              │          │    Header       │
│              │              │          │─────────────────│
│   Content    │              │ Sidebar  │                 │
│   Area       │              │   Nav    │   Content Area  │
│              │              │          │                 │
│──────────────│              │          │                 │
│ Bottom Nav   │              └──────────┴─────────────────┘
└──────────────┘
```

**Mobile Navigation Tabs (Bottom Bar):** Chats | Status | Search | Profile  
**Desktop Navigation (Left Sidebar):** Same four sections rendered as a collapsible icon-and-label sidebar.

### Theme Modes

- **Light Mode:** White surfaces, sky-blue accents, near-black text.
- **Dark Mode:** `#0F172A` background, sky-blue accents, white text.
- Users may also select from a set of preset UI style variants (e.g., Rounded Bubbles, Compact, Classic) stored in their profile row.

---

## 5. Feature Breakdown

### 5.1 User Authentication & Onboarding

#### Sign-Up Flow: Step 1 — Registration

**Screen Name:** `RegisterScreen`  
**Route:** `/register`

| Field | Type | Validation |
|---|---|---|
| Full Name | Text | Required, 2–60 chars |
| Email | Email | Required, unique, valid format |
| Date of Birth | Date Picker | Required, user must be ≥ 13 years old |
| Gender | Select | Required; options: Male, Female, Non-Binary, Prefer Not to Say |
| Password | Password | Required, min 8 chars, 1 uppercase, 1 number |
| Confirm Password | Password | Must match Password field |

On submission: Supabase `auth.signUp()` is called. A `profiles` row is created via a database trigger (`on_auth_user_created`). The user is advanced to Step 2.

#### Sign-Up Flow: Step 2 — Username Selection

**Screen Name:** `UsernameScreen`  
**Route:** `/register/username`

| Rule | Detail |
|---|---|
| Format | 3–20 chars, alphanumeric + underscores only, no spaces |
| Uniqueness | Real-time availability check against `profiles.username` on input change (debounced 400ms) |
| Reservation | Username is stored immediately on confirm |
| Post-Action | Redirect to `/` (Home / All Chats) |

#### Sign-In Flow

**Route:** `/login`  
Fields: Email + Password. Uses `supabase.auth.signInWithPassword()`. On success, redirect to `/`.

#### Session Management

JWT tokens are persisted via Supabase's built-in session management. Capacitor stores sessions in native secure storage. Sessions expire after 7 days of inactivity; silent refresh is attempted automatically.

---

### 5.2 Home / All Chats

**Route:** `/`  
**Component:** `ChatsListScreen`

#### Chat List

- Displays all conversations the authenticated user participates in, ordered by `last_message_at` descending.
- Each list item shows: Avatar, Display Name, last message preview (truncated to 40 chars), and timestamp.
- Unread message count badge renders for conversations with `read: false` messages.

#### Search

- A search bar at the top of the Chats screen filters the list in real-time by contact name or username.
- A dedicated **"Find Random Chat"** button / shortcut is also exposed here (see Section 5.4).

#### Chat Conversation View

**Route:** `/chat/:chatId`  
**Component:** `ConversationScreen`

| Feature | Detail |
|---|---|
| Message Types | Plain text, Images (uploaded to Supabase Storage), Emoji |
| Image Upload | File picker → upload to `storage/chat-media/{chatId}/{filename}` → store public URL in message |
| Emoji Picker | Tray above keyboard using `emoji-picker-react` |
| Bubble Layout | Sent messages right-aligned (sky blue), received left-aligned (white/dark-surface) |
| Timestamps | Show time on each bubble; show date separator for day changes |
| Real-Time | New messages appear instantly via Supabase Realtime channel subscription on `messages` table filtered by `chat_id` |
| Read Receipts | Message `read_at` timestamp is updated when the recipient's conversation view is active |

---

### 5.3 Status System

**Route:** `/status`  
**Component:** `StatusScreen`

#### Posting a Status

- Supports **Text** and **Emoji** only (no images in v1.0).
- Composer: A text area with embedded emoji picker.
- Character limit: 280 characters.
- On post: Insert row into `statuses` table with `expires_at = NOW() + INTERVAL '24 hours'`.

#### Viewing Statuses

- List of statuses from contacts (users with an existing chat) and, if public, any user.
- Each status card shows: Avatar, username, status text, and relative time ("2h ago").
- Expired statuses are hidden on the client (filtered by `expires_at > NOW()`) and cleaned by a Supabase scheduled Edge Function.

#### Privacy Options

| Setting | Behavior |
|---|---|
| Chat List Only | Status visible only to users who share an existing chat with the author |
| Public (Anyone) | Status visible to all authenticated users |

Privacy is stored on the individual status row (`visibility ENUM('contacts', 'public')`), not as a global setting, so each post can have a different audience.

---

### 5.4 Random Chat (Omegle-Style)

**Entry Point:** Search screen → "Random Chat" button  
**Route:** `/random-chat`  
**Component:** `RandomChatScreen`

#### Pairing Logic (Full Flow)

1. User taps "Start Random Chat."
2. Client calls a Supabase Edge Function `join_random_queue`.
3. Edge Function:
   a. Checks `random_pairing_queue` for another user currently `status = 'waiting'`.
   b. **If a waiting user is found:** Update both rows to `status = 'matched'`, create a temporary `chat` row with `type = 'random'`, and return the `chat_id` and partner's username to both users via Realtime broadcast.
   c. **If no one is waiting:** Insert a new row with `status = 'waiting'` and hold. The client subscribes to a personal Realtime channel (`random:userId`) and waits for a broadcast event.
4. On match: Both clients receive a broadcast event with payload `{ chat_id, partner_username }`.
5. UI shows an alert: **"Connected successfully with @{partner_username}!"**
6. Chat interface renders identically to a normal conversation (Text + Emoji only for Random Chat).

#### Random Chat Interface

| Element | Detail |
|---|---|
| Header | Displays partner's `@username` |
| Chat Area | Standard message bubbles |
| Disconnect Button | Prominent; closes the session |
| On Disconnect | Updates `random_pairing_queue` row to `status = 'disconnected'`; marks the temporary chat as `active = false`; both users are redirected to `/` |
| Timeout | If no partner is found within 60 seconds, the queue row is deleted and user is shown "No one available right now. Try again later." |

#### Safety Note

Random chat conversations are ephemeral. No random chat history is retained after disconnect (messages in a `type = 'random'` chat are deleted 1 hour after `active = false`).

---

### 5.5 Settings & Privacy

**Route:** `/settings`  
**Component:** `SettingsScreen` (with nested sub-screens)

#### Profile Customization

| Feature | Detail |
|---|---|
| Change Profile Picture | Upload new image to `storage/avatars/{userId}` → update `profiles.avatar_url` |
| Change Display Name | Immediate update to `profiles.full_name` |
| Change Username | Subject to **5-day cooldown** (see Section 7 — Business Rules). Shows countdown if restricted. |

#### UI Customization

| Setting | Options |
|---|---|
| Theme Color | Sky Blue (default), Purple, Green, Orange |
| Mode | Light, Dark, System |
| Bubble Style | Rounded (default), Classic, Compact |

Preferences are stored in `profiles.ui_preferences` (JSONB column).

#### Privacy Settings

| Setting | Behavior |
|---|---|
| Public Profile | All profile details visible to any authenticated user |
| Private Profile | Only Profile Picture, Display Name, and Username are visible to non-contacts; DOB, gender, and email are hidden |

Stored as `profiles.privacy_mode ENUM('public', 'private')`.

---

### 5.6 Admin Panel

**Route:** `/1234/admin`  
**Access:** This route is not linked from anywhere in the app UI. Access is by direct URL only.  
**Authentication:** Separate fixed-credential login form (`admin_credentials` table with a single row seeded at deployment). Uses a separate session flag (`is_admin = true` in JWT custom claims via Supabase service role).

**Design Philosophy:** Functional, minimal, no branding. Data-density over aesthetics.

#### Admin Dashboard — Sections

**A. Analytics Overview**

| Metric | Source |
|---|---|
| Total Registered Users | `COUNT(*) FROM profiles` |
| Active Users (Last 7 Days) | `COUNT(*) FROM profiles WHERE last_seen_at > NOW() - INTERVAL '7 days'` |
| Total Messages Sent | `COUNT(*) FROM messages` |
| Active Statuses | `COUNT(*) FROM statuses WHERE expires_at > NOW()` |
| Random Chat Sessions (Today) | `COUNT(*) FROM chats WHERE type='random' AND created_at > today` |

**B. User Management**

- Paginated table: `id`, `full_name`, `username`, `email`, `created_at`, `last_seen_at`, `privacy_mode`, `is_suspended`.
- **Actions per row:**
  - **Edit:** Modify `full_name`, `username`, `privacy_mode`. Changes bypass the 5-day cooldown.
  - **Suspend / Unsuspend:** Toggle `profiles.is_suspended`. Suspended users receive a "Your account has been suspended" message on login.
  - **Delete:** Hard-delete the Supabase Auth user (cascades to `profiles` and all related data via FK constraints).

**C. Status Management**

- Table of all active statuses: `username`, `content`, `visibility`, `created_at`, `expires_at`.
- **Actions:** Admin can delete any status immediately (hard delete).

---

## 6. Database Architecture

All tables reside in Supabase's PostgreSQL instance. The `auth.users` table is managed by Supabase Auth. All custom tables live in the `public` schema.

### 6.1 Table: `profiles`

```sql
CREATE TABLE public.profiles (
  id               UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name        TEXT NOT NULL,
  username         TEXT NOT NULL UNIQUE,
  email            TEXT NOT NULL UNIQUE,
  dob              DATE NOT NULL,
  gender           TEXT CHECK (gender IN ('male','female','non_binary','prefer_not_to_say')),
  avatar_url       TEXT,
  privacy_mode     TEXT NOT NULL DEFAULT 'public' CHECK (privacy_mode IN ('public','private')),
  is_suspended     BOOLEAN NOT NULL DEFAULT FALSE,
  last_seen_at     TIMESTAMPTZ,
  username_changed_at TIMESTAMPTZ,   -- Used for 5-day cooldown enforcement
  ui_preferences   JSONB DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### 6.2 Table: `chats`

```sql
CREATE TABLE public.chats (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type             TEXT NOT NULL DEFAULT 'personal' CHECK (type IN ('personal','random')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_message_at  TIMESTAMPTZ,
  active           BOOLEAN NOT NULL DEFAULT TRUE
);
```

### 6.3 Table: `chat_participants`

```sql
CREATE TABLE public.chat_participants (
  chat_id          UUID NOT NULL REFERENCES public.chats(id) ON DELETE CASCADE,
  user_id          UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  joined_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (chat_id, user_id)
);
```

### 6.4 Table: `messages`

```sql
CREATE TABLE public.messages (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id          UUID NOT NULL REFERENCES public.chats(id) ON DELETE CASCADE,
  sender_id        UUID NOT NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  content          TEXT,                 -- NULL if media-only message
  media_url        TEXT,                 -- NULL if text-only message
  media_type       TEXT CHECK (media_type IN ('image','emoji',NULL)),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  read_at          TIMESTAMPTZ           -- NULL = unread
);
```

> Constraint: At least one of `content` or `media_url` must be non-null.  
> `CHECK (content IS NOT NULL OR media_url IS NOT NULL)`

### 6.5 Table: `statuses`

```sql
CREATE TABLE public.statuses (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  content          TEXT NOT NULL,
  visibility       TEXT NOT NULL DEFAULT 'contacts' CHECK (visibility IN ('contacts','public')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at       TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours')
);
```

### 6.6 Table: `random_pairing_queue`

```sql
CREATE TABLE public.random_pairing_queue (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL UNIQUE REFERENCES public.profiles(id) ON DELETE CASCADE,
  status           TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','matched','disconnected','timed_out')),
  chat_id          UUID REFERENCES public.chats(id),  -- Populated once matched
  joined_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

> The `UNIQUE` constraint on `user_id` ensures a user cannot be in the queue twice simultaneously.

### 6.7 Table: `admin_credentials`

```sql
CREATE TABLE public.admin_credentials (
  id               SERIAL PRIMARY KEY,
  username         TEXT NOT NULL UNIQUE,
  password_hash    TEXT NOT NULL,  -- bcrypt hash
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

> Seeded once at deployment. No self-service management.

### 6.8 Entity Relationship Diagram (Simplified)

```
auth.users ──────────────────── profiles
                                    │
              ┌─────────────────────┼──────────────────────┐
              │                     │                      │
        statuses            chat_participants         random_pairing_queue
                                    │
                                  chats
                                    │
                                messages
```

---

## 7. System Logic & Business Rules

### 7.1 Username Change — 5-Day Cooldown

**Rule:** A user may only change their username once every 5 calendar days.

**Implementation:**

```sql
-- Before allowing an update, check:
SELECT username_changed_at FROM profiles WHERE id = $user_id;

-- Only proceed if:
username_changed_at IS NULL
OR username_changed_at < NOW() - INTERVAL '5 days'

-- On successful update:
UPDATE profiles
SET username = $new_username,
    username_changed_at = NOW()
WHERE id = $user_id;
```

On the client: If the cooldown is active, the username field is disabled and a message is shown: "You can change your username again in X days." The remaining days are calculated as `5 - DATE_PART('day', NOW() - username_changed_at)`.

**Admin Override:** Admin edits to usernames do not update `username_changed_at`, so they do not trigger or reset the user's cooldown clock.

---

### 7.2 Status 24-Hour Expiry

**Rule:** Statuses automatically expire 24 hours after creation.

**Layer 1 — Client-side filter:** All queries for statuses include `WHERE expires_at > NOW()` so expired statuses never appear, even if not yet deleted.

**Layer 2 — Supabase Scheduled Edge Function (`cleanup_statuses`):**

```typescript
// Runs every 30 minutes via Supabase cron
Deno.serve(async () => {
  const { error } = await supabase
    .from('statuses')
    .delete()
    .lt('expires_at', new Date().toISOString());

  return new Response(JSON.stringify({ error }), { status: 200 });
});
```

This two-layer approach ensures expired content is never served, while the periodic deletion keeps the database clean and index performance healthy.

---

### 7.3 Random Chat Timeout

**Rule:** If a user waits more than 60 seconds without being matched, the session is cancelled.

**Implementation:** A client-side `setTimeout` of 60,000ms is started when the user joins the queue. If it fires before a match broadcast is received:
1. Call Edge Function `leave_random_queue` to delete the queue row.
2. Display: "No one available right now. Try again later."
3. Navigate back to `/`.

---

### 7.4 Random Chat Ephemeral Cleanup

**Rule:** Messages in a `type = 'random'` chat are deleted 1 hour after the chat is marked `active = false`.

**Implementation:** A Supabase Edge Function `cleanup_random_chats` runs every 15 minutes:

```typescript
const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

await supabase
  .from('messages')
  .delete()
  .in('chat_id',
    supabase.from('chats')
      .select('id')
      .eq('type', 'random')
      .eq('active', false)
      .lt('updated_at', oneHourAgo)
  );
```

---

### 7.5 New User Profile Trigger

**Rule:** On Supabase Auth user creation, a corresponding `profiles` row is created automatically.

```sql
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name, dob, gender)
  VALUES (
    NEW.id,
    NEW.email,
    NEW.raw_user_meta_data ->> 'full_name',
    (NEW.raw_user_meta_data ->> 'dob')::DATE,
    NEW.raw_user_meta_data ->> 'gender'
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
```

---

## 8. Real-Time Logic (Supabase Realtime)

Supabase Realtime uses PostgreSQL's logical replication to broadcast row-level changes over WebSockets. MKP Chat uses three distinct Realtime patterns.

### 8.1 Instant Messaging

Each open conversation subscribes to a Postgres Changes channel filtered by `chat_id`:

```typescript
const subscription = supabase
  .channel(`chat:${chatId}`)
  .on(
    'postgres_changes',
    {
      event: 'INSERT',
      schema: 'public',
      table: 'messages',
      filter: `chat_id=eq.${chatId}`
    },
    (payload) => {
      appendMessageToUI(payload.new);
    }
  )
  .subscribe();
```

When a user sends a message:
1. Client calls `supabase.from('messages').insert(...)`.
2. PostgreSQL commits the row.
3. Supabase Realtime broadcasts the `INSERT` event.
4. All subscribers (i.e., both chat participants) receive the event and update their UI in under 100ms on typical connections.

The subscription is removed (`subscription.unsubscribe()`) when the conversation component unmounts.

### 8.2 Random Chat Pairing

Because pairing involves coordination between two users who do not yet share a channel, a **Broadcast** channel (not Postgres Changes) is used for the match notification:

```typescript
// Waiting user subscribes to their personal match channel
const waitChannel = supabase
  .channel(`random:${currentUserId}`)
  .on('broadcast', { event: 'matched' }, (payload) => {
    // payload = { chat_id, partner_username }
    navigateTo(`/random-chat/${payload.chat_id}`);
  })
  .subscribe();
```

The Edge Function uses the Supabase Admin client to publish to the waiting user's channel:

```typescript
await supabase.channel(`random:${waitingUserId}`).send({
  type: 'broadcast',
  event: 'matched',
  payload: { chat_id: newChatId, partner_username: currentUsername }
});
```

This approach is reliable because Broadcast channels do not require the receiving user to be a DB row subscriber; the channel name alone is sufficient for routing.

### 8.3 Status Feed Updates

The Status screen subscribes to new public/contact statuses:

```typescript
supabase
  .channel('status-feed')
  .on(
    'postgres_changes',
    { event: 'INSERT', schema: 'public', table: 'statuses' },
    (payload) => {
      if (isVisible(payload.new, currentUserId)) {
        prependStatusToFeed(payload.new);
      }
    }
  )
  .subscribe();
```

`isVisible()` applies the same visibility logic as the database RLS policy (checking contact list and visibility field) client-side to avoid flashing unauthorized status momentarily before it is filtered.

---

## 9. Security & Row Level Security (RLS) Policies

**All tables have RLS enabled by default.** No row is accessible unless explicitly permitted by a policy.

```sql
-- Enable RLS on all tables (run once per table)
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chats ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.statuses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.random_pairing_queue ENABLE ROW LEVEL SECURITY;
```

### 9.1 Profiles RLS

```sql
-- Users can always read their own profile
CREATE POLICY "profiles_select_own"
  ON public.profiles FOR SELECT
  USING (auth.uid() = id);

-- Public profiles visible to all authenticated users
CREATE POLICY "profiles_select_public"
  ON public.profiles FOR SELECT
  USING (privacy_mode = 'public' AND auth.uid() IS NOT NULL);

-- Private profiles: only DP, name, username are accessible
-- (Enforced by a view for partial exposure — see below)

-- Users can only update their own profile
CREATE POLICY "profiles_update_own"
  ON public.profiles FOR UPDATE
  USING (auth.uid() = id);
```

For private profiles, a database view `public.profiles_public_view` exposes only safe fields:

```sql
CREATE VIEW public.profiles_public_view AS
  SELECT id, full_name, username, avatar_url
  FROM public.profiles
  WHERE privacy_mode = 'private';
```

Clients query this view for non-contact, private-mode users.

### 9.2 Messages RLS

```sql
-- Users can only read messages in chats they participate in
CREATE POLICY "messages_select_participant"
  ON public.messages FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.chat_participants cp
      WHERE cp.chat_id = messages.chat_id
        AND cp.user_id = auth.uid()
    )
  );

-- Users can only insert messages into chats they are a participant of
CREATE POLICY "messages_insert_participant"
  ON public.messages FOR INSERT
  WITH CHECK (
    sender_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.chat_participants cp
      WHERE cp.chat_id = messages.chat_id
        AND cp.user_id = auth.uid()
    )
  );
```

### 9.3 Statuses RLS

```sql
-- Users can always see their own statuses
CREATE POLICY "statuses_select_own"
  ON public.statuses FOR SELECT
  USING (user_id = auth.uid() AND expires_at > NOW());

-- Public statuses visible to any authenticated user
CREATE POLICY "statuses_select_public"
  ON public.statuses FOR SELECT
  USING (
    visibility = 'public'
    AND expires_at > NOW()
    AND auth.uid() IS NOT NULL
  );

-- Contact statuses: visible only if a chat exists between viewer and author
CREATE POLICY "statuses_select_contacts"
  ON public.statuses FOR SELECT
  USING (
    visibility = 'contacts'
    AND expires_at > NOW()
    AND EXISTS (
      SELECT 1 FROM public.chat_participants cp1
      JOIN public.chat_participants cp2 ON cp1.chat_id = cp2.chat_id
      WHERE cp1.user_id = auth.uid()
        AND cp2.user_id = statuses.user_id
    )
  );

-- Users can only insert and delete their own statuses
CREATE POLICY "statuses_insert_own"
  ON public.statuses FOR INSERT
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "statuses_delete_own"
  ON public.statuses FOR DELETE
  USING (user_id = auth.uid());
```

### 9.4 Random Pairing Queue RLS

```sql
-- Users can only see and manage their own queue entry
CREATE POLICY "queue_select_own"
  ON public.random_pairing_queue FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "queue_insert_own"
  ON public.random_pairing_queue FOR INSERT
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "queue_update_own"
  ON public.random_pairing_queue FOR UPDATE
  USING (user_id = auth.uid());

CREATE POLICY "queue_delete_own"
  ON public.random_pairing_queue FOR DELETE
  USING (user_id = auth.uid());
```

> **Important:** The pairing Edge Function runs with the **service_role key** (bypasses RLS) so it can update both users' rows atomically without exposing that privilege to the client.

### 9.5 Admin Panel Security

- The `/1234/admin` route is protected client-side by a route guard checking `is_admin` in the session.
- Admin operations (edit, delete, suspend users) are performed via Supabase Edge Functions authenticated with the service_role key — never the anon key.
- The admin credentials table is not accessible via RLS to any non-service-role connection.
- The obscure URL path provides security-through-obscurity as an additional layer; it is not the sole security mechanism.

---

## 10. Non-Functional Requirements

| Category | Requirement |
|---|---|
| Performance | Chat messages must be delivered within 200ms on a standard broadband connection |
| Offline Support | Last 50 messages per chat cached locally via Capacitor Preferences API; app remains readable offline |
| Scalability | Supabase Free tier supports up to 500MB DB and 2GB bandwidth; upgrade to Pro at 1,000 MAU |
| Accessibility | WCAG 2.1 AA minimum; all interactive elements keyboard-navigable; ARIA labels on icon buttons |
| Internationalisation | UTF-8 throughout; emoji fully supported; RTL layout to be addressed in v2.0 |
| Mobile | Capacitor build targets iOS 15+ and Android 11+; tested on iPhone SE (small screen) and standard Android |
| Browser Support | Latest two versions of Chrome, Firefox, Safari, Edge |

---

## 11. Out of Scope (v1.0)

The following features are explicitly deferred to future versions to maintain v1.0 focus and timeline:

- Voice or video calling
- Group chats (more than 2 participants)
- Message reactions
- Message forwarding or replies (threaded)
- End-to-end encryption (E2E)
- Push notifications (Capacitor Push Notifications Plugin — v1.1)
- Read receipts visibility toggle
- Link previews
- RTL language support
- OAuth / Social login (Google, Apple)
- User blocking and reporting
- Story-style status viewing (Instagram/WhatsApp style tap-through)
- In-app notifications
- Desktop app packaging (Electron / Tauri)

---

*End of MKP Chat PRD v1.0*

---

**Document Control**

| Version | Date | Author | Notes |
|---|---|---|---|
| 1.0 | April 2026 | Senior PM / Architect | Initial draft |