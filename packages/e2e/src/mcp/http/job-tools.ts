/**
 * The four job tools the gateway serves itself: queue test files, then poll
 * the job, read its report, and list its artifacts. Every argument object is
 * closed; a field the schema does not name is refused before it reaches the
 * job store.
 */

import { ConfigurationError } from '@e2e-dev/core/lib/internal/errors';
import type { Tool } from '@modelcontextprotocol/server';
import { MAX_IPC_FILES } from '../../run/dynamic-ipc.ts';
import { textResult, type McpToolResult } from '../tools.ts';
import type { HttpMcpToken } from './config.ts';
import type { JobService, JobSubmission } from './jobs.ts';

const MAX_TARGET_CHARS = 200;
const MAX_KEY_CHARS = 200;

const RUN_TEST_SCHEMA: Tool = {
  name: 'run_test',
  description:
    'Queue test files from the configured project on one target and return a job id at once. Name the target with targetId, or with accountDescription: the business words of one account pool account, where every word must occur in its description and exactly one enabled account must match. The files are collected and then run on the target\'s current run; calls made while it runs join the same run. Poll get_test_status, then read get_test_report. Repeating an idempotencyKey returns the first job instead of queueing another. CAPACITY_EXCEEDED means the gateway or the run is full; retry after a job finishes.',
  inputSchema: {
    type: 'object',
    properties: {
      targetId: { type: 'string', maxLength: MAX_TARGET_CHARS, description: 'A target the project config declares; cannot be combined with accountDescription.' },
      accountDescription: {
        type: 'string',
        maxLength: MAX_TARGET_CHARS,
        description: 'Words selecting one enabled account pool account; cannot be combined with targetId.',
      },
      testFiles: {
        type: 'array',
        maxItems: MAX_IPC_FILES,
        minItems: 1,
        items: { type: 'string' },
        description: 'Project-relative test file paths, one to fifty.',
      },
      idempotencyKey: {
        type: 'string',
        maxLength: MAX_KEY_CHARS,
        description: 'A client-chosen key: the same key and request returns the same job.',
      },
    },
    required: ['testFiles'],
    additionalProperties: false,
  },
  // Collection and the tests import and run project code.
  annotations: { readOnlyHint: false },
};

const GET_TEST_STATUS_SCHEMA: Tool = {
  name: 'get_test_status',
  description: 'Read one job\'s state, result counts, and its error when it did not pass.',
  inputSchema: {
    type: 'object',
    properties: {
      jobId: { type: 'string', maxLength: MAX_KEY_CHARS, description: 'The job id run_test returned.' },
    },
    required: ['jobId'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
};

const GET_TEST_REPORT_SCHEMA: Tool = {
  name: 'get_test_report',
  description: 'Read one job\'s per-test results, bounded failure evidence, and artifact kinds. Paths on disk are not included.',
  inputSchema: {
    type: 'object',
    properties: {
      jobId: { type: 'string', maxLength: MAX_KEY_CHARS, description: 'The job id run_test returned.' },
    },
    required: ['jobId'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
};

const LIST_TEST_ARTIFACTS_SCHEMA: Tool = {
  name: 'list_test_artifacts',
  description:
    'List the artifacts a finished job kept, with an authenticated download URL for each local file. Poll it while ready is false: a job\'s artifacts appear after its run ends. Once ready is true the listing is final, including its error, if any. Argument: jobId.',
  inputSchema: {
    type: 'object',
    properties: {
      jobId: { type: 'string', maxLength: MAX_KEY_CHARS, description: 'The job id run_test returned.' },
    },
    required: ['jobId'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
};

/** The four job tools, in the order a client lists them. */
export const JOB_TOOL_DEFINITIONS: readonly Tool[] = [
  RUN_TEST_SCHEMA,
  GET_TEST_STATUS_SCHEMA,
  GET_TEST_REPORT_SCHEMA,
  LIST_TEST_ARTIFACTS_SCHEMA,
];

/** Runs one job tool; a thrown classified error becomes its error result. */
export async function callJobTool(
  jobs: JobService,
  token: HttpMcpToken,
  name: string,
  args: unknown,
  baseUrl: string,
): Promise<McpToolResult> {
  switch (name) {
    case 'run_test':
      return textResult(JSON.stringify(await jobs.submit(token, parseRunTest(args)), null, 2));
    case 'get_test_status':
      return textResult(JSON.stringify(jobs.status(token, parseJobId(args, name)), null, 2));
    case 'get_test_report':
      return textResult(JSON.stringify(jobs.report(token, parseJobId(args, name)), null, 2));
    case 'list_test_artifacts':
      return textResult(JSON.stringify(await jobs.artifacts(token, parseJobId(args, name), baseUrl), null, 2));
    default:
      throw new ConfigurationError('INVALID_ARGUMENT', `"${name}" is not a job tool`);
  }
}

/** `run_test` arguments: one target or account description, and one to fifty project-relative files. */
function parseRunTest(value: unknown): JobSubmission {
  const args = closed(value, ['targetId', 'accountDescription', 'testFiles', 'idempotencyKey'], 'run_test');
  const targetId = args['targetId'];
  const accountDescription = args['accountDescription'];
  // Naming both is the conflict, whatever either value holds: an empty
  // description beside a target is still two selectors.
  if (targetId !== undefined && accountDescription !== undefined) {
    throw new ConfigurationError('ACCOUNT_SELECTION_CONFLICT', 'run_test takes targetId or accountDescription, not both');
  }
  if (targetId !== undefined && (typeof targetId !== 'string' || targetId === '')) {
    throw invalid('run_test needs targetId as a non-empty string when given');
  }
  if (accountDescription !== undefined && (typeof accountDescription !== 'string' || accountDescription.trim() === '')) {
    throw invalid('run_test needs accountDescription as a non-empty string when given');
  }
  if (targetId === undefined && accountDescription === undefined) {
    throw invalid('run_test needs targetId or accountDescription');
  }
  const files = args['testFiles'];
  if (!Array.isArray(files) || files.length === 0 || files.length > MAX_IPC_FILES) {
    throw invalid(`run_test needs testFiles as an array of one to ${MAX_IPC_FILES} strings`);
  }
  if (!files.every((file) => typeof file === 'string')) throw invalid('run_test needs testFiles as an array of strings');
  const key = args['idempotencyKey'];
  if (key !== undefined && (typeof key !== 'string' || key === '')) throw invalid('run_test needs idempotencyKey as a non-empty string when given');
  return {
    ...(targetId === undefined ? {} : { targetId }),
    ...(accountDescription === undefined ? {} : { accountDescription }),
    testFiles: files as string[],
    ...(key === undefined ? {} : { idempotencyKey: key }),
  };
}

/** `get_test_status` and `get_test_report` arguments: one job id. */
function parseJobId(value: unknown, tool: string): string {
  const args = closed(value, ['jobId'], tool);
  const jobId = args['jobId'];
  if (typeof jobId !== 'string' || jobId === '') throw invalid(`${tool} needs jobId as a non-empty string`);
  return jobId;
}

function closed(value: unknown, allowed: readonly string[], tool: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid(`${tool} arguments must be an object with ${allowed.join(', ')}`);
  }
  const args = value as Record<string, unknown>;
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) throw invalid(`${tool} does not take ${JSON.stringify(key)}; use ${allowed.join(', ')}`);
  }
  return args;
}

function invalid(message: string): ConfigurationError {
  return new ConfigurationError('INVALID_ARGUMENT', message);
}
