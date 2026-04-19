-- GrantFlow: Grant Catalog Table
-- Stores curated grant opportunities (seeded from grants-seed.json, supplementing live Grants.gov results)

CREATE TABLE grants (
    id TEXT PRIMARY KEY, -- kebab-case slug (e.g. "nih-research-project-grant-r01")
    opportunity_title TEXT NOT NULL,
    provider TEXT NOT NULL,
    category TEXT NOT NULL,
    funding_min BIGINT,
    funding_max BIGINT,
    geographic_scope TEXT NOT NULL CHECK (geographic_scope IN ('national', 'regional', 'state', 'local')),
    states_eligible TEXT[] NOT NULL DEFAULT '{}',
    eligibility_types TEXT[] NOT NULL DEFAULT '{}',
    focus_areas TEXT[] NOT NULL DEFAULT '{}',
    target_population TEXT,
    description TEXT,
    application_url TEXT,
    deadline_type TEXT CHECK (deadline_type IN ('rolling', 'annual', 'cycle', 'closed')),
    typical_deadline_month INTEGER CHECK (typical_deadline_month BETWEEN 1 AND 12),
    is_recurring BOOLEAN NOT NULL DEFAULT true,
    notes TEXT NOT NULL DEFAULT '',
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for common query patterns
CREATE INDEX idx_grants_category ON grants(category);
CREATE INDEX idx_grants_geographic_scope ON grants(geographic_scope);
CREATE INDEX idx_grants_states_eligible ON grants USING GIN(states_eligible);
CREATE INDEX idx_grants_eligibility_types ON grants USING GIN(eligibility_types);
CREATE INDEX idx_grants_focus_areas ON grants USING GIN(focus_areas);
CREATE INDEX idx_grants_is_active ON grants(is_active);
CREATE INDEX idx_grants_fts ON grants USING GIN(
    to_tsvector('english', coalesce(opportunity_title, '') || ' ' || coalesce(provider, '') || ' ' || coalesce(description, '') || ' ' || coalesce(target_population, ''))
);

-- Updated_at trigger
CREATE TRIGGER update_grants_updated_at
    BEFORE UPDATE ON grants
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Full-text search function for grants
CREATE OR REPLACE FUNCTION search_grants(
    p_query TEXT DEFAULT '',
    p_category TEXT DEFAULT NULL,
    p_state TEXT DEFAULT NULL,
    p_limit INTEGER DEFAULT 50
)
RETURNS TABLE (
    id TEXT,
    opportunity_title TEXT,
    provider TEXT,
    category TEXT,
    funding_min BIGINT,
    funding_max BIGINT,
    geographic_scope TEXT,
    states_eligible TEXT[],
    eligibility_types TEXT[],
    focus_areas TEXT[],
    target_population TEXT,
    description TEXT,
    application_url TEXT,
    deadline_type TEXT,
    typical_deadline_month INTEGER,
    is_recurring BOOLEAN,
    notes TEXT,
    relevance REAL
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        g.id,
        g.opportunity_title,
        g.provider,
        g.category,
        g.funding_min,
        g.funding_max,
        g.geographic_scope,
        g.states_eligible,
        g.eligibility_types,
        g.focus_areas,
        g.target_population,
        g.description,
        g.application_url,
        g.deadline_type,
        g.typical_deadline_month,
        g.is_recurring,
        g.notes,
        CASE
            WHEN p_query = '' THEN 1.0
            ELSE ts_rank(
                to_tsvector('english', coalesce(g.opportunity_title, '') || ' ' || coalesce(g.provider, '') || ' ' || coalesce(g.description, '') || ' ' || coalesce(g.target_population, '')),
                plainto_tsquery('english', p_query)
            )
        END AS relevance
    FROM grants g
    WHERE
        g.is_active = true
        AND (p_query = '' OR to_tsvector('english', coalesce(g.opportunity_title, '') || ' ' || coalesce(g.provider, '') || ' ' || coalesce(g.description, '') || ' ' || coalesce(g.target_population, '')) @@ plainto_tsquery('english', p_query))
        AND (p_category IS NULL OR g.category = p_category)
        AND (p_state IS NULL OR g.geographic_scope = 'national' OR p_state = ANY(g.states_eligible))
    ORDER BY relevance DESC
    LIMIT p_limit;
END;
$$ LANGUAGE plpgsql;
