/** Validates shared session envelopes against the shared-session-1 wire schema in `schema/`. */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const SCHEMA_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..', 'schema');

let validator: ValidateFunction | undefined;

function compiled(): ValidateFunction {
  if (validator === undefined) {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats.default(ajv);
    const schema = JSON.parse(readFileSync(path.join(SCHEMA_ROOT, 'shared-session-1.schema.json'), 'utf8')) as Record<string, unknown>;
    validator = ajv.compile(schema);
  }
  return validator;
}

/** Asserts the document is schema-valid shared-session-1; throws with details otherwise. */
export function assertValidSharedSessionEnvelope(document: unknown): void {
  if (!(compiled()(document) as boolean)) {
    throw new Error(`shared-session-1 schema violation:\n${JSON.stringify(compiled().errors, null, 2)}`);
  }
}
