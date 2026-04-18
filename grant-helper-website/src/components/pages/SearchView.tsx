import { useEffect, useMemo, useRef, useState } from 'react';
import { searchOpportunities, getOpportunityUrl, buildGrantContext, isGrantApiConfigured, type GrantsGovOpportunity } from '../../api/grantsGov';
import GrantChat from '../chat/GrantChat';
import './EmptyState.css';
import './SearchView.css';

interface SearchViewProps {
  organizationProfile?: string;
}

const STOP_WORDS = new Set([
  'about', 'after', 'again', 'agency', 'all', 'also', 'among', 'and', 'application', 'article', 'articles',
  'because', 'been', 'before', 'being', 'board', 'business', 'charitable', 'community', 'corporation',
  'directors', 'document', 'education', 'entity', 'exclusively', 'executed', 'following', 'formed', 'forming',
  'foundation', 'grant', 'grants', 'have', 'including', 'incorporation', 'information', 'initiative', 'initiatives',
  'laws', 'name', 'nonprofit', 'office', 'organization', 'organizational', 'other', 'our', 'over', 'people',
  'program', 'programs', 'project', 'purpose', 'purposes', 'service', 'services', 'shall', 'that', 'their',
  'these', 'this', 'those', 'under', 'upon', 'were', 'which', 'with', 'within', 'youth',
  'address', 'street', 'avenue', 'road', 'drive', 'lane', 'court', 'boulevard', 'suite',
  'owner', 'founder', 'registered', 'agent', 'phone', 'email', 'contact', 'maple',
  'samantha', 'pittsburgh', 'springfield'
]);

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractProfileKeywords(profile: string): string[] {
  const scrubbed = profile
    .replace(/owner\s*\/\s*founder:\s*name:\s*[^\n.]*/gi, ' ')
    .replace(/founder:\s*name:\s*[^\n.]*/gi, ' ')
    .replace(/owner:\s*name:\s*[^\n.]*/gi, ' ')
    .replace(/registered agent:\s*name:\s*[^\n.]*/gi, ' ')
    .replace(/contact information:\s*[^]+?(?=(?:\d+\.|$))/gi, ' ')
    .replace(/email:\s*[^\s]+/gi, ' ')
    .replace(/phone:\s*[\d(). -]+/gi, ' ')
    .replace(/\b\d{5}(?:-\d{4})?\b/g, ' ')
    .replace(/\b\d+\b/g, ' ');
  const normalized = normalizeText(scrubbed);
  if (!normalized) {
    return [];
  }

  const phraseHints = [
    'community outreach',
    'youth mentorship',
    'public service',
    'educational purposes',
    'mental health',
    'food security',
    'housing stability',
    'arts education',
    'college access',
    'workforce development',
    'violence prevention',
    'family support',
    'environmental justice'
  ];

  const phraseMatches = phraseHints.filter((phrase) => normalized.includes(phrase));
  const counts = new Map<string, number>();

  normalized.split(' ').forEach((word) => {
    if (word.length < 4 || STOP_WORDS.has(word) || /^\d+$/.test(word)) {
      return;
    }
    counts.set(word, (counts.get(word) || 0) + 1);
  });

  const rankedWords = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([word]) => word);

  return Array.from(new Set([...phraseMatches, ...rankedWords])).slice(0, 8);
}

function buildRecommendedQuery(profile: string): string {
  const keywords = extractProfileKeywords(profile).slice(0, 4);
  return keywords.length ? keywords.join(' ') : 'nonprofit education community services';
}

function scoreOpportunityAgainstProfile(opportunity: GrantsGovOpportunity, profileKeywords: string[]): number {
  if (!profileKeywords.length) {
    return 0;
  }

  const blob = normalizeText([
    opportunity.opportunity_title,
    opportunity.opportunity_number,
    opportunity.summary?.summary_description,
    Array.isArray((opportunity as Record<string, unknown>).applicant_types)
      ? ((opportunity as Record<string, unknown>).applicant_types as string[]).join(' ')
      : ''
  ].filter(Boolean).join(' '));

  let score = 0;
  profileKeywords.forEach((keyword) => {
    const normalizedKeyword = normalizeText(keyword);
    if (!normalizedKeyword) {
      return;
    }

    if (blob.includes(normalizedKeyword)) {
      score += normalizedKeyword.includes(' ') ? 3 : 2;
    } else {
      const keywordParts = normalizedKeyword.split(' ');
      const partialMatches = keywordParts.filter((part) => blob.includes(part)).length;
      score += partialMatches * 0.75;
    }
  });

  return Number(score.toFixed(2));
}

