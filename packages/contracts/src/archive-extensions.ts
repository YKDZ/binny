import * as z from "zod";

import { sourceAdapterIdSchema } from "./bin-configuration.ts";
import { postgresTextSchema } from "./postgres-text.ts";

/** Scalar JSON values that can be compared with a declared extension field. */
export const archiveExtensionScalarSchema = z.union([
  postgresTextSchema,
  z.number().finite(),
  z.boolean(),
]);

export const archiveExtensionFieldFilterSchema = z.discriminatedUnion("op", [
  z
    .object({ op: z.literal("eq"), value: archiveExtensionScalarSchema })
    .strict(),
  z
    .object({
      op: z.literal("in"),
      values: z.array(archiveExtensionScalarSchema).min(1).max(100),
    })
    .strict(),
  z
    .object({ op: z.literal("has"), value: archiveExtensionScalarSchema })
    .strict(),
  z
    .object({
      op: z.literal("hasAny"),
      values: z.array(archiveExtensionScalarSchema).min(1).max(100),
    })
    .strict(),
]);

const archiveExtensionFieldNameSchema = postgresTextSchema.min(1).max(128);

/** An explicit adapter scope and one controlled condition per extension field. */
export const archiveSearchExtensionsSchema = z
  .object({
    sourceAdapterId: sourceAdapterIdSchema,
    filters: z
      .record(
        archiveExtensionFieldNameSchema,
        archiveExtensionFieldFilterSchema,
      )
      .refine(
        (filters) =>
          Object.keys(filters).length > 0 && Object.keys(filters).length <= 32,
        "Provide between 1 and 32 extension field filters.",
      ),
  })
  .strict();

/**
 * Queryable field operations are derived from the property type in the saved
 * adapter extension schema. Optional or nullable fields do not match when the
 * archived value is absent or null.
 */
export const archiveExtensionFieldDiscoverySchema = z
  .object({
    type: z.enum([
      "string",
      "number",
      "integer",
      "boolean",
      "array",
      "object",
      "null",
      "unsupported",
    ]),
    nullable: z.boolean(),
    required: z.boolean(),
    description: postgresTextSchema.optional(),
    itemType: z.enum(["string", "number", "integer", "boolean"]).optional(),
    allowedValues: z.array(archiveExtensionScalarSchema).optional(),
    allowedItemValues: z.array(archiveExtensionScalarSchema).optional(),
    operations: z.array(z.enum(["eq", "in", "has", "hasAny"])),
  })
  .strict();

/** Return only the selected adapter's declared top-level extension fields. */
export const sourceAdapterExtensionFieldsDiscoverySchema = z
  .object({
    sourceAdapterId: sourceAdapterIdSchema,
    sourceAdapterVersion: postgresTextSchema.min(1),
    fields: z.record(
      archiveExtensionFieldNameSchema,
      archiveExtensionFieldDiscoverySchema,
    ),
  })
  .strict();

type JsonSchemaObject = Readonly<Record<string, unknown>>;
type ExtensionScalar = z.infer<typeof archiveExtensionScalarSchema>;
type ExtensionScalarType = "string" | "number" | "integer" | "boolean";

function isJsonSchemaObject(value: unknown): value is JsonSchemaObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extensionScalarType(value: unknown): ExtensionScalarType | undefined {
  return value === "string" ||
    value === "number" ||
    value === "integer" ||
    value === "boolean"
    ? value
    : undefined;
}

function extensionScalarValues(value: unknown): ExtensionScalar[] | undefined {
  const checked = z.array(archiveExtensionScalarSchema).safeParse(value);
  return checked.success ? checked.data : undefined;
}

type ExtensionFieldType = z.infer<
  typeof archiveExtensionFieldDiscoverySchema
>["type"];
type ExtensionFieldShape = {
  readonly type: ExtensionFieldType;
  readonly nullable: boolean;
  readonly itemType?: ExtensionScalarType;
  readonly allowedValues?: readonly ExtensionScalar[];
  readonly allowedItemValues?: readonly ExtensionScalar[];
};

function resolveJsonPointer(root: JsonSchemaObject, reference: string) {
  if (reference === "#") return root;
  if (!reference.startsWith("#/")) return undefined;
  let value: unknown = root;
  for (const encodedPart of reference.slice(2).split("/")) {
    const part = encodedPart.replace(/~1/gu, "/").replace(/~0/gu, "~");
    if (!isJsonSchemaObject(value) || !Object.hasOwn(value, part))
      return undefined;
    value = value[part];
  }
  return isJsonSchemaObject(value) ? value : undefined;
}

