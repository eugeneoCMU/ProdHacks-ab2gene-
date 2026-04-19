import { useEffect, useMemo, useRef, useState } from 'react';
import { searchOpportunities, getOpportunityUrl, buildGrantContext, type GrantsGovOpportunity } from '../../api/grantsGov';
import GrantChat from '../chat/GrantChat';
import './EmptyState.css';
import './SearchView.css';

const PROFILE_STORAGE_KEY = 'grantflow.organizationProfile';

interface SearchViewProps {
  organizationProfile?: string;
}

interface MatchedOpportunity extends GrantsGovOpportunity {
  matchScore?: number;
  matchExplanation?: string;
  applicationTips?: string;
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
  'samantha', 'pittsburgh', 'springfield', 'dissolution', 'applicable', 'goals',
  'educational', 'outreach', 'articles', 'incorporated', 'formation', 'certifies',
  'principal', 'community', 'hands', 'helping'
]);

const BROAD_FALLBACK_QUERIES = [
  'education youth',
  'mentorship tutoring',
  'family support',
  'community services',
  'after school',
];

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
  if (!normalized) return [];

  const phraseHints = [
    'community outreach', 'youth mentorship', 'public service', 'educational purposes',
    'mental health', 'food security', 'housing stability', 'arts education',
    'college access', 'workforce development', 'violence prevention', 'family support',
    'environmental justice'
  ];

  const phraseMatches = phraseHints.filter((phrase) => normalized.includes(phrase));
  const counts = new Map<string, number>();

  normalized.split(' ').forEach((word) => {
    if (word.length < 4 || STOP_WORDS.has(word) || /^\d+$/.test(word)) return;
    counts.set(word, (counts.get(word) || 0) + 1);
  });

  const rankedWords = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([word]) => word);

  return Array.from(new Set([...phraseMatches, ...rankedWords])).slice(0, 8);
}

function buildRecommendedQuery(profile: string): string {
  const keywords = extractProfileKeywords(profile)
    .filter((keyword) => {
      const normalized = normalizeText(keyword);
      if (!normalized) return false;
      return normalized.split(' ').filter(Boolean).some((word) => word.length >= 4 && !STOP_WORDS.has(word));
    })
    .slice(0, 3);
  return keywords.length ? keywords.join(' ') : 'tutoring mentorship family support';
}

function sanitizeSearchQuery(value: string): string {
  const normalized = normalizeText(value);
  if (!normalized) return '';
  const tokens = normalized.split(' ').filter((word) => word.length >= 4 && !STOP_WORDS.has(word));
  return Array.from(new Set(tokens)).slice(0, 5).join(' ');
}

function buildSearchCandidates(rawQuery: string, recommendedQuery: string): string[] {
  const preferred = sanitizeSearchQuery(rawQuery);
  const recommended = sanitizeSearchQuery(recommendedQuery);
  return Array.from(new Set([preferred, recommended, ...BROAD_FALLBACK_QUERIES].filter(Boolean)));
}


function formatDisplayDate(value?: string | null): string {
  if (!value) return 'No deadline listed';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatCurrency(value?: number): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value);
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
}

