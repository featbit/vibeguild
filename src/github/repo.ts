/**
 * GitHub repo creation for task execution sandboxes.
 *
 * Each world task running in Docker mode gets a dedicated private repo
 * under the vibeguild org.  The sandbox agent pushes its execution
 * artifacts there; the world/ layer only records the URL.
 */

export type TaskRepoResult = {
  repoName: string;
  url: string;
  cloneUrl: string;
};

export type CreateTaskRepoOptions = {
  taskId: string;
  taskTitle: string;
  org: string;
  token: string;
};

export const createTaskRepo = async (opts: CreateTaskRepoOptions): Promise<TaskRepoResult> => {
  const repoName = `task-${opts.taskId.slice(0, 8)}`;
  const description = `Vibe Guild execution sandbox for: ${opts.taskTitle}`;

  const response = await fetch(`https://api.github.com/orgs/${opts.org}/repos`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${opts.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: repoName,
      description,
      private: true,
      auto_init: true,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub repo creation failed: ${response.status} — ${body}`);
  }

  const data = (await response.json()) as { html_url: string; clone_url: string; name: string };
  return { repoName: data.name, url: data.html_url, cloneUrl: data.clone_url };
};
