import { z } from "zod";
import type {
  ContractMetadata,
  ContractSpec,
  OperationMetadata,
} from "./contract-metadata.js";

export class ContractMetadataError extends Error {}

export class ContractRuntime {
  private readonly namedSchemas = new Map<string, z.ZodType>();

  constructor(private readonly metadata: ContractMetadata) {}

  schema(name: string): z.ZodType {
    const cached = this.namedSchemas.get(name);

    if (cached) {
      return cached;
    }

    const specification = this.metadata.schemas[name];

    if (!specification) {
      throw new ContractMetadataError("unknown contract schema: " + name);
    }

    const schema = specification.kind === "object"
      ? this.compile(specification)
      : z.lazy(() => this.compile(specification));

    this.namedSchemas.set(name, schema);

    return schema;
  }

  operation(name: string): OperationMetadata {
    const operation = this.metadata.operations[name];

    if (!operation) {
      throw new ContractMetadataError("unknown operation: " + name);
    }

    return operation;
  }

  compile(specification: ContractSpec): z.ZodType {
    let schema = this.compileBase(specification);

    if (specification.minLength !== undefined && schema instanceof z.ZodString) {
      schema = schema.min(specification.minLength);
    }

    if (specification.format === "uuid" && schema instanceof z.ZodString) {
      schema = schema.uuid();
    }

    if (specification.format === "datetime" && schema instanceof z.ZodString) {
      schema = schema.datetime();
    }

    if (specification.integer && schema instanceof z.ZodNumber) {
      schema = schema.int();
    }

    if (specification.nonnegative && schema instanceof z.ZodNumber) {
      schema = schema.nonnegative();
    }

    if (specification.positive && schema instanceof z.ZodNumber) {
      schema = schema.positive();
    }

    if (specification.minItems !== undefined && schema instanceof z.ZodArray) {
      schema = schema.min(specification.minItems);
    }

    return schema;
  }

  private compileBase(specification: ContractSpec): z.ZodType {
    switch (specification.kind) {
      case "array":
        return z.array(this.compile(specification.element));
      case "boolean":
        return z.boolean();
      case "literal":
        return z.literal(specification.value);
      case "never":
        return z.never();
      case "null":
        return z.null();
      case "number":
        return z.number();
      case "object":
        return this.compileObject(specification);
      case "partial":
        return this.compilePartial(specification.target);
      case "record":
        return z.record(z.string(), this.compile(specification.value));
      case "ref":
        return this.schema(specification.name);
      case "string":
        return z.string();
      case "union":
        return this.compileUnion(specification.options);
      case "unknown":
        return z.unknown();
    }
  }

  private compileObject(specification: Extract<ContractSpec, { kind: "object" }>): z.ZodType {
    const shape: Record<string, z.ZodType> = {};

    for (const parentName of specification.extends) {
      const parent = this.metadata.schemas[parentName];

      if (!parent || parent.kind !== "object") {
        throw new ContractMetadataError(
          "object inheritance target is not an object: " + parentName,
        );
      }

      Object.assign(shape, this.objectShape(parent));
    }

    for (const [name, property] of Object.entries(specification.properties)) {
      let propertySchema = this.compile(property);

      if (property.default !== undefined) {
        propertySchema = propertySchema.default(property.default);
      } else if (property.optional) {
        propertySchema = propertySchema.optional();
      }

      shape[name] = propertySchema;
    }

    const object = z.object(shape);
    return specification.strict ? object.strict() : object;
  }

  private objectShape(
    specification: Extract<ContractSpec, { kind: "object" }>,
  ): Record<string, z.ZodType> {
    const schema = this.compileObject(specification);

    if (!(schema instanceof z.ZodObject)) {
      throw new ContractMetadataError("object compilation did not produce an object");
    }

    return schema.shape;
  }

  private compilePartial(specification: ContractSpec): z.ZodType {
    if (specification.kind !== "ref") {
      throw new ContractMetadataError("partial must target a named object");
    }

    const target = this.schema(specification.name);

    if (!(target instanceof z.ZodObject)) {
      throw new ContractMetadataError(
        "partial target is not an object: " + specification.name,
      );
    }

    return target.partial();
  }

  private compileUnion(options: readonly ContractSpec[]): z.ZodType {
    if (options.length === 0) {
      throw new ContractMetadataError("union must contain at least one option");
    }

    if (options.length === 1) {
      return this.compile(options[0]);
    }

    const first = this.compile(options[0]);
    const second = this.compile(options[1]);
    const remaining = options.slice(2).map((option) => this.compile(option));

    return z.union([first, second, ...remaining]);
  }
}
