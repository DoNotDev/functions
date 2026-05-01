// packages/functions/src/firebase/oauth/githubAccess.ts

/**
 * @fileoverview GitHub access Firebase function
 * @description Firebase callable function for managing GitHub access
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import { logger } from 'firebase-functions/v2';
import { onCall } from 'firebase-functions/v2/https';
import * as v from 'valibot';

import {
  grantGitHubAccessSchema,
  revokeGitHubAccessSchema,
  checkGitHubAccessSchema,
  type GrantGitHubAccessRequest,
  type RevokeGitHubAccessRequest,
  type CheckGitHubAccessRequest,
} from '@donotdev/core/server';
import { getFirebaseAdminAuth } from '@donotdev/firebase/server';

import { handleError } from '../../shared/errorHandling.js';
import { GitHubApiService } from '../../shared/index.js';
import { assertAuthenticated } from '../../shared/utils.js';
import { AUTH_CONFIG } from '../config/constants.js';
import { githubPersonalAccessToken } from '../config/secrets.js';

import type { CallableRequest } from 'firebase-functions/v2/https';
import type { CallableFunction } from 'firebase-functions/v2/https';

const OAUTH_CONFIG = {
  ...AUTH_CONFIG,
  secrets: [githubPersonalAccessToken],
};

/**
 * Internal function that accepts custom schema
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
async function grantGitHubAccessInternal(
  request: CallableRequest<GrantGitHubAccessRequest>,
  customSchema?: v.BaseSchema<
    unknown,
    GrantGitHubAccessRequest,
    v.BaseIssue<unknown>
  >
) {
  try {
    const uid = assertAuthenticated(request.auth);

    // Use provided schema or default to framework schema
    const schema = customSchema || grantGitHubAccessSchema;

    // Validate request data using the schema
    const validationResult = v.safeParse(schema, request.data);
    if (!validationResult.success) {
      throw new Error(
        `Validation failed: ${validationResult.issues.map((e) => e.message).join(', ')}`
      );
    }

    const validatedData = validationResult.output;
    const {
      githubUsername,
      repoConfig,
      permission = 'push',
      customClaims,
    } = validatedData;
    // W20: Enforce authenticated user ID — never trust client-supplied userId
    const userId = uid;

    // Get GitHub token
    const githubToken = githubPersonalAccessToken.value();
    if (!githubToken) {
      throw handleError(
        new Error('GitHub Personal Access Token not configured')
      );
    }

    // Initialize GitHub API service
    const githubApi = new GitHubApiService({ accessToken: githubToken });

    // Add collaborator to repository
    await githubApi.addCollaborator({
      owner: repoConfig.owner,
      repo: repoConfig.repo,
      username: githubUsername,
      permission: permission as
        | 'push'
        | 'pull'
        | 'triage'
        | 'maintain'
        | 'admin',
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

    logger.info('GitHub access granted', {
      userId: result.userId,
      githubUsername: result.githubUsername,
      repoConfig: result.repoConfig,
    });

    return result;
  } catch (error) {
    throw handleError(error);
  }
}

/**
 * Grant GitHub repository access to a user
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export const grantGitHubAccess: CallableFunction<
  GrantGitHubAccessRequest,
  Promise<any>
> = onCall<GrantGitHubAccessRequest>(
  OAUTH_CONFIG,
  async (request: CallableRequest<GrantGitHubAccessRequest>) => {
    return await grantGitHubAccessInternal(request);
  }
);

/**
 * Grant GitHub repository access with custom validation schema
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export async function grantGitHubAccessWithSchema(
  request: CallableRequest<GrantGitHubAccessRequest>,
  customSchema: v.BaseSchema<
    unknown,
    GrantGitHubAccessRequest,
    v.BaseIssue<unknown>
  >
) {
  return await grantGitHubAccessInternal(request, customSchema);
}

/**
 * Revoke GitHub repository access from a user
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
async function revokeGitHubAccessInternal(
  request: CallableRequest<RevokeGitHubAccessRequest>,
  customSchema?: v.BaseSchema<
    unknown,
    RevokeGitHubAccessRequest,
    v.BaseIssue<unknown>
  >
) {
  try {
    const uid = assertAuthenticated(request.auth);

    // Use provided schema or default to framework schema
    const schema = customSchema || revokeGitHubAccessSchema;

    // Validate request data using the schema
    const validationResult = v.safeParse(schema, request.data);
    if (!validationResult.success) {
      throw new Error(
        `Validation failed: ${validationResult.issues.map((e) => e.message).join(', ')}`
      );
    }

    const { githubUsername, repoConfig } = validationResult.output;
    // W20: Enforce authenticated user ID — never trust client-supplied userId
    const userId = uid;

    // Get GitHub token
    const githubToken = githubPersonalAccessToken.value();
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
      logger.warn(`Failed to remove ${githubUsername} from GitHub repository`);
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

    logger.info('GitHub access revoked', {
      userId: result.userId,
      githubUsername: result.githubUsername,
      repoConfig: result.repoConfig,
    });

    return result;
  } catch (error) {
    throw handleError(error);
  }
}

/**
 * Revoke GitHub repository access from a user
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export const revokeGitHubAccess: CallableFunction<
  RevokeGitHubAccessRequest,
  Promise<any>
> = onCall<RevokeGitHubAccessRequest>(
  OAUTH_CONFIG,
  async (request: CallableRequest<RevokeGitHubAccessRequest>) => {
    return await revokeGitHubAccessInternal(request);
  }
);

/**
 * Revoke GitHub repository access with custom validation schema
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export async function revokeGitHubAccessWithSchema(
  request: CallableRequest<RevokeGitHubAccessRequest>,
  customSchema: v.BaseSchema<
    unknown,
    RevokeGitHubAccessRequest,
    v.BaseIssue<unknown>
  >
) {
  return await revokeGitHubAccessInternal(request, customSchema);
}

/**
 * Check GitHub repository access for a user
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
async function checkGitHubAccessInternal(
  request: CallableRequest<CheckGitHubAccessRequest>,
  customSchema?: v.BaseSchema<
    unknown,
    CheckGitHubAccessRequest,
    v.BaseIssue<unknown>
  >
) {
  try {
    const uid = assertAuthenticated(request.auth);

    // Use provided schema or default to framework schema
    const schema = customSchema || checkGitHubAccessSchema;

    // Validate request data using the schema
    const validationResult = v.safeParse(schema, request.data);
    if (!validationResult.success) {
      throw new Error(
        `Validation failed: ${validationResult.issues.map((e) => e.message).join(', ')}`
      );
    }

    const { githubUsername, repoConfig } = validationResult.output;
    // W20: Enforce authenticated user ID — never trust client-supplied userId
    const userId = uid;

    // Get GitHub token
    const githubToken = githubPersonalAccessToken.value();
    if (!githubToken) {
      throw handleError(
        new Error('GitHub Personal Access Token not configured')
      );
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

    return result;
  } catch (error) {
    throw handleError(error);
  }
}

/**
 * Check GitHub repository access for a user
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export const checkGitHubAccess: CallableFunction<
  CheckGitHubAccessRequest,
  Promise<any>
> = onCall<CheckGitHubAccessRequest>(
  OAUTH_CONFIG,
  async (request: CallableRequest<CheckGitHubAccessRequest>) => {
    return await checkGitHubAccessInternal(request);
  }
);

/**
 * Check GitHub repository access with custom validation schema
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export async function checkGitHubAccessWithSchema(
  request: CallableRequest<CheckGitHubAccessRequest>,
  customSchema: v.BaseSchema<
    unknown,
    CheckGitHubAccessRequest,
    v.BaseIssue<unknown>
  >
) {
  return await checkGitHubAccessInternal(request, customSchema);
}
