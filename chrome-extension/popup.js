const statusNode = document.getElementById("status");
const statusCardNode = document.getElementById("status-card");
const resultsNode = document.getElementById("results");
const autofillButton = document.getElementById("autofill-button");
const openPlatformButton = document.getElementById("open-platform-button");
const connectPlatformButton = document.getElementById("connect-platform-button");
const profileSummaryNode = document.getElementById("profile-summary");

const PLATFORM_URL_STORAGE_KEY = "grantflow.extension.platformUrl";
const BACKEND_URL_STORAGE_KEY = "grantflow.extension.backendUrl";
const PLATFORM_PROFILE_STORAGE_KEY = "grantflow.extension.profileSummary";
const PLATFORM_PROFILE_TEXT_STORAGE_KEY = "grantflow.extension.profileText";
const PLATFORM_USER_ID_STORAGE_KEY = "grantflow.extension.userId";
const PLATFORM_ACCESS_TOKEN_STORAGE_KEY = "grantflow.extension.accessToken";
const PLATFORM_DOCUMENT_NAMES_STORAGE_KEY = "grantflow.extension.documentNames";
const STRUCTURED_PROFILE_STORAGE_KEY = "grantflow.extension.structuredProfile";
const PROFILE_STORAGE_KEY = "grantflow.organizationProfile";
const PROFILE_SUMMARY_STORAGE_KEY = "grantflow.profileSummary";
const USER_ID_STORAGE_KEY = "grantflow.userId";
const SAVED_DOCUMENTS_STORAGE_KEY = "grantflow.savedDocuments";
const DEFAULT_PLATFORM_URL = "http://localhost:5173";
const DEFAULT_BACKEND_URL = "http://localhost:3001";

let lastScanPayload = null;

initializePopup().catch(console.error);

function setStatus(message) {
  statusNode.textContent = message;
}

function setStatusState(state) {
  statusCardNode.classList.remove(
    "status-card--idle",
    "status-card--working",
    "status-card--success",
    "status-card--error"
  );
  statusCardNode.classList.add(`status-card--${state}`);
}

