export async function lookupEIN(ein: string): Promise<{ orgName: string; text: string }> {
  const cleanEIN = ein.replace(/\D/g, '');

  const res = await fetch('/api/ein-lookup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ein: cleanEIN }),
  });

  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    throw new Error(`Server error (${res.status}). Make sure the backend is running.`);
  }

  const data = await res.json() as { orgName?: string; text?: string; error?: string };

  if (!res.ok) {
    throw new Error(data.error ?? 'EIN lookup failed');
  }

  return { orgName: data.orgName ?? '', text: data.text ?? '' };
}
