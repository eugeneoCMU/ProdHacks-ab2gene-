/**
 * Extract text from uploaded documents (PDF, DOC, DOCX, TXT) for organization profile.
 */

export async function extractDocuments(files: File[]): Promise<{ text: string }> {
  const form = new FormData();
  for (const file of files) {
    form.append('files', file);
  }

  const res = await fetch('/api/extract-documents', {
    method: 'POST',
    body: form,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error || `Extract failed: ${res.status}`);
  }

  return res.json() as Promise<{ text: string }>;
}
