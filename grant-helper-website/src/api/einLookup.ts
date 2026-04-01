export async function lookupEIN(ein: string): Promise<{ orgName: string; text: string }> {
  const res = await fetch('/api/ein-lookup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ein }),
  });

  const data = await res.json() as { orgName?: string; text?: string; error?: string };

  if (!res.ok) {
    throw new Error(data.error ?? 'EIN lookup failed');
  }

  return { orgName: data.orgName ?? '', text: data.text ?? '' };
}
