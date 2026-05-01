// packages/functions/src/shared/github.ts

/**
 * @fileoverview GitHub API Service for functions
 * @description Server-safe GitHub API utilities for repository management
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

/** Configuration for authenticating with the GitHub API. */
export interface GitHubApiConfig {
  accessToken: string;
  baseUrl?: string;
}

/** GitHub user profile returned by the API. */
export interface GitHubUser {
  id: number;
  login: string;
  email: string;
  name?: string;
  avatar_url: string;
}

/** GitHub repository metadata returned by the API. */
export interface GitHubRepository {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  owner: {
    login: string;
    id: number;
  };
}

/** Request payload for adding a collaborator to a GitHub repository. */
export interface AddCollaboratorRequest {
  owner: string;
  repo: string;
  username: string;
  permission?: 'pull' | 'triage' | 'push' | 'maintain' | 'admin';
}

/** Error response structure from the GitHub API. */
export interface GitHubApiError {
  message: string;
  documentation_url?: string;
  status?: number;
}

/** Pattern for valid GitHub usernames, org names, repo names, and team slugs */
const SAFE_GITHUB_NAME = /^[a-zA-Z0-9_.-]+$/;

/** Validate a GitHub name (username, owner, repo, team slug) against path injection */
function validateGitHubName(name: string, label: string): void {
  if (!SAFE_GITHUB_NAME.test(name)) {
    throw new Error(
      `Invalid ${label}: must contain only alphanumeric, hyphens, underscores, and dots`
    );
  }
}