function declaredSchemaTypes(
  root: JsonSchemaObject,
  schema: JsonSchemaObject,
  references = new Set<string>(),
): Set<string> {
  if (typeof schema.$ref === "string") {
    const reference = schema.$ref;
    if (references.has(reference)) return new Set(["unsupported"]);
    const target = resolveJsonPointer(root, reference);
    if (target === undefined) return new Set(["unsupported"]);
    const nextReferences = new Set(references);
    nextReferences.add(reference);
    return declaredSchemaTypes(root, target, nextReferences);
  }
  if (typeof schema.type === "string") return new Set([schema.type]);
  if (Array.isArray(schema.type))
    return new Set(
      schema.type.filter((entry): entry is string => typeof entry === "string"),
    );
  if (Object.hasOwn(schema, "const")) {
    const valueType =
      schema.const === null
        ? "null"
        : typeof schema.const === "string" ||
            typeof schema.const === "number" ||
            typeof schema.const === "boolean"
          ? typeof schema.const
          : "unsupported";
    return new Set([valueType]);
  }
  if (Array.isArray(schema.enum)) {
    return new Set(
      schema.enum.map((value) =>
        value === null
          ? "null"
          : typeof value === "string" ||
              typeof value === "number" ||
              typeof value === "boolean"
            ? typeof value
            : "unsupported",
      ),
    );
  }
  const alternatives = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(alternatives)) {
    return alternatives.reduce<Set<string>>((types, branch) => {
      if (isJsonSchemaObject(branch)) {
        for (const type of declaredSchemaTypes(root, branch, references))
          types.add(type);
      }
      return types;
    }, new Set());
  }
  return new Set(["unsupported"]);
}

function resolveJsonSchema(
  root: JsonSchemaObject,
  schema: JsonSchemaObject,
  references = new Set<string>(),
): JsonSchemaObject {
  if (typeof schema.$ref !== "string") return schema;
  const reference = schema.$ref;
  if (references.has(reference)) return { ...schema, type: "unsupported" };
  const target = resolveJsonPointer(root, reference);
  if (target === undefined) return { ...schema, type: "unsupported" };
  const nextReferences = new Set(references);
  nextReferences.add(reference);
  const resolvedTarget = resolveJsonSchema(root, target, nextReferences);
  const overlay = Object.fromEntries(
    Object.entries(schema).filter(([key]) => key !== "$ref"),
  );
  return { ...resolvedTarget, ...overlay };
}

function scalarConstraints(
  schema: JsonSchemaObject,
): ExtensionScalar[] | undefined {
  if (Array.isArray(schema.enum)) return extensionScalarValues(schema.enum);
  if (Object.hasOwn(schema, "const"))
    return extensionScalarValues([schema.const]);
  return undefined;
}

function alternativeValues(
  shapes: readonly ExtensionFieldShape[],
): ExtensionScalar[] | undefined {
  const values = shapes.map(({ allowedValues }) => allowedValues);
  if (values.some((entry) => entry === undefined)) return undefined;
  return [...new Set(values.flatMap((entry) => entry ?? []))];
}

