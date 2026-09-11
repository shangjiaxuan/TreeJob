export type ContractConstraint = {
  default?: boolean | number | string | null | readonly unknown[] | object;
  format?: "datetime" | "uuid";
  integer?: boolean;
  minItems?: number;
  minLength?: number;
  nonnegative?: boolean;
  optional?: boolean;
  positive?: boolean;
};

export type ContractSpec = ContractConstraint & (
  | {
    kind: "array";
    element: ContractSpec;
  }
  | {
    kind: "boolean" | "never" | "null" | "number" | "string" | "unknown";
  }
  | {
    kind: "literal";
    value: boolean | number | string | null;
  }
  | {
    kind: "object";
    strict: boolean;
    extends: readonly string[];
    properties: Record<string, ContractSpec>;
  }
  | {
    kind: "partial";
    target: ContractSpec;
  }
  | {
    kind: "record";
    value: ContractSpec;
  }
  | {
    kind: "ref";
    name: string;
  }
  | {
    kind: "union";
    options: readonly ContractSpec[];
  }
);

export type OperationMetadata = {
  input: ContractSpec;
  output: ContractSpec;
  command: ContractSpec;
};

export type ContractMetadata = {
  version: 1;
  schemas: Record<string, ContractSpec>;
  operations: Record<string, OperationMetadata>;
};
