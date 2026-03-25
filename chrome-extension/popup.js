const statusNode = document.getElementById("status");
const resultsNode = document.getElementById("results");
const scanButton = document.getElementById("scan-button");
const autofillButton = document.getElementById("autofill-button");
const openPlatformButton = document.getElementById("open-platform-button");
const connectPlatformButton = document.getElementById("connect-platform-button");
const platformUrlInput = document.getElementById("platform-url");
const profileSummaryNode = document.getElementById("profile-summary");

const PLATFORM_URL_STORAGE_KEY = "grantflow.extension.platformUrl";
const PLATFORM_PROFILE_STORAGE_KEY = "grantflow.extension.profileSummary";
const PROFILE_STORAGE_KEY = "grantflow.organizationProfile";
const PROFILE_SUMMARY_STORAGE_KEY = "grantflow.profileSummary";

let lastScanPayload = null;

initializePopup().catch(console.error);

function setStatus(message) {
  statusNode.textContent = message;
}

function renderFields(payload) {
  lastScanPayload = payload;
  const fields = payload.fields || [];
  const summary = summarizeFields(fields);
  const groupedFields = groupFields(fields);

  if (fields.length === 0) {
    resultsNode.innerHTML = "<p class=\"field-meta\">No visible form fields were detected on this page.</p>";
    return;
  }

  resultsNode.innerHTML = `
    <section class="summary-card">
      <p class="summary-line">High confidence: ${summary.high}</p>
      <p class="summary-line">Needs review: ${summary.review}</p>
      <p class="summary-line">Unknown: ${summary.low}</p>
    </section>
  ` + groupedFields
    .map(([groupName, groupItems]) => renderGroup(groupName, groupItems))
    .join("");
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

function renderFieldCard(field) {
  const title = field.fieldKey === "unknown" ? "Unknown field" : field.fieldKey.replace(/_/g, " ");
  const label = field.label || field.placeholder || field.name || field.id || "Unlabeled field";
  const reasons = (field.reasons || []).join(", ");
  const bucketLabel = field.confidenceBucket === "high"
    ? "High confidence"
    : field.confidenceBucket === "review"
      ? "Review"
      : "Unknown";

  return `
    <section class="field-card field-card--${escapeHtml(field.confidenceBucket)}">
      <h3>${escapeHtml(title)}</h3>
      <p class="field-meta">${escapeHtml(label)}</p>
      <p class="field-meta">Label: ${escapeHtml(label)}</p>
      <p class="field-meta">Type: ${escapeHtml(field.tagName)} · ${escapeHtml(field.type)}</p>
      <p class="field-meta">Name/ID: ${escapeHtml(field.name || "(no name)")} · ${escapeHtml(field.id || "(no id)")}</p>
      <p class="field-meta">${escapeHtml(field.path)}</p>
      <span class="confidence">${escapeHtml(bucketLabel)} · ${Math.round(field.confidence * 100)}%</span>
      <p class="field-meta">${escapeHtml(reasons || "No keyword match, fallback heuristic only")}</p>
      <p class="field-meta">${escapeHtml(field.descriptor)}</p>
    </section>
  `;
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

async function initializePopup() {
  const saved = await chrome.storage.local.get([PLATFORM_URL_STORAGE_KEY, PLATFORM_PROFILE_STORAGE_KEY]);
  if (saved[PLATFORM_URL_STORAGE_KEY]) {
    platformUrlInput.value = saved[PLATFORM_URL_STORAGE_KEY];
  }
  renderProfileSummary(saved[PLATFORM_PROFILE_STORAGE_KEY] || null);
}

function renderProfileSummary(summary) {
  if (!summary) {
    profileSummaryNode.innerHTML = `<p class="field-meta">Not connected yet. Open the platform, upload profile docs there, then connect from the extension.</p>`;
    return;
  }

  profileSummaryNode.innerHTML = `
    <h3 class="profile-summary-title">Connected Profile</h3>
    <p class="field-meta">Characters: ${escapeHtml(String(summary.characters || 0))}</p>
    <p class="field-meta">Sentences: ${escapeHtml(String(summary.sentences || 0))}</p>
    <p class="field-meta">${escapeHtml(summary.preview || "No preview available.")}</p>
  `;
}

async function getPlatformTab(platformUrl) {
  const [exactTab] = await chrome.tabs.query({ url: `${platformUrl}/*` });
  if (exactTab?.id) {
    return exactTab;
  }

  const tabs = await chrome.tabs.query({});
  return tabs.find((tab) => tab.url && tab.url.startsWith(platformUrl)) || null;
}

async function connectToPlatform() {
  const platformUrl = platformUrlInput.value.trim().replace(/\/+$/, "");
  if (!platformUrl) {
    setStatus("Enter the platform URL first.");
    return;
  }

  await chrome.storage.local.set({ [PLATFORM_URL_STORAGE_KEY]: platformUrl });
  const tab = await getPlatformTab(platformUrl);

  if (!tab?.id) {
    setStatus("Platform tab not found. Open the platform first, then connect.");
    return;
  }

  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (profileKey, summaryKey) => {
      try {
        const profile = window.localStorage.getItem(profileKey) || "";
        const rawSummary = window.localStorage.getItem(summaryKey);
        const summary = rawSummary ? JSON.parse(rawSummary) : null;
        return { profile, summary };
      } catch (error) {
        return {
          profile: "",
          summary: null,
          error: error instanceof Error ? error.message : "Could not read platform state."
        };
      }
    },
    args: [PROFILE_STORAGE_KEY, PROFILE_SUMMARY_STORAGE_KEY]
  });

  if (!result || result.error) {
    setStatus(result?.error || "Could not read the platform profile.");
    return;
  }

  if (!result.profile) {
    setStatus("No organization profile found yet. Upload or create it in the platform first.");
    renderProfileSummary(null);
    return;
  }

  await chrome.storage.local.set({ [PLATFORM_PROFILE_STORAGE_KEY]: result.summary });
  renderProfileSummary(result.summary);
  setStatus("Connected to GrantFlow profile successfully.");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function scanCurrentPage() {
  setStatus("Running Task 1.3 scan on the current page...");
  resultsNode.innerHTML = "";

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab?.id) {
    setStatus("Could not find the active tab.");
    return;
  }

  const response = await chrome.tabs.sendMessage(tab.id, { type: "GRANT_HELPER_SCAN_FIELDS" }).catch(() => null);

  if (!response) {
    setStatus("This page did not respond. Try refreshing the tab and scanning again.");
    return;
  }

  setStatus(`Task 1.3 scan complete. Found ${response.fields.length} visible field${response.fields.length === 1 ? "" : "s"} on this page.`);
  renderFields(response);
}

