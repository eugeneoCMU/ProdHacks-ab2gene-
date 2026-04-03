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

import { createClient } from '@supabase/supabase-js';

// These would be set in production .env:
// VITE_SUPABASE_URL=https://your-project.supabase.co
// VITE_SUPABASE_ANON_KEY=your-anon-key

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || '';
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

/**
 * Upload a file to Supabase Storage
 * @param file - File object to upload
 * @param userId - User ID (from auth.user())
 * @returns Row id (same UUID as storage segment) and storage path
 */
export async function uploadToSupabase(
  file: File,
  userId: string
): Promise<{ id: string; storagePath: string }> {
  const documentId = crypto.randomUUID();
  const storagePath = `${userId}/${documentId}/${file.name}`;

  // Upload to Storage
  const { error: uploadError } = await supabase.storage
    .from('user-docs')
    .upload(storagePath, file);

  if (uploadError) throw uploadError;

  // Keep documents.id aligned with path segment so extract/chunk persist uses the same UUID
  const { error: dbError } = await supabase.from('documents').insert({
    id: documentId,
    user_id: userId,
    filename: file.name,
    mime_type: file.type,
    storage_path: storagePath,
    file_size_bytes: file.size,
    status: 'uploaded',
  });

  if (dbError) throw dbError;

  return { id: documentId, storagePath };
}

/**
 * Fetch user's documents from Supabase
 * @param userId - User ID (from auth.user())
 * @returns Array of document metadata
 */
export async function getUserDocuments(userId: string): Promise<UserDocumentRow[]> {
  const { data, error } = await supabase
    .from('documents')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (error) throw error;
  return (data ?? []) as UserDocumentRow[];
}

export type UserDocumentRow = {
  id: string;
  filename: string;
  mime_type: string | null;
  file_size_bytes: number | null;
  created_at: string;
  status: string | null;
};

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

export type OrganizationProfileRow = {
  organization_name: string;
  organization_profile: string;
};

// export async function fetchOrganizationProfile(
//   userId: string
// ): Promise<OrganizationProfileRow | null> {
//   const { data, error } = await supabase
//     .from('organization_profiles')
//     .select('organization_name, organization_profile')
//     .eq('user_id', userId)
//     .maybeSingle();

//   if (error) throw error;
//   return data;
// }

/** Ensures a row exists (e.g. if signup predates the org-profile migration). */
export async function ensureOrganizationProfileRow(userId: string): Promise<void> {
  const { data: existing } = await supabase
    .from('organization_profiles')
    .select('id')
    .eq('user_id', userId)
    .maybeSingle();

  if (existing) return;

  const { error } = await supabase.from('organization_profiles').insert({
    user_id: userId,
    organization_name: 'My organization',
    organization_profile: '',
  });

  if (error && !/duplicate|unique/i.test(error.message)) throw error;
}

export async function saveOrganizationProfileText(userId: string, text: string): Promise<void> {
  const { error } = await supabase
    .from('organization_profiles')
    .update({ organization_profile: text })
    .eq('user_id', userId);

  if (error) throw error;
}
