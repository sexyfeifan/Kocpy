export interface SourceTreeIssue {
  path: string;
  issue: string;
}

export function sourceTreeIssue(name: string): string | null;
export function findSourceTreeIssues(root?: string): Promise<SourceTreeIssue[]>;
export function verifySourceTree(root?: string): Promise<SourceTreeIssue[]>;
