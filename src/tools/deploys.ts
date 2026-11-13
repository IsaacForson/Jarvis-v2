import { exec } from './exec.ts';

export type Failure = { id: string; text: string; at: number };
type Run = { databaseId: number; workflowName: string; conclusion: string; headBranch: string; createdAt: string };
type Deployment = { id: number; environment: string; created_at: string; statuses_url: string };

const DAY = 24 * 60 * 60_000;
const gh = async <T>(args: string[]): Promise<T> => JSON.parse(await exec('gh', args, { timeoutMs: 20_000 })) as T;

/**
 * Failed GitHub Actions runs and failed deployments (as Vercel, Netlify and others report them to
 * GitHub) in the user's repositories pushed to in the last week. Uses the gh command, signed in.
 */
export async function recentFailures(now = Date.now()): Promise<Failure[]> {
  const repos = (await gh<{ nameWithOwner: string; pushedAt: string }[]>(['repo', 'list', '--limit', '20', '--json', 'nameWithOwner,pushedAt']))
    .filter((repo) => now - new Date(repo.pushedAt).getTime() < 7 * DAY)
    .slice(0, 5);
  const found = await Promise.all(
    repos.map(async ({ nameWithOwner: repo }) => {
      const name = repo.split('/')[1] ?? repo;
      const runs = await gh<Run[]>(['run', 'list', '-R', repo, '--limit', '5', '--json', 'databaseId,workflowName,conclusion,headBranch,createdAt']).catch(() => []);
      const failedRuns = runs
        .filter((run) => ['failure', 'timed_out', 'startup_failure'].includes(run.conclusion))
        .map((run) => ({ id: `run ${run.databaseId}`, text: `the ${run.workflowName} run on ${name}, branch ${run.headBranch}, failed`, at: new Date(run.createdAt).getTime() }));
      const deployments = await gh<Deployment[]>(['api', `repos/${repo}/deployments?per_page=3`]).catch(() => []);
      const failedDeploys = await Promise.all(
        deployments.map(async (deployment) => {
          const [latest] = await gh<{ state: string }[]>(['api', `${deployment.statuses_url.replace('https://api.github.com/', '')}?per_page=1`]).catch(() => []);
          return latest && (latest.state === 'failure' || latest.state === 'error')
            ? [{ id: `deploy ${deployment.id}`, text: `the ${deployment.environment} deployment of ${name} failed`, at: new Date(deployment.created_at).getTime() }]
            : [];
        }),
      );
      return [...failedRuns, ...failedDeploys.flat()];
    }),
  );
  return found.flat();
}
