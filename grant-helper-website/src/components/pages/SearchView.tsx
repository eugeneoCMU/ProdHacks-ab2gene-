import { useState } from 'react';
import { searchOpportunities, getOpportunityUrl, buildGrantContext, type GrantsGovOpportunity } from '../../api/grantsGov';
import GrantChat from '../chat/GrantChat';
import './EmptyState.css';
import './SearchView.css';


export default function SearchView() {
  const [query, setQuery] = useState('education');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opportunities, setOpportunities] = useState<GrantsGovOpportunity[]>([]);
  const [selectedOpportunity, setSelectedOpportunity] = useState<GrantsGovOpportunity | null>(null);

  const handleSearch = async () => {
    setLoading(true);
    setError(null);
    setOpportunities([]);
    try {
      const result = await searchOpportunities({
        query: query.trim() || 'education',
        pagination: { page_offset: 1, page_size: 10 },
      });
      setOpportunities(result.data ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="empty-state search-view">
      <div className="empty-state-icon">🔍</div>
      <h2 className="empty-state-title">Discover Grants Tailored to Your Mission</h2>
      <p className="empty-state-description">
        Search through thousands of grant opportunities matched to your organization's
        profile. Our AI helps you find grants with the highest likelihood of success.
      </p>

      <div className="search-bar">
        <input
          type="text"
          className="search-input"
          placeholder="e.g. education, health, research"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
          disabled={loading}
        />
        <button
          type="button"
          className="btn-primary"
          onClick={handleSearch}
          disabled={loading}
        >
          {loading ? 'Searching…' : 'Start Searching'}
        </button>
      </div>

      {error && (
        <div className="search-error" role="alert">
          {error}
        </div>
      )}

      {selectedOpportunity && (
        <div
          className="search-chat-overlay"
          role="dialog"
          aria-modal="true"
          onClick={(e) => e.target === e.currentTarget && setSelectedOpportunity(null)}
        >
          <div className="search-chat-wrap" onClick={(e) => e.stopPropagation()}>
            <GrantChat
              grantTitle={selectedOpportunity.opportunity_title}
              grantContext={buildGrantContext(selectedOpportunity)}
              onClose={() => setSelectedOpportunity(null)}
            />
          </div>
        </div>
      )}

      {opportunities.length > 0 && (
        <div className="search-results">
          <h3 className="search-results-title">Found {opportunities.length} opportunities</h3>
          <ul className="opportunity-list">
            {opportunities.map((opp, i) => {
              const url = getOpportunityUrl(opp);
              const content = (
                <>
                  <strong className="opportunity-title">{opp.opportunity_title}</strong>
                  <div className="opportunity-meta">
                    {opp.summary?.post_date && <span>Posted: {opp.summary.post_date}</span>}
                    <span>Closes: {opp.summary?.close_date ?? 'No deadline'}</span>
                  </div>
                  {url && <span className="opportunity-link-hint">View on Grants.gov →</span>}
                </>
              );
              return (
                <li key={opp.opportunity_id ?? `opp-${i}`} className="opportunity-card">
                  {url ? (
                    <a href={url} target="_blank" rel="noopener noreferrer" className="opportunity-link">
                      {content}
                    </a>
                  ) : (
                    content
                  )}
                  <button
                    type="button"
                    className="opportunity-ask-btn"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setSelectedOpportunity(opp);
                    }}
                  >
                    Ask about this grant
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div className="empty-state-actions">
        <button
          type="button"
          className="btn-secondary"
          onClick={handleSearch}
          disabled={loading}
        >
          View Recommended
        </button>
      </div>

      <div className="feature-grid">
        <div className="feature-card">
          <div className="feature-icon">🤖</div>
          <h3 className="feature-title">AI-Powered Matching</h3>
          <p className="feature-text">
            Smart algorithms match your profile to the most relevant grant opportunities.
          </p>
        </div>
        <div className="feature-card">
          <div className="feature-icon">⚡</div>
          <h3 className="feature-title">Real-Time Updates</h3>
          <p className="feature-text">
            Get notified about new grants and upcoming deadlines that match your criteria.
          </p>
        </div>
        <div className="feature-card">
          <div className="feature-icon">📊</div>
          <h3 className="feature-title">Success Insights</h3>
          <p className="feature-text">
            See success rates and competition levels for each grant opportunity.
          </p>
        </div>
      </div>
    </div>
  );
}
