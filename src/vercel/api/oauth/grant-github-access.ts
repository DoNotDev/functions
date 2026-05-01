// packages/functions/src/vercel/api/oauth/grant-github-access.ts

/**
 * @fileoverview Grant GitHub access API handler
 * @description Vercel API route for granting GitHub access
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import {
  grantGitHubAccessSchema,
  type GrantGitHubAccessRequest,
} from '@donotdev/core/server';
import { getFirebaseAdminAuth } from '@donotdev/firebase/server';

import { GitHubApiService } from '../../../shared/index.js';
import { createVercelBaseFunction } from '../../baseFunction.js';

import type { NextApiRequest, NextApiResponse } from 'next';
import type * as v from 'valibot';

/**
 * Business logic for granting GitHub access
 * Base function handles: validation, auth, rate limiting, monitoring
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
async function grantGitHubAccessLogic(
  req: NextApiRequest,
  res: NextApiResponse,
  data: GrantGitHubAccessRequest,
  context: { uid: string }
) {
  const {
    githubUsername,
    repoConfig,
    permission = 'push',
    customClaims,
  } = data;
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

  // Add collaborator to repository
  await githubApi.addCollaborator({
    owner: repoConfig.owner,
    repo: repoConfig.repo,
    username: githubUsername,
    permission: permission as 'push' | 'pull' | 'triage' | 'maintain' | 'admin',
  });

  // Update user's custom claims if provided
  if (customClaims) {
    const user = await getFirebaseAdminAuth().getUser(userId);
    const updatedClaims = {
      ...user.customClaims,
      ...customClaims,
      githubAccess: {
        ...user.customClaims?.githubAccess,
        [repoConfig.owner]: {
          ...user.customClaims?.githubAccess?.[repoConfig.owner],
          [repoConfig.repo]: {
            username: githubUsername,
            permission,
            grantedAt: new Date().toISOString(),
          },
        },
      },
    };

    await getFirebaseAdminAuth().setCustomUserClaims(userId, updatedClaims);
  }

  const result = {
    success: true,
    userId,
    githubUsername,
    repoConfig,
    permission,
    message: `Successfully granted ${githubUsername} ${permission} access to ${repoConfig.owner}/${repoConfig.repo}`,
  };

  return res.status(200).json(result);
}

/**
 * Vercel API handler for granting GitHub access
 * Base function handles all common concerns automatically
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
const grantGitHubAccess = (
  customSchema?: v.BaseSchema<unknown, any, v.BaseIssue<unknown>>
) => {
  const schema = customSchema || grantGitHubAccessSchema;
  return createVercelBaseFunction(
    'POST',
    schema,
    'grant_github_access',
    grantGitHubAccessLogic
  );
};

export default grantGitHubAccess;
