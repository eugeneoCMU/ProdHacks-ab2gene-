# Supabase setup: create tables from initial schema

## 1. Run the migration in Supabase Dashboard

1. Open [Supabase Dashboard](https://supabase.com/dashboard) and select your project.
2. In the left sidebar, go to **SQL Editor**.
3. Click **New query**.
4. Open `supabase/migrations/001_initial_schema.sql` in your repo, copy its **entire contents**, and paste into the SQL Editor.
5. Click **Run** (or press Cmd/Ctrl + Enter).

You should see “Success. No rows returned.” This creates:

- **documents** – metadata for uploaded files
- **document_chunks** – extracted text for RAG
- Indexes, RLS policies, and the `search_user_documents` function

**If you get "new row violates row-level security policy" when uploading:** run the RLS fix migration:

1. In **SQL Editor**, click **New query**.
2. Copy the full contents of `supabase/migrations/002_grant_rls_fix.sql` and paste.
3. Click **Run**.

This grants `anon` and `authenticated` access to the tables so inserts succeed.

## 2. Create the Storage bucket (for file uploads)

1. In the left sidebar, go to **Storage**.
2. Click **New bucket**.
3. Name: `user-docs`.
4. Set to **Private** (recommended).
5. Click **Create bucket**.

Then add policies so users can access only their own files:

1. Open the `user-docs` bucket and go to **Policies**.
2. **New policy** → “For full customization” (or use templates if available).
3. Add policies that use `auth.uid()` and the path prefix, for example:

- **Upload (INSERT):** Allow if `(storage.foldername(name))[1] = auth.uid()::text`
- **Read (SELECT):** Same condition.
- **Delete (DELETE):** Same condition.

Or use the policy SQL from the comments at the bottom of `001_initial_schema.sql`.

## 3. Enable Anonymous sign-in (optional, for uploads without login)

If your app uses anonymous sign-in so uploads work before users create an account:

1. Go to **Authentication** → **Providers**.
2. Find **Anonymous sign-ins** and turn it **On**.

## 4. Env vars in your app

In your app’s `.env` (e.g. grant-helper-website):

```env
VITE_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
```

Get both from **Project Settings** → **API** in the Supabase Dashboard.
