/**
 * The three job tools the gateway serves itself: queue test files, then poll
 * the job and read its report. Every argument object is closed; a field the
 * schema does not name is refused before it reaches the job store.
 */

import type { Tool } from '@modelcontextprotocol/server';
import { ConfigurationError } from '../../internal/errors.ts';
import { MAX_IPC_FILES } from '../../run/dynamic-ipc.ts';
import { textResult, type McpToolResult } from '../tools.ts';
import type { HttpMcpToken } from './config.ts';
import type { JobService, JobSubmission } from './jobs.ts';

const MAX_TARGET_CHARS = 200;
const MAX_KEY_CHARS = 200;

const RUN_TEST_SCHEMA: Tool = {
  name: 'run_test',
  description:
    'Queue test files from the configured project on one target and return a job id at once. The files are collected and then run on the target\'s current run; calls made while it runs join the same run. Poll get_test_status, then read get_test_report. Repeating an idempotencyKey returns the first job instead of queueing another. CAPACITY_EXCEEDED means the gateway or the run is full; retry after a job finishes.',
  inputSchema: {
    type: 'object',
    properties: {
      targetId: { type: 'string', maxLength: MAX_TARGET_CHARS, description: 'A target the project config declares.' },
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
    required: ['targetId', 'testFiles'],
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

/** The three job tools, in the order a client lists them. */
export const JOB_TOOL_DEFINITIONS: readonly Tool[] = [RUN_TEST_SCHEMA, GET_TEST_STATUS_SCHEMA, GET_TEST_REPORT_SCHEMA];

/** Runs one job tool; a thrown classified error becomes its error result. */
export async function callJobTool(
  jobs: JobService,
  token: HttpMcpToken,
  name: string,
  args: unknown,
): Promise<McpToolResult> {
  switch (name) {
    case 'run_test':
      return textResult(JSON.stringify(await jobs.submit(token, parseRunTest(args)), null, 2));
    case 'get_test_status':
      return textResult(JSON.stringify(jobs.status(token, parseJobId(args, name)), null, 2));
    case 'get_test_report':
      return textResult(JSON.stringify(jobs.report(token, parseJobId(args, name)), null, 2));
    default:
      throw new ConfigurationError('INVALID_ARGUMENT', `"${name}" is not a job tool`);
  }
}

/** `run_test` arguments: one target and one to fifty project-relative files. */
function parseRunTest(value: unknown): JobSubmission {
  const args = closed(value, ['targetId', 'testFiles', 'idempotencyKey'], 'run_test');
  const targetId = args['targetId'];
  if (typeof targetId !== 'string' || targetId === '') throw invalid('run_test needs targetId as a non-empty string');
  const files = args['testFiles'];
  if (!Array.isArray(files) || files.length === 0 || files.length > MAX_IPC_FILES) {
    throw invalid(`run_test needs testFiles as an array of one to ${MAX_IPC_FILES} strings`);
  }
  if (!files.every((file) => typeof file === 'string')) throw invalid('run_test needs testFiles as an array of strings');
  const key = args['idempotencyKey'];
  if (key !== undefined && (typeof key !== 'string' || key === '')) throw invalid('run_test needs idempotencyKey as a non-empty string when given');
  return {
    targetId,
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
