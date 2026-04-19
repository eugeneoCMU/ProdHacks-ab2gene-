#!/usr/bin/env node

/**
 * Smart Matching Validation Test Suite
 * Tests the LLM-powered grant matching system with diverse nonprofit profiles and real grants
 */

import { writeFileSync } from 'fs';

const BACKEND_URL = 'http://localhost:3001';

// 15 diverse nonprofit profiles for testing
const TEST_PROFILES = [
  {
    id: 'micro-edu-rural',
    text: `Rural Education Initiative
Annual Budget: $25,000
Location: Lexington, Kentucky
Focus: Literacy programs for elementary students in rural Appalachia
Target: Children ages 5-12 in underserved rural communities
Staff: 2 part-time coordinators
501(c)(3) nonprofit, 3 years operating`
  },
  {
    id: 'small-health-urban',
    text: `Community Health Access Project
Annual Budget: $150,000
Location: Detroit, Michigan
Focus: Mental health services and substance abuse treatment for low-income adults
Target: Adults 18-65 in urban Detroit neighborhoods
Staff: 8 full-time, 12 part-time
501(c)(3) nonprofit, 7 years operating`
  },
  {
    id: 'medium-stem-suburban',
    text: `STEM Future Foundation
Annual Budget: $500,000
Location: Austin, Texas
Focus: Robotics, coding, and engineering programs for middle and high school students
Target: Students grades 6-12, especially girls and underrepresented minorities
Staff: 15 full-time, 25 part-time instructors
501(c)(3) nonprofit, 10 years operating`
  },
  {
    id: 'large-environment-national',
    text: `National Conservation Alliance
Annual Budget: $2,500,000
Location: Washington, DC (operates nationwide)
Focus: Climate change advocacy, forest conservation, wildlife protection
Target: General public, policymakers, environmental organizations
Staff: 45 full-time, 20 contractors
501(c)(3) nonprofit, 18 years operating`
  },
  {
    id: 'micro-arts-urban',
    text: `Brooklyn Arts Collective
Annual Budget: $35,000
Location: Brooklyn, New York
Focus: Community theater and visual arts workshops for youth
Target: Youth ages 13-18 in Brooklyn neighborhoods
Staff: 3 part-time coordinators
501(c)(3) nonprofit, 2 years operating`
  },
  {
    id: 'small-social-services',
    text: `Homeless Outreach Services
Annual Budget: $180,000
Location: Portland, Oregon
Focus: Emergency shelter, food assistance, job training for homeless individuals
Target: Homeless adults and families
Staff: 10 full-time, 8 volunteers
501(c)(3) nonprofit, 12 years operating`
  },
  {
    id: 'medium-youth-development',
    text: `Youth Leadership Institute
Annual Budget: $650,000
Location: Atlanta, Georgia
Focus: After-school programs, mentorship, college prep for at-risk youth
Target: High school students from low-income families
Staff: 22 full-time, 30 mentors
501(c)(3) nonprofit, 15 years operating`
  },
  {
    id: 'large-medical-research',
    text: `Diabetes Research Foundation
Annual Budget: $5,000,000
Location: Boston, Massachusetts
Focus: Medical research on diabetes prevention and treatment
Target: Research scientists, medical community, diabetes patients
Staff: 75 full-time researchers and staff
501(c)(3) nonprofit, 25 years operating`
  },
  {
    id: 'small-senior-services',
    text: `Elder Care Network
Annual Budget: $220,000
Location: Phoenix, Arizona
Focus: Meal delivery, transportation, social activities for seniors
Target: Adults 65+ living independently
Staff: 12 full-time, 40 volunteers
501(c)(3) nonprofit, 9 years operating`
  },
  {
    id: 'medium-economic-development',
    text: `Small Business Development Center
Annual Budget: $450,000
Location: Cleveland, Ohio
Focus: Business training, microloans, entrepreneurship support
Target: Low-income entrepreneurs and small business owners
Staff: 18 full-time
501(c)(3) nonprofit, 11 years operating`
  },
  {
    id: 'micro-faith-community',
    text: `Faith Community Food Pantry
Annual Budget: $40,000
Location: Nashville, Tennessee
Focus: Food distribution and emergency assistance for families in need
Target: Low-income families in Davidson County
Staff: 2 part-time, 25 volunteers
Faith-based 501(c)(3), 5 years operating`
  },
  {
    id: 'small-disability-services',
    text: `Adaptive Recreation Program
Annual Budget: $195,000
Location: Seattle, Washington
Focus: Sports and recreation programs for children with disabilities
Target: Children and young adults with physical and developmental disabilities
Staff: 11 full-time, 15 part-time coaches
501(c)(3) nonprofit, 8 years operating`
  },
  {
    id: 'medium-education-charter',
    text: `STEAM Academy Charter School
Annual Budget: $850,000
Location: Los Angeles, California
Focus: Science, technology, engineering, arts, and math education
Target: K-8 students, 60% from low-income families
Staff: 35 full-time teachers and administrators
501(c)(3) charter school, 6 years operating`
  },
  {
    id: 'large-international-aid',
    text: `Global Health Initiative
Annual Budget: $12,000,000
Location: New York, New York (operates in 20 countries)
Focus: Maternal health, disease prevention, clean water access
Target: Underserved populations in developing countries
Staff: 150 full-time, 200 field workers
501(c)(3) nonprofit, 30 years operating`
  },
  {
    id: 'small-animal-welfare',
    text: `Animal Rescue Foundation
Annual Budget: $175,000
Location: Denver, Colorado
Focus: Animal rescue, adoption, spay/neuter programs
Target: Abandoned and stray animals in Denver metro area
Staff: 9 full-time, 50 volunteers
501(c)(3) nonprofit, 14 years operating`
  }
];

