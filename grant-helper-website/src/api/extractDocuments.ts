/**
 * Extract text from uploaded documents (PDF, DOC, DOCX, TXT) for organization profile.
 * When `accessToken` and `documentIds` (same order as `files`) are set, the server
 * chunks text, embeds, and inserts rows into `document_chunks`.
 */

export type ExtractDocumentsOptions = {
  accessToken?: string;
  /** Supabase `documents.id` for each file, same length and order as `files` */
  documentIds?: string[];
};

export async function extractDocuments(
  files: File[],
  options?: ExtractDocumentsOptions
): Promise<void> {
  const form = new FormData();
  for (const file of files) {
    form.append('files', file);
  }

  const { accessToken, documentIds } = options ?? {};
  if (documentIds?.length) {
    if (documentIds.length !== files.length) {
      throw new Error('documentIds must match files in length and order');
    }
    form.append('documentIds', JSON.stringify(documentIds));
  }

  const headers: HeadersInit = {};
  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }

  const res = await fetch('/api/extract-documents', {
    method: 'POST',
    headers,
    body: form,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error || `Extract failed: ${res.status}`);
  }

}
