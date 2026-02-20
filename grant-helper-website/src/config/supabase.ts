/**
 * Supabase Client Configuration (Production-Ready Stub)
 *
 * This file demonstrates how Supabase would be integrated for production.
 * Currently NOT used in the demo to keep local file upload working for Feb 20 deadline.
 *
 * To enable Supabase in production:
 * 1. Run migration: supabase/migrations/001_initial_schema.sql
 * 2. Add SUPABASE_URL and SUPABASE_ANON_KEY to .env
 * 3. Create 'user-docs' storage bucket in Supabase Dashboard
 * 4. Configure Storage RLS policies (see migration file comments)
 * 5. Replace src/api/extractDocuments.ts with uploadToSupabase() calls
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';

// These would be set in production .env:
// VITE_SUPABASE_URL=https://your-project.supabase.co
// VITE_SUPABASE_ANON_KEY=your-anon-key

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || '';
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

// createClient() throws if URL is empty, so only create when configured (avoids blank screen when .env is missing)
function getSupabase(): SupabaseClient {
  if (supabaseUrl && supabaseAnonKey) {
    return createClient(supabaseUrl, supabaseAnonKey);
  }
  // Return a dummy that satisfies auth.getSession() so WorkspaceView etc. don't crash
  return {
    auth: {
      getSession: () => Promise.resolve({ data: { session: null }, error: null }),
      getUser: () => Promise.resolve({ data: { user: null }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
      signIn: async () => ({ data: null, error: new Error('Supabase not configured') }),
      signOut: async () => ({ error: null }),
      signUp: async () => ({ data: null, error: new Error('Supabase not configured') }),
    },
    storage: {} as SupabaseClient['storage'],
    from: () => ({} as ReturnType<SupabaseClient['from']>),
    rpc: () => ({} as ReturnType<SupabaseClient['rpc']>),
    rest: {} as SupabaseClient['rest'],
    realtime: {} as SupabaseClient['realtime'],
    removeChannel: () => ({}),
    getChannels: () => ([]),
    channel: () => ({} as any),
  } as unknown as SupabaseClient;
}

export const supabase = getSupabase();

/**
 * Upload a file to Supabase Storage
 * @param file - File object to upload
 * @param userId - User ID (from auth.user())
 * @returns Storage path if successful
 */
export async function uploadToSupabase(file: File, userId: string): Promise<string> {
  const documentId = crypto.randomUUID();
  const storagePath = `${userId}/${documentId}/${file.name}`;

  console.log(storagePath);
  console.log(file);

  // Upload to Storage
  const { error: uploadError } = await supabase.storage
    .from('user-docs')
    .upload(storagePath, file);

  if (uploadError){
    console.error('Error uploading file to Supabase Storage:', uploadError);
    throw uploadError;
  }
  // Insert metadata into documents table (id is auto-generated)

  console.log({
    user_id: userId,
    filename: file.name,
    mime_type: file.type,
    storage_path: storagePath,
    file_size_bytes: file.size,
    status: 'uploaded',
  });
  const { error: dbError } = await supabase.from('documents').insert({
    user_id: userId,
    filename: file.name,
    mime_type: file.type,
    storage_path: storagePath,
    file_size_bytes: file.size,
    status: 'uploaded',
  });

  if (dbError){
    throw dbError;
  }

  return storagePath;
}

/**
 * Fetch user's documents from Supabase
 * @param userId - User ID (from auth.user())
 * @returns Array of document metadata
 */
export async function getUserDocuments(userId: string) {
  const { data, error } = await supabase
    .from('documents')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (error) throw error;
  return data;
}

/**
 * Search user's document chunks (RAG retrieval)
 * @param userId - User ID (from auth.user())
 * @param query - Search query
 * @param limit - Max results
 * @returns Relevant document chunks ranked by relevance
 */
export async function searchDocuments(
  userId: string,
  query: string,
  limit: number = 10
) {
  const { data, error } = await supabase.rpc('search_user_documents', {
    p_user_id: userId,
    p_query: query,
    p_limit: limit,
  });

  if (error) throw error;
  return data;
}

/**
 * Delete a document and its chunks
 * @param documentId - Document UUID
 */
export async function deleteDocument(documentId: string) {
  // Get document metadata first
  const { data: doc, error: fetchError } = await supabase
    .from('documents')
    .select('storage_path')
    .eq('id', documentId)
    .single();

  if (fetchError) throw fetchError;

  // Delete from storage
  const { error: storageError } = await supabase.storage
    .from('user-docs')
    .remove([doc.storage_path]);

  if (storageError) throw storageError;

  // Database cascades will auto-delete chunks due to ON DELETE CASCADE
  const { error: dbError } = await supabase
    .from('documents')
    .delete()
    .eq('id', documentId);

  if (dbError) throw dbError;
}
