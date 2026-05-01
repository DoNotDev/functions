// packages/functions/src/firebase/helpers/githubTeamAccessHelper.ts

/**
 * @fileoverview GitHub Team Access Helper Functions
 * @description Helper functions for managing GitHub team memberships
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import { logger } from 'firebase-functions/v2';

import { getFirebaseAdminAuth } from '@donotdev/firebase/server';

import { handleError } from '../../shared/errorHandling.js';
import { GitHubApiService } from '../../shared/index.js';

/**
 * Grant GitHub team access to a user (helper function)
 * Can be called directly from other functions
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export async function grantGitHubTeamAccessHelper(
  userId: string,
  githubUsername: string,
  teamConfig: { org: string; team: string },
  role: 'member' | 'maintainer' = 'member'
): Promise<void> {
  try {
    // Get GitHub Personal Access Token
    const githubToken = process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
    if (!githubToken) {
      throw new Error('GitHub Personal Access Token not configured');
    }

    // Create GitHub API service
    const githubApi = new GitHubApiService({ accessToken: githubToken });

    // Check if user is already a team member
    const isAlreadyMember = await githubApi.isTeamMember(
      teamConfig.org,
      teamConfig.team,
      githubUsername
    );

    if (!isAlreadyMember) {
      // Add user to team
      const success = await githubApi.addTeamMember(
        teamConfig.org,
        teamConfig.team,
        githubUsername,
        role
      );

      if (!success) {
        throw new Error(
          `Failed to add ${githubUsername} to team ${teamConfig.org}/${teamConfig.team}`
        );
      }
    }

    // Update custom claims
    const user = await getFirebaseAdminAuth().getUser(userId);
    const currentClaims = user.customClaims || {};

    const updatedClaims = {
      ...currentClaims,
      githubTeamAccess: {
        ...currentClaims.githubTeamAccess,
        [teamConfig.org]: {
          ...currentClaims.githubTeamAccess?.[teamConfig.org],
          [teamConfig.team]: {
            username: githubUsername,
            role,
            grantedAt: new Date().toISOString(),
          },
        },
      },
    };

    await getFirebaseAdminAuth().setCustomUserClaims(userId, updatedClaims);

    logger.info('GitHub team access granted', {
      userId,
      githubUsername,
      teamConfig,
      role,
    });
  } catch (error) {
    logger.error('Failed to grant GitHub team access', {
      userId,
      githubUsername,
      teamConfig,
      error: error instanceof Error ? error.message : String(error),
    });
    throw handleError(error);
  }
}

/**
 * Revoke GitHub team access from a user (helper function)
 * Can be called directly from other functions
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export async function revokeGitHubTeamAccessHelper(
  userId: string,
  githubUsername: string,
  teamConfig: { org: string; team: string }
): Promise<void> {
  try {
    // Get GitHub Personal Access Token
    const githubToken = process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
    if (!githubToken) {
      throw new Error('GitHub Personal Access Token not configured');
    }

    // Create GitHub API service
    const githubApi = new GitHubApiService({ accessToken: githubToken });

    // Check if user is a team member
    const isMember = await githubApi.isTeamMember(
      teamConfig.org,
      teamConfig.team,
      githubUsername
    );

    if (isMember) {
      // Remove user from team
      const success = await githubApi.removeTeamMember(
        teamConfig.org,
        teamConfig.team,
        githubUsername
      );

      if (!success) {
        logger.warn(
          `Failed to remove ${githubUsername} from team ${teamConfig.org}/${teamConfig.team}`
        );
      }
    }

    // Update custom claims - remove team access
    const user = await getFirebaseAdminAuth().getUser(userId);
    const currentClaims = user.customClaims || {};

    if (currentClaims.githubTeamAccess?.[teamConfig.org]?.[teamConfig.team]) {
      const updatedClaims = { ...currentClaims };

      // Remove the specific team access
      if (updatedClaims.githubTeamAccess[teamConfig.org]) {
        delete updatedClaims.githubTeamAccess[teamConfig.org][teamConfig.team];

        // If no teams left for this org, remove the org entry
        if (
          Object.keys(updatedClaims.githubTeamAccess[teamConfig.org]).length ===
          0
        ) {
          delete updatedClaims.githubTeamAccess[teamConfig.org];
        }
      }

      await getFirebaseAdminAuth().setCustomUserClaims(userId, updatedClaims);
    }

    logger.info('GitHub team access revoked', {
      userId,
      githubUsername,
      teamConfig,
    });
  } catch (error) {
    logger.error('Failed to revoke GitHub team access', {
      userId,
      githubUsername,
      teamConfig,
      error: error instanceof Error ? error.message : String(error),
    });
    throw handleError(error);
  }
}

/**
 * Check GitHub team access for a user (helper function)
 * Can be called directly from other functions
 */
export async function checkGitHubTeamAccessHelper(
  userId: string,
  githubUsername: string,
  teamConfig: { org: string; team: string }
): Promise<{
  hasTeamAccess: boolean;
  hasCustomClaimsAccess: boolean;
  accessDetails: any;
}> {
  try {
    // Get GitHub Personal Access Token
    const githubToken = process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
    if (!githubToken) {
      throw new Error('GitHub Personal Access Token not configured');
    }

    // Create GitHub API service
    const githubApi = new GitHubApiService({ accessToken: githubToken });

    // Check if user is a team member on GitHub
    const hasTeamAccess = await githubApi.isTeamMember(
      teamConfig.org,
      teamConfig.team,
      githubUsername
    );

    // Check custom claims
    const user = await getFirebaseAdminAuth().getUser(userId);
    const currentClaims = user.customClaims || {};
    const teamAccess =
      currentClaims.githubTeamAccess?.[teamConfig.org]?.[teamConfig.team];

    return {
      hasTeamAccess,
      hasCustomClaimsAccess: !!teamAccess,
      accessDetails: teamAccess || null,
    };
  } catch (error) {
    logger.error('Failed to check GitHub team access', {
      userId,
      githubUsername,
      teamConfig,
      error: error instanceof Error ? error.message : String(error),
    });
    throw handleError(error);
  }
}
