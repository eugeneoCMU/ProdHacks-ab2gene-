import { useState, useRef, useEffect } from 'react';
import { postChat, type ChatMessage } from '../../api/chat';
import { useSupabaseAuth } from '../../hooks/useSupabaseAuth';
import './GrantChat.css';

interface GrantChatProps {
  grantTitle: string;
  grantContext: string;
  profileContext?: string;
  onClose: () => void;
}

export default function GrantChat({ grantTitle, grantContext, onClose }: GrantChatProps) {
  const { session } = useSupabaseAuth();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const sendingRef = useRef(false);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = async () => {
    const text = input.trim();
    if (!text || loading || sendingRef.current) return;

    sendingRef.current = true;
    setInput('');
    setError(null);
    const userMessage: ChatMessage = { role: 'user', content: text };
    setMessages((prev) => [...prev, userMessage]);
    setLoading(true);

    try {
      const nextHistory = [...messages, userMessage];
      const { reply } = await postChat({
        grantContext,
        messages: nextHistory,
        accessToken: session?.access_token,
      });
      setMessages((prev) => [...prev, { role: 'model', content: reply }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to get reply');
    } finally {
      sendingRef.current = false;
      setLoading(false);
      inputRef.current?.focus();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="grant-chat">
      <div className="grant-chat-header">
        <h3 className="grant-chat-title">Ask about this grant</h3>
        <p className="grant-chat-subtitle">{grantTitle}</p>
        <button type="button" className="grant-chat-close" onClick={onClose} aria-label="Close chat">
          ×
        </button>
      </div>

      <div className="grant-chat-messages">
        {messages.length === 0 && (
          <div className="grant-chat-welcome">
            Ask anything about eligibility, deadlines, award amounts, or how to apply. Answers are based on this grant’s details.
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`grant-chat-msg grant-chat-msg--${m.role}`}>
            <div className="grant-chat-msg-content">{m.content}</div>
          </div>
        ))}
        {loading && (
          <div className="grant-chat-msg grant-chat-msg--model">
            <div className="grant-chat-msg-content grant-chat-msg-loading">Thinking…</div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {error && (
        <div className="grant-chat-error" role="alert">
          {error}
        </div>
      )}

      <div className="grant-chat-input-row">
        <textarea
          ref={inputRef}
          className="grant-chat-input"
          placeholder="Ask a question about this grant…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={loading}
          rows={2}
        />
        <button
          type="button"
          className="grant-chat-send"
          onClick={handleSend}
          disabled={loading || !input.trim()}
        >
          Send
        </button>
      </div>
    </div>
  );
}