// Fetch real grants from Grants.gov API
async function fetchGrantsFromAPI(limit = 20) {
  try {
    console.log(`\nFetching ${limit} grants from Grants.gov API...`);
    const response = await fetch('https://api.simpler.grants.gov/v1/opportunities/search', {
      method: 'POST',
      headers: {
        'X-API-Key': 'aqkUnWCC1fVlk2YPe9XV4BcQl',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: 'education',
        filters: {
          opportunity_status: { one_of: ['posted'] },
          applicant_type: { one_of: ['nonprofits_non_higher_education_with_501c3', 'state_governments'] },
        },
        pagination: {
          page_offset: 1,
          page_size: limit,
          sort_order: [{ order_by: 'close_date', sort_direction: 'ascending' }],
        },
      }),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Grants.gov API error: ${response.status} ${text}`);
    }
    const data = await response.json();
    console.log(`✓ Fetched ${data.data?.length || 0} grants`);
    return data.data || [];
  } catch (err) {
    console.error('Failed to fetch from Grants.gov:', err.message);
    return [];
  }
}

// Helper to wait/delay
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Test smart matching for one profile against multiple grants
async function testProfileMatching(profile, grants) {
  try {
    const response = await fetch(`${BACKEND_URL}/api/grants/smart-match`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        organizationProfile: profile.text,
        grants: grants,
        topN: grants.length
      })
    });

    if (!response.ok) {
      throw new Error(`Smart match API error: ${response.status}`);
    }

    const result = await response.json();
    return result.matches;
  } catch (err) {
    console.error(`Failed to match profile ${profile.id}:`, err.message);
    return [];
  }
}

// Analyze results and generate statistics
function analyzeResults(allResults) {
  const stats = {
    totalTests: allResults.length,
    scoreDistribution: { excellent: 0, good: 0, fair: 0, poor: 0 },
    avgScoreByProfile: {},
    topMatchesByProfile: {},
    issuesFound: []
  };

  allResults.forEach(result => {
    const { profileId, matches } = result;

    if (matches.length === 0) {
      stats.avgScoreByProfile[profileId] = 'N/A';
      stats.topMatchesByProfile[profileId] = [];
      return;
    }

    // Calculate average score for this profile
    const scores = matches.map(m => m.matchScore || 0);
    const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;
    stats.avgScoreByProfile[profileId] = avgScore.toFixed(1);

    // Count score distribution
    scores.forEach(score => {
      if (score >= 80) stats.scoreDistribution.excellent++;
      else if (score >= 60) stats.scoreDistribution.good++;
      else if (score >= 40) stats.scoreDistribution.fair++;
      else stats.scoreDistribution.poor++;
    });

    // Store top 3 matches
    stats.topMatchesByProfile[profileId] = matches
      .slice(0, 3)
      .map(m => ({
        title: m.opportunity_title,
        score: m.matchScore,
        explanation: m.matchExplanation?.substring(0, 100) + '...'
      }));

    // Detect potential issues
    if (avgScore > 75) {
      stats.issuesFound.push(`${profileId}: Very high average score (${avgScore.toFixed(1)}) - may be too lenient`);
    }
    if (avgScore < 20) {
      stats.issuesFound.push(`${profileId}: Very low average score (${avgScore.toFixed(1)}) - may be too strict`);
    }
  });

  return stats;
}

// Main test execution
async function runTests() {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  Smart Matching Validation Test Suite');
  console.log('═══════════════════════════════════════════════════════\n');

  const startTime = Date.now();

  // Step 1: Fetch real grants
  const grants = await fetchGrantsFromAPI(3); // Reduced to 10 to avoid rate limits
  if (grants.length === 0) {
    console.error('✗ No grants fetched. Exiting.');
    return;
  }

  // Step 2: Select subset of profiles for testing (to save API costs)
  const testProfiles = TEST_PROFILES.slice(0, 3); // Test with 3 profiles to avoid rate limits
  console.log(`\nTesting ${testProfiles.length} nonprofit profiles against ${grants.length} grants`);
  console.log(`Total combinations: ${testProfiles.length * grants.length} matches`);
  console.log('(Adding delays between profiles to avoid rate limits...)\n');

  // Step 3: Run matching tests with delays
  const allResults = [];
  for (let i = 0; i < testProfiles.length; i++) {
    const profile = testProfiles[i];
    console.log(`[${i + 1}/${testProfiles.length}] Testing ${profile.id}...`);
    
    // Add delay before each profile (except first) to avoid rate limits
    if (i > 0) {
      console.log('  ⏱ Waiting 10s to avoid rate limits...');
      await delay(10000);
    }
    
    const matches = await testProfileMatching(profile, grants);
    allResults.push({ profileId: profile.id, matches });
    
    if (matches.length > 0) {
      const avgScore = (matches.reduce((sum, m) => sum + (m.matchScore || 0), 0) / matches.length).toFixed(1);
      console.log(`  ✓ Matched ${matches.length} grants (avg score: ${avgScore})`);
    } else {
      console.log(`  ✗ Failed to match grants (check server logs)`);
    }
  }

  // Step 4: Analyze results
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  Test Results Summary');
  console.log('═══════════════════════════════════════════════════════\n');

  const stats = analyzeResults(allResults);

  const totalMatches = testProfiles.length * grants.length;
  console.log('Score Distribution:');
  console.log(`  Excellent (80-100): ${stats.scoreDistribution.excellent} (${(stats.scoreDistribution.excellent / totalMatches * 100).toFixed(1)}%)`);
  console.log(`  Good (60-79):       ${stats.scoreDistribution.good} (${(stats.scoreDistribution.good / totalMatches * 100).toFixed(1)}%)`);
  console.log(`  Fair (40-59):       ${stats.scoreDistribution.fair} (${(stats.scoreDistribution.fair / totalMatches * 100).toFixed(1)}%)`);
  console.log(`  Poor (0-39):        ${stats.scoreDistribution.poor} (${(stats.scoreDistribution.poor / totalMatches * 100).toFixed(1)}%)\n`);

  console.log('Average Score by Profile:');
  Object.entries(stats.avgScoreByProfile).forEach(([profile, score]) => {
    console.log(`  ${profile}: ${score}`);
  });

  console.log('\nTop 3 Matches by Profile:');
  Object.entries(stats.topMatchesByProfile).forEach(([profileId, matches]) => {
    console.log(`\n  ${profileId}:`);
    matches.forEach((m, i) => {
      console.log(`    ${i + 1}. [${m.score}%] ${m.title}`);
      console.log(`       ${m.explanation}`);
    });
  });

  if (stats.issuesFound.length > 0) {
    console.log('\n⚠ Potential Issues Detected:');
    stats.issuesFound.forEach(issue => console.log(`  - ${issue}`));
  }

  console.log('\n═══════════════════════════════════════════════════════');
  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  const estimatedCost = (testProfiles.length * grants.length * 0.05).toFixed(2);
  console.log(`Completed in ${duration}s`);
  console.log(`Estimated API cost: $${estimatedCost}`);
  console.log('═══════════════════════════════════════════════════════\n');

  // Save detailed results to file
  writeFileSync(
    'test-results.json',
    JSON.stringify({ stats, allResults }, null, 2)
  );
  console.log('✓ Detailed results saved to test-results.json\n');
}

// Run the tests
runTests().catch(err => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
