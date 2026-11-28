export const APPROVAL_FAILURE = 'This step was not run because the approval check failed. Do not retry or reword it. Report the failure; an admin must resolve it.';
export const APPROVAL_WORKER = 'This step was not run. Subagents and background sessions need an admin to run approval-needing work on the main loop. Do not retry or reword it. Say that an admin is needed in your report.';
export const APPROVAL_TIMEOUT = 'This step was not run because nobody answered the approval prompt within 60 seconds. Do not retry or reword it; ask an admin to request it again.';
