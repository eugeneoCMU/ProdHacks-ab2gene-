import { useState } from 'react';
import { searchOpportunities, getOpportunityUrl, buildGrantContext, type GrantsGovOpportunity } from '../../api/grantsGov';
import GrantChat from '../chat/GrantChat';
import './EmptyState.css';
import './SearchView.css';

interface SearchViewProps {
  organizationProfile?: string;
}

interface MatchedOpportunity extends GrantsGovOpportunity {
  matchScore?: number;
  matchExplanation?: string;
  applicationTips?: string;
}

export default function SearchView({ organizationProfile = '' }: SearchViewProps) {
  const [query, setQuery] = useState('education');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opportunities, setOpportunities] = useState<MatchedOpportunity[]>([]);
  const [selectedOpportunity, setSelectedOpportunity] = useState<MatchedOpportunity | null>(null);
  const [matchingInProgress, setMatchingInProgress] = useState(false);

  const handleSearch = async () => {
    setLoading(true);
    setError(null);
    setOpportunities([]);
    try {
      // Step 1: Search for grants
      const result = await searchOpportunities({
        query: query.trim() || 'education',
        pagination: { page_offset: 1, page_size: 10 },
      });
      const grants = result.data ?? [];

      // Step 2: If we have organization profile, use smart matching
      if (organizationProfile && grants.length > 0) {
        setMatchingInProgress(true);
        try {
          const matchResponse = await fetch('/api/grants/smart-match', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              organizationProfile,
              grants,
              topN: grants.length, // Match all grants, we'll display scores
            }),
          });

          if (matchResponse.ok) {
            const { matches } = await matchResponse.json();
            setOpportunities(matches);
          } else {
            // Fallback: display grants without scores
            setOpportunities(grants);
          }
        } catch (matchErr) {
          console.error('Smart matching failed:', matchErr);
          // Fallback: display grants without scores
          setOpportunities(grants);
        } finally {
          setMatchingInProgress(false);
        }
      } else {
        // No profile or no grants: display as-is
        setOpportunities(grants);
      }
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
              profileContext={organizationProfile}
              onClose={() => setSelectedOpportunity(null)}
            />
          </div>
        </div>
      )}

      {opportunities.length > 0 && (
        <div className="search-results">
          <h3 className="search-results-title">
            Found {opportunities.length} opportunities
            {matchingInProgress && ' (analyzing matches...)'}
          </h3>
          <ul className="opportunity-list">
            {opportunities.map((opp, i) => {
              const url = getOpportunityUrl(opp);
              const hasMatchScore = typeof opp.matchScore === 'number';
              const score = opp.matchScore ?? 0;
              const matchColor = hasMatchScore
                ? score >= 80 ? '#22c55e'
                : score >= 60 ? '#eab308'
                : score >= 40 ? '#f97316'
                : '#ef4444'
                : '#64748b';

              const content = (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '8px' }}>
                    <strong className="opportunity-title">{opp.opportunity_title}</strong>
                    {hasMatchScore && (
                      <span
                        style={{
                          backgroundColor: matchColor,
                          color: 'white',
                          padding: '4px 12px',
                          borderRadius: '12px',
                          fontSize: '14px',
                          fontWeight: 600,
                          flexShrink: 0
                        }}
                      >
                        {score}% Match
                      </span>
                    )}
                  </div>
                  {opp.matchExplanation && (
                    <p style={{
                      margin: '8px 0',
                      fontSize: '14px',
                      color: '#64748b',
                      lineHeight: '1.5'
                    }}>
                      {opp.matchExplanation}
                    </p>
                  )}
                  {opp.applicationTips && (
                    <div style={{
                      margin: '12px 0',
                      padding: '12px',
                      backgroundColor: '#f0f9ff',
                      border: '1px solid #0ea5e9',
                      borderRadius: '8px'
                    }}>
                      <div style={{
                        fontSize: '13px',
                        fontWeight: 600,
                        color: '#0369a1',
                        marginBottom: '8px',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px'
                      }}>
                        💡 Application Tips
                      </div>
                      <div style={{
                        fontSize: '13px',
                        color: '#475569',
                        lineHeight: '1.6',
                        whiteSpace: 'pre-line'
                      }}>
                        {opp.applicationTips}
                      </div>
                    </div>
                  )}
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
