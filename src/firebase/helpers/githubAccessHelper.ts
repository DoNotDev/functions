// packages/functions/src/firebase/helpers/githubAccessHelper.ts

/**
 * @fileoverview GitHub Access Helper Functions
 * @description Helper functions that can be called directly without Firebase Function wrapper
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import { logger } from 'firebase-functions/v2';

import {
  getFirebaseAdminAuth,
  getFirebaseAdminFirestore,
} from '@donotdev/firebase/server';

import { handleError } from '../../shared/errorHandling.js';
import { GitHubApiService } from '../../shared/index.js';

/**
 * Grant GitHub repository access to a user (helper function)
 * Can be called directly from other functions
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export async function grantGitHubAccessHelper(
  userId: string,
  githubUsername: string,
  repoConfig: { owner: string; repo: string },
  permission: 'pull' | 'triage' | 'push' | 'maintain' | 'admin' = 'pull',
  customClaims?: Record<string, any>
): Promise<void> {
  // Get GitHub Personal Access Token
  const githubToken = process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
  if (!githubToken) {
    throw handleError(new Error('GitHub Personal Access Token not configured'));
  }

  // Create GitHub API service
  const githubApi = new GitHubApiService({ accessToken: githubToken });

  // Check if user is already a collaborator
  const isAlreadyCollaborator = await githubApi.isCollaborator(
    repoConfig.owner,
    repoConfig.repo,
    githubUsername
  );

  if (!isAlreadyCollaborator) {
    // Add user as collaborator
    await githubApi.addCollaborator({
      owner: repoConfig.owner,
      repo: repoConfig.repo,
      username: githubUsername,
      permission,
    });
  }

  // Update custom claims if provided
  if (customClaims) {
    const user = await getFirebaseAdminAuth().getUser(userId);
    const currentClaims = user.customClaims || {};

    await getFirebaseAdminAuth().setCustomUserClaims(userId, {
      ...currentClaims,
      ...customClaims,
      githubAccess: true,
      githubUsername,
      githubRepoAccess: {
        owner: repoConfig.owner,
        repo: repoConfig.repo,
        permission,
        grantedAt: new Date().toISOString(),
      },
    });
  }

  // Save to Firestore for redundancy
  if (process.env.SAVE_GITHUB_ACCESS_TO_FIRESTORE === 'true') {
    const db = getFirebaseAdminFirestore();
    await db.collection('githubAccess').doc(userId).set(
      {
        githubUsername,
        repoConfig,
        permission,
        accessGranted: true,
        grantedAt: Date.now(),
      },
      { merge: true }
    );
  }

  logger.info('GitHub repository access granted', {
    userId,
    githubUsername,
    repoConfig,
    permission,
  });
}

/**
 * Get custom claims for a user (helper function)
 * Can be called directly from other functions
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export async function getCustomClaimsHelper(
  userId: string,
  claimKeys?: string[]
): Promise<Record<string, any>> {
  // Get user and claims
  const user = await getFirebaseAdminAuth().getUser(userId);
  const allClaims = user.customClaims || {};

  // Filter claims if specific keys requested
  const requestedClaims = claimKeys
    ? Object.fromEntries(
        claimKeys
          .filter((key) => key in allClaims)
          .map((key) => [key, allClaims[key]])
      )
    : allClaims;

  return requestedClaims;
}

/**
 * Set custom claims for a user (helper function)
 * Can be called directly from other functions
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export async function setCustomClaimsHelper(
  userId: string,
  claims: Record<string, any>,
  merge: boolean = true
): Promise<void> {
  // Get current claims if merging
  let currentClaims = {};
  if (merge) {
    try {
      const user = await getFirebaseAdminAuth().getUser(userId);
      currentClaims = user.customClaims || {};
    } catch (error) {
      logger.warn('Could not fetch current claims for user', { userId, error });
    }
  }

  // Merge or replace claims
  const newClaims = merge ? { ...currentClaims, ...claims } : claims;

  // Set custom claims
  await getFirebaseAdminAuth().setCustomUserClaims(userId, newClaims);

  // Optionally save to Firestore for redundancy
  if (process.env.SAVE_CLAIMS_TO_FIRESTORE === 'true') {
    const db = getFirebaseAdminFirestore();
    await db.collection('userClaims').doc(userId).set(
      {
        claims: newClaims,
        updatedAt: new Date().toISOString(),
      },
      { merge: true }
    );
  }

  logger.info('Custom claims updated', {
    userId,
    claimKeys: Object.keys(claims),
  });
}
