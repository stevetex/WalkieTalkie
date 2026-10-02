// A small JSON Schema (draft 2020-12) checker for the contract tests, so the server stays free
// of dependencies. It covers the keywords contracts/schemas use: type, enum, const, properties,
// required, additionalProperties, items, minItems, maxItems, minProperties, minimum, minLength,
// maxLength, pattern, oneOf, anyOf, allOf, not, if/then, and $ref within or across files.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

type Schema = Record<string, unknown> | boolean;

export class SchemaSet {
  private files = new Map<string, Record<string, unknown>>();

  constructor(dir: string) {
    for (const name of readdirSync(dir).filter((f) => f.endsWith(".schema.json"))) {
      this.files.set(name, JSON.parse(readFileSync(join(dir, name), "utf8")));
    }
  }

  get names(): string[] {
    return [...this.files.keys()];
  }

  // The problems with `value`, as "path: what" lines; none means it's valid.
  validate(file: string, value: unknown): string[] {
    const root = this.files.get(file);
    if (!root) throw new Error(`no schema ${file}`);
    const errors: string[] = [];
    this.check(root, value, "$", file, errors);
    return errors;
  }

  private resolve(ref: string, base: string): { schema: Schema; base: string } {
    const [file, pointer = ""] = ref.split("#");
    const target = file || base;
    let node: unknown = this.files.get(target);
    if (node === undefined) throw new Error(`unresolved $ref ${ref} from ${base}`);
    for (const part of pointer.split("/").filter(Boolean)) node = (node as Record<string, unknown>)[part];
    if (node === undefined) throw new Error(`unresolved $ref ${ref} from ${base}`);
    return { schema: node as Schema, base: target };
  }

  private check(schema: Schema, value: unknown, path: string, base: string, errors: string[]): void {
    if (schema === true) return;
    if (schema === false) return void errors.push(`${path}: not allowed`);
    const s = schema;
    if (typeof s.$ref === "string") {
      const { schema: target, base: targetBase } = this.resolve(s.$ref, base);
      this.check(target, value, path, targetBase, errors);
    }
    if (s.type !== undefined) {
      const types = Array.isArray(s.type) ? s.type : [s.type];
      if (!types.some((t) => isType(value, t as string))) return void errors.push(`${path}: expected ${types.join(" or ")}`);
    }
    if (s.enum !== undefined && !(s.enum as unknown[]).some((e) => same(e, value))) errors.push(`${path}: ${JSON.stringify(value)} isn't one of ${JSON.stringify(s.enum)}`);
    if (s.const !== undefined && !same(s.const, value)) errors.push(`${path}: expected ${JSON.stringify(s.const)}`);
    if (typeof value === "string") {
      if (typeof s.minLength === "number" && [...value].length < s.minLength) errors.push(`${path}: shorter than ${s.minLength}`);
      if (typeof s.maxLength === "number" && [...value].length > s.maxLength) errors.push(`${path}: longer than ${s.maxLength}`);
      if (typeof s.pattern === "string" && !new RegExp(s.pattern, "u").test(value)) errors.push(`${path}: doesn't match ${s.pattern}`);
    }
    if (typeof value === "number" && typeof s.minimum === "number" && value < s.minimum) errors.push(`${path}: below ${s.minimum}`);
    if (Array.isArray(value)) {
      if (typeof s.minItems === "number" && value.length < s.minItems) errors.push(`${path}: fewer than ${s.minItems} items`);
      if (typeof s.maxItems === "number" && value.length > s.maxItems) errors.push(`${path}: more than ${s.maxItems} items`);
      if (s.items !== undefined) value.forEach((item, i) => this.check(s.items as Schema, item, `${path}[${i}]`, base, errors));
    }
    if (isType(value, "object")) {
      const object = value as Record<string, unknown>;
      const properties = (s.properties ?? {}) as Record<string, Schema>;
      for (const key of (s.required ?? []) as string[]) if (!(key in object)) errors.push(`${path}: missing ${key}`);
      if (typeof s.minProperties === "number" && Object.keys(object).length < s.minProperties) errors.push(`${path}: fewer than ${s.minProperties} properties`);
      for (const [key, v] of Object.entries(object)) {
        if (key in properties) this.check(properties[key], v, `${path}.${key}`, base, errors);
        else if (s.additionalProperties !== undefined) this.check(s.additionalProperties as Schema, v, `${path}.${key}`, base, errors);
      }
    }
    const passes = (sub: Schema) => {
      const e: string[] = [];
      this.check(sub, value, path, base, e);
      return e.length === 0;
    };
    if (s.allOf) for (const sub of s.allOf as Schema[]) this.check(sub, value, path, base, errors);
    if (s.anyOf && !(s.anyOf as Schema[]).some(passes)) errors.push(`${path}: matches none of anyOf`);
    if (s.oneOf) {
      const matched = (s.oneOf as Schema[]).filter(passes).length;
      if (matched !== 1) errors.push(`${path}: matches ${matched} of oneOf, not exactly 1`);
    }
    if (s.not !== undefined && passes(s.not as Schema)) errors.push(`${path}: matches a forbidden shape`);
    if (s.if !== undefined && passes(s.if as Schema) && s.then !== undefined) this.check(s.then as Schema, value, path, base, errors);
  }
}

function isType(value: unknown, type: string): boolean {
  switch (type) {
    case "object": return typeof value === "object" && value !== null && !Array.isArray(value);
    case "array": return Array.isArray(value);
    case "string": return typeof value === "string";
    case "integer": return Number.isInteger(value);
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "boolean": return typeof value === "boolean";
    case "null": return value === null;
    default: throw new Error(`unknown type ${type}`);
  }
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