/**
 * GitHub API Service for server-side operations
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export class GitHubApiService {
  private config: GitHubApiConfig;

  constructor(config: GitHubApiConfig) {
    this.config = {
      baseUrl: 'https://api.github.com',
      ...config,
    };
  }

  /**
   * Get the current authenticated user
   *
   * @version 0.1.0
   * @since 0.0.1
   * @author AMBROISE PARK Consulting
   */
  async getCurrentUser(): Promise<GitHubUser> {
    const response = await this.request<GitHubUser>('/user');
    return response;
  }

  /**
   * Get user repositories
   *
   * @version 0.1.0
   * @since 0.0.1
   * @author AMBROISE PARK Consulting
   */
  async getUserRepositories(username?: string): Promise<GitHubRepository[]> {
    if (username) {
      validateGitHubName(username, 'username');
    }
    const endpoint = username ? `/users/${username}/repos` : '/user/repos';
    const response = await this.request<GitHubRepository[]>(endpoint);
    return response;
  }

  /**
   * Add a collaborator to a repository
   *
   * @version 0.1.0
   * @since 0.0.1
   * @author AMBROISE PARK Consulting
   */
  async addCollaborator(request: AddCollaboratorRequest): Promise<boolean> {
    validateGitHubName(request.owner, 'owner');
    validateGitHubName(request.repo, 'repo');
    validateGitHubName(request.username, 'username');
    try {
      await this.request(
        `/repos/${request.owner}/${request.repo}/collaborators/${request.username}`,
        {
          method: 'PUT',
          body: JSON.stringify({
            permission: request.permission || 'push',
          }),
        }
      );
      return true;
    } catch (error) {
      console.error('Failed to add collaborator:', error);
      return false;
    }
  }

  /**
   * Check if a user is a collaborator on a repository
   * Uses GitHub's direct API endpoint for efficiency
   *
   * @version 0.1.0
   * @since 0.0.1
   * @author AMBROISE PARK Consulting
   */
  async isCollaborator(
    owner: string,
    repo: string,
    username: string
  ): Promise<boolean> {
    validateGitHubName(owner, 'owner');
    validateGitHubName(repo, 'repo');
    validateGitHubName(username, 'username');
    try {
      // GitHub returns 204 if user is collaborator, 404 if not
      await this.request(`/repos/${owner}/${repo}/collaborators/${username}`, {
        method: 'GET',
      });
      return true;
    } catch (error: any) {
      if (error.message?.includes('404')) {
        return false;
      }
      console.error('Failed to check collaborator status:', error);
      return false;
    }
  }

  /**
   * Remove a collaborator from a repository
   *
   * @version 0.1.0
   * @since 0.0.1
   * @author AMBROISE PARK Consulting
   */
  async removeCollaborator(
    owner: string,
    repo: string,
    username: string
  ): Promise<boolean> {
    validateGitHubName(owner, 'owner');
    validateGitHubName(repo, 'repo');
    validateGitHubName(username, 'username');
    try {
      await this.request(`/repos/${owner}/${repo}/collaborators/${username}`, {
        method: 'DELETE',
      });
      return true;
    } catch (error) {
      console.error('Failed to remove collaborator:', error);
      return false;
    }
  }

  /**
   * Add a user to an organization team
   *
   * @version 0.1.0
   * @since 0.0.1
   * @author AMBROISE PARK Consulting
   */
  async addTeamMember(
    org: string,
    teamSlug: string,
    username: string,
    role: 'member' | 'maintainer' = 'member'
  ): Promise<boolean> {
    validateGitHubName(org, 'org');
    validateGitHubName(teamSlug, 'teamSlug');
    validateGitHubName(username, 'username');
    try {
      await this.request(
        `/orgs/${org}/teams/${teamSlug}/memberships/${username}`,
        {
          method: 'PUT',
          body: JSON.stringify({ role }),
        }
      );
      return true;
    } catch (error) {
      console.error('Failed to add team member:', error);
      return false;
    }
  }

  /**
   * Remove a user from an organization team
   *
   * @version 0.1.0
   * @since 0.0.1
   * @author AMBROISE PARK Consulting
   */
  async removeTeamMember(
    org: string,
    teamSlug: string,
    username: string
  ): Promise<boolean> {
    validateGitHubName(org, 'org');
    validateGitHubName(teamSlug, 'teamSlug');
    validateGitHubName(username, 'username');
    try {
      await this.request(
        `/orgs/${org}/teams/${teamSlug}/memberships/${username}`,
        {
          method: 'DELETE',
        }
      );
      return true;
    } catch (error) {
      console.error('Failed to remove team member:', error);
      return false;
    }
  }

  /**
   * Check if a user is a member of an organization team
   *
   * @version 0.1.0
   * @since 0.0.1
   * @author AMBROISE PARK Consulting
   */
  async isTeamMember(
    org: string,
    teamSlug: string,
    username: string
  ): Promise<boolean> {
    validateGitHubName(org, 'org');
    validateGitHubName(teamSlug, 'teamSlug');
    validateGitHubName(username, 'username');
    try {
      await this.request(
        `/orgs/${org}/teams/${teamSlug}/memberships/${username}`,
        {
          method: 'GET',
        }
      );
      return true;
    } catch (error: any) {
      if (error.message?.includes('404')) {
        return false;
      }
      console.error('Failed to check team membership:', error);
      return false;
    }
  }

  /**
   * Make an authenticated request to the GitHub API
   *
   * @version 0.1.0
   * @since 0.0.1
   * @author AMBROISE PARK Consulting
   */
  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const url = `${this.config.baseUrl}${endpoint}`;

    const response = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.config.accessToken}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'DoNotDev-Functions',
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    if (!response.ok) {
      const errorData = (await response.json().catch(() => ({}))) as any;
      const error: GitHubApiError = {
        message:
          errorData.message ||
          `HTTP ${response.status}: ${response.statusText}`,
        documentation_url: errorData.documentation_url,
        status: response.status,
      };
      throw new Error(`GitHub API Error: ${error.message}`);
    }

    return response.json() as Promise<T>;
  }
}

/**
 * Create a GitHub API service instance
 */
export function createGitHubApiService(accessToken: string): GitHubApiService {
  return new GitHubApiService({ accessToken });
}
