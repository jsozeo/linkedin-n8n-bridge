// LinkedIn platform registry — just the ordered list of extractors.
// Aggregation + resolution lives in ../index.js (the multi-platform registry).
//
// Order matters for URL auto-detection: more specific patterns first.
// `comments` (single-post permalink /feed/update/…) must be tested before
// `posts` (whose pattern also matches the home /feed/).

import * as profile from './profile.js';
import * as companyAbout from './companyAbout.js';
import * as companyLife from './companyLife.js';
import * as companyJobs from './companyJobs.js';
import * as companyPosts from './companyPosts.js';
import * as searchPeople from './searchPeople.js';
import * as searchCompanies from './searchCompanies.js';
import * as company from './company.js';
import * as peopleCompany from './peopleCompany.js';
import * as posts from './posts.js';
import * as comments from './comments.js';
import * as messaging from './messaging.js';
import * as jobs from './jobs.js';

export const PLATFORM = 'linkedin';

// Order = URL auto-detection priority (most specific first). The company
// sub-tabs (/about, /life, /jobs, /posts) are matched before the bare
// `company` overview and before `peopleCompany` (/people). `kind` is usually
// passed explicitly by the orchestrator, so order only matters for detection.
export const SKILLS = [
  profile,
  companyAbout,
  companyLife,
  companyJobs,
  companyPosts,
  // Global search results — must precede peopleCompany, whose pattern also
  // matches /search/results/people.
  searchPeople,
  searchCompanies,
  peopleCompany,
  company,
  comments,
  posts,
  // messaging matches /feed$ too — keep it AFTER posts so the bare home feed
  // still routes to the feed extractor by default.
  messaging,
  jobs,
];