function stripHtml(value: string): string {
  return decodeHtmlEntities(value).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function truncateSummary(value?: string, maxLength = 240): string {
  const text = stripHtml(String(value || ''));
  if (!text) return 'No summary description available yet.';
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength).trimEnd()}...`;
}

function getAgencyName(opportunity: GrantsGovOpportunity): string {
  const raw = (opportunity as Record<string, unknown>).agency_name;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : 'Agency not listed';
}

function getApplicantTypePreview(opportunity: GrantsGovOpportunity): string[] {
  const raw = (opportunity as Record<string, unknown>).applicant_types;
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => String(item).replace(/_/g, ' ').trim()).filter(Boolean).slice(0, 2);
}

export default function SearchView({ organizationProfile: profileProp }: SearchViewProps = {}) {
  const organizationProfile = profileProp
    ?? (typeof window !== 'undefined' ? window.localStorage.getItem(PROFILE_STORAGE_KEY) : '')
    ?? '';
  const [query, setQuery] = useState('education');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opportunities, setOpportunities] = useState<MatchedOpportunity[]>([]);
  const [selectedOpportunity, setSelectedOpportunity] = useState<MatchedOpportunity | null>(null);
  const [matchingInProgress, setMatchingInProgress] = useState(false);
  const [lastSearchLabel, setLastSearchLabel] = useState('');
  const [lastAttemptedQuery, setLastAttemptedQuery] = useState('');
  const resultsRef = useRef<HTMLDivElement | null>(null);

  const profileKeywords = useMemo(() => extractProfileKeywords(organizationProfile), [organizationProfile]);
  const recommendedQuery = useMemo(() => buildRecommendedQuery(organizationProfile), [organizationProfile]);
  const hasProfile = organizationProfile.trim().length > 0;
  const grantApiConfigured = Boolean(import.meta.env.VITE_GRANT_API);

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

    const rawQuery = mode === 'recommended'
      ? recommendedQuery
      : (query.trim() || recommendedQuery);
    const candidates = buildSearchCandidates(rawQuery, recommendedQuery);
    const baseQuery = candidates[0] || 'education youth';

    setQuery(baseQuery);
    setLastAttemptedQuery(baseQuery);

    try {
      const searchQuery = query.trim() || 'education';
      setLastAttemptedQuery(searchQuery);

      // Fetch from Grants.gov and internal catalog in parallel
      const [grantsGovResult, catalogResult] = await Promise.allSettled([
        searchOpportunities({ query: searchQuery, pagination: { page_offset: 1, page_size: 10 } }),
        fetch(`/api/grants/catalog?q=${encodeURIComponent(searchQuery)}&limit=15`).then(r => r.json()),
      ]);

      const grantsGovGrants = grantsGovResult.status === 'fulfilled' ? (grantsGovResult.value.data ?? []) : [];
      const catalogGrants = catalogResult.status === 'fulfilled' ? (catalogResult.value.data ?? []) : [];

      // Merge: catalog first (curated), then Grants.gov live results
      const merged = [...catalogGrants, ...grantsGovGrants];
      setLastSearchLabel(searchQuery);

      if (merged.length === 0) {
        setOpportunities([]);
        return;
      }

      // Smart matching if profile is available
      if (organizationProfile) {
        setMatchingInProgress(true);
        try {
          const matchResponse = await fetch('/api/grants/smart-match', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ organizationProfile, grants: merged, topN: merged.length }),
          });
          if (matchResponse.ok) {
            const { matches } = await matchResponse.json();
            setOpportunities(matches);
          } else {
            setOpportunities(merged);
          }
        } catch (matchErr) {
          console.error('Smart matching failed:', matchErr);
          setOpportunities(merged);
        } finally {
          setMatchingInProgress(false);
        }
      } else {
        setOpportunities(merged);
      }
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
            {' '}({opportunities.filter(o => (o as Record<string, unknown>).source === 'catalog').length} catalog, {opportunities.filter(o => (o as Record<string, unknown>).source !== 'catalog').length} live)
            {matchingInProgress && ' — analyzing matches...'}
          </h3>
          <ul className="opportunity-list">
            {opportunities.map((opp, i) => {
              const url = getOpportunityUrl(opp);
              const isCatalog = (opp as Record<string, unknown>).source === 'catalog';
              const hasMatchScore = typeof opp.matchScore === 'number';
              const score = opp.matchScore ?? 0;
              const matchColor = hasMatchScore
                ? score >= 80 ? '#22c55e'
                : score >= 60 ? '#eab308'
                : score >= 40 ? '#f97316'
                : '#ef4444'
                : '#64748b';
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
                        {isCatalog && (
                          <span style={{ backgroundColor: '#7c3aed', color: 'white', padding: '2px 8px', borderRadius: '10px', fontSize: '11px', fontWeight: 600, marginLeft: '8px' }}>
                            CATALOG
                          </span>
                        )}
                      </div>
                    </div>
                    {hasMatchScore && (
                      <span style={{ backgroundColor: matchColor, color: 'white', padding: '4px 12px', borderRadius: '12px', fontSize: '13px', fontWeight: 600, flexShrink: 0 }}>
                        {score}% Match
                      </span>
                    )}
                  </div>
                  {opp.matchExplanation && (
                    <p style={{ margin: '6px 0', fontSize: '13px', color: '#64748b', lineHeight: '1.5' }}>
                      {opp.matchExplanation}
                    </p>
                  )}
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
                  {opp.applicationTips && (
                    <div style={{ margin: '12px 0', padding: '12px', backgroundColor: '#f0f9ff', border: '1px solid #0ea5e9', borderRadius: '8px' }}>
                      <div style={{ fontSize: '13px', fontWeight: 600, color: '#0369a1', marginBottom: '6px' }}>
                        💡 Application Tips
                      </div>
                      <div style={{ fontSize: '13px', color: '#475569', lineHeight: '1.6', whiteSpace: 'pre-line' }}>
                        {opp.applicationTips}
                      </div>
                    </div>
                  )}
                </>
              );
              const catalogUrl = isCatalog ? (opp as Record<string, unknown>).application_url as string | null : null;
              const linkUrl = catalogUrl ?? url;

              return (
                <li key={opp.opportunity_id ?? `opp-${i}`} className="opportunity-card">
                  {linkUrl ? (
                    <a href={linkUrl} target="_blank" rel="noopener noreferrer" className="opportunity-link">
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

      {!loading && !opportunities.length && !error && lastAttemptedQuery ? (
        <div className="search-config-card" role="status">
          No matches loaded for <strong>{lastAttemptedQuery}</strong> yet. Try simplifying the search to one or two themes.
        </div>
      ) : null}

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