function fieldShape(
  root: JsonSchemaObject,
  input: JsonSchemaObject,
): ExtensionFieldShape {
  const schema = resolveJsonSchema(root, input);
  const declaredTypes = declaredSchemaTypes(root, input);
  const nonNullTypes = [...declaredTypes].filter((type) => type !== "null");
  const nullable = schema.nullable === true || declaredTypes.has("null");
  if (nonNullTypes.length === 0) return { type: "null", nullable: true };
  if (nonNullTypes.length > 1) return { type: "unsupported", nullable };

  const alternatives = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(alternatives)) {
    const shapes = alternatives.flatMap((branch) =>
      isJsonSchemaObject(branch) ? [fieldShape(root, branch)] : [],
    );
    const nullableBranch = shapes.some(({ type }) => type === "null");
    const nonNullShapes = shapes.filter(({ type }) => type !== "null");
    if (nonNullShapes.length > 0) {
      const first = nonNullShapes[0]!;
      const compatible = nonNullShapes.every(
        (candidate) =>
          candidate.type === first.type &&
          candidate.itemType === first.itemType,
      );
      if (compatible) {
        const allowedValues = alternativeValues(nonNullShapes);
        return {
          ...first,
          nullable: nullable || nullableBranch || first.nullable,
          ...(allowedValues === undefined ? {} : { allowedValues }),
        };
      }
    } else if (nullableBranch) {
      return { type: "null", nullable: true };
    }
    return { type: "unsupported", nullable: nullable || nullableBranch };
  }

  const declaredType = schema.type;
  if (Array.isArray(declaredType)) {
    const types = declaredType.filter((entry) => entry !== "null");
    const includesNull = types.length !== declaredType.length;
    if (types.length !== 1 || typeof types[0] !== "string")
      return { type: "unsupported", nullable };
    return fieldShape(root, {
      ...schema,
      type: types[0],
      nullable: nullable || includesNull,
    });
  }

  const scalarType = extensionScalarType(declaredType);
  if (scalarType !== undefined) {
    const allowedValues = scalarConstraints(schema);
    return {
      type: scalarType,
      nullable,
      ...(allowedValues === undefined ? {} : { allowedValues }),
    };
  }

  if (declaredType === "array") {
    const items = isJsonSchemaObject(schema.items)
      ? fieldShape(root, schema.items)
      : { type: "unsupported" as const, nullable: false };
    const itemType = extensionScalarType(items.type);
    if (itemType === undefined) return { type: "array", nullable };
    return {
      type: "array",
      nullable,
      itemType,
      ...(items.allowedValues === undefined
        ? {}
        : { allowedItemValues: items.allowedValues }),
    };
  }

  return {
    type:
      declaredType === "object"
        ? "object"
        : declaredType === "null"
          ? "null"
          : "unsupported",
    nullable: nullable || declaredType === "null",
  };
}

function describeField(
  root: JsonSchemaObject,
  property: JsonSchemaObject,
  required: boolean,
): z.infer<typeof archiveExtensionFieldDiscoverySchema> {
  const description =
    typeof property.description === "string"
      ? { description: property.description }
      : {};
  const shape = fieldShape(root, property);
  const operations =
    shape.type === "string" ||
    shape.type === "number" ||
    shape.type === "integer" ||
    shape.type === "boolean"
      ? ["eq", "in"]
      : shape.type === "array" && shape.itemType !== undefined
        ? ["has", "hasAny"]
        : [];
  return archiveExtensionFieldDiscoverySchema.parse({
    ...shape,
    required,
    ...description,
    operations,
  });
}

/**
 * Project an adapter's authoritative JSON Schema into a concise field catalog.
 * Nested object members stay discoverable as an object field but have no query
 * operations.
 */
export function discoverSourceAdapterExtensionFields(input: {
  readonly sourceAdapterId: string;
  readonly sourceAdapterVersion: string;
  readonly extensionsSchema: Readonly<Record<string, unknown>>;
}) {
  const properties = input.extensionsSchema.properties;
  const required = Array.isArray(input.extensionsSchema.required)
    ? new Set(
        input.extensionsSchema.required.filter(
          (name) => typeof name === "string",
        ),
      )
    : new Set<string>();
  const fields = isJsonSchemaObject(properties)
    ? Object.fromEntries(
        Object.entries(properties).flatMap(([name, property]) =>
          isJsonSchemaObject(property)
            ? [
                [
                  name,
                  describeField(
                    input.extensionsSchema,
                    property,
                    required.has(name),
                  ),
                ],
              ]
            : [],
        ),
      )
    : {};
  return sourceAdapterExtensionFieldsDiscoverySchema.parse({
    sourceAdapterId: input.sourceAdapterId,
    sourceAdapterVersion: input.sourceAdapterVersion,
    fields,
  });
}

export type ArchiveExtensionScalar = z.infer<
  typeof archiveExtensionScalarSchema
>;
export type ArchiveExtensionFieldFilter = z.infer<
  typeof archiveExtensionFieldFilterSchema
>;
export type ArchiveSearchExtensions = z.infer<
  typeof archiveSearchExtensionsSchema
>;
export type SourceAdapterExtensionFieldsDiscovery = z.infer<
  typeof sourceAdapterExtensionFieldsDiscoverySchema
>;
