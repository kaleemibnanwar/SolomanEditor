/**
 * TOOL ARGUMENT VALIDATION.
 *
 * The MCP spec requires a server to validate every tool input, and an editing
 * agent gets much better errors this way: a wrong transition id or a negative
 * duration is rejected with the offending path and a list of the values that
 * would have worked, instead of silently producing a broken timeline.
 *
 * Implemented against the keywords declared in `protocol.ts`'s JsonSchema — the
 * two are a matched pair.
 */
import type { JsonSchema } from "@/lib/mcp/protocol";

/** One failure, addressed by its path in the argument object. */
export interface ValidationIssue {
  path: string;
  message: string;
}

const typeOf = (value: unknown): string => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
};

/** Does `value` satisfy the declared `type`? Integers also satisfy "number". */
function typeMatches(value: unknown, type: JsonSchema["type"]): boolean {
  const actual = typeOf(value);
  if (type === "number") return actual === "number" || actual === "integer";
  if (type === "integer") return actual === "integer";
  return actual === type;
}

const show = (value: unknown) => (typeof value === "string" ? `"${value}"` : JSON.stringify(value));

function validateInto(value: unknown, schema: JsonSchema, path: string, issues: ValidationIssue[]): void {
  if (schema.type && !typeMatches(value, schema.type)) {
    issues.push({ path, message: `expected ${schema.type}, got ${typeOf(value)}` });
    return;
  }

  if (schema.enum && !schema.enum.includes(value)) {
    issues.push({ path, message: `${show(value)} is not one of ${schema.enum.map(show).join(", ")}` });
    return;
  }

  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      issues.push({ path, message: `must be >= ${schema.minimum}` });
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      issues.push({ path, message: `must be <= ${schema.maximum}` });
    }
  }

  if (typeof value === "string" && schema.minLength !== undefined && value.length < schema.minLength) {
    issues.push({ path, message: `must be at least ${schema.minLength} characters` });
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      issues.push({ path, message: `needs at least ${schema.minItems} item(s)` });
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      issues.push({ path, message: `takes at most ${schema.maxItems} item(s)` });
    }
    if (schema.items) {
      value.forEach((item, i) => validateInto(item, schema.items as JsonSchema, `${path}[${i}]`, issues));
    }
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (record[key] === undefined) issues.push({ path: path ? `${path}.${key}` : key, message: "is required" });
    }
    for (const [key, child] of Object.entries(record)) {
      const childSchema = schema.properties?.[key];
      if (!childSchema) {
        if (schema.additionalProperties === false) {
          const known = Object.keys(schema.properties ?? {});
          issues.push({
            path: path ? `${path}.${key}` : key,
            message: `unknown argument${known.length ? ` — expected one of: ${known.join(", ")}` : ""}`,
          });
        }
        continue;
      }
      if (child === undefined) continue;
      validateInto(child, childSchema, path ? `${path}.${key}` : key, issues);
    }
  }
}

/** Every problem with `args` against `schema`. Empty means it is valid. */
export function validateArgs(args: unknown, schema: JsonSchema): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  validateInto(args ?? {}, schema, "", issues);
  return issues;
}

/** A single-line, agent-readable rendering of validation failures. */
export const formatIssues = (issues: ValidationIssue[]): string =>
  `Invalid arguments:\n${issues.map((i) => `  · ${i.path || "(root)"} ${i.message}`).join("\n")}`;
