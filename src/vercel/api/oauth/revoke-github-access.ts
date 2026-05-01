// packages/functions/src/vercel/api/oauth/revoke-github-access.ts

/**
 * @fileoverview Revoke GitHub access API handler
 * @description Vercel API route for revoking GitHub access
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import * as v from 'valibot';

import {
  revokeGitHubAccessSchema,
  type RevokeGitHubAccessRequest,
} from '@donotdev/core/server';
import { getFirebaseAdminAuth } from '@donotdev/firebase/server';

import { handleError } from '../../../shared/errorHandling.js';
import { GitHubApiService } from '../../../shared/index.js';
import { verifyAuthToken } from '../../../shared/utils/internal/auth.js';

import type { NextApiRequest, NextApiResponse } from 'next';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
  customSchema?: v.BaseSchema<unknown, any, v.BaseIssue<unknown>>
) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // C1: verify JWT — previously only checked header presence.
    const uid = await verifyAuthToken(req);

    // Use provided schema or default to framework schema
    const schema = customSchema || revokeGitHubAccessSchema;

    // Validate request data using the schema
    const validationResult = v.safeParse(schema, req.body);
    if (!validationResult.success) {
      return res.status(400).json({
        error: `Validation failed: ${validationResult.issues.map((e) => e.message).join(', ')}`,
      });
    }

    const { githubUsername, repoConfig } = validationResult.output as {
      userId?: string;
      githubUsername: string;
      repoConfig: { owner: string; repo: string };
    };

    // C1/IDOR: Always use verified uid from token — ignore client-supplied userId.
    const userId = uid;

    if (!githubUsername) {
      throw handleError(new Error('GitHub username is required'));
    }

    if (!repoConfig?.owner || !repoConfig?.repo) {
      throw handleError(new Error('Repository owner and name are required'));
    }

    // Get GitHub token
    const githubToken = process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
    if (!githubToken) {
      throw handleError(
        new Error('GitHub Personal Access Token not configured')
      );
    }

    // Initialize GitHub API service
    const githubApi = new GitHubApiService({ accessToken: githubToken });

    // Remove collaborator from repository
    const removedFromGitHub = await githubApi.removeCollaborator(
      repoConfig.owner,
      repoConfig.repo,
      githubUsername
    );
    if (!removedFromGitHub) {
      console.warn(`Failed to remove ${githubUsername} from GitHub repository`);
    }

    // Remove from user's custom claims
    const user = await getFirebaseAdminAuth().getUser(userId);
    const customClaims = user.customClaims || {};

    if (customClaims.githubAccess?.[repoConfig.owner]?.[repoConfig.repo]) {
      const updatedClaims = { ...customClaims };

      // Remove the specific repository access
      if (updatedClaims.githubAccess[repoConfig.owner]) {
        delete updatedClaims.githubAccess[repoConfig.owner][repoConfig.repo];

        // If no repositories left for this owner, remove the owner entry
        if (
          Object.keys(updatedClaims.githubAccess[repoConfig.owner]).length === 0
        ) {
          delete updatedClaims.githubAccess[repoConfig.owner];
        }
      }

      await getFirebaseAdminAuth().setCustomUserClaims(userId, updatedClaims);
    }

    const result = {
      success: true,
      userId,
      githubUsername,
      repoConfig,
      message: `Successfully revoked ${githubUsername} access to ${repoConfig.owner}/${repoConfig.repo}`,
    };

    return res.status(200).json(result);
  } catch (error) {
    throw handleError(error);
  }
}
