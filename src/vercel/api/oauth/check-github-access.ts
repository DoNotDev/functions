// packages/functions/src/vercel/api/oauth/check-github-access.ts

/**
 * @fileoverview Check GitHub access API handler
 * @description Vercel API route for checking GitHub access status
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import {
  checkGitHubAccessSchema,
  type CheckGitHubAccessRequest,
} from '@donotdev/core/server';
import { getFirebaseAdminAuth } from '@donotdev/firebase/server';

import { GitHubApiService } from '../../../shared/index.js';
import { createVercelBaseFunction } from '../../baseFunction.js';

import type { NextApiRequest, NextApiResponse } from 'next';
import type * as v from 'valibot';

/**
 * Business logic for checking GitHub access
 * Base function handles: validation, auth, rate limiting, monitoring
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
async function checkGitHubAccessLogic(
  req: NextApiRequest,
  res: NextApiResponse,
  data: CheckGitHubAccessRequest,
  context: { uid: string }
) {
  const { githubUsername, repoConfig } = data;
  const userId = context.uid;

  if (!githubUsername) {
    throw new Error('GitHub username is required');
  }

  if (!repoConfig?.owner || !repoConfig?.repo) {
    throw new Error('Repository owner and name are required');
  }

  // Get GitHub token
  const githubToken = process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
  if (!githubToken) {
    throw new Error('GitHub Personal Access Token not configured');
  }

  // Initialize GitHub API service
  const githubApi = new GitHubApiService({ accessToken: githubToken });

  // Check if user is collaborator
  const hasAccess = await githubApi.isCollaborator(
    repoConfig.owner,
    repoConfig.repo,
    githubUsername
  );

  // Also check custom claims for access record
  const user = await getFirebaseAdminAuth().getUser(userId);
  const customClaims = user.customClaims || {};
  const githubAccess =
    customClaims.githubAccess?.[repoConfig.owner]?.[repoConfig.repo];

  const result = {
    success: true,
    userId,
    githubUsername,
    repoConfig,
    hasAccess,
    customClaimsAccess: !!githubAccess,
    accessDetails: githubAccess || null,
    message: hasAccess
      ? `${githubUsername} has access to ${repoConfig.owner}/${repoConfig.repo}`
      : `${githubUsername} does not have access to ${repoConfig.owner}/${repoConfig.repo}`,
  };

  return res.status(200).json(result);
}

/**
 * Vercel API handler for checking GitHub access
 * Base function handles all common concerns automatically
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
const checkGitHubAccess = (
  customSchema?: v.BaseSchema<unknown, any, v.BaseIssue<unknown>>
) => {
  const schema = customSchema || checkGitHubAccessSchema;
  return createVercelBaseFunction(
    'POST',
    schema,
    'check_github_access',
    checkGitHubAccessLogic
  );
};

export default checkGitHubAccess;