function updateFlowState(options = {}) {
  const hasConnectedProfile = Boolean(options.hasConnectedProfile);

  autofillButton.disabled = !hasConnectedProfile;
  connectPlatformButton.textContent = hasConnectedProfile ? "Sync Again" : "Connect & Sync";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function summarizeFields(fields) {
  return fields.reduce((acc, field) => {
    if (field.confidenceBucket === "high") {
      acc.high += 1;
    } else if (field.confidenceBucket === "review") {
      acc.review += 1;
    } else {
      acc.low += 1;
    }
    return acc;
  }, { high: 0, review: 0, low: 0 });
}

function getFieldGroup(fieldKey) {
  const groupMap = {
    organization_name: "Organization",
    organization_description: "Organization",
    organization_history: "Organization",
    organizational_capacity: "Organization",
    year_founded: "Organization",
    website: "Organization",
    type_of_applicant: "Organization",
    department: "Organization",
    division: "Organization",
    executive_officer_name: "Organization",
    executive_officer_email: "Organization",
    executive_officer_phone: "Organization",
    board_governance: "Organization",

    contact_name: "Contact",
    contact_prefix: "Contact",
    first_name: "Contact",
    middle_initial: "Contact",
    last_name: "Contact",
    contact_suffix: "Contact",
    email: "Contact",
    phone: "Contact",
    mobile_phone: "Contact",
    fax: "Contact",
    job_title: "Contact",
    principal_investigator_name: "Contact",
    principal_investigator_email: "Contact",
    principal_investigator_phone: "Contact",
    authorized_representative_name: "Contact",
    authorized_representative_email: "Contact",
    authorized_representative_phone: "Contact",

    mission_statement: "Narrative",
    need_statement: "Narrative",
    target_population: "Narrative",
    geographic_area_served: "Narrative",
    program_description: "Narrative",
    impact_statement: "Narrative",
    outcomes: "Narrative",
    evaluation_plan: "Narrative",
    sustainability_plan: "Narrative",
    implementation_timeline: "Narrative",
    methods_approach: "Narrative",
    staffing_plan: "Narrative",
    partnerships: "Narrative",
    dei_statement: "Narrative",
    financial_need: "Narrative",
    success_metrics: "Narrative",

    project_title: "Project",
    project_summary: "Project",
    project_abstract: "Project",
    project_goals: "Project",
    start_date: "Project",
    end_date: "Project",
    performance_site_name: "Project",
    performance_site_address_1: "Project",
    performance_site_city: "Project",
    performance_site_state: "Project",
    performance_site_zip: "Project",
    performance_site_country: "Project",
    request_type: "Project",

    funding_amount: "Budget",
    federal_request_amount: "Budget",
    non_federal_match_amount: "Budget",
    total_project_cost: "Budget",
    personnel_costs: "Budget",
    fringe_benefits: "Budget",
    travel_costs: "Budget",
    equipment_costs: "Budget",
    supplies_costs: "Budget",
    contractual_costs: "Budget",
    consultant_costs: "Budget",
    other_direct_costs: "Budget",
    indirect_costs: "Budget",

    address_line_1: "Address",
    address_line_2: "Address",
    city: "Address",
    state: "Address",
    zip: "Address",
    country: "Address",
    county: "Address",
    congressional_district_applicant: "Address",
    congressional_district_project: "Address",

    uei: "Compliance",
    duns: "Compliance",
    ein: "Compliance",
    assistance_listing_number: "Compliance",
    assistance_listing_title: "Compliance",
    funding_opportunity_number: "Compliance",
    agency_routing_identifier: "Compliance",
    federal_identifier: "Compliance",
    era_commons_id: "Compliance",

    username: "Account",
    password: "Account",
    confirm_password: "Account",
    birth_month: "Account",
    birth_day: "Account"
  };

  if (fieldKey === "unknown") {
    return "Unknown";
  }

  return groupMap[fieldKey] || "Other";
}

function groupFields(fields) {
  const orderedGroups = [
    "Organization",
    "Contact",
    "Narrative",
    "Project",
    "Budget",
    "Address",
    "Compliance",
    "Account",
    "Other",
    "Unknown"
  ];

  const groups = new Map(orderedGroups.map((group) => [group, []]));
  fields.forEach((field) => {
    const groupName = getFieldGroup(field.fieldKey);
    groups.get(groupName).push(field);
  });

  return Array.from(groups.entries()).filter(([, items]) => items.length > 0);
}

function renderFieldCard(field) {
  const title = field.fieldKey === "unknown" ? "Unknown field" : field.fieldKey.replace(/_/g, " ");
  const label = field.label || field.placeholder || field.name || field.id || "Unlabeled field";
  const reasons = (field.reasons || []).join(", ");
  const bucketLabel = field.confidenceBucket === "high"
    ? "High confidence"
    : field.confidenceBucket === "review"
      ? "Needs review"
      : "Unknown";

  return `
    <section class="field-card field-card--${escapeHtml(field.confidenceBucket)}">
      <h3>${escapeHtml(title)}</h3>
      <p class="field-meta"><strong>Label:</strong> ${escapeHtml(label)}</p>
      <p class="field-meta">Type: ${escapeHtml(field.tagName)} · ${escapeHtml(field.type)}</p>
      <p class="field-meta">Name/ID: ${escapeHtml(field.name || "(no name)")} · ${escapeHtml(field.id || "(no id)")}</p>
      <p class="field-meta">Required: ${field.required ? "Yes" : "No"}</p>
      <span class="confidence">${escapeHtml(bucketLabel)} · ${Math.round(field.confidence * 100)}%</span>
      <p class="field-meta"><strong>Signals:</strong> ${escapeHtml(reasons || "No keyword match, fallback heuristic only")}</p>
    </section>
  `;
}

function renderGroup(groupName, fields) {
  return `
    <section class="group-card">
      <div class="group-header">
        <h2 class="group-title">${escapeHtml(groupName)}</h2>
        <span class="group-count">${fields.length}</span>
      </div>
      <div class="group-fields">
        ${fields.map((field) => renderFieldCard(field)).join("")}
      </div>
    </section>
  `;
}

function renderFields(payload) {
  lastScanPayload = payload;
  resultsNode.innerHTML = "";
}

function renderProfileSummary(documentNames = []) {
  if (!documentNames.length) {
    profileSummaryNode.innerHTML = `<p class="field-meta">No synced documents yet. Upload files in GrantFlow, then click sync.</p>`;
    return;
  }

  profileSummaryNode.innerHTML = `
    <h3 class="profile-summary-title">Saved Documents</h3>
    <ul class="document-list">
      ${documentNames.map((name) => `<li class="document-item">${escapeHtml(name)}</li>`).join("")}
    </ul>
  `;
}

async function initializePopup() {
  const saved = await chrome.storage.local.get([
    PLATFORM_PROFILE_TEXT_STORAGE_KEY,
    PLATFORM_USER_ID_STORAGE_KEY,
    PLATFORM_ACCESS_TOKEN_STORAGE_KEY,
    PLATFORM_DOCUMENT_NAMES_STORAGE_KEY
  ]);
  renderProfileSummary(saved[PLATFORM_DOCUMENT_NAMES_STORAGE_KEY] || []);
  const hasConnectedProfile = Boolean(
    saved[PLATFORM_PROFILE_TEXT_STORAGE_KEY] ||
    saved[PLATFORM_USER_ID_STORAGE_KEY] ||
    saved[PLATFORM_ACCESS_TOKEN_STORAGE_KEY]
  );
  setStatusState(hasConnectedProfile ? "success" : "idle");
  updateFlowState({ hasConnectedProfile });
}

async function getPlatformTab(platformUrl) {
  const [exactTab] = await chrome.tabs.query({ url: `${platformUrl}/*` });
  if (exactTab?.id) {
    return exactTab;
  }

  const tabs = await chrome.tabs.query({});
  return tabs.find((tab) => tab.url && tab.url.startsWith(platformUrl)) || null;
}

function normalizeWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function capturePattern(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return normalizeWhitespace(match[1].replace(/^["']|["']$/g, ""));
    }
  }
  return "";
}

function splitContactName(fullName) {
  const parts = normalizeWhitespace(fullName).split(" ").filter(Boolean);
  if (parts.length < 2) {
    return { first: "", last: "" };
  }
  return {
    first: parts[0],
    last: parts.slice(1).join(" ")
  };
}

function toTitleCaseName(value) {
  return String(value || "")
    .split(/[\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function inferNameFromEmail(email) {
  const trimmed = normalizeWhitespace(email);
  if (!isLikelyEmail(trimmed)) {
    return { first: "", last: "", full: "" };
  }

  const localPart = trimmed.split("@")[0];
  const parts = localPart
    .split(/[._-]+/)
    .map((part) => part.replace(/[^a-z]/gi, ""))
    .filter((part) => part.length >= 2);

  if (parts.length < 2) {
    return { first: "", last: "", full: "" };
  }

  const first = toTitleCaseName(parts[0]);
  const last = toTitleCaseName(parts.slice(1).join(" "));
  return {
    first,
    last,
    full: `${first} ${last}`.trim()
  };
}

function parseAddressParts(address) {
  const parsed = {};
  const clean = normalizeWhitespace(String(address || "").replace(/\baddress:\b/i, ""));
  if (!clean) {
    return parsed;
  }

  const cityStateZipMatch = clean.match(/^(.*?)(?:,\s*|\s+)([A-Za-z .'-]+),\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)(?:\s+(United States|USA|US))?$/i);
  if (cityStateZipMatch) {
    parsed.address_line_1 = normalizeWhitespace(cityStateZipMatch[1]);
    parsed.city = normalizeWhitespace(cityStateZipMatch[2]);
    parsed.state = normalizeWhitespace(cityStateZipMatch[3]);
    parsed.zip = normalizeWhitespace(cityStateZipMatch[4]);
    parsed.country = normalizeWhitespace(cityStateZipMatch[5] || "United States");
    return parsed;
  }

  const zipMatch = clean.match(/\b\d{5}(?:-\d{4})?\b/);
  const stateMatch = clean.match(/\b([A-Z]{2})\s+\d{5}(?:-\d{4})?\b/);
  const countryMatch = clean.match(/\b(United States|USA|US)\b/i);
  const streetLeadMatch = clean.match(/^(\d+\s+[A-Za-z0-9.'# -]+?(?:street|st|avenue|ave|road|rd|boulevard|blvd|drive|dr|lane|ln|way|court|ct|place|pl|terrace|ter|circle|cir)\b)/i);
  const cityMatch = clean.match(/(?:^|,\s*)([A-Za-z .'-]+),\s*[A-Z]{2}\s+\d{5}(?:-\d{4})?/);

  if (streetLeadMatch) parsed.address_line_1 = normalizeWhitespace(streetLeadMatch[1]);
  if (cityMatch) parsed.city = normalizeWhitespace(cityMatch[1]);
  if (stateMatch) parsed.state = stateMatch[1];
  if (zipMatch) parsed.zip = zipMatch[0];
  if (countryMatch) parsed.country = countryMatch[1].toLowerCase() === "us" ? "United States" : normalizeWhitespace(countryMatch[1]);

  return parsed;
}

function enrichStructuredProfileWithInferences(structuredProfile) {
  if (!structuredProfile) {
    return null;
  }

  const next = { ...structuredProfile };

  const primaryAddressBlob = [
    next.address_line_1,
    next.address_line_2,
    next.city,
    next.state,
    next.zip,
    next.country
  ].filter(Boolean).join(", ");

  const reparsed = parseAddressParts(next.address_line_1 || primaryAddressBlob);
  if (!next.address_line_1 && reparsed.address_line_1) {
    next.address_line_1 = reparsed.address_line_1;
  }
  if (!next.address_line_2 && reparsed.address_line_2) {
    next.address_line_2 = reparsed.address_line_2;
  }
  if (!next.city && reparsed.city) {
    next.city = reparsed.city;
  }
  if (!next.state && reparsed.state) {
    next.state = reparsed.state;
  }
  if (!next.zip && reparsed.zip) {
    next.zip = reparsed.zip;
  }
  if (!next.country && reparsed.country) {
    next.country = reparsed.country;
  }

  if (!next.country && next.state && next.zip) {
    next.country = "United States";
  }

  if ((!next.contact_name || !String(next.contact_name).trim()) && next.first_name && next.last_name) {
    next.contact_name = `${String(next.first_name).trim()} ${String(next.last_name).trim()}`.trim();
  }

  if ((!next.first_name || !next.last_name) && next.contact_name) {
    const split = splitContactName(String(next.contact_name));
    if (!next.first_name && split.first) {
      next.first_name = split.first;
    }
    if (!next.last_name && split.last) {
      next.last_name = split.last;
    }
  }

  if ((!next.first_name || !next.last_name || !next.contact_name) && next.email) {
    const inferredName = inferNameFromEmail(String(next.email));
    if (!next.first_name && inferredName.first) {
      next.first_name = inferredName.first;
    }
    if (!next.last_name && inferredName.last) {
      next.last_name = inferredName.last;
    }
    if (!next.contact_name && inferredName.full) {
      next.contact_name = inferredName.full;
    }
  }

  return next;
}

function buildLocalStructuredProfile(profileText) {
  const text = normalizeWhitespace(profileText);
  if (!text) {
    return null;
  }

  const profile = {};
  const emailMatch = text.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i);
  const phoneMatch = text.match(/(?:\+?1[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}/);
  const websiteMatch = text.match(/\b(?:https?:\/\/)?(?:www\.)?[a-z0-9.-]+\.[a-z]{2,}(?:\/[^\s]*)?\b/i);
  const einMatch = text.match(/\b\d{2}-\d{7}\b/);

  profile.organization_name = capturePattern(text, [
    /organization name[:\s]+["']?([^".]+)["']?/i,
    /legal name[:\s]+["']?([^".]+)["']?/i,
    /name of the nonprofit organization is ["']?([^".]+)["']?/i
  ]);

  const contactName = capturePattern(text, [
    /contact person[:\s]+([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z.'-]+)+)/i,
    /owner\s*\/\s*founder:\s*name:\s*([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z.'-]+)+)/i,
    /executive director[:\s]+([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z.'-]+)+)/i
  ]);

  if (contactName) {
    profile.contact_name = contactName;
    const split = splitContactName(contactName);
    profile.first_name = split.first;
    profile.last_name = split.last;
  }

  profile.job_title = capturePattern(text, [
    /title\s*\/\s*position[:\s]+([A-Za-z][A-Za-z\s/&-]{2,80})(?:\s{2,}|email:|phone:|$)/i,
    /job title[:\s]+([A-Za-z][A-Za-z\s/&-]{2,80})(?:\s{2,}|email:|phone:|$)/i,
    /position[:\s]+([A-Za-z][A-Za-z\s/&-]{2,80})(?:\s{2,}|email:|phone:|$)/i,
    /role[:\s]+([A-Za-z][A-Za-z\s/&-]{2,80})(?:\s{2,}|email:|phone:|$)/i
  ]);

  if (emailMatch) profile.email = emailMatch[0];
  if (phoneMatch) {
    profile.phone = normalizeWhitespace(phoneMatch[0]);
    profile.mobile_phone = normalizeWhitespace(phoneMatch[0]);
  }
  if (websiteMatch && !websiteMatch[0].includes("@")) {
    profile.website = websiteMatch[0].startsWith("http") ? websiteMatch[0] : `https://${websiteMatch[0]}`;
  }
  if (einMatch) profile.ein = einMatch[0];

  const addressBlob = capturePattern(text, [
    /principal office address:\s*([^]+?)\s*(?:registered agent:|contact information:|board of directors:|owner|founder|$)/i,
    /mailing address:\s*([^]+?)\s*(?:registered agent:|contact information:|board of directors:|owner|founder|$)/i,
    /address:\s*([^]+?)\s*(?:phone:|email:|registered agent:|owner|founder|$)/i
  ]);
  if (addressBlob) {
    Object.assign(profile, parseAddressParts(addressBlob));
  }

  profile.mission_statement = capturePattern(text, [
    /mission statement[:\s]+(.*?)(?:project title:|organization website:|annual operating budget:|$)/i,
    /purpose:\s*(.*?)(?:principal office address:|registered agent:|contact information:|$)/i,
    /mission[:\s]+(.*?)(?:programs?:|services?:|$)/i
  ]);
  if (profile.mission_statement && !profile.organization_description) {
    profile.organization_description = profile.mission_statement;
  }

  return profile;
}

async function syncStructuredProfile(backendUrl, profileText, userId) {
  const accessToken = arguments[3] || "";
  if (!backendUrl || (!profileText && !userId && !accessToken)) {
    return { structuredProfile: null, documentContextUsed: false };
  }

  const response = await fetch(`${backendUrl}/api/profile-structure`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      organizationProfile: profileText,
      userId: userId || "",
      accessToken
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `Profile sync failed: ${response.status}`);
  }

  return {
    structuredProfile: data.profile || null,
    documentContextUsed: Boolean(data.documentContextUsed)
  };
}

async function connectToPlatform() {
  const platformUrl = DEFAULT_PLATFORM_URL;
  const backendUrl = DEFAULT_BACKEND_URL;
  const existing = await chrome.storage.local.get([
    PLATFORM_DOCUMENT_NAMES_STORAGE_KEY,
    PLATFORM_PROFILE_TEXT_STORAGE_KEY,
    PLATFORM_PROFILE_STORAGE_KEY,
    STRUCTURED_PROFILE_STORAGE_KEY
  ]);

  await chrome.storage.local.set({
    [PLATFORM_URL_STORAGE_KEY]: platformUrl,
    [BACKEND_URL_STORAGE_KEY]: backendUrl
  });

  const tab = await getPlatformTab(platformUrl);
  if (!tab?.id) {
    setStatusState("error");
    setStatus("Platform tab not found. Open the platform first, then connect.");
    updateFlowState({ hasConnectedProfile: false });
    return;
  }

  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (profileKey, summaryKey, userIdKey, docsKey) => {
      try {
        const profile = window.localStorage.getItem(profileKey) || "";
        const rawSummary = window.localStorage.getItem(summaryKey);
        const summary = rawSummary ? JSON.parse(rawSummary) : null;
        const explicitUserId = window.localStorage.getItem(userIdKey) || "";
        const rawDocs = window.localStorage.getItem(docsKey);
        let documentNames = [];
        if (rawDocs) {
          try {
            const parsedDocs = JSON.parse(rawDocs);
            if (Array.isArray(parsedDocs)) {
              documentNames = parsedDocs
                .map((item) => typeof item === "string" ? item : item?.filename)
                .filter(Boolean);
            }
          } catch {
            documentNames = [];
          }
        }
        if (!documentNames.length) {
          documentNames = Array.from(
            document.querySelectorAll(".saved-document-name, .file-name")
          ).map((node) => node.textContent?.trim() || "").filter(Boolean);
        }
        const authKey = Object.keys(window.localStorage).find((key) => key.includes("-auth-token"));
        let userId = explicitUserId;
        let accessToken = "";
        if (authKey) {
          try {
            const rawSession = window.localStorage.getItem(authKey);
            const parsedSession = rawSession ? JSON.parse(rawSession) : null;
            userId = explicitUserId || parsedSession?.user?.id || parsedSession?.currentSession?.user?.id || "";
            accessToken = parsedSession?.access_token || parsedSession?.currentSession?.access_token || parsedSession?.session?.access_token || "";
          } catch {
            userId = explicitUserId;
          }
        }
        return { profile, summary, userId, accessToken, documentNames };
      } catch (error) {
        return {
          profile: "",
          summary: null,
          userId: "",
          accessToken: "",
          documentNames: [],
          error: error instanceof Error ? error.message : "Could not read platform state."
        };
      }
    },
    args: [PROFILE_STORAGE_KEY, PROFILE_SUMMARY_STORAGE_KEY, USER_ID_STORAGE_KEY, SAVED_DOCUMENTS_STORAGE_KEY]
  });

  if (!result || result.error) {
    setStatusState("error");
    setStatus(result?.error || "Could not read the platform profile.");
    updateFlowState({ hasConnectedProfile: false });
    return;
  }

  const hasSignedInContext = Boolean(result.userId || result.accessToken);
  if (!result.profile && !hasSignedInContext) {
    setStatusState("error");
    setStatus("No uploaded-document profile or signed-in document context was found yet. Upload documents in the platform first.");
    renderProfileSummary([]);
    updateFlowState({ hasConnectedProfile: false });
    return;
  }

  const documentNames = result.documentNames?.length
    ? [...new Set(result.documentNames)]
    : (existing[PLATFORM_DOCUMENT_NAMES_STORAGE_KEY] || []);

  const profileText = result.profile || existing[PLATFORM_PROFILE_TEXT_STORAGE_KEY] || "";

  let structuredProfile = null;

  if (backendUrl) {
    try {
      const syncResult = await syncStructuredProfile(backendUrl, profileText, result.userId || "", result.accessToken || "");
      structuredProfile = syncResult.structuredProfile;
    } catch (error) {
      console.warn("Structured profile sync failed", error);
    }
  }

  if (!structuredProfile && profileText) {
    structuredProfile = buildLocalStructuredProfile(profileText);
  }

  await chrome.storage.local.set({
    [PLATFORM_PROFILE_STORAGE_KEY]: result.summary || existing[PLATFORM_PROFILE_STORAGE_KEY] || null,
    [PLATFORM_PROFILE_TEXT_STORAGE_KEY]: profileText,
    [PLATFORM_USER_ID_STORAGE_KEY]: result.userId || "",
    [PLATFORM_ACCESS_TOKEN_STORAGE_KEY]: result.accessToken || "",
    [PLATFORM_DOCUMENT_NAMES_STORAGE_KEY]: documentNames,
    [STRUCTURED_PROFILE_STORAGE_KEY]: structuredProfile
  });

  renderProfileSummary(documentNames);
  updateFlowState({ hasConnectedProfile: true });
  setStatusState(structuredProfile ? "success" : "idle");
  setStatus(structuredProfile
    ? "Connected and synced organization data successfully."
    : "Connected to the platform account. Backend sync can be retried later."
  );
}

async function prepareCurrentPage(tabId) {
  return await chrome.tabs.sendMessage(tabId, { type: "GRANT_HELPER_PREPARE_AUTOFILL" }).catch(() => null);
}

function chooseAutofillTargets(fields) {
  const blocked = new Set([
    "password",
    "confirm_password",
    "username",
    "birth_month",
    "birth_day",
    "unknown"
  ]);

  return fields.filter((field) => {
    if (blocked.has(field.fieldKey)) {
      return false;
    }
    if (resolveFieldKeyForFill(field) === "unknown") {
      return false;
    }
    if (field.type === "checkbox" || field.type === "radio" || field.type === "password") {
      return false;
    }
    return field.confidenceBucket === "high";
  }).sort((a, b) => {
    if (a.required !== b.required) {
      return a.required ? -1 : 1;
    }
    return b.confidence - a.confidence;
  });
}

const SYNTHETIC_AI_FIELD_KEYS = new Set([
  "project_title",
  "project_summary",
  "project_abstract",
  "project_goals",
  "need_statement",
  "target_population",
  "geographic_area_served",
  "mission_statement",
  "organization_description",
  "organization_history",
  "program_description",
  "impact_statement",
  "outcomes",
  "evaluation_plan",
  "sustainability_plan",
  "implementation_timeline",
  "methods_approach",
  "staffing_plan",
  "partnerships",
  "dei_statement",
  "financial_need",
  "organizational_capacity",
  "board_governance",
  "success_metrics"
]);

function buildFieldTextBlob(field) {
  return normalizeFillText([
    field.label,
    field.placeholder,
    field.name,
    field.id,
    field.descriptor
  ].filter(Boolean).join(" "));
}

function isRepeatedConfirmationField(field, resolvedFieldKey) {
  const text = buildFieldTextBlob(field);
  if (!text) {
    return false;
  }
  const repeatedKey = new Set(["email", "phone", "mobile_phone", "contact_name", "first_name", "last_name"]);
  return repeatedKey.has(resolvedFieldKey) && (
    hasPhrase(text, "confirm") ||
    hasPhrase(text, "re enter") ||
    hasPhrase(text, "reenter") ||
    hasPhrase(text, "repeat") ||
    hasPhrase(text, "again") ||
    hasPhrase(text, "verify")
  );
}

function getStructuredValue(structuredProfile, fieldKey, field = {}) {
  if (!structuredProfile) {
    return "";
  }

  const labelBlob = buildFieldTextBlob(field);
  const contactName = String(structuredProfile.contact_name || "").trim();
  const contactParts = contactName.split(/\s+/).filter(Boolean);
  const direct = structuredProfile[fieldKey];
  if (String(direct || "").trim()) {
    return String(direct).trim();
  }

  if (fieldKey === "address_line_1" && String(structuredProfile.address_line_1 || "").trim()) {
    return String(structuredProfile.address_line_1).trim();
  }

  if (fieldKey === "address_line_2" && String(structuredProfile.address_line_2 || "").trim()) {
    return String(structuredProfile.address_line_2).trim();
  }

  if (fieldKey === "city" && String(structuredProfile.city || "").trim()) {
    return String(structuredProfile.city).trim();
  }

  if (fieldKey === "state" && String(structuredProfile.state || "").trim()) {
    return String(structuredProfile.state).trim();
  }

  if (fieldKey === "zip" && String(structuredProfile.zip || "").trim()) {
    return String(structuredProfile.zip).trim();
  }

  if (fieldKey === "country" && String(structuredProfile.country || "").trim()) {
    return String(structuredProfile.country).trim();
  }

  if (fieldKey === "address_line_1" && (
    labelBlob.includes("mailing address") ||
    labelBlob.includes("organizational address") ||
    labelBlob.includes("primary address")
  )) {
    return String(structuredProfile.address_line_1 || "").trim();
  }

  if (fieldKey === "mobile_phone" && structuredProfile.phone) {
    return "";
  }

  if (fieldKey === "first_name" && contactParts.length >= 2) {
    return contactParts[0];
  }

  if (fieldKey === "last_name" && contactParts.length >= 2) {
    return contactParts.slice(1).join(" ");
  }

  if (fieldKey === "contact_name") {
    const first = String(structuredProfile.first_name || "").trim();
    const last = String(structuredProfile.last_name || "").trim();
    const full = first && last ? `${first} ${last}` : "";
    if (full) {
      return full;
    }
  }

  if (fieldKey === "phone" && labelBlob.includes("primary") && String(structuredProfile.phone || "").trim()) {
    return String(structuredProfile.phone).trim();
  }

  if (fieldKey === "email" && (
    hasPhrase(labelBlob, "confirm email") ||
    hasPhrase(labelBlob, "re enter email") ||
    hasPhrase(labelBlob, "reenter email")
  )) {
    return String(structuredProfile.email || "").trim();
  }

  if (fieldKey === "organization_description" && structuredProfile.mission_statement) {
    return String(structuredProfile.mission_statement).trim();
  }

  return "";
}

function sanitizeStructuredProfile(structuredProfile) {
  if (!structuredProfile) {
    return null;
  }

  const next = enrichStructuredProfileWithInferences(structuredProfile) || { ...structuredProfile };
  const trimValue = (key) => String(next[key] || "").trim();
  const clearIfUnsafe = (key, predicate) => {
    const value = trimValue(key);
    if (!value) {
      next[key] = "";
      return;
    }
    next[key] = predicate(value) ? value : "";
  };

  clearIfUnsafe("email", isLikelyEmail);
  clearIfUnsafe("phone", isLikelyPhone);
  clearIfUnsafe("mobile_phone", isLikelyPhone);
  clearIfUnsafe("zip", isLikelyZip);
  clearIfUnsafe("city", isLikelyCityValue);
  clearIfUnsafe("state", isLikelyStateValue);
  clearIfUnsafe("country", isLikelyCountryValue);
  clearIfUnsafe("address_line_1", isLikelyAddressValue);
  clearIfUnsafe("first_name", isLikelyNameValue);
  clearIfUnsafe("last_name", isLikelyNameValue);
  clearIfUnsafe("contact_name", isLikelyNameValue);

  const first = trimValue("first_name");
  const last = trimValue("last_name");
  if (first && last && normalizeFillText(first) === normalizeFillText(last)) {
    next.last_name = "";
  }

  const contactName = trimValue("contact_name");
  if (contactName && (!first || !last)) {
    const parts = contactName.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      if (!first && isLikelyNameValue(parts[0])) {
        next.first_name = parts[0];
      }
      const inferredLast = parts.slice(1).join(" ");
      if (!last && isLikelyNameValue(inferredLast)) {
        next.last_name = inferredLast;
      }
    }
  }

  return next;
}

function buildStructuredFills(fields, structuredProfile) {
  const safeStructuredProfile = sanitizeStructuredProfile(structuredProfile);
  const resolvedFields = fields.map((field) => ({
    ...field,
    resolvedFieldKey: resolveFieldKeyForFill(field)
  }));
  const fills = [];
  const chosenValuesByKey = new Map();
  const hasRequiredPrimaryPhone = resolvedFields.some((field) => field.resolvedFieldKey === "phone" && field.required);
  const phoneValue = String(safeStructuredProfile?.phone || "").trim();
  const mobileValue = String(safeStructuredProfile?.mobile_phone || "").trim();

  resolvedFields.forEach((field) => {
    const resolvedFieldKey = field.resolvedFieldKey || field.fieldKey;
    let value = getStructuredValue(safeStructuredProfile, resolvedFieldKey, field);

    if (resolvedFieldKey === "phone" && !value && mobileValue) {
      value = mobileValue;
    }

    if (resolvedFieldKey === "mobile_phone") {
      if (mobileValue) {
        value = mobileValue;
      } else if (hasRequiredPrimaryPhone && phoneValue) {
        value = "";
      } else if (field.required && phoneValue) {
        value = phoneValue;
      }
    }

    if (!value && isRepeatedConfirmationField(field, resolvedFieldKey)) {
      value = chosenValuesByKey.get(resolvedFieldKey) || "";
    }

    const normalizedValue = normalizeValueForFieldKey(resolvedFieldKey, value);

    if (!normalizedValue || !isSafeValueForFieldKey(resolvedFieldKey, normalizedValue)) {
      return;
    }

    fills.push({
      index: field.index,
      value: normalizedValue,
      confidence: field.required ? "high" : "medium",
      fieldKey: resolvedFieldKey
    });
    chosenValuesByKey.set(resolvedFieldKey, normalizedValue);
  });

  return fills;
}

function buildQuestionText(field) {
  if (field.label) {
    return field.label;
  }
  if (field.placeholder) {
    return field.placeholder;
  }
  return [
    field.name,
    field.id
  ].filter(Boolean).join(" | ");
}

function normalizeFillText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/[^a-z0-9\s/]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasPhrase(text, phrase) {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return new RegExp(`(?:^|\\b)${escaped}(?:\\b|$)`, "i").test(text);
}

function inferFieldKeyFromText(text, fallbackKey) {
  const normalized = normalizeFillText(text);
  if (!normalized) {
    return fallbackKey;
  }

  if (
    (hasPhrase(normalized, "re enter email address") ||
      hasPhrase(normalized, "reenter email address") ||
      hasPhrase(normalized, "confirm email address") ||
      hasPhrase(normalized, "confirm email") ||
      hasPhrase(normalized, "re enter e mail address") ||
      hasPhrase(normalized, "reenter e mail address")) &&
    (normalized.includes("email") || normalized.includes("e mail"))
  ) {
    return "email";
  }

  if (hasPhrase(normalized, "project title") || hasPhrase(normalized, "program title")) {
    return "project_title";
  }

  if (hasPhrase(normalized, "mission statement") || hasPhrase(normalized, "organization mission")) {
    return "mission_statement";
  }

  if (hasPhrase(normalized, "organization description") || hasPhrase(normalized, "about your organization")) {
    return "organization_description";
  }

  if (
    hasPhrase(normalized, "email address") ||
    hasPhrase(normalized, "e mail address") ||
    hasPhrase(normalized, "email") ||
    hasPhrase(normalized, "e mail")
  ) {
    return "email";
  }

  if (hasPhrase(normalized, "contact name") || hasPhrase(normalized, "contact person") || hasPhrase(normalized, "primary contact")) {
    return "contact_name";
  }

  if (hasPhrase(normalized, "first name")) {
    return "first_name";
  }

  if (hasPhrase(normalized, "last name")) {
    return "last_name";
  }

  if (hasPhrase(normalized, "title / position") || hasPhrase(normalized, "title position") || hasPhrase(normalized, "job title") || hasPhrase(normalized, "position")) {
    return "job_title";
  }

  if (hasPhrase(normalized, "mobile phone") || hasPhrase(normalized, "cell phone")) {
    return "mobile_phone";
  }

  if (hasPhrase(normalized, "phone")) {
    return "phone";
  }

  if (hasPhrase(normalized, "website") || hasPhrase(normalized, "web site") || hasPhrase(normalized, "url")) {
    return "website";
  }

  if (
    hasPhrase(normalized, "zip/postal code") ||
    hasPhrase(normalized, "zip postal code") ||
    hasPhrase(normalized, "postal code") ||
    hasPhrase(normalized, "zipcode") ||
    hasPhrase(normalized, "zip code")
  ) {
    return "zip";
  }

  if (
    hasPhrase(normalized, "state/province") ||
    hasPhrase(normalized, "state province") ||
    hasPhrase(normalized, "province") ||
    hasPhrase(normalized, "state")
  ) {
    return "state";
  }

  if (hasPhrase(normalized, "country")) {
    return "country";
  }

  if (hasPhrase(normalized, "city") || hasPhrase(normalized, "suburb")) {
    return "city";
  }

  if (
    hasPhrase(normalized, "address 2") ||
    hasPhrase(normalized, "address line 2") ||
    hasPhrase(normalized, "suite") ||
    hasPhrase(normalized, "apartment")
  ) {
    return "address_line_2";
  }

  if (hasPhrase(normalized, "address") || hasPhrase(normalized, "street")) {
    return "address_line_1";
  }

  return fallbackKey;
}

function isLikelyEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

function isLikelyPhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length >= 10 && digits.length <= 15;
}

function formatPhoneValue(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  if (digits.length === 11 && digits.startsWith("1")) {
    const core = digits.slice(1);
    return `(${core.slice(0, 3)}) ${core.slice(3, 6)}-${core.slice(6)}`;
  }
  return String(value || "").trim();
}

function isLikelyZip(value) {
  return /^\d{5}(?:-\d{4})?$/.test(String(value || "").trim());
}

function isLikelyStateValue(value) {
  const trimmed = String(value || "").trim();
  return /^[A-Za-z]{2}$/.test(trimmed) || /^[A-Za-z][A-Za-z\s.-]{2,}$/.test(trimmed);
}

function isLikelyCityValue(value) {
  const trimmed = String(value || "").trim();
  return Boolean(trimmed) && !/\d/.test(trimmed) && /^[A-Za-z][A-Za-z\s.'-]{1,}$/.test(trimmed);
}

function isLikelyCountryValue(value) {
  const trimmed = String(value || "").trim();
  return Boolean(trimmed) && !/\d/.test(trimmed) && /^[A-Za-z][A-Za-z\s.'-]{2,}$/.test(trimmed);
}

function isLikelyAddressValue(value) {
  const trimmed = String(value || "").trim();
  return Boolean(trimmed) && /\d/.test(trimmed) && /[A-Za-z]/.test(trimmed);
}

function isLikelyNameValue(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed || /\d/.test(trimmed) || !/^[A-Za-z][A-Za-z\s.'-]{0,}$/.test(trimmed)) {
    return false;
  }
  const normalized = normalizeFillText(trimmed);
  if (
    normalized.includes("address") ||
    normalized.includes("street") ||
    normalized.includes("road") ||
    normalized.includes("avenue") ||
    normalized.includes("boulevard") ||
    normalized.includes("drive") ||
    normalized.includes("lane") ||
    normalized.includes("suite") ||
    normalized.includes("position") ||
    normalized.includes("manager") ||
    normalized.includes("director")
  ) {
    return false;
  }
  return true;
}

function isLikelyFullName(value) {
  const trimmed = String(value || "").trim();
  if (!isLikelyNameValue(trimmed)) {
    return false;
  }
  return trimmed.split(/\s+/).filter(Boolean).length >= 2;
}

function isLikelyJobTitle(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed || /\d{3,}/.test(trimmed) || trimmed.includes("@")) {
    return false;
  }
  const normalized = normalizeFillText(trimmed);
  return !(
    normalized.includes("street") ||
    normalized.includes("address") ||
    normalized.includes("road") ||
    normalized.includes("avenue") ||
    normalized.includes("pittsburgh") ||
    normalized.includes("united states")
  );
}

function isLikelyOrganizationName(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed || trimmed.includes("@") || /^\d+$/.test(trimmed)) {
    return false;
  }
  const normalized = normalizeFillText(trimmed);
  return !(
    normalized.includes("street") ||
    normalized.includes("road") ||
    normalized.includes("avenue") ||
    normalized.includes("suite") ||
    normalized.includes("unit") ||
    normalized.includes("pittsburgh") ||
    normalized.includes("united states")
  );
}

function isLikelyProjectTitle(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed || trimmed.length < 4 || trimmed.includes("@")) {
    return false;
  }
  return /[A-Za-z]/.test(trimmed);
}

function isSafeValueForFieldKey(fieldKey, value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return false;
  }

  switch (fieldKey) {
    case "email":
    case "principal_investigator_email":
    case "authorized_representative_email":
    case "executive_officer_email":
      return isLikelyEmail(trimmed);
    case "phone":
    case "mobile_phone":
    case "fax":
    case "principal_investigator_phone":
    case "authorized_representative_phone":
    case "executive_officer_phone":
      return isLikelyPhone(trimmed);
    case "zip":
    case "performance_site_zip":
      return isLikelyZip(trimmed);
    case "city":
    case "performance_site_city":
      return isLikelyCityValue(trimmed);
    case "state":
    case "performance_site_state":
      return isLikelyStateValue(trimmed);
    case "country":
    case "performance_site_country":
      return isLikelyCountryValue(trimmed);
    case "address_line_1":
    case "performance_site_address_1":
      return isLikelyAddressValue(trimmed);
    case "address_line_2":
      return trimmed.length >= 2 && trimmed.length <= 120;
    case "first_name":
    case "last_name":
    case "principal_investigator_name":
    case "authorized_representative_name":
    case "executive_officer_name":
      return isLikelyNameValue(trimmed);
    case "contact_name":
      return isLikelyFullName(trimmed);
    case "job_title":
      return isLikelyJobTitle(trimmed);
    case "organization_name":
      return isLikelyOrganizationName(trimmed);
    case "project_title":
      return isLikelyProjectTitle(trimmed);
    case "website":
      return /^(https?:\/\/|www\.)/i.test(trimmed) || /^[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?:\/.*)?$/.test(trimmed);
    case "ein":
      return /^\d{2}-?\d{7}$/.test(trimmed.replace(/\s+/g, ""));
    case "mission_statement":
    case "organization_description":
    case "organization_history":
      return trimmed.length >= 20 && !isLikelyStateValue(trimmed);
    default:
      return true;
  }
}

function normalizeValueForFieldKey(fieldKey, value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return "";
  }

  switch (fieldKey) {
    case "phone":
    case "mobile_phone":
    case "fax":
    case "principal_investigator_phone":
    case "authorized_representative_phone":
    case "executive_officer_phone":
      return formatPhoneValue(trimmed);
    case "email":
    case "principal_investigator_email":
    case "authorized_representative_email":
    case "executive_officer_email":
      return trimmed.toLowerCase();
    default:
      return trimmed;
  }
}

function resolveFieldKeyForFill(field) {
  const inputType = String(field.type || "").toLowerCase();
  if (inputType === "email") {
    return "email";
  }
  if (inputType === "tel") {
    const mobileHint = normalizeFillText([field.label, field.placeholder, field.name, field.id].filter(Boolean).join(" "));
    return mobileHint.includes("mobile") || mobileHint.includes("cell") ? "mobile_phone" : "phone";
  }
  if (inputType === "url") {
    return "website";
  }

  const directText = [
    field.label,
    field.placeholder,
    field.name,
    field.id
  ].filter(Boolean).join(" ");
  const directMatch = inferFieldKeyFromText(directText, "");
  if (field.fieldKey && field.fieldKey !== "unknown" && field.confidence >= 0.78 && !directMatch) {
    return field.fieldKey;
  }
  if (directMatch) {
    return directMatch;
  }

  return inferFieldKeyFromText(field.descriptor, field.fieldKey);
}

function shouldUseAiFallback(field) {
  const resolvedFieldKey = resolveFieldKeyForFill(field);
  const group = getFieldGroup(resolvedFieldKey);
  const tagName = String(field.tagName || "").toLowerCase();
  const inputType = String(field.type || "").toLowerCase();
  const labelBlob = [field.label, field.placeholder, field.name, field.id, field.descriptor]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (tagName === "textarea") {
    return SYNTHETIC_AI_FIELD_KEYS.has(resolvedFieldKey);
  }

  if (SYNTHETIC_AI_FIELD_KEYS.has(resolvedFieldKey) && inputType !== "date") {
    return true;
  }

  if (group === "Organization" && (
    labelBlob.includes("describe") ||
    labelBlob.includes("summary") ||
    labelBlob.includes("mission") ||
    labelBlob.includes("history") ||
    labelBlob.includes("purpose")
  )) {
    return true;
  }

  return false;
}

async function requestBatchAutofillAnswers(backendUrl, payload) {
  const response = await fetch(`${backendUrl}/api/autofill-fields`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `Backend autofill failed: ${response.status}`);
  }

  return data.answers || [];
}

async function requestSingleAutofillAnswer(backendUrl, payload, field) {
  const response = await fetch(`${backendUrl}/api/autofill-field`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...payload,
      questionText: field.questionText,
      fieldKey: field.fieldKey,
      descriptor: field.descriptor,
      tagName: field.tagName,
      inputType: field.inputType
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `Backend autofill failed: ${response.status}`);
  }

  return {
    index: field.index,
    fieldKey: data.normalizedFieldKey || field.fieldKey,
    answer: data.answer || "",
    confidence: data.confidence || "low",
    rationale: data.rationale || ""
  };
}

async function requestAutofillAnswers(backendUrl, payload) {
  try {
    return await requestBatchAutofillAnswers(backendUrl, payload);
  } catch (error) {
    console.warn("Batch autofill route unavailable, falling back to single-field generation.", error);
    const answers = [];
    for (const field of payload.fields) {
      try {
        answers.push(await requestSingleAutofillAnswer(backendUrl, payload, field));
      } catch (singleError) {
        console.warn("Single-field autofill failed", singleError);
      }
    }
    return answers;
  }
}

async function autofillCurrentPage() {
  const platformUrl = DEFAULT_PLATFORM_URL;
  const backendUrl = DEFAULT_BACKEND_URL;

  if (!backendUrl) {
    setStatus("Enter the backend URL first.");
    return;
  }

  await chrome.storage.local.set({
    [PLATFORM_URL_STORAGE_KEY]: platformUrl,
    [BACKEND_URL_STORAGE_KEY]: backendUrl
  });

  const saved = await chrome.storage.local.get([
    PLATFORM_PROFILE_STORAGE_KEY,
    PLATFORM_PROFILE_TEXT_STORAGE_KEY,
    PLATFORM_USER_ID_STORAGE_KEY,
    PLATFORM_ACCESS_TOKEN_STORAGE_KEY,
    STRUCTURED_PROFILE_STORAGE_KEY
  ]);

  let profileSummary = saved[PLATFORM_PROFILE_STORAGE_KEY] || null;
  let profileText = saved[PLATFORM_PROFILE_TEXT_STORAGE_KEY] || "";
  let userId = saved[PLATFORM_USER_ID_STORAGE_KEY] || "";
  let accessToken = saved[PLATFORM_ACCESS_TOKEN_STORAGE_KEY] || "";
  let structuredProfile = saved[STRUCTURED_PROFILE_STORAGE_KEY] || null;

  if (!profileText && !userId && !accessToken) {
    await connectToPlatform();
    const refreshed = await chrome.storage.local.get([
      PLATFORM_PROFILE_STORAGE_KEY,
      PLATFORM_PROFILE_TEXT_STORAGE_KEY,
      PLATFORM_USER_ID_STORAGE_KEY,
      PLATFORM_ACCESS_TOKEN_STORAGE_KEY,
      STRUCTURED_PROFILE_STORAGE_KEY
    ]);
    profileSummary = refreshed[PLATFORM_PROFILE_STORAGE_KEY] || profileSummary;
    profileText = refreshed[PLATFORM_PROFILE_TEXT_STORAGE_KEY] || "";
    userId = refreshed[PLATFORM_USER_ID_STORAGE_KEY] || "";
    accessToken = refreshed[PLATFORM_ACCESS_TOKEN_STORAGE_KEY] || "";
    structuredProfile = refreshed[STRUCTURED_PROFILE_STORAGE_KEY] || structuredProfile;
  }

  if (!profileText && !userId && !accessToken) {
    setStatusState("error");
    setStatus("No uploaded-document profile or signed-in document context is available yet. Sync the platform first.");
    updateFlowState({ hasConnectedProfile: false });
    return;
  }

  if (!structuredProfile) {
    try {
      const syncResult = await syncStructuredProfile(backendUrl, profileText, userId, accessToken);
      structuredProfile = syncResult.structuredProfile;
      await chrome.storage.local.set({
        [STRUCTURED_PROFILE_STORAGE_KEY]: structuredProfile
      });
      const refreshedSummary = await chrome.storage.local.get([PLATFORM_DOCUMENT_NAMES_STORAGE_KEY]);
      renderProfileSummary(refreshedSummary[PLATFORM_DOCUMENT_NAMES_STORAGE_KEY] || []);
    } catch (error) {
      console.warn("Late structured profile sync failed", error);
    }
  }

  updateFlowState({ hasConnectedProfile: true });

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    setStatusState("error");
    setStatus("Could not find the active tab.");
    return;
  }

  setStatusState("working");
  setStatus("Analyzing the current page and matching profile data...");
  const scanResponse = await prepareCurrentPage(tab.id);
  if (!scanResponse) {
    setStatusState("error");
    setStatus("This page did not respond. Refresh the page and try again.");
    return;
  }

  const targets = chooseAutofillTargets(scanResponse.fields || []);
  if (!targets.length) {
    renderFields(scanResponse);
    setStatusState("error");
    setStatus("No supported autofill targets were detected on this page.");
    return;
  }

  const fills = buildStructuredFills(targets, structuredProfile);
  const filledIndexes = new Set(fills.map((fill) => fill.index));
  const aiTargets = targets
    .filter((field) => !filledIndexes.has(field.index))
    .filter((field) => shouldUseAiFallback(field));

  if (aiTargets.length) {
    setStatusState("working");
    setStatus(`Using uploaded documents to draft ${aiTargets.length} additional answer${aiTargets.length === 1 ? "" : "s"}...`);
    try {
      const answers = await requestAutofillAnswers(backendUrl, {
        fields: aiTargets.map((field) => ({
          index: field.index,
          fieldKey: resolveFieldKeyForFill(field),
          questionText: buildQuestionText(field),
          descriptor: field.descriptor,
          tagName: field.tagName,
          inputType: field.type
        })),
        pageTitle: scanResponse.title,
        pageUrl: scanResponse.url,
        organizationProfile: profileText,
        grantContext: "",
        userId,
        accessToken
      });

      answers.forEach((answer) => {
        const resolvedFieldKey = answer.fieldKey || "unknown";
        const normalizedAnswer = normalizeValueForFieldKey(resolvedFieldKey, answer.answer);
        if (normalizedAnswer && answer.confidence !== "low" && isSafeValueForFieldKey(resolvedFieldKey, normalizedAnswer)) {
          fills.push({
            index: answer.index,
            value: normalizedAnswer,
            confidence: answer.confidence || "medium",
            fieldKey: resolvedFieldKey
          });
        }
      });
    } catch (error) {
      console.error("Batch autofill failed", error);
    }
  }

  if (!fills.length) {
    renderFields(scanResponse);
    setStatusState("error");
    setStatus("No safe autofill values were generated. Review the highlighted fields for manual mapping.");
    return;
  }

  const fillResponse = await chrome.tabs.sendMessage(tab.id, {
    type: "GRANT_HELPER_AUTOFILL_FIELDS",
    fills
  }).catch(() => null);

  renderFields(scanResponse);
  if (!fillResponse) {
    setStatusState("error");
    setStatus("Autofill values were prepared, but the page could not be updated.");
    return;
  }

  const applied = fillResponse.applied?.length || 0;
  const skipped = fillResponse.skipped?.length || 0;
  setStatusState(applied > 0 ? "success" : "error");
  setStatus(`Autofilled ${applied} field${applied === 1 ? "" : "s"} from uploaded-document context. ${skipped ? `${skipped} still need review.` : "Review highlights for any remaining fields."}`);
}

autofillButton.addEventListener("click", () => {
  autofillCurrentPage().catch((error) => {
    console.error(error);
    setStatusState("error");
    setStatus("Could not autofill this page.");
  });
});

openPlatformButton.addEventListener("click", () => {
  chrome.tabs.create({ url: DEFAULT_PLATFORM_URL });
});

connectPlatformButton.addEventListener("click", () => {
  setStatusState("working");
  setStatus("Syncing uploaded documents from GrantFlow...");
  connectToPlatform().catch((error) => {
    console.error(error);
    setStatusState("error");
    setStatus("Could not connect to the platform.");
  });
});
