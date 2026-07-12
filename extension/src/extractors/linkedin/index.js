// LinkedIn platform registry — just the ordered list of extractors.
// Aggregation + resolution lives in ../index.js (the multi-platform registry).
//
// Order matters for URL auto-detection: more specific patterns first.
// `comments` (single-post permalink /feed/update/…) must be tested before
// `posts` (whose pattern also matches the home /feed/).

import * as profile from './profile.js';
import * as peopleCompany from './peopleCompany.js';
import * as posts from './posts.js';
import * as comments from './comments.js';
import * as jobs from './jobs.js';

export const PLATFORM = 'linkedin';

export const SKILLS = [profile, peopleCompany, comments, posts, jobs];
