/**
 * Grant RAG chat API client (talks to our backend that uses Gemini).
 */

export interface ChatMessage {
  role: 'user' | 'model';
  content: string;
}

const SERVER_UNREACHABLE_MSG =
  'Chat service is not running. Run "npm run dev:server" in another terminal, or use "npm run dev:all" to run both the app and the server.';

export interface PostChatOptions {
  grantContext: string;
  profileContext?: string;
  messages: ChatMessage[];
  /** Supabase session access token — enables server-side embedding retrieval over document_chunks */
  accessToken?: string | null;
}

export async function postChat({
  grantContext,
  profileContext = '',
  messages,
  accessToken,
}: PostChatOptions): Promise<{ reply: string }> {
  let res: Response;
  try {
    const body: Record<string, unknown> = { grantContext, profileContext, messages };
    if (accessToken) {
      body.accessToken = accessToken;
    }
    res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error(SERVER_UNREACHABLE_MSG);
  }

  if (!res.ok) {
    if (res.status === 502 || res.status === 503 || res.status === 504) {
      throw new Error(SERVER_UNREACHABLE_MSG);
    }
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error || `Chat failed: ${res.status}`);
  }

  return res.json() as Promise<{ reply: string }>;
}