function sortByProfileFit(opportunities: GrantsGovOpportunity[], profileKeywords: string[]): GrantsGovOpportunity[] {
  return [...opportunities].sort((a, b) => {
    const scoreA = scoreOpportunityAgainstProfile(a, profileKeywords);
    const scoreB = scoreOpportunityAgainstProfile(b, profileKeywords);
    if (scoreB !== scoreA) {
      return scoreB - scoreA;
    }
    return String(a.summary?.close_date || '').localeCompare(String(b.summary?.close_date || ''));
  });
}

function formatDisplayDate(value?: string | null): string {
  if (!value) {
    return 'No deadline listed';
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });
}

function formatCurrency(value?: number): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return '';
  }

  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0
  }).format(value);
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function stripHtml(value: string): string {
  return decodeHtmlEntities(value)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncateSummary(value?: string, maxLength = 240): string {
  const text = stripHtml(String(value || ''));
  if (!text) {
    return 'No summary description available yet.';
  }

  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength).trimEnd()}...`;
}

function getAgencyName(opportunity: GrantsGovOpportunity): string {
  const raw = (opportunity as Record<string, unknown>).agency_name;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : 'Agency not listed';
}

function getApplicantTypePreview(opportunity: GrantsGovOpportunity): string[] {
  const raw = (opportunity as Record<string, unknown>).applicant_types;
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .map((item) => String(item).replace(/_/g, ' ').trim())
    .filter(Boolean)
    .slice(0, 2);
}

export default function SearchView({ organizationProfile = '' }: SearchViewProps) {
  const [query, setQuery] = useState('education');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opportunities, setOpportunities] = useState<GrantsGovOpportunity[]>([]);
  const [selectedOpportunity, setSelectedOpportunity] = useState<GrantsGovOpportunity | null>(null);
  const [lastSearchLabel, setLastSearchLabel] = useState('');
  const resultsRef = useRef<HTMLDivElement | null>(null);

  const profileKeywords = useMemo(() => extractProfileKeywords(organizationProfile), [organizationProfile]);
  const recommendedQuery = useMemo(() => buildRecommendedQuery(organizationProfile), [organizationProfile]);
  const hasProfile = organizationProfile.trim().length > 0;
  const grantApiConfigured = isGrantApiConfigured();

  useEffect(() => {
    if (opportunities.length > 0) {
      resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [opportunities]);

  const runSearch = async (mode: 'manual' | 'recommended') => {
    setLoading(true);
    setError(null);
    setOpportunities([]);
    setSelectedOpportunity(null);

    if (!grantApiConfigured) {
      setError('Grant search is not configured yet. Add VITE_GRANT_API to grant-helper-website/.env, then restart the frontend.');
      setLoading(false);
      return;
    }

    const baseQuery = mode === 'recommended'
      ? recommendedQuery
      : (query.trim() || recommendedQuery);

    setQuery(baseQuery);

    try {
      const result = await searchOpportunities({
        query: baseQuery,
        pagination: { page_offset: 1, page_size: 12 },
      });

      const sorted = sortByProfileFit(result.data ?? [], profileKeywords);
      setOpportunities(sorted);
      setLastSearchLabel(baseQuery);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="empty-state search-view">
      <p className="search-kicker">Grant search</p>
      <h2 className="empty-state-title">Find grants that better match your organization</h2>
      <p className="empty-state-description">
        Search across opportunities using your uploaded organization profile as context.
        Results are re-ranked using the mission, activities, and themes found in your documents.
      </p>

      <div className="search-bar">
        <input
          type="text"
          className="search-input"
          placeholder="e.g. education, health, research"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && runSearch('manual')}
          disabled={loading || !grantApiConfigured}
        />
        <button
          type="button"
          className="btn-primary"
          onClick={() => runSearch('manual')}
          disabled={loading || !grantApiConfigured}
        >
          {loading ? 'Searching…' : 'Start Searching'}
        </button>
      </div>

      <div className="profile-insight-card">
        <h3 className="profile-insight-title">Profile-driven recommendations</h3>
        {hasProfile ? (
          <>
            <p className="profile-insight-copy">
              Recommended search based on uploaded documents: <strong>{recommendedQuery}</strong>
            </p>
            <div className="keyword-chip-row">
              {profileKeywords.slice(0, 6).map((keyword) => (
                <span key={keyword} className="keyword-chip">{keyword}</span>
              ))}
            </div>
          </>
        ) : (
          <p className="profile-insight-copy">
            Upload organization documents in Profile first to unlock tailored search terms and better matching.
          </p>
        )}
      </div>

      {!grantApiConfigured && (
        <div className="search-config-card" role="status">
          Add <code>VITE_GRANT_API=your_key</code> to <code>grant-helper-website/.env</code>, then restart the frontend to enable live grant search.
        </div>
      )}

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
        <div className="search-results" ref={resultsRef}>
          <h3 className="search-results-title">
            Found {opportunities.length} opportunities
            {lastSearchLabel ? ` for "${lastSearchLabel}"` : ''}
          </h3>
          <ul className="opportunity-list">
            {opportunities.map((opp, i) => {
              const url = getOpportunityUrl(opp);
              const fitScore = scoreOpportunityAgainstProfile(opp, profileKeywords);
              const agencyName = getAgencyName(opp);
              const applicantTypes = getApplicantTypePreview(opp);
              const awardFloor = formatCurrency(opp.summary?.award_floor);
              const awardCeiling = formatCurrency(opp.summary?.award_ceiling);
              const content = (
                <>
                  <div className="opportunity-card-top">
                    <div className="opportunity-heading">
                      <strong className="opportunity-title">{opp.opportunity_title}</strong>
                      <div className="opportunity-subtitle">
                        <span className="opportunity-agency">{agencyName}</span>
                      </div>
                    </div>
                    {fitScore > 0 && (
                      <span className="opportunity-fit-badge">Profile fit {fitScore.toFixed(1)}</span>
                    )}
                  </div>
                  <div className="opportunity-meta-grid">
                    <div className="opportunity-meta-card">
                      <span className="opportunity-meta-label">Deadline</span>
                      <span className="opportunity-meta-value">{formatDisplayDate(opp.summary?.close_date)}</span>
                    </div>
                    <div className="opportunity-meta-card">
                      <span className="opportunity-meta-label">Posted</span>
                      <span className="opportunity-meta-value">{formatDisplayDate(opp.summary?.post_date)}</span>
                    </div>
                    {(awardFloor || awardCeiling) && (
                      <div className="opportunity-meta-card">
                        <span className="opportunity-meta-label">Award range</span>
                        <span className="opportunity-meta-value">
                          {[awardFloor, awardCeiling].filter(Boolean).join(' - ') || 'Not listed'}
                        </span>
                      </div>
                    )}
                  </div>
                  {applicantTypes.length > 0 && (
                    <div className="opportunity-chip-row">
                      {applicantTypes.map((type) => (
                        <span key={`${opp.opportunity_id ?? i}-${type}`} className="opportunity-chip">{type}</span>
                      ))}
                    </div>
                  )}
                  <p className="opportunity-description">{truncateSummary(opp.summary?.summary_description)}</p>
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
                  {url && <span className="opportunity-link-hint">Open full listing</span>}
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
          onClick={() => runSearch('recommended')}
          disabled={loading || !grantApiConfigured}
        >
          View Recommended
        </button>
      </div>

      <div className="feature-grid search-feature-grid">
        <div className="feature-card">
          <div className="feature-index">01</div>
          <h3 className="feature-title">Profile-aware matching</h3>
          <p className="feature-text">
            Uploaded-document themes now influence search terms and result ranking.
          </p>
        </div>
        <div className="feature-card">
          <div className="feature-index">02</div>
          <h3 className="feature-title">Faster shortlisting</h3>
          <p className="feature-text">
            Prioritize grants that align more closely with your mission and activities.
          </p>
        </div>
        <div className="feature-card">
          <div className="feature-index">03</div>
          <h3 className="feature-title">Shared context</h3>
          <p className="feature-text">
            Use the same uploaded profile for search, grant Q&A, and extension autofill.
          </p>
        </div>
      </div>
    </div>
  );
}