async function triggerAutofillPrep() {
  setStatus("Preparing autofill targets on the current page...");
  resultsNode.innerHTML = "";

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    setStatus("Could not find the active tab.");
    return;
  }

  const response = await chrome.tabs.sendMessage(tab.id, { type: "GRANT_HELPER_PREPARE_AUTOFILL" }).catch(() => null);
  if (!response) {
    setStatus("This page did not respond. Try refreshing the tab and preparing again.");
    return;
  }

  const fields = response.fields || [];
  const high = fields.filter((field) => field.confidenceBucket === "high").length;
  const review = fields.filter((field) => field.confidenceBucket === "review").length;
  const unknown = fields.filter((field) => field.confidenceBucket === "low").length;

  setStatus(`Prepared ${high} high-confidence matches, ${review} review fields, and ${unknown} manual-mapping fields.`);
  renderFields(response);
}


scanButton.addEventListener("click", () => {
  scanCurrentPage().catch((error) => {
    console.error(error);
    setStatus("Scan failed. Check the extension console for details.");
  });
});

autofillButton.addEventListener("click", () => {
  triggerAutofillPrep().catch((error) => {
    console.error(error);
    setStatus("Could not prepare autofill for this page.");
  });
});

openPlatformButton.addEventListener("click", () => {
  chrome.tabs.create({ url: platformUrlInput.value.trim() || "http://localhost:5173" });
});

connectPlatformButton.addEventListener("click", () => {
  connectToPlatform().catch((error) => {
    console.error(error);
    setStatus("Could not connect to the platform.");
  });
});
