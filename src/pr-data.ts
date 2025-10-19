export interface PullRequest {
    additions: number;
    assignees: Assignee[];
    author: Author;
    changedFiles: number;
    number: number;
    title: string;
    deletions: number;
    files: ChangedFile[];
    latestReviews: Review[];
    url: string;
}

export interface Author {
    id: string;
    is_bot: boolean;
    login: string;
    name: string;
}

export function isAuthorBot(author: Author): boolean {
    return author.is_bot;
}

export function authorToAssignee(author: Author): Assignee {
    return {
        id: author.id,
        login: author.login,
        name: author.name,
    };
}

export interface Assignee {
    id: string;
    login: string;
    name: string;
}

export interface Review {
    id: string;
    author: { login: string };
    state: "APPROVED" | "COMMENTED";
}

export interface ChangedFile {
    path: string;
    additions: number;
    deletions: number;
}
